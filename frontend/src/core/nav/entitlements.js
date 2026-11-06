/**
 * Per-account feature entitlement — the single source of truth.
 *
 * This lived only inside Sidebar.jsx, so every other surface that wanted to
 * show features (the dashboard's shortcut panels, most recently) hand-rolled
 * its own list and drifted. That drift is not cosmetic: the dashboard was
 * offering "By Face" and "By Appearance" to accounts that had no such feature,
 * pointing at a route that no longer existed, which the catch-all turned into a
 * redirect to the login page.
 *
 * Semantics (unchanged from the Sidebar implementation this replaces):
 *  - Full account (`features == null`) sees everything; AI is still gated by
 *    `aiEnabled`.
 *  - Curated account sees untagged VMS-core items always, a tagged item only
 *    when its feature is on (listed, or for a DEFAULT_ON key: not switched
 *    off with "!key"), and untagged AI items never — so the console
 *    isn't cluttered with generic AI tools the account never asked for.
 *  - `optIn` items appear ONLY when explicitly listed, even for full accounts.
 *    That lets a curated account surface something in a different section
 *    without it appearing for everyone.
 *  - `aiEnabled === false` drops AI groups entirely.
 *  - DEMO keys (sample-data pages, see DEMO_KEYS) are on ONLY when listed —
 *    a full account (`features == null`) does not get them.
 */
// Roles that BUILD Monitor Wall layouts. Operators and viewers (the guards at
// a desk) only open walls, so the builder and its sidebar entry are hidden
// from them. `user` is the legacy full-access role, `owner` the demo login.
export const WALL_MANAGER_ROLES = ['admin', 'user', 'manager', 'owner'];
export const canManageWalls = (user) => WALL_MANAGER_ROLES.includes(user?.role);

/**
 * Keys added in 2026-10 that are ON for a curated account unless the admin
 * explicitly switched them off (stored as "!key"). Every other key — all AI
 * keys, plus `map` and `reports` — is on for a curated account only when it
 * is listed. Mirror of featureCatalog.js (`defaultOn: true`) in the backend;
 * see the comment there for why (Sharda's list predates these keys).
 */
export const DEFAULT_ON_KEYS = [
  'monitor_wall', 'playback', 'cloud_recordings', 'camera_setup', 'camera_health',
  'alerts', 'event_log', 'email_alerts', 'mobile_app', 'user_management',
];

/**
 * Pages that run on sample data, not on a real detector: Weapon, Fire, Fights,
 * Number plates (ai-analytics/*, ai-analytics/data/ANPR.js) and Staff activity
 * (employee-productivity's dummy data layer). A real customer must never see
 * them by default, so they are on ONLY when the account lists the key — even
 * a full account (features NULL) does not get them. The admin console switches
 * one on per account for a demo. Mirror of featureCatalog.js (`demo: true`).
 */
export const DEMO_KEYS = ['weapon', 'fire', 'aggression', 'anpr', 'activity'];

/** Is `key` on for this stored features value (null = full account)? Tier not checked. */
export function featureOn(features, key) {
  if (DEMO_KEYS.includes(key)) return Array.isArray(features) && features.includes(key);
  if (!Array.isArray(features) || !features.length) return true;
  if (DEFAULT_ON_KEYS.includes(key)) return !features.includes(`!${key}`);
  return features.includes(key);
}

export function makeEntitlement(user) {
  const aiOn = user?.aiEnabled !== false;
  const features = Array.isArray(user?.features) && user.features.length ? user.features : null;
  /** Is this key on? Basic keys ignore the tier; AI keys need it. */
  const has = (key) => featureOn(features, key) && (aiOn || !AI_KEYS.has(key));
  /** Any of these keys on (an item tagged `featureAny`). */
  const hasAny = (keys) => keys.some(has);

  /**
   * @param item        nav/use-case item; may carry `feature` and `optIn`
   * @param isAiGroup   true when the item sits in an AI group, which decides
   *                    what happens to an item with no feature tag
   */
  const allows = (item, isAiGroup) => {
    if (item.optIn) return !!features && features.includes(item.feature);
    if (item.featureAny) return hasAny(item.featureAny);
    // featureOn(null, key) is true for every key but a demo one.
    if (item.feature) return featureOn(features, item.feature);
    return !features || !isAiGroup;
  };

  return { aiOn, features, allows, has, hasAny };
}

