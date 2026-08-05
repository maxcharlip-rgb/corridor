#!/usr/bin/env node
/**
 * End-to-end verification of the Higgsfield REST path.
 *
 *   node scripts/verify-higgsfield.js --confirm
 *   node scripts/verify-higgsfield.js --confirm --image-url https://example.com/photo.jpg
 *
 * THIS SPENDS REAL CREDITS (one take ≈ 5). It refuses to run without --confirm,
 * because a verification script that quietly costs money is a trap.
 *
 * This exercises the exact code path the deployed app uses — server/higgsfield.js
 * over REST with keys from .env — NOT the MCP tooling, which is client-side only
 * and unavailable to a server. Until this passes, cinematic rendering in the
 * product is unproven no matter how many clips were made another way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, higgsfieldConfigured } from '../server/config.js';
import { submitImageToVideo, getStatus, TERMINAL_STATUSES } from '../server/higgsfield.js';
import { MOTION_BY_KEY, buildPrompt } from '../server/motions.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};

const log = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  console.error(`\n  ✕ ${msg}\n`);
  process.exit(1);
};

console.log('\n  Higgsfield REST verification\n');

if (!higgsfieldConfigured) {
  fail('HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET are not set in .env');
}

// Resolve the image the API will download.
let imageUrl = valueOf('--image-url');
if (!imageUrl) {
  if (/localhost|127\.0\.0\.1/i.test(config.publicUrl)) {
    fail(
      'PUBLIC_URL is local-only, so Higgsfield cannot download a photo from this machine.\n' +
        '    Either set PUBLIC_URL to a public tunnel, or pass a reachable image directly:\n' +
        '      node scripts/verify-higgsfield.js --confirm --image-url https://…/photo.jpg'
    );
  }
  const uploads = fs.existsSync(config.uploadsDir)
    ? fs.readdirSync(config.uploadsDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    : [];
  if (!uploads.length) fail('No uploaded photos found. Upload one, or pass --image-url.');
  imageUrl = `${config.publicUrl}/uploads/${uploads[0]}`;
}

const motion = MOTION_BY_KEY.dolly_in;
const prompt = buildPrompt(
  { direction: '', promptOverride: '' },
  { listing: { propertyType: 'office' }, motion, spaceType: { label: 'Lobby' } }
);

log(`endpoint   ${config.higgsfield.baseUrl}/v1/image2video/dop`);
log(`auth       Key ${config.higgsfield.keyId.slice(0, 6)}…:••••••`);
log(`model      ${config.higgsfield.model}`);
log(`motion     ${motion.label}`);
log(`image      ${imageUrl}`);
log(`prompt     ${prompt.slice(0, 90)}…`);

if (!has('--confirm')) {
  console.log('\n  Dry run. Nothing was submitted and no credits were spent.');
  console.log('  Re-run with --confirm to actually generate (≈5 credits).\n');
  process.exit(0);
}

// Confirm the image is fetchable before spending anything — a 404 here is the
// most common cause of a wasted generation.
log('\nchecking the image is publicly reachable…');
try {
  const probe = await fetch(imageUrl, { method: 'HEAD' });
  if (!probe.ok) fail(`Image URL returned ${probe.status}. Higgsfield will not be able to read it.`);
  log(`  reachable (${probe.headers.get('content-type') || 'unknown type'})`);
} catch (err) {
  fail(`Could not reach the image URL: ${err.message}`);
}

log('\nsubmitting…');
let requestId;
try {
  ({ requestId } = await submitImageToVideo({
    imageUrls: [imageUrl],
    prompt,
    motionKey: 'dolly_in',
    duration: 5,
  }));
  log(`  accepted · request ${requestId}`);
} catch (err) {
  console.error(`\n  ✕ Submit failed: ${err.message}`);
  if (err.body) console.error(`\n  Raw response:\n  ${JSON.stringify(err.body).slice(0, 800)}\n`);
  console.error(
    '  Check first: the auth header format is "Key ID:SECRET" (not Bearer), and the\n' +
      '  endpoint is platform.higgsfield.ai/v1/image2video/dop.\n'
  );
  process.exit(1);
}

log('\npolling…');
const startedAt = Date.now();
const deadline = startedAt + config.higgsfield.timeoutMs;

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, config.higgsfield.pollIntervalMs));
  let status;
  try {
    status = await getStatus(requestId);
  } catch (err) {
    log(`  transient poll error (will retry): ${err.message}`);
    continue;
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log(`  ${String(elapsed).padStart(3)}s  ${status.status}`);

  if (TERMINAL_STATUSES.has(status.status)) {
    if (status.status === 'completed' && status.videoUrl) {
      console.log(`\n  ✓ REST integration works end to end.`);
      console.log(`    video: ${status.videoUrl}\n`);
      console.log('    Cinematic rendering in the app is now proven, not assumed.\n');
      process.exit(0);
    }
    console.error(`\n  ✕ Finished as "${status.status}". ${status.error || ''}`);
    console.error('    Credits are refunded on failed and rejected renders.\n');
    process.exit(1);
  }
}

fail(`Timed out after ${Math.round(config.higgsfield.timeoutMs / 1000)}s. Request ${requestId} may still complete.`);
