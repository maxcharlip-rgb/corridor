import { MOTION_BY_KEY, SPACE_BY_KEY, SPACE_TYPES } from '../motions.js';
import { CREDITS_PER_TAKE } from '../limits.js';
import { config } from '../config.js';

/**
 * Tour agent — spec in, executable Higgsfield plan out.
 *
 * No LLM, deliberately. Choosing a camera move for a room type is a lookup, not
 * a judgement: a break room takes an orbit, a corridor takes a push. A model
 * would do the same job slower, less predictably, and at a cost per call.
 *
 * Returns a PLAN ONLY — never calls Higgsfield. The backend executes it, which
 * keeps the credit gate the single chokepoint for spend.
 */

/**
 * Model tiers for `/v1/image2video/dop`.
 *
 * The endpoint accepts only dop-lite, dop-preview and dop-turbo. Both tiers
 * point at dop-turbo for now: it is the one variant validated end to end on
 * real footage, and promoting hero shots to dop-preview is not worth doing
 * blind — its per-second cost is unmeasured, and an unverified upgrade applied
 * to every listing spends a client's credits to satisfy a guess.
 */
export const MODELS = {
  standard: { id: 'dop-turbo', credits: 5.0 },
  hero: { id: 'dop-turbo', credits: 5.0 },
};

/**
 * Shot style per room type.
 *
 * `motionKey` indexes our camera catalogue, which expresses the move in prompt
 * language. Higgsfield's `preset_id` parameter is NOT a camera preset — that
 * catalogue is consumer character effects (ZOMBIE DANCE, EARTH ZOOM) and will
 * wreck a listing video. Camera direction lives in the prompt.
 */
export const SHOT_STYLES = {
  exterior:   { motionKey: 'dolly_in',       weight: 1.30, tier: 'hero',     intent: 'establish the building and its street presence' },
  entrance:   { motionKey: 'dolly_in',       weight: 0.90, tier: 'standard', intent: 'arrive at and push toward the entry doors' },
  lobby:      { motionKey: 'crane_up',       weight: 1.25, tier: 'hero',     intent: 'reveal the volume and finish level of the arrival space' },
  corridor:   { motionKey: 'push_forward',   weight: 1.15, tier: 'standard', intent: 'walk the length of the circulation and show depth' },
  floor:      { motionKey: 'truck_lateral',  weight: 1.50, tier: 'standard', intent: 'show the width and openness of the floor plate' },
  workspace:  { motionKey: 'pull_back',      weight: 1.15, tier: 'standard', intent: 'reveal the full workstation layout from a detail' },
  conference: { motionKey: 'orbit_360',      weight: 0.95, tier: 'standard', intent: 'circle the table to show the room in the round' },
  breakroom:  { motionKey: 'orbit_360',      weight: 0.90, tier: 'standard', intent: 'sweep the amenity space and its finishes' },
  amenity:    { motionKey: 'orbit_360',      weight: 1.10, tier: 'hero',     intent: 'sweep the amenity as a selling feature' },
  rooftop:    { motionKey: 'crane_up',       weight: 1.30, tier: 'hero',     intent: 'rise to reveal the outdoor space and the view beyond' },
  detail:     { motionKey: 'static_hold',    weight: 0.70, tier: 'standard', intent: 'hold on a finish detail' },
  transition: { motionKey: 'blend_transition', weight: 1.05, tier: 'standard', intent: 'travel continuously between two rooms' },
};

/**
 * How long a shot should run.
 *
 * A fixed 5 seconds everywhere is wrong in both directions: a detail shot
 * outstays its welcome while a 24,000 SF floor plate gets cut off before the
 * eye has crossed it. Length has to track how much there is to look at.
 *
 * Three inputs:
 *   weight  — how much attention the space itself deserves. A floor plate reads
 *             slowly and is the thing being leased; a break room does not.
 *   scale   — the property's size. The same lateral truck across 60,000 SF has
 *             far more ground to cover than across 4,000.
 *   pace    — the broker's call on overall tour length.
 *
 * The result is clamped to the model's real range, because an out-of-range
 * duration is silently ignored upstream.
 */
