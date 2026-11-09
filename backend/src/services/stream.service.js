/**
 * stream.service.js — Stream Service v2.0
 *
 * Live streaming is handled entirely by Stream Service.
 * This service is a thin orchestration layer that:
 *   1. Ensures the camera path exists in Stream Service (re-adds if lost after MTX restart)
 *   2. Returns the WebRTC URL (primary, sub-500ms) and HLS URL (fallback, 2s)
 *
 * The browser uses WebRTC for single-camera live view and HLS for multi-grid.
 */

const axios            = require('axios');
const logger           = require('../config/logger');
const streamingService  = require('./drishyamStreaming.service');
const transcoderService = require('./transcoder.service');
const config           = require('../config/env');

const LOW_TRANSCODE_MAX_ACTIVE = parseInt(process.env.GRID_LOW_TRANSCODE_MAX || '2', 10);
const LOW_TRANSCODE_COOLDOWN_MS = parseInt(process.env.GRID_LOW_TRANSCODE_COOLDOWN_MS || '15000', 10);
const _lowWarmupInFlight = new Set();
const _lowWarmupLastAt = new Map();
// Single-camera view: how long /stream/start waits for the MAIN channel
// (NVR pull + ffmpeg's first 1080p keyframe) before serving the sub instead.
const MAIN_OPEN_BUDGET_MS = parseInt(process.env.MAIN_OPEN_BUDGET_MS || '12000', 10);

/**
 * Warm up the HLS muxer for a path. Two-phase strategy:
 *
 *   Phase 1 — wait for the Stream Service path to be `ready: true`.
 *     A path that's not ready has no incoming RTSP frames; HLS will
 *     ALWAYS return 404 in that state. Polling HLS during this window
 *     is wasted work and gives us misleading 404s in the logs.
 *
 *   Phase 2 — once ready, poll the HLS playlist until it returns 200.
 *     The muxer takes another 1-3 seconds to build the first segment
 *     after the path becomes ready. Fetching the URL also TRIGGERS
 *     Stream Service to start the muxer (it's lazy), so this serves a dual
 *     purpose.
 *
 * If the path never becomes ready (camera offline, RTSP unreachable),
 * we return false after totalBudgetMs and let the frontend show the
 * "Camera unavailable" state. No more pointless 404 storms.
 */
async function warmupHlsPath(pathName, {
  maxAttempts   = 12,
  delayMs       = 500,
  readyBudgetMs = 6000,
  triggerBeforeReady = false,
} = {}) {
  const hlsUrl = `${config.streamService.internalHlsUrl}/${pathName}/index.m3u8`;
  const triggerHlsMuxer = () => {
    axios.get(hlsUrl, { timeout: 3500, validateStatus: () => true }).catch(() => {});
  };

  // Phase 1: wait for path readiness
  const readyDeadline = Date.now() + readyBudgetMs;
  let isReady = false;
  let nextTriggerAt = 0;
  while (Date.now() < readyDeadline) {
    // On-demand paths only connect to their RTSP source after a reader asks
    // for HLS. Probe before readiness, otherwise sub-stream warmup deadlocks.
    if (triggerBeforeReady && Date.now() >= nextTriggerAt) {
      triggerHlsMuxer();
      nextTriggerAt = Date.now() + 1500;
    }
    try {
      const r = await streamingService.api.get(`/v3/paths/get/${pathName}`, { timeout: 1000 });
      if (r.data?.ready === true) {
        isReady = true;
        break;
      }
    } catch (_) { /* ignore — keep polling */ }
    await new Promise((res) => setTimeout(res, 400));
  }
  if (!isReady) return false;

  // Phase 2: poll HLS — this also triggers the muxer to start producing
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await axios.get(hlsUrl, { timeout: 1000, validateStatus: () => true });
      if (r.status >= 200 && r.status < 300) return true;
    } catch (_) { /* ignore — try again */ }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}

