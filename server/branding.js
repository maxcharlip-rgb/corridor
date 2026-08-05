import { getDb, save } from './store.js';
import { accountById } from './auth.js';

/**
 * Per-account broker branding.
 *
 * Branding used to live in a single global `db.broker`, which was fine while
 * one person operated the install. It is not fine the moment a second brokerage
 * signs up: firm A's name, logo and phone number would appear on firm B's tour,
 * end card and sign. That is a trust failure and, on a printed sign carrying
 * the wrong contact, arguably a misrepresentation.
 *
 * The rule: **anything a viewer can see resolves branding from the listing
 * owner's account, never from install state.** Global `db.broker` survives only
 * as a migration source and as the pre-auth single-operator fallback.
 */

export const BRAND_FIELDS = ['name', 'company', 'phone', 'email', 'website', 'logoUrl', 'accent'];

const EMPTY_BRAND = {
  name: '',
  company: '',
  phone: '',
  email: '',
  website: '',
  logoUrl: '',
  accent: '#c8622a',
};

/** Normalise whatever is stored into a complete brand object. */
function shape(source = {}) {
  const brand = { ...EMPTY_BRAND };
  for (const field of BRAND_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) brand[field] = source[field];
  }
  if (!brand.accent) brand.accent = EMPTY_BRAND.accent;
  return brand;
}

/**
 * One-time, self-cleaning migration.
 *
 * Folds any legacy global broker into the first account, then **deletes the
 * field**. Once it has run, `db.broker` does not exist — so the code path by
 * which one firm's identity could reach another firm's tour is physically gone
 * rather than merely unused.
 *
 * Runs on every boot and is a no-op after the first. Reading `db.broker`
 * defensively (rather than assuming it exists) is what lets an install created
 * before per-account branding upgrade without losing its details.
 */
export function migrateGlobalBranding() {
  const db = getDb();
  const accounts = db.accounts || [];
  const legacy = db.broker && Object.values(db.broker).some((v) => v && v !== '#c8622a') ? db.broker : null;

  // No accounts yet: keep the legacy blob untouched so a pre-auth install
  // doesn't silently lose branding it may still be relying on.
  if (!accounts.length) return { migrated: 0, cleared: false };

  let migrated = 0;
  for (const account of accounts) {
    if (account.brand) continue;
    // Only the first account inherits legacy install branding; any account
    // created later starts blank rather than borrowing someone else's identity.
    const isFirst = accounts[0].id === account.id;
    account.brand = shape(
      isFirst && legacy
        ? { ...legacy, name: legacy.name || account.name, company: legacy.company || account.company }
        : { name: account.name, company: account.company, email: account.email }
    );
    migrated += 1;
  }

  // Now that at least one account owns branding, the global field has no
  // remaining reader. Remove it so it cannot be reintroduced by accident.
  const cleared = Object.prototype.hasOwnProperty.call(db, 'broker');
  if (cleared) delete db.broker;

  if (migrated || cleared) {
    save();
    if (migrated) console.log(`[branding] migrated legacy broker into ${migrated} account(s)`);
    if (cleared) console.log('[branding] removed global db.broker — branding is per-account only');
  }
  return { migrated, cleared };
}

/** Branding for an account id. */
export function brandingForAccount(accountId) {
  const account = accountId ? accountById(accountId) : null;
  if (account) return shape(account.brand || { name: account.name, company: account.company, email: account.email });

  // Pre-auth single-operator mode only: no accounts exist at all, so there is
  // no owner to resolve and any install-level branding is unambiguous. This is
  // the sole remaining reader of the legacy field, and it becomes unreachable
  // the moment the first account is created.
  const db = getDb();
  if (!(db.accounts || []).length) return shape(db.broker || {});

  // Accounts exist but this listing has no owner — do NOT fall back to global
  // state, or an orphaned listing would wear the first account's identity.
  return shape({});
}

/**
 * Branding for anything a viewer sees. Always resolved from the listing's
 * owner. This is the only function viewer-facing code should call.
 */
export function brandingForListing(listing) {
  return brandingForAccount(listing?.ownerId || null);
}

/** Update the signed-in account's brand. */
export function updateBranding(accountId, patch = {}) {
  const account = accountById(accountId);
  if (!account) {
    const err = new Error('Account not found.');
    err.status = 404;
    throw err;
  }
  const next = shape(account.brand);
  for (const field of BRAND_FIELDS) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  account.brand = next;
  save();
  return next;
}
