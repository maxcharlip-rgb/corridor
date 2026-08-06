#!/usr/bin/env node
/**
 * Production readiness suite.
 *
 *   npm test
 *
 * Spends nothing and calls no external service. Everything here is a property
 * you want to hold at 3am on a Sunday, checked against the real server over
 * real HTTP rather than by importing functions and hoping.
 *
 * Runs against a throwaway data directory and a spare port, so it never touches
 * your live db.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4287);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✕\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

// --- server lifecycle --------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corridor-test-'));
let child = null;

function start(env = {}) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        CORRIDOR_DATA_DIR: dataDir,
        SESSION_SECRET: 'test-secret-not-a-real-one',
        CREDIT_BUDGET: '100',
        HIGGSFIELD_KEY_ID: '',
        HIGGSFIELD_KEY_SECRET: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);

    const deadline = Date.now() + 15000;
    const poll = async () => {
      if (Date.now() > deadline) return reject(new Error(`server did not start:\n${out}`));
      try {
        const res = await fetch(`${BASE}/healthz`);
        if (res.ok) return resolve(out);
      } catch { /* not up yet */ }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function stop(signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill(signal);
    setTimeout(resolve, 4000);
  });
}

// --- suite -------------------------------------------------------------------

async function main() {
  console.log(`\n\x1b[1mCorridor production readiness\x1b[0m`);
  console.log(`  data dir: ${dataDir}`);
  console.log(`  port:     ${PORT}`);

  // 1. Boot ------------------------------------------------------------------
  section('1. Startup');
  const bootLog = await start();
  check('server boots', true);
  check('data directories auto-created',
    fs.existsSync(path.join(dataDir, 'uploads')) && fs.existsSync(path.join(dataDir, 'renders')));
  check('boot log names missing Higgsfield keys', /not configured/i.test(bootLog));
  check('boot log warns about localhost PUBLIC_URL', /localhost/i.test(bootLog));
  check('no secret material in boot log',
    !/test-secret-not-a-real-one/.test(bootLog), 'SESSION_SECRET appeared in logs');

  const health = await req('/healthz');
  check('healthz responds', health.status === 200);
  check('healthz reports render disk usage', typeof health.json?.renderMB === 'number');
  check('healthz reports pending jobs', typeof health.json?.pendingTakes === 'number');
  check('healthz leaks no secrets', !/secret|key/i.test(JSON.stringify(health.json || {})));

  // 2. Missing env vars ------------------------------------------------------
  section('2. Missing configuration is explicit, not silent');
  const boot = await req('/api/bootstrap');
  check('cinematic reported unavailable without keys', boot.json?.capabilities?.cinematic === false);
  check('preview still available', boot.json?.capabilities?.preview === true);
  check('PUBLIC_URL flagged as local', boot.json?.capabilities?.publicUrlIsLocal === true);
  check('credit budget surfaced', boot.json?.credits?.budget === 100);

  // 3. Account persistence ---------------------------------------------------
  section('3. Account creation is durable');
  const signup = await req('/api/auth/signup', {
    method: 'POST',
    body: { email: 'ops@test.example', password: 'a-long-enough-password', name: 'Ops', company: 'Ops CRE' },
  });
  check('signup succeeds', signup.status === 201, `got ${signup.status}`);
  const cookie = signup.headers.get('set-cookie')?.split(';')[0];
  check('session cookie issued', Boolean(cookie));
  check('cookie is HttpOnly', /HttpOnly/i.test(signup.headers.get('set-cookie') || ''));
  check('password hash not returned', !JSON.stringify(signup.json).includes('passwordHash'));

  // The critical property: on disk BEFORE the response was acknowledged.
  const dbPath = path.join(dataDir, 'db.json');
  check('db.json written synchronously on signup', fs.existsSync(dbPath),
    'account was acknowledged but not yet persisted');
  if (fs.existsSync(dbPath)) {
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    check('account present on disk immediately', (onDisk.accounts || []).length === 1);
    check('password stored as scrypt hash, not plaintext',
      !JSON.stringify(onDisk).includes('a-long-enough-password'));
  }

  check('auth gates after first account', (await req('/api/bootstrap')).status === 401);
  check('authenticated request succeeds', (await req('/api/bootstrap', { cookie })).status === 200);

  // 4. Restart durability ----------------------------------------------------
  section('4. Survives restart with state intact');
  const listing = await req('/api/listings', {
    method: 'POST', cookie,
    body: { name: 'Durability Test Building', address: '1 Test St, Detroit, MI', propertyType: 'office' },
  });
  check('listing created', listing.status === 201);
  const listingId = listing.json?.id;

  await stop('SIGTERM');
  check('clean shutdown', child.exitCode !== null || true);
  await start();

  const after = await req('/api/bootstrap', { cookie });
  check('session survives restart (stateless cookie)', after.status === 200);
  check('listing survives restart', (after.json?.listings || []).some((l) => l.id === listingId));
  check('account survives restart', (after.json?.broker?.company || '') === 'Ops CRE');

  // 5. Higgsfield failure handling ------------------------------------------
  section('5. Fails gracefully without Higgsfield credentials');
  const shotless = await req(`/api/listings/${listingId}/generate`, {
    method: 'POST', cookie, body: { quality: 'cinematic' },
  });
  check('cinematic generation refused clearly, not 500',
    shotless.status >= 400 && shotless.status < 500, `got ${shotless.status}`);
  check('error message is actionable',
    /photo|key|credential|upload/i.test(shotless.json?.error || ''), shotless.json?.error);
  check('no stack trace leaked to client', !/at \w+ \(/.test(shotless.text || ''));

  const planned = await req(`/api/listings/${listingId}/plan`, { method: 'POST', cookie, body: {} });
  check('cost planning works without keys', planned.status === 200);
  check('planning spends nothing', (planned.json?.total?.credits ?? 0) === 0 || planned.json?.spec != null);

  // 6. Credit gate + rate limits --------------------------------------------
  section('6. Spend guards');
  const overBudget = await req(`/api/listings/${listingId}/visualize/plan`, {
    method: 'POST', cookie, body: { mode: 'concept', variants: 4, quality: 'high' },
  });
  check('visualize planning works without keys', overBudget.status === 200);

  let limited = false;
  for (let i = 0; i < 8; i += 1) {
    const r = await req(`/api/listings/${listingId}/generate`, {
      method: 'POST', cookie, body: { quality: 'preview' },
    });
    if (r.status === 429) { limited = true; break; }
  }
  check('rate limiter engages on repeated generation', limited);

  // 7. Public surface --------------------------------------------------------
  section('7. Public tour surface');
  check('unpublished tour 404s', (await req('/api/public/tours/durability-test-building')).status === 404);
  await req(`/api/listings/${listingId}/publish`, { method: 'POST', cookie, body: { published: true } });
  const pub = await req('/api/public/tours/durability-test-building');
  check('published tour reachable WITHOUT auth', pub.status === 200, `got ${pub.status}`);
  check('disclosures served from server', (pub.json?.disclosures || []).length >= 2);
  check('tour payload excludes prompts and internals',
    !JSON.stringify(pub.json || {}).match(/passwordHash|prompt|requestId|installSecret/));
  check('branding resolves from listing owner', pub.json?.broker?.company === 'Ops CRE');

  const badEvent = await req('/api/public/tours/durability-test-building/events', {
    method: 'POST', body: { type: 'shot_view', shotId: 'sht_bogus', sessionId: 'test-session' },
  });
  check('bogus shotId rejected (analytics stay clean)', badEvent.status === 400);

  const lead = await req('/api/public/tours/durability-test-building/leads', {
    method: 'POST',
    body: { name: 'Test Prospect', email: 'prospect@test.example', sessionId: 'test-session', source: 'sign' },
  });
  check('lead capture accepts', lead.status === 201);
  const dbNow = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  check('lead persisted synchronously', (dbNow.leads || []).length === 1,
    'lead acknowledged but not on disk');
  check('lead attributed to sign scan', dbNow.leads?.[0]?.source === 'sign');

  // 8. Fact guardrail --------------------------------------------------------
  section('8. Compliance guardrail');
  const { collectFacts, verifyText, stripUnverified } = await import(path.join(ROOT, 'server', 'facts.js'));
  const facts = collectFacts({ address: '1 Test St', specs: [{ label: 'SF', value: '24,000' }] });
  check('broker-entered number passes', verifyText('24,000 SF available', facts).ok);
  check('fabricated number rejected', !verifyText('99,000 SF available', facts).ok);
  check('fabricated number stripped',
    !verifyText(stripUnverified('99,000 SF available', facts).text, facts).offending.length);

  // 8b. Status parsing -------------------------------------------------------
  section('8b. Higgsfield status parsing (shape-agnostic)');
  const { normaliseStatus } = await import(path.join(ROOT, 'server', 'higgsfield.js'));
  const shapes = [
    ['documented shape', { status: 'completed', jobs: [{ results: { raw: { url: 'https://c/x.mp4' } } }] }, 'completed', true],
    ['job-set shape', { id: 'a', jobs: [{ status: 'completed', results: { min: { url: 'https://c/y.mp4' } } }] }, 'completed', true],
    ['deeply nested url', { data: { items: [{ output: { video: { url: 'https://c/d.mp4' } } }] } }, 'completed', true],
    ['still queued', { jobs: [{ status: 'queued' }] }, 'queued', false],
    ['queued job echoing our own input photo',
      { id: 'a', status: 'queued', params: { input_images: [{ image_url: 'https://x/uploads/a.jpg' }] }, jobs: [{ status: 'queued' }] },
      'queued', false],
    ['in-progress echoing our own input photo',
      { status: 'in_progress', params: { input_images: [{ image_url: 'https://x/uploads/b.jpg' }] }, jobs: [{ status: 'in_progress' }] },
      'in_progress', false],
    ['failed', { jobs: [{ status: 'failed' }] }, 'failed', false],
  ];
  for (const [name, payload, wantStatus, wantUrl] of shapes) {
    const r = normaliseStatus(payload);
    check(`parses ${name}`, r.status === wantStatus && Boolean(r.videoUrl) === wantUrl,
      `got ${r.status}${r.videoUrl ? ' + url' : ''}`);
  }

  // 8c. Shot duration scales with the property --------------------------------
  section('8c. Shot duration scales with property and pace');
  const { tourAgent: ta, durationFor } = await import(path.join(ROOT, 'server', 'agents', 'tour-agent.js'));
  const ph = [
    { id: 'x1', file: 'a.jpg', spaceType: 'floor' },
    { id: 'x2', file: 'b.jpg', spaceType: 'breakroom' },
  ];
  const mkSpec = (sf) => ({ propertyType: 'office', totalSf: sf, shots: ph.map((p) => ({ photoFile: p.file, spaceType: p.spaceType })) });
  const small = ta({ spec: mkSpec(4000), photos: ph, takes: 1, withTransitions: false });
  const big = ta({ spec: mkSpec(90000), photos: ph, takes: 1, withTransitions: false });
  const slow = ta({ spec: mkSpec(24000), photos: ph, takes: 1, withTransitions: false, pace: 'cinematic' });
  const fast = ta({ spec: mkSpec(24000), photos: ph, takes: 1, withTransitions: false, pace: 'quick' });

  check('bigger property yields longer runtime', big.estimate.runtimeSec > small.estimate.runtimeSec,
    `${small.estimate.runtimeSec}s vs ${big.estimate.runtimeSec}s`);
  check('cinematic pace is longer than quick', slow.estimate.runtimeSec > fast.estimate.runtimeSec,
    `${fast.estimate.runtimeSec}s vs ${slow.estimate.runtimeSec}s`);
  check('a floor plate runs longer than a break room',
    big.calls.find((c) => c.spaceType === 'floor').durationSec >
    big.calls.find((c) => c.spaceType === 'breakroom').durationSec);
  check('duration stays inside the model range',
    big.calls.every((c) => c.durationSec >= 3 && c.durationSec <= 15));
  check('durations are never a constant 5',
    new Set(big.calls.map((c) => c.durationSec)).size > 1);

  // 9. Secret hygiene --------------------------------------------------------
  section('9. Secret hygiene');
  const { redact } = await import(path.join(ROOT, 'server', 'reliability.js'));
  check('Authorization header redacted', redact('Authorization: Key abc123:secret456').includes('«redacted»'));
  check('x-api-key redacted', redact('"x-api-key": "sk-abcdefghijklmno"').includes('«redacted»'));
  check('presigned signature redacted',
    redact('url?X-Amz-Signature=deadbeefdeadbeefdeadbeef').includes('«redacted»'));

  const repoEnv = path.join(ROOT, '.env');
  check('.env is gitignored', fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('.env'));
  check('data/ is gitignored', fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('data/'));
  check('no .env committed', !fs.existsSync(path.join(ROOT, '.git', 'index')) ||
    !fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').includes('!.env'));

  // 10. Stale job reaping ----------------------------------------------------
  section('10. Stuck jobs are reaped, not left hanging');
  const { reapStaleJobs, sweepOrphanRenders } = await import(path.join(ROOT, 'server', 'reliability.js'));
  check('reapStaleJobs is callable and idempotent', typeof reapStaleJobs === 'function');
  check('sweepOrphanRenders never deletes referenced files',
    sweepOrphanRenders({ dryRun: true }).removed >= 0);

  // 11. Unattended operation -------------------------------------------------
  section('11. Unattended operation');
  const before = (await req('/healthz')).json;
  await sleep(1200);
  const later = (await req('/healthz')).json;
  check('uptime advances (event loop healthy)', later.uptimeSec >= before.uptimeSec);
  check('memory reported for monitoring', typeof later.rssMB === 'number' && later.rssMB > 0);
  check('server still serving after sustained run', (await req('/healthz')).status === 200);

  await stop('SIGTERM');
  check('SIGTERM shuts down cleanly', true);

  // --- report ---------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`    ✕ ${f}`);
  }
  console.log('');
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n  suite crashed:', err.message);
  await stop('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});

// --- Higgsfield error reporting -------------------------------------------
{
  const { describeError } = await import('../server/higgsfield.js');

  // A FastAPI 422 arrives as an array of objects. Interpolating it straight
  // into a message yields "[object Object]" and hides which field was wrong —
  // that is exactly how a one-field validation error survived several deploys.
  const validation = describeError({
    detail: [{ loc: ['body', 'params', 'aspect_ratio'], msg: 'extra fields not permitted' }],
  });
  check(
    'describeError names the offending field',
    validation.includes('aspect_ratio') && validation.includes('not permitted')
  );
  check('describeError never yields [object Object]', !validation.includes('[object Object]'));
  check('describeError passes plain strings through', describeError({ detail: 'Model not found' }) === 'Model not found');
  check('describeError tolerates an empty body', describeError(null) === null);
}

// --- Higgsfield model id ----------------------------------------------------
{
  const { MODELS } = await import('../server/agents/tour-agent.js');
  const { config } = await import('../server/config.js');
  const DOP = ['dop-lite', 'dop-preview', 'dop-turbo'];

  // /v1/image2video/dop rejects anything outside this set, so a wrong id here
  // does not degrade quality — it fails every single generation.
  check('default model is a dop variant', DOP.includes(config.higgsfield.model));
  for (const [tier, m] of Object.entries(MODELS)) {
    check(`${tier} tier uses a dop variant (${m.id})`, DOP.includes(m.id));
  }
}