/** Convenience: warm the main path for a camera. */
async function warmupHls(monitorId, options = {}) {
  return warmupHlsPath(streamingService.pathName(monitorId), options);
}

/**
 * Detect the source video codec for a camera by inspecting Stream Service.
 * Returns 'H264', 'H265', or null if unknown / not ready yet.
 */
async function detectPathCodec(pathName) {
  try {
    const info = await streamingService.api
      .get(`/v3/paths/get/${pathName}`, { timeout: 1500 })
      .then((r) => r.data);
    const tracks = info?.tracks2 || info?.tracks || [];
    const video  = tracks.find((t) => t.codec === 'H264' || t.codec === 'H265');
    return video?.codec ?? null;
  } catch (_) {
    return null;
  }
}

// monitorId → last codec we actually observed ('H264' | 'H265').
//
// A camera's codec is a static property of its encoder, but `detectPathCodec`
// can only read it while the path is live. These paths are on-demand, so a
// probe during warm-up legitimately returns null — and null used to be treated
// as "not H.265", which silently disabled transcoding and handed the player a
// dead URL. Remembering the answer makes the routing decision stable instead of
// dependent on whether the NVR happened to be quick that second.
const codecMemo = new Map();

async function detectSourceCodec(monitorId) {
  const codec = await detectPathCodec(streamingService.pathName(monitorId));
  if (codec) codecMemo.set(monitorId, codec);
  return codec;
}

async function isPathReady(pathName) {
  try {
    const info = await streamingService.api
      .get(`/v3/paths/get/${pathName}`, { timeout: 800 })
      .then((r) => r.data);
    return info?.ready === true;
  } catch (_) {
    return false;
  }
}

async function warmLowTranscodedHls(monitorId) {
  const { spawned, reason } = await transcoderService.requestTranscode(monitorId, {
    variant: 'low', wait: true, priority: 5,   // background pre-warm — lower priority
  });
  const lowPath = transcoderService.transcodedLowPathName(monitorId);

  if (spawned) await new Promise((r) => setTimeout(r, 1500));
  else if (reason && reason !== 'already-running') {
    logger.warn('[Stream] low transcoder not started', { monitorId, reason });
  }

  const warmed = await warmupHlsPath(lowPath, { maxAttempts: 12, delayMs: 500 });
  return warmed ? `${config.streamService.hlsUrl}/${lowPath}/index.m3u8` : null;
}

function warmLowTranscodedHlsInBackground(monitorId) {
  const now = Date.now();
  if (_lowWarmupInFlight.has(monitorId)) return;
  if (_lowWarmupInFlight.size >= LOW_TRANSCODE_MAX_ACTIVE) {
    logger.info('[Stream] low warmup skipped: queue full', {
      monitorId,
      active: _lowWarmupInFlight.size,
      max: LOW_TRANSCODE_MAX_ACTIVE,
    });
    return;
  }
  if (now - (_lowWarmupLastAt.get(monitorId) || 0) < LOW_TRANSCODE_COOLDOWN_MS) return;

  _lowWarmupInFlight.add(monitorId);
  _lowWarmupLastAt.set(monitorId, now);
  warmLowTranscodedHls(monitorId).catch((err) => {
    logger.warn('[Stream] background low warmup failed', { monitorId, error: err.message });
  }).finally(() => {
    _lowWarmupInFlight.delete(monitorId);
  });
}

