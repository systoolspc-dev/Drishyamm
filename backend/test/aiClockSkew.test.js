// The AI service's clock, read off the Date header of the /status poll. The
// 2026-10-27 outage was a 38 s drift nobody could see; this is what makes it
// a single log line instead.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../src/config/logger');
const {
  skewFromDateHeader, recordAiClock, getAiClockSkew, _reset,
} = require('../src/services/aiClockSkew');

const T0 = Date.parse('2026-10-27T09:00:00Z');
const header = (offsetSec) => new Date(T0 + offsetSec * 1000).toUTCString();

beforeEach(() => {
  _reset();
  jest.clearAllMocks();
});

describe('skewFromDateHeader', () => {
  test('peer behind is negative, ahead is positive', () => {
    expect(skewFromDateHeader(header(-38), T0, T0)).toBe(-38);
    expect(skewFromDateHeader(header(12), T0, T0)).toBe(12);
  });

  test('measures against the middle of the round trip', () => {
    // Sent 2 s before T0, answered 2 s after: the peer stamped it around T0.
    expect(skewFromDateHeader(header(0), T0 - 2000, T0 + 2000)).toBe(0);
  });

  test('missing or unreadable header gives null', () => {
    expect(skewFromDateHeader(undefined, T0, T0)).toBeNull();
    expect(skewFromDateHeader('not a date', T0, T0)).toBeNull();
  });
});

describe('recordAiClock', () => {
  test('a clock in step logs nothing', () => {
    recordAiClock(header(1), T0, T0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getAiClockSkew()).toMatchObject({ skewSec: 1, outOfStep: false });
  });

  test('warns once on drift, not on every poll', () => {
    recordAiClock(header(-38), T0, T0);
    recordAiClock(header(-38), T0, T0);
    recordAiClock(header(-39), T0, T0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ skewSec: -38, direction: 'AI behind' });
    expect(getAiClockSkew()).toMatchObject({ skewSec: -39, outOfStep: true });
  });

  test('clears only once well back in step (no flapping at the line)', () => {
    recordAiClock(header(12), T0, T0);
    recordAiClock(header(8), T0, T0); // under 10 but over 5: still out of step
    expect(logger.info).not.toHaveBeenCalled();
    expect(getAiClockSkew().outOfStep).toBe(true);

    recordAiClock(header(0), T0, T0);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(getAiClockSkew().outOfStep).toBe(false);
  });

  test('an unreadable header leaves the last reading alone', () => {
    recordAiClock(header(-38), T0, T0);
    recordAiClock(undefined, T0, T0);
    expect(getAiClockSkew()).toMatchObject({ skewSec: -38, outOfStep: true });
  });
});
