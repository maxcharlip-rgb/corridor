import path from 'node:path';
import express from 'express';
import { config, higgsfieldConfigured } from './config.js';
import { getDb, flush, listings as listingsRepo } from './store.js';
import { api } from './routes/api.js';
import { publicApi } from './routes/public.js';
import { authApi } from './routes/auth.js';
import { loadAccount, requireAuth, authEnabled } from './auth.js';
import { migrateGlobalBranding } from './branding.js';
import { resumePending } from './jobs.js';
import { ffmpegAvailable } from './render-preview.js';

const app = express();
app.disable('x-powered-by');

// Uploads and renders are served as static assets. Higgsfield needs to be able
// to fetch /uploads/* directly when rendering in Cinematic quality.
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '1h' }));
app.use('/renders', express.static(config.rendersDir, { maxAge: '1h' }));
app.use(express.static(config.publicDir, { extensions: ['html'] }));

// Session is loaded for every request; requireAuth decides what is gated.
// The public tour API sits ABOVE auth on purpose — a prospect scanning a sign
// must never meet a login screen.
app.use(loadAccount);
app.use('/api/public', publicApi);
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
  res.json({
    ok: true,
    preview: ffmpegAvailable(),
    cinematic: higgsfieldConfigured,
    listings: getDb().listings.length,
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
});

function shutdown(signal) {
  console.log(`\n${signal} received — saving and closing.`);
  flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