class StreamService {
  /**
   * Ensure the camera is registered in Stream Service and return stream URLs.
   * Re-adds the path if Stream Service was restarted and lost its config.
   *
   * @param {object} camera - Camera model instance
   * @returns {{ webrtcUrl, hlsUrl, provider }}
   */
  /**
   * @param {object}  camera
   * @param {object}  opts
   * @param {string}  opts.quality     'auto' | 'main' | 'sub'
   * @param {boolean} opts.clientHevc  Client proved it can decode H.265 itself
   *                                   (MediaSource.isTypeSupported('…hvc1…')).
   *                                   When true we serve H.265 natively instead
   *                                   of burning an encoder on it.
   */
  async startStream(camera, { quality = 'auto', clientHevc = false } = {}) {
    const { monitorId } = camera;

    const camConfig = {
      userId:   camera.userId,   // drives per-account recording (RECORD_USER_IDS)
      host:     camera.host,
      port:     camera.port,
      path:     camera.path,
      username: camera.username,
      password: camera.password,
    };

    // Check if main stream path is already configured (handles MTX restart recovery)
    const existing = await streamingService.getPath(monitorId);
    if (!existing) {
      await streamingService.addCamera(monitorId, camConfig);
    } else if (typeof streamingService.ensureMainCloseAfter === 'function') {
      streamingService.ensureMainCloseAfter(monitorId).catch(() => {});
    }

    // Add sub-stream path (on-demand, no recording) for grid / low-bandwidth view.
    // Derive sub-stream RTSP path from main path (e.g. Hikvision /Channels/101 → /Channels/102).
    const subRtspPath = streamingService.deriveSubPath(camera.path);
    if (subRtspPath) {
      await streamingService.addCameraSubStream(monitorId, { ...camConfig, path: subRtspPath });
    }

    let webrtcUrl   = streamingService.getWebrtcUrl(monitorId);
    const sourceHlsUrl = streamingService.getHlsUrl(monitorId);
    let hlsSubUrl   = null;
    let preferSub   = false;

    // Wake the source HLS muxer first — it gives us a chance to detect the
    // codec from the live track info.
    //
    // NOT for grid tiles: they are served from the sub channel below and never
    // request the main path, so warming it costs ~2.5 s of latency per tile for
    // a stream nobody will play — and opens a main-channel session on an NVR
    // where sessions are the scarce resource.
    if (quality !== 'low') {
      // Bounded on purpose. Both players retry a not-yet-ready source
      // (HLSPlayer 5x at 3 s, streamRegistry re-negotiates WHEP), so holding
      // the HTTP request open buys nothing and costs everything: 8 tiles x a
      // 6 s warmup saturates the browser's 6-connection-per-origin budget and
      // starves every other call on the page.
      await warmupHls(monitorId, { maxAttempts: 4, delayMs: 300, readyBudgetMs: 1500 });
    }

    // Sub-streams are on-demand to avoid doubling camera/NVR load. Prefer the
    // camera/NVR sub-stream for grid tiles because it costs almost no server CPU.
    // If that path is unavailable or browser-incompatible, we fall back to the
    // main HLS URL immediately and warm a capped low transcoder in background.
    let subCodec = null;
    if (subRtspPath && (quality === 'low' || quality === 'auto')) {
      const subPathName = streamingService.subPathName(monitorId);
      const subReady = await warmupHlsPath(subPathName, {
        maxAttempts: quality === 'low' ? 3 : 3,
        delayMs: 300,
        readyBudgetMs: quality === 'low' ? 2200 : 1800,
        triggerBeforeReady: true,
      });
      subCodec = subReady ? await detectPathCodec(subPathName) : null;

      if (subReady && subCodec === 'H264') {
        hlsSubUrl = streamingService.getHlsSubUrl(monitorId);
        // The remote NVR / office uplink can't reliably carry the full-res MAIN
        // stream (RTSP TCP timeouts → HLS 500), but this low-bitrate sub-stream
        // does. Serve the sub as the PRIMARY live view too so single-camera view
        // actually plays. Set PREFER_MAIN_STREAM=1 to go back to the main stream.
        if (process.env.PREFER_MAIN_STREAM !== '1') {
          preferSub = true;
          webrtcUrl = `${config.streamService.webrtcUrl}/${subPathName}`;
        }
      } else if (quality === 'low' && !clientHevc && subCodec !== 'H264') {
        // GRID TILES. A tile must never touch the main channel and must never
        // block: measured in a real browser, letting tiles fall through to the
        // main path cost 5-25 s per request and the dashboard showed
        // "Stream Unavailable" on every card.
        //
        // The sub channel is the right source for a thumbnail anyway (640x360
        // vs 1920x1080, and it needs no main-channel NVR session). We take it
        // even when the sub has not finished warming — `subReady` false here
        // usually just means the on-demand pull needed more than our 2.2 s
        // budget, not that it is broken. HLSPlayer retries a fatal load 5x at
        // 3 s, which covers the warm-up far more cheaply than holding the
        // request open.
        const subH264 = transcoderService.transcodedSubPathName(monitorId);
        transcoderService.requestTranscode(monitorId, {
          variant: 'sub', wait: false, priority: 2,
        }).catch(() => {});
        hlsSubUrl = `${config.streamService.hlsUrl}/${subH264}/index.m3u8`;
        if (process.env.PREFER_MAIN_STREAM !== '1') {
          preferSub = true;
          webrtcUrl = `${config.streamService.webrtcUrl}/${subH264}`;
        }
        logger.info('[Stream] grid tile: transcoded SUB, non-blocking',
          { monitorId, path: subH264, subReady, subCodec: subCodec || 'unknown' });
      } else if (subReady && subCodec === 'H265' && !clientHevc) {
        // The sub channel exists but is H.265, which this client cannot decode.
        // Previously we just left hlsSubUrl unset here and fell through to the
        // block below, which handed the player the raw H.265 sub URL anyway —
        // unplayable — while the MAIN stream got transcoded instead. That is
        // backwards for grid tiles: transcoding the sub costs a fraction of the
        // NVR bandwidth (640x360 vs 1920x1080) and needs no main-channel
        // session at all, which is exactly what is scarce on a shared NVR.
        const subH264 = transcoderService.transcodedSubPathName(monitorId);

        // Grid tiles must NOT block on an encoder warming up. Measured in a real
        // browser, a dashboard of 8 cameras each waiting for its transcoder took
        // 7-25 s per request (one hit 24,960 ms) and two requests failed outright
        // — which is what the operator sees as "Stream Unavailable".
        //
        // HLSPlayer already retries a fatal load 5 times at 3 s intervals, so
        // handing over the URL before the path is published costs the tile a few
        // seconds of "Connecting…" and nothing else. Single-camera view (quality
        // 'auto'/'main') still waits, because there the user is staring at one
        // player and a retry cycle reads as a stall.
        const fastPath = quality === 'low';
        const { spawned, reason } = await transcoderService.requestTranscode(monitorId, {
          variant: 'sub', wait: !fastPath, priority: 2,
        });
        if (!fastPath && reason && reason !== 'already-running' && !spawned) {
          logger.warn('[Stream] sub transcoder not started', { monitorId, reason });
        }

        let ready = fastPath;
        if (!fastPath) {
          if (spawned) await new Promise((r) => setTimeout(r, 1500));
          ready = await warmupHlsPath(subH264, { maxAttempts: 6, delayMs: 400, readyBudgetMs: 3000 });
        }
        if (ready) {
          hlsSubUrl = `${config.streamService.hlsUrl}/${subH264}/index.m3u8`;
          if (process.env.PREFER_MAIN_STREAM !== '1') {
            preferSub = true;
            webrtcUrl = `${config.streamService.webrtcUrl}/${subH264}`;
          }
          logger.info('[Stream] serving transcoded SUB channel',
            { monitorId, path: subH264, blocking: !fastPath });
        }
      }
    }

    // Even if the native sub didn't finish warming synchronously above, hand the
    // player its URL whenever a sub channel exists — the player warms/retries the
    // sub manifest itself and falls back to main only if it truly fails. Without
    // this, an on-demand sub that needs >2s to warm returned hlsSubUrl=null, so a
    // per-camera "Sub" choice (and grid tiles) silently played the MAIN stream.
    // Only hand over the RAW sub URL when the client can actually decode what
    // is on it. For an H.265 sub on a non-HEVC client this used to publish a
    // URL the player could never render (and, because it was non-null, it also
    // suppressed the low-transcoder fallback below).
    //
    // An HEVC-capable client is the opposite case and the cheapest path we
    // have: it takes the camera's native sub channel with no encoder slot, no
    // re-encode generation and no added latency.
    if (!hlsSubUrl && subRtspPath && (quality === 'low' || quality === 'auto')
        && (subCodec !== 'H265' || clientHevc)) {
      hlsSubUrl = streamingService.getHlsSubUrl(monitorId);
      if (subCodec === 'H265') {
        logger.info('[Stream] H.265 sub passthrough (client decodes HEVC natively)', { monitorId });
      }
    }

    // No native sub channel (or it's unusable) → fall back to a low transcoder.
    if (quality === 'low' && !hlsSubUrl) {
      const lowPath = transcoderService.transcodedLowPathName(monitorId);
      if (await isPathReady(lowPath)) {
        hlsSubUrl = `${config.streamService.hlsUrl}/${lowPath}/index.m3u8`;
      } else {
        warmLowTranscodedHlsInBackground(monitorId);
      }
    }

    // ── Codec routing ───────────────────────────────────────────────────────
    // Most IP cameras publish H.265. Historically no browser could decode it via
    // Media Source Extensions, so every H.265 camera was re-encoded to H.264 by
    // a sidecar FFmpeg publishing to a `_h264` path.
    //
    // That is no longer universally true: Chromium has shipped HEVC-over-MSE by
    // default since v105, using the platform's hardware decoder, so a large share
    // of real client machines can play the camera's native stream. Transcoding
    // those is pure waste — it costs an encoder slot (capped by MAX_CONCURRENT,
    // which is a hard ceiling on how many H.265 cameras can be watched at once),
    // adds a re-encode generation of quality loss, and adds latency.
    //
    // So the client tells us what it can actually decode (it probes
    // MediaSource.isTypeSupported for hvc1/hev1) and we only transcode when it
    // genuinely can't. Clients that don't report a capability are treated as
    // incapable, so the old behaviour remains the safe default.
    let hlsUrl = preferSub && hlsSubUrl ? hlsSubUrl : sourceHlsUrl;
    let codec  = null;
    let transcoded = false;
    let mainOpen = null;   // single view: why main was / wasn't served (returned for diagnostics)

    codec = await detectSourceCodec(monitorId);

    // The main path is on-demand, so when the NVR is busy it can still be
    // warming here — `/v3/paths/get` then reports `tracks: []` and
    // detectSourceCodec returns null. null matches NEITHER branch below, so we
    // used to fall straight through with `hlsUrl = sourceHlsUrl`: the raw H.265
    // URL of a path that is not ready. The player got HTTP 500 and rendered
    // "Stream Unavailable — Network Error", while the only cameras that worked
    // were the ones something else (the AI service) happened to be holding open.
    //
    // Unknown is not the same as H.264. Resolve it instead of guessing:
    // the sub channel is the same camera and the same encoder, so its codec
    // answers the same question; failing that, re-probe once now that the
    // sub-warmup above has given the main path more time.
    // Resolve in order of confidence, and never let "unknown" mean "H.264":
    //   1. what this camera reported on any earlier start (codec is static)
    //   2. the sub channel — same camera, same encoder
    //   3. one more probe, now that the sub warm-up above bought time
    //   4. assume H.265, because that is what this fleet is and because
    //      transcoding an H.264 camera merely wastes an encoder slot, whereas
    //      NOT transcoding an H.265 one returns a stream no browser can play.
    if (!codec) {
      const memo = codecMemo.get(monitorId);
      if (memo) {
        codec = memo;
        logger.info('[Stream] main codec unknown; using last observed', { monitorId, codec });
      } else if (subCodec) {
        codec = subCodec;
        logger.info('[Stream] main codec unknown; inferred from sub channel', { monitorId, codec });
      } else {
        await new Promise((r) => setTimeout(r, 600));
        codec = await detectSourceCodec(monitorId);
        if (!codec) {
          codec = 'H265';
          logger.warn('[Stream] main codec undetectable; assuming H265 so the ' +
            'client gets a transcoded, playable path', { monitorId });
        }
      }
    }

    if (!preferSub && codec === 'H265' && clientHevc) {
      // Native passthrough — no encoder, no quality loss, no concurrency cap.
      logger.info('[Stream] H.265 passthrough (client decodes HEVC natively)', { monitorId });
    } else if (!preferSub && codec === 'H265') {
      transcoded = true;

      // Which channel can we actually serve?
      //
      // Ask the SOURCE, not the transcoder queue. `requestTranscode(wait:true)`
      // awaits a BullMQ job with a 10 s ceiling, so asking it this question
      // serialised every camera behind every other one. `isPathReady` answers
      // the only thing that matters — "can the main channel be pulled right
      // now?" — in <=800 ms, and it is the same condition the transcoder uses
      // internally to return `source-not-ready`.
      //
      // On a shared NVR at its session limit, main being unavailable is the
      // NORMAL case once a few cameras are watched. The sub channel needs no
      // main-channel session, so serve that instead of publishing a main
      // `_h264` URL that will never appear (WHEP 404 + HLS 404 = a player stuck
      // on "Connecting…" forever, which is exactly what Live View showed).
      // Single-camera view (blocking) opens the main channel on demand. The main
      // source is on-demand too, so "ready" was only ever true when something
      // else happened to hold it open — in practice never, and every Live View /
      // fullscreen played the 360p sub upscaled (blurry). The main transcoder
      // is the source's reader (no source-ready gate since #3), so spawning it
      // is what makes Stream Service pull main from the NVR. Bounded: if main
      // isn't publishing within MAIN_OPEN_BUDGET_MS (NVR at its session limit,
      // thin uplink), fall back to the sub exactly as before.
      //
      // Judge by the TRANSCODED main path, not the source: a source can go
      // `ready` and then stall (seen 2026-10-19: one channel's main sent 64 KB
      // and stopped), and handing out a `_h264` URL that never publishes is the
      // WHEP-404 / black-player failure again.
      const mainH264 = transcoderService.transcodedPathName(monitorId);
      let mainOk = await isPathReady(mainH264);
      const blocking = quality !== 'low';
      if (!mainOk && blocking) {
        const t0 = Date.now();
        // Free this NVR's uplink from sub-streams nobody is watching first:
        // main can't start while they take the whole link.
        await require('./streamWarm.service').yieldForMain(camera).catch(() => {});
        const { spawned: mainSpawned, reason: mainReason } = await transcoderService.requestTranscode(monitorId, {
          variant: 'main', wait: true, priority: 1,
        });
        if (mainSpawned || mainReason === 'already-running') {
          mainOk = await warmupHlsPath(mainH264, {
            maxAttempts: 8, delayMs: 300, readyBudgetMs: MAIN_OPEN_BUDGET_MS,
          });
        }
        mainOpen = { ok: mainOk, reason: mainReason || null, ms: Date.now() - t0 };
        logger.info('[Stream] main channel opened on demand', { monitorId, ...mainOpen });
      }
      const variant = mainOk ? 'main' : 'sub';
      const targetPath = mainOk
        ? transcoderService.transcodedPathName(monitorId)
        : transcoderService.transcodedSubPathName(monitorId);

      // Single-camera view WAITS for the encoder to exist. Handing back a path
      // before its transcoder has spawned is precisely what made WHEP answer
      // 404. Grid tiles no longer reach this code at all — they poll
      // head-count snapshots — so nobody pays for this wait but the one player
      // the operator is actually looking at. (`blocking` is set above.)
      const { spawned, reason } = await transcoderService.requestTranscode(monitorId, {
        variant, wait: blocking, priority: 1,
      });
      if (blocking) {
        if (spawned) await new Promise((r) => setTimeout(r, 800));
        else if (reason && reason !== 'already-running') {
          logger.warn('[Stream] transcoder not started', { monitorId, variant, reason });
        }
        await warmupHlsPath(targetPath, { maxAttempts: 8, delayMs: 300, readyBudgetMs: 2500 });
      }

      hlsUrl    = `${config.streamService.hlsUrl}/${targetPath}/index.m3u8`;
      webrtcUrl = `${config.streamService.webrtcUrl}/${targetPath}`;
      if (!mainOk) {
        hlsSubUrl = hlsUrl;
        logger.warn('[Stream] main channel not pullable; serving transcoded SUB instead',
          { monitorId, path: targetPath });
      }
    }

    logger.info('[Stream] URLs ready', {
      monitorId, codec, subCodec, transcoded,
      hasSubStream: !!subRtspPath,
    });
    return { webrtcUrl, hlsUrl, hlsSubUrl, provider: 'mediamtx', codec, transcoded, mainOpen };
  }

