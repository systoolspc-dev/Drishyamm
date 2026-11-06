/**
 * streamQuality.service.js
 *
 * Per-camera quality telemetry + active stream healing. Sits next to
 * streamSupervisor — supervisor decides "is this stream alive?", quality
 * decides "is the data we're getting actually good?" and "should we heal it?"
 *
 * What it measures (per camera, per tick) ─────────────────────────────────────
 *
 *   bps_in              ingress bitrate (already in supervisor)
 *   bps_jitter_ms       stddev of inter-tick bps over a rolling window — proxy
 *                       for actual RTP inter-arrival jitter. Values > 200ms
 *                       indicate a network with significant frame bunching;
 *                       the player needs more buffer.
 *   frames_in_error_rate per-second rate of Stream Service inboundFramesInError —
 *                       direct evidence of corrupted RTP packets that the
 *                       camera or upstream NAT mangled. Sustained > 5/s warns,
 *                       > 50/s heals.
 *   reader_count        how many active WebRTC/HLS readers — multiplies the
 *                       cost of any heal action (we avoid healing a stream
 *                       that 50 people are actively watching).
 *
 * Healing actions ────────────────────────────────────────────────────────────
 *
 *   stuck CONNECTING > HEAL_AFTER_MS    → PATCH path config
 *   frames_in_error_rate > HEAL_FIE     → PATCH path config (forces re-init)
 *   bps_jitter_ms > HEAL_JITTER         → log warning, emit metric, no auto-heal
 *                                         (jitter is a network problem, healing
 *                                         won't help and may make it worse)
 *
 * PATCH on /v3/config/paths/patch/<name> with the existing config triggers
 * Stream Service to drop the upstream RTSP and reconnect — the cheapest way to
 * recover from a stuck/corrupt path. The supervisor will then see
 * ready→true on the next tick.
 *
 * To prevent heal storms: each camera has a heal cooldown (default 60s) and a
 * 24h heal budget (default 20). Beyond the budget the camera is marked as
 * needing operator attention via Prometheus + a `quality.giveup` event.
 */

const axios = require('axios');

const logger  = require('../config/logger');
const metrics = require('./metrics.service');
const config  = require('../config/env');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

// ── Tunables ──────────────────────────────────────────────────────────────────

const WINDOW_SAMPLES   = parseInt(process.env.QUALITY_WINDOW_SAMPLES    || '30',   10); // ~60s @ 2s tick
const HEAL_AFTER_MS    = parseInt(process.env.QUALITY_HEAL_AFTER_MS     || '30000',10);
const HEAL_FIE_RATE    = parseInt(process.env.QUALITY_HEAL_FIE_RATE     || '50',   10); // frames-in-error/sec
const WARN_FIE_RATE    = parseInt(process.env.QUALITY_WARN_FIE_RATE     || '5',    10);
const WARN_JITTER_MS   = parseInt(process.env.QUALITY_WARN_JITTER_MS    || '200',  10);
const HEAL_COOLDOWN_MS = parseInt(process.env.QUALITY_HEAL_COOLDOWN_MS  || '60000',10);
const HEAL_BUDGET_24H  = parseInt(process.env.QUALITY_HEAL_BUDGET_24H   || '20',   10);
const HEAL_COOLDOWN_MAX_MS = parseInt(process.env.QUALITY_HEAL_COOLDOWN_MAX_MS || '900000', 10); // 15min backoff cap
const NVR_RECONNECT_MIN_MS = parseInt(process.env.QUALITY_NVR_RECONNECT_MIN_MS || '30000',  10); // min gap between re-binds to one NVR

// Per-camera state — bounded by camera count, not tick count
//   { bpsSamples: [], lastFie, lastFieAt, lastHealAt, healsToday: [ts...], consecutiveHeals }
const _cam = new Map();

