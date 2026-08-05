import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const EMPTY = {
  version: 1,
  // NOTE: no global `broker` field. Branding is per-account (see branding.js);
  // a shared one leaked firm A onto firm B's tour, sign and end card.
  accounts: [],
  listings: [],
  photos: [],
  shots: [],
  leads: [],
  events: [],
};

let db = null;
let writeTimer = null;

function read() {
  if (!fs.existsSync(config.dbFile)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed };
  } catch (err) {
    // Never silently start from a blank slate over a parse error — that would
    // look like data loss. Move the bad file aside so it can be recovered.
    const backup = `${config.dbFile}.corrupt-${Date.now()}`;
    fs.renameSync(config.dbFile, backup);
    console.error(`[store] db.json was unreadable (${err.message}); moved to ${backup}`);
    return structuredClone(EMPTY);
  }
}

function writeNow() {
  const tmp = `${config.dbFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.dbFile); // atomic within the same filesystem
}

/** Debounced persist. Call after any mutation. */
export function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      writeNow();
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  }, 40);
}

export function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    writeNow();
  } catch (err) {
    console.error('[store] flush failed:', err.message);
  }
}

export function getDb() {
  if (!db) db = read();
  return db;
}

export const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const now = () => new Date().toISOString();

/** URL-safe, human-typable public slug for shareable tour links. */
export function slugify(text, fallback = 'tour') {
  const base =
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || fallback;
  const existing = new Set(getDb().listings.map((l) => l.slug));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// --- typed accessors --------------------------------------------------------

export const listings = {
  all: () => getDb().listings,
  byId: (listingId) => getDb().listings.find((l) => l.id === listingId) || null,
  bySlug: (slug) => getDb().listings.find((l) => l.slug === slug) || null,
};

export const photos = {
  forListing: (listingId) =>
    getDb()
      .photos.filter((p) => p.listingId === listingId)
      .sort((a, b) => a.order - b.order),
  byId: (photoId) => getDb().photos.find((p) => p.id === photoId) || null,
};

export const shots = {
  forListing: (listingId) =>
    getDb()
      .shots.filter((s) => s.listingId === listingId)
      .sort((a, b) => a.order - b.order),
  byId: (shotId) => getDb().shots.find((s) => s.id === shotId) || null,
};

export const leads = {
  forListing: (listingId) =>
    getDb()
      .leads.filter((l) => l.listingId === listingId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
};

export const events = {
  forListing: (listingId) => getDb().events.filter((e) => e.listingId === listingId),
};
