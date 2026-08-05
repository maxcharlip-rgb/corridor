import { config, higgsfieldConfigured } from './config.js';
import { redact } from './reliability.js';

/**
 * Higgsfield connectivity diagnosis.
 *
 * Built after discovering that Higgsfield evaluates auth BEFORE routing:
 *
 *   POST /v1/image2video/dop      + bad key -> 401 {"detail":"Invalid credentials"}
 *   POST /v1/definitely-not-real  + bad key -> 401 {"detail":"Invalid credentials"}
 *
 * A wrong path and a wrong key are therefore indistinguishable while the key is
 * invalid. Any error handling that says "404 means your path is wrong" is dead
 * code — that 404 will never arrive.
 *
 * The useful consequence: credentials CAN be validated without spending a
 * credit, by sending a deliberately invalid body to a real endpoint.
 *
 *   valid key   + invalid body -> 4xx that is NOT 401 (request rejected)
 *   invalid key + invalid body -> 401 (auth rejected first)
 *
 * That is the whole trick behind `probeAuth()`. It costs nothing because the
 * request never becomes a job.
 */

const TIMEOUT_MS = 15_000;

async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate credentials without creating a job or spending credits.
 * @returns {Promise<{ok:boolean, state:string, status:number|null, detail:string}>}
 */
export async function probeAuth() {
  if (!higgsfieldConfigured) {
    return {
      ok: false,
      state: 'no_credentials',
      status: null,
      detail:
        'HIGGSFIELD_KEY_ID and HIGGSFIELD_KEY_SECRET are not set. Create a .env file ' +
        '(copy .env.example) and add both. Preview-quality rendering works without them.',
    };
  }

  const url = `${config.higgsfield.baseUrl}/v1/image2video/dop`;
  let res;
  let body = '';
  try {
    // Intentionally invalid params: if the key is good, the API rejects the
    // *request*; if the key is bad, it rejects the *auth* first.
    res = await timedFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Key ${config.higgsfield.keyId}:${config.higgsfield.keySecret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ params: {} }),
    });
    body = (await res.text()).slice(0, 300);
  } catch (err) {
    return {
      ok: false,
      state: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      status: null,
      detail:
        err.name === 'AbortError'
          ? `No response from ${config.higgsfield.baseUrl} within ${TIMEOUT_MS / 1000}s.`
          : `Cannot reach ${config.higgsfield.baseUrl}: ${redact(err.message)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      state: 'invalid_credentials',
      status: res.status,
      detail:
        'Higgsfield rejected the credentials. Check HIGGSFIELD_KEY_ID and ' +
        'HIGGSFIELD_KEY_SECRET are the API key pair from platform.higgsfield.ai — note the ' +
        'header format is "Key ID:SECRET", not Bearer. Also confirm the key has not expired.',
    };
  }

  if (res.status >= 500) {
    return {
      ok: false,
      state: 'upstream_error',
      status: res.status,
      detail: `Higgsfield returned ${res.status}. This is on their side; retry shortly.`,
    };
  }

  // Anything else (400/422 for the empty params) means auth passed.
  return {
    ok: true,
    state: 'authenticated',
    status: res.status,
    detail: `Credentials accepted (endpoint rejected the deliberately empty request with ${res.status}, as expected).`,
  };
}

/**
 * Confirm Higgsfield can actually download our images. This is a distinct
 * failure from auth and is the more common one in practice: keys are usually
 * fine, but PUBLIC_URL points at localhost or a dead tunnel.
 */
export async function probePublicUrl(sampleUploadFile = null) {
  const base = config.publicUrl;

  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(base)) {
    return {
      ok: false,
      state: 'local_only',
      detail:
        `PUBLIC_URL is ${base}. Higgsfield downloads your photos over the public internet, so ` +
        'cinematic renders and image generation cannot work. Point it at a tunnel ' +
        '(cloudflared/ngrok) or your deployed origin. Preview rendering is unaffected.',
    };
  }

  const target = sampleUploadFile ? `${base}/uploads/${sampleUploadFile}` : `${base}/healthz`;
  try {
    const res = await timedFetch(target, { method: sampleUploadFile ? 'HEAD' : 'GET' });
    if (!res.ok) {
      return {
        ok: false,
        state: 'unreachable',
        detail: `${target} returned ${res.status}. Higgsfield will get the same, so generation will fail.`,
      };
    }
    return { ok: true, state: 'reachable', detail: `${target} is reachable from the public internet.` };
  } catch (err) {
    return {
      ok: false,
      state: 'unreachable',
      detail: `Could not reach ${target}: ${redact(err.message)}. Higgsfield will not be able to either.`,
    };
  }
}

/** Full picture, safe to expose to an authenticated operator. */
export async function diagnose({ sampleUploadFile = null } = {}) {
  const [auth, publicUrl] = await Promise.all([probeAuth(), probePublicUrl(sampleUploadFile)]);

  const blockers = [];
  if (!auth.ok) blockers.push(auth.detail);
  if (!publicUrl.ok) blockers.push(publicUrl.detail);

  return {
    ready: auth.ok && publicUrl.ok,
    auth,
    publicUrl,
    config: {
      baseUrl: config.higgsfield.baseUrl,
      videoModel: config.higgsfield.model,
      videoEndpoint: '/v1/image2video/dop',
      imageEndpoint: process.env.HIGGSFIELD_IMAGE_PATH || '/v1/image2image (default)',
      publicUrl: config.publicUrl,
      // Presence only — never the values.
      keyIdSet: Boolean(config.higgsfield.keyId),
      keySecretSet: Boolean(config.higgsfield.keySecret),
    },
    blockers,
    note:
      'Higgsfield checks auth before routing, so an incorrect endpoint path also returns 401. ' +
      'Endpoint paths cannot be validated until credentials are valid.',
  };
}
