/**
 * Camera motion catalog.
 *
 * Two things worth knowing about Higgsfield before reading this file:
 *
 * 1. Higgsfield's *presets* (the `preset_id` parameter) are consumer/character
 *    effects — "ZOMBIE DANCE", "EARTH ZOOM", "ACTION FIGURE". They are the wrong
 *    tool for property marketing and will happily turn a lobby into a music
 *    video. The cinematic camera moves we want live in the DoP model's motion
 *    vocabulary, applied to `/v1/image2video/dop`.
 *
 * 2. Motion UUIDs are catalog-specific and change over time. So each entry here
 *    carries a `promptFragment` that expresses the move in plain camera
 *    language, which the DoP models honour on its own. If you have the UUID for
 *    a motion, set it via env (see `motionEnvKey`) and it gets sent as well.
 *
 * `preview` drives the local ffmpeg render so the free preview reads as the
 * same shot as the paid one: same direction of travel, same framing intent.
 * z = zoom (1 = full frame), c = normalised centre of interest (0..1).
 */

export const MOTIONS = [
  {
    key: 'dolly_in',
    label: 'Dolly In',
    tagline: 'Push through the front door',
    description:
      'Camera advances steadily into the space. The strongest opening shot in a tour — it reads as "you are walking in".',
    higgsfieldMotion: 'Dolly In',
    promptFragment:
      'the camera dollies smoothly forward into the space at a steady walking pace, holding a level horizon',
    bestFor: ['exterior', 'entrance', 'lobby', 'corridor'],
    inputs: 1,
    preview: { z0: 1.0, z1: 1.28, c0: [0.5, 0.5], c1: [0.5, 0.5] },
  },
  {
    key: 'push_forward',
    label: 'Push Forward',
    tagline: 'Move deeper down a corridor',
    description:
      'A slower, longer push than a dolly in. Use it to communicate depth — the length of a floor plate or a run of offices.',
    higgsfieldMotion: 'Push In',
    promptFragment:
      'the camera pushes forward slowly and continuously deeper into the room, revealing the depth of the space',
    bestFor: ['corridor', 'floor', 'workspace'],
    inputs: 1,
    preview: { z0: 1.02, z1: 1.34, c0: [0.5, 0.48], c1: [0.52, 0.5] },
  },
  {
    key: 'orbit_360',
    label: '360 Orbit',
    tagline: 'Rotate around a feature',
    description:
      'Smooth arc around a focal point. Best on a kitchen island, a reception desk, or an amenity centrepiece — anything with a clear middle.',
    higgsfieldMotion: '360 Orbit',
    promptFragment:
      'the camera orbits smoothly around the central feature of the room in one continuous arc, keeping it centred in frame',
    bestFor: ['amenity', 'lobby', 'breakroom', 'conference'],
    inputs: 1,
    preview: { z0: 1.18, z1: 1.18, c0: [0.28, 0.5], c1: [0.72, 0.5] },
  },
  {
    key: 'crane_up',
    label: 'Crane Shot',
    tagline: 'Rise to reveal scale',
    description:
      'Camera lifts and tilts to take in the whole space. The shot that sells a rooftop, a plaza, or a double-height lobby.',
    higgsfieldMotion: 'Crane Up',
    promptFragment:
      'the camera cranes upward and slightly tilts down, opening up to reveal the full scale of the space and the sky beyond',
    bestFor: ['rooftop', 'exterior', 'lobby', 'plaza'],
    inputs: 1,
    preview: { z0: 1.3, z1: 1.04, c0: [0.5, 0.72], c1: [0.5, 0.34] },
  },
  {
    key: 'pull_back',
    label: 'Pull Back',
    tagline: 'Reveal the full space from a detail',
    description:
      'Starts tight on a detail and retreats to the wide. The natural closing shot of a stop, or of the whole tour.',
    higgsfieldMotion: 'Pull Back',
    promptFragment:
      'the camera pulls back steadily from a tight detail to reveal the entire space in a wide establishing frame',
    bestFor: ['workspace', 'amenity', 'floor', 'exterior'],
    inputs: 1,
    preview: { z0: 1.42, z1: 1.0, c0: [0.5, 0.5], c1: [0.5, 0.5] },
  },
  {
    key: 'tilt_up',
    label: 'Tilt Up',
    tagline: 'Show ceiling height',
    description:
      'Vertical reveal from floor to ceiling. Clear-height is a leasing spec buyers care about — this is how you show it instead of stating it.',
    higgsfieldMotion: 'Tilt Up',
    promptFragment:
      'the camera tilts upward from the floor toward the ceiling in one smooth continuous move, emphasising vertical height',
    bestFor: ['lobby', 'warehouse', 'atrium', 'exterior'],
    inputs: 1,
    preview: { z0: 1.24, z1: 1.24, c0: [0.5, 0.86], c1: [0.5, 0.16] },
  },
  {
    key: 'truck_lateral',
    label: 'Lateral Truck',
    tagline: 'Glide across the floor plate',
    description:
      'Camera slides sideways, parallel to the space. Reads as width — the right move for open-plan floors and workstation counts.',
    higgsfieldMotion: 'Truck Left',
    promptFragment:
      'the camera trucks smoothly sideways across the room, parallel to the floor, revealing the width of the space',
    bestFor: ['floor', 'workspace', 'corridor'],
    inputs: 1,
    preview: { z0: 1.2, z1: 1.2, c0: [0.16, 0.5], c1: [0.84, 0.5] },
  },
  {
    key: 'static_hold',
    label: 'Locked Off',
    tagline: 'Hold, with life',
    description:
      'Effectively no camera move — subtle parallax only. Use for spec cards and detail beats where movement would distract.',
    higgsfieldMotion: 'Static',
    promptFragment:
      'the camera remains locked off and still, with only the most subtle natural parallax and no perceptible movement',
    bestFor: ['detail', 'spec', 'signage'],
    inputs: 1,
    preview: { z0: 1.06, z1: 1.11, c0: [0.5, 0.5], c1: [0.5, 0.5] },
  },
  {
    key: 'blend_transition',
    label: 'Seamless Blend',
    tagline: 'Travel between two rooms',
    description:
      'Takes two overlapping photos and invents the walk between them. This is what stitches separate stills into one continuous tour.',
    higgsfieldMotion: 'Dolly In',
    promptFragment:
      'smoothly blend from the first image into the second image as one continuous camera move, stable camera, seamless transition, no cut',
    bestFor: ['transition'],
    inputs: 2,
    preview: { z0: 1.06, z1: 1.22, c0: [0.5, 0.5], c1: [0.5, 0.5] },
  },
];

