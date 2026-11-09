/**
 * transcoder.service.js — on-demand H.265 → H.264 transcoder.
 *
 * THE PROBLEM
 * -----------
 * Many IP cameras publish H.265 (HEVC) over RTSP. Stream Service happily
 * remuxes that into HLS, but **Chrome cannot decode H.265 in HLS**
 * via Media Source Extensions. So we transcode to H.264 server-side
 * and serve a `_h264` Stream Service path that the browser can play.
 *
 * ROBUSTNESS
 * ----------
 *   • Encoder auto-detection — picks h264_nvenc, h264_qsv, or h264_amf
 *     when available (5-10× lower CPU than libx264). Falls back cleanly.
 *   • No source-readiness gate — FFmpeg is the on-demand source's reader, so
 *     spawning it is what makes Stream Service start the NVR pull. Waiting for
 *     the source to be ready first deadlocked fire-and-forget callers (see
 *     ensurePathTranscoder). A source that never comes up makes FFmpeg exit;
 *     the restart backoff + MAX_RESTARTS bound that.
 *   • Stall detection — kills + restarts FFmpeg if no frame counter
 *     update for STALL_TIMEOUT_MS (sometimes ffmpeg "lives" but doesn't
 *     produce output after a source glitch).
 *   • Idle shutdown — kills FFmpeg after IDLE_TIMEOUT_MS with no readers
 *     on the `_h264` Stream Service path. Spawns again on next viewer.
 *   • Concurrency limit — capped at MAX_CONCURRENT to prevent CPU
 *     thrashing when many H.265 cameras are opened at once.
 *   • Auto-restart with backoff — quick crashes restart with linear
 *     backoff, MAX_RESTARTS attempts, then we stop trying.
 *
 * SPEED
 * -----
 *   • ultrafast + zerolatency preset (~30% faster encode start)
 *   • -fflags +nobuffer + -flags low_delay (skip initial buffering)
 *   • Small GOP (25) for faster first keyframe
 *   • No B-frames (no reorder delay)
 *   • Audio dropped (G.711 isn't HLS-compatible anyway)
 *
 *   Cold start: ~1.5-2s (was ~3s). Steady state: ~5-10% of one CPU
 *   core per 1080p H.265 stream with libx264, <1% with h264_nvenc.
 */

const { spawn } = require('node:child_process');
const config    = require('../config/env');
const logger    = require('../config/logger');
const queues    = require('../queues');

// ── State ────────────────────────────────────────────────────────────────────
// monitorId → { proc, startedAt, restartCount, sourceUrl, targetUrl,
//               lastFrameAt, idleSince }
const _processes = new Map();
// processKey → epoch ms until which idle shutdown is suspended. Set by the
// warm-keeper (streamWarm.service) while a user of the camera is logged in, so
// a tile opened later finds its stream already running (~0.3 s to first frame
// instead of a cold NVR pull + ffmpeg start).
const _pinnedUntil = new Map();

const TRANSCODED_SUFFIX = '_h264';
const SUB_TRANSCODED_SUFFIX = '_sub_h264';
const LOW_TRANSCODED_SUFFIX = '_low_h264';

// Auto-restart parameters. Linear backoff so a permanently-broken source
// doesn't turn into an FFmpeg fork-bomb.
const MIN_UPTIME_MS    = 5_000;
const RESTART_DELAY_MS = 3_000;
const MAX_RESTARTS     = 5;
// A run that lasted this long was NOT a crash-loop: ffmpeg started, encoded
// happily, and then lost its SOURCE. On a shared NVR that is routine, not a
// fault — see HEALTHY_RUN_MS use in the exit handler.
const HEALTHY_RUN_MS   = parseInt(process.env.TRANSCODER_HEALTHY_RUN_MS, 10) || 30_000;

// Robustness budgets
const STALL_TIMEOUT_MS  = parseInt(process.env.TRANSCODER_STALL_MS, 10)  || 30_000;
const IDLE_TIMEOUT_MS   = parseInt(process.env.TRANSCODER_IDLE_MS, 10)   || 60_000;
const HEALTH_CHECK_MS   = parseInt(process.env.TRANSCODER_CHECK_MS, 10)  || 15_000;
const MAX_CONCURRENT    = parseInt(process.env.TRANSCODER_MAX, 10)       || 8;

