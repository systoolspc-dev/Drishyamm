const {
  ALL_FEATURE_KEYS, AI_FEATURE_KEYS, DEFAULT_ON_KEYS, DEMO_KEYS,
  isFeatureOn, featureStateOf, storedFeatures,
} = require('../src/utils/featureCatalog');
const { allowsAny } = require('../src/services/entitlements.service');

// Sharda's production list, exactly as stored (written before the 2026-10
// Video / Alerts / Team keys existed). `footfall` is not a catalog key.
const SHARDA = ['person_tracker', 'person_search', 'restricted_zone', 'ai_feed',
  'face_watchlist', 'headcount', 'footfall', 'reports'];

const ent = (features, aiEnabled = true) => ({ features, aiEnabled });

describe('feature catalog shape', () => {
  test('every group keeps id/label/ai/items and every item a key + label', () => {
    const { FEATURE_GROUPS } = require('../src/utils/featureCatalog');
    for (const g of FEATURE_GROUPS) {
      expect(typeof g.id).toBe('string');
      expect(typeof g.label).toBe('string');
      expect(typeof g.ai).toBe('boolean');
      for (const i of g.items) {
        expect(typeof i.key).toBe('string');
        expect(typeof i.label).toBe('string');
      }
    }
    expect(new Set(ALL_FEATURE_KEYS).size).toBe(ALL_FEATURE_KEYS.length);
  });

  test('defaultOn keys are never AI keys, and map/reports stay ordinary', () => {
    expect(DEFAULT_ON_KEYS.filter((k) => AI_FEATURE_KEYS.includes(k))).toEqual([]);
    expect(DEFAULT_ON_KEYS).not.toContain('map');
    expect(DEFAULT_ON_KEYS).not.toContain('reports');
    expect(DEFAULT_ON_KEYS).toEqual(expect.arrayContaining(['monitor_wall', 'playback', 'camera_setup', 'alerts', 'event_log']));
  });
});

describe('isFeatureOn / allowsAny', () => {
  test('a full account (NULL or []) has every key except the demo ones', () => {
    for (const k of ALL_FEATURE_KEYS.filter((x) => !DEMO_KEYS.includes(x))) {
      expect(isFeatureOn(null, k)).toBe(true);
      expect(isFeatureOn([], k)).toBe(true);
      expect(allowsAny(ent(null), [k])).toBe(true);
    }
  });

  test("Sharda's list keeps Live/Recordings/Alerts and means what it meant before", () => {
    for (const k of DEFAULT_ON_KEYS) expect(allowsAny(ent(SHARDA), [k])).toBe(true);
    // listed AI keys + reports: on
    for (const k of ['person_tracker', 'person_search', 'restricted_zone', 'ai_feed', 'face_watchlist', 'headcount', 'reports']) {
      expect(allowsAny(ent(SHARDA), [k])).toBe(true);
    }
    // not listed: off, exactly as before (map, weapon, anpr, activity, face learning …)
    for (const k of ['map', 'weapon', 'fire', 'aggression', 'anpr', 'activity', 'face_detection', 'journey_map']) {
      expect(allowsAny(ent(SHARDA), [k])).toBe(false);
    }
  });

  test('"!key" switches a defaultOn key off; a bare missing key does not', () => {
    expect(isFeatureOn(['reports'], 'playback')).toBe(true);
    expect(isFeatureOn(['reports', '!playback'], 'playback')).toBe(false);
    expect(isFeatureOn(['reports', '!playback'], 'monitor_wall')).toBe(true);
    // "!" on an ordinary key means nothing: it is off because it is not listed
    expect(isFeatureOn(['!reports'], 'reports')).toBe(false);
  });

  test('legacy ["_none"] = every ordinary key off, basic video still on', () => {
    expect(allowsAny(ent(['_none']), ['reports'])).toBe(false);
    expect(allowsAny(ent(['_none']), ['face_watchlist'])).toBe(false);
    expect(allowsAny(ent(['_none']), ['playback'])).toBe(true);
  });

  test('AI keys still need the AI tier; basic keys do not', () => {
    expect(allowsAny(ent(null, false), ['face_watchlist'])).toBe(false);
    expect(allowsAny(ent(null, false), ['playback'])).toBe(true);
    expect(allowsAny(ent(null, false), ['playback', 'restricted_zone'])).toBe(true);
  });
});

