// A transcoder we stopped ON PURPOSE must stay stopped; one that genuinely
// crashed must still come back.
//
// These two cases are only distinguishable by INTENT, and the exit handler used
// to infer intent from `signal === 'SIGTERM'`. That never works: FFmpeg installs
// its own SIGTERM handler so it can flush its outputs, then exits of its own
// accord with **code 255 and signal null**. Node reports an ordinary exit, so
// the "we meant this" branch was unreachable dead code and every deliberate
// stop — above all the 60s idle shutdown — was misread as a crash and respawned
// ~3s later. Cameras nobody was watching looped forever at ~78s a cycle, each
// holding an encoder slot and re-opening an NVR RTSP session round the clock.
//
// So these tests drive the REAL exit handler with the REAL exit signature
// (255/null) that production FFmpeg produces. Asserting on the signal instead
// would have passed happily against the broken code.

const mockSpawned = [];
jest.mock('node:child_process', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = jest.fn(() => { proc.killed = true; return true; });
    mockSpawned.push(proc);
    return proc;
  }),
}));

// Every path is ready, so nothing gates the spawn. Paths report ONE reader by
// default: that keeps the background idle-shutdown sweep out of these tests, so
// each one exercises only the exit path it is actually about.
jest.mock('../src/services/drishyamStreaming.service', () => ({
  api: { get: jest.fn(async () => ({ data: { ready: true, readers: [{ type: 'hlsSession' }] } })) },
}));

jest.mock('../src/config/logger', () => ({
  warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Run inline rather than through BullMQ.
jest.mock('../src/queues', () => ({
  isEnabled: () => false,
  QUEUE_NAMES: { TRANSCODE: 'transcode' },
  getQueue: jest.fn(),
  getQueueEvents: jest.fn(),
}));

const { spawn } = require('node:child_process');
const transcoder = require('../src/services/transcoder.service');

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// FFmpeg's real exit after it handles SIGTERM itself: a code, and NO signal.
const FFMPEG_SIGTERM_EXIT = [255, null];

// Let any restart fire. The backoff is RESTART_DELAY_MS * (restarts + 1), so a
// single 3s window is not enough once the counter has moved — step well past it,
// flushing between steps so each awaited restart can actually complete.
const afterRestartWindow = async () => {
  for (let i = 0; i < 6; i++) {
    jest.advanceTimersByTime(5_000);
    await flush();
  }
};

describe('transcoder lifecycle: deliberate stop vs genuine crash', () => {
  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    mockSpawned.length = 0;
    spawn.mockClear();
  });

  afterEach(() => {
    transcoder.stopAll();
    jest.useRealTimers();
  });

  /** Start one transcoder and return its fake ffmpeg process. */
  async function start(monitorId) {
    const res = await transcoder.ensureSubTranscoder(monitorId);
    expect(res.spawned).toBe(true);
    await flush();
    return mockSpawned[mockSpawned.length - 1];
  }

  test('a deliberate stop does NOT respawn, even though ffmpeg exits 255/null', async () => {
    const proc = await start('cam-deliberate-1');
    expect(spawn).toHaveBeenCalledTimes(1);

    // Deliberate stop. Production sends SIGTERM here (idle shutdown does the
    // same thing through the same helper).
    expect(transcoder.stopTranscoder('cam-deliberate-1')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // ...and ffmpeg exits the way it really does: its own code, no signal.
    proc.exitCode = 255;
    proc.emit('exit', ...FFMPEG_SIGTERM_EXIT);
    await afterRestartWindow();

    // THE REGRESSION: pre-fix this was 2 — the stop was read as a crash.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(transcoder.hasTranscoder('cam-deliberate-1')).toBe(false);
  });

  test('a deliberate stop stays stopped across several restart windows', async () => {
    const proc = await start('cam-deliberate-2');

    transcoder.stopTranscoder('cam-deliberate-2');
    proc.exitCode = 255;
    proc.emit('exit', ...FFMPEG_SIGTERM_EXIT);

    // The production symptom was a ~78s cycle that never ended, so check well
    // past a single backoff window.
    for (let i = 0; i < 5; i++) await afterRestartWindow();

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('stopAll does not respawn anything', async () => {
    const a = await start('cam-all-1');
    const b = await start('cam-all-2');
    expect(spawn).toHaveBeenCalledTimes(2);

    transcoder.stopAll();
    for (const p of [a, b]) {
      p.exitCode = 255;
      p.emit('exit', ...FFMPEG_SIGTERM_EXIT);
    }
    await afterRestartWindow();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('a genuine crash DOES still respawn — the fix must not disable recovery', async () => {
    const proc = await start('cam-crash-1');
    expect(spawn).toHaveBeenCalledTimes(1);

    // Nobody asked for this: ffmpeg died on its own.
    proc.exitCode = 1;
    proc.emit('exit', 1, null);
    await afterRestartWindow();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('a crash after a long healthy run also respawns (lost source, not a fault)', async () => {
    const proc = await start('cam-crash-2');

    // A run that cleared HEALTHY_RUN_MS: the source went away, which on a
    // shared NVR is routine. It must come back.
    jest.advanceTimersByTime(90_000);
    proc.exitCode = 255;
    proc.emit('exit', 255, null);
    await afterRestartWindow();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('a SIGTERM that lands before ffmpeg installs its handler is still no-restart', async () => {
    const proc = await start('cam-raw-sigterm');

    // Node reports the signal itself in this (rarer) case.
    transcoder.stopTranscoder('cam-raw-sigterm');
    proc.exitCode = null;
    proc.emit('exit', null, 'SIGTERM');
    await afterRestartWindow();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
