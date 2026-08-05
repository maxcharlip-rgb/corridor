import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Photo preparation.
 *
 * `enhance` is real and runs locally: interior listing photos are routinely
 * under-lit and flat, and lifting shadows / recovering contrast before
 * generation measurably improves what the video model does with them.
 *
 * `stage` (virtually furnishing an empty space) is deliberately an adapter
 * rather than a silent implementation — see the note on that function.
 */

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => reject(new Error(`Could not run ${binary}: ${err.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-4).join('\n')}`))
    );
  });
}

const PROFILES = {
  balanced: {
    label: 'Balanced',
    note: 'Gentle shadow lift and clarity. Safe on almost any interior.',
    filter: 'eq=brightness=0.03:contrast=1.06:saturation=1.05,unsharp=5:5:0.45:5:5:0.0',
  },
  bright: {
    label: 'Brighten interior',
    note: 'For dim rooms shot without supplemental lighting.',
    filter: 'eq=brightness=0.09:contrast=1.10:saturation=1.06:gamma=1.06,unsharp=5:5:0.55:5:5:0.0',
  },
  daylight: {
    label: 'Neutralise colour cast',
    note: 'Pulls the yellow-green cast out of fluorescent-lit offices.',
    filter:
      'colorbalance=rs=-0.04:gs=-0.03:bs=0.06:rm=-0.02:bm=0.04,eq=brightness=0.04:contrast=1.07:saturation=1.02,unsharp=5:5:0.4:5:5:0.0',
  },
  crisp: {
    label: 'Architectural crisp',
    note: 'Higher micro-contrast for exteriors and detail shots.',
    filter: 'eq=brightness=0.01:contrast=1.14:saturation=1.03,unsharp=7:7:0.8:7:7:0.0',
  },
};

export const ENHANCE_PROFILES = Object.entries(PROFILES).map(([key, value]) => ({
  key,
  label: value.label,
  note: value.note,
}));

/**
 * Produce an enhanced copy of a photo. Non-destructive: the original file is
 * kept so a broker can always revert, which matters because "enhanced" photos
 * of a real property are a representation to a prospect.
 */
export async function enhancePhoto({ sourceFile, profile = 'balanced' }) {
  if (!config.ffmpeg) {
    throw new Error('ffmpeg was not found, so photo enhancement is unavailable.');
  }
  const spec = PROFILES[profile];
  if (!spec) throw new Error(`Unknown enhancement profile "${profile}".`);

  const ext = path.extname(sourceFile) || '.jpg';
  const outFile = `${path.basename(sourceFile, ext)}__${profile}${ext}`;
  const outPath = path.join(config.uploadsDir, outFile);

  await run(config.ffmpeg, [
    '-y',
    '-i', path.join(config.uploadsDir, sourceFile),
    '-vf', spec.filter,
    '-q:v', '2',
    outPath,
  ]);

  if (!fs.existsSync(outPath)) throw new Error('Enhancement produced no output file.');
  return outFile;
}

/**
 * Virtual staging adapter.
 *
 * Not implemented against a default endpoint on purpose. Two reasons:
 *
 * 1. Image-edit endpoints and their parameter names differ per provider and
 *    change often. Guessing one produces a 404 at the worst possible moment —
 *    when a broker is mid-demo. Point this at the endpoint you actually have.
 * 2. Furnishing an empty suite or removing clutter changes what the prospect
 *    believes they are being shown. Most jurisdictions and the NAR code treat
 *    undisclosed alteration of property imagery as a misrepresentation issue.
 *    Corridor therefore records `staged: true` on the photo and the public
 *    tour renders a permanent "Virtually staged" badge over any shot built from
 *    it. That badge is not optional and is not removable from the UI.
 *
 * To enable: set STAGING_ENDPOINT (and STAGING_API_KEY) in .env, then this
 * posts {image_url, prompt} and expects {url} back.
 */
export async function stagePhoto({ sourceFile, prompt }) {
  const endpoint = process.env.STAGING_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'Virtual staging is not configured. Set STAGING_ENDPOINT in .env to an image-edit ' +
        'endpoint that accepts {image_url, prompt} and returns {url}. Photos staged this way ' +
        'are permanently badged "Virtually staged" in the public tour.'
    );
  }

  const imageUrl = `${config.publicUrl}/uploads/${sourceFile}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.STAGING_API_KEY
        ? { Authorization: `Bearer ${process.env.STAGING_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ image_url: imageUrl, prompt }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Staging endpoint returned ${res.status}: ${text.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Staging endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!data.url) throw new Error('Staging endpoint returned no "url" field.');

  const buffer = Buffer.from(await (await fetch(data.url)).arrayBuffer());
  const ext = path.extname(sourceFile) || '.jpg';
  const outFile = `${path.basename(sourceFile, ext)}__staged${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, outFile), buffer);
  return outFile;
}

export const stagingConfigured = () => Boolean(process.env.STAGING_ENDPOINT);
