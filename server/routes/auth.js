import express from 'express';
import {
  createAccount,
  authenticate,
  setSessionCookie,
  clearSessionCookie,
  authEnabled,
} from '../auth.js';
import { rateLimit } from '../limits.js';

export const authApi = express.Router();
authApi.use(express.json({ limit: '16kb' }));

// Credential endpoints are the classic brute-force target, so they get their
// own tighter bucket than the generation routes.
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, scope: 'auth' });

const publicView = (account) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  company: account.company,
  plan: account.plan,
});

authApi.get('/me', (req, res) => {
  res.json({
    account: req.account ? publicView(req.account) : null,
    authEnabled: authEnabled(),
  });
});

authApi.post('/signup', credentialLimiter, (req, res, next) => {
  try {
    const { email, password, name, company } = req.body || {};
    const account = createAccount({ email, password, name, company });
    setSessionCookie(res, account.id);
    res.status(201).json({ account: publicView(account) });
  } catch (err) {
    next(err);
  }
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
