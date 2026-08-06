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
  ...(process.env.HIGGSFIELD_STATUS_PATH
    ? [(id) => process.env.HIGGSFIELD_STATUS_PATH.replace('{id}', id)]
    : []),
  (id) => `/v1/requests/${id}/status`,
  (id) => `/v1/job-sets/${id}`,
  (id) => `/v1/jobs/${id}`,
  (id) => `/v1/image2video/dop/${id}`,
  (id) => `/requests/${id}/status`,
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

  // Always log endpoint + status. Without this, a failure is invisible in prod.
  console.log(`[higgsfield] ${method} ${pathname} -> ${res.status}`);

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

/**
 * Submit an image generation or edit.
 *
 * Used by the visualisation workflow (concept / renovation / fit-out / layout).
 * `imageUrl` is omitted for concept images — there is no building to edit yet.
 *
 * NOTE: the image endpoint path is configurable because, unlike
 * /v1/image2video/dop, it has not been exercised against a live account here.
 * If it 404s, set HIGGSFIELD_IMAGE_PATH rather than editing this file — the
 * error below tells you exactly that.
 */
export async function submitImageGeneration({ imageUrl, prompt, model, aspectRatio = '16:9' }) {
  assertConfigured();
  if (!prompt) throw new Error('A prompt is required.');

  if (imageUrl) {
    if (/localhost|127\.0\.0\.1/i.test(imageUrl)) {
      throw new Error(
        `Higgsfield must download ${imageUrl}, but it is local-only. Set PUBLIC_URL to a reachable origin.`
      );
    }
    let probe;
    try {
      probe = await fetch(imageUrl, { method: 'HEAD' });
    } catch (err) {
      throw new Error(`Source image is unreachable (${err.message}): ${imageUrl}`);
    }
    if (!probe.ok) throw new Error(`Source image returned ${probe.status}: ${imageUrl}`);
  }

  const pathname =
    process.env.HIGGSFIELD_IMAGE_PATH || (imageUrl ? '/v1/image2image' : '/v1/text2image');

  const params = { model, prompt, aspect_ratio: aspectRatio };
  if (imageUrl) params.input_images = [{ type: 'image_url', image_url: imageUrl, role: 'image' }];

  let data;
  try {
    data = await request(pathname, { method: 'POST', body: { params } });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error(
        'Higgsfield rejected the credentials on the image endpoint. Note that Higgsfield checks auth ' +
        'BEFORE routing, so this same 401 appears if HIGGSFIELD_IMAGE_PATH is wrong. Verify the keys ' +
        'first with: node scripts/verify-higgsfield.js --confirm'
      );
    }
    if (err.status === 404) {
      throw new Error(
        `Higgsfield image endpoint ${pathname} returned 404. The image path differs from the video ` +
          'path and has not been confirmed against a live account. Set HIGGSFIELD_IMAGE_PATH in .env ' +
          'to the correct route. Video generation is unaffected.'
      );
    }
    throw err;
  }

  const requestId = data.request_id || data.id || data.job_set_id || data.data?.id || null;
  if (!requestId) {
    throw new Error(`Image job accepted but returned no request id: ${JSON.stringify(data).slice(0, 400)}`);
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
      /* Try the next candidate on ANY 4xx.
       *
       * This previously bailed unless the status was exactly 404 — but
       * Higgsfield evaluates auth BEFORE routing, so an unknown path answers
       * 401, not 404. The very first wrong candidate therefore threw and the
       * remaining ones were never attempted. Polling then failed forever while
       * the generation had already been submitted and billed: the user was
       * charged and never saw a result. Only a network fault or a 5xx is worth
       * abandoning the search for.
       */
      if (!err.status || err.status >= 500) throw err;
    }
  }
  const err = new Error(
    `Could not read job status from Higgsfield. Tried: ${STATUS_PATH_CANDIDATES.map((f) => f('<id>')).join(', ')}. ` +
      `Last response: ${lastError ? lastError.message : 'unknown'}. ` +
      'Set HIGGSFIELD_STATUS_PATH if your account uses a different route.'
  );
  err.exhausted = true;
  throw err;
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
