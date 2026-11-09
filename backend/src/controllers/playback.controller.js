/**
 * playback.controller.js — NVR playback (RTSP replay of the NVR's OWN recordings).
 *
 * Flow: build a vendor RTSP playback URL for a camera + time range → spawn an
 * ffmpeg that transcodes it to H.264 (browser-safe; NVR streams are often H.265
 * which Chrome can't decode over HLS) and PUBLISHES it to a short-lived Stream
 * Service path → hand the browser HLS + WebRTC URLs for that path.
 *
 * ffmpeg runs in this (backend) container — the same place the live transcoder
 * runs — and is killed on /stop or after a hard session cap so we never leave an
 * orphan pulling the NVR (respects NVR-load limits).
 *
 * Two companions for the Playback page:
 *   /nvr/recordings  asks the NVR which parts of a day it has footage for (the
 *                    timeline's Recording track).
 *   /nvr/export      streams a clip of that footage to the browser as an MP4.
 *
 * Cameras that come in through a site relay (path edge_<site>_<token>_chN) sit
 * on a private network we can't reach, so their relay replays the NVR for us
 * and pushes the footage up (edgeRelay.service). Its pushed path then stands
 * in for the NVR's playback URL; everything downstream is the same.
 */
const { spawn } = require('node:child_process');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { Camera, CameraGroup } = require('../models');
const vendors = require('../services/vendors');
const streamRouter = require('../services/streamRouter.service');
const streamingService = require('../services/drishyamStreaming.service');
const nvrRecordingSearch = require('../services/nvrRecordingSearch.service');
const edgeRelay = require('../services/edgeRelay.service');
const logger = require('../config/logger');
const config = require('../config/env');
const liveRelay = require('../services/liveRelay.service');

const MAX_RANGE_MS = 6 * 3600 * 1000;      // cap one request at 6h of footage
const MAX_SESSION_MS = 30 * 60 * 1000;     // hard-kill ffmpeg after 30 min
const MAX_SEARCH_MS = 48 * 3600 * 1000;    // recording search: one day, with room for timezone edges
const MAX_EXPORT_MS = 30 * 60 * 1000;      // one clip: the NVR replays in real time, so this is also its duration
// Where ffmpeg publishes the transcoded H.264 (Stream Service RTSP ingest).
const MEDIAMTX_RTSP = process.env.MEDIAMTX_RTSP_BASE || 'rtsp://mediamtx:8554';

// pathName -> { proc, timer, startedAt }
const sessions = new Map();
// userId -> { proc } — one export per account at a time. Each export is
// another pull on the NVR on top of any playback, and NVRs fall over on too
// many concurrent pulls (the 2026-07-06 incident).
const exportsByUser = new Map();

// ffmpeg echoes its input URL in errors, and the NVR's credentials are in it.
const redact = (s) => String(s || '').replace(/\/\/[^@\s/]*@/g, '//***@');

function stopSession(pathN) {
  const s = sessions.get(pathN);
  if (!s) return;
  sessions.delete(pathN);
  clearTimeout(s.timer);
  edgeRelay.closeReplay(s.edgeJob);
  if (s.relay) liveRelay.stopRelay(s.relayPath || pathN);
  try { s.proc?.kill('SIGKILL'); } catch { /* already gone */ }
  logger.info('nvr playback session stopped', { pathN });
}

// `copy`: the source is already H.264 (a relay's replay reports its codec), so
// it is passed straight through — starts sooner and costs no CPU.
function spawnTranscode(pathN, nvrRtsp, edgeJob = null, { copy = false } = {}) {
  const video = copy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p'];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', nvrRtsp,
    '-an',                                   // drop NVR G711 audio (HLS trouble)
    ...video,
    '-f', 'rtsp', '-rtsp_transport', 'tcp', `${MEDIAMTX_RTSP}/${pathN}`,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-600); });
  proc.on('exit', (code) => {
    if (code && code !== 255) logger.warn('nvr playback ffmpeg exited', { pathN, code, tail: redact(tail).trim().slice(-200) });
    const s = sessions.get(pathN);
    if (s && s.proc === proc) { clearTimeout(s.timer); sessions.delete(pathN); }
    edgeRelay.closeReplay(edgeJob);
  });
  proc.on('error', (e) => logger.error('nvr playback ffmpeg spawn error', { pathN, error: e.message }));
  const timer = setTimeout(() => stopSession(pathN), MAX_SESSION_MS);
  sessions.set(pathN, { proc, timer, startedAt: Date.now(), edgeJob });
  return proc;
}