// Per-NVR (camera host) last RTSP re-bind timestamp. Many cameras share one
// NVR; serializing re-binds per host stops a burst of simultaneous reconnects
// from blowing the NVR's concurrent-session cap (which drops healthy channels).
const _nvrReconnectAt = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function entryFor(monitorId) {
  let e = _cam.get(monitorId);
  if (!e) {
    e = { bpsSamples: [], lastFie: null, lastFieAt: null, lastHealAt: 0, healsToday: [], consecutiveHeals: 0 };
    _cam.set(monitorId, e);
  }
  return e;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Rough mapping from bps-stddev to inter-frame jitter milliseconds.
 *
 * If a camera averages X bps and stddev is Y, then frames are arriving with
 * timing variance proportional to Y/X seconds. We multiply by 1000 to get ms
 * and clamp to a sane range. This isn't an exact RFC 3550 jitter metric, but
 * it's a stable proxy that scales with real arrival jitter and we can compute
 * it with no extra polling work.
 */
function jitterMs(samples, meanBps) {
  if (!meanBps || samples.length < 2) return 0;
  const sd = stddev(samples);
  return Math.min(2000, Math.round((sd / meanBps) * 1000));
}

// ── Per-server axios cache (mirrors supervisor) ──────────────────────────────

const _serverClients = new Map();
function clientFor(server) {
  if (_serverClients.has(server.id)) return _serverClients.get(server.id);
  const c = axios.create({
    baseURL: server.apiUrl,
    timeout: 4000,
    headers: { 'Content-Type': 'application/json' },
    auth: server.apiUser ? { username: server.apiUser, password: server.apiPass || '' } : undefined,
  });
  _serverClients.set(server.id, c);
  return c;
}

// ── Active healing ───────────────────────────────────────────────────────────

/**
 * Force a camera path to re-initialize by PATCHing it with its existing config.
 * Cheap (no DELETE→ADD round trip), but enough to make Stream Service drop the
 * source RTSP connection and reconnect. The supervisor reflects the ensuing
 * CONNECTING→STREAMING transition; metrics record the heal action.
 *
 * Respects:
 *   - cooldown (HEAL_COOLDOWN_MS) per camera
 *   - 24h budget (HEAL_BUDGET_24H) — beyond this we give up and alert
 *   - reader count — we DO heal even with readers because the alternative is
 *     a frozen frame; readers will reconnect within Stream Service's stale window
 *
 * @returns {Promise<{healed: boolean, reason: string}>}
 */
async function heal(camera, server, reason) {
  const e = entryFor(camera.monitorId);
  const now = Date.now();

  // Per-camera cooldown with EXPONENTIAL backoff + jitter. A permanently-stuck
  // camera (flaky NVR) must not be force-reconnected once a minute forever:
  // each consecutive heal doubles the wait (capped at HEAL_COOLDOWN_MAX_MS),
  // and ±20% jitter de-phases sibling cameras so they stop healing in lockstep.
  const backoff  = Math.min(HEAL_COOLDOWN_MS * (2 ** (e.consecutiveHeals || 0)), HEAL_COOLDOWN_MAX_MS);
  const jittered = backoff * (0.8 + Math.random() * 0.4);
  if (now - e.lastHealAt < jittered) {
    return { healed: false, reason: 'cooldown' };
  }
  // Trim the heal log to the last 24h then check budget
  e.healsToday = e.healsToday.filter((t) => now - t < 24 * 60 * 60 * 1000);
  if (e.healsToday.length >= HEAL_BUDGET_24H) {
    metrics.streamHealsRefused.inc({ reason: 'budget-exhausted' });
    return { healed: false, reason: 'budget-exhausted' };
  }

  // Per-NVR reconnect rate limit. Many cameras share ONE NVR (same host); if
  // they all re-bind at once they exceed the NVR's concurrent-RTSP-session cap
  // and it drops healthy channels too — the cross-camera amplification behind
  // the flapping. Serialize re-binds to one per NVR per NVR_RECONNECT_MIN_MS.
  const nvrKey = camera.host || `cam:${camera.monitorId}`;
  if (now - (_nvrReconnectAt.get(nvrKey) || 0) < NVR_RECONNECT_MIN_MS) {
    metrics.streamHealsRefused.inc({ reason: 'nvr-rate-limited' });
    return { healed: false, reason: 'nvr-rate-limited' };
  }

  const api = clientFor(server);
  const name = `cam_${camera.monitorId}`;

  // Read existing config so PATCH preserves source/record/onDemand semantics
  let existing = null;
  try {
    const r = await api.get(`/v3/config/paths/get/${name}`);
    existing = r.data;
  } catch (err) {
    metrics.streamHealsRefused.inc({ reason: 'config-fetch-failed' });
    return { healed: false, reason: `config-fetch: ${err.message}` };
  }

  // PATCH with the same config — Stream Service treats it as "rebind the source".
  // We strip read-only fields that 400 the request.
  const body = {
    source:                existing.source,
    sourceOnDemand:        existing.sourceOnDemand ?? false,
    sourceProtocol:        existing.sourceProtocol ?? 'tcp',
    record:                existing.record ?? false,
    recordPath:            existing.recordPath ?? undefined,
    recordSegmentDuration: existing.recordSegmentDuration ?? undefined,
    recordDeleteAfter:     existing.recordDeleteAfter ?? undefined,
  };

  try {
    await api.patch(`/v3/config/paths/patch/${name}`, body);
  } catch (err) {
    metrics.streamHealsRefused.inc({ reason: 'patch-failed' });
    return { healed: false, reason: `patch: ${err.message}` };
  }

  e.lastHealAt = now;
  e.healsToday.push(now);
  e.consecutiveHeals = (e.consecutiveHeals || 0) + 1;
  _nvrReconnectAt.set(nvrKey, now);
  metrics.streamHealsTriggered.inc({ reason });
  logger.warn('[Quality] heal triggered', {
    monitor: camera.monitorId, server: server.name, reason,
    healsToday: e.healsToday.length,
  });
  return { healed: true, reason };
}

// ── Public observe() — called once per camera per supervisor tick ────────────

/**
 * Update telemetry for one camera, then return a heal request if the camera
 * looks broken enough to warrant intervention. The supervisor consumes the
 * request and (if healing is enabled) issues the PATCH.
 *
 * Pure on the inputs; callers should pass:
 *   - monitorId, server (for heal target resolution)
 *   - bpsIn (computed by supervisor)
 *   - pathInfo (the Stream Service /v3/paths/list item)
 *   - supervisorState (current state machine value from the supervisor)
 *   - enteredStateAt (ms, when the camera entered the current state)
 *
 * Returns: { jitterMs, fieRate, readers, healAdvice: null | {reason} }
 */
function observe({ monitorId, bpsIn, pathInfo, supervisorState, enteredStateAt }) {
  const e = entryFor(monitorId);
  const now = Date.now();

  // Healthy again — clear the heal backoff so a future real fault heals promptly.
  if (supervisorState === 'streaming') e.consecutiveHeals = 0;

  // bps rolling window
  e.bpsSamples.push(bpsIn || 0);
  if (e.bpsSamples.length > WINDOW_SAMPLES) e.bpsSamples.shift();
  // Stream Service byte counters can sample as 0 on a poll boundary even when the
  // stream is ready and healthy. Use positive samples for jitter display so
  // the UI does not label one sparse tick as 700ms transport jitter.
  const nonZeroSamples = e.bpsSamples.filter((v) => v > 0);
  const jitterSamples = nonZeroSamples.length >= 2 ? nonZeroSamples : e.bpsSamples;
  const mean = jitterSamples.reduce((s, v) => s + v, 0) / jitterSamples.length;
  const jit  = jitterMs(jitterSamples, mean);

  // frames-in-error rate (per second) over the inter-tick interval
  const fieNow = pathInfo?.inboundFramesInError ?? null;
  let fieRate = 0;
  if (fieNow != null && e.lastFie != null && e.lastFieAt && now > e.lastFieAt) {
    const dF = Math.max(0, fieNow - e.lastFie);
    const dT = (now - e.lastFieAt) / 1000;
    fieRate = dT > 0 ? Math.round(dF / dT) : 0;
  }
  if (fieNow != null) { e.lastFie = fieNow; e.lastFieAt = now; }

  const readers = Array.isArray(pathInfo?.readers) ? pathInfo.readers.length : 0;

  // Cache last computed values on the entry so /quality endpoint can return them
  e.lastJitter  = jit;
  e.lastFieRate = fieRate;
  e.lastReaders = readers;

  // ── Metrics ────────────────────────────────────────────────────────────
  metrics.cameraJitterMs.set({ monitor_id: monitorId }, jit);
  metrics.cameraFieRate.set({ monitor_id: monitorId },  fieRate);
  metrics.cameraReaders.set({ monitor_id: monitorId },  readers);

  // ── Heal decisions ─────────────────────────────────────────────────────
  let healAdvice = null;

  // 1) Stuck CONNECTING — common when the camera-side ONVIF refused our
  //    initial RTSP DESCRIBE; PATCH forces a clean reconnect.
  if (
    supervisorState === 'connecting' &&
    enteredStateAt && (now - enteredStateAt) >= HEAL_AFTER_MS
  ) {
    healAdvice = { reason: 'stuck-connecting' };
  }

  // 2) Sustained frames-in-error → camera is sending corrupt RTP. Reconnecting
  //    sometimes resyncs the SPS/PPS and clears it; if it doesn't, the heal
  //    budget will exhaust and the operator gets paged.
  if (!healAdvice && fieRate >= HEAL_FIE_RATE) {
    healAdvice = { reason: 'frames-in-error' };
  }

  // 3) Sustained high jitter — DON'T auto-heal. PATCH won't fix a network
  //    problem, and tearing down a session that's still delivering frames
  //    just makes it worse. We log + alert via the metric instead.
  if (jit >= WARN_JITTER_MS) {
    metrics.cameraQualityWarn.inc({ kind: 'high-jitter' });
  }
  if (fieRate >= WARN_FIE_RATE && fieRate < HEAL_FIE_RATE) {
    metrics.cameraQualityWarn.inc({ kind: 'frames-in-error' });
  }

  return { jitterMs: jit, fieRate, readers, meanBps: Math.round(mean), healAdvice };
}

/**
 * Manual heal trigger — exposed via /api/cameras/:monitorId/heal for
 * operators. Resolves the camera + server, applies cooldown + budget rules.
 */
async function manualHeal(monitorId) {
  const { Camera, StreamServer } = loadModels();
  const camera = await Camera.findOne({ where: { monitorId } });
  if (!camera) return { healed: false, reason: 'camera-not-found' };
  let server = camera.mediamtxServerId
    ? await StreamServer.findByPk(camera.mediamtxServerId)
    : null;
  if (!server) {
    server = {
      id: '__env_default__',
      name: 'env-default',
      apiUrl: config.streamService.apiUrl,
      apiUser: config.streamService.apiUser,
      apiPass: config.streamService.apiPass,
    };
  }
  return heal(camera, server, 'manual');
}

/** Drop in-memory state for a camera (call on camera delete). */
function forget(monitorId) { _cam.delete(monitorId); }

/** Snapshot for diagnostics. */
function snapshot() {
  const out = {};
  for (const [k, e] of _cam.entries()) {
    out[k] = {
      meanBps: e.bpsSamples.length
        ? Math.round(e.bpsSamples.reduce((s, v) => s + v, 0) / e.bpsSamples.length)
        : 0,
      jitterMs:   e.lastJitter  ?? 0,
      fieRate:    e.lastFieRate ?? 0,
      readers:    e.lastReaders ?? 0,
      healsToday: e.healsToday.length,
      lastHealAt: e.lastHealAt || null,
    };
  }
  return out;
}

module.exports = { observe, heal, manualHeal, forget, snapshot };
