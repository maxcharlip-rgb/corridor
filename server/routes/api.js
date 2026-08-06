import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, higgsfieldConfigured } from '../config.js';
import {
  getDb, save, id, now, slugify,
  listings as listingsRepo,
  photos as photosRepo,
  shots as shotsRepo,
  leads as leadsRepo,
  events as eventsRepo,
} from '../store.js';
import { MOTIONS, MOTION_BY_KEY, SPACE_TYPES, SPACE_BY_KEY, guessSpaceType, buildPrompt, motionEnvKey } from '../motions.js';
import { enqueuePreview, submitCinematic, selectTake, queueDepth, startVisualPolling, DEFAULT_TAKES } from '../jobs.js';
import { renderEndCard, applyTextOverlays, buildSpecLine, fontsAvailable } from '../endcard.js';
import {
  canGenerateVideo,
  recordCreditSpend,
  creditsUsedThisMonth,
  creditBudget,
  CREDITS_PER_TAKE,
  generateLimiter,
  dailyGenerateLimiter,
} from '../limits.js';
import { ffmpegAvailable, stitchReel } from '../render-preview.js';
import { enhancePhoto, stagePhoto, stagingConfigured, ENHANCE_PROFILES } from '../photo-ops.js';
import { renderSign, qrDataUrl, taggedUrl, SIGN_FORMATS, SHARE_CHANNELS } from '../signkit.js';
import { submitImageGeneration } from '../higgsfield.js';
import { diagnose } from '../higgsfield-diagnose.js';
import { ownsListing, authEnabled } from '../auth.js';
import { collectFacts, stripUnverified, logFactUse, DISCLOSURES } from '../facts.js';
import { brandingForAccount, brandingForListing, updateBranding, BRAND_FIELDS } from '../branding.js';
import { specAgent, buildSpecFromBrokerInput } from '../agents/spec-agent.js';
import { tourAgent, captionTrack, heroTextFor, PACES } from '../agents/tour-agent.js';
import { envisionAgent, VISUALIZE_MODES, VISUAL_STYLES, IMAGE_MODELS } from '../agents/envision-agent.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));

/* Formats the whole pipeline can actually handle.
 *
 * HEIC is deliberately absent. It was accepted, stored and advertised in the
 * UI, but nothing downstream can read it: express serves it as
 * application/octet-stream so thumbnails render blank, the bundled ffmpeg has
 * no HEIF demuxer so previews fail, and the cinematic path hands the URL to
 * Higgsfield and spends credits on a file the model cannot decode. Accepting an
 * upload we cannot use is worse than refusing it with instructions. */
