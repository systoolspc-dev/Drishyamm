// Pure helpers of the admin Accounts list / hub.
jest.mock('../src/models', () => ({}));
jest.mock('../src/controllers/cameraHealth.controller', () => ({}));
jest.mock('../src/services/entitlements.service', () => ({}));
jest.mock('../src/services/cameraQuota.service', () => ({}));

const { eventFeature, licenceMismatches } = require('../src/controllers/adminAccounts.controller');

test('event types map to the feature that produced them', () => {
  expect(eventFeature('person.unknown')).toBe('face');
  expect(eventFeature('occupancy.threshold')).toBe('headcount');
  expect(eventFeature('zone.intrusion')).toBe('restricted_zone');
  expect(eventFeature('weapon.detected')).toBe('weapon');
  expect(eventFeature('something.else')).toBe(null);
});

describe('licence record vs enforced limits', () => {
  const sub = { status: 'active', plan: { aiEnabled: true }, features: null, featureLimits: {} };
  const rec = (over = {}) => ({
    status: 'active',
    resources: [{ sku: 'cam_hd', quota: 10 }, { sku: 'storage_gb', quota: 500 }],
    features: [{ featureKey: 'feat_face_rec', enabled: true, configJson: { cameras: 4 } }],
    ...over,
  });

  test('no record → nothing to compare', () => {
    expect(licenceMismatches(null, sub, 10)).toEqual([]);
  });

  test('camera count and face cameras that differ are both reported', () => {
    const out = licenceMismatches(rec(), sub, 64);
    expect(out.map((m) => m.key)).toEqual(['cameras', 'face']);
    expect(out[0]).toMatchObject({ record: '10', enforced: '64' });
    // no separate face limit → bounded by the camera licence
    expect(out[1]).toMatchObject({ record: '4', enforced: '64' });
  });

  test('matching numbers → no mismatch', () => {
    const s = { ...sub, featureLimits: { face: 4 } };
    expect(licenceMismatches(rec(), s, 10)).toEqual([]);
  });

  test('an expired record against a live subscription is a mismatch', () => {
    const s = { ...sub, featureLimits: { face: 4 } };
    expect(licenceMismatches(rec({ status: 'expired' }), s, 10).map((m) => m.key)).toEqual(['status']);
  });
});