export const PACES = {
  quick:     { key: 'quick',     label: 'Quick cut',  factor: 0.78, blurb: 'Tighter shots. Best for social.' },
  standard:  { key: 'standard',  label: 'Standard',   factor: 1.00, blurb: 'Balanced. The default.' },
  cinematic: { key: 'cinematic', label: 'Cinematic',  factor: 1.30, blurb: 'Longer holds. Best for a pitch or a big property.' },
};

const BASE_SECONDS = 5.5;

/** Bigger properties earn longer moves — there is literally more to cross. */
function scaleFactor(totalSf) {
  if (!totalSf || !Number.isFinite(totalSf)) return 1;
  if (totalSf < 3000) return 0.85;
  if (totalSf < 8000) return 0.95;
  if (totalSf < 20000) return 1.05;
  if (totalSf < 50000) return 1.18;
  if (totalSf < 120000) return 1.30;
  return 1.40;
}

export function durationFor({ spaceType, spec, pace = 'standard', model }) {
  const style = SHOT_STYLES[spaceType] || SHOT_STYLES.floor;
  const paceFactor = (PACES[pace] || PACES.standard).factor;
  const raw = BASE_SECONDS * style.weight * scaleFactor(spec?.totalSf) * paceFactor;

  // Respect what the chosen model actually supports.
  const range = MODEL_DURATION[model] || { min: 3, max: 12 };
  return Math.min(Math.max(Math.round(raw), range.min), range.max);
}

/**
 * Duration limits per model.
 *
 * The dop family's real range is unpublished, so it is deliberately absent:
 * an invented range would quietly truncate a long tour, while an out-of-range
 * value now comes back as a readable 422 instead.
 */
export const MODEL_DURATION = {};

const fmtSf = (n) => (typeof n === 'number' ? `${n.toLocaleString('en-US')} SF` : null);

/**
 * One short, accurate caption per shot.
 *
 * Built ONLY from operator-entered spec fields. Never invents a measurement, a
 * rate or a feature — a caption is a representation about a property, and an
 * invented one is worse than no caption at all. Falls back to the room name.
 */
export function heroTextFor({ spaceType, spec, isTransition }) {
  if (isTransition) return '';
  const label = SPACE_BY_KEY[spaceType]?.label || 'Space';
  const sf = fmtSf(spec?.totalSf);
  const findSpec = (re) => (spec?.specs || []).find((s) => re.test(s.label || ''))?.value || null;

  switch (spaceType) {
    case 'exterior': {
      const parts = [sf, spec?.floors ? `${spec.floors} floor${spec.floors > 1 ? 's' : ''}` : null];
      const tail = parts.filter(Boolean).join(' · ');
      return tail || spec?.address || label;
    }
    case 'floor':
    case 'workspace': {
      const avail = findSpec(/available|rentable|suite/i);
      return [avail ? `${avail} SF` : sf, 'open floor plate'].filter(Boolean).join(' · ') || label;
    }
    case 'lobby':
      return 'Reception and arrival';
    case 'corridor':
      return 'Circulation and elevator lobby';
    case 'conference':
      return 'Conference room';
    case 'breakroom':
      return 'Break room and kitchenette';
    case 'amenity':
      return 'Shared amenity space';
    case 'rooftop':
      return 'Rooftop and outdoor space';
    case 'entrance':
      return 'Main entrance';
    default:
      return label;
  }
}

/**
 * Build the generation prompt for one shot.
 *
 * Realism is the whole objective, so the prompt is mostly prohibition. Property
 * video fails when the model redecorates: the two failure modes actually
 * observed in production were invented facade signage and an inverted camera
 * move, and both are addressed here explicitly rather than generically.
 */
