const { createOccupancyTracker } = require('../src/services/occupancyHysteresis');

describe('occupancyHysteresis — count-threshold anti-flap (framework M1+M2)', () => {
  test('M1: needs confirmPolls consecutive samples >= threshold before breach', () => {
    const t = createOccupancyTracker({ confirmPolls: 3, clearMargin: 5 });
    expect(t.update('z', 50, 50)).toBeNull();      // 1
    expect(t.update('z', 51, 50)).toBeNull();      // 2
    expect(t.update('z', 50, 50)).toBe('breach');  // 3rd consecutive → breach
    expect(t.isBreached('z')).toBe(true);
  });

  test('M1: a single spike does not breach (a dip resets the streak)', () => {
    const t = createOccupancyTracker({ confirmPolls: 3 });
    expect(t.update('z', 60, 50)).toBeNull();  // 1
    expect(t.update('z', 10, 50)).toBeNull();  // dip resets the counter
    expect(t.update('z', 60, 50)).toBeNull();  // 1 again
    expect(t.update('z', 60, 50)).toBeNull();  // 2
    expect(t.isBreached('z')).toBe(false);
  });

  test('M2 deadband: hovering 48↔51 around cap 50 does NOT flap', () => {
    const t = createOccupancyTracker({ confirmPolls: 1, clearMargin: 5 }); // clears at 45
    expect(t.update('z', 51, 50)).toBe('breach');
    for (const c of [48, 51, 49, 50, 48, 51]) {
      expect(t.update('z', c, 50)).toBeNull(); // never <=45 → no clear, no new breach
    }
    expect(t.isBreached('z')).toBe(true);
  });

  test('clears only at threshold − margin, then can breach again', () => {
    const t = createOccupancyTracker({ confirmPolls: 1, clearMargin: 5 });
    expect(t.update('z', 55, 50)).toBe('breach');
    expect(t.update('z', 46, 50)).toBeNull();   // still inside the deadband (>45)
    expect(t.update('z', 45, 50)).toBe('clear'); // <=45 → clear
    expect(t.update('z', 55, 50)).toBe('breach'); // re-arms after clearing
  });

  test('threshold <= 0 disables tracking (returns null, no state kept)', () => {
    const t = createOccupancyTracker();
    expect(t.update('z', 100, 0)).toBeNull();
    expect(t.isBreached('z')).toBe(false);
    expect(t._state.has('z')).toBe(false);
  });

  test('per-key isolation + reset', () => {
    const t = createOccupancyTracker({ confirmPolls: 1 });
    expect(t.update('a', 60, 50)).toBe('breach');
    expect(t.update('b', 10, 50)).toBeNull();
    expect(t.isBreached('a')).toBe(true);
    expect(t.isBreached('b')).toBe(false);
    t.reset('a');
    expect(t.isBreached('a')).toBe(false);
  });
});
