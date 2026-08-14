/** Built-in public demo. Render's disk has no listings, so this cannot
 *  depend on db.json. The files live in public/demo and ship with the app. */
export const DEMO_SLUG = 'demo';
export const DEMO_LISTING_ID = 'lst_demo';

export const DEMO_SHOTS = [
  { id: 'sht_demo_exterior', title: 'Exterior', caption: 'From the curb', file: 'exterior' },
  { id: 'sht_demo_lobby', title: 'Lobby', caption: 'How the building receives people', file: 'lobby' },
  { id: 'sht_demo_corridor', title: 'Corridor', caption: 'The walk to the floor', file: 'corridor' },
  { id: 'sht_demo_floor', title: 'Floor plate', caption: 'The space they would take', file: 'floor' },
  { id: 'sht_demo_break', title: 'Break room', caption: 'Where the day actually happens', file: 'breakroom' },
  { id: 'sht_demo_roof', title: 'Rooftop', caption: 'Why this listing is not the one next door', file: 'rooftop' },
];

export const DEMO_LISTING = {
  id: DEMO_LISTING_ID,
  slug: DEMO_SLUG,
  published: true,
  name: '1011 Commerce Center',
  address: '1011 Michigan Ave NE, Grand Rapids, MI',
  headline: '24,000 SF available · Q1 2027 occupancy',
  propertyType: 'office',
  specs: [
    { label: 'Available SF', value: '24,000' },
    { label: 'Asking rate', value: '$18.50 NNN' },
  ],
  cta: { label: 'Request a showing', enabled: true },
};

export function isDemoSlug(slug) {
  return String(slug || '') === DEMO_SLUG;
}

export function demoPayload() {
  return {
    demo: true,
    disclosures: [
      'This is a Corridor sample listing. The space is real. The inquiry comes to us.',
    ],
    listing: {
      name: DEMO_LISTING.name,
      address: DEMO_LISTING.address,
      headline: DEMO_LISTING.headline,
      propertyType: DEMO_LISTING.propertyType,
      specs: DEMO_LISTING.specs,
      cta: DEMO_LISTING.cta,
      reelUrl: null,
      demo: true,
    },
    broker: {
      name: 'Max Charlip',
      company: 'Corridor',
      email: 'max@corridor.tours',
      phone: '',
    },
    stops: DEMO_SHOTS.map((shot) => ({
      id: shot.id,
      title: shot.title,
      caption: shot.caption,
      spaceType: shot.file,
      motionLabel: '',
      isTransition: false,
      videoUrl: `/demo/${shot.file}.mp4`,
      posterUrl: `/demo/${shot.file}.jpg`,
      durationSec: 5,
      virtuallyStaged: false,
    })),
  };
}

export function demoShotIds() {
  return new Set(DEMO_SHOTS.map((s) => s.id));
}