function parseRange(start, end, maxMs, maxLabel) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new AppError('Invalid time range — end must be after start.', 400);
  }
  if (endMs - startMs > maxMs) throw new AppError(`Pick a window of ${maxLabel} or less.`, 400);
  if (startMs > Date.now()) throw new AppError('Start time is in the future.', 400);
  return { startMs, endMs };
}

// The caller's camera, its NVR group, and the vendor family that decides the
// playback URL / search API.
async function loadCamera(userId, monitorId) {
  const camera = await Camera.findOne({
    where: { monitorId, userId },
    include: [{ model: CameraGroup, as: 'group' }],
  });
  if (!camera) throw new AppError('Camera not found.', 404);
  return {
    camera,
    group: camera.group,
    deviceType: camera.deviceType || camera.group?.deviceType || 'hikvision',
    edge: edgeRelay.parseEdgeCamera(camera),
  };
}

// The device holding the recordings: the group's NVR, else the camera itself.
const nvrHost = ({ camera, group }) => group?.host ?? camera.host ?? null;

function assertPlayback(cam) {
  if (cam.edge) return;       // the relay knows its NVR's brand and does the replay
  if (!vendors.supportsPlayback(cam.deviceType)) {
    throw new AppError(`NVR playback isn't supported for "${cam.deviceType}" yet. Supported: Hikvision, Dahua / CP Plus.`, 422);
  }
  if (!nvrHost(cam)) throw new AppError("This camera isn't connected through an NVR, so there is no NVR footage to replay.", 422);
}

// Credentials resolve group-first, the same way buildCamConfig does for live.
function nvrPlaybackRtsp(cam, startMs, endMs) {
  const { camera, group, deviceType } = cam;
  return streamRouter.buildRtspUrl({
    host:     nvrHost(cam),
    port:     group?.port     ?? camera.port ?? 554,
    path:     vendors.buildPlaybackPath(deviceType, camera.channel || 1, startMs, endMs),
    username: group?.username ?? camera.username,
    password: group?.password ?? camera.password, // model getter decrypts
  });
}

/**
 * Where to read the NVR's footage for [startMs, endMs] from: the NVR's own
 * playback URL, or for a relayed camera the path its relay pushes the replay
 * to (edgeJob is then that request, to close when done).
 */
async function playbackSource(cam, startMs, endMs) {
  if (!cam.edge) return { url: nvrPlaybackRtsp(cam, startMs, endMs), edgeJob: null, h264: false };
  const { id, sourceUrl, codec } = await edgeRelay.openReplay(cam.edge, startMs, endMs);
  return { url: sourceUrl, edgeJob: id, h264: codec === 'H264' };
}

