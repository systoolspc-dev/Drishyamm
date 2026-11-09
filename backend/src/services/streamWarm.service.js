// Warm-keeper: keep the cameras a logged-in user is looking at (and the next
// page) warm, so opening Live View, flipping a page or reloading never pays a
// cold start (NVR RTSP pull + the camera's first keyframe: ~1.5–4 s here)
// instead of ~10 ms from a running relay's GOP cache.
//
// How it works
//   • The app calls POST /api/stream/warm on load and every ~60 s while open
//     (useStreamPrewarm), with the monitorIds on screen + the next page (on
//     the first load: the page it showed last time). Each call renews the
//     user's lease (STREAM_WARM_LEASE_MS).
//   • Those cameras' live relays (liveRelay.service.js) are pinned until the
//     lease ends — the camera's own sub-stream for browsers that decode H.265,
//     plus the H.264 sidecar transcoder for those that can't. New NVR sessions
//     are paced per NVR inside the relay/transcoder (bursts trip the
//     customer's network block, docs/14 #7).
//   • When nobody renews the lease (tabs closed / logged out) the pins lapse
//     and relays and transcoders idle out, releasing the NVR sessions.
//   • At most STREAM_WARM_MAX per user and MAX_PER_HOST per NVR, whatever the
//     account's camera count.
const logger = require('../config/logger');
const transcoder = require('./transcoder.service');
const reachability = require('./cameraReachability.service');

const LEASE_MS     = parseInt(process.env.STREAM_WARM_LEASE_MS || '180000', 10);
// Per-NVR cap: recorders serve only so many concurrent remote streams (the lab
// DS-7632NI-K2 delivered ~12–13 and starved the rest) — same as the wall's
// NVR_PULL_LIMIT = 9.
const MAX_PER_HOST = parseInt(process.env.STREAM_WARM_MAX_PER_HOST || '9', 10);
// Warm the H.264 sidecar for browsers that can't decode H.265? Off by default:
// each one holds an encoder slot for as long as the user stays logged in, and on
// a CPU-only host (8 slots, shared by every account) one such user could hold
// them all. Sidecars still start the moment someone actually watches a tile.
const WARM_TRANSCODE = process.env.STREAM_WARM_TRANSCODE === '1';
const ENABLED      = process.env.STREAM_WARM !== '0';

let _models = null;
const loadModels = () => (_models ||= require('../models'));

const _leases = new Map();    // userId → lease expiry (ms)

// ── Fullscreen main has the right of way ─────────────────────────────────────
// A site's uplink carries only so much. Measured on the lab site 2026-10-20:
// ~2.2–2.7 Mbit/s in total; with 17 sub-streams flowing (9 warm + 9 on screen)
// they took ~2.2 of it and main got 56 kbit/s — fullscreen never left the blurry
// sub. So when someone asks for main, every sub-stream on that NVR that nobody
// is watching (warm-only, or a tile left a moment ago) is stopped and its NVR
// session closed at once — not after the 5 min hold — and the warm-keeper
// leaves that NVR alone while main runs. Tiles still on screen are untouched.
const MAIN_PRIORITY_MS = parseInt(process.env.STREAM_MAIN_PRIORITY_MS || '90000', 10);
const _mainUntil = new Map(); // host → ms until which warming that NVR is paused

async function yieldForMain(camera) {
  const { host, monitorId: wanted } = camera;
  if (!host) return { released: 0 };
  _mainUntil.set(host, Date.now() + MAIN_PRIORITY_MS);
  const streaming = require('./drishyamStreaming.service');
  let items;
  try {
    ({ data: { items } } = await streaming.api.get('/v3/paths/list', { timeout: 1500 }));
  } catch (_) {
    return { released: 0 };
  }
  const byName = new Map((items || []).map((p) => [p.name, p]));
  // Our own transcoders read over RTSP; anything else on a path is a viewer.
  const viewers = (name) => (byName.get(name)?.readers || []).filter((r) => r.type !== 'rtspSession').length;

  const { Camera } = loadModels();
  const cams = await Camera.findAll({ where: { host }, attributes: ['monitorId'] });
  const released = [];
  for (const { monitorId } of cams) {
    if (monitorId === wanted) continue;
    // Unwatched live relays (they may pull the NVR directly, invisible to
    // Stream Service's path list).
    const relay = require('./liveRelay.service');
    if (relay.releaseIfIdle(`cam_${monitorId}_sub`)) released.push(monitorId);
    const src = byName.get(`cam_${monitorId}_sub`);
    if (!src || (!src.ready && !(src.readers || []).length)) continue; // no NVR session
    if (viewers(`cam_${monitorId}_sub_h264`) > 0 || viewers(`cam_${monitorId}_sub`) > 0) continue;
    // Live-relay viewers read through our own RTSP session, so ask the relay.
    if (relay.viewerCount(`cam_${monitorId}_sub`) > 0 || relay.viewerCount(`cam_${monitorId}_sub_h264`) > 0) continue;
    relay.releaseIfIdle(`cam_${monitorId}_sub`);
    relay.releaseIfIdle(`cam_${monitorId}_sub_h264`);
    transcoder.stopVariant(monitorId, 'sub');
    // Close the NVR session now. The next startStream re-PUTs the normal
    // config (addCameraSubStream), so this only shortens this one hold.
    streaming.api.patch(`/v3/config/paths/patch/cam_${monitorId}_sub`, { sourceOnDemandCloseAfter: '1s' })
      .catch(() => {});
    released.push(monitorId);
  }
  logger.info('streamWarm: released unwatched sub-streams for a fullscreen main', {
    host, monitorId: wanted, released: released.length,
  });
  return { released: released.length };
}