  /**
   * Remove the camera path from Stream Service (stops stream + recording).
   * Called on camera/group delete — not on normal "stop watching" events
   * because Stream Service should keep recording 24/7 regardless of who is watching.
   */
  /**
   * Live relay path for a camera (see liveRelay.service.js). Only the cheap
   * part of startStream: make sure the Stream Service paths exist — no codec
   * probe, no HLS warm-up, no waiting. Returns the path the relay reads.
   *   variant 'sub'  → cam_<id>_sub (main path when the camera has no sub)
   *   variant 'main' → cam_<id>
   *   transcode      → the H.264 sidecar of that variant (ffmpeg started here,
   *                    non-blocking; the relay retries until it publishes)
   */
  async ensureLivePath(camera, { variant = 'sub', transcode = false } = {}) {
    const { monitorId } = camera;
    const camConfig = {
      userId: camera.userId,     // drives per-account recording (RECORD_USER_IDS)
      host: camera.host, port: camera.port, path: camera.path,
      username: camera.username, password: camera.password,
    };
    this._livePathsAt ||= new Map();
    const fresh = (this._livePathsAt.get(monitorId) || 0) > Date.now() - 60_000;
    const subRtspPath = streamingService.deriveSubPath(camera.path);
    if (!fresh) {
      const existing = await streamingService.getPath(monitorId);
      if (!existing) await streamingService.addCamera(monitorId, camConfig);
      else if (typeof streamingService.ensureMainCloseAfter === 'function') {
        streamingService.ensureMainCloseAfter(monitorId).catch(() => {});
      }
      if (subRtspPath) await streamingService.addCameraSubStream(monitorId, { ...camConfig, path: subRtspPath });
      this._livePathsAt.set(monitorId, Date.now());
    }
    const useSub = variant === 'sub' && !!subRtspPath;
    if (transcode) {
      transcoderService.requestTranscode(monitorId, { variant: useSub ? 'sub' : 'main', priority: useSub ? 5 : 1 })
        .catch((err) => logger.warn('[Stream] live transcode request failed', { monitorId, error: err.message }));
      return useSub ? transcoderService.transcodedSubPathName(monitorId) : transcoderService.transcodedPathName(monitorId);
    }
    return useSub ? `cam_${monitorId}_sub` : `cam_${monitorId}`;
  }