// ── Per-NVR connection pacing ────────────────────────────────────────────────
// Every transcoder whose source is not already flowing makes Stream Service
// open a NEW RTSP session to the customer's NVR. Opened in a burst (a wall page
// of 9 tiles + the warm-keeper, or every camera restarting at once after a
// drop), the customer's network blocks port 554 for 20–60 s: measured
// 2026-10-20 — 8 opens in 0.1 s at 05:10:13 → unreachable at 05:10:18; 14 opens
// in 1 s at 05:16:36 → unreachable at 05:16:57. Every session then drops, all
// restart together, and the next burst re-arms the block: tiles sat on
// "Connecting" for minutes. So new sessions on one NVR are spaced
// NVR_OPEN_GAP_MS apart, and none are opened while the NVR is unreachable.
// 300 ms = ~3 opens/s per NVR. The blocks above came from 8 in 0.1 s and 14 in
// 1 s; the warm-keeper's 0.3 s stagger never tripped one.
const NVR_OPEN_GAP_MS     = parseInt(process.env.NVR_OPEN_GAP_MS, 10) || 300;
const NVR_DOWN_WAIT_MS    = parseInt(process.env.NVR_DOWN_WAIT_MS, 10) || 60_000;
const _nvrHostOf    = new Map(); // monitorId → NVR host
const _nvrQueues    = new Map(); // host → { waiting: [], lastAt, timer }
const _opening      = new Map(); // processKey → in-flight ensure promise
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _nvrSeq = 0;

// Open priorities: what someone is looking at goes first.
const OPEN_PRIORITY = { main: 0, view: 1, warm: 2 };

async function nvrHostOf(monitorId) {
  if (_nvrHostOf.has(monitorId)) return _nvrHostOf.get(monitorId);
  try {
    const { Camera } = require('../models');
    const cam = await Camera.findOne({ where: { monitorId }, attributes: ['host'] });
    const host = cam?.host || null;
    _nvrHostOf.set(monitorId, host);
    return host;
  } catch (_) {
    return null;
  }
}

function serveNvrQueue(host) {
  const q = _nvrQueues.get(host);
  if (!q || q.timer || !q.waiting.length) return;
  const wait = Math.max(0, q.lastAt + NVR_OPEN_GAP_MS - Date.now());
  q.timer = setTimeout(() => {
    q.timer = null;
    q.waiting.sort((x, y) => x.prio - y.prio || x.seq - y.seq);
    const next = q.waiting.shift();
    if (next) { q.lastAt = Date.now(); next.resolve(); }
    serveNvrQueue(host);
  }, wait);
}

/**
 * Wait for this camera's turn to open a new NVR session: one per
 * NVR_OPEN_GAP_MS per NVR, highest priority first (OPEN_PRIORITY: a
 * fullscreen main, then tiles on screen, then warm-keeper/prefetch).
 * `ticket` (optional object) receives `bump(prio)` so a queued background
 * open can be promoted when a viewer arrives for it.
 */
async function paceNvrOpen(monitorId, { urgent = false, priority, ticket } = {}) {
  const host = await nvrHostOf(monitorId);
  if (!host) return;
  const reach = require('./cameraReachability.service');
  const giveUpAt = Date.now() + NVR_DOWN_WAIT_MS;
  while (reach.isReachable(host) === false && Date.now() < giveUpAt) await sleep(2000);

  let q = _nvrQueues.get(host);
  if (!q) { q = { waiting: [], lastAt: 0, timer: null }; _nvrQueues.set(host, q); }
  const prio = urgent ? OPEN_PRIORITY.main : (priority ?? OPEN_PRIORITY.view);
  await new Promise((resolve) => {
    const w = { prio, seq: _nvrSeq++, resolve };
    if (ticket) ticket.bump = (p) => { if (p < w.prio) w.prio = p; };
    q.waiting.push(w);
    serveNvrQueue(host);
  });
}
const ALLOW_HW_ENCODERS = process.env.TRANSCODER_ALLOW_HW === 'true';

// ── Encoder auto-detection ───────────────────────────────────────────────────
// Cached at first call. Returns the best encoder this machine supports,
// in this priority: NVIDIA → Intel QSV → AMD → libx264 (CPU fallback).
//
// We probe `ffmpeg -encoders`. That tells us the encoder is BUILT IN, but
// not whether the actual hardware is present and the driver loads. So we
// keep libx264 as a runtime fallback if the hardware encoder fails on the
// very first transcoder spawn — see ensureTranscoder.

let _encoderProbeDone = false;
let _encoderName      = 'libx264';
let _encoderArgs      = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];

