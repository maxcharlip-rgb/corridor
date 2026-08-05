import { SPACE_BY_KEY } from '../motions.js';
import { config } from '../config.js';

/**
 * Visualisation agent — plans "what could this be" images.
 *
 * Returns a PLAN ONLY. It does not call Higgsfield.
 *
 * This is the *second* workflow in Corridor. Video tours are the product; this
 * exists so a broker can answer the question a prospect actually asks in the
 * room — "could this work for us?" — with a picture instead of a description.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DISCLOSURE IS STRUCTURAL, NOT OPTIONAL
 *
 * Every mode here produces an image of a space that does not currently exist.
 * That is a representation about a property someone may sign a lease over, so:
 *
 *   1. Every planned image carries `requiresDisclosure: true` and a mode-specific
 *      `disclosureLabel`, burned into the studio and the tour, not removable.
 *   2. Prompts preserve real architecture — walls, windows, columns, ceiling
 *      height, floor plate — in every mode except `concept`, where by definition
 *      no building exists yet and the image is labelled a concept.
 *   3. Concept images must never be presented as photographs of the property.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Model costs, preflighted with get_cost (2026-08-05):
 *   nano_banana   1 credit   realistic, image-to-image, budget
 *   gpt_image_2   7 credits  2k / high quality, stronger edit fidelity
 *
 * Default to the cheap one: at 1 credit you can show a broker six options for
 * the price of a single video take, and volume beats polish when the point is
 * to explore possibilities.
 */
export const IMAGE_MODELS = {
  standard: { id: 'nano_banana', credits: 1, label: 'Standard — 1 credit' },
  high: { id: 'gpt_image_2', credits: 7, label: 'High fidelity — 7 credits' },
};

/** The four things a broker actually needs to show. */
export const VISUALIZE_MODES = {
  concept: {
    key: 'concept',
    label: 'Generate concept image',
    blurb: 'A building that does not exist yet, shown as a plausible new-construction concept.',
    needsPhoto: false,
    disclosureLabel: 'Concept image — building not built',
    preserveArchitecture: false,
  },
  renovation: {
    key: 'renovation',
    label: 'Visualise renovation',
    blurb: 'The existing building reimagined — repositioned, refreshed, or re-clad.',
    needsPhoto: true,
    disclosureLabel: 'Renovation concept — not current condition',
    preserveArchitecture: true,
  },
  fitout: {
    key: 'fitout',
    label: 'Show tenant fit-out',
    blurb: 'The space occupied — furnished, branded, and working for a specific tenant type.',
    needsPhoto: true,
    disclosureLabel: 'Illustrative fit-out — furniture not included',
    preserveArchitecture: true,
  },
  layout: {
    key: 'layout',
    label: 'Preview new layout',
    blurb: 'An alternate use or room configuration for the same floor plate.',
    needsPhoto: true,
    disclosureLabel: 'Proposed layout — not as-built',
    preserveArchitecture: true,
  },
};

/** Fit-out and repositioning styles a CRE audience recognises. */
export const VISUAL_STYLES = {
  modern: { label: 'Modern office', decor: 'open bench desking, glass-fronted offices, warm wood accents, planting, soft neutral palette' },
  professional: { label: 'Professional services', decor: 'private offices, boardroom, tailored millwork, conservative palette, layered lighting' },
  medical: { label: 'Medical office', decor: 'reception casework, seating bays, clean clinical finishes, soft even lighting' },
  industrial: { label: 'Industrial / creative', decor: 'exposed structure, black steel and reclaimed timber, pendant lighting, open collaboration' },
  retail: { label: 'Retail / showroom', decor: 'display fixtures, feature lighting, clear sightlines from the storefront' },
  flex: { label: 'Flex / hybrid', decor: 'movable furniture, huddle rooms, writable surfaces, mixed soft and task seating' },
  shell: { label: 'Vacant shell', decor: 'clean, bright and empty, ready for fit-out, no furniture' },
};

// Bounded per listing: cheap images are easy to run away with, and a legible
// before/after story beats forty near-identical options.
export const MAX_IMAGES_PER_LISTING = 24;

function promptFor({ mode, space, style, notes, propertyType, address }) {
  const styleSpec = VISUAL_STYLES[style] || VISUAL_STYLES.modern;
  const spaceLabel = space?.label?.toLowerCase() || 'commercial space';
  const type = propertyType || 'commercial';

  const preserve =
    'CRITICAL: preserve the real architecture exactly — wall positions, window openings and mullions, ' +
    'structural columns, ceiling height and grid, door locations, and the shape of the floor plate. ' +
    'Change only furniture, finishes, decor and lighting. Do not move, add or remove any wall, window or column.';

  const realism =
    'Photorealistic architectural interior photography, natural light, true-to-life proportions and materials. ' +
    'No people, no text, no signage, no logos, no watermarks, no floor-plan overlays.';

  switch (mode) {
    case 'concept':
      return [
        `Photorealistic architectural rendering of a proposed new ${type} building${address ? ` on a site at ${address}` : ''}.`,
        styleSpec.label ? `Design language: ${styleSpec.label.toLowerCase()}.` : '',
        notes?.length ? `Brief: ${notes.join('; ')}.` : '',
        'Exterior three-quarter view at eye level, overcast daylight, contextual landscaping and parking,',
        'plausible massing and realistic materials for a suburban commercial site.',
        'Architectural visualisation quality — it must read as a rendering of a proposal, not a photograph.',
        'No people, no text, no signage, no logos, no watermarks.',
      ].filter(Boolean).join(' ');

    case 'renovation':
      return [
        `Re-render this photograph of a ${type} property as a completed renovation and repositioning.`,
        `Target character: ${styleSpec.label.toLowerCase()} — ${styleSpec.decor}.`,
        notes?.length ? `Scope: ${notes.join('; ')}.` : '',
        'Update finishes, glazing treatment, lighting and landscaping only.',
        preserve,
        realism,
      ].filter(Boolean).join(' ');

    case 'fitout':
      return [
        `Re-render this photograph of a ${spaceLabel} as a completed tenant fit-out.`,
        `Fit it out as a ${styleSpec.label.toLowerCase()}: ${styleSpec.decor}.`,
        notes?.length ? `Tenant requirements: ${notes.join('; ')}.` : '',
        preserve,
        realism,
      ].filter(Boolean).join(' ');

    case 'layout':
      return [
        `Re-render this photograph of a ${spaceLabel} reconfigured for a different use.`,
        `Show it arranged as a ${styleSpec.label.toLowerCase()}: ${styleSpec.decor}.`,
        notes?.length ? `Configuration: ${notes.join('; ')}.` : '',
        'Demountable partitions and furniture may be rearranged to suit the new layout.',
        preserve,
        realism,
      ].filter(Boolean).join(' ');

    default:
      return '';
  }
}

