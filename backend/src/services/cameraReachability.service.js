/**
 * cameraReachability.service.js
 *
 * Lightweight per-NVR reachability prober.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cameras run as `sourceOnDemand` paths in Stream Service, so a camera only becomes
 * `ready` (and thus "online" to streamSupervisor) WHILE someone is actively
 * viewing it. A healthy but idle camera therefore looks offline — the
 * supervisor has no signal that the camera is reachable when nobody is pulling
 * it. This prober supplies exactly that missing signal, cheaply.
 *
 * HOW
 * ---
 *   - Probes each DISTINCT host once per cycle (all cameras behind one NVR
 *     share a single probe — 68 cams on one IP = one TCP connect).
 *   - A successful TCP connect to the RTSP port => reachable; a timeout or
 *     refusal => unreachable. (A dead NVR's dial times out — that is exactly
 *     what distinguishes it from a reachable-but-idle one.)
 *   - streamSupervisor consults isReachable(host) to mark reachable-but-idle
 *     cameras STANDBY (online) instead of OFFLINE, and to flip a whole NVR's
 *     cameras together when its uplink dies — all without 24/7 pulling streams.
 */

const net    = require('node:net');
const logger = require('../config/logger');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

const PROBE_INTERVAL_MS = parseInt(process.env.CAMERA_PROBE_INTERVAL_MS, 10) || 25_000;
const PROBE_TIMEOUT_MS  = parseInt(process.env.CAMERA_PROBE_TIMEOUT_MS, 10)  || 5_000;
const DEFAULT_RTSP_PORT = parseInt(process.env.CAMERA_PROBE_PORT, 10)        || 554;

// host -> { reachable: boolean, lastChecked: ts, lastChange: ts }
const _reach = new Map();
let _timer   = null;
let _running = false;

/** Resolve true if a TCP connection opens within the timeout, else false. */
function tcpProbe(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* noop */ }
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error',   () => finish(false));
    try { socket.connect(port, host); } catch (_) { finish(false); }
  });
}

async function cycle() {
  let hosts;
  try {
    const { Camera } = loadModels();
    const rows = await Camera.findAll({ attributes: ['host', 'port'] });
    const byHost = new Map();                 // dedup: one probe per host
    for (const r of rows) {
      if (!r.host) continue;
      if (!byHost.has(r.host)) byHost.set(r.host, r.port || DEFAULT_RTSP_PORT);
    }
    hosts = [...byHost.entries()];
  } catch (err) {
    logger.warn('cameraReachability: camera query failed', { error: err.message });
    return;
  }

  await Promise.all(hosts.map(async ([host, port]) => {
    const ok  = await tcpProbe(host, port);
    const now = Date.now();
    const prev = _reach.get(host);
    if (!prev || prev.reachable !== ok) {
      logger.info('cameraReachability: host state change', { host, port, reachable: ok });
      _reach.set(host, { reachable: ok, lastChecked: now, lastChange: now });
    } else {
      prev.lastChecked = now;
    }
  }));
}

/** @returns {boolean|null} true / false / null when the host hasn't been probed yet. */
function isReachable(host) {
  const e = _reach.get(host);
  return e ? e.reachable : null;
}

/** Diagnostics snapshot for an admin endpoint. */
function snapshot() {
  const out = {};
  for (const [host, e] of _reach.entries()) out[host] = e;
  return out;
}

function start() {
  if (_running) return;
  _running = true;
  cycle().catch(() => {});                    // immediate first probe
  _timer = setInterval(() => cycle().catch(() => {}), PROBE_INTERVAL_MS);
  if (_timer.unref) _timer.unref();           // don't keep the process alive
  logger.info('cameraReachability: started', { intervalMs: PROBE_INTERVAL_MS, timeoutMs: PROBE_TIMEOUT_MS });
}

function stop() {
  _running = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { start, stop, isReachable, snapshot };
