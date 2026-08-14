import express from 'express';
import {
  authenticate,
  accountByEmail,
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
 * Ask for a sign-in link.
 *
 * There is no signup route: a broker's account is created by their first order.
 * So this either mails a link to an address we know, or does nothing — and it
 * says exactly the same thing either way. A different answer for a known
 * address would turn this into a way to test who has an account.
 */
authApi.post('/link', credentialLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
  }

  const account = accountByEmail(email);
  if (account) {
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
 * The link itself. Spends the token, starts the session, and lands on /studio.
 * A redirect rather than JSON because this is opened from an inbox, not fetched.
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
        '<a href="/" style="color:#1E5AA8">Ask for a new one</a>.</p></div>');
  }
  setSessionCookie(res, account.id);
  res.redirect(302, '/studio');
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
