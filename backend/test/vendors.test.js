const v = require('../src/services/vendors');

describe('vendor RTSP path building (camera onboarding)', () => {
  test('Hikvision main/sub follow the Channels/N01→N02 convention', () => {
    expect(v.buildRtspPath('hikvision', 1)).toBe('/Streaming/Channels/101');
    expect(v.buildSubPath('hikvision', 1)).toBe('/Streaming/Channels/102');
    expect(v.buildRtspPath('hikvision', 3)).toBe('/Streaming/Channels/301');
  });

  test('Dahua main/sub follow the subtype=0/1 convention', () => {
    expect(v.buildRtspPath('dahua', 2)).toBe('/cam/realmonitor?channel=2&subtype=0');
    expect(v.buildSubPath('dahua', 2)).toBe('/cam/realmonitor?channel=2&subtype=1');
  });

  test('vendor aliases canonicalize (hik → hikvision)', () => {
    expect(v.canonicalId('hik')).toBe('hikvision');
    expect(v.isSupported('dahua')).toBe(true);
  });

  test('an unknown vendor THROWS (no silent Hikvision fallback → no confidently-wrong URLs)', () => {
    let err;
    try { v.getDriver('totally-unknown-brand'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('unsupported-vendor');
  });
});

describe('deriveSubPath (derive the sub-stream from a main RTSP path)', () => {
  test('Hikvision Channels/…1 → …2', () => {
    expect(v.deriveSubPath('/Streaming/Channels/101')).toBe('/Streaming/Channels/102');
  });
  test('Dahua subtype=0 → subtype=1', () => {
    expect(v.deriveSubPath('/cam/realmonitor?channel=1&subtype=0')).toBe('/cam/realmonitor?channel=1&subtype=1');
  });
  test('Uniview s0 → s1', () => {
    expect(v.deriveSubPath('/unicast/c1/s0/live')).toBe('/unicast/c1/s1/live');
  });
  test('Bosch inst=1 → inst=2', () => {
    expect(v.deriveSubPath('rtsp://h/?inst=1')).toBe('rtsp://h/?inst=2');
  });
  test('null / unrecognized paths return null (no bogus sub-path)', () => {
    expect(v.deriveSubPath(null)).toBeNull();
    expect(v.deriveSubPath('/some/random/path')).toBeNull();
  });
});
