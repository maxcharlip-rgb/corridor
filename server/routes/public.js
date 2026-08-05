import express from 'express';
import { config } from '../config.js';
import { getDb, save, id, now, listings as listingsRepo, shots as shotsRepo, photos as photosRepo } from '../store.js';
import { SPACE_BY_KEY, MOTION_BY_KEY } from '../motions.js';
import { normaliseSource } from '../signkit.js';
import { DISCLOSURES } from '../facts.js';

export const publicApi = express.Router();
publicApi.use(express.json({ limit: '64kb' }));

const MAX_EVENTS = 50_000; // keep the JSON store bounded on a long-lived demo
const VALID_EVENTS = new Set(['tour_open', 'shot_view', 'tour_complete', 'cta_click', 'reel_play']);

function findPublished(slug) {
  const listing = listingsRepo.bySlug(slug);
  if (!listing || !listing.published) return null;
  return listing;
}

/** The payload the public viewer renders. Deliberately excludes prompts,
 *  render internals, credit costs and lead data — this is a prospect's view. */
publicApi.get('/tours/:slug', (req, res) => {
  const listing = findPublished(req.params.slug);
  if (!listing) return res.status(404).json({ error: 'Tour not found.' });

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
    broker: db.broker,
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
  if (shotId && !shotsRepo.forListing(listing.id).some((s) => s.id === shotId)) {
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
  save();
  res.status(201).json({ ok: true });
});

publicApi.use((err, _req, res, _next) => {
  console.error('[public]', err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

export function tourUrlFor(listing) {
  return `${config.publicUrl}/t/${listing.slug}`;
}
