import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { config } from './config.js';
import { getDb, save, id, shots as shotsRepo, photos as photosRepo, listings, now } from './store.js';
import { MOTION_BY_KEY, SPACE_BY_KEY, buildPrompt } from './motions.js';
import {
  renderMotionShot,
  renderBlendShot,
  renderPoster,
  stabilizeClip,
  ffmpegAvailable,
} from './render-preview.js';
import { submitImageToVideo, getStatus, TERMINAL_STATUSES } from './higgsfield.js';

/**
 * Render orchestration.
 *
 * Preview renders run locally with a small concurrency cap (ffmpeg is CPU
 * bound). Cinematic renders are submitted to Higgsfield and then polled; the
 * poller survives restarts because the request id lives on the shot record.
 */

/* How many ffmpeg renders run at once.
   ffmpeg is the memory ceiling, not the CPU ceiling: two concurrent zoompan
   renders OOM-killed a 512 MB Render instance mid-job, so renders never
   finished and the restart discarded them. Hosted platforms default to 1;
   a local machine with real RAM keeps 2. Override with RENDER_CONCURRENCY. */
const HOSTED = Boolean(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME ||
  process.env.DYNO || process.env.KUBERNETES_SERVICE_HOST
);
const PREVIEW_CONCURRENCY = Math.max(1, Number(process.env.RENDER_CONCURRENCY || (HOSTED ? 1 : 2)));
const queue = [];
let active = 0;
let pollTimer = null;

function photoPath(photo) {
  return path.join(config.uploadsDir, photo.file);
}

function resolveShotContext(shot) {
  const motion = MOTION_BY_KEY[shot.motionKey] || MOTION_BY_KEY.dolly_in;
  const spaceType = SPACE_BY_KEY[shot.spaceType] || null;
  const listing = listings.byId(shot.listingId);
  const photos = (shot.photoIds || []).map((pid) => photosRepo.byId(pid)).filter(Boolean);
  return { motion, spaceType, listing, photos };
}

// --- preview (local, free) ---------------------------------------------------

export function enqueuePreview(shotId) {
  const shot = shotsRepo.byId(shotId);
  if (!shot) throw new Error('Shot not found.');
  if (!ffmpegAvailable()) {
    throw new Error(
      'ffmpeg was not found on this machine, so preview rendering is unavailable. ' +
        'Install ffmpeg (brew install ffmpeg) or set FFMPEG_PATH in .env.'
    );
  }
  if (queue.includes(shotId)) return shot;

  shot.status = 'queued';
  shot.error = null;
  shot.updatedAt = now();
  save();

  queue.push(shotId);
  pump();
  return shot;
}

