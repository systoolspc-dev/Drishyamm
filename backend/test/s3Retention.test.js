// These date helpers decide what gets DELETED from durable storage, so they are
// tested exhaustively — a false-positive here is lost surveillance evidence.
const { keyDateMs, cutoffMs, isExpiredKey, GRACE_DAYS } = require('../src/services/s3Retention.service')._internals;

const DAY = 24 * 60 * 60 * 1000;
const K = (date) => `recordings/u1/lobby-grp/cam-01/${date}/12-00-00.mp4`;

describe('keyDateMs — strict date extraction (never mis-parse a key)', () => {
  test('extracts a valid date at the right segment', () => {
    expect(keyDateMs(K('2026-07-05'))).toBe(Date.parse('2026-07-05T00:00:00Z'));
  });
  test('returns null for a malformed date', () => {
    expect(keyDateMs(K('2026-7-5'))).toBeNull();
    expect(keyDateMs(K('notadate'))).toBeNull();
  });
  test('returns null for an INVALID calendar date (never coerced)', () => {
    expect(keyDateMs(K('2026-13-40'))).toBeNull();
    expect(keyDateMs(K('2026-02-30'))).toBeNull();
  });
  test('returns null for keys outside the recordings namespace / wrong shape', () => {
    expect(keyDateMs('other/u1/g/c/2026-07-05/f.mp4')).toBeNull();
    expect(keyDateMs('recordings/u1/g/c')).toBeNull();          // too short
    expect(keyDateMs('')).toBeNull();
    expect(keyDateMs(null)).toBeNull();
  });
});

describe('isExpiredKey — only strictly-older, parseable keys are eligible', () => {
  const now = Date.parse('2026-07-05T12:00:00Z');
  const retention = 30;
  const cutoff = cutoffMs(retention, now); // now - (30 + grace) days

  test('a recording well past retention is expired', () => {
    expect(isExpiredKey(K('2026-01-01'), cutoff)).toBe(true);
  });
  test('a recent recording (within retention) is NOT expired', () => {
    expect(isExpiredKey(K('2026-07-01'), cutoff)).toBe(false);
    expect(isExpiredKey(K('2026-07-05'), cutoff)).toBe(false);
  });
  test('the grace margin keeps a recording that just crossed retention', () => {
    // exactly `retention` days ago — inside the grace window, so kept
    const justOver = new Date(now - retention * DAY).toISOString().slice(0, 10);
    expect(isExpiredKey(K(justOver), cutoff)).toBe(false);
  });
  test('an unparseable key is NEVER expired (fails safe → never deleted)', () => {
    expect(isExpiredKey(K('2026-13-99'), cutoff)).toBe(false);
    expect(isExpiredKey('recordings/u1/g/c', cutoff)).toBe(false);
  });
});

describe('cutoffMs — retention + grace', () => {
  test('is retention+grace days before now', () => {
    const now = 1_000_000 * DAY;
    expect(cutoffMs(30, now)).toBe(now - (30 + GRACE_DAYS) * DAY);
  });
});
