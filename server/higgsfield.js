import { config, higgsfieldConfigured } from './config.js';
import { motionIdFor } from './motions.js';

/**
 * Minimal Higgsfield DoP (Director of Photography) image-to-video client.
 *
 * Base URL      : https://platform.higgsfield.ai
 * Auth          : Authorization: Key <KEY_ID>:<KEY_SECRET>
 * Generate      : POST /v1/image2video/dop
 * Poll          : GET  /v1/requests/{id}/status   (fallbacks tried on 404)
 * Statuses      : queued | in_progress | completed | failed | nsfw
 *
 * Note on failures: this client never swallows an error body. If Higgsfield
 * changes a field name, you get the raw response text in the job error rather
 * than a generic "generation failed", which is the difference between a
 * five-minute fix and an afternoon.
 */

const STATUS_PATH_CANDIDATES = [
  (id) => `/v1/requests/${id}/status`,
  (id) => `/requests/${id}/status`,
  (id) => `/v1/job-sets/${id}`,
];

let resolvedStatusPath = null;

function authHeader() {
  return `Key ${config.higgsfield.keyId}:${config.higgsfield.keySecret}`;
}

function assertConfigured() {
  if (!higgsfieldConfigured) {
    throw new Error(
      'Higgsfield credentials are not set. Add HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET to .env, ' +
        'or render in Preview quality (which is free and runs locally).'
    );
  }
}

async function request(pathname, { method = 'GET', body } = {}) {
  const url = `${config.higgsfield.baseUrl}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — keep the raw text for the error message */
  }

  if (!res.ok) {
    const detail = json?.detail || json?.message || json?.error || text || res.statusText;
    const err = new Error(`Higgsfield ${method} ${pathname} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }

  return json ?? {};
}

/**
 * Submit an image-to-video job.
 *
 * @param {object}   opts
 * @param {string[]} opts.imageUrls  1 image for a motion shot, 2 (start,end) for a blend.
 * @param {string}   opts.prompt
 * @param {string}   opts.motionKey  key from the motions catalog
 * @param {number}   [opts.duration] seconds
 * @param {number}   [opts.seed]
 * @returns {Promise<{requestId: string, raw: object}>}
 */
export async function submitImageToVideo({ imageUrls, prompt, motionKey, duration, seed }) {
  assertConfigured();

  if (!imageUrls?.length) throw new Error('At least one image URL is required.');
  for (const imageUrl of imageUrls) {
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw new Error(`Image URL must be absolute and publicly reachable, got: ${imageUrl}`);
    }
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(imageUrl)) {
      throw new Error(
        `Higgsfield must be able to download the image, but ${imageUrl} is local-only. ` +
          'Set PUBLIC_URL to a publicly reachable origin (e.g. a tunnel) before rendering in Cinematic quality.'
      );
    }
  }

  // Confirm every image is actually fetchable before spending anything. An
  // unreachable URL is the most common cause of a wasted generation, and the
  // failure surfaces minutes later as an opaque job error otherwise.
  await Promise.all(
    imageUrls.map(async (imageUrl) => {
      let probe;
      try {
        probe = await fetch(imageUrl, { method: 'HEAD' });
      } catch (err) {
        throw new Error(`Higgsfield could not be given ${imageUrl} — it is unreachable (${err.message}).`);
      }
      if (!probe.ok) {
        throw new Error(
          `Image URL returned ${probe.status}: ${imageUrl}. Higgsfield downloads photos over the ` +
            'public internet, so this must be reachable from outside your machine.'
        );
      }
    })
  );

  // Roles matter for the two-image blend: the model needs to know which frame
  // it is travelling from and which it is arriving at.
  const inputImages =
    imageUrls.length === 1
      ? [{ type: 'image_url', image_url: imageUrls[0], role: 'start_image' }]
      : [
          { type: 'image_url', image_url: imageUrls[0], role: 'start_image' },
          { type: 'image_url', image_url: imageUrls[1], role: 'end_image' },
        ];

  const params = {
    model: config.higgsfield.model,
    prompt,
    input_images: inputImages,
  };

  const motionId = motionKey ? motionIdFor(motionKey) : null;
  if (motionId) params.motion_id = motionId;
  if (duration) params.duration = duration;
  if (Number.isInteger(seed)) params.seed = seed;

  const data = await request('/v1/image2video/dop', { method: 'POST', body: { params } });

  const requestId =
    data.request_id || data.id || data.job_set_id || data.jobSetId || data.data?.id || null;

  if (!requestId) {
    throw new Error(
      `Higgsfield accepted the job but returned no request id. Raw response: ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  return { requestId, raw: data };
}

/** Fetch the status of a submitted request, normalised. */
export async function getStatus(requestId) {
  assertConfigured();

  const candidates = resolvedStatusPath
    ? [resolvedStatusPath]
    : STATUS_PATH_CANDIDATES;

  let lastError = null;
  for (const buildPath of candidates) {
    try {
      const data = await request(buildPath(requestId));
      resolvedStatusPath = buildPath; // remember what worked
      return normaliseStatus(data);
    } catch (err) {
      lastError = err;
      if (err.status !== 404) throw err; // a real error, not a wrong path
    }
  }
  throw lastError || new Error('Unable to resolve Higgsfield status endpoint.');
}

function normaliseStatus(data) {
  const job = data.jobs?.[0] || data.job || data;
  const status = String(data.status || job.status || 'queued').toLowerCase();

  const videoUrl =
    job.results?.raw?.url ||
    job.results?.min?.url ||
    job.result?.url ||
    job.video?.url ||
    data.results?.raw?.url ||
    null;

  const previewUrl = job.results?.min?.url || job.preview?.url || null;

  return {
    status, // queued | in_progress | completed | failed | nsfw
    videoUrl,
    previewUrl,
    error: data.error || job.error || job.failure_reason || null,
    raw: data,
  };
}

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled']);

export { higgsfieldConfigured };