const ALLOWED_IMAGE = /^image\/(jpeg|png|webp)$/i;
const HEIC_IMAGE = /^image\/(heic|heif)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `${id('img')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 60 },
  /* Skip a bad file rather than abort the request.
   *
   * multer aborts the whole upload on the first rejection, so one screenshot or
   * one oversized frame in a 40-photo drop discarded every good photo and
   * persisted nothing. A broker reads that as "the upload is broken". Record
   * the reason and keep going; the handler reports what was skipped. */
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE.test(file.mimetype)) return cb(null, true);
    req.rejectedFiles = req.rejectedFiles || [];
    req.rejectedFiles.push({
      name: file.originalname,
      reason: HEIC_IMAGE.test(file.mimetype)
        ? 'HEIC is not supported yet. On iPhone: Settings → Camera → Formats → "Most Compatible", or export as JPEG.'
        : 'Only JPEG, PNG and WebP images are supported.',
    });
    cb(null, false);
  },
});

/** Wrap an async handler so a rejection becomes a clean 400/500 instead of a hang. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireListing(req) {
  const listing = listingsRepo.byId(req.params.listingId || req.params.id);
  if (!listing) {
    const err = new Error('Listing not found.');
    err.status = 404;
    throw err;
  }
  // 404 rather than 403 on someone else's listing — don't confirm it exists.
  if (!ownsListing(req.account, listing)) {
    const err = new Error('Listing not found.');
    err.status = 404;
    throw err;
  }
  return listing;
}

/** Listings the signed-in account may see. */
function visibleListings(req) {
  if (!authEnabled()) return listingsRepo.all();
  return listingsRepo.all().filter((l) => ownsListing(req.account, l));
}

function requireShot(req) {
  const shot = shotsRepo.byId(req.params.shotId || req.params.id);
  if (!shot) {
    const err = new Error('Shot not found.');
    err.status = 404;
    throw err;
  }
  // A shot is only reachable through a listing the account owns.
  if (!ownsListing(req.account, listingsRepo.byId(shot.listingId))) {
    const err = new Error('Shot not found.');
    err.status = 404;
    throw err;
  }
  return shot;
}

// --- bootstrap ---------------------------------------------------------------

api.get('/bootstrap', (_req, res) => {
  const db = getDb();
  res.json({
    broker: brandingForAccount(_req.account?.id || null),
    motions: MOTIONS.map((m) => ({
      key: m.key,
      label: m.label,
      tagline: m.tagline,
      description: m.description,
      bestFor: m.bestFor,
      inputs: m.inputs,
      higgsfieldMotion: m.higgsfieldMotion,
      motionIdEnv: motionEnvKey(m.key),
      motionIdSet: Boolean(process.env[motionEnvKey(m.key)]),
    })),
    spaceTypes: SPACE_TYPES,
    enhanceProfiles: ENHANCE_PROFILES,
    signFormats: Object.values(SIGN_FORMATS),
    paces: Object.values(PACES),
    visualizeModes: Object.values(VISUALIZE_MODES),
    visualStyles: VISUAL_STYLES,
    imageModels: IMAGE_MODELS,
    shareChannels: SHARE_CHANNELS,
    capabilities: {
      preview: ffmpegAvailable(),
      cinematic: higgsfieldConfigured,
      staging: stagingConfigured(),
      publicUrl: config.publicUrl,
      publicUrlIsLocal: /localhost|127\.0\.0\.1/i.test(config.publicUrl),
      model: config.higgsfield.model,
    },
    credits: {
      usedThisMonth: creditsUsedThisMonth(),
      budget: creditBudget() || null,
      perTake: CREDITS_PER_TAKE,
    },
    listings: visibleListings(_req).map((l) => summarise(l)),
  });
});

function summarise(listing) {
  const listingShots = shotsRepo.forListing(listing.id);
  const ready = listingShots.filter((s) => s.status === 'ready').length;
  return {
    ...listing,
    photoCount: photosRepo.forListing(listing.id).length,
    shotCount: listingShots.length,
    readyCount: ready,
    leadCount: leadsRepo.forListing(listing.id).length,
    viewCount: eventsRepo.forListing(listing.id).filter((e) => e.type === 'tour_open').length,
  };
}

api.put('/broker', handle(async (req, res) => {
  // Branding belongs to an account, never to the install. There is no global
  // fallback to write to any more.
  if (!req.account) {
    return res.status(401).json({ error: 'Sign in to set your brokerage details.' });
  }
  res.json(updateBranding(req.account.id, req.body || {}));
}));

// --- listings ----------------------------------------------------------------

api.post('/listings', handle(async (req, res) => {
  const { name, address, propertyType, headline } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'A building name is required.' });
  }
  const listing = {
    id: id('lst'),
    ownerId: req.account?.id || null,
    slug: slugify(name),
    name: String(name).trim(),
    address: address || '',
    propertyType: propertyType || 'office',
    headline: headline || '',
    specs: [],
    cta: { label: 'Request a showing', enabled: true },
    published: false,
    createdAt: now(),
    updatedAt: now(),
  };
  getDb().listings.push(listing);
  save();
  res.status(201).json(summarise(listing));
}));

api.get('/listings/:id', handle(async (req, res) => {
  const listing = requireListing(req);
  res.json({
    listing: summarise(listing),
    photos: photosRepo.forListing(listing.id),
    shots: shotsRepo.forListing(listing.id).map(decorateShot),
    queue: queueDepth(),
  });
}));

api.patch('/listings/:id', handle(async (req, res) => {
  const listing = requireListing(req);
  const fields = ['name', 'address', 'propertyType', 'headline', 'specs', 'cta', 'published'];
  const previousName = listing.name;
  for (const field of fields) {
    if (req.body[field] !== undefined) listing[field] = req.body[field];
  }

  /* Let the slug follow the name.
   *
   * The upload flow creates the listing as "Untitled tour" before the broker
   * has named anything, and the slug was fixed at creation — so a renamed
   * building kept /t/untitled-tour as its public link and untitled-tour_reel.mp4
   * as its download, forever. That link is the product: it goes on the sign,
   * the QR code and the CoStar post.
   *
   * The old slug is kept as an alias so anything already shared keeps resolving. */
  if (listing.name !== previousName) {
    const next = slugify(listing.name);
    if (next !== listing.slug) {
      listing.slugAliases = [...new Set([...(listing.slugAliases || []), listing.slug])];
      listing.slug = next;
    }
  }

  listing.updatedAt = now();
  save();
  res.json(summarise(listing));
}));

api.delete('/listings/:id', handle(async (req, res) => {
  const listing = requireListing(req);
  const db = getDb();
  db.listings = db.listings.filter((l) => l.id !== listing.id);
  db.photos = db.photos.filter((p) => p.listingId !== listing.id);
  db.shots = db.shots.filter((s) => s.listingId !== listing.id);
  save();
  res.json({ ok: true });
}));

// --- photos ------------------------------------------------------------------

api.post('/listings/:id/photos', upload.array('photos', 60), handle(async (req, res) => {
  const listing = requireListing(req);
  const existing = photosRepo.forListing(listing.id);
  let order = existing.length;

  const created = (req.files || []).map((file) => {
    const spaceType = guessSpaceType(file.originalname);
    const photo = {
      id: id('pho'),
      listingId: listing.id,
      file: file.filename,
      originalName: file.originalname,
      originalFile: file.filename,
      spaceType,
      caption: '',
      staged: false,
      enhanced: null,
      order: order++,
      createdAt: now(),
    };
    getDb().photos.push(photo);
    return photo;
  });

  listing.updatedAt = now();
  save();

  /* Report both halves. The client needs the photos that landed AND the ones
     that did not, or a partial upload looks like a complete one. */
  const rejected = req.rejectedFiles || [];
  if (!created.length && rejected.length) {
    return res.status(400).json({ error: rejected[0].reason, rejected });
  }
  res.status(201).json(rejected.length ? { photos: created, rejected } : created);
}));

api.patch('/photos/:id', handle(async (req, res) => {
  const photo = photosRepo.byId(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  for (const field of ['spaceType', 'caption', 'order']) {
    if (req.body[field] !== undefined) photo[field] = req.body[field];
  }
  save();
  res.json(photo);
}));

api.post('/photos/reorder', handle(async (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array.' });
  orderedIds.forEach((photoId, index) => {
    const photo = photosRepo.byId(photoId);
    if (photo) photo.order = index;
  });
  save();
  res.json({ ok: true });
}));

api.delete('/photos/:id', handle(async (req, res) => {
  const photo = photosRepo.byId(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });
  const db = getDb();
  db.photos = db.photos.filter((p) => p.id !== photo.id);
  // Any shot that depended on this photo is no longer renderable.
  for (const shot of db.shots) {
    if (shot.photoIds?.includes(photo.id)) {
      shot.photoIds = shot.photoIds.filter((pid) => pid !== photo.id);
      if (!shot.photoIds.length) shot.status = 'draft';
    }
  }
  save();
  res.json({ ok: true });
}));

api.post('/photos/:id/enhance', handle(async (req, res) => {
  const photo = photosRepo.byId(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  const { profile = 'balanced', revert = false } = req.body || {};
  if (revert) {
    photo.file = photo.originalFile;
    photo.enhanced = null;
    save();
    return res.json(photo);
  }

  const outFile = await enhancePhoto({ sourceFile: photo.originalFile, profile });
  photo.file = outFile;
  photo.enhanced = profile;
  save();
  res.json(photo);
}));

api.post('/photos/:id/stage', handle(async (req, res) => {
  const photo = photosRepo.byId(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  const space = SPACE_BY_KEY[photo.spaceType]?.label || 'commercial space';
  const prompt =
    req.body?.prompt ||
    `Virtually stage this empty ${space.toLowerCase()} with tasteful, contemporary commercial furniture. ` +
      'Keep every wall, window, column, ceiling and floor finish exactly as photographed. Do not alter the architecture.';

  const outFile = await stagePhoto({ sourceFile: photo.originalFile, prompt });
  photo.file = outFile;
  photo.staged = true; // drives the permanent disclosure badge in the public tour
  save();
  res.json(photo);
}));

// --- shots -------------------------------------------------------------------

function decorateShot(shot) {
  const motion = MOTION_BY_KEY[shot.motionKey];
  const cinematicReady = Boolean(shot.cinematic?.file);
  return {
    ...shot,
    motionLabel: motion?.label || shot.motionKey,
    motionInputs: motion?.inputs || 1,
    bestQuality: cinematicReady ? 'cinematic' : shot.preview?.file ? 'preview' : null,
    videoUrl: cinematicReady
      ? `/renders/${shot.cinematic.file}`
      : shot.preview?.file
        ? `/renders/${shot.preview.file}`
        : null,
    posterUrl: cinematicReady && shot.cinematic.poster
      ? `/renders/${shot.cinematic.poster}`
      : shot.preview?.poster
        ? `/renders/${shot.preview.poster}`
        : null,
  };
}

function makeShot(listingId, { photoIds, motionKey, spaceType, title, order, durationSec }) {
  return {
    id: id('sht'),
    listingId,
    order,
    title: title || '',
    caption: '',
    spaceType: spaceType || 'floor',
    motionKey: motionKey || 'dolly_in',
    photoIds,
    durationSec: durationSec || (MOTION_BY_KEY[motionKey]?.inputs === 2 ? 6 : 5),
    direction: '',
    promptOverride: '',
    status: 'draft',
    preview: null,
    cinematic: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

api.post('/listings/:id/shots', handle(async (req, res) => {
  const listing = requireListing(req);
  const { photoIds, motionKey, spaceType, title, durationSec } = req.body || {};
  if (!Array.isArray(photoIds) || !photoIds.length) {
    return res.status(400).json({ error: 'Select at least one photo for this shot.' });
  }
  const motion = MOTION_BY_KEY[motionKey || 'dolly_in'];
  if (!motion) return res.status(400).json({ error: `Unknown camera move "${motionKey}".` });
  if (motion.inputs === 2 && photoIds.length < 2) {
    return res.status(400).json({ error: `"${motion.label}" needs two photos.` });
  }

  const order = shotsRepo.forListing(listing.id).length;
  const shot = makeShot(listing.id, { photoIds, motionKey, spaceType, title, order, durationSec });
  getDb().shots.push(shot);
  save();
  res.status(201).json(decorateShot(shot));
}));

/**
 * Auto-sequence a tour from the uploaded photos.
 * Orders by how a physical tour actually runs (exterior → entrance → lobby →
 * corridor → floor → amenities → rooftop) and assigns each space the camera
 * move that suits it. Optionally weaves in two-photo blends so consecutive
 * rooms read as one continuous walk instead of a slideshow.
 */
api.post('/listings/:id/autoplan', handle(async (req, res) => {
  const listing = requireListing(req);
  const { withTransitions = true, replace = true } = req.body || {};

  const photos = photosRepo.forListing(listing.id);
  if (!photos.length) return res.status(400).json({ error: 'Upload some photos first.' });

  const db = getDb();
  if (replace) {
    db.shots = db.shots.filter((s) => s.listingId !== listing.id);
  }

  const sorted = [...photos].sort((a, b) => {
    const oa = SPACE_BY_KEY[a.spaceType]?.order ?? 999;
    const ob = SPACE_BY_KEY[b.spaceType]?.order ?? 999;
    return oa - ob || a.order - b.order;
  });

  let order = replace ? 0 : shotsRepo.forListing(listing.id).length;
  const created = [];

  sorted.forEach((photo, index) => {
    const space = SPACE_BY_KEY[photo.spaceType];
    const shot = makeShot(listing.id, {
      photoIds: [photo.id],
      motionKey: space?.defaultMotion || 'dolly_in',
      spaceType: photo.spaceType,
      title: space?.label || 'Stop',
      order: order++,
    });
    db.shots.push(shot);
    created.push(shot);

    // A blend only makes sense between two *different* rooms — between two
    // angles of the same room it just looks like a stutter.
    const next = sorted[index + 1];
    if (withTransitions && next && next.spaceType !== photo.spaceType) {
      const transition = makeShot(listing.id, {
        photoIds: [photo.id, next.id],
        motionKey: 'blend_transition',
        spaceType: 'transition',
        title: `${space?.label || 'Stop'} → ${SPACE_BY_KEY[next.spaceType]?.label || 'Next'}`,
        order: order++,
      });
      db.shots.push(transition);
      created.push(transition);
    }
  });

  save();
  res.status(201).json(created.map(decorateShot));
}));

api.patch('/shots/:id', handle(async (req, res) => {
  const shot = requireShot(req);
  for (const field of ['title', 'caption', 'spaceType', 'motionKey', 'photoIds', 'durationSec', 'direction', 'promptOverride']) {
    if (req.body[field] !== undefined) shot[field] = req.body[field];
  }
  shot.updatedAt = now();
  save();
  res.json(decorateShot(shot));
}));

api.delete('/shots/:id', handle(async (req, res) => {
  const shot = requireShot(req);
  const db = getDb();
  db.shots = db.shots.filter((s) => s.id !== shot.id);
  save();
  res.json({ ok: true });
}));

api.post('/shots/reorder', handle(async (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array.' });
  orderedIds.forEach((shotId, index) => {
    const shot = shotsRepo.byId(shotId);
    if (shot) shot.order = index;
  });
  save();
  res.json({ ok: true });
}));

/** Show the exact prompt that will be sent, before any credits are spent. */
api.get('/shots/:id/prompt', handle(async (req, res) => {
  const shot = requireShot(req);
  const motion = MOTION_BY_KEY[shot.motionKey] || MOTIONS[0];
  const prompt = buildPrompt(shot, {
    listing: listingsRepo.byId(shot.listingId),
    motion,
    spaceType: SPACE_BY_KEY[shot.spaceType],
  });
  res.json({ prompt, motion: motion.label, model: config.higgsfield.model });
}));

/* Apply the paid-generation limits only to generations that actually cost
   money. A preview is a local ffmpeg render that spends nothing and calls
   nothing, but it shared the 5/minute cap with Higgsfield submissions — so a
   broker storyboarding an ordinary 8-shot tour was rate-limited out of the
   free path partway through. */
const costsCredits = (mw) => (req, res, next) =>
  (req.body?.quality === 'cinematic' ? mw(req, res, next) : next());

api.post('/shots/:id/render', costsCredits(generateLimiter), costsCredits(dailyGenerateLimiter), handle(async (req, res) => {
  const shot = requireShot(req);
  const quality = req.body?.quality === 'cinematic' ? 'cinematic' : 'preview';

  if (quality === 'cinematic') {
    const takes = Number(req.body?.takes) || DEFAULT_TAKES;

    // Credit gate BEFORE the call — a runaway loop must be stopped while the
    // credits still exist, not reported after they are gone.
    const gate = canGenerateVideo(takes * CREDITS_PER_TAKE);
    if (!gate.ok) return res.status(402).json({ error: gate.reason, ...gate });

    const updated = await submitCinematic(shot.id, takes);
    const submitted = (updated.takes || []).filter((t) => t.status === 'queued').length;
    recordCreditSpend({
      credits: submitted * CREDITS_PER_TAKE,
      shotId: shot.id,
      note: `${submitted} take(s)`,
    });
    return res.json(decorateShot(updated));
  }
  const updated = enqueuePreview(shot.id);
  res.json(decorateShot(updated));
}));

/**
 * Dry run. Parses the broker's notes, plans every Higgsfield call, and returns
 * the full cost — without submitting anything. This is the "what will this cost
 * me" screen, and it is the safest thing in the API: it cannot spend money.
 */
api.post('/listings/:id/plan', handle(async (req, res) => {
  const listing = requireListing(req);
  const listingPhotos = photosRepo.forListing(listing.id);

  const spec = await specAgent({
    text: req.body?.notes || '',
    photos: listingPhotos,
    form: {
      address: listing.address || undefined,
      propertyType: listing.propertyType || undefined,
      headline: listing.headline || undefined,
      specs: listing.specs?.length ? listing.specs : undefined,
      envision: req.body?.envision,
    },
  });

  const tour = tourAgent({
    spec,
    photos: listingPhotos,
    takes: Number(req.body?.takes) || DEFAULT_TAKES,
    withTransitions: req.body?.withTransitions !== false,
    pace: req.body?.pace || listing.pace || 'standard',
  });

  const envision = req.body?.envision
    ? envisionAgent({ spec, photos: listingPhotos, perSpace: Number(req.body?.perSpace) || 2 })
    : { calls: [], estimate: { images: 0, totalCredits: 0 }, warnings: [] };

  const totalCredits = tour.estimate.totalCredits + envision.estimate.totalCredits;
  const gate = canGenerateVideo(totalCredits);

  res.json({
    spec,
    tour,
    envision,
    total: {
      credits: totalCredits,
      approxUsd: Number((totalCredits * 0.033).toFixed(2)),
      withinBudget: gate.ok,
      budgetMessage: gate.ok ? null : gate.reason,
    },
    warnings: [...tour.warnings, ...envision.warnings],
  });
}));

/**
 * Specs & Chat step. Turns the broker's form fields plus free text into a
 * structured spec, stores it, and applies the derived space types back onto the
 * photos so the storyboard reflects what they described.
 *
 * Planning only — spends no Higgsfield credits. The single Claude call is the
 * whole cost, and it degrades to a heuristic parse without a key.
 */
api.post('/listings/:id/specs', handle(async (req, res) => {
  const listing = requireListing(req);
  const listingPhotos = photosRepo.forListing(listing.id);

  const spec = await buildSpecFromBrokerInput({
    notes: req.body?.notes || '',
    photos: listingPhotos,
    form: {
      address: req.body?.address ?? listing.address ?? undefined,
      propertyType: req.body?.propertyType ?? listing.propertyType ?? undefined,
      headline: req.body?.headline ?? listing.headline ?? undefined,
      specs: req.body?.specs ?? (listing.specs?.length ? listing.specs : undefined),
      envision: req.body?.envision,
    },
  });

  // Push what the model understood back onto the records the studio renders.
  for (const shot of spec.shots || []) {
    const photo = listingPhotos.find((p) => p.file === shot.photoFile);
    if (photo && shot.spaceType) {
      photo.spaceType = shot.spaceType;
      if (shot.caption) photo.caption = shot.caption;
    }
  }

  if (spec.address) listing.address = spec.address;
  if (spec.headline) listing.headline = spec.headline;
  if (spec.propertyType) listing.propertyType = spec.propertyType;
  if (spec.specs?.length) listing.specs = spec.specs;
  listing.spec = spec;
  listing.specNotes = req.body?.notes || '';
  listing.updatedAt = now();
  save();

  res.json({ spec, listing: summarise(listing), photos: photosRepo.forListing(listing.id) });
}));

/**
 * One-call generation: plan → create shots → submit, all behind the guards.
 * Mounted at both /listings/:id/generate and /projects/:id/generate — this
 * codebase calls them listings, the product spec calls them projects.
 */
const generateHandler = handle(async (req, res) => {
  const listing = requireListing(req);
  const listingPhotos = photosRepo.forListing(listing.id);
  if (!listingPhotos.length) return res.status(400).json({ error: 'Upload photos first.' });

  const quality = req.body?.quality === 'cinematic' ? 'cinematic' : 'preview';
  const takes = Number(req.body?.takes) || DEFAULT_TAKES;

  const spec =
    listing.spec ||
    (await buildSpecFromBrokerInput({ notes: '', photos: listingPhotos, form: {} }));

  const plan = tourAgent({
    spec,
    photos: listingPhotos,
    takes,
    withTransitions: req.body?.withTransitions !== false,
    pace: req.body?.pace || listing.pace || 'standard',
  });
  if (req.body?.pace) { listing.pace = req.body.pace; save(); }
  if (!plan.calls.length) {
    return res.status(400).json({ error: 'Nothing to generate.', warnings: plan.warnings });
  }

  // Cost the whole job before creating anything.
  if (quality === 'cinematic') {
    const gate = canGenerateVideo(plan.estimate.totalCredits);
    if (!gate.ok) return res.status(402).json({ error: gate.reason, ...gate, plan: plan.estimate });
  }

  // Materialise the plan as shots, replacing any previous storyboard.
  const db = getDb();
  db.shots = db.shots.filter((s) => s.listingId !== listing.id);
  const created = plan.calls.map((call) =>
    makeShot(listing.id, {
      photoIds: call.photoIds,
      motionKey: call.motionKey,
      spaceType: call.spaceType,
      title: call.title,
      order: call.order,
      durationSec: call.durationSec,
    })
  );
  created.forEach((shot, i) => {
    shot.caption = plan.calls[i].heroText || '';
    shot.heroText = plan.calls[i].heroText || '';
    shot.model = plan.calls[i].request.model;
    shot.tier = plan.calls[i].tier;
    db.shots.push(shot);
  });
  save();

  const results = [];
  for (const shot of created) {
    try {
      if (quality === 'cinematic') {
        const updated = await submitCinematic(shot.id, takes);
        const submitted = (updated.takes || []).filter((t) => t.status === 'queued').length;
        recordCreditSpend({ credits: submitted * CREDITS_PER_TAKE, shotId: shot.id, note: 'generate' });
      } else {
        enqueuePreview(shot.id);
      }
      results.push({ shotId: shot.id, ok: true });
    } catch (err) {
      results.push({ shotId: shot.id, ok: false, error: err.message });
    }
  }

  res.status(202).json({
    status: 'processing',
    quality,
    shots: created.length,
    submitted: results.filter((r) => r.ok).length,
    estimate: plan.estimate,
    warnings: plan.warnings,
    results,
    poll: `/api/listings/${listing.id}`,
  });
});

api.post('/listings/:id/generate', generateLimiter, dailyGenerateLimiter, generateHandler);
api.post('/projects/:id/generate', generateLimiter, dailyGenerateLimiter, generateHandler);

/**
 * Live Higgsfield diagnosis. Costs nothing — validates credentials by sending a
 * deliberately invalid request (auth fails before the request is judged, so a
 * non-401 rejection proves the keys work) and separately checks that our
 * PUBLIC_URL is reachable from outside.
 */
api.get('/diagnostics/higgsfield', handle(async (req, res) => {
  const anyPhoto = getDb().photos[0];
  res.json(await diagnose({ sampleUploadFile: anyPhoto?.file || null }));
}));

// --- visualisation ------------------------------------------------------------
// The second workflow. Video tours remain the product; this answers the question
// a prospect asks in the room — "could this work for us?" — with a picture.

/** Dry run. Costs the image job without submitting anything. */
api.post('/listings/:id/visualize/plan', handle(async (req, res) => {
  const listing = requireListing(req);
  const plan = envisionAgent({
    listing,
    photos: photosRepo.forListing(listing.id),
    mode: req.body?.mode,
    style: req.body?.style,
    notes: Array.isArray(req.body?.notes) ? req.body.notes : [],
    photoIds: req.body?.photoIds || null,
    variants: Number(req.body?.variants) || 2,
    quality: req.body?.quality || 'standard',
  });
  const gate = canGenerateVideo(plan.estimate.totalCredits);
  res.json({ ...plan, withinBudget: gate.ok, budgetMessage: gate.ok ? null : gate.reason });
}));

/** Execute a visualisation plan, behind the same guards as video. */
api.post('/listings/:id/visualize', generateLimiter, dailyGenerateLimiter, handle(async (req, res) => {
  const listing = requireListing(req);
  const plan = envisionAgent({
    listing,
    photos: photosRepo.forListing(listing.id),
    mode: req.body?.mode,
    style: req.body?.style,
    notes: Array.isArray(req.body?.notes) ? req.body.notes : [],
    photoIds: req.body?.photoIds || null,
    variants: Number(req.body?.variants) || 2,
    quality: req.body?.quality || 'standard',
  });

  if (!plan.calls.length) {
    return res.status(400).json({ error: 'Nothing to visualise.', warnings: plan.warnings });
  }

  const gate = canGenerateVideo(plan.estimate.totalCredits);
  if (!gate.ok) return res.status(402).json({ error: gate.reason, ...gate, estimate: plan.estimate });

  listing.visuals = listing.visuals || [];
  const created = [];

  for (const call of plan.calls) {
    const visual = {
      id: id('vis'),
      mode: call.mode,
      title: call.title,
      photoId: call.photoId,
      status: 'queued',
      // Disclosure is attached at creation and travels with the record.
      requiresDisclosure: call.requiresDisclosure,
      disclosureLabel: call.disclosureLabel,
      prompt: call.request.prompt,
      createdAt: now(),
    };
    try {
      const { requestId } = await submitImageGeneration({
        imageUrl: call.request.imageUrl,
        prompt: call.request.prompt,
        model: call.request.model,
        aspectRatio: call.request.aspectRatio,
      });
      visual.requestId = requestId;
      recordCreditSpend({ credits: call.estimatedCredits, note: `visualize:${call.mode}` });
    } catch (err) {
      visual.status = 'failed';
      visual.error = err.message;
    }
    listing.visuals.push(visual);
    created.push(visual);
  }

  save();
  startVisualPolling();
  res.status(202).json({ status: 'processing', created: created.length, estimate: plan.estimate, visuals: created });
}));

api.get('/listings/:id/visuals', handle(async (req, res) => {
  const listing = requireListing(req);
  res.json({ visuals: listing.visuals || [], modes: Object.values(VISUALIZE_MODES), styles: VISUAL_STYLES });
}));

api.delete('/listings/:id/visuals/:visualId', handle(async (req, res) => {
  const listing = requireListing(req);
  listing.visuals = (listing.visuals || []).filter((v) => v.id !== req.params.visualId);
  save();
  res.json({ ok: true });
}));

/**
 * What Higgsfield actually returned. Owner-only, redacted.
 *
 * Exists because every video-side failure so far was diagnosed by shipping a
 * guess and waiting to see. This shows the real payload, the parse result, and
 * the file that landed on disk — enough to settle a question in one request
 * instead of one deploy.
 */
api.get('/listings/:id/debug/takes', handle(async (req, res) => {
  const listing = requireListing(req);
  const { redact } = await import('../reliability.js');
  const { probeVideoStream } = await import('../render-preview.js');

  const out = [];
  for (const shot of shotsRepo.forListing(listing.id)) {
    for (const take of shot.takes || []) {
      let onDisk = null;
      if (take.file) {
        const full = path.join(config.rendersDir, take.file);
        if (fs.existsSync(full)) {
          const stat = fs.statSync(full);
          const probe = await probeVideoStream(full);
          onDisk = { file: take.file, bytes: stat.size, codec: probe?.codec || null, seconds: probe?.seconds ?? null };
        }
      }
      out.push({
        shot: shot.title,
        shotId: shot.id,
        requestedDurationSec: shot.durationSec,
        model: shot.model || config.higgsfield.model,
        takeId: take.id,
        requestId: take.requestId,
        status: take.status,
        error: take.error || null,
        pollFailures: take.pollFailures || 0,
        parsed: take.lastParsed || null,
        onDisk,
        rawPayload: take.lastPayload ? redact(take.lastPayload) : null,
      });
    }
  }
  res.json({ listing: listing.name, takes: out });
}));

/** Promote one take to be the version the tour and reel use. */
api.post('/shots/:id/select-take', handle(async (req, res) => {
  const shot = requireShot(req);
  const updated = selectTake(shot.id, req.body?.takeId);
  res.json(decorateShot(updated));
}));

api.post('/listings/:id/render-all', costsCredits(generateLimiter), costsCredits(dailyGenerateLimiter), handle(async (req, res) => {
  const listing = requireListing(req);
  const quality = req.body?.quality === 'cinematic' ? 'cinematic' : 'preview';
  const targets = shotsRepo
    .forListing(listing.id)
    .filter((s) => s.photoIds?.length && (req.body?.force || s.status !== 'ready' || quality === 'cinematic'));

  // Batch generation is the single easiest way to burn a month of credits by
  // accident, so the whole batch is costed and gated up front.
  if (quality === 'cinematic') {
    const takes = Number(req.body?.takes) || DEFAULT_TAKES;
    const gate = canGenerateVideo(targets.length * takes * CREDITS_PER_TAKE);
    if (!gate.ok) return res.status(402).json({ error: gate.reason, ...gate });
  }

  const results = [];
  for (const shot of targets) {
    try {
      if (quality === 'cinematic') {
        const takes = Number(req.body?.takes) || DEFAULT_TAKES;
        const updated = await submitCinematic(shot.id, takes);
        const submitted = (updated.takes || []).filter((t) => t.status === 'queued').length;
        recordCreditSpend({ credits: submitted * CREDITS_PER_TAKE, shotId: shot.id, note: 'batch' });
      } else {
        enqueuePreview(shot.id);
      }
      results.push({ shotId: shot.id, ok: true });
    } catch (err) {
      results.push({ shotId: shot.id, ok: false, error: err.message });
    }
  }
  res.json({ quality, submitted: results.filter((r) => r.ok).length, results });
}));

// --- reel export -------------------------------------------------------------

/* One reel build per listing at a time.
 *
 * stitchReel now isolates its own scratch space, but the montage, overlaid and
 * end-card intermediates are still named per listing, so two overlapping builds
 * would trample each other's inputs. The studio issues two builds on the normal
 * path (one scheduled on render-complete, one immediate), so this is the
 * default flow rather than an edge case. Concurrent callers await the build
 * already running and receive its result instead of starting a second one. */
const reelBuilds = new Map();

api.post('/listings/:id/reel', handle(async (req, res) => {
  const listing = requireListing(req);

  const inFlight = reelBuilds.get(listing.id);
  if (inFlight) return res.json(await inFlight);

  const build = buildReel(req, listing).finally(() => reelBuilds.delete(listing.id));
  reelBuilds.set(listing.id, build);
  return res.json(await build);
}));

async function buildReel(req, listing) {
  const ordered = shotsRepo.forListing(listing.id);
  const clipPaths = ordered
    .map((shot) => {
      const file = shot.cinematic?.file || shot.preview?.file;
      return file ? path.join(config.rendersDir, file) : null;
    })
    .filter((p) => p && fs.existsSync(p));

  if (!clipPaths.length) {
    return res.status(400).json({ error: 'Render at least one shot before exporting a reel.' });
  }

  const broker = brandingForListing(listing);
  const outFile = `${listing.slug}_reel.mp4`;
  const outPath = path.join(config.rendersDir, outFile);
  const work = (name) => path.join(config.rendersDir, `${listing.slug}_${name}.mp4`);

  // 1. Montage of the selected takes, in storyboard order.
  const montagePath = work('montage');
  const stitched = await stitchReel({ clipPaths, outPath: montagePath });

  // 2. Burn in address / specs / CTA. The tour gets forwarded away from the
  //    listing page, so this information has to live inside the pixels.
  const overlayOpts = req.body?.overlays !== false;
  const montageSec = ordered
    .filter((shot) => shot.cinematic?.file || shot.preview?.file)
    .reduce((total, shot) => total + (shot.durationSec || 5), 0);

  // Compliance gate: nothing with an unverifiable number reaches a viewer.
  // Every number burned into the video must already exist in broker-entered data.
  const facts = collectFacts(listing, listing.spec);
  const clean = (value, context) => {
    const result = stripUnverified(value, facts);
    if (result.stripped.length) {
      logFactUse({ listingId: listing.id, accountId: req.account?.id, context, facts, text: value, stripped: result.stripped });
      console.warn('[facts] stripped unverifiable ' + JSON.stringify(result.stripped) + ' from ' + context);
    }
    return result.text;
  };

  let bodyPath = montagePath;
  /* Why overlays were skipped has to travel back to the caller. Silently
     returning overlays:false is how a reel shipped without the address and
     specs for weeks with the explanation sitting in a server log nobody read. */
  let overlaySkipped = null;
  let overlayFailed = null;
  if (!overlayOpts) overlaySkipped = 'not requested';
  else if (!fontsAvailable()) overlaySkipped = 'no usable font on this host — set FONT_PATH or reinstall dependencies';
  if (overlayOpts && fontsAvailable()) {
    try {
      const overlaidPath = work('overlaid');
      await applyTextOverlays({
        inPath: montagePath,
        outPath: overlaidPath,
        address: clean(req.body?.address ?? (listing.address || ''), 'overlay.address'),
        specLine: clean(req.body?.specLine ?? buildSpecLine(listing), 'overlay.specLine'),
        cta: req.body?.ctaText ?? [listing.cta?.label, broker.phone].filter(Boolean).join('  ·  '),
        captions: captionTrack(
          ordered
            .filter((shot) => shot.cinematic?.file || shot.preview?.file)
            .map((shot) => ({
              durationSec: shot.durationSec || 5,
              heroText: clean(shot.heroText || shot.caption || '', 'caption:' + shot.id),
            }))
        ),
        durationSec: montageSec,
        accent: broker.accent,
      });
      bodyPath = overlaidPath;
    } catch (err) {
      overlaySkipped = null;
      overlayFailed = err.message;
      console.error('[api] overlays failed, continuing without them:', err.message);
    }
  }

  // 3. End card, positioned front or back. Rendered fresh each build so profile
  //    edits always propagate.
  const position = ['start', 'end', 'none'].includes(req.body?.endCardPosition)
    ? req.body.endCardPosition
    : 'end';

  let endCardPath = null;
  let endCardSkipped = null;
  if (position === 'none') endCardSkipped = 'not requested';
  else if (!fontsAvailable()) endCardSkipped = 'no usable font on this host';
  if (position !== 'none' && fontsAvailable()) {
    try {
      endCardPath = work('endcard');
      await renderEndCard({
        broker,
        listing,
        photoPath: broker.photoFile
          ? path.join(config.uploadsDir, broker.photoFile)
          : null,
        durationSec: Number(req.body?.endCardSeconds) || 4,
        outPath: endCardPath,
      });
    } catch (err) {
      console.error('[api] end card failed, building reel without it:', err.message);
      endCardSkipped = err.message;
      endCardPath = null;
    }
  }

  if (endCardPath) {
    await stitchReel({
      clipPaths: position === 'start' ? [endCardPath, bodyPath] : [bodyPath, endCardPath],
      outPath,
    });
  } else {
    fs.copyFileSync(bodyPath, outPath);
  }

  listing.reelFile = outFile;
  listing.reelBuiltAt = now();
  listing.endCardPosition = position;
  save();

  return {
    url: `/renders/${outFile}`,
    clips: stitched.clips,
    endCard: Boolean(endCardPath),
    endCardPosition: position,
    overlays: bodyPath !== montagePath,
    overlaySkipped: overlayFailed || overlaySkipped,
    endCardSkipped,
    fonts: fontsAvailable(),
  };
}

// --- publish, leads, analytics ----------------------------------------------

api.post('/listings/:id/publish', handle(async (req, res) => {
  const listing = requireListing(req);
  listing.published = req.body?.published !== false;
  listing.updatedAt = now();
  save();
  res.json({
    published: listing.published,
    url: `${config.publicUrl}/t/${listing.slug}`,
  });
}));

// --- sign kit ----------------------------------------------------------------

/** Tagged links per channel + a QR preview, for the Publish tab. */
api.get('/listings/:id/signkit', handle(async (req, res) => {
  const listing = requireListing(req);
  const tourUrl = `${config.publicUrl}/t/${listing.slug}`;

  res.json({
    tourUrl,
    published: listing.published,
    qrPreview: await qrDataUrl(tourUrl, 'sign', 320),
    formats: Object.values(SIGN_FORMATS),
    links: SHARE_CHANNELS.map((channel) => ({
      ...channel,
      url: taggedUrl(tourUrl, channel.key),
    })),
  });
}));

/** Print-ready sign asset. SVG is vector, so it scales to any sign size. */
api.get('/listings/:id/sign.svg', handle(async (req, res) => {
  const listing = requireListing(req);
  const format = req.query.format || 'rider';
  if (!SIGN_FORMATS[format]) {
    return res.status(400).json({ error: `Unknown sign format "${format}".` });
  }

  const svg = await renderSign({
    format,
    tourUrl: `${config.publicUrl}/t/${listing.slug}`,
    listing,
    // A printed sign carrying the wrong firm's phone number is the worst
    // possible leak — it goes in the ground and stays there.
    broker: brandingForListing(listing),
    accent: brandingForListing(listing).accent,
  });

  res.type('image/svg+xml');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${listing.slug}-${format}.svg"`
  );
  res.send(svg);
}));