// Use the most universally-compatible args for each hardware encoder.
// Newer NVENC/QSV/AMF have richer options (-tune ll, -rc cbr, p1-p7 presets,
// -low_power, -usage lowlatency) but those break on older drivers/hardware
// with "-22 Invalid argument". The args below work on every generation we
// care about; we trade ~5% quality for not crashing.
// NOTE: GOP/keyframe interval is NOT set here — it is owned centrally by
// buildFfmpegArgs (profileArgs come after these args, so a -g there wins).
// Standardized to ~1s there to keep parts keyframe-aligned with mediamtx.
const HW_ENCODERS = [
  ['h264_nvenc', ['-c:v', 'h264_nvenc', '-preset', 'fast',     '-bf', '0']],
  ['h264_qsv',   ['-c:v', 'h264_qsv',   '-preset', 'veryfast', '-bf', '0']],
  ['h264_amf',   ['-c:v', 'h264_amf',   '-quality', 'speed',   '-bf', '0']],
];

// Runtime-failure tracking. If an encoder crashes within RUNTIME_FAILURE_WINDOW_MS
// of starting, we count it. After RUNTIME_FAILURE_THRESHOLD strikes the encoder
// is permanently demoted for the rest of the process — typically straight to
// libx264.
const RUNTIME_FAILURE_WINDOW_MS  = 10_000;
const RUNTIME_FAILURE_THRESHOLD  = 2;
let _encoderFailureCount = 0;
let _demotedEncoders     = new Set();   // 'h264_nvenc', 'h264_qsv', etc.

async function detectEncoder({ force = false } = {}) {
  if (_encoderProbeDone && !force) return { name: _encoderName, args: _encoderArgs };

  if (!ALLOW_HW_ENCODERS) {
    _encoderName = 'libx264';
    _encoderArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
    _encoderFailureCount = 0;
    logger.info('transcoder: using software encoder libx264');
    _encoderProbeDone = true;
    return { name: _encoderName, args: _encoderArgs };
  }

  const list = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    p.stdout.on('data', (c) => { buf += c.toString(); });
    p.on('error', () => resolve(''));
    p.on('exit',  () => resolve(buf));
  });

  // Skip any hardware encoder that's been demoted at runtime (driver issues etc.)
  for (const [name, args] of HW_ENCODERS) {
    if (_demotedEncoders.has(name)) continue;
    if (list.includes(name)) {
      _encoderName = name;
      _encoderArgs = args;
      _encoderFailureCount = 0;
      logger.info('transcoder: hardware encoder selected', { name });
      _encoderProbeDone = true;
      return { name, args };
    }
  }

  _encoderName = 'libx264';
  _encoderArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  _encoderFailureCount = 0;
  logger.info('transcoder: using software encoder libx264');
  _encoderProbeDone = true;
  return { name: _encoderName, args: _encoderArgs };
}

/**
 * Demote the current encoder permanently (for this process lifetime) and
 * pick the next-best one. Called from the FFmpeg exit handler when the
 * encoder keeps crashing within RUNTIME_FAILURE_WINDOW_MS.
 */
async function demoteEncoder() {
  const failed = _encoderName;
  if (failed === 'libx264') return false;   // can't demote further
  _demotedEncoders.add(failed);
  logger.warn('transcoder: encoder demoted after repeated runtime failures', {
    failed, demoted: [..._demotedEncoders],
  });
  await detectEncoder({ force: true });
  return true;
}

// ── FFmpeg arg builder ───────────────────────────────────────────────────────

// Input probing. Stream Service hands FFmpeg an SDP that already carries the
// codec parameters, so FFmpeg does not need its default ~5 s / 5 MB probe
// before it starts decoding; 0.5 s is enough to find the first frames.
const PROBE_ARGS = [
  '-probesize',       process.env.TRANSCODER_PROBESIZE || '500000',
  '-analyzeduration', process.env.TRANSCODER_ANALYZE_US || '500000',
];

