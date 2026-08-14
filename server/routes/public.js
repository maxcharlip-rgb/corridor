import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { getDb, save, saveNow, id, now, listings as listingsRepo, shots as shotsRepo, photos as photosRepo } from '../store.js';
import { sendMail, requestNotification, requestConfirmation, notifyAddress, mailConfigured } from '../mailer.js';
import { rateLimit } from '../limits.js';
import { createCheckout, verifyCheckout, PACKAGES, PACKAGE_BY_KEY, paymentsConfigured, paymentStatus } from '../payments.js';
import { SPACE_BY_KEY, MOTION_BY_KEY } from '../motions.js';
import { normaliseSource } from '../signkit.js';
import { DISCLOSURES } from '../facts.js';
import { brandingForListing } from '../branding.js';
import { DEMO_LISTING, DEMO_LISTING_ID, demoPayload, demoShotIds, isDemoSlug } from '../demo-tour.js';

export const publicApi = express.Router();
publicApi.use(express.json({ limit: '64kb' }));

const MAX_EVENTS = 50_000; // keep the JSON store bounded on a long-lived demo
const VALID_EVENTS = new Set(['tour_open', 'shot_view', 'tour_complete', 'cta_click', 'reel_play']);

function findPublished(slug) {
  if (isDemoSlug(slug)) return DEMO_LISTING;
  const listing = listingsRepo.bySlug(slug);
  if (!listing || !listing.published) return null;
  return listing;
}

/** The payload the public viewer renders. Deliberately excludes prompts,
 *  render internals, credit costs and lead data — this is a prospect's view. */

// --- checkout ----------------------------------------------------------------

const checkoutLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, scope: 'checkout' });

/** What is for sale, and whether this install can take money at all. */
publicApi.get('/packages', (_req, res) => {
  res.json({ packages: PACKAGES, payments: paymentStatus() });
});

