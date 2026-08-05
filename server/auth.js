import crypto from 'node:crypto';
import { getDb, save, id, now } from './store.js';

/**
 * Minimal auth: one broker account per email.
 *
 * No Supabase, no Auth0, no new dependencies — scrypt for hashing and a signed
 * stateless cookie for the session. That is genuinely enough for a pilot where
 * you know every user by name, and it keeps the deployment a single process
 * with a JSON file.
 *
 * What this is NOT: it has no password reset, no email verification, no MFA and
 * no account recovery. Those matter the moment a stranger can sign up. Before
 * opening signup beyond people you know, move to a real identity provider.
 */

const SESSION_DAYS = 30;
const COOKIE = 'corridor_session';

function secret() {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;

  // Derive a stable per-install secret so sessions survive restarts without
  // forcing config on day one. A rotating secret would log everyone out on
  // every deploy, which is worse than a weak-but-stable one for a pilot.
  const db = getDb();
  if (!db.installSecret) {
    db.installSecret = crypto.randomBytes(32).toString('hex');
    save();
    console.warn(
      '[auth] SESSION_SECRET not set — generated one and stored it in db.json.\n' +
        '       Set SESSION_SECRET in .env before deploying anywhere real.'
    );
  }
  return db.installSecret;
}

// --- password hashing --------------------------------------------------------

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  // Constant-time compare so a timing attack can't probe the hash.
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- session cookie ----------------------------------------------------------

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, accountId) {
  const token = sign({ sub: accountId, exp: Date.now() + SESSION_DAYS * 864e5 });
  const secure = /^https:/i.test(process.env.PUBLIC_URL || '') ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${SESSION_DAYS * 86400}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// --- accounts ----------------------------------------------------------------

const accounts = () => {
  const db = getDb();
  db.accounts = db.accounts || [];
  return db.accounts;
};

export const accountById = (accountId) => accounts().find((a) => a.id === accountId) || null;
export const accountByEmail = (email) =>
  accounts().find((a) => a.email === String(email || '').toLowerCase().trim()) || null;

export function createAccount({ email, password, name, company }) {
  const normalised = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)) throw badRequest('Enter a valid email address.');
  if (!password || String(password).length < 8) throw badRequest('Password must be at least 8 characters.');
  if (accountByEmail(normalised)) throw badRequest('An account with that email already exists.');

  const db = getDb();
  const account = {
    id: id('acc'),
    email: normalised,
    passwordHash: hashPassword(String(password)),
    name: name || '',
    company: company || '',
    plan: 'standard',
    createdAt: now(),
  };
  accounts().push(account);

  // Adopt any listings created before auth existed, so the first account to
  // sign up inherits the pilot data rather than finding an empty portal.
  const orphans = db.listings.filter((l) => !l.ownerId);
  for (const listing of orphans) listing.ownerId = account.id;
  if (orphans.length) console.log(`[auth] adopted ${orphans.length} pre-auth listing(s) into ${normalised}`);

  save();
  return account;
}

export function authenticate({ email, password }) {
  const account = accountByEmail(email);
  // Hash anyway on a miss so response time doesn't reveal whether the email exists.
  if (!account) {
    hashPassword(String(password || ''));
    throw unauthorized('Email or password is incorrect.');
  }
  if (!verifyPassword(String(password || ''), account.passwordHash)) {
    throw unauthorized('Email or password is incorrect.');
  }
  return account;
}

export { setSessionCookie };

// --- middleware --------------------------------------------------------------

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function unauthorized(message) {
  const err = new Error(message);
  err.status = 401;
  return err;
}

/** Attaches req.account when a valid session cookie is present. Never blocks. */
export function loadAccount(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const payload = token ? unsign(token) : null;
  req.account = payload ? accountById(payload.sub) : null;
  next();
}

/**
 * Blocks unauthenticated requests — but only once at least one account exists.
 * A fresh install with no accounts stays open so the first run isn't a lockout;
 * the moment someone signs up, everything is scoped to them.
 */
export function requireAuth(req, res, next) {
  if (!accounts().length) return next();
  if (!req.account) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

/** True when the account may see/modify this listing. */
export function ownsListing(account, listing) {
  if (!accounts().length) return true; // pre-auth single-operator mode
  if (!account || !listing) return false;
  return !listing.ownerId || listing.ownerId === account.id;
}

export const authEnabled = () => accounts().length > 0;
