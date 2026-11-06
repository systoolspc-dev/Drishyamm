/**
 * The face the Find & Track demos put in front of an audience.
 *
 * Pilot and sales demos run on machines with no cameras and no enrolled
 * gallery, so every "tracked person" fell back to a silhouette or a pair of
 * initials — which reads as "the system found nobody" at exactly the moment
 * you are trying to show that it found someone.
 *
 * To use a real headshot, drop it in `src/assets` named
 * `demo-face-<anything>.jpg` (`.jpeg`, `.png` and `.webp` also match) — for
 * example `src/assets/demo-face-rahul-sharma.jpg`. Nothing else to wire up.
 *
 * The glob resolves the file at build time when it is present and yields an
 * empty object when it is not, so a checkout without the photo still builds
 * and still runs — it simply falls back to the silhouette below, which is the
 * behaviour this app had before. That is the same trick FireDetectionRouter
 * uses for its optional demo clip.
 */
const photos = import.meta.glob('../../assets/demo-face-*.{jpg,jpeg,png,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** The headshot, or null when no file has been dropped in. */
export const DEMO_FACE_PHOTO = Object.values(photos)[0] || null;

/** Brand-orange silhouette. Used until a real photo is supplied. */
export const DEMO_FACE_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
      '<rect width="160" height="160" rx="20" fill="#FFF1E2"/>' +
      '<circle cx="80" cy="60" r="30" fill="#F7983A"/>' +
      '<path d="M24 152c0-33 25-54 56-54s56 21 56 54z" fill="#F7983A"/>' +
      '</svg>',
  );

/** What every demo surface should render for the tracked person. */
export const DEMO_FACE = DEMO_FACE_PHOTO || DEMO_FACE_PLACEHOLDER;

/**
 * The person the walkthrough follows. The name stays consistent across Person
 * Tracker and Journey Map so a presenter moving between the two pages is
 * clearly looking at one subject — while `external_id` keeps saying "Sample
 * journey", so synthetic data is never mistaken for a real sighting.
 */
export const DEMO_SUBJECT_FULL_NAME = 'Rahul Sharma';
