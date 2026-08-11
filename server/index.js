import path from 'node:path';
import express from 'express';
import { config, higgsfieldConfigured } from './config.js';
import { getDb, flush, listings as listingsRepo } from './store.js';
import { api } from './routes/api.js';
import { publicApi } from './routes/public.js';
import { intakeApi } from './routes/intake.js';
import { authApi } from './routes/auth.js';
import { loadAccount, requireAuth, authEnabled } from './auth.js';
import { migrateGlobalBranding } from './branding.js';
import {
  installProcessGuards,
  installSafeLogging,
  startHousekeeping,
  healthSnapshot,
} from './reliability.js';
import { resumePending } from './jobs.js';
import { ffmpegAvailable } from './render-preview.js';

// Install before anything else can log or throw.
installSafeLogging();
installProcessGuards({ onFatal: () => flush() });

const app = express();

/* Render terminates TLS at exactly one proxy hop in front of this process.
   Without this, req.ip is the proxy's address — the same value for every
   visitor — so every rate-limit bucket is shared and one busy account can lock
   out all the others. It also makes the Secure-cookie decision in auth.js
   correct, since req.secure is derived from the forwarded protocol. */
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Uploads and renders are served as static assets. Higgsfield needs to be able
// to fetch /uploads/* directly when rendering in Cinematic quality.
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h' }));
/* Render filenames are stable and their contents are not: a re-render writes
   ${shot.id}_preview.mp4 and ${slug}_reel.mp4 again. A one-hour immutable cache
   therefore serves the previous cut — a broker rebuilds a tour, downloads it,
   and gets the old video with no indication anything is stale. */
app.use('/renders', express.static(config.rendersDir, { maxAge: 0, etag: true }));
app.use(express.static(config.publicDir, { extensions: ['html'] }));

// Session is loaded for every request; requireAuth decides what is gated.
// The public tour API sits ABOVE auth on purpose — a prospect scanning a sign
// must never meet a login screen.
app.use(loadAccount);
app.use('/api/public', publicApi);
// Before the authenticated '/api' router below, which would otherwise swallow
// it: intake is by definition from someone who has no account yet.
app.use('/api/intake', intakeApi);
app.use('/api/auth', authApi);
app.use('/api', requireAuth, api);

// Public tour viewer — one route, slug resolved client-side from the path.
app.get('/t/:slug', (req, res) => {
  const listing = listingsRepo.bySlug(req.params.slug);
  if (!listing || !listing.published) {
    return res.status(404).sendFile(path.join(config.publicDir, '404.html'));
  }
  res.sendFile(path.join(config.publicDir, 'tour.html'));
});

app.get('/healthz', (_req, res) => {
  const snap = healthSnapshot();
  res.json({
    ok: true,
    preview: ffmpegAvailable(),
    cinematic: higgsfieldConfigured,
    ...snap,
  });
});

const server = app.listen(config.port, () => {
  const line = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`);
  console.log('\n  Corridor — cinematic tours for commercial real estate\n');
  line('Studio', `http://localhost:${config.port}`);
  line('Preview', ffmpegAvailable() ? `ready (${config.ffmpeg})` : 'UNAVAILABLE — install ffmpeg');
  line(
    'Cinematic',
    higgsfieldConfigured
      ? `ready (${config.higgsfield.model})`
      : 'not configured — add HIGGSFIELD_KEY_ID / HIGGSFIELD_KEY_SECRET to .env'
  );
  // Hosted platforms (Render, Railway, Fly, Heroku) have ephemeral filesystems.
  // If state is sitting inside the deployed checkout, the next deploy silently
  // destroys every account, listing, lead and rendered video — and published
  // tour links start 404ing. Loud, because the failure is otherwise invisible
  // until the first redeploy.
  const hosted = process.env.RENDER || process.env.RAILWAY_ENVIRONMENT ||
    process.env.FLY_APP_NAME || process.env.DYNO || process.env.KUBERNETES_SERVICE_HOST;
  if (hosted && !process.env.CORRIDOR_DATA_DIR) {
    console.warn(
      '\n  ⚠  EPHEMERAL STATE: running on a hosted platform with CORRIDOR_DATA_DIR unset,\n' +
        `     so data lives in the checkout (${config.dataDir}). The next deploy will\n` +
        '     erase every account, listing, lead and render, and published tour links\n' +
        '     will 404. Mount a persistent disk and point CORRIDOR_DATA_DIR at it.\n'
    );
  }

  if (higgsfieldConfigured && /localhost|127\.0\.0\.1/i.test(config.publicUrl)) {
    console.log(
      '\n  Note: PUBLIC_URL is localhost. Higgsfield downloads your photos over the\n' +
        '  public internet, so Cinematic renders need a reachable PUBLIC_URL (a tunnel).\n' +
        '  Preview renders are unaffected.'
    );
  }
  console.log('');
  migrateGlobalBranding();
  resumePending();
  startHousekeeping();
});

function shutdown(signal) {
  console.log(`\n${signal} received — saving and closing.`);
  flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