// POST /api/playback/nvr/start   { monitorId, start, end }
const startNvrPlayback = asyncHandler(async (req, res) => {
  const { monitorId, start, end } = req.body || {};
  if (!monitorId || !start || !end) throw new AppError('monitorId, start and end are required.', 400);
  const { startMs, endMs } = parseRange(start, end, MAX_RANGE_MS, '6 hours');

  const cam = await loadCamera(req.user.id, monitorId);
  assertPlayback(cam);

  const pathN = `pb_${monitorId}_${startMs}`;
  stopSession(pathN);           // replace any previous session for this exact window

  // Fast path (`relay: true` from browsers with MediaSource; `hevc` says
  // whether they decode H.265 — older pages only sent relay when they did):
  // the footage goes to the browser over the live relay WebSocket,
  // stream-copied, with no H.264 transcode and no HLS segments to wait for.
  //   • NVR we reach: its own playback RTSP, only for H.265-capable browsers
  //     (the codec isn't known before it plays; NVRs here are mostly H.265).
  //   • Site-relay camera: the replay its relay pushes up, once it is up; the
  //     codec is known then, so H.264 sites get it in every browser.
  const wantRelay = !!req.body.relay;
  const hevcOk = req.body.hevc === undefined ? wantRelay : !!req.body.hevc;
  if (wantRelay && hevcOk && !cam.edge) {
    const ticket = liveRelay.issueTicket({
      userId: req.user.id, monitorId, path: pathN, variant: 'main',
      nvrUrl: nvrPlaybackRtsp(cam, startMs, endMs), once: true,
    });
    sessions.set(pathN, { proc: null, relay: true, startedAt: Date.now(), timer: setTimeout(() => stopSession(pathN), MAX_SESSION_MS) });
    logger.info('nvr playback started', { userId: req.user.id, monitorId, deviceType: cam.deviceType, pathN, mode: 'relay' });
    return res.json({
      success: true, mode: 'relay', pathName: pathN, ticket,
      range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      deviceType: cam.deviceType,
    });
  }
  const src = await playbackSource(cam, startMs, endMs);
  if (wantRelay && cam.edge && (src.h264 || hevcOk)) {
    const relayPath = String(src.url).split('/').pop();      // pbsrc_<site>_<token>_<id>
    const ticket = liveRelay.issueTicket({ userId: req.user.id, monitorId, path: relayPath, variant: 'main', once: true });
    sessions.set(pathN, { proc: null, relay: true, relayPath, edgeJob: src.edgeJob, startedAt: Date.now(), timer: setTimeout(() => stopSession(pathN), MAX_SESSION_MS) });
    logger.info('nvr playback started', { userId: req.user.id, monitorId, deviceType: cam.deviceType, pathN, mode: 'relay', via: 'site relay' });
    return res.json({
      success: true, mode: 'relay', pathName: pathN, ticket,
      range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      deviceType: cam.deviceType,
    });
  }
  spawnTranscode(pathN, src.url, src.edgeJob, { copy: src.h264 });

  logger.info('nvr playback started', { userId: req.user.id, monitorId, deviceType: cam.deviceType, pathN });
  res.json({
    success: true,
    pathName: pathN,
    // Absolute, from the same config the live player uses. A relative
    // `/hls/...` only resolves behind the prod nginx, so the page was dead in
    // dev (Vite has no /hls route and answers index.html, which hls.js reads
    // as a fatal manifest error).
    hlsUrl: `${config.streamService.hlsUrl}/${pathN}/index.m3u8`,
    webrtcUrl: `${config.streamService.webrtcUrl}/${pathN}`,
    range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    deviceType: cam.deviceType,
  });
});

// POST /api/playback/nvr/stop   { pathName }  (or ?pathName= — the page's
// unload beacon can't send a JSON body without a CORS preflight)
const stopNvrPlayback = asyncHandler(async (req, res) => {
  const pathName = req.body?.pathName || req.query.pathName;
  if (!pathName || !/^pb_[A-Za-z0-9_]+$/.test(pathName)) throw new AppError('Invalid pathName.', 400);
  stopSession(pathName);
  try { await streamingService.api.delete(`/v3/config/paths/delete/${pathName}`); } catch (_) { /* fine */ }
  res.json({ success: true });
});

// GET /api/playback/nvr/recordings?monitorId=&start=&end=
// Where the NVR has footage in the window, as merged spans tagged
// continuous / motion / alarm. `supported: false` (with a reason) for devices
// we can't ask, so the timeline can say "unknown" instead of "nothing".
const searchNvrRecordings = asyncHandler(async (req, res) => {
  const { monitorId, start, end } = req.query;
  if (!monitorId || !start || !end) throw new AppError('monitorId, start and end are required.', 400);
  const { startMs, endMs } = parseRange(start, end, MAX_SEARCH_MS, '48 hours');
  const cam = await loadCamera(req.user.id, monitorId);
  if (cam.edge) {
    return res.json({
      success: true, supported: false, segments: [],
      reason: 'Recording search is not available for cameras connected through a site relay yet.',
    });
  }
  const host = nvrHost(cam);
  if (!host) {
    return res.json({ success: true, supported: false, reason: "This camera isn't connected through an NVR.", segments: [] });
  }

  let result;
  try {
    result = await nvrRecordingSearch.searchRecordings({
      deviceType: cam.deviceType,
      host,
      httpPort: cam.group?.httpPort || 80,
      username: cam.group?.username ?? cam.camera.username,
      password: cam.group?.password ?? cam.camera.password,
      channel:  cam.camera.channel || 1,
      start:    startMs,
      end:      Math.min(endMs, Date.now()),
      cacheKey: `${req.user.id}|${monitorId}`,
    });
  } catch (err) {
    logger.warn('nvr recording search failed', { monitorId, error: err.message });
    // Answered here rather than thrown: the error handler replaces every 5xx
    // message with a generic one, and this one says what to fix.
    return res.status(502).json({
      success: false,
      message: err.expose ? err.message : 'Could not read the recording list from the NVR.',
    });
  }

  return res.json({
    success: true,
    supported: result.supported,
    reason: result.reason || null,
    segments: result.segments.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      kind: s.kind,
    })),
  });
});