function pump() {
  while (active < PREVIEW_CONCURRENCY && queue.length) {
    const shotId = queue.shift();
    active += 1;
    runPreview(shotId)
      .catch((err) => {
        const shot = shotsRepo.byId(shotId);
        if (shot) {
          shot.status = 'failed';
          shot.error = err.message;
          shot.updatedAt = now();
          save();
        }
        console.error(`[jobs] preview ${shotId} failed:`, err.message);
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

async function runPreview(shotId) {
  const shot = shotsRepo.byId(shotId);
  if (!shot) return;

  const { motion, photos } = resolveShotContext(shot);
  if (!photos.length) throw new Error('This shot has no photo attached.');
  if (motion.inputs === 2 && photos.length < 2) {
    throw new Error(`"${motion.label}" needs two photos — attach a start and an end frame.`);
  }

  shot.status = 'rendering';
  shot.updatedAt = now();
  save();

  const base = `${shot.id}_preview`;
  const outPath = path.join(config.rendersDir, `${base}.mp4`);
  const posterPath = path.join(config.rendersDir, `${base}.jpg`);

  if (motion.inputs === 2) {
    await renderBlendShot({
      imagePathA: photoPath(photos[0]),
      imagePathB: photoPath(photos[1]),
      preview: motion.preview,
      durationSec: shot.durationSec || 6,
      outPath,
    });
  } else {
    await renderMotionShot({
      imagePath: photoPath(photos[0]),
      preview: motion.preview,
      durationSec: shot.durationSec || 5,
      outPath,
    });
  }

  await renderPoster({ videoPath: outPath, outPath: posterPath });

  shot.preview = {
    file: path.basename(outPath),
    poster: fs.existsSync(posterPath) ? path.basename(posterPath) : null,
    renderedAt: now(),
  };
  shot.status = 'ready';
  shot.error = null;
  shot.updatedAt = now();
  save();
}

// --- cinematic (Higgsfield, costs credits) -----------------------------------

/**
 * Number of independent takes to generate per shot.
 *
 * This is the highest-leverage quality lever in the whole product. Measured
 * per-shot defect rate is ~40% (hallucinated signage, inverted camera moves),
 * so a single take yields a clean five-shot tour only 0.6^5 ≈ 8% of the time.
 * Three takes drops per-shot failure to ~6%, taking a clean tour to ~73% — for
 * about $3 of credits against a $249 price. Redundancy beats better prompting.
 */
export const DEFAULT_TAKES = 3;

export async function submitCinematic(shotId, takeCount = DEFAULT_TAKES) {
  const shot = shotsRepo.byId(shotId);
  if (!shot) throw new Error('Shot not found.');

  const { motion, spaceType, listing, photos } = resolveShotContext(shot);
  if (!photos.length) throw new Error('This shot has no photo attached.');
  if (motion.inputs === 2 && photos.length < 2) {
    throw new Error(`"${motion.label}" needs two photos — attach a start and an end frame.`);
  }

  const prompt = buildPrompt(shot, { listing, motion, spaceType });
  const imageUrls = photos
    .slice(0, motion.inputs)
    .map((p) => `${config.publicUrl}/uploads/${p.file}`);

  shot.takes = shot.takes || [];
  const submitted = [];

  for (let i = 0; i < Math.max(1, takeCount); i += 1) {
    try {
      const { requestId } = await submitImageToVideo({
        imageUrls,
        prompt,
        motionKey: shot.motionKey,
        duration: shot.durationSec,
        // Distinct seeds so the takes actually differ; identical seeds would
        // just buy the same defect three times.
        seed: Math.floor(Math.random() * 1_000_000),
      });
      const take = {
        id: id('tk'),
        requestId,
        status: 'queued',
        submittedAt: now(),
        file: null,
        poster: null,
        error: null,
      };
      shot.takes.push(take);
      submitted.push(take);
    } catch (err) {
      // One rejected take shouldn't abandon the others already in flight.
      console.error(`[jobs] take ${i + 1} for ${shot.id} failed to submit:`, err.message);
      if (!submitted.length && i === Math.max(1, takeCount) - 1) throw err;
    }
  }

  shot.prompt = prompt;
  shot.updatedAt = now();
  save();

  startPolling();
  return shot;
}

/** Promote a specific take to be the one the tour uses. */
export function selectTake(shotId, takeId) {
  const fail = (message, status) => {
    const err = new Error(message);
    err.status = status;
    return err;
  };

  const shot = shotsRepo.byId(shotId);
  if (!shot) throw fail('Shot not found.', 404);
  const take = (shot.takes || []).find((t) => t.id === takeId);
  if (!take) throw fail('Take not found.', 404);
  if (!take.file) throw fail('That take has not finished rendering.', 409);

  shot.selectedTakeId = take.id;
  shot.cinematic = { ...take };
  shot.status = 'ready';
  shot.error = null;
  shot.updatedAt = now();
  save();
  return shot;
}

function pendingTakes() {
  const out = [];
  for (const shot of getDb().shots) {
    for (const take of shot.takes || []) {
      if (take.requestId && !TERMINAL_STATUSES.has(take.status || 'queued')) {
        out.push({ shot, take });
      }
    }
  }
  return out;
}

export function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    pollOnce().catch((err) => console.error('[jobs] poll error:', err.message));
  }, config.higgsfield.pollIntervalMs);
  pollTimer.unref?.();
}

async function pollOnce() {
  const pending = pendingTakes();
  if (!pending.length) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }

  for (const { shot, take } of pending) {
    try {
      const result = await getStatus(take.requestId);
      take.status = result.status;

      /* Completed with no URL used to fall through both branches, so nothing
         was saved and the same job was polled forever — the exact "charged but
         nothing appears" failure. Treat it as terminal and say so. */
      if (result.status === 'completed' && !result.videoUrl) {
        take.status = 'failed';
        take.error =
          'Higgsfield reported this generation complete but returned no downloadable file. ' +
          'The payload has been logged so the response shape can be checked.';
        shot.error = take.error;
        shot.updatedAt = now();
        save();
        continue;
      }

      if (result.status === 'completed' && result.videoUrl) {
        const rawFile = await downloadRemote(result.videoUrl, `${take.id}_raw.mp4`);
        const rawPath = path.join(config.rendersDir, rawFile);

        // Stabilise before the take is ever shown. Generated motion always
        // carries some wobble, and it is cheaper to fix here than to have a
        // broker notice it.
        const stabPath = path.join(config.rendersDir, `${take.id}.mp4`);
        const { path: finalPath, stabilized } = await stabilizeClip({
          inPath: rawPath,
          outPath: stabPath,
        });
        if (finalPath !== rawPath) fs.rmSync(rawPath, { force: true });

        const posterPath = path.join(config.rendersDir, `${take.id}.jpg`);
        await renderPoster({ videoPath: finalPath, outPath: posterPath });

        take.file = path.basename(finalPath);
        take.poster = fs.existsSync(posterPath) ? path.basename(posterPath) : null;
        take.remoteUrl = result.videoUrl;
        take.stabilized = stabilized;
        take.renderedAt = now();

        // Auto-select the first take to land so the tour is never blocked on a
        // human; the operator can switch to a better take afterwards.
        if (!shot.selectedTakeId) {
          shot.selectedTakeId = take.id;
          shot.cinematic = { ...take };
          shot.status = 'ready';
          shot.error = null;
        }
      } else if (result.status === 'failed' || result.status === 'nsfw') {
        take.error =
          result.status === 'nsfw'
            ? 'Higgsfield flagged this frame and refunded the credits.'
            : result.error || 'Higgsfield reported the render failed. Credits are refunded on failure.';
        // Only surface an error on the shot if every take died.
        const takes = shot.takes || [];
        if (takes.every((t) => t.error || (!t.file && TERMINAL_STATUSES.has(t.status)))) {
          shot.error = take.error;
          shot.status = 'failed';
        }
      }

      shot.updatedAt = now();
      save();
    } catch (err) {
      /* A transient blip should retry; a permanent fault must not spin forever.
       *
       * Previously every poll error was treated as transient, so a take whose
       * status could never be read stayed "queued" indefinitely — the
       * generation had been submitted and BILLED, but nothing ever appeared for
       * the user and no error was raised. Silent, paid-for, and invisible.
       */
      take.lastPollError = err.message;
      take.pollFailures = (take.pollFailures || 0) + 1;
      console.error(`[jobs] poll ${shot.id}/${take.id} (attempt ${take.pollFailures}):`, err.message);

      const permanent = err.exhausted || err.status === 401 || err.status === 403;
      if (permanent || take.pollFailures >= 8) {
        take.status = 'failed';
        take.error = permanent
          ? `Higgsfield accepted and billed this generation, but its status could not be read: ${err.message}`
          : `Gave up reading status after ${take.pollFailures} attempts: ${err.message}`;
        shot.error = take.error;
        const takes = shot.takes || [];
        if (takes.every((t) => t.error)) shot.status = 'failed';
      }
      save();
    }
  }
}