describe('featureStateOf / storedFeatures round trip', () => {
  test("Sharda's list reads with every defaultOn key on and footfall kept", () => {
    const st = featureStateOf(SHARDA);
    expect(st.mode).toBe('custom');
    expect(st.enabled).toEqual(expect.arrayContaining(DEFAULT_ON_KEYS));
    expect(st.enabled).not.toContain('map');
    expect(st.unknown).toEqual(['footfall']);
  });

  test('saving Sharda unchanged keeps every switch where it was', () => {
    const st = featureStateOf(SHARDA);
    const stored = storedFeatures(st.enabled, st.unknown);
    for (const k of ALL_FEATURE_KEYS) expect(isFeatureOn(stored, k)).toBe(isFeatureOn(SHARDA, k));
    expect(stored).toContain('footfall');
  });

  test('switching Recordings off stores "!playback"; on again removes it', () => {
    const st = featureStateOf(SHARDA);
    const off = storedFeatures(st.enabled.filter((k) => k !== 'playback'), st.unknown);
    expect(off).toContain('!playback');
    expect(isFeatureOn(off, 'playback')).toBe(false);
    const st2 = featureStateOf(off);
    expect(st2.enabled).not.toContain('playback');
    expect(st2.unknown).toEqual(['footfall']); // the marker is not an "unknown" key
    const on = storedFeatures([...st2.enabled, 'playback'], st2.unknown);
    expect(on).not.toContain('!playback');
    expect(isFeatureOn(on, 'playback')).toBe(true);
  });

  test('everything on → NULL; everything off → nothing matches', () => {
    expect(storedFeatures(ALL_FEATURE_KEYS.filter((k) => !DEMO_KEYS.includes(k)))).toBeNull();
    const none = storedFeatures([]);
    for (const k of ALL_FEATURE_KEYS) expect(isFeatureOn(none, k)).toBe(false);
    // only basic video on, every AI key and map/reports off
    const basic = storedFeatures([...DEFAULT_ON_KEYS]);
    expect(basic).toEqual(['_none']);
    for (const k of DEFAULT_ON_KEYS) expect(isFeatureOn(basic, k)).toBe(true);
    expect(isFeatureOn(basic, 'reports')).toBe(false);
  });
});

describe('demo keys (sample-data pages): on only when listed', () => {
  test('the demo set is exactly the sample-data pages, all AI, none defaultOn', () => {
    expect([...DEMO_KEYS].sort()).toEqual(['activity', 'aggression', 'anpr', 'fire', 'weapon']);
    for (const k of DEMO_KEYS) {
      expect(AI_FEATURE_KEYS).toContain(k);
      expect(DEFAULT_ON_KEYS).not.toContain(k);
    }
  });

  test('a full account (NULL / []) does NOT get demo keys', () => {
    for (const k of DEMO_KEYS) {
      expect(isFeatureOn(null, k)).toBe(false);
      expect(isFeatureOn([], k)).toBe(false);
      expect(allowsAny(ent(null), [k])).toBe(false);
    }
    // ...but still every real AI key and the basic video keys
    expect(allowsAny(ent(null), ['face_watchlist', 'headcount', 'ai_feed', 'playback'])).toBe(true);
  });

  test('listing a demo key switches it on (needs the AI tier too)', () => {
    expect(isFeatureOn(['weapon'], 'weapon')).toBe(true);
    expect(isFeatureOn(['weapon'], 'fire')).toBe(false);
    expect(allowsAny(ent(['anpr']), ['anpr'])).toBe(true);
    expect(allowsAny(ent(['anpr'], false), ['anpr'])).toBe(false);
  });

  test("Sharda's list keeps every demo key off", () => {
    for (const k of DEMO_KEYS) expect(allowsAny(ent(SHARDA), [k])).toBe(false);
  });

  test('admin view of a full account shows demo switches off', () => {
    const st = featureStateOf(null);
    expect(st.mode).toBe('all');
    for (const k of DEMO_KEYS) expect(st.enabled).not.toContain(k);
    expect(st.enabled).toEqual(expect.arrayContaining(['face_watchlist', 'headcount', 'playback']));
  });

  test('a demo key switched on is stored as an explicit list, never NULL', () => {
    const stored = storedFeatures([...ALL_FEATURE_KEYS.filter((k) => !DEMO_KEYS.includes(k)), 'weapon']);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toContain('weapon');
    for (const k of ALL_FEATURE_KEYS) {
      expect(isFeatureOn(stored, k)).toBe(!DEMO_KEYS.includes(k) || k === 'weapon');
    }
    const all = storedFeatures([...ALL_FEATURE_KEYS]);
    for (const k of ALL_FEATURE_KEYS) expect(isFeatureOn(all, k)).toBe(true);
  });
});