export function buildShotPrompt({ spaceType, motion, spec, heroText, isTransition }) {
  const label = (SPACE_BY_KEY[spaceType]?.label || 'commercial space').toLowerCase();
  const style = SHOT_STYLES[spaceType] || SHOT_STYLES.floor;
  const propertyType = spec?.propertyType ? `${spec.propertyType} ` : '';

  return [
    isTransition
      ? `Continuous cinematic walkthrough moving between two areas of a ${propertyType}commercial property.`
      : `Cinematic architectural walkthrough of the ${label} of a ${propertyType}commercial property.`,
    heroText ? `This space is presented as: ${heroText}.` : '',
    `Shot intent: ${style.intent}.`,
    `Camera direction: ${motion.promptFragment}.`,
    'Move smoothly through this real photograph. Stable camera, level horizon, soft cinematic lighting,',
    'true-to-photo colours, photorealistic architectural cinematography, no motion blur, no fisheye distortion.',
    'CRITICAL — do not add, remove, restyle or move anything: no people, no added furniture, no new walls,',
    'doors, windows or columns, no signage, no lettering, no logos, no text of any kind anywhere in frame.',
    'Preserve the existing architecture, finishes, fixtures and layout exactly as photographed.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Validate a planned shot. Quality gates are enforced in code rather than left
 * to review, because a bad shot costs credits to discover.
 */
function validate(call) {
  const problems = [];
  if (!call.spaceType) problems.push('missing room type');
  if (!call.isTransition && !call.heroText) problems.push('missing heroText');
  if (!call.request?.prompt || call.request.prompt.length < 80) problems.push('prompt too thin');
  if (!call.request?.imageUrls?.length) problems.push('no image URL');
  if (!call.isTransition && !new RegExp(SPACE_BY_KEY[call.spaceType]?.label?.split(' ')[0] || 'x', 'i').test(call.request.prompt)) {
    problems.push('prompt does not name the room type');
  }
  return problems;
}

/**
 * @param {object} input
 * @param {object} input.spec      output of specAgent
 * @param {object[]} input.photos  store photo records
 * @param {number} [input.takes]
 * @param {boolean} [input.withTransitions]
 * @param {number} [input.budgetCredits] trim the plan to fit
 * @returns {{calls, estimate, warnings, rejected}}
 */
export function tourAgent({ spec, photos = [], takes = 3, withTransitions = true, budgetCredits = null, pace = 'standard' }) {
  const warnings = [];
  const rejected = [];
  const byFile = new Map(photos.map((p) => [p.file, p]));

  const planned = (spec?.shots || [])
    .map((shot) => ({ shot, photo: byFile.get(shot.photoFile) }))
    .filter((entry) => {
      if (!entry.photo) warnings.push(`No uploaded photo matches "${entry.shot.photoFile}" — skipped.`);
      return Boolean(entry.photo);
    })
    .sort(
      (a, b) =>
        (SPACE_BY_KEY[a.shot.spaceType]?.order ?? 999) - (SPACE_BY_KEY[b.shot.spaceType]?.order ?? 999)
    );

  if (!planned.length) warnings.push('No shots could be planned — check that photos are uploaded.');

  const urlFor = (photo) => `${config.publicUrl}/uploads/${photo.file}`;
  const calls = [];
  let order = 0;

  const push = (call) => {
    const problems = validate(call);
    if (problems.length) {
      rejected.push({ title: call.title, problems });
      return;
    }
    calls.push(call);
  };

  planned.forEach((entry, index) => {
    const spaceType = entry.shot.spaceType;
    const style = SHOT_STYLES[spaceType] || SHOT_STYLES.floor;
    const motion = MOTION_BY_KEY[style.motionKey] || MOTION_BY_KEY.dolly_in;
    const model = MODELS[style.tier] || MODELS.standard;
    const durationSec = durationFor({ spaceType, spec, pace, model: model.id });
    const heroText = entry.shot.caption?.trim() || heroTextFor({ spaceType, spec });

    push({
      kind: 'video',
      order: order++,
      title: entry.shot.title || SPACE_BY_KEY[spaceType]?.label || 'Stop',
      heroText,
      spaceType,
      isTransition: false,
      motionKey: motion.key,
      photoIds: [entry.photo.id],
      durationSec,
      takes,
      tier: style.tier,
      request: {
        endpoint: '/v1/image2video/dop',
        model: model.id,
        duration: durationSec,
        aspectRatio: '16:9',
        sound: 'off',
        imageUrls: [urlFor(entry.photo)],
        prompt: buildShotPrompt({ spaceType, motion, spec, heroText, isTransition: false }),
      },
      estimatedCredits: takes * model.credits,
    });

    // A blend only reads well between two *different* rooms; between two angles
    // of the same room it looks like a stutter.
    const next = planned[index + 1];
    if (withTransitions && next && next.shot.spaceType !== spaceType) {
      const blend = MOTION_BY_KEY.blend_transition;
      const transitionSec = durationFor({ spaceType: 'transition', spec, pace, model: MODELS.standard.id });
      push({
        kind: 'video',
        order: order++,
        title: `${SPACE_BY_KEY[spaceType]?.label || 'Stop'} → ${SPACE_BY_KEY[next.shot.spaceType]?.label || 'Next'}`,
        heroText: '',
        spaceType: 'transition',
        isTransition: true,
        motionKey: blend.key,
        photoIds: [entry.photo.id, next.photo.id],
        durationSec: transitionSec,
        takes,
        tier: 'standard',
        request: {
          endpoint: '/v1/image2video/dop',
          model: MODELS.standard.id,
          duration: transitionSec,
          aspectRatio: '16:9',
          sound: 'off',
          imageUrls: [urlFor(entry.photo), urlFor(next.photo)],
          prompt: buildShotPrompt({ spaceType: 'transition', motion: blend, spec, heroText: '', isTransition: true }),
        },
        estimatedCredits: takes * MODELS.standard.credits,
      });
    }
  });

  if (rejected.length) {
    warnings.push(`${rejected.length} shot(s) rejected by quality gate: ${rejected.map((r) => `${r.title} (${r.problems.join(', ')})`).join('; ')}`);
  }

  // Trim to budget by demoting hero-tier shots to the standard model before
  // dropping any shot outright — a cheaper model beats a missing room.
  let total = calls.reduce((sum, c) => sum + c.estimatedCredits, 0);
  if (budgetCredits && total > budgetCredits) {
    for (const call of calls) {
      if (total <= budgetCredits) break;
      if (call.tier !== 'hero') continue;
      const saving = call.estimatedCredits - takes * MODELS.standard.credits;
      call.request.model = MODELS.standard.id;
      call.tier = 'standard';
      call.estimatedCredits -= saving;
      total -= saving;
      warnings.push(`Demoted "${call.title}" to the standard model to fit the credit budget.`);
    }
    if (total > budgetCredits) {
      warnings.push(`Plan still exceeds the budget (${total} > ${budgetCredits} credits). Reduce takes or shots.`);
    }
  }

  if (/localhost|127\.0\.0\.1/i.test(config.publicUrl)) {
    warnings.push('PUBLIC_URL is local-only. Higgsfield cannot download these photos — set a public tunnel before executing.');
  }

  const heroShots = calls.filter((c) => c.tier === 'hero').length;

  return {
    calls,
    rejected,
    estimate: {
      shots: calls.length,
      heroShots,
      takesPerShot: takes,
      generations: calls.length * takes,
      totalCredits: Number(total.toFixed(1)),
      approxUsd: Number((total * 0.033).toFixed(2)),
      runtimeSec: calls.reduce((sum, c) => sum + c.durationSec, 0),
    },
    warnings,
  };
}

/** Caption track for the assembler: one timed band per shot. */
export function captionTrack(calls) {
  let at = 0;
  const track = [];
  for (const call of calls) {
    if (call.heroText) {
      // Hold the caption over the first half of the shot, then clear it so the
      // architecture is unobstructed for the rest of the move.
      track.push({
        from: Number((at + 0.35).toFixed(2)),
        to: Number((at + Math.min(call.durationSec * 0.6, 3.6)).toFixed(2)),
        text: call.heroText,
      });
    }
    at += call.durationSec;
  }
  return track;
}

export const SPACE_ORDER = SPACE_TYPES.map((s) => s.key);
