import { SPACE_BY_KEY } from '../motions.js';
import { config } from '../config.js';

/**
 * Envision agent — plans "what could this space be" images.
 *
 * Returns a PLAN ONLY. It does not call Higgsfield.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ENABLING ENVISION IN A CUSTOMER-FACING BUILD
 *
 * Envision Space is virtual staging. Re-rendering a real, leasable suite as
 * furnished and restyled produces an image of a space that does not exist. That
 * is a representation about a property a prospect may sign a lease over.
 *
 * Two hard rules, enforced structurally rather than by good intentions:
 *
 *   1. Every planned image carries `requiresDisclosure: true` and a
 *      `disclosureLabel`. Corridor's tour player already burns a permanent
 *      "Virtually staged" badge on any shot built from a staged photo, and that
 *      badge is not removable from the UI.
 *   2. Prompts instruct the model to preserve architecture — walls, windows,
 *      columns, ceiling height, floor plate — and change only furniture, finish
 *      and lighting. An envision image that moves a wall is not a marketing
 *      asset, it is a misrepresentation.
 *
 * Envision images must never be mixed into the tour montage as if they were
 * photographs of the space. Keep them in a labelled before/after set.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const ENVISION_STYLES = {
  modern: {
    label: 'Modern office',
    decor: 'open bench desking, glass-fronted private offices, warm wood accents, potted plants, soft neutral palette',
  },
  industrial: {
    label: 'Industrial / creative',
    decor: 'exposed ceiling, black steel and reclaimed wood, pendant lighting, open collaborative seating',
  },
  medical: {
    label: 'Medical office',
    decor: 'clean clinical finishes, reception casework, seating bays, soft even lighting, muted calming palette',
  },
  flex: {
    label: 'Flex / hybrid',
    decor: 'movable furniture, huddle pods, writable surfaces, mixed soft and task seating',
  },
  professional: {
    label: 'Professional services',
    decor: 'private offices, conference table, tailored millwork, conservative palette, layered lighting',
  },
};

// Cap per project. Envision images are cheap individually and easy to run away
// with; a bounded set also keeps the before/after story legible to a prospect.
export const MAX_ENVISION_IMAGES = 12;

// Estimated credits per image edit. Verify with a get_cost preflight before
// relying on this for budgeting — it is not measured the way video is.
export const CREDITS_PER_IMAGE = 3;

function promptFor({ space, style, furnished, notes }) {
  const spaceLabel = space?.label?.toLowerCase() || 'commercial space';
  const decor = ENVISION_STYLES[style]?.decor || ENVISION_STYLES.modern.decor;

  return [
    `Re-render this photograph of a ${spaceLabel} as a ${ENVISION_STYLES[style]?.label || 'modern office'}.`,
    furnished ? `Furnish it with ${decor}.` : 'Show it clean, bright and vacant, ready for fit-out.',
    notes?.length ? `Additional direction: ${notes.join('; ')}.` : '',
    'CRITICAL: preserve the real architecture exactly — wall positions, window openings and mullions,',
    'structural columns, ceiling height and grid, door locations, and the shape of the floor plate.',
    'Change only furniture, finishes, decor and lighting. Do not move, add or remove any wall, window or column.',
    'Photorealistic architectural interior photography, natural light, true-to-life proportions.',
    'No people, no text, no signage, no logos, no watermarks.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * @param {object} input
 * @param {object} input.spec     output of specAgent (uses spec.envision)
 * @param {object[]} input.photos store photo records
 * @param {number} [input.perSpace] variants per selected space
 * @returns {{calls: object[], estimate: object, warnings: string[]}}
 */
export function envisionAgent({ spec, photos = [], perSpace = 2 }) {
  const warnings = [];
  const envision = spec?.envision;

  if (!envision) {
    return { calls: [], estimate: { images: 0, totalCredits: 0 }, warnings: ['No envision settings supplied.'] };
  }

  const style = ENVISION_STYLES[envision.style] ? envision.style : 'modern';
  if (envision.style && !ENVISION_STYLES[envision.style]) {
    warnings.push(`Unknown style "${envision.style}" — defaulting to modern office.`);
  }

  // Envision only the spaces a tenant actually evaluates. Corridors and
  // exteriors gain nothing from being restyled.
  const worthEnvisioning = new Set(['floor', 'workspace', 'conference', 'lobby', 'amenity', 'breakroom']);
  const targets = photos.filter((p) => worthEnvisioning.has(p.spaceType));

  if (!targets.length) warnings.push('No photos of spaces worth envisioning (floor plate, offices, lobby, amenities).');

  const calls = [];
  for (const photo of targets) {
    for (let variant = 0; variant < perSpace; variant += 1) {
      if (calls.length >= MAX_ENVISION_IMAGES) break;
      const space = SPACE_BY_KEY[photo.spaceType];
      calls.push({
        kind: 'image',
        photoId: photo.id,
        spaceType: photo.spaceType,
        title: `${space?.label || 'Space'} — ${ENVISION_STYLES[style].label}${perSpace > 1 ? ` (v${variant + 1})` : ''}`,
        variant,
        request: {
          // Image-edit endpoint differs by account/model; confirm with
          // models_explore before wiring execution. Plan only for now.
          endpoint: '/v1/image2image',
          imageUrl: `${config.publicUrl}/uploads/${photo.file}`,
          prompt: promptFor({
            space,
            style,
            furnished: envision.furnished !== false,
            notes: envision.notes,
          }),
        },
        estimatedCredits: CREDITS_PER_IMAGE,
        // Not optional, not removable. See the header.
        requiresDisclosure: true,
        disclosureLabel: 'Virtually staged',
      });
    }
  }

  if (calls.length >= MAX_ENVISION_IMAGES) {
    warnings.push(`Capped at ${MAX_ENVISION_IMAGES} images per project.`);
  }

  return {
    calls,
    estimate: {
      images: calls.length,
      totalCredits: calls.length * CREDITS_PER_IMAGE,
      approxUsd: Number((calls.length * CREDITS_PER_IMAGE * 0.033).toFixed(2)),
      note: 'Image credit cost is estimated, not measured. Preflight with get_cost before relying on it.',
    },
    warnings,
  };
}
