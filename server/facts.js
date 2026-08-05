import { getDb, save, id, now } from './store.js';

/**
 * Fact verification.
 *
 * A caption on a property video is a representation. "24,000 SF · open floor
 * plate" is a statement a prospect may rely on, and if the broker never typed
 * 24,000 then the software invented a material fact about someone else's asset.
 *
 * The rule enforced here: **every number that reaches a viewer must already
 * appear in broker-entered listing data.** Not "should" — the check runs before
 * any caption is burned in and before any prompt is submitted, and unverifiable
 * numbers are stripped or the operation is rejected.
 *
 * Words are not policed. A model writing "Reception and arrival" is describing
 * a room; a model writing "24,000 SF" is making a claim. Numbers are where the
 * liability lives.
 */

/** Numeric tokens: 24,000 · 18.50 · $18.50 · 3 · 4.2 */
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?/g;

/** "24,000" → "24000", "$18.50" → "18.50". Comparison is on the bare value. */
function normalise(token) {
  return String(token).replace(/[$,]/g, '').replace(/\.0+$/, '');
}

/**
 * Every number the broker actually entered for this listing, from every field
 * a viewer could be shown.
 */
export function collectFacts(listing, spec = null) {
  const sources = [
    listing?.address,
    listing?.headline,
    listing?.name,
    listing?.cta?.label,
    ...(listing?.specs || []).flatMap((s) => [s.label, s.value]),
    spec?.totalSf != null ? String(spec.totalSf) : null,
    spec?.floors != null ? String(spec.floors) : null,
    listing?.spec?.totalSf != null ? String(listing.spec.totalSf) : null,
    listing?.spec?.floors != null ? String(listing.spec.floors) : null,
  ].filter(Boolean);

  const numbers = new Set();
  for (const source of sources) {
    for (const token of String(source).match(NUMBER_RE) || []) {
      numbers.add(normalise(token));
    }
  }

  return { numbers, sources };
}

/**
 * Check a viewer-facing string against the fact set.
 * @returns {{ok: boolean, offending: string[]}}
 */
export function verifyText(text, facts) {
  if (!text) return { ok: true, offending: [] };
  const offending = [];

  for (const token of String(text).match(NUMBER_RE) || []) {
    const value = normalise(token);

    // Small bare integers (1-12) are almost always ordinals or counts in a room
    // name — "Suite 3", "Floor 2" — not claims about size or price. Requiring
    // them to be pre-declared produces noise without protecting anyone.
    if (/^\d{1,2}$/.test(value) && Number(value) <= 12 && facts.numbers.has(value) === false) {
      // Still rejected if it is attached to a unit that makes it a claim.
      const claimContext = new RegExp(`${token}\\s*(sf|sq|square|%|psf|/sf|floors?|stor)`, 'i');
      if (!claimContext.test(text)) continue;
    }

    if (!facts.numbers.has(value)) offending.push(token);
  }

  return { ok: offending.length === 0, offending };
}

/**
 * Remove unverifiable numbers rather than failing outright, so a caption
 * degrades to the generic form the compliance rule asks for:
 *   "24,000 SF · open floor plate"  →  "open floor plate"
 */
/** Escape a literal for use inside a RegExp. Kept out of any template literal —
 *  `${` inside one is interpolation, which silently mangles the pattern. */
const escapeRe = (literal) => String(literal).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

const UNIT_TAIL = '(?:\\s*(?:sf|sq\\.?\\s*ft|square\\s*feet|psf|/\\s*sf|nnn|floors?|stories|storeys))?';

export function stripUnverified(text, facts) {
  const { ok, offending } = verifyText(text, facts);
  if (ok) return { text, stripped: [] };

  let out = String(text);
  for (const token of offending) {
    // Drop the number, any unit that follows it, and one trailing separator.
    out = out.replace(
      new RegExp(`${escapeRe(token)}${UNIT_TAIL}\\s*(?:·|\\||—|-|,)?\\s*`, 'gi'),
      ''
    );
  }

  out = out
    .replace(/^\s*(?:·|\||—|-|,)\s*/, '')
    .replace(/\s*(?:·|\||—|-|,)\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // A stripped leading number often leaves a dangling preposition ("of open
  // plate"). Drop it rather than capitalising nonsense.
  out = out.replace(/^(?:of|in|at|with|for)\s+/i, '');
  if (out) out = out[0].toUpperCase() + out.slice(1);

  return { text: out, stripped: offending };
}

/**
 * Provenance log. If a representation is ever questioned, this shows the
 * broker's own input alongside proof the system did not alter it.
 */
export function logFactUse({ listingId, accountId, context, facts, text, stripped = [] }) {
  const db = getDb();
  db.factLog = db.factLog || [];
  db.factLog.push({
    id: id('fct'),
    listingId,
    accountId: accountId || null,
    context,
    text: String(text || '').slice(0, 300),
    numbersUsed: [...String(text || '').matchAll(NUMBER_RE)].map((m) => m[0]).slice(0, 12),
    strippedNumbers: stripped.slice(0, 12),
    sourceFields: (facts?.sources || []).slice(0, 12).map((s) => String(s).slice(0, 120)),
    createdAt: now(),
  });
  if (db.factLog.length > 20_000) db.factLog.splice(0, 4000);
  save();
}

/** Standing disclosures. Rendered on every public tour; not dismissible. */
export const DISCLOSURES = {
  accuracy:
    'All property details shown in this tour — address, size, rate and features — are provided by ' +
    'the listing broker or owner. Corridor does not verify or guarantee their accuracy. Confirm all ' +
    'information directly with the broker before relying on it.',
  motion:
    'Motion in this tour is generated from still photography of the property. It is intended to convey ' +
    'layout and scale, not to represent exact dimensions.',
  staging:
    'Envisioned and virtually staged images are conceptual and may not reflect the current condition of ' +
    'the space. Layout and structure are preserved; finishes and furniture are illustrative only.',
};
