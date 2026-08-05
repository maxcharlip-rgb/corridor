import { getDb, save, saveNow, now } from './store.js';

/**
 * Spend guards.
 *
 * Two different risks, guarded separately:
 *
 *   1. A bug or a loop burns the whole Higgsfield balance in minutes. The
 *      credit gate is the backstop — it refuses generation before the call is
 *      made, not after the money is gone.
 *   2. Someone hammers the generate endpoint. Rate limiting handles that.
 *
 * Per-*user* limits are deliberately not implemented here: Corridor has no auth
 * yet, so there is no user to attribute a limit to. Limiting by IP is the
 * honest ceiling until accounts exist — see `planLimitFor` for the shape the
 * per-plan logic should take once they do.
 */

// Credits per Higgsfield take, measured against cinematic_studio_video_v2 at
// 5s / std / sound off. Verify with get_cost if the model or duration changes.
export const CREDITS_PER_TAKE = 5;

export const creditBudget = () => Number(process.env.CREDIT_BUDGET || 0);

/** Rolling month key, so the ledger resets naturally with the billing cycle. */
const monthKey = () => new Date().toISOString().slice(0, 7);

function ledger() {
  const db = getDb();
  db.credits = db.credits || { month: monthKey(), used: 0, entries: [] };
  if (db.credits.month !== monthKey()) {
    db.credits = { month: monthKey(), used: 0, entries: [] };
    save();
  }
  return db.credits;
}

export function creditsUsedThisMonth() {
  return ledger().used;
}

/**
 * Gate a generation before any credits are spent.
 * Returns { ok } or { ok: false, reason, used, budget, projected }.
 */
export function canGenerateVideo(estimatedCredits) {
  const budget = creditBudget();
  const used = creditsUsedThisMonth();
  const projected = used + estimatedCredits;

  // A budget of 0 means "not configured" — don't silently block real work, but
  // do say so at startup so it is a deliberate choice rather than an oversight.
  if (!budget) return { ok: true, used, budget: null, projected, unlimited: true };

  if (projected > budget) {
    return {
      ok: false,
      reason:
        `This would use ${estimatedCredits} credits, taking the month to ${projected} against a ` +
        `budget of ${budget}. Raise CREDIT_BUDGET in .env or wait for the cycle to reset.`,
      used,
      budget,
      projected,
    };
  }
  return { ok: true, used, budget, projected };
}

/** Record spend. Call immediately after a successful submit, never before. */
export function recordCreditSpend({ credits, shotId, note }) {
  const entry = { credits, shotId: shotId || null, note: note || '', at: now() };
  const book = ledger();
  book.used += credits;
  book.entries.push(entry);
  if (book.entries.length > 5000) book.entries.splice(0, 1000);
  // Durable: losing the ledger would let the budget be spent twice.
  saveNow();
  return book.used;
}

// --- rate limiting -----------------------------------------------------------

const buckets = new Map();

/**
 * Fixed-window counter. In-memory on purpose: a single-process pilot does not
 * need Redis, and reaching for it now would add an operational dependency with
 * no user to protect. Swap the Map for Redis when you run more than one worker.
 */
function hit(key, windowMs, max) {
  const nowMs = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || nowMs > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return { ok: true, remaining: max - 1, resetInSec: Math.ceil(windowMs / 1000) };
  }
  bucket.count += 1;
  const resetInSec = Math.ceil((bucket.resetAt - nowMs) / 1000);
  if (bucket.count > max) return { ok: false, remaining: 0, resetInSec };
  return { ok: true, remaining: max - bucket.count, resetInSec };
}

// Opportunistic sweep so the Map cannot grow without bound.
setInterval(() => {
  const nowMs = Date.now();
  for (const [key, bucket] of buckets) {
    if (nowMs > bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref?.();

const clientKey = (req) =>
  req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';

/**
 * Express middleware factory.
 * @param {object} opts { windowMs, max, scope }
 */
export function rateLimit({ windowMs, max, scope }) {
  return (req, res, next) => {
    const result = hit(`${scope}:${clientKey(req)}`, windowMs, max);
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    if (!result.ok) {
      res.setHeader('Retry-After', String(result.resetInSec));
      return res.status(429).json({
        error: `Too many requests. Try again in ${result.resetInSec}s.`,
        retryAfterSeconds: result.resetInSec,
      });
    }
    next();
  };
}

/** Generation is the expensive path — tighter than ordinary reads. */
export const generateLimiter = rateLimit({ windowMs: 60_000, max: 5, scope: 'gen' });
export const dailyGenerateLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 20, scope: 'gen-day' });
export const apiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 500, scope: 'api' });

/**
 * Shape for per-plan limits once auth exists. Not wired up — there is no user
 * object to read a plan from yet, and a fake one would only give false comfort.
 */
export const PLANS = {
  demo: { chatPerDay: 20, videosPerDay: 0, canGenerate: false },
  standard: { chatPerDay: 100, videosPerDay: 10, canGenerate: true },
  enterprise: { chatPerDay: null, videosPerDay: null, canGenerate: true },
};

export function planLimitFor(user) {
  return PLANS[user?.plan] || PLANS.demo;
}
