// A relay whose NVR keeps the session open but stops sending video must be
// restarted. ffmpeg's socket timeout never fires in that case, so before the
// watchdog such a tile stayed frozen on its cached GOP until a page reload
// (seen 2026-11-09: 3 of 18 Monitor Wall tiles, every load).

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/transcoder.service', () => ({
  paceNvrOpen: jest.fn(async () => {}), OPEN_PRIORITY: { main: 0, view: 1, warm: 2 }, isRunning: () => false,
}));

process.env.RELAY_STALL_MS = '10000';
process.env.RELAY_NO_INIT_MS = '20000';
const { _internals: { sweepStalled, relays } } = require('../src/services/liveRelay.service');

const NOW = 1_000_000;
function fakeRelay(path, fields) {
  const relay = {
    path, stopped: false, once: false, killReason: null, viewers: new Set(),
    proc: { kill: jest.fn() }, startedAt: NOW - 60_000, init: Buffer.from('init'), lastFrameAt: NOW - 500,
    ...fields,
  };
  relays.set(path, relay);
  return relay;
}

afterEach(() => relays.clear());

test('a connected relay with no video for longer than RELAY_STALL_MS is killed so it restarts', () => {
  const r = fakeRelay('cam_stalled_sub', { lastFrameAt: NOW - 11_000 });
  sweepStalled(NOW);
  expect(r.proc.kill).toHaveBeenCalledWith('SIGKILL');
  expect(r.killReason).toMatch(/no video for 11 s/);
});

test('a relay receiving frames is left alone', () => {
  const r = fakeRelay('cam_ok_sub', { lastFrameAt: NOW - 2_000 });
  sweepStalled(NOW);
  expect(r.proc.kill).not.toHaveBeenCalled();
});

test('a fresh restart is measured from its own start, not the old last frame', () => {
  // Restarted 3 s ago after a stall: the last frame is from before the stall.
  const r = fakeRelay('cam_restarted_sub', { startedAt: NOW - 3_000, lastFrameAt: NOW - 40_000 });
  sweepStalled(NOW);
  expect(r.proc.kill).not.toHaveBeenCalled();
});

test('no init segment within RELAY_NO_INIT_MS of starting is treated as hung', () => {
  const early = fakeRelay('cam_probing_sub', { init: null, startedAt: NOW - 5_000 });
  const hung = fakeRelay('cam_hung_sub', { init: null, startedAt: NOW - 21_000 });
  sweepStalled(NOW);
  expect(early.proc.kill).not.toHaveBeenCalled();
  expect(hung.proc.kill).toHaveBeenCalledTimes(1);
});

test('not running, stopped, one-shot replays and already-killed relays are skipped', () => {
  const old = NOW - 60_000;
  const waiting = fakeRelay('cam_paced_sub', { proc: null, lastFrameAt: old }); // waiting on NVR pacing
  const stopped = fakeRelay('cam_stopped_sub', { stopped: true, lastFrameAt: old });
  const replay = fakeRelay('cam_replay', { once: true, lastFrameAt: old });
  const killed = fakeRelay('cam_killed_sub', { killReason: 'already', lastFrameAt: old });
  sweepStalled(NOW);
  for (const r of [stopped, replay, killed]) expect(r.proc.kill).not.toHaveBeenCalled();
  expect(waiting.proc).toBeNull();
});
