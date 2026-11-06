/**
 * featureCatalog — the sellable features of one customer account, and the
 * per-camera AI licences that bound them.
 *
 * The KEYS are the ones the customer sidebar already tags its rows with
 * (`feature:` in smart-cam-app/src/core/layout/Sidebar.jsx) and that
 * Subscription.features stores. This file only gives them labels and a group
 * so the admin console can show them as switches; it does not invent a second
 * vocabulary. Add a nav row with a new key → add it here too, and mirror the
 * rule in smart-cam-app/src/core/nav/entitlements.js.
 *
 * Two different limits live on an account:
 *   - feature visibility (Subscription.features): is the page there at all;
 *   - per-camera AI licence (Subscription.featureLimits): on how many cameras
 *     the feature may be switched on. Only features with a real per-camera
 *     switch in the backend have one — a count we cannot enforce is not shown
 *     as if we could.
 *
 * ── How Subscription.features is read ─────────────────────────────────────
 *
 *   NULL / []        full account: every feature the plan tier allows.
 *   ["a","b",…]      curated account:
 *                      - an ordinary key (every AI key, `map`, `reports`) is
 *                        ON only when it is listed;
 *                      - a `defaultOn` key is ON unless "!key" is listed.
 *   ["_none"]        every ordinary key off (defaultOn keys still on unless
 *                    "!key" is listed beside it).
 *
 *   A `demo` key is the exception to "NULL = everything": it is ON only when
 *   it is listed, on a full account too. Those pages run on sample data, not
 *   on a real detector (Weapon / Fire / Fights / Number plates / Staff
 *   activity), so a real customer never lands on them by default; an admin
 *   switches one on per account for a demo.
 *
 * Why two kinds: the defaultOn keys (Video wall, Recordings, Alerts, …) were
 * added in 2026-10, after curated lists already existed in production (Sharda:
 * person_tracker, person_search, restricted_zone, ai_feed, face_watchlist,
 * headcount, footfall, reports). Read as "listed = on", every one of those
 * lists would have lost Live/Playback/Alerts the moment this shipped. Storing
 * the OFF state ("!playback") for those keys means an old list needs no
 * migration and still means what it meant. The admin console writes both
 * kinds through storedFeatures() below.
 *
 * The always-on core (Home, Watch live, Settings › account) has no key.
 */

const OFF_PREFIX = '!';
// Stored when an admin switches every ordinary feature off: an empty list
// already means "full account", so "nothing" needs a value that matches no key.
const NO_FEATURES = '_none';