api.get('/listings/:id/leads', handle(async (req, res) => {
  const listing = requireListing(req);
  res.json(leadsRepo.forListing(listing.id));
}));

api.get('/listings/:id/analytics', handle(async (req, res) => {
  const listing = requireListing(req);
  const listingEvents = eventsRepo.forListing(listing.id);
  const listingShots = shotsRepo.forListing(listing.id);

  const sessions = new Set(listingEvents.map((e) => e.sessionId));
  const opens = listingEvents.filter((e) => e.type === 'tour_open');
  const completions = listingEvents.filter((e) => e.type === 'tour_complete');
  const ctaClicks = listingEvents.filter((e) => e.type === 'cta_click');

  // Attention per stop: how many distinct sessions actually reached each shot,
  // and how many rewatched it. Rewatches are the strongest interest signal a
  // broker gets short of a form fill.
  const perShot = listingShots.map((shot) => {
    const viewEvents = listingEvents.filter((e) => e.type === 'shot_view' && e.shotId === shot.id);
    const bySession = new Map();
    for (const event of viewEvents) {
      bySession.set(event.sessionId, (bySession.get(event.sessionId) || 0) + 1);
    }
    const reached = bySession.size;
    const rewatched = [...bySession.values()].filter((count) => count > 1).length;
    return {
      shotId: shot.id,
      title: shot.title || SPACE_BY_KEY[shot.spaceType]?.label || 'Stop',
      order: shot.order,
      reached,
      rewatched,
      reachRate: sessions.size ? Math.round((reached / sessions.size) * 100) : 0,
    };
  });

  const dropOff = perShot.find((s, i) => {
    const prev = perShot[i - 1];
    return prev && prev.reached > 0 && s.reached / prev.reached < 0.6;
  });

  // Attribution by channel. The sign row is the one that justifies the renewal:
  // it is the only lead source in CRE that is otherwise completely invisible.
  const listingLeads = leadsRepo.forListing(listing.id);
  const sessionSource = new Map();
  for (const event of listingEvents) {
    if (!sessionSource.has(event.sessionId) || event.type === 'tour_open') {
      sessionSource.set(event.sessionId, event.source || 'direct');
    }
  }
  const bySource = {};
  for (const source of sessionSource.values()) {
    bySource[source] = bySource[source] || { source, sessions: 0, leads: 0 };
    bySource[source].sessions += 1;
  }
  for (const lead of listingLeads) {
    const source = lead.source || 'direct';
    bySource[source] = bySource[source] || { source, sessions: 0, leads: 0 };
    bySource[source].leads += 1;
  }
  const sources = Object.values(bySource)
    .map((row) => ({
      ...row,
      conversion: row.sessions ? Math.round((row.leads / row.sessions) * 100) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  res.json({
    sources,
    sessions: sessions.size,
    opens: opens.length,
    completions: completions.length,
    completionRate: sessions.size ? Math.round((completions.length / sessions.size) * 100) : 0,
    ctaClicks: ctaClicks.length,
    leads: leadsRepo.forListing(listing.id).length,
    perShot,
    biggestDropOff: dropOff ? { title: dropOff.title, order: dropOff.order } : null,
  });
}));

// --- error handling ----------------------------------------------------------

api.use((err, _req, res, _next) => {
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  // Expected, actionable conditions (missing keys, unreachable PUBLIC_URL) are
  // user errors, not server faults. Logging full stacks for them buries real
  // failures in noise. One clean line for those; stacks only for genuine 5xx.
  const expected = /credential|not set|unreachable|local-only|PUBLIC_URL|returned 40/i.test(err.message || '');
  if (status >= 500 && !expected) console.error('[api]', err);
  else if (status >= 500) console.warn('[api]', err.message);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});
