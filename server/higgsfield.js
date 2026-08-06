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


/**
 * Per-model duration limits.
 *
 * Empty on purpose. The dop endpoint's supported range is undocumented, and the
 * previous table listed models this endpoint does not even accept — clamping
 * against it silently shortened tours. With no entry, the requested duration is
 * sent as-is and an unsupported value surfaces as a readable validation error.
 */
const MODEL_DURATION = {};

export function clampDuration(model, seconds) {
  const range = MODEL_DURATION[model];
  if (!range) return seconds;
  const clamped = Math.min(Math.max(Math.round(seconds), range.min), range.max);
  if (clamped !== seconds) {
    console.warn(`[higgsfield] duration ${seconds}s is outside ${model} (${range.min}-${range.max}s); using ${clamped}s`);
  }
  return clamped;
}

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

/**
 * Turn an error body into something a human can read.
 *
 * A 422 arrives as FastAPI's validation shape — `detail` is an array of
 * {loc, msg} objects. Interpolating that into a template literal yields
 * "[object Object]", which is how a precise, self-describing error about a
 * single bad field became days of guessing at the request body.
 */
export function describeError(json) {
  if (!json) return null;
  const detail = json.detail ?? json.message ?? json.error ?? json.errors;
  if (!detail) return null;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        if (typeof d === 'string') return d;
        // Drop the leading "body" segment; it is the same on every entry.
        const field = Array.isArray(d.loc) ? d.loc.filter((x) => x !== 'body').join('.') : d.field;
        const msg = d.msg || d.message || d.type || JSON.stringify(d);
        return field ? `${field}: ${msg}` : msg;
      })
      .join('; ');
  }
  return JSON.stringify(detail);
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
    const detail = describeError(json) || text || res.statusText;
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
/* Optional request fields, ordered least-essential first.
 *
 * A 422 is a validation rejection: nothing is queued and nothing is charged,
 * so retrying costs only latency. Rather than have one unrecognised optional
 * field fail every generation — and take a deploy to identify — drop the
 * optional fields a tier at a time until the API accepts the job, then
 * remember what worked so later takes submit in one round trip. */
const OPTIONAL_TIERS = [
  [],
  ['seed', 'aspect_ratio'],
  ['seed', 'aspect_ratio', 'sound'],
  ['seed', 'aspect_ratio', 'sound', 'motion_id'],
  ['seed', 'aspect_ratio', 'sound', 'motion_id', 'duration'],
];

let acceptedTier = 0;

async function submitWithFallback(params) {
  let firstError = null;

  for (let tier = acceptedTier; tier < OPTIONAL_TIERS.length; tier += 1) {
    const body = { ...params };
    for (const field of OPTIONAL_TIERS[tier]) delete body[field];

    try {
      const data = await request('/v1/image2video/dop', { method: 'POST', body: { params: body } });
      if (tier !== acceptedTier) {
        console.warn(
          `[higgsfield] submit accepted after dropping: ${OPTIONAL_TIERS[tier].join(', ') || 'nothing'}`
        );
        acceptedTier = tier;
      }
      return data;
    } catch (err) {
      // Only a validation rejection is safe to retry. Anything else (auth,
      // rate limit, server fault) must surface as-is rather than being
      // retried four times.
      if (err.status !== 422) throw err;
      firstError = firstError || err;
      console.warn(`[higgsfield] 422 with [${OPTIONAL_TIERS[tier].join(', ') || 'full body'}] dropped: ${err.message}`);
    }
  }

  throw firstError;
}

/* The complete set of models /v1/image2video/dop accepts. Anything else is a
   validation failure, not a quality trade-off. */
export const DOP_MODELS = new Set(['dop-lite', 'dop-preview', 'dop-turbo']);
const FALLBACK_MODEL = 'dop-turbo';

export async function submitImageToVideo({ imageUrls, prompt, motionKey, duration, seed, model, aspectRatio, sound }) {
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

  /* Honour the planned model — but only if this endpoint accepts it.
   *
   * The per-shot model is persisted when a tour is planned, so shots created
   * under an older build carry ids this endpoint rejects. Trusting stored data
   * to still be a valid enum meant every existing listing failed to submit even
   * after the default was corrected. Validate at the point of use. */
  const requested = model || config.higgsfield.model;
  const chosenModel = DOP_MODELS.has(requested) ? requested : FALLBACK_MODEL;
  if (chosenModel !== requested) {
    console.warn(`[higgsfield] "${requested}" is not accepted here; submitting as ${chosenModel}`);
  }

  const params = {
    model: chosenModel,
    prompt,
    input_images: inputImages,
  };

  const motionId = motionKey ? motionIdFor(motionKey) : null;
  if (motionId) params.motion_id = motionId;

  /* Duration must be sent, and must sit inside the model's supported range —
   * an out-of-range value is silently clamped or ignored, which is how a 5s
   * request came back as a 1s clip. */
  if (duration) params.duration = clampDuration(chosenModel, duration);
  if (aspectRatio) params.aspect_ratio = aspectRatio;
  if (sound) params.sound = sound;
  if (Number.isInteger(seed)) params.seed = seed;

  const data = await submitWithFallback(params);

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

  /* A transient 4xx on the known-good path must not be read as "no path
     works". Once resolvedStatusPath is memoised the candidate list is a single
     entry, so one 429 exhausted it immediately and the caller treated that as
     permanent — abandoning a job that had already been paid for and was still
     running. Retry the full list before concluding anything, and never call a
     retryable status exhausted. */
  const memoised = resolvedStatusPath;
  const candidates = memoised ? [memoised, ...STATUS_PATH_CANDIDATES] : STATUS_PATH_CANDIDATES;
  const RETRYABLE = new Set([408, 425, 429]);

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
  // A path that worked before is still the right path; the failure was the
  // request, not the route. Forget the memo so the next cycle re-derives it.
  if (memoised) resolvedStatusPath = null;

  const retryable = RETRYABLE.has(lastError?.status);
  const err = new Error(
    `Could not read job status from Higgsfield. Tried: ${STATUS_PATH_CANDIDATES.map((f) => f('<id>')).join(', ')}. ` +
      `Last response: ${lastError ? lastError.message : 'unknown'}. ` +
      'Set HIGGSFIELD_STATUS_PATH if your account uses a different route.'
  );
  // Only a genuine "no route answers" is permanent. Rate limiting is not.
  if (!retryable) err.exhausted = true;
  err.status = lastError?.status;
  throw err;
}