const FEATURE_GROUPS = Object.freeze([
  {
    id: 'vms', label: 'Video', ai: false,
    description: 'Watching, recording and setting up cameras',
    items: [
      { key: 'monitor_wall', label: 'Video wall', defaultOn: true,
        description: 'Many cameras on one screen, with saved wall layouts.' },
      { key: 'playback', label: 'Recordings', defaultOn: true,
        description: 'Play back footage from the site recorder (NVR) and make timelapses.' },
      { key: 'cloud_recordings', label: 'Cloud recordings', defaultOn: true,
        description: 'Clips saved to Drishyam cloud storage (the Cloud tab inside Recordings).' },
      { key: 'map', label: 'Map',
        description: 'Sites and cameras on a map.' },
      { key: 'reports', label: 'Reports',
        description: 'Make, keep and download PDF and spreadsheet reports.' },
      { key: 'camera_setup', label: 'Add & edit cameras', defaultOn: true,
        description: 'The customer adds and removes their own cameras, recorders and sites. Off = a managed account: only Drishyam adds cameras.' },
      { key: 'camera_health', label: 'Camera status', defaultOn: true,
        description: 'Which cameras are working, slow or offline.' },
    ],
  },
  {
    id: 'alerts', label: 'Alerts', ai: false,
    description: 'Telling the customer when something happens',
    items: [
      { key: 'alerts', label: 'Alerts page', defaultOn: true,
        description: 'The list of alerts with photos: known faces, strangers, breaches.' },
      { key: 'event_log', label: 'Activity history', defaultOn: true,
        description: 'The searchable history of everything the cameras detected.' },
      { key: 'email_alerts', label: 'Email alerts', defaultOn: true,
        description: 'Alerts by email; the customer picks who gets them. Off also stops the emails.' },
      { key: 'mobile_app', label: 'Phone alerts', defaultOn: true,
        description: 'Alerts pushed to the Drishyam phone app. Off stops the push notifications.' },
    ],
  },
  {
    id: 'team', label: 'Team', ai: false,
    description: 'Who in the customer’s company can log in',
    items: [
      { key: 'user_management', label: 'Users & roles', defaultOn: true,
        description: 'The customer adds their own staff logins and roles (Setup › Users).' },
    ],
  },
  {
    id: 'face', label: 'Face recognition', ai: true, licence: 'face',
    items: [
      { key: 'face_watchlist', label: 'Face Watchlist',
        description: 'Customer sees “Known people”: alert when a listed face is seen.' },
      { key: 'face_detection', label: 'Face Learning',
        description: 'Customer sees “Teach faces”: name the faces the cameras keep seeing.' },
    ],
  },
  {
    id: 'tracking', label: 'Find & track', ai: true, licence: 'face',
    items: [
      { key: 'person_search',  label: 'Personnel Search',
        description: 'Customer sees “Find a person”: search sightings by photo or name.' },
      { key: 'person_tracker', label: 'Person Tracker', note: 'Also Live Tracker',
        description: 'Customer sees “Track a person”: follow one person across cameras, live too.' },
      { key: 'journey_map',    label: 'Journey Map',
        description: 'Customer sees “Where they went”: a person’s route on the site plan.' },
    ],
  },
  {
    id: 'headcount', label: 'Head count & occupancy', ai: true, licence: 'headcount',
    items: [{ key: 'headcount', label: 'Head Count & Flow', note: 'Also Zone Setup and Camera Head Count',
      description: 'Customer sees “People count” and “Counting areas”.' }],
  },
  {
    id: 'restricted_zone', label: 'Restricted zones', ai: true, licence: 'restricted_zone',
    items: [{ key: 'restricted_zone', label: 'Restricted Zone Breaches',
      description: 'Customer sees “No-entry areas”: alert when someone enters one.' }],
  },
  {
    id: 'activity', label: 'Activity monitoring', ai: true, licence: 'activity',
    items: [{ key: 'activity', label: 'Activity Monitoring', note: 'Also Attendance Report', demo: true,
      description: 'Customer sees “Staff activity”: breaks, phone use, attendance, staff scores. Demo: sample data, off until switched on here.' }],
  },
  {
    id: 'safety', label: 'Safety detection', ai: true,
    items: [
      { key: 'weapon',     label: 'Weapon Detection', demo: true, description: 'Customer sees “Weapon alerts”. Demo: sample data, off until switched on here.' },
      { key: 'fire',       label: 'Fire Detection',   demo: true, description: 'Customer sees “Fire & smoke”. Demo: sample data, off until switched on here.' },
      { key: 'aggression', label: 'Aggression',       demo: true, description: 'Customer sees “Fights”. Demo: sample data, off until switched on here.' },
    ],
  },
  {
    id: 'vehicles', label: 'Vehicles', ai: true,
    items: [{ key: 'anpr', label: 'Vehicles (ANPR)', note: 'All vehicle tabs', demo: true,
      description: 'Customer sees “Number plates”: plate reads, vehicle search, outside vehicles. Demo: sample data, off until switched on here.' }],
  },
  {
    id: 'feed', label: 'Live feed', ai: true,
    items: [{ key: 'ai_feed', label: 'AI Feed',
      description: 'Customer sees “Live detections”: every detection as it happens.' }],
  },
]);

// Feature keys that need the face engine (vms_face) running on a camera.
// Person tracking reads the same engine's appearance stream.
const FACE_ENGINE_KEYS = Object.freeze([
  'face_watchlist', 'face_detection', 'person_search', 'person_tracker', 'journey_map',
]);

/**
 * Per-camera AI licences. `features` = the keys that need it (any one is
 * enough to be allowed to switch it on); `isOn(camera)` = the backend's own
 * per-camera switch for it. Restricted zones are counted from zone rows, not a
 * camera flag — see entitlements.service.countLicenceUsage.
 */
const AI_LICENCES = Object.freeze([
  {
    key: 'face', label: 'Face recognition & tracking',
    features: FACE_ENGINE_KEYS,
    isOn: (c) => c.settings?.ai?.enabled === true && c.settings?.ai?.mode !== 'off',
  },
  {
    key: 'headcount', label: 'Head count',
    features: ['headcount'],
    isOn: (c) => c.settings?.headcount?.enabled === true,
  },
  {
    key: 'activity', label: 'Activity monitoring',
    features: ['activity'],
    isOn: (c) => c.settings?.ai?.activityMonitoring === true,
  },
  {
    key: 'restricted_zone', label: 'Restricted zones',
    features: ['restricted_zone'],
    isOn: null, // counted from restricted_zones rows
  },
]);