/**
 * Stream the finished render straight to disk.
 *
 * Buffering the whole file with arrayBuffer() held the entire video in RAM
 * before writing a single byte — on a small instance, several of those
 * alongside an ffmpeg process is enough to get the service OOM-killed. Piping
 * keeps memory flat regardless of clip length.
 */
async function downloadRemote(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading render failed: ${res.status} ${res.statusText}`);
  const outPath = path.join(config.rendersDir, filename);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outPath));
  return filename;
}

/**
 * Resume work after a restart.
 *
 * Two different kinds of in-flight job, and only one of them used to survive:
 *
 *  - Higgsfield takes live on the remote side, so a request id is enough to
 *    pick polling back up.
 *  - Local preview renders live in an IN-MEMORY queue. A restart — a deploy, an
 *    OOM kill, a crash — destroys the queue while the database still says
 *    "rendering". Those shots were orphaned permanently: no worker owned them,
 *    nothing ever failed them, and the UI showed a spinner forever. Clicking
 *    Generate again just produced more stuck shots.
 *
 * So anything left mid-render is re-queued here. This is what makes the render
 * pipeline actually restart-safe rather than merely restart-tolerant.
 */
export function resumePending() {
  if (pendingTakes().length) startPolling();

  const orphans = getDb().shots.filter(
    (s) => (s.status === 'rendering' || s.status === 'queued') && s.photoIds?.length
  );
  if (!orphans.length) return;

  if (!ffmpegAvailable()) {
    for (const shot of orphans) {
      shot.status = 'failed';
      shot.error = 'Rendering was interrupted and ffmpeg is unavailable to retry.';
    }
    save();
    return;
  }

  console.log(`[jobs] re-queueing ${orphans.length} render(s) interrupted by a restart`);
  for (const shot of orphans) {
    shot.status = 'queued';
    shot.error = null;
    if (!queue.includes(shot.id)) queue.push(shot.id);
  }
  save();
  pump();
}

export function queueDepth() {
  return { queued: queue.length, active };
}

// --- visualisation image polling ---------------------------------------------

let visualTimer = null;

function pendingVisuals() {
  const out = [];
  for (const listing of getDb().listings) {
    for (const visual of listing.visuals || []) {
      if (visual.requestId && !TERMINAL_STATUSES.has(visual.status || 'queued')) out.push({ listing, visual });
    }
  }
  return out;
}

/** Images are cheap and fast; a shorter interval than video is fine. */
export function startVisualPolling() {
  if (visualTimer) return;
  visualTimer = setInterval(() => {
    pollVisualsOnce().catch((err) => console.error('[jobs] visual poll:', err.message));
  }, Math.max(3000, config.higgsfield.pollIntervalMs));
  visualTimer.unref?.();
}

async function pollVisualsOnce() {
  const pending = pendingVisuals();
  if (!pending.length) {
    clearInterval(visualTimer);
    visualTimer = null;
    return;
  }

  for (const { visual } of pending) {
    try {
      const result = await getStatus(visual.requestId);
      visual.status = result.status;

      if (result.status === 'completed' && (result.videoUrl || result.raw?.jobs?.[0]?.results?.raw?.url)) {
        const url = result.videoUrl || result.raw.jobs[0].results.raw.url;
        const file = await downloadRemote(url, `${visual.id}.jpg`);
        visual.file = file;
        visual.remoteUrl = url;
        visual.renderedAt = now();
      } else if (result.status === 'failed' || result.status === 'nsfw') {
        visual.error = result.error || `Generation ${result.status}. Credits are refunded on failure.`;
      }
      save();
    } catch (err) {
      visual.lastPollError = err.message;
      save();
    }
  }
}