export const MOTION_BY_KEY = Object.fromEntries(MOTIONS.map((m) => [m.key, m]));

/** Env override for a motion UUID, e.g. HIGGSFIELD_MOTION_DOLLY_IN=<uuid>. */
export function motionEnvKey(key) {
  return `HIGGSFIELD_MOTION_${key.toUpperCase()}`;
}

export function motionIdFor(key) {
  return process.env[motionEnvKey(key)] || null;
}

/**
 * Space types drive both auto-sequencing and the default motion suggestion.
 * Ordered the way a physical tour actually runs.
 */
export const SPACE_TYPES = [
  { key: 'exterior', label: 'Exterior', order: 10, defaultMotion: 'dolly_in' },
  { key: 'entrance', label: 'Entrance', order: 20, defaultMotion: 'dolly_in' },
  { key: 'lobby', label: 'Lobby / Reception', order: 30, defaultMotion: 'crane_up' },
  { key: 'corridor', label: 'Corridor / Elevator', order: 40, defaultMotion: 'push_forward' },
  { key: 'floor', label: 'Floor Plate', order: 50, defaultMotion: 'truck_lateral' },
  { key: 'workspace', label: 'Workstations / Offices', order: 60, defaultMotion: 'pull_back' },
  { key: 'conference', label: 'Conference Room', order: 70, defaultMotion: 'orbit_360' },
  { key: 'breakroom', label: 'Break Room / Kitchen', order: 80, defaultMotion: 'orbit_360' },
  { key: 'amenity', label: 'Amenity Space', order: 90, defaultMotion: 'orbit_360' },
  { key: 'rooftop', label: 'Rooftop / Outdoor', order: 100, defaultMotion: 'crane_up' },
  { key: 'detail', label: 'Detail / Finish', order: 110, defaultMotion: 'static_hold' },
];

export const SPACE_BY_KEY = Object.fromEntries(SPACE_TYPES.map((s) => [s.key, s]));

/**
 * Guess a space type from a filename. Brokers upload folders like
 * "lobby-01.jpg" / "IMG_rooftop.jpg", so this saves a lot of clicking. It is
 * only ever a starting suggestion — the UI always shows the guess as editable.
 */
export function guessSpaceType(filename) {
  const name = String(filename || '').toLowerCase();
  const rules = [
    ['exterior', /exterior|facade|street|building|front|aerial|drone|outside/],
    ['rooftop', /roof|terrace|patio|deck|balcon|plaza|courtyard/],
    ['lobby', /lobby|reception|entry|foyer|atrium|vestibule/],
    ['entrance', /entrance|door|entry/],
    ['breakroom', /break|kitchen|pantry|cafe|lunch|dining|eat/],
    ['conference', /conference|meeting|boardroom|huddle/],
    ['corridor', /corridor|hall|elevator|stair|lift/],
    ['workspace', /desk|cubicle|workstation|office|suite|bullpen/],
    ['amenity', /amenity|gym|fitness|lounge|game|wellness/],
    ['floor', /floor|plate|open|space|interior/],
    ['detail', /detail|finish|sign|logo|close/],
  ];
  for (const [key, pattern] of rules) {
    if (pattern.test(name)) return key;
  }
  return 'floor';
}

/**
 * Build the generation prompt for a shot.
 *
 * Deliberately conservative language: property video fails when the model
 * invents architecture, so every prompt carries explicit do-not-invent
 * guardrails alongside the camera direction.
 */
export function buildPrompt(shot, { listing, motion, spaceType } = {}) {
  if (shot.promptOverride && shot.promptOverride.trim()) {
    return shot.promptOverride.trim();
  }

  const space = spaceType?.label ? spaceType.label.toLowerCase() : 'interior space';
  const propertyType = listing?.propertyType ? `${listing.propertyType} ` : '';

  const parts = [
    `Cinematic architectural walkthrough of the ${space} of a ${propertyType}commercial property.`,
    `Camera direction: ${motion.promptFragment}.`,
    'Photorealistic, real estate marketing cinematography, natural interior lighting, true-to-photo colours, stable horizon, no motion blur, no fisheye distortion.',
    'Preserve the existing architecture, finishes, furniture and layout exactly as shown; do not add, remove, or restyle any structural element, fixture, or signage.',
    'No people entering frame, no text overlays, no captions, no logos.',
  ];

  if (shot.direction && shot.direction.trim()) {
    parts.splice(2, 0, `Additional direction: ${shot.direction.trim()}.`);
  }

  return parts.join(' ');
}
