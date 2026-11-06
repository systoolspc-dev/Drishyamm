const { fuseSpace } = require('../src/services/occupancy/fuse');

const live = (heads) => ({ heads, connected: true, reliable: true, ageSec: 1 });
const dead = () => ({ heads: 0, connected: false, reliable: false, ageSec: 999 });
const cam = (monitorId, overlapGroup = null, weight = 1) => ({ monitorId, overlapGroup, weight });

describe('fuseSpace — the three worked cases from the design doc', () => {
  test('cafeteria: two cameras on the SAME hall → MAX, never sum', () => {
    const r = fuseSpace([cam('A', 'hall'), cam('B', 'hall')], { A: live(12), B: live(14) });
    expect(r.count).toBe(14);          // naive sum would say 26 — double-counted
    expect(r.quality).toBe('measured');
  });

  test('auditorium: cameras on disjoint halves → SUM', () => {
    const r = fuseSpace([cam('C'), cam('D')], { C: live(30), D: live(25) });
    expect(r.count).toBe(55);
  });

  test('lobby: two on the door (same people) + one on seating → max + sum', () => {
    const r = fuseSpace(
      [cam('E', 'door'), cam('F', 'door'), cam('G')],
      { E: live(8), F: live(9), G: live(4) },
    );
    expect(r.count).toBe(13);          // max(8,9) + 4
  });
});

describe('fuseSpace — reliability propagates (a blind corner is not an empty one)', () => {
  test('every group fresh → measured, 100% coverage', () => {
    const r = fuseSpace([cam('A'), cam('B')], { A: live(3), B: live(2) });
    expect(r).toMatchObject({ count: 5, quality: 'measured', coveragePct: 100 });
  });

  test('one of two groups blind → partial LOWER BOUND, not a smaller truth', () => {
    const r = fuseSpace([cam('A'), cam('B')], { A: live(6), B: dead() });
    expect(r.count).toBe(6);           // we know there are AT LEAST 6
    expect(r.quality).toBe('partial');
    expect(r.coveragePct).toBe(50);
  });

  test('ALL cameras dead → count is NULL, never 0', () => {
    const r = fuseSpace([cam('A'), cam('B')], { A: dead(), B: dead() });
    expect(r.count).toBeNull();        // the whole point of the feature
    expect(r.quality).toBe('unknown');
  });

  test('no samples at all → unknown, not zero', () => {
    const r = fuseSpace([cam('A')], {});
    expect(r.count).toBeNull();
    expect(r.quality).toBe('unknown');
  });

  test('everything stale → NULL (an old reading is not a current count)', () => {
    const stale = { heads: 5, connected: true, reliable: true, ageSec: 9999 };
    const r = fuseSpace([cam('A')], { A: stale });
    expect(r.count).toBeNull();
    expect(r.quality).toBe('stale');
  });

  test('an empty room really is 0 when we can see it', () => {
    const r = fuseSpace([cam('A'), cam('B')], { A: live(0), B: live(0) });
    expect(r.count).toBe(0);
    expect(r.quality).toBe('measured');
  });

  test('a degraded (noisy) camera is flagged but still counts', () => {
    const r = fuseSpace([cam('A')], { A: { ...live(4), degraded: true } });
    expect(r).toMatchObject({ count: 4, degraded: true });
  });
});

describe('fuseSpace — weights and edges', () => {
  test('weight corrects partial coverage', () => {
    // camera sees ~60% of the room → weight 1.6
    const r = fuseSpace([cam('A', null, 1.6)], { A: live(10) });
    expect(r.count).toBe(16);
  });

  test('within a group the WEIGHTED max wins', () => {
    const r = fuseSpace([cam('A', 'hall', 1), cam('B', 'hall', 2)], { A: live(9), B: live(5) });
    expect(r.count).toBe(10);          // max(9*1, 5*2)
  });

  test('disabled members are ignored', () => {
    const r = fuseSpace(
      [cam('A'), { ...cam('B'), enabled: false }],
      { A: live(3), B: live(99) },
    );
    expect(r.count).toBe(3);
  });

  test('a space with no cameras is unknown, not zero', () => {
    expect(fuseSpace([], {})).toMatchObject({ count: null, quality: 'unknown' });
  });
});