function exportArgs(nvrRtsp, durationSec, format) {
  // 'original' keeps the NVR's own encode (often H.265: smaller and faster, but
  // many desktop players need a codec pack). 'mp4' re-encodes to H.264 so the
  // clip opens anywhere — the right default for evidence that gets forwarded.
  const video = format === 'original'
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  return [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', nvrRtsp,
    '-t', String(durationSec),
    '-an',
    ...video,
    // Fragmented MP4: bytes (and the browser's download progress) start within
    // seconds instead of after the whole clip has been encoded.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
}

function exportFilename(name, camera, startMs) {
  const clean = (s) => String(s || '').replace(/\.mp4$/i, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return `${clean(name) || `${clean(camera.name) || 'camera'}_${startMs}`}.mp4`;
}

// GET /api/playback/nvr/export?monitorId=&start=&end=&format=mp4|original&name=
// Streams the NVR's footage for the range straight to the browser as an MP4
// download. The NVR replays in real time, so a 3-minute clip takes about three
// minutes. Loaded by the browser directly, so the JWT rides as ?token=, the
// same as recording downloads.
const exportNvrClip = asyncHandler(async (req, res) => {
  const { monitorId, start, end } = req.query;
  if (!monitorId || !start || !end) throw new AppError('monitorId, start and end are required.', 400);
  const { startMs, endMs } = parseRange(start, end, MAX_EXPORT_MS, '30 minutes');
  const cam = await loadCamera(req.user.id, monitorId);
  assertPlayback(cam);
  if (exportsByUser.has(req.user.id)) throw new AppError('An export is already running. Wait for it to finish, then try again.', 429);

  const format = req.query.format === 'original' ? 'original' : 'mp4';
  const durationSec = Math.ceil((endMs - startMs) / 1000);
  const filename = exportFilename(req.query.name, cam.camera, startMs);
  // Claimed before the (possibly slow) relay handshake, so a double click
  // can't start two pulls on the NVR.
  const entry = { proc: null };
  exportsByUser.set(req.user.id, entry);
  let src;
  try {
    src = await playbackSource(cam, startMs, endMs);
  } catch (err) {
    exportsByUser.delete(req.user.id);
    throw err;
  }
  if (req.destroyed) {          // download cancelled while the relay was connecting
    exportsByUser.delete(req.user.id);
    edgeRelay.closeReplay(src.edgeJob);
    return;
  }
  // An H.264 replay is already what 'mp4' would re-encode to: copy it.
  const proc = spawn('ffmpeg', exportArgs(src.url, durationSec, src.h264 ? 'original' : format), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  entry.proc = proc;
  // The NVR should end the stream at the range's end on its own; this is the
  // backstop for one that keeps sending.
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, (durationSec + 90) * 1000);
  const release = () => {
    clearTimeout(timer);
    edgeRelay.closeReplay(src.edgeJob);
    if (exportsByUser.get(req.user.id) === entry) exportsByUser.delete(req.user.id);
  };
  logger.info('nvr export started', { userId: req.user.id, monitorId, format, durationSec });

  let tail = '';
  proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-600); });

  // Headers wait for the first bytes, so an NVR that refuses the range can
  // still be answered with a real error status instead of an empty file.
  let started = false;
  proc.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');   // nginx: pass it through, don't buffer the clip
    }
    if (!res.write(chunk)) {
      proc.stdout.pause();
      res.once('drain', () => proc.stdout.resume());
    }
  });

  proc.on('close', (code) => {
    release();
    if (started) {
      res.end();
      logger.info('nvr export finished', { userId: req.user.id, monitorId, code });
      return;
    }
    logger.warn('nvr export produced no video', { monitorId, code, tail: redact(tail).trim().slice(-200) });
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: 'The NVR returned no footage for this range. Check the time, and that RTSP playback is enabled on the NVR.',
      });
    }
  });
  proc.on('error', (e) => {
    release();
    logger.error('nvr export ffmpeg spawn error', { monitorId, error: e.message });
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Could not start the export.' });
  });

  // Download cancelled in the browser → stop pulling the NVR.
  res.on('close', () => {
    if (!res.writableFinished) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
  });
});

module.exports = {
  startNvrPlayback,
  stopNvrPlayback,
  searchNvrRecordings,
  exportNvrClip,
  // exported for tests
  exportArgs,
  exportFilename,
};
