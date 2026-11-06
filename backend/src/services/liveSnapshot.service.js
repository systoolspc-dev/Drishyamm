/**
 * liveSnapshot.service.js — one still from a live camera, for the Monitor Wall
 * editor's tiles.
 *
 * The recorder is the constraint here, not this server. Stream Service keeps an
 * on-demand path pulling for 20 s after its last reader leaves
 * (sourceOnDemandCloseAfter), so a still taken THROUGH Stream Service holds an
 * NVR session open for 20 s. Sixteen tiles would be sixteen sessions: the
 * flood that took a whole Hikvision offline on 2026-07-06. So, in order:
 *
 *   1. A cached still younger than FRESH_MS is served as is. Every viewer and
 *      every tab shares it.
 *   2. If the camera's path is already live (someone is watching), one frame is
 *      read from Stream Service's RTSP egress. The recorder is already serving
 *      that session, so this costs it nothing.
 *   3. Otherwise one frame is read straight from the camera's SUB-stream. That
 *      session lasts only as long as ffmpeg (a second or two, no linger), and a
 *      per-recorder lock allows one such grab per NVR host at a time.
 *
 * When a grab fails, a still up to STALE_MS old is served instead of nothing
 * and flagged stale, so the page can show its age.
 */

const { spawn } = require('child_process');
const streamingService = require('./drishyamStreaming.service');
const { createSemaphore } = require('../utils/semaphore');
const logger = require('../config/logger');

const FRESH_MS = 60 * 1000;
const STALE_MS = 15 * 60 * 1000;
const GRAB_TIMEOUT_MS = 9000;
const MAX_ENTRIES = 1000;
const WIDTH = 640;

const cache = new Map();       // monitorId → { jpeg, at, source }
const inFlight = new Map();    // monitorId → Promise<entry>
const hostLocks = new Map();   // recorder host → semaphore(1)
// Decoding a keyframe (often H.265) is the CPU cost; cap it for the server.
const ffmpegSlots = createSemaphore(4);

function hostLock(host) {
  const key = String(host || '').toLowerCase();
  if (!hostLocks.has(key)) hostLocks.set(key, createSemaphore(1));
  return hostLocks.get(key);
}

// ffmpeg echoes its input URL in errors; never let camera credentials reach a
// log. Greedy to the LAST '@' before the host, so a raw '@' in a password
// can't leave the tail of it behind.
function scrub(text) {
  return String(text || '').replace(/rtsp:\/\/[^\s/]*@/gi, 'rtsp://***@');
}

async function isPathReady(name) {
  if (!streamingService.api?.get) return false;
  try {
    const { data } = await streamingService.api.get(`/v3/paths/get/${name}`, { timeout: 800 });
    return data?.ready === true;
  } catch {
    return false;
  }
}

async function pickSource(camera) {
  const { monitorId } = camera;
  if (await isPathReady(streamingService.subPathName(monitorId))) {
    return { kind: 'live', url: streamingService.getRtspEgressUrl(monitorId, true) };
  }
  if (await isPathReady(streamingService.pathName(monitorId))) {
    return { kind: 'live', url: streamingService.getRtspEgressUrl(monitorId, false) };
  }
  const subPath = streamingService.deriveSubPath(camera.path);
  return {
    kind: 'direct',
    host: camera.host,
    url: streamingService.buildRtspUrl({
      host: camera.host,
      port: camera.port,
      path: subPath || camera.path,
      username: camera.username,
      password: camera.password,
    }),
  };
}

function grabFrame(url) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-rtsp_transport', 'tcp',
      '-timeout', '5000000',            // socket I/O timeout, microseconds
      // Decode keyframes only. Joining a stream mid-GOP, the first frame an
      // H.265 decoder emits is a grey half-frame with no reference picture;
      // waiting for the next keyframe costs at most one GOP (~2 s).
      '-skip_frame', 'nokey',
      '-i', url,
      '-frames:v', '1', '-an',
      '-vf', `scale=${WIDTH}:-2`,
      '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error('timed out waiting for a frame'));
    }, GRAB_TIMEOUT_MS);

    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { stderr = (stderr + c).slice(-500); });
    ff.on('error', (err) => { clearTimeout(timer); reject(err); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (code === 0 && jpeg.length) resolve(jpeg);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').pop() || 'no frame'}`));
    });
  });
}

function remember(monitorId, entry) {
  cache.delete(monitorId);
  cache.set(monitorId, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

async function refresh(camera) {
  const source = await pickSource(camera);
  const lock = source.kind === 'direct' ? hostLock(source.host) : null;
  if (lock) await lock.acquire();
  await ffmpegSlots.acquire();
  try {
    const jpeg = await grabFrame(source.url);
    const entry = { jpeg, at: Date.now(), source: source.kind };
    remember(camera.monitorId, entry);
    return entry;
  } catch (err) {
    logger.warn('live snapshot failed', { monitorId: camera.monitorId, source: source.kind, error: scrub(err.message) });
    throw err;
  } finally {
    ffmpegSlots.release();
    if (lock) lock.release();
  }
}

/**
 * @param {object} camera  Camera row (monitorId, host, port, path, username, password, status)
 * @returns {Promise<{ jpeg: Buffer, at: number, source: 'live'|'direct', stale: boolean }>}
 * @throws  Error with code 'OFFLINE' for an offline camera with nothing cached
 */
async function getSnapshot(camera) {
  const { monitorId } = camera;
  const hit = cache.get(monitorId);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (age < FRESH_MS) return { ...hit, stale: false };

  // An unreachable camera would hold its recorder's lock for the whole
  // timeout and stall every other still on that NVR. Don't try.
  if (camera.status !== 'online') {
    if (age < STALE_MS) return { ...hit, stale: true };
    const err = new Error('camera is offline');
    err.code = 'OFFLINE';
    throw err;
  }

  if (!inFlight.has(monitorId)) {
    inFlight.set(monitorId, refresh(camera).finally(() => inFlight.delete(monitorId)));
  }
  try {
    return { ...(await inFlight.get(monitorId)), stale: false };
  } catch (err) {
    if (age < STALE_MS) return { ...hit, stale: true };
    throw err;
  }
}

module.exports = {
  getSnapshot,
  _internals: { pickSource, scrub, cache, FRESH_MS, STALE_MS },
};
