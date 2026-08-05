import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Local preview renderer.
 *
 * Cinematic (Higgsfield) renders cost credits and take minutes. Brokers need to
 * see the *cut* — order, pacing, which move on which room — long before that is
 * worth paying for. So every shot first renders locally as a Ken Burns move
 * whose direction of travel matches the Higgsfield motion it stands in for.
 *
 * The result is a watchable tour for zero credits, and the broker upgrades only
 * the shots that earn it.
 */

// 24 fps everywhere, deliberately. Higgsfield returns 24; normalising the reel
// to 30 duplicates every fourth frame, and on a slow architectural dolly that
// duplication reads as camera shake. Matching the source end-to-end is the
// single cheapest quality win in the pipeline.
const FPS = 24;
const W = 1920;
const H = 1080;
// Working resolution above output: zoompan steps in integer pixels, so panning
// at output resolution visibly stair-steps. Rendering 2x and scaling down hides it.
const WORK_W = 3840;
const WORK_H = 2160;

export function ffmpegAvailable() {
  return Boolean(config.ffmpeg);
}

function run(binary, args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ffmpeg (${binary}): ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // ffmpeg's useful message is almost always the last few lines.
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      reject(new Error(`ffmpeg exited ${code}:\n${tail}`));
    });
  });
}

/** Interpolation expression over the clip, 0 → 1, using zoompan's frame counter. */
const lerp = (from, to, frames) =>
  from === to
    ? String(from)
    : `${from}+(${to}-${from})*on/${Math.max(frames - 1, 1)}`;

/**
 * Build the scale → crop → zoompan chain for one still image.
 * `preview` is the {z0,z1,c0,c1} block from the motions catalog.
 */