function buildFfmpegArgs(sourceUrl, targetUrl, encoderArgs, { lowProfile = false } = {}) {
  // GOP / keyframe interval — single source of truth for ALL encoders (these
  // args come after ...encoderArgs, so they override any -g a HW encoder set).
  // Standardized to ~1 second so it matches the 1s LL-HLS part duration in
  // mediamtx.yml: every part then begins on a keyframe and is an independent
  // start/resync point (instant zap + clean post-stall recovery). Frame counts
  // assume the system-standard fps (main ~25, low 12); at other source fps the
  // GOP lands close to 1s, which is fine for surveillance. Cost: ~10-15% more
  // bitrate than a 2s GOP — the deliberate trade for snappy, smooth playback.
  // The 360p grid stream is tiny: libx264 ultrafast encodes it with plenty of
  // headroom and gets the first frame out sooner than veryfast.
  const fastestSw = lowProfile && encoderArgs.includes('libx264') ? ['-preset', 'ultrafast'] : [];
  const profileArgs = lowProfile
    ? [
        ...fastestSw,
        '-vf', 'scale=-2:360,fps=12',
        '-b:v', '450k',
        '-maxrate', '550k',
        '-bufsize', '900k',
        // 0.5 s GOP @ 12 fps (was 12 = 1 s, before that 24 = 2 s). A new
        // viewer's first frame waits for the next keyframe, so this halves the
        // worst case of every tile start; at 360p the extra I-frames cost little.
        '-g', '6',
        '-keyint_min', '6',
      ]
    : [
        // Cap at 1080p: some NVR channels are 3200x1800, which costs ~3x the
        // encode of 1080p for no visible gain in a browser tile/fullscreen.
        '-vf', "scale=-2:'min(1080,ih)'",
        '-g', '25',          // ~1s GOP @ 25fps (was effectively 50 = 2s)
        '-keyint_min', '25',
      ];

  return [
    // ── Input ──
    '-rtsp_transport', 'tcp',
    // No +nobuffer: it drops the packets read during probing, i.e. the
    // source's first keyframe, so ffmpeg waited a whole camera GOP (3.3 s)
    // before its first frame (see liveRelay.service.js).
    '-fflags',         '+genpts+discardcorrupt',
    '-flags',          'low_delay',
    '-avoid_negative_ts', 'make_zero',
    ...PROBE_ARGS,
    '-i',              sourceUrl,
    // Map the video explicitly. Auto-mapping skips a stream whose size the
    // short probe did not see yet (H.265 before its first keyframe:
    // "Video: hevc, none") and ffmpeg then quits with "Output file #0 does not
    // contain any stream" — 10 of ~90 restarts on 2026-10-20. Mapped, the
    // filters are configured from the first decoded frame instead.
    '-map',            '0:v:0',

    // ── Video transcode ──
    ...encoderArgs,
    '-pix_fmt',  'yuv420p',
    '-profile:v', 'main',
    ...profileArgs,
    '-sc_threshold', '0',     // no scene-cut keyframes (predictable GOP)

    // ── Audio: pass the camera's G.711 through (the live relay turns it into
    // AAC for the browser). `?`: a camera without audio just has none.
    '-map',      '0:a:0?',
    '-c:a',      'copy',

    // ── Output ──
    '-f',                'rtsp',
    '-rtsp_transport',   'tcp',
    '-muxdelay',         '0.1',
    targetUrl,
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function transcodedPathName(monitorId) {
  return `cam_${monitorId}${TRANSCODED_SUFFIX}`;
}

function transcodedSubPathName(monitorId) {
  return `cam_${monitorId}${SUB_TRANSCODED_SUFFIX}`;
}

function transcodedLowPathName(monitorId) {
  return `cam_${monitorId}${LOW_TRANSCODED_SUFFIX}`;
}

function isTranscodedPath(pathName) {
  return pathName?.endsWith(TRANSCODED_SUFFIX) ||
    pathName?.endsWith(SUB_TRANSCODED_SUFFIX) ||
    pathName?.endsWith(LOW_TRANSCODED_SUFFIX);
}

function processKey(monitorId, variant = 'main') {
  if (variant === 'sub') return `${monitorId}:sub`;
  if (variant === 'low') return `${monitorId}:low`;
  return `${monitorId}:main`;
}

function activeCount() {
  let n = 0;
  for (const e of _processes.values()) {
    if (e.proc && !e.proc.killed && e.proc.exitCode == null) n++;
  }
  return n;
}

/**
 * Probe Stream Service once for a path's `ready` flag. We can't `require()` the
 * mediamtx service at the top of this file (would create a circular import),
 * so we lazy-resolve.
 */
async function isSourcePathReady(sourcePath) {
  const streamingService = require('./drishyamStreaming.service');
  try {
    const r = await streamingService.api.get(`/v3/paths/get/${sourcePath}`, {
      timeout: 1500,
    });
    return r.data?.ready === true;
  } catch (_) {
    return false;
  }
}

async function transcodedPathReaders(targetPath) {
  const streamingService = require('./drishyamStreaming.service');
  try {
    const r = await streamingService.api.get(
      `/v3/paths/get/${targetPath}`,
      { timeout: 1500 },
    );
    return (r.data?.readers || r.data?.readers2 || []).length;
  } catch (_) {
    return 0;
  }
}

// ── Spawn ────────────────────────────────────────────────────────────────────

/**
 * Ensure a transcoder is running for this monitorId. Idempotent.
 *
 * Returns:
 *   { spawned, reason }
 *     spawned: true  → newly spawned
 *     spawned: false → either already running or rejected (see reason)
 *
 * Reasons we may reject:
 *   • 'already-running' — current process is alive
 *   • 'capacity' — at MAX_CONCURRENT cap
 */
async function ensurePathTranscoder(monitorId, opts = {}) {
  // Coalesce concurrent requests for the same camera+variant: the spawn now
  // waits for its NVR slot, and a second caller arriving meanwhile must not
  // start a second ffmpeg (and a second NVR session).
  const key = processKey(monitorId, opts.variant || 'main');
  const inflight = _opening.get(key);
  if (inflight) {
    return inflight.then((r) => (r.spawned ? { spawned: false, reason: 'already-running' } : r));
  }
  const p = spawnPathTranscoder(monitorId, opts).finally(() => _opening.delete(key));
  _opening.set(key, p);
  return p;
}

async function spawnPathTranscoder(monitorId, {
  variant = 'main',
  sourcePath = `cam_${monitorId}`,
  targetPath = transcodedPathName(monitorId),
  lowProfile = false,
} = {}) {
  const key = processKey(monitorId, variant);
  const existing = _processes.get(key);
  if (existing && !existing.proc.killed && existing.proc.exitCode == null) {
    // Bump idle timer — caller showed intent to use it
    existing.idleSince = null;
    return { spawned: false, reason: 'already-running' };
  }

  if (activeCount() >= MAX_CONCURRENT) {
    logger.warn('transcoder: at capacity, rejecting spawn', {
      monitorId, active: activeCount(), max: MAX_CONCURRENT,
    });
    return { spawned: false, reason: 'capacity' };
  }

  // Spawn even when the source isn't `ready` yet. The sources are on-demand:
  // FFmpeg's RTSP read is what makes Stream Service open the NVR session, and
  // Stream Service holds that read until the first frames arrive. The old gate
  // returned 'source-not-ready' here, and grid tiles request transcoders
  // fire-and-forget, so nobody retried: the tile 404'd until the player gave up
  // and called /stream/start again (≈2 WHEP 404s and 1.6 start calls per tile
  // in the 2026-10-19 baseline). Logged so a slow source is still visible.
  const sourceReady = await isSourcePathReady(sourcePath);
  // A source that is not flowing yet means a new NVR session: wait our turn.
  if (!sourceReady) await paceNvrOpen(monitorId, { urgent: variant === 'main' });
  else await nvrHostOf(monitorId); // cached; runningOnHost() needs every camera's host

  const { args: encoderArgs } = await detectEncoder();

  const host = config.streamService.rtspHost || 'localhost';
  const port = config.streamService.rtspPort || 8554;
  const sourceUrl = `rtsp://${host}:${port}/${sourcePath}`;
  const targetUrl = `rtsp://${host}:${port}/${targetPath}`;

  let proc;
  try {
    proc = spawn('ffmpeg', buildFfmpegArgs(sourceUrl, targetUrl, encoderArgs, { lowProfile }), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    logger.error('transcoder: failed to spawn ffmpeg', { monitorId, error: err.message });
    return { spawned: false, reason: 'spawn-failed' };
  }

  // Per-process state
  const entry = {
    proc,
    startedAt:    Date.now(),
    sourceUrl,
    targetUrl,
    restartCount: 0,
    lastFrameAt:  Date.now(),  // updated when stderr says "frame="
    idleSince:    null,        // set by health-check loop when readers=0
    stopping:     false,       // WE asked it to stop — see stopDeliberately()
    stderrTail:   '',
    key,
    monitorId,
    variant,
    targetPath,
  };
  _processes.set(key, entry);

  // FFmpeg writes progress to stderr lines like:
  //   "frame=  120 fps= 25 q=23.0 size=     128kB time=00:00:04.80 bitrate=..."
  // We watch for "frame=" updates as a heartbeat for stall detection.
  proc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    entry.stderrTail = (entry.stderrTail + s).slice(-3000);
    if (s.includes('frame=')) {
      entry.lastFrameAt = Date.now();
    }
  });

  proc.on('error', (err) => {
    logger.error('transcoder: ffmpeg process error', { monitorId, variant, error: err.message });
    _processes.delete(key);
  });

  proc.on('exit', (code, signal) => {
    const e = _processes.get(key);
    const uptimeMs = e ? Date.now() - e.startedAt : 0;
    const restarts = e?.restartCount || 0;
    _processes.delete(key);

    // Did WE stop it? Check the recorded intent, not the signal — FFmpeg traps
    // SIGTERM and exits with code 255 / signal null, so `signal === 'SIGTERM'`
    // never matched and every deliberate stop was respawned as a "crash".
    // The signal check is kept only for a SIGTERM that lands before FFmpeg has
    // installed its handler.
    if (e?.stopping || signal === 'SIGTERM') {
      logger.info('transcoder: stopped', {
        monitorId, variant, uptimeMs, restarts, code, signal,
      });
      return;
    }

    if (uptimeMs >= MIN_UPTIME_MS && code === 0) {
      logger.info('transcoder: ffmpeg exited cleanly', { monitorId, uptimeMs });
      return;
    }

    // Skip libx264's end-of-run statistics and progress lines: they fill the
    // last lines and hide the actual reason (input EOF, RTSP error, …).
    const tail = (e?.stderrTail || '').split(/[\r\n]+/)
      .filter((l) => l && !/^\[libx264 @|^frame=|^\s*$/.test(l))
      .slice(-6).join(' | ');
    logger.warn('transcoder: ffmpeg exited unexpectedly', {
      monitorId, variant, code, signal, uptimeMs, restarts, encoder: _encoderName, tail,
    });

    // Encoder runtime-failure tracking: if the active hardware encoder keeps
    // dying very early (driver/version mismatch), demote it for the rest of
    // this process and let the next spawn use the fallback.
    if (uptimeMs < RUNTIME_FAILURE_WINDOW_MS && _encoderName !== 'libx264') {
      _encoderFailureCount += 1;
      if (_encoderFailureCount >= RUNTIME_FAILURE_THRESHOLD) {
        demoteEncoder().catch(() => {});
      }
    }

    // MAX_RESTARTS exists to stop a genuinely broken transcoder (bad codec,
    // missing encoder, unreachable target) from looping forever. It must NOT
    // punish a transcoder that worked.
    //
    // `restartCount` only ever incremented, so a camera on a shared NVR —
    // which drops a source every minute or so — walked up the counter one
    // healthy 75-second run at a time and was then disabled PERMANENTLY, with
    // no way back short of a backend restart. That is how Live View ended up
    // dead for cameras that had been streaming fine minutes earlier.
    //
    // So: a run that cleared HEALTHY_RUN_MS resets the budget. Only real
    // crash-loops — dying fast, over and over — can exhaust it.
    const healthyRun = uptimeMs >= HEALTHY_RUN_MS;
    const nextRestarts = healthyRun ? 0 : restarts + 1;

    if (!healthyRun && restarts >= MAX_RESTARTS) {
      logger.error('transcoder: giving up after repeated crashes',
        { monitorId, variant, restarts, uptimeMs });
      return;
    }
    if (healthyRun && restarts > 0) {
      logger.info('transcoder: healthy run before exit; restart budget reset',
        { monitorId, variant, uptimeMs, wasRestarts: restarts });
    }

    const delay = RESTART_DELAY_MS * (nextRestarts + 1);
    setTimeout(() => {
      // Guard the whole async restart: an unhandled rejection here (e.g.
      // ensurePathTranscoder throwing on a bad path) would otherwise crash
      // the process and take every other transcoder down with it.
      (async () => {
        if (_processes.has(key)) return;
        const next = await ensurePathTranscoder(monitorId, { variant, sourcePath, targetPath, lowProfile });
        const e2 = _processes.get(key);
        if (e2 && next.spawned) e2.restartCount = nextRestarts;
      })().catch((err) => {
        logger.error('transcoder: restart attempt failed', { monitorId, variant, error: err?.message });
      });
    }, delay);
  });

  logger.info('transcoder: spawned', {
    monitorId, variant, encoder: _encoderName, source: sourceUrl, target: targetUrl, sourceReady,
  });
  return { spawned: true, reason: 'ok' };
}

async function ensureTranscoder(monitorId) {
  return ensurePathTranscoder(monitorId);
}

async function ensureSubTranscoder(monitorId) {
  return ensurePathTranscoder(monitorId, {
    variant: 'sub',
    sourcePath: `cam_${monitorId}_sub`,
    targetPath: transcodedSubPathName(monitorId),
    lowProfile: true,
  });
}

async function ensureLowTranscoder(monitorId) {
  return ensurePathTranscoder(monitorId, {
    variant: 'low',
    sourcePath: `cam_${monitorId}`,
    targetPath: transcodedLowPathName(monitorId),
    lowProfile: true,
  });
}

// ── Health check loop ────────────────────────────────────────────────────────
// Every HEALTH_CHECK_MS:
//   • Stall: if lastFrameAt > STALL_TIMEOUT_MS ago → SIGTERM (auto-restart fires)
//   • Idle:  if transcoded path has 0 readers, start an idle timer; SIGTERM
//            after IDLE_TIMEOUT_MS.

let _healthInterval = null;

function startHealthLoop() {
  if (_healthInterval) return;
  _healthInterval = setInterval(runHealthCheck, HEALTH_CHECK_MS);
  // Don't keep Node alive just for this loop
  if (_healthInterval.unref) _healthInterval.unref();
}

async function runHealthCheck() {
  const now = Date.now();

  for (const entry of _processes.values()) {
    if (!entry.proc || entry.proc.killed || entry.proc.exitCode != null) continue;

    // 1. Stall detection — but give FFmpeg MIN_UPTIME_MS to start producing
    if (now - entry.startedAt > MIN_UPTIME_MS &&
        now - entry.lastFrameAt > STALL_TIMEOUT_MS) {
      logger.warn('transcoder: stall detected, killing for restart', {
        monitorId: entry.monitorId,
        variant: entry.variant,
        sinceLastFrameMs: now - entry.lastFrameAt,
      });
      try { entry.proc.kill('SIGKILL'); } catch (_) {}
      // exit handler will trigger auto-restart with backoff
      continue;
    }

    // 2. Idle shutdown — only check after MIN_UPTIME_MS to avoid killing
    //    a transcoder before Stream Service even sees its first publish.
    if (now - entry.startedAt < MIN_UPTIME_MS * 2) continue;

    const pinned = (_pinnedUntil.get(processKey(entry.monitorId, entry.variant)) || 0) > now;
    const readers = pinned ? 1 : await transcodedPathReaders(entry.targetPath);
    if (readers > 0) {
      entry.idleSince = null;
      continue;
    }
    if (entry.idleSince == null) {
      entry.idleSince = now;
      continue;
    }
    if (now - entry.idleSince > IDLE_TIMEOUT_MS) {
      logger.info('transcoder: idle shutdown (no viewers)', {
        monitorId: entry.monitorId,
        variant: entry.variant,
        idleMs: now - entry.idleSince,
      });
      // Mark as a clean stop so the exit handler does not respawn it. This
      // MUST go through stopDeliberately(): FFmpeg traps SIGTERM and exits
      // 255/null, so the signal alone cannot tell the handler we meant it.
      stopDeliberately(entry);
    }
  }
}

// Lazy-start the loop on first ensureTranscoder call. We don't start it in
// module load because workers / shutdown paths import this module too.
const _origEnsure = ensureTranscoder;
async function ensureTranscoderWithHealth(monitorId) {
  startHealthLoop();
  return _origEnsure(monitorId);
}

async function ensureSubTranscoderWithHealth(monitorId) {
  startHealthLoop();
  return ensureSubTranscoder(monitorId);
}

async function ensureLowTranscoderWithHealth(monitorId) {
  startHealthLoop();
  return ensureLowTranscoder(monitorId);
}

// ── Stop / introspection ─────────────────────────────────────────────────────

/**
 * Stop a transcoder *on purpose*, so the exit handler does not restart it.
 *
 * The exit handler used to infer "we meant this" from `signal === 'SIGTERM'`.
 * That never works: FFmpeg installs its own SIGTERM handler so it can flush
 * and close its outputs, then exits of its own accord with **code 255 and
 * signal null**. Node therefore reports a normal exit, the SIGTERM branch was
 * unreachable dead code, and every deliberate stop — above all the idle
 * shutdown — was misread as a crash and respawned ~3s later. Cameras nobody
 * was watching looped forever, each holding an encoder slot and an NVR RTSP
 * session, and re-opening that session every ~78s round the clock.
 *
 * Intent is ours to record, not the signal's to imply. Flag it here; the exit
 * handler checks the flag first.
 */
function stopDeliberately(entry) {
  if (!entry || !entry.proc) return false;
  entry.stopping = true;
  try {
    entry.proc.kill('SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

function stopTranscoder(monitorId) {
  let stopped = false;
  for (const variant of ['main', 'sub', 'low']) {
    const entry = _processes.get(processKey(monitorId, variant));
    if (!entry) continue;
    if (stopDeliberately(entry)) stopped = true;
  }
  return stopped;
}

/** Stop one variant on purpose (no auto-restart) and drop its pin. */
function stopVariant(monitorId, variant) {
  const key = processKey(monitorId, variant);
  _pinnedUntil.delete(key);
  const entry = _processes.get(key);
  return entry ? stopDeliberately(entry) : false;
}

/** Running transcoders on one NVR host, from the host cache paceNvrOpen fills. */
function runningOnHost(host) {
  const out = [];
  for (const e of _processes.values()) {
    if (!e.proc || e.proc.killed || e.proc.exitCode != null || e.stopping) continue;
    if (_nvrHostOf.get(e.monitorId) === host) out.push({ monitorId: e.monitorId, variant: e.variant, targetPath: e.targetPath });
  }
  return out;
}

/** Keep a transcoder alive with no viewers until `untilMs` (see _pinnedUntil). */
function pinTranscoder(monitorId, variant, untilMs) {
  _pinnedUntil.set(processKey(monitorId, variant), untilMs);
}

/** Running transcoders vs MAX_CONCURRENT, so callers can leave room for viewers. */
function capacity() {
  return { active: activeCount(), max: MAX_CONCURRENT };
}

function isRunning(monitorId, variant = 'main') {
  const entry = _processes.get(processKey(monitorId, variant));
  return !!(entry && entry.proc && !entry.proc.killed && entry.proc.exitCode == null && !entry.stopping);
}

function hasTranscoder(monitorId) {
  const entry = _processes.get(processKey(monitorId));
  return !!(entry && !entry.proc.killed && entry.proc.exitCode == null);
}

function stopAll() {
  for (const entry of _processes.values()) {
    stopDeliberately(entry);
  }
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

function listActive() {
  const now = Date.now();
  const out = [];
  for (const entry of _processes.values()) {
    const alive = !entry.proc.killed && entry.proc.exitCode == null;
    out.push({
      monitorId: entry.monitorId,
      variant: entry.variant,
      alive,
      uptimeSec:        Math.round((now - entry.startedAt) / 1000),
      lastFrameAgoSec:  Math.round((now - entry.lastFrameAt) / 1000),
      restartCount:     entry.restartCount || 0,
      encoder:          _encoderName,
    });
  }
  return out;
}

process.on('SIGTERM', stopAll);
process.on('SIGINT',  stopAll);

// ── Producer: queue-backed entry point (A1) ───────────────────────────────────
// Single front door for "make sure a transcoder exists for this camera". When
// BullMQ is active it enqueues a deduped job (one per cam+variant) onto the
// TRANSCODE queue; the worker runs the same ensure* function. When Redis is
// down it runs inline — identical to the legacy behavior. Either way the
// return shape is {spawned,reason} so existing callers are unchanged.
//
//   variant : 'main' | 'sub' | 'low'
//   wait    : true  → await the job result and return {spawned,reason}
//             false → fire-and-forget, return {queued:true}
//   priority: BullMQ priority (lower = sooner). Live-view should pass 1;
//             background pre-warm should pass a higher number.
const ENSURE_BY_VARIANT = {
  main: ensureTranscoderWithHealth,
  sub:  ensureSubTranscoderWithHealth,
  low:  ensureLowTranscoderWithHealth,
};
const QUEUE_WAIT_MS = parseInt(process.env.TRANSCODER_QUEUE_WAIT_MS, 10) || 10_000;

async function requestTranscode(monitorId, { variant = 'main', wait = false, priority = 10 } = {}) {
  const fn = ENSURE_BY_VARIANT[variant] || ensureTranscoderWithHealth;

  if (queues.isEnabled()) {
    try {
      const q = queues.getQueue(queues.QUEUE_NAMES.TRANSCODE);
      const job = await q.add(
        'ensure',
        { monitorId, variant },
        {
          // One in-flight job per camera+variant — coalesces duplicate viewer
          // requests into a single ffmpeg spawn instead of a thundering herd.
          jobId: `transcode:${monitorId}:${variant}`,
          priority,
          removeOnComplete: true,
          removeOnFail: { age: 3600, count: 200 },
        },
      );

      if (!wait) return { queued: true };

      const events = queues.getQueueEvents(queues.QUEUE_NAMES.TRANSCODE);
      const res = await job.waitUntilFinished(events, QUEUE_WAIT_MS);
      return res || { spawned: false, reason: 'queued' };
    } catch (err) {
      // Any queue/await failure → run inline. ensure* is idempotent (it checks
      // for an existing process), so even if the queued job ALSO runs later it
      // is a no-op. We never lose or double-start a transcoder.
      logger.warn('transcoder: queue path failed, running inline', {
        monitorId, variant, error: err.message,
      });
    }
  }

  return fn(monitorId);
}

module.exports = {
  ensureTranscoder: ensureTranscoderWithHealth,
  ensureSubTranscoder: ensureSubTranscoderWithHealth,
  ensureLowTranscoder: ensureLowTranscoderWithHealth,
  requestTranscode,
  stopTranscoder,
  stopVariant,
  runningOnHost,
  nvrHostOf,
  paceNvrOpen,
  OPEN_PRIORITY,
  pinTranscoder,
  capacity,
  isRunning,
  hasTranscoder,
  stopAll,
  listActive,
  transcodedPathName,
  transcodedSubPathName,
  transcodedLowPathName,
  isTranscodedPath,
  // exposed for testing / status panels
  _internals: { detectEncoder, MAX_CONCURRENT, STALL_TIMEOUT_MS, IDLE_TIMEOUT_MS },
};