/**
 * Normalise a status response.
 *
 * Response shapes differ per route — /v1/job-sets/{id} does not look like the
 * documented request-status payload — and guessing one specific nesting is what
 * left generations billed but never collected: the poll returned 200, the URL
 * was not where the code looked, nothing was saved, and it polled the same job
 * forever.
 *
 * So rather than assume a shape, walk the whole object for the first media URL
 * and the most specific status present. Tolerant beats precise here: the cost of
 * a wrong guess is an invisible paid-for generation.
 */
/*
 * Higgsfield echoes the REQUEST back inside status payloads, so a response for a
 * still-queued job contains `params.input_images[].image_url` — the .jpg we
 * uploaded. A key-blind scan for "any media URL" found that photo, concluded the
 * job was complete, downloaded a JPEG as .mp4 (vidstab accepts it without
 * complaint) and published a 0.04s frozen frame while the real render was paid
 * for and abandoned.
 *
 * So the scan is now key-aware: never descend into an echo of our own request,
 * and track whether a URL was found under a key that plausibly holds a RESULT.
 */
const ECHO_KEYS = /^(params|input|inputs|input_images|image_url|image_urls|source|request|payload|body)$/i;
const RESULT_KEYS = /^(results?|output|outputs|assets?|video|videos|media|files?|min|raw)$/i;

function deepFind(node, predicate, depth = 0, inResults = false) {
  if (!node || depth > 6) return null;
  if (typeof node === 'string') return predicate(node, inResults) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFind(item, predicate, depth + 1, inResults);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (ECHO_KEYS.test(key)) continue; // our own request, never a render
      const hit = deepFind(value, predicate, depth + 1, inResults || RESULT_KEYS.test(key));
      if (hit) return hit;
    }
  }
  return null;
}

const isHttp = (v) => /^https?:\/\//i.test(v);
const isVideoUrl = (v) => isHttp(v) && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(v);
const isImageUrl = (v) => isHttp(v) && /\.(jpe?g|png|webp)(\?|$)/i.test(v);

/* Signed CDN URLs sometimes carry no extension. Tolerate that, but only under a
 * result key AND only once the job itself claims to be finished — otherwise the
 * tolerance fires mid-flight, which is how the original bug triggered. */
const isResultUrl = (v, inResults) =>
  isHttp(v) && inResults && !isImageUrl(v) && !/\.(json|txt|log|trf)(\?|$)/i.test(v);

function collectStatuses(node, out = [], depth = 0) {
  if (!node || depth > 5 || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStatuses(item, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (ECHO_KEYS.test(key)) continue; // an echoed status is not job state
    if (key === 'status' && typeof value === 'string') out.push(value.toLowerCase());
    else collectStatuses(value, out, depth + 1);
  }
  return out;
}

/**
 * Prefer the full-quality render over the compressed preview.
 *
 * A completed job carries both: `results.min` (a small, heavily compressed
 * proof) and `results.raw` (the actual deliverable). A generic deep scan returns
 * whichever appears first in the payload, and `min` sorts first — so every tour
 * was shipping the preview while the render the credits paid for went unused.
 * On a broker's listing that difference is the whole product.
 */
function bestVideoUrl(data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  for (const quality of ['raw', 'min']) {
    for (const job of jobs) {
      const url = job?.results?.[quality]?.url;
      if (isVideoUrl(url)) return url;
    }
  }
  return null;
}

export function normaliseStatus(data) {
  const statuses = collectStatuses(data);
  const claimsDone = statuses.length > 0 && statuses.every((s) => s === 'completed');

  /* videoUrl is ONLY ever a video. There is no image fallback: an image can
   * never be the result of an image-to-video job, and treating one as such is
   * exactly what published a still frame as a finished tour. */
  const videoUrl = bestVideoUrl(data) || deepFind(data, isVideoUrl) || (claimsDone ? deepFind(data, isResultUrl) : null);
  const imageUrl = deepFind(data, isImageUrl);

  let status;
  if (videoUrl) status = 'completed';
  else if (statuses.some((s) => s === 'failed' || s === 'error')) status = 'failed';
  else if (statuses.some((s) => s === 'nsfw')) status = 'nsfw';
  else if (claimsDone) status = 'completed';
  else status = statuses[0] || 'queued';

  if (status === 'completed' && !videoUrl && !imageUrl) {
    console.error('[higgsfield] job reported complete but no media URL was found. Payload:',
      JSON.stringify(data).slice(0, 900));
  }

  return {
    status,
    videoUrl,
    imageUrl,
    previewUrl: imageUrl,
    error: data.error || data.detail || null,
    raw: data,
  };
}

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled']);

export { higgsfieldConfigured };