/**
 * @param {object} input
 * @param {object} input.listing
 * @param {object[]} input.photos      store photo records
 * @param {string} input.mode          concept | renovation | fitout | layout
 * @param {string} [input.style]
 * @param {string[]} [input.notes]
 * @param {string[]} [input.photoIds]  which photos to work from (omit = auto)
 * @param {number} [input.variants]    images per photo
 * @param {string} [input.quality]     standard | high
 * @returns {{calls, estimate, warnings}}
 */
export function envisionAgent({
  listing,
  photos = [],
  mode = 'fitout',
  style = 'modern',
  notes = [],
  photoIds = null,
  variants = 2,
  quality = 'standard',
}) {
  const warnings = [];
  const spec = VISUALIZE_MODES[mode];
  if (!spec) {
    return { calls: [], estimate: { images: 0, totalCredits: 0 }, warnings: [`Unknown mode "${mode}".`] };
  }

  const model = IMAGE_MODELS[quality] || IMAGE_MODELS.standard;
  if (!VISUAL_STYLES[style]) {
    warnings.push(`Unknown style "${style}" — using modern office.`);
    style = 'modern';
  }

  const calls = [];

  // Concept needs no photo: there is no building to photograph yet.
  if (!spec.needsPhoto) {
    for (let i = 0; i < Math.max(1, variants); i += 1) {
      calls.push({
        kind: 'image',
        mode,
        photoId: null,
        title: `${spec.label}${variants > 1 ? ` (v${i + 1})` : ''}`,
        variant: i,
        request: {
          endpoint: '/v1/text2image',
          model: model.id,
          aspectRatio: '16:9',
          prompt: promptFor({ mode, style, notes, propertyType: listing?.propertyType, address: listing?.address }),
        },
        estimatedCredits: model.credits,
        requiresDisclosure: true,
        disclosureLabel: spec.disclosureLabel,
      });
    }
  } else {
    // Only spaces a tenant actually evaluates. Corridors gain nothing here.
    const worth = new Set(['floor', 'workspace', 'conference', 'lobby', 'amenity', 'breakroom', 'exterior', 'retail']);
    let targets = photoIds?.length
      ? photos.filter((p) => photoIds.includes(p.id))
      : photos.filter((p) => (mode === 'renovation' ? p.spaceType === 'exterior' : worth.has(p.spaceType)));

    if (!targets.length && photos.length) {
      warnings.push('No obviously suitable photos for this mode — using the first uploaded photo.');
      targets = photos.slice(0, 1);
    }
    if (!targets.length) warnings.push('Upload a photo first.');

    for (const photo of targets) {
      for (let i = 0; i < Math.max(1, variants); i += 1) {
        if (calls.length >= MAX_IMAGES_PER_LISTING) break;
        const space = SPACE_BY_KEY[photo.spaceType];
        calls.push({
          kind: 'image',
          mode,
          photoId: photo.id,
          spaceType: photo.spaceType,
          title: `${space?.label || 'Space'} — ${VISUAL_STYLES[style].label}${variants > 1 ? ` (v${i + 1})` : ''}`,
          variant: i,
          request: {
            endpoint: '/v1/image2image',
            model: model.id,
            aspectRatio: '16:9',
            imageUrl: `${config.publicUrl}/uploads/${photo.file}`,
            prompt: promptFor({
              mode,
              space,
              style,
              notes,
              propertyType: listing?.propertyType,
              address: listing?.address,
            }),
          },
          estimatedCredits: model.credits,
          requiresDisclosure: true,
          disclosureLabel: spec.disclosureLabel,
        });
      }
    }
  }

  if (calls.length >= MAX_IMAGES_PER_LISTING) {
    warnings.push(`Capped at ${MAX_IMAGES_PER_LISTING} images per listing.`);
  }
  if (/localhost|127\.0\.0\.1/i.test(config.publicUrl) && spec.needsPhoto) {
    warnings.push('PUBLIC_URL is local-only — Higgsfield cannot download these photos.');
  }

  const totalCredits = calls.reduce((sum, c) => sum + c.estimatedCredits, 0);

  return {
    calls,
    estimate: {
      images: calls.length,
      model: model.id,
      creditsPerImage: model.credits,
      totalCredits,
      approxUsd: Number((totalCredits * 0.033).toFixed(2)),
    },
    warnings,
  };
}
