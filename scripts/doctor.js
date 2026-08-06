#!/usr/bin/env node
/**
 * Preflight. Spends nothing, calls nothing external.
 *
 * Run before a demo: `npm run doctor`
 *
 * Every check that could block a live brokerage demo is here, and each failure
 * says what to do about it rather than just what is wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config, higgsfieldConfigured, ROOT } from '../server/config.js';
import { fontsAvailable } from '../server/endcard.js';
import { ffmpegAvailable } from '../server/render-preview.js';
import { creditBudget } from '../server/limits.js';

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });
const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

// --- rendering -------------------------------------------------------------
ffmpegAvailable()
  ? add(OK, 'ffmpeg', config.ffmpeg)
  : add(FAIL, 'ffmpeg', 'Not found. Previews, stabilisation, overlays and reels all need it. `npm i ffmpeg-static`');

fontsAvailable()
  ? add(OK, 'fonts', 'end cards and text overlays can render')
  : add(FAIL, 'fonts', 'No usable TTF found — end cards and overlays will be skipped. Add a path in server/endcard.js');

// --- Higgsfield ------------------------------------------------------------
if (!higgsfieldConfigured) {
  add(WARN, 'higgsfield keys', 'Not set. Preview quality works; Cinematic is disabled. Set HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET in .env');
} else {
  add(OK, 'higgsfield keys', `present · model ${config.higgsfield.model}`);
}

// The API has to fetch our photos over the public internet. This is the single
// most common reason a first cinematic render fails.
if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(config.publicUrl)) {
  add(
    higgsfieldConfigured ? FAIL : WARN,
    'PUBLIC_URL',
    `${config.publicUrl} is local-only. Higgsfield downloads photos from this origin, so cinematic ` +
      'renders will fail. Set PUBLIC_URL to a tunnel (cloudflared/ngrok) before demoing.'
  );
} else {
  add(OK, 'PUBLIC_URL', config.publicUrl);
}

// --- spend guards ----------------------------------------------------------
creditBudget()
  ? add(OK, 'credit budget', `${creditBudget()} credits/month ceiling`)
  : add(WARN, 'credit budget', 'CREDIT_BUDGET unset — no ceiling on monthly spend. Set it in .env');

// --- storage ---------------------------------------------------------------
for (const [label, dir] of [
  ['uploads dir', config.uploadsDir],
  ['renders dir', config.rendersDir],
]) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    add(OK, label, dir);
  } catch {
    add(FAIL, label, `${dir} is not writable`);
  }
}

if (fs.existsSync(config.dbFile)) {
  try {
    const db = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    add(OK, 'database', `${db.listings?.length || 0} listings · ${db.leads?.length || 0} leads`);
  } catch {
    add(FAIL, 'database', 'db.json exists but will not parse');
  }
} else {
  add(OK, 'database', 'fresh (no db.json yet)');
}

// --- port ------------------------------------------------------------------
const portFree = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(config.port, '127.0.0.1');
});
portFree
  ? add(OK, 'port', `${config.port} available`)
  : add(WARN, 'port', `${config.port} already in use — an instance may already be running`);

// --- model sanity (free) -----------------------------------------------------
const KNOWN_MODELS = [
  'cinematic_studio_video_v2', 'cinematic_studio_3_0', 'cinematic_studio_video',
  'kling3_0', 'kling3_0_turbo', 'kling2_6', 'seedance_2_0', 'seedance_2_0_mini',
  'veo3', 'veo3_1', 'veo3_1_lite', 'minimax_hailuo', 'wan2_6', 'wan2_7',
  'grok_video', 'grok_video_v15', 'flux_3_video', 'gemini_omni', 'higgsfield_preset',
];
KNOWN_MODELS.includes(config.higgsfield.model)
  ? add(OK, 'video model', config.higgsfield.model)
  : add(FAIL, 'video model',
      `"${config.higgsfield.model}" is not a known Higgsfield model id. An unknown id is ` +
      'accepted and BILLED but returns a degenerate clip. Use cinematic_studio_video_v2.');

// --- live Higgsfield probe (free) -------------------------------------------
if (higgsfieldConfigured) {
  const { diagnose } = await import('../server/higgsfield-diagnose.js');
  const d = await diagnose();
  add(d.auth.ok ? OK : FAIL, 'higgsfield auth', d.auth.detail);
  add(d.publicUrl.ok ? OK : (higgsfieldConfigured ? FAIL : WARN), 'image reachability', d.publicUrl.detail);
}

// --- report ----------------------------------------------------------------
const icon = { ok: '  ✓', warn: '  !', fail: '  ✕' };
console.log('\n  Corridor preflight\n');
for (const r of results) {
  console.log(`${icon[r.level]} ${r.name.padEnd(16)} ${r.detail}`);
}

const fails = results.filter((r) => r.level === FAIL).length;
const warns = results.filter((r) => r.level === WARN).length;
console.log(
  `\n  ${fails ? `${fails} blocking` : 'no blocking issues'}${warns ? `, ${warns} warning(s)` : ''}\n`
);

if (higgsfieldConfigured && !fails) {
  console.log('  Next: verify the REST path actually works (spends 5 credits):');
  console.log('    node scripts/verify-higgsfield.js --confirm\n');
}

process.exit(fails ? 1 : 0);