  /**
   * The camera's own RTSP URL for a live-relay variant (credentials included —
   * never log it). The relay pulls it directly when Stream Service isn't
   * already pulling that stream: the NVR opens every session on a keyframe,
   * which a reader attached behind Stream Service misses (then waits a full
   * camera GOP, 3.3 s here).
   */
  liveNvrUrl(camera, variant = 'sub') {
    const sub = variant === 'sub' ? streamingService.deriveSubPath(camera.path) : null;
    return streamingService.buildRtspUrl({
      host: camera.host, port: camera.port, path: sub || camera.path,
      username: camera.username, password: camera.password,
    });
  }

  async stopStream(monitorId) {
    // Kill any transcoder first so it doesn't try to push to a dying path.
    transcoderService.stopTranscoder(monitorId);
    await Promise.all([
      streamingService.removeCamera(monitorId),
      streamingService.removeCameraSubStream(monitorId),
    ]);
    logger.info('[Stream] Paths removed from Stream Service', { monitorId });
  }

  getWebrtcUrl(monitorId) { return streamingService.getWebrtcUrl(monitorId); }
  getHlsUrl(monitorId)    { return streamingService.getHlsUrl(monitorId); }

  isStreamActive(camera) { return camera?.status === 'online'; }

  /**
   * Build an HLS master playlist that lists the main stream and (when
   * actually streaming) the sub-stream as ABR variants. HLS.js will
   * pick a variant based on measured bandwidth — same model as Netflix.
   *
   * Why we check `ready: true` for the sub-stream:
   *   The sub-stream path is `sourceOnDemand: true`, meaning Stream Service
   *   only connects to it when a viewer requests it. If we list a sub
   *   variant in the master and the sub never actually publishes (e.g.
   *   the camera doesn't have a sub-stream at the derived RTSP path),
   *   HLS.js's variant fetch returns an empty/404 response and Chrome
   *   ORB-blocks it (visible as `ERR_BLOCKED_BY_ORB` in Network tab).
   *
   *   So: only include the sub variant after Stream Service confirms it's
   *   actually streaming. Otherwise we ship a single-variant master,
   *   which is still valid HLS and avoids the broken-variant flood.
   *
   * @param {Camera} camera — Sequelize camera instance
   * @returns {Promise<string>} the HLS master playlist body
   */
  async buildMasterPlaylist(camera) {
    const { monitorId } = camera;

    const mainW = camera.width  || 1920;
    const mainH = camera.height || 1080;
    const fps   = camera.fps    || 25;

    // Rough h264 bandwidth estimate: bits-per-pixel ≈ 0.10. This only
    // needs to be in the ballpark for the player's heuristics — it's not
    // the encoder's real rate.
    const estBitrate = (w, h, framerate, bpp = 0.10) =>
      Math.round(w * h * framerate * bpp);

    // Is a sub-stream POSSIBLE (path derivable for this camera type)?
    const subDerivable = !!streamingService.deriveSubPath(camera.path);

    // Is the sub-stream ACTUALLY streaming right now? Best-effort probe.
    // We don't await long here — if Stream Service is slow or the sub never
    // came up, we fall back to single-variant master.
    let subReady = false;
    if (subDerivable) {
      try {
        const subPath = streamingService.subPathName(monitorId);
        const info = await streamingService.api
          .get(`/v3/paths/get/${subPath}`, { timeout: 1500 })
          .then((r) => r.data)
          .catch(() => null);
        subReady = info?.ready === true;
      } catch (_) {
        subReady = false;
      }
    }

    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    // High variant — full resolution
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${estBitrate(mainW, mainH, fps)},` +
      `RESOLUTION=${mainW}x${mainH},FRAME-RATE=${fps},NAME="High"`,
    );
    lines.push(streamingService.getHlsUrl(monitorId));

    // Low variant — only when Stream Service confirms it's currently streaming
    if (subReady) {
      const subW = 640;
      const subH = 480;
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${estBitrate(subW, subH, fps)},` +
        `RESOLUTION=${subW}x${subH},FRAME-RATE=${fps},NAME="Low"`,
      );
      lines.push(streamingService.getHlsSubUrl(monitorId));
    }

    return lines.join('\n') + '\n';
  }
}

module.exports = new StreamService();
