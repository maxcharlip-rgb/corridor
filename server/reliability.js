import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb, save, flush, now } from './store.js';
import { fontsAvailable } from './endcard.js';

/**
 * Production hardening.
 *
 * Corridor is a single long-lived process serving public tour links. The
 * failure modes that matter at 24/7 are not the ones that show up in a demo:
 *
 *   - An unhandled rejection terminates Node, taking every published tour
 *     offline until someone notices.
 *   - A generation job that never reaches a terminal state polls forever, so
 *     the shot is stuck "rendering" and the interval never clears.
 *   - Debounced writes mean an acknowledged signup can be lost to a crash.
 *   - Renders accumulate until the disk fills, which fails everything at once.
 *
 * Each is handled here rather than hoped about.
 */

// --- secret redaction ---------------------------------------------------------

/**
 * Strip anything credential-shaped before it reaches a log or an API response.
 * Applied to every error surfaced from an outbound call, because upstream
 * services do sometimes echo request headers back in error bodies.
 */
export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return text;

  const secrets = [
    config.higgsfield.keySecret,
    config.higgsfield.keyId,
    process.env.ANTHROPIC_API_KEY,
    process.env.SESSION_SECRET,
    process.env.STAGING_API_KEY,
  ].filter((s) => s && String(s).length >= 8);

  for (const secret of secrets) {
    text = text.split(secret).join('«redacted»');
  }

  return text
    .replace(/(Authorization:\s*)(Key|Bearer)\s+\S+/gi, '$1$2 «redacted»')
    .replace(/(x-api-key["':\s]+)[A-Za-z0-9_\-]{8,}/gi, '$1«redacted»')
    .replace(/(X-Amz-Signature=)[a-f0-9]{16,}/gi, '$1«redacted»')
    .replace(/(sk-[A-Za-z0-9_\-]{8,})/g, '«redacted»');
}

/** Console wrapper that redacts. Install once at boot. */
export function installSafeLogging() {
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) =>
      original(...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
  }
}

// --- process guards -----------------------------------------------------------

/**
 * Keep the process alive through programming errors.
 *
 * An unhandled rejection in a poll tick should not take down a server that is
 * also hosting live tour links. Crashes are logged and counted; if they arrive
 * faster than a threshold the process exits deliberately so a supervisor
 * (systemd, Railway, Render) restarts it clean rather than thrashing.
 */
export function installProcessGuards({ onFatal } = {}) {
  let recent = 0;
  const WINDOW_MS = 60_000;
  const MAX_IN_WINDOW = 10;
  setInterval(() => { recent = 0; }, WINDOW_MS).unref?.();

  const handle = (kind) => (err) => {
    recent += 1;
    console.error(`[${kind}]`, redact(err?.stack || err?.message || String(err)));
    // Persist immediately — whatever just broke, don't also lose state.
    try { flush(); } catch { /* nothing more we can do */ }

    if (recent > MAX_IN_WINDOW) {
      console.error(`[fatal] ${recent} errors in under a minute — exiting for a clean restart.`);
      try { onFatal?.(); } catch { /* ignore */ }
      process.exit(1);
    }
  };

  process.on('unhandledRejection', handle('unhandledRejection'));
  process.on('uncaughtException', handle('uncaughtException'));
}

// --- stuck job reaping --------------------------------------------------------

/**
 * A Higgsfield request that never reaches a terminal status would otherwise
 * keep its poller running forever and leave the shot permanently "rendering".
 * Anything older than this is marked failed so the UI tells the truth and the
 * interval can clear.
 */
export const JOB_STALE_MS = Number(process.env.JOB_STALE_MS || 45 * 60 * 1000);

export function reapStaleJobs() {
  const db = getDb();
  const cutoff = Date.now() - JOB_STALE_MS;
  let reaped = 0;

  const isStale = (record) => {
    const started = Date.parse(record.submittedAt || record.createdAt || '');
    return Number.isFinite(started) && started < cutoff;
  };

  for (const shot of db.shots || []) {
    for (const take of shot.takes || []) {
      if (take.file || take.error) continue;
      if (!take.requestId || !isStale(take)) continue;
      take.status = 'failed';
      take.error = `No result after ${Math.round(JOB_STALE_MS / 60000)} minutes — treated as failed. Higgsfield refunds credits on failure.`;
      reaped += 1;
    }
    const takes = shot.takes || [];
    if (takes.length && takes.every((t) => t.error) && shot.status !== 'ready') {
      shot.status = 'failed';
      shot.error = 'Every take failed or timed out.';
    }
  }

  for (const listing of db.listings || []) {
    for (const visual of listing.visuals || []) {
      if (visual.file || visual.error) continue;
      if (!visual.requestId || !isStale(visual)) continue;
      visual.status = 'failed';
      visual.error = `No result after ${Math.round(JOB_STALE_MS / 60000)} minutes — treated as failed.`;
      reaped += 1;
    }
  }

  if (reaped) {
    save();
    console.warn(`[reliability] reaped ${reaped} stale job(s)`);
  }
  return { reaped };
}

// --- disk retention -----------------------------------------------------------

/**
 * Renders accumulate: three takes per shot, plus stabilisation intermediates,
 * plus a reel per rebuild. Left alone this fills the disk, which fails uploads,
 * renders and publishing simultaneously.
 *
 * Only files no record points at are removed, so a published tour can never
 * lose its video.
 */
export const RENDER_RETENTION_DAYS = Number(process.env.RENDER_RETENTION_DAYS || 30);

export function sweepOrphanRenders({ dryRun = false } = {}) {
  if (!fs.existsSync(config.rendersDir)) return { removed: 0, freedBytes: 0, kept: 0 };

  const db = getDb();
  const referenced = new Set();
  const keep = (name) => name && referenced.add(name);

  for (const shot of db.shots || []) {
    keep(shot.preview?.file); keep(shot.preview?.poster);
    keep(shot.cinematic?.file); keep(shot.cinematic?.poster);
    for (const take of shot.takes || []) { keep(take.file); keep(take.poster); }
  }
  for (const listing of db.listings || []) {
    keep(listing.reelFile);
    for (const visual of listing.visuals || []) keep(visual.file);
  }

  const cutoff = Date.now() - RENDER_RETENTION_DAYS * 864e5;
  let removed = 0;
  let freedBytes = 0;
  let kept = 0;

  for (const name of fs.readdirSync(config.rendersDir)) {
    if (referenced.has(name)) { kept += 1; continue; }
    const full = path.join(config.rendersDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs > cutoff) { kept += 1; continue; }

    freedBytes += stat.size;
    removed += 1;
    if (!dryRun) {
      try { fs.rmSync(full, { force: true }); } catch (err) { console.error('[reliability] sweep:', err.message); }
    }
  }

  if (removed && !dryRun) {
    console.log(`[reliability] swept ${removed} orphan render(s), freed ${(freedBytes / 1e6).toFixed(1)} MB`);
  }
  return { removed, freedBytes, kept };
}

/** Periodic housekeeping. Safe to call on boot. */
export function startHousekeeping({ intervalMs = 15 * 60 * 1000 } = {}) {
  const tick = () => {
    try { reapStaleJobs(); } catch (err) { console.error('[reliability] reap:', err.message); }
    try { sweepOrphanRenders(); } catch (err) { console.error('[reliability] sweep:', err.message); }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

/** Snapshot for /healthz — enough to alert on without exposing anything. */
export function healthSnapshot() {
  const db = getDb();
  let pendingTakes = 0;
  let failedTakes = 0;
  for (const shot of db.shots || []) {
    for (const take of shot.takes || []) {
      if (take.error) failedTakes += 1;
      else if (take.requestId && !take.file) pendingTakes += 1;
    }
  }
  let renderBytes = 0;
  try {
    for (const name of fs.readdirSync(config.rendersDir)) {
      try { renderBytes += fs.statSync(path.join(config.rendersDir, name)).size; } catch { /* skip */ }
    }
  } catch { /* dir missing */ }

  /* Overlays and the end card are silently skipped when no font resolves, so
     whether fonts are present has to be observable from outside the process —
     otherwise a reel ships without the address and specs and nothing says why. */
  let fonts = false;
  try { fonts = fontsAvailable(); } catch { /* module failed to load */ }

  return {
    uptimeSec: Math.round(process.uptime()),
    fonts,
    dataDirPersistent: !/\/(app|opt\/render)\/(src|project)/.test(config.dataDir) || Boolean(process.env.CORRIDOR_DATA_DIR),
    listings: (db.listings || []).length,
    accounts: (db.accounts || []).length,
    pendingTakes,
    failedTakes,
    renderMB: Number((renderBytes / 1e6).toFixed(1)),
    rssMB: Number((process.memoryUsage().rss / 1e6).toFixed(1)),
    checkedAt: now(),
  };
}
