import express from 'express';
import {
  authenticate,
  accountByEmail,
  createAccount,
  issueLoginToken,
  redeemLoginToken,
  LINK_EXPIRY_MINUTES,
  setSessionCookie,
  clearSessionCookie,
  authEnabled,
} from '../auth.js';
import { rateLimit } from '../limits.js';
import { config } from '../config.js';
import { sendMail, signInLink, mailConfigured } from '../mailer.js';
import { requests as requestsRepo, saveNow } from '../store.js';

export const authApi = express.Router();
authApi.use(express.json({ limit: '16kb' }));

// Credential endpoints are the classic brute-force target, so they get their
// own tighter bucket than the generation routes.
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, scope: 'auth' });

/**
 * What the browser is allowed to know about an account.
 *
 * These four are exactly what the order form prefills. Sending them is the
 * whole reason accounts exist here: a returning broker's second order should be
 * address, photos, submit.
 */
const publicView = (account) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  phone: account.phone || '',
  company: account.company,
  plan: account.plan,
  marketing_opt_in: Boolean(account.marketing_opt_in),
});

authApi.get('/me', (req, res) => {
  res.json({
    account: req.account ? publicView(req.account) : null,
    authEnabled: authEnabled(),
  });
});

/**
 * Status as the broker should read it. Operator values stay on the request;
 * this is the only wording the desk shows.
 */
export function deskStatusLabel(status) {
  switch (String(status || '')) {
    case 'ready':
    case 'delivered':
      return 'Ready';
    case 'in progress':
    case 'cutting':
      return 'Working on it';
    case 'declined':
      return 'Declined';
    case 'new':
    default:
      return 'Sent';
  }
}

/** What a signed-in broker is allowed to see about their own request. */
function deskView(request) {
  return {
    id: request.id,
    address: request.address || '',
    status: request.status || 'new',
    label: deskStatusLabel(request.status),
    createdAt: request.createdAt || request.at || null,
    photoCount: (request.photos || []).length,
    size: request.size || '',
    notes: request.notes || '',
    photos: (request.photos || []).map((p) => `/uploads/${p.file}`),
  };
}

/**
 * This account's listings only. Never other brokers', never the operator queue.
 */
authApi.get('/listings', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Sign in to continue.' });
  const mine = requestsRepo
    .all()
    .filter((r) => r.accountId === req.account.id)
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(deskView);
  res.json({ listings: mine });
});

authApi.get('/listings/:id', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Sign in to continue.' });
  const request = requestsRepo.byId(req.params.id);
  if (!request || request.accountId !== req.account.id) {
    return res.status(404).json({ error: 'Listing not found.' });
  }
  res.json({ listing: deskView(request) });
});

/**
 * Ask for a sign-in link. Same endpoint for Sign in and Create account.
 *
 * If the email is new, a passwordless account is created and the link is the
 * whole signup. The JSON is the same either way so this cannot be used to
 * test who already has an account.
 */
authApi.post('/link', credentialLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  }
  const name = String((req.body || {}).name || '').trim().slice(0, 120);
  const marketingOptIn = (req.body || {}).marketing === true
    || (req.body || {}).marketing === 'yes'
    || (req.body || {}).marketing_opt_in === true;

  let account = accountByEmail(email);
  if (!account) {
    try {
      account = createAccount({ email, name, marketingOptIn });
    } catch {
      account = accountByEmail(email);
    }
  }

  if (account) {
    if (marketingOptIn && !account.marketing_opt_in) {
      account.marketing_opt_in = true;
      saveNow();
    }
    const token = issueLoginToken(account.id);
    const url = `${config.publicUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const mail = signInLink(account, url, LINK_EXPIRY_MINUTES);
    const sent = await sendMail({ to: account.email, subject: mail.subject, html: mail.html });
    if (!sent.ok) console.error(`[auth] sign-in link for ${email} was NOT sent: ${sent.error}`);
    /* With no mail provider there is no other way in, and an install nobody can
       sign into is not testable. Only ever when mail is off — a link in the log
       of a live server would be a handed-out session. */
    if (!mailConfigured()) console.log(`[auth] mail is off; sign-in link for ${email}: ${url}`);
  }
  res.json({ success: true, error: null });
});

/**
 * The link itself. Spends the token, starts the session, and lands on the
 * broker desk. A redirect rather than JSON because this is opened from an
 * inbox, not fetched. Studio stays the operator cut tool, not the sign-in home.
 */
authApi.get('/verify', (req, res) => {
  const account = redeemLoginToken(String(req.query.token || ''));
  if (!account) {
    return res
      .status(401)
      .type('html')
      .send('<!doctype html><meta charset="utf-8"><title>Link expired — Corridor</title>' +
        '<div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;max-width:34em;margin:14vh auto;padding:0 20px;color:#101418">' +
        '<h1 style="font:400 30px/1.1 Georgia,serif">That link has expired.</h1>' +
        `<p style="color:#5B6672">Sign-in links last ${LINK_EXPIRY_MINUTES} minutes and work once. ` +
        '<a href="/listings" style="color:#1E5AA8">Ask for a new one</a>.</p></div>');
  }
  setSessionCookie(res, account.id);
  res.redirect(302, '/listings');
});

authApi.post('/login', credentialLimiter, (req, res, next) => {
  try {
    const account = authenticate(req.body || {});
    setSessionCookie(res, account.id);
    res.json({ account: publicView(account) });
  } catch (err) {
    next(err);
  }
});

authApi.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authApi.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[auth]', err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});
