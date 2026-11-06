const {
  cameraQuality, spaceQuality, isUsable, canBreach, canClear, STALE_AFTER_SEC,
} = require('../src/services/occupancy/quality');

describe('occupancy quality — a dead camera is not an empty room', () => {
  const fresh = { heads: 3, connected: true, reliable: true, ageSec: 1 };

  test('a fresh verified count is measured and usable', () => {
    expect(cameraQuality(fresh)).toBe('measured');
    expect(isUsable('measured')).toBe(true);
  });

  test('ZERO from a live camera is a real measurement (empty room)', () => {
    // The whole point: 0 must stay 0 when we could actually see.
    expect(cameraQuality({ ...fresh, heads: 0 })).toBe('measured');
  });

  test('a disconnected camera is unknown — never a zero', () => {
    expect(cameraQuality({ ...fresh, connected: false })).toBe('unknown');
    expect(cameraQuality({ heads: 0, connected: false })).toBe('unknown');
  });

  test('the service saying count_reliable=false makes it unknown', () => {
    expect(cameraQuality({ ...fresh, reliable: false })).toBe('unknown');
  });

  test('a count older than the staleness budget is stale, not measured', () => {
    expect(cameraQuality({ ...fresh, ageSec: STALE_AFTER_SEC + 1 })).toBe('stale');
    expect(isUsable('stale')).toBe(false);
  });

  test('missing number is unknown', () => {
    expect(cameraQuality({ connected: true, reliable: true })).toBe('unknown');
  });
});

describe('space quality — fusing several cameras', () => {
  test('all overlap groups measured → measured', () => {
    expect(spaceQuality({ groupsTotal: 2, groupsMeasured: 2 })).toBe('measured');
  });

  test('some groups blind → partial (the count is a lower bound)', () => {
    expect(spaceQuality({ groupsTotal: 3, groupsMeasured: 1 })).toBe('partial');
  });

  test('nothing fresh but older readings exist → stale', () => {
    expect(spaceQuality({ groupsTotal: 2, groupsMeasured: 0, anyStale: true })).toBe('stale');
  });

  test('no usable camera at all → unknown', () => {
    expect(spaceQuality({ groupsTotal: 2, groupsMeasured: 0 })).toBe('unknown');
    expect(spaceQuality({ groupsTotal: 0 })).toBe('unknown');
  });
});

describe('alert permissions are asymmetric — fail loud, not silent', () => {
  test('a lower bound MAY raise a breach (a floor >= N is proof)', () => {
    expect(canBreach('partial')).toBe(true);
  });

  test('but a lower bound may NEVER clear one', () => {
    expect(canClear('partial')).toBe(false);
  });

  test('stale/unknown can neither raise nor clear', () => {
    for (const q of ['stale', 'unknown']) {
      expect(canBreach(q)).toBe(false);
      expect(canClear(q)).toBe(false);
    }
  });

  test('only a measured count can clear a breach', () => {
    expect(canClear('measured')).toBe(true);
  });
});
