const v = require('../src/validators/cameraGroup.validation');

describe('createGroup schema', () => {
  test('accepts a minimal valid body and applies defaults', () => {
    const { error, value } = v.createGroup.validate({ name: 'NVR-1', host: '10.0.0.5', totalChannels: 4 });
    expect(error).toBeUndefined();
    expect(value.port).toBe(554);
    expect(value.httpPort).toBe(80);
    expect(value.deviceType).toBe('hikvision');
  });

  test('rejects a missing name/host', () => {
    expect(v.createGroup.validate({ host: '10.0.0.5' }).error).toBeDefined();
    expect(v.createGroup.validate({ name: 'x' }).error).toBeDefined();
  });

  test('rejects an out-of-range port', () => {
    expect(v.createGroup.validate({ name: 'x', host: 'h', port: 70000 }).error).toBeDefined();
  });

  test('preserves the free-form channels override', () => {
    const { value } = v.createGroup.validate({ name: 'x', host: 'h', channels: { 1: 'Lobby' } });
    expect(value.channels).toEqual({ 1: 'Lobby' });
  });
});

describe('bulk mutation schemas', () => {
  test('require a non-empty monitorIds array', () => {
    expect(v.bulkRetention.validate({ monitorIds: [] }).error).toBeDefined();
    expect(v.bulkQuality.validate({}).error).toBeDefined();
  });

  test('accept valid bulk bodies and pass value fields through', () => {
    expect(v.bulkRetention.validate({ monitorIds: ['a', 'b'], retentionDays: 30 }).error).toBeUndefined();
    expect(v.bulkQuality.validate({ monitorIds: ['a'], streamQuality: 'sub' }).error).toBeUndefined();
    // null retention (inherit) is passed through, not rejected
    expect(v.bulkRetention.validate({ monitorIds: ['a'], retentionDays: null }).error).toBeUndefined();
  });
});