function kenBurnsChain(preview, frames) {
  const { z0, z1, c0, c1 } = preview;
  const z = lerp(z0, z1, frames);
  const cx = lerp(c0[0], c1[0], frames);
  const cy = lerp(c0[1], c1[1], frames);

  return [
    `scale=${WORK_W}:${WORK_H}:force_original_aspect_ratio=increase`,
    `crop=${WORK_W}:${WORK_H}`,
    // z is clamped at 1 because zoompan cannot zoom out past the source frame.
    `zoompan=z='max(${z},1.0)'` +
      `:x='(iw-iw/zoom)*(${cx})'` +
      `:y='(ih-ih/zoom)*(${cy})'` +
      `:d=1:s=${W}x${H}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');
}

const ENCODE_ARGS = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
];

/**
 * Render a single-image motion shot.
 * @returns {Promise<{path: string, durationSec: number}>}
 */
export async function renderMotionShot({ imagePath, preview, durationSec = 5, outPath }) {
  if (!config.ffmpeg) throw new Error('ffmpeg was not found — preview rendering is unavailable.');

  const frames = Math.max(Math.round(durationSec * FPS), 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  await run(config.ffmpeg, [
    '-y',
    '-loop', '1',
    '-framerate', String(FPS),
    '-t', String(durationSec),
    '-i', imagePath,
    '-vf', kenBurnsChain(preview, frames),
    '-frames:v', String(frames),
    ...ENCODE_ARGS,
    outPath,
  ]);

  return { path: outPath, durationSec };
}

/**
 * Render a two-image blend. The second image continues the first's travel and
 * settles, so the crossfade reads as one move rather than a dissolve between
 * two unrelated stills.
 */
export async function renderBlendShot({
  imagePathA,
  imagePathB,
  preview,
  durationSec = 6,
  outPath,
}) {
  if (!config.ffmpeg) throw new Error('ffmpeg was not found — preview rendering is unavailable.');

  const xfade = 1.0;
  const legSec = (durationSec + xfade) / 2;
  const legFrames = Math.max(Math.round(legSec * FPS), 2);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const chainA = kenBurnsChain(preview, legFrames);
  // Arrive slightly pushed-in and settle out — continuation, not a new shot.
  const chainB = kenBurnsChain(
    { z0: Math.max(preview.z1 * 0.96, 1.0), z1: 1.02, c0: preview.c1, c1: [0.5, 0.5] },
    legFrames
  );

  await run(config.ffmpeg, [
    '-y',
    '-loop', '1', '-framerate', String(FPS), '-t', String(legSec), '-i', imagePathA,
    '-loop', '1', '-framerate', String(FPS), '-t', String(legSec), '-i', imagePathB,
    '-filter_complex',
    `[0:v]${chainA}[a];[1:v]${chainB}[b];` +
      `[a][b]xfade=transition=fade:duration=${xfade}:offset=${(legSec - xfade).toFixed(3)},format=yuv420p[v]`,
    '-map', '[v]',
    ...ENCODE_ARGS,
    outPath,
  ]);

  return { path: outPath, durationSec };
}

/**
 * Two-pass stabilisation for generated footage.
 *
 * Motion invented from a single still wobbles: the model re-guesses occluded
 * geometry every frame, so long straight lines — ceiling grids, cubicle edges,
 * window mullions — swim. Office interiors are the worst case for this, which
 * is unfortunately exactly what CRE listings are made of. Gaussian smoothing
 * removes the high-frequency jitter while preserving the intended dolly.
 *
 * Locally-rendered previews never need this; they are mathematically smooth.
 */
export async function stabilizeClip({ inPath, outPath, smoothing = 22 }) {
  if (!config.ffmpeg) throw new Error('ffmpeg was not found — stabilisation is unavailable.');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const transforms = `${outPath}.trf`;
  try {
    await run(config.ffmpeg, [
      '-y', '-i', inPath,
      '-vf', `vidstabdetect=shakiness=6:accuracy=15:result=${transforms}`,
      '-f', 'null', '-',
    ]);
    await run(config.ffmpeg, [
      '-y', '-i', inPath,
      '-vf',
      `vidstabtransform=input=${transforms}:smoothing=${smoothing}:optzoom=1:interpol=bicubic:crop=black,` +
        'unsharp=5:5:0.35',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
      '-pix_fmt', 'yuv420p', outPath,
    ]);
    return { path: outPath, stabilized: true };
  } catch (err) {
    // A failed stabilisation must never lose the take — fall back to the raw clip.
    console.error('[render] stabilisation failed, keeping raw clip:', err.message);
    return { path: inPath, stabilized: false };
  } finally {
    fs.rmSync(transforms, { force: true });
  }
}

/** Pull a poster frame so the tour player has something to show before play. */
export async function renderPoster({ videoPath, outPath, atSec = 0.4 }) {
  if (!config.ffmpeg) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    await run(config.ffmpeg, [
      '-y',
      '-ss', String(atSec),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '3',
      outPath,
    ]);
    return outPath;
  } catch {
    return null; // a missing poster is cosmetic; never fail the render over it
  }
}

/**
 * Stitch finished shot clips into one continuous reel — the asset the broker
 * actually posts to LoopNet or LinkedIn.
 */
export async function stitchReel({ clipPaths, outPath, endCardPath }) {
  if (!config.ffmpeg) throw new Error('ffmpeg was not found — reel export is unavailable.');
  if (!clipPaths.length) throw new Error('No rendered shots to stitch.');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // The end card is just another clip on the end of the concat list.
  const all = endCardPath && fs.existsSync(endCardPath) ? [...clipPaths, endCardPath] : clipPaths;

  if (all.length === 1) {
    fs.copyFileSync(all[0], outPath);
    return { path: outPath, clips: 1, endCard: false };
  }

  // Normalise every clip through the same filter graph before concat: sources
  // mix locally-rendered previews, Higgsfield downloads and the end card, all
  // potentially at different sizes. Everything lands at 1920x1080 / 24 fps.
  const inputs = all.flatMap((clipPath) => ['-i', clipPath]);
  const normalised = all
    .map(
      (_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[v${i}]`
    )
    .join(';');
  const concatInputs = all.map((_, i) => `[v${i}]`).join('');

  await run(
    config.ffmpeg,
    [
      '-y',
      ...inputs,
      '-filter_complex',
      `${normalised};${concatInputs}concat=n=${all.length}:v=1:a=0[out]`,
      '-map', '[out]',
      ...ENCODE_ARGS,
      outPath,
    ],
    { timeoutMs: 15 * 60 * 1000 }
  );

  return { path: outPath, clips: clipPaths.length, endCard: all.length > clipPaths.length };
}