publicApi.post('/checkout', checkoutLimiter, async (req, res) => {
  const key = String(req.body?.package || '');
  if (!PACKAGE_BY_KEY[key]) return res.status(400).json({ error: 'Pick a package first.' });
  if (!paymentsConfigured()) {
    return res.status(503).json({ error: 'Payments are not switched on yet. Set STRIPE_SECRET_KEY.' });
  }
  try {
    const session = await createCheckout({ packageKey: key, email: String(req.body?.email || '').trim() || null });
    res.json(session);
  } catch (err) {
    console.error('[checkout] could not create session:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * Is this session paid?
 *
 * The form asks before it renders. The answer comes from Stripe, never from the
 * URL the browser was redirected with — an id in a query string proves nothing.
 */
publicApi.get('/checkout/:sessionId', async (req, res) => {
  const result = await verifyCheckout(req.params.sessionId);
  res.json({
    paid: result.paid,
    packageKey: result.packageKey,
    package: result.packageKey ? PACKAGE_BY_KEY[result.packageKey] || null : null,
    amount: result.amount,
    email: result.email,
    reason: result.paid ? null : result.reason,
  });
});

// --- property intake ---------------------------------------------------------

/* Photos arrive from people with no account, so the ceiling is lower than the
   studio's and the filter is the same one the rest of the app uses. */
const ALLOWED_IMAGE = /^image\/(jpeg|png|webp)$/i;

const intakeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      cb(null, `${id('img')}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE.test(file.mimetype)) return cb(null, true);
    req.rejectedFiles = req.rejectedFiles || [];
    req.rejectedFiles.push({
      name: file.originalname,
      reason: /heic|heif/i.test(file.mimetype)
        ? 'HEIC is not supported. On iPhone: Settings → Camera → Formats → "Most Compatible".'
        : 'Only JPEG, PNG and WebP images are supported.',
    });
    cb(null, false);
  },
});

const intakeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, scope: 'intake' });

const WANTS = ['video tour', 'brochure'];
const DEALS = ['for lease', 'for sale', 'both'];
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);

/**
 * A brokerage submits a property; we produce the marketing and email it back.
 *
 * The submission is saved BEFORE any mail is attempted and the response does not
 * depend on mail succeeding. A provider outage must never present as "your
 * request failed" to someone who has just uploaded forty photos — they would
 * not send them twice, and we would never know they tried.
 */
publicApi.post('/requests', intakeLimiter, intakeUpload.array('photos', 40), async (req, res) => {
  const body = req.body || {};

  // Bots fill in every field they find. A human never sees this one.
  if (clean(body.website)) return res.status(201).json({ ok: true });

  const email = clean(body.email, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required — it is where the video goes.' });
  }
  const address = clean(body.address);
  if (!address) return res.status(400).json({ error: 'The property address is required.' });

  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({
      error: 'Add at least one photo of the property.',
      rejected: req.rejectedFiles || [],
    });
  }

  /* Payment, confirmed with Stripe rather than believed from the browser.
   *
   * The redirect hands the page a session id, which proves nothing on its own —
   * anyone can put an id in a query string. So the id is exchanged for the real
   * payment_status here, at the point the work is actually committed to.
   *
   * COMP_CODE exists because the first listings are deliberately free. A pilot
   * that cannot be run through the real flow gets run some other way, and then
   * the real flow is the one thing never tested. */
  let payment = { paid: false, comped: false, amount: null, packageKey: null, sessionId: null };
  const comp = clean(body.comp, 80);
  const compCode = process.env.COMP_CODE || '';

  if (compCode && comp && comp === compCode) {
    payment = { paid: true, comped: true, amount: 0, packageKey: clean(body.package, 40) || null, sessionId: null };
  } else if (paymentsConfigured()) {
    const check = await verifyCheckout(clean(body.session, 200));
    if (!check.paid) {
      return res.status(402).json({
        error: 'We could not confirm payment for this request. If you were charged, reply to your receipt and we will sort it out.',
        reason: check.reason,
      });
    }
    payment = {
      paid: true, comped: false,
      amount: check.amount, packageKey: check.packageKey, sessionId: check.sessionId,
    };
  }
  // With payments unconfigured the form still works — that is the state this
  // install ships in until STRIPE_SECRET_KEY is set, and a broker mid-pilot
  // should not hit a wall because billing is not switched on yet.

  const wants = String(body.wants || 'video tour')
    .split(',').map((w) => w.trim().toLowerCase()).filter((w) => WANTS.includes(w));

  const request = {
    id: id('req'),
    firm: clean(body.firm),
    name: clean(body.name),
    email,
    phone: clean(body.phone, 60),
    address,
    propertyType: clean(body.propertyType, 60),
    deal: DEALS.includes(clean(body.deal, 40).toLowerCase()) ? clean(body.deal, 40).toLowerCase() : '',
    size: clean(body.size, 80),
    price: clean(body.price, 120),
    notes: clean(body.notes, 4000),
    wants: wants.length ? wants : ['video tour'],
    photos: files.map((f, i) => ({ file: f.filename, originalName: f.originalname, order: i })),
    rejected: req.rejectedFiles || [],
    status: 'new',
    payment,
    createdAt: now(),
    source: clean(body.source, 80) || 'web',
  };

  const db = getDb();
  db.requests = db.requests || [];
  db.requests.push(request);
  // Durable immediately: this is somebody's job, not a cache entry.
  saveNow();

  res.status(201).json({
    ok: true,
    id: request.id,
    photos: files.length,
    paid: payment.paid,
    rejected: request.rejected,
    // Tell the truth about delivery rather than implying an email is on its way.
    emailConfigured: mailConfigured(),
  });

  // Notifications happen after the response; the record is already safe.
  (async () => {
    const note = requestNotification(request, request.photos);
    const toOperator = await sendMail({ to: notifyAddress(), subject: note.subject, html: note.html, replyTo: email });

    const confirm = requestConfirmation(request);
    const toBroker = await sendMail({ to: email, subject: confirm.subject, html: confirm.html });

    const stored = (getDb().requests || []).find((r) => r.id === request.id);
    if (stored) {
      stored.notified = { operator: toOperator, broker: toBroker, at: now() };
      save();
    }
    if (!toOperator.ok) {
      console.error(`[intake] request ${request.id} saved but the operator was NOT emailed: ${toOperator.error}`);
    }
  })();
});

publicApi.get('/tours/:slug', (req, res) => {
  const listing = findPublished(req.params.slug);
  if (!listing) return res.status(404).json({ error: 'Tour not found.' });
  if (listing.id === DEMO_LISTING_ID) return res.json(demoPayload());

  const db = getDb();
  const stops = shotsRepo
    .forListing(listing.id)
    .filter((shot) => shot.cinematic?.file || shot.preview?.file)
    .map((shot) => {
      const usesStagedPhoto = (shot.photoIds || [])
        .map((pid) => photosRepo.byId(pid))
        .some((photo) => photo?.staged);

      const cinematic = Boolean(shot.cinematic?.file);
      return {
        id: shot.id,
        title: shot.title || SPACE_BY_KEY[shot.spaceType]?.label || 'Stop',
        caption: shot.caption || '',
        spaceType: shot.spaceType,
        motionLabel: MOTION_BY_KEY[shot.motionKey]?.label || '',
        isTransition: shot.motionKey === 'blend_transition',
        videoUrl: cinematic ? `/renders/${shot.cinematic.file}` : `/renders/${shot.preview.file}`,
        posterUrl: cinematic
          ? shot.cinematic.poster && `/renders/${shot.cinematic.poster}`
          : shot.preview.poster && `/renders/${shot.preview.poster}`,
        durationSec: shot.durationSec || 5,
        // Disclosure travels with the shot and is rendered unconditionally.
        virtuallyStaged: usesStagedPhoto,
      };
    });

  // Disclosures ship with the payload rather than being hard-coded in the
  // viewer, so they cannot drift from the server's own compliance text and
  // cannot be edited away in the frontend.
  const disclosures = [DISCLOSURES.accuracy, DISCLOSURES.motion];
  if (stops.some((s) => s.virtuallyStaged)) disclosures.push(DISCLOSURES.staging);

  res.json({
    disclosures,
    listing: {
      name: listing.name,
      address: listing.address,
      headline: listing.headline,
      propertyType: listing.propertyType,
      specs: listing.specs || [],
      cta: listing.cta || { label: 'Request a showing', enabled: true },
      reelUrl: listing.reelFile ? `/renders/${listing.reelFile}` : null,
    },
    broker: brandingForListing(listing),
    stops,
  });
});

publicApi.post('/tours/:slug/events', (req, res) => {
  const listing = findPublished(req.params.slug);
  if (!listing) return res.status(404).json({ error: 'Tour not found.' });

  const { type, shotId, sessionId, source } = req.body || {};
  if (!VALID_EVENTS.has(type)) return res.status(400).json({ error: 'Unknown event type.' });
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
    return res.status(400).json({ error: 'A sessionId is required.' });
  }

  // A shotId that isn't part of this listing would silently corrupt per-stop
  // attention numbers, so reject it rather than storing it.
  const knownShots = listing.id === DEMO_LISTING_ID
    ? demoShotIds()
    : new Set(shotsRepo.forListing(listing.id).map((s) => s.id));
  if (shotId && !knownShots.has(shotId)) {
    return res.status(400).json({ error: 'Unknown shotId for this tour.' });
  }

  const db = getDb();
  if (db.events.length >= MAX_EVENTS) db.events.splice(0, Math.floor(MAX_EVENTS * 0.2));

  db.events.push({
    id: id('evt'),
    listingId: listing.id,
    type,
    shotId: shotId || null,
    sessionId: String(sessionId).slice(0, 64),
    source: normaliseSource(source),
    createdAt: now(),
  });
  save();
  res.status(202).json({ ok: true });
});

publicApi.post('/tours/:slug/leads', (req, res) => {
  const listing = findPublished(req.params.slug);
  if (!listing) return res.status(404).json({ error: 'Tour not found.' });

  const { name, email, company, phone, message, sessionId, source } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const clip = (value, max) => String(value || '').trim().slice(0, max);

  const lead = {
    id: id('led'),
    listingId: listing.id,
    name: clip(name, 120),
    email: clip(email, 200),
    company: clip(company, 160),
    phone: clip(phone, 40),
    message: clip(message, 2000),
    sessionId: clip(sessionId, 64),
    source: normaliseSource(source),
    createdAt: now(),
  };

  // Attach the engagement story so the broker sees how warm this lead is at a
  // glance rather than having to cross-reference analytics.
  const sessionEvents = getDb().events.filter(
    (e) => e.sessionId === lead.sessionId && e.listingId === listing.id
  );
  lead.stopsViewed = new Set(sessionEvents.filter((e) => e.type === 'shot_view').map((e) => e.shotId)).size;
  lead.completedTour = sessionEvents.some((e) => e.type === 'tour_complete');

  getDb().leads.push(lead);
  // Durable: a lead lost to a crash is lost revenue and cannot be recovered.
  saveNow();
  res.status(201).json({ ok: true });
});

publicApi.use((err, _req, res, _next) => {
  console.error('[public]', err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

export function tourUrlFor(listing) {
  return `${config.publicUrl}/t/${listing.slug}`;
}