function mainActive(host) {
  if (transcoder.runningOnHost(host).some((r) => r.variant === 'main')) {
    _mainUntil.set(host, Math.max(_mainUntil.get(host) || 0, Date.now() + 30_000));
  }
  return (_mainUntil.get(host) || 0) > Date.now();
}

// Per-user cap: the visible page plus one page of prefetch. Independent of
// how many cameras the account has — 18 cameras or 1500, a page load warms
// the same handful (it used to be 9 per NVR, i.e. hundreds on a big site).
const MAX_WARM = parseInt(process.env.STREAM_WARM_MAX || '18', 10);
const FIRST_PAGE = 9;

/**
 * Renew `userId`'s lease and keep the cameras they are looking at warm.
 *
 *   monitorIds  what the browser shows now (+ the next page), most important
 *               first; on the very first load, the page it showed last time.
 *               Absent → the first page by channel.
 *   hevc        the browser decodes H.265 itself: warm the camera's own
 *               sub-stream relay. Otherwise also warm the H.264 sidecar.
 *
 * Warm = a live relay pinned for the lease (liveRelay.service.js), so a tile
 * gets the last keyframe + frames since at once instead of a cold NVR pull.
 */
async function touch(userId, { monitorIds, hevc = false } = {}) {
  if (!ENABLED) return { enabled: false };
  const until = Date.now() + LEASE_MS;
  _leases.set(userId, until);

  const { Camera } = loadModels();
  const attributes = ['id', 'monitorId', 'host', 'port', 'path', 'username', 'password', 'status', 'channel'];
  let cams;
  if (Array.isArray(monitorIds) && monitorIds.length) {
    const ids = [...new Set(monitorIds.map(String))].slice(0, MAX_WARM);
    const rows = await Camera.findAll({ where: { userId, monitorId: ids }, attributes });
    const byId = new Map(rows.map((c) => [c.monitorId, c]));
    cams = ids.map((id) => byId.get(id)).filter(Boolean); // keep the browser's order
  } else {
    cams = await Camera.findAll({ where: { userId }, attributes, order: [['channel', 'ASC']], limit: FIRST_PAGE });
  }

  const relay = require('./liveRelay.service');
  const streamService = require('./stream.service');
  const perHost = new Map();
  let warmed = 0;
  for (const cam of cams) {
    // Never knock on a recorder we know is unreachable — retries are what keep
    // a network block alive (docs/14 #7). The supervisor brings it back.
    if (reachability.isReachable(cam.host) === false) continue;
    // Someone is watching main on this NVR: it gets the uplink (see above).
    if (mainActive(cam.host)) continue;
    const n = perHost.get(cam.host) || 0;
    if (n >= MAX_PER_HOST) continue;
    perHost.set(cam.host, n + 1);
    try {
      const rawPath = await streamService.ensureLivePath(cam, { variant: 'sub' });
      const codec = relay.codecOf(rawPath);
      const transcode = !hevc && (!codec || /^(hvc1|hev1)/.test(codec));
      if (transcode && !WARM_TRANSCODE) {
        perHost.set(cam.host, n);   // nothing warmed for this camera
        continue;
      }
      if (transcode) {
        const path = await streamService.ensureLivePath(cam, { variant: 'sub', transcode: true });
        transcoder.pinTranscoder(cam.monitorId, 'sub', until);
        relay.pin(path, { monitorId: cam.monitorId, variant: 'sub' }, until);
      } else {
        const nvrUrl = streamService.liveNvrUrl(cam, 'sub');
        // The per-NVR cap holds across accounts: they all share the recorder.
        if (!relay.hasSource(nvrUrl) && relay.sessionsOnHost(cam.host) >= MAX_PER_HOST) {
          perHost.set(cam.host, n);
          continue;
        }
        relay.pin(rawPath, { monitorId: cam.monitorId, variant: 'sub', nvrUrl }, until);
      }
      warmed++;
    } catch (err) {
      logger.warn('streamWarm: warm failed', { monitorId: cam.monitorId, error: err.message });
    }
  }
  return { enabled: true, requested: cams.length, warmed, leaseMs: LEASE_MS };
}

module.exports = { touch, yieldForMain };