const ALL_FEATURE_KEYS = Object.freeze(FEATURE_GROUPS.flatMap((g) => g.items.map((i) => i.key)));
const AI_FEATURE_KEYS = Object.freeze(
  FEATURE_GROUPS.filter((g) => g.ai).flatMap((g) => g.items.map((i) => i.key)),
);
const DEFAULT_ON_KEYS = Object.freeze(
  FEATURE_GROUPS.flatMap((g) => g.items.filter((i) => i.defaultOn).map((i) => i.key)),
);
// Sample-data pages (no real detector behind them yet): on ONLY when listed,
// even for a full (NULL) account. Mirror: DEMO_KEYS in core/nav/entitlements.js.
const DEMO_KEYS = Object.freeze(
  FEATURE_GROUPS.flatMap((g) => g.items.filter((i) => i.demo).map((i) => i.key)),
);

/**
 * Is `key` on for a stored Subscription.features value? Tier (AI) is NOT
 * checked here — entitlements.allowsAny adds that.
 * @param {string[]|null} features  Subscription.features as stored
 * @param {string} key
 */
function isFeatureOn(features, key) {
  if (DEMO_KEYS.includes(key)) return Array.isArray(features) && features.includes(key);
  if (!Array.isArray(features) || !features.length) return true;
  if (DEFAULT_ON_KEYS.includes(key)) return !features.includes(OFF_PREFIX + key);
  return features.includes(key);
}

/**
 * The admin-facing view of a stored list:
 *   { mode: 'all'|'custom', enabled: catalog keys that are on, unknown: other
 *     stored entries (hand-set keys such as `footfall`), kept as they are }
 */
function featureStateOf(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return { mode: 'all', enabled: ALL_FEATURE_KEYS.filter((k) => !DEMO_KEYS.includes(k)), unknown: [] };
  }
  const enabled = ALL_FEATURE_KEYS.filter((k) => isFeatureOn(raw, k));
  const unknown = raw.filter((k) => k !== NO_FEATURES
    && !ALL_FEATURE_KEYS.includes(k)
    && !(typeof k === 'string' && k.startsWith(OFF_PREFIX) && ALL_FEATURE_KEYS.includes(k.slice(1))));
  return { mode: 'custom', enabled, unknown };
}

/**
 * What to store for "these catalog keys on" (+ unknown entries to keep).
 * Returns null (full account) when every non-demo key is on, no demo key is
 * on and nothing else is kept. A demo key switched on needs an explicit list,
 * because NULL leaves every demo key off.
 * @param {string[]} chosen  catalog keys the admin switched on
 * @param {string[]} keep    unknown entries to carry over unchanged
 */
function storedFeatures(chosen, keep = []) {
  const on = new Set(chosen);
  const fullAccount = ALL_FEATURE_KEYS.every((k) => (DEMO_KEYS.includes(k) ? !on.has(k) : on.has(k)));
  if (fullAccount && !keep.length) return null;
  const list = [
    ...ALL_FEATURE_KEYS.filter((k) => !DEFAULT_ON_KEYS.includes(k) && on.has(k)),
    ...DEFAULT_ON_KEYS.filter((k) => !on.has(k)).map((k) => OFF_PREFIX + k),
    ...keep,
  ];
  return list.length ? list : [NO_FEATURES];
}

function featureLabel(key) {
  for (const g of FEATURE_GROUPS) {
    const hit = g.items.find((i) => i.key === key);
    if (hit) return hit.label;
  }
  return key;
}

function licenceFor(key) {
  return AI_LICENCES.find((l) => l.key === key) || null;
}

module.exports = {
  FEATURE_GROUPS,
  FACE_ENGINE_KEYS,
  AI_LICENCES,
  ALL_FEATURE_KEYS,
  AI_FEATURE_KEYS,
  DEFAULT_ON_KEYS,
  DEMO_KEYS,
  OFF_PREFIX,
  NO_FEATURES,
  isFeatureOn,
  featureStateOf,
  storedFeatures,
  featureLabel,
  licenceFor,
};