// AI keys (need the AI+VMS tier). Mirror of featureCatalog.js AI groups.
const AI_KEYS = new Set([
  'face_watchlist', 'face_detection', 'person_search', 'person_tracker', 'journey_map',
  'headcount', 'restricted_zone', 'activity', 'weapon', 'fire', 'aggression', 'anpr', 'ai_feed',
]);

/**
 * Which feature a PAGE needs — the route-level twin of the sidebar's `feature`
 * tags, so a page hidden from the sidebar cannot still be opened by URL or a
 * bookmark. Longest prefix wins; `any` = one of these keys is enough; `ai`
 * pages also need the AI tier. The backend refuses the same features' APIs
 * (middleware/requireFeature.js) — this is UX, not the boundary.
 *
 * Keys must match smart-cam-backend/src/utils/featureCatalog.js.
 */
const ROUTE_FEATURES = [
  { prefix: '/map',                         any: ['map'] },
  { prefix: '/reports',                     any: ['reports'] },
  { prefix: '/monitor-wall',                any: ['monitor_wall'] },
  // One page, two tabs: NVR + timelapse need `playback`, Cloud needs
  // `cloud_recordings` — the page hides the tab the account lacks.
  { prefix: '/playback',                    any: ['playback', 'cloud_recordings'] },
  { prefix: '/camera-setup',                any: ['camera_setup'] },
  { prefix: '/health',                      any: ['camera_health'] },
  { prefix: '/alerts',                      any: ['alerts'] },
  { prefix: '/event-logs',                  any: ['event_log'] },
  { prefix: '/watchlist',                   any: ['face_watchlist'], ai: true },
  // The ai-analytics Face Watchlist workspace runs on faceWatchlistMockData and
  // is reached only from the Weapon / Number-plate demo pages — the real one
  // is /watchlist. It opens with those demos, never for face_watchlist alone.
  { prefix: '/ai-analytics/watchlist',      any: ['weapon', 'fire', 'aggression', 'anpr'], ai: true },
  // Sales showcase (demo videos) and the GPU cost calculator: not customer pages.
  { prefix: '/feature-demos',               any: DEMO_KEYS },
  { prefix: '/compute-cost',                any: DEMO_KEYS },
  { prefix: '/face-learning',               any: ['face_detection'], ai: true },
  { prefix: '/attendance-report',           any: ['activity'], ai: true },
  // Zone Headcount here is the Staff-activity module's page (mock counts), not
  // the real People count at /occupancy, so it follows the demo `activity` key.
  { prefix: '/activity-monitoring/headcount', any: ['activity'], ai: true },
  { prefix: '/activity-monitoring',         any: ['activity'], ai: true },
  { prefix: '/ai-analytics/productivity',   any: ['activity'], ai: true },
  { prefix: '/ai-event/personlsearch',      any: ['person_search'], ai: true },
  { prefix: '/ai-event/journeymap',         any: ['journey_map'], ai: true },
  { prefix: '/ai-event/headcount',          any: ['headcount'], ai: true },
  { prefix: '/person-tracker',              any: ['person_tracker'], ai: true },
  { prefix: '/live-tracker',                any: ['person_tracker'], ai: true },
  { prefix: '/occupancy/breaches',          any: ['restricted_zone'], ai: true },
  { prefix: '/occupancy/zone-setup',        any: ['headcount', 'restricted_zone'], ai: true },
  { prefix: '/occupancy',                   any: ['headcount'], ai: true },
  { prefix: '/ai-analytics/weapon',         any: ['weapon'], ai: true },
  { prefix: '/ai-analytics/fire',           any: ['fire'], ai: true },
  { prefix: '/ai-analytics/aggression',     any: ['aggression'], ai: true },
  { prefix: '/ai-analytics/vehicle',        any: ['anpr'], ai: true },
  { prefix: '/ai-feed',                     any: ['ai_feed'], ai: true },
].sort((a, b) => b.prefix.length - a.prefix.length);

/** True when `user` may open `pathname`. Unlisted routes are always allowed. */
export function routeAllowed(pathname, user) {
  const rule = ROUTE_FEATURES.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
  );
  if (!rule) return true;
  const { aiOn, features } = makeEntitlement(user);
  if (rule.ai && !aiOn) return false;
  return rule.any.some((k) => featureOn(features, k));
}
