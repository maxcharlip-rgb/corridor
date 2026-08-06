import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// --- .env loading (no dependency; we only need flat KEY=VALUE) ---------------
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

// --- ffmpeg discovery -------------------------------------------------------
// Preview renders are done locally so a broker can block out an entire tour
// before spending a single Higgsfield credit. We look in the usual places.
function bundled(moduleName) {
  // ffmpeg-static ships a prebuilt binary so Corridor works without Homebrew.
  try {
    const resolved = require(moduleName);
    return typeof resolved === 'string' ? resolved : resolved?.path || null;
  } catch {
    return null;
  }
}

function findBinary(name, bundledModule) {
  const candidates = [
    process.env[`${name.toUpperCase()}_PATH`],
    bundledModule ? bundled(bundledModule) : null,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking — a dangling symlink or missing path is expected here */
    }
  }
  return null;
}

const DATA_DIR = process.env.CORRIDOR_DATA_DIR
  ? path.resolve(process.env.CORRIDOR_DATA_DIR)
  : path.join(ROOT, 'data');

export const config = {
  port: Number(process.env.PORT || 4182),
  // CORRIDOR_DATA_DIR lets the test suite (and a container with a mounted
  // volume) point state somewhere other than the repo, so tests can never
  // clobber a live db.json.
  dataDir: DATA_DIR,
  uploadsDir: path.join(DATA_DIR, 'uploads'),
  rendersDir: path.join(DATA_DIR, 'renders'),
  dbFile: path.join(DATA_DIR, 'db.json'),
  publicDir: path.join(ROOT, 'public'),

  // Public origin used when building shareable tour links and when handing
  // image URLs to Higgsfield. Higgsfield must be able to *reach* these URLs,
  // so on localhost cinematic renders require a tunnel (see README).
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4182}`).replace(/\/$/, ''),

  ffmpeg: findBinary('ffmpeg', 'ffmpeg-static'),
  ffprobe: findBinary('ffprobe'),

  higgsfield: {
    keyId: process.env.HIGGSFIELD_KEY_ID || '',
    keySecret: process.env.HIGGSFIELD_KEY_SECRET || '',
    baseUrl: (process.env.HIGGSFIELD_BASE_URL || 'https://platform.higgsfield.ai').replace(/\/$/, ''),
    /* Default image-to-video model.
     *
     * `/v1/image2video/dop` accepts ONLY 'dop-lite', 'dop-preview' and
     * 'dop-turbo' — the endpoint tells you so in its 422. The ids returned by
     * the model-catalog tooling (cinematic_studio_video_v2, kling3_0, …) belong
     * to a different API surface; sending one here rejects every submission.
     * Do not "correct" this against a catalog listing again.
     */
    model: process.env.HIGGSFIELD_MODEL || 'dop-turbo',
    pollIntervalMs: Number(process.env.HIGGSFIELD_POLL_MS || 5000),
    timeoutMs: Number(process.env.HIGGSFIELD_TIMEOUT_MS || 10 * 60 * 1000),
  },
};

export const higgsfieldConfigured = Boolean(
  config.higgsfield.keyId && config.higgsfield.keySecret
);

for (const dir of [config.dataDir, config.uploadsDir, config.rendersDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
