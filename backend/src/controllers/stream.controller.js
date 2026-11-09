const asyncHandler      = require('../middleware/asyncHandler');
const { Camera }        = require('../models');
const streamService     = require('../services/stream.service');
const recordingSync     = require('../services/recordingSync.service');
const streamToken       = require('../utils/streamToken');
const liveSnapshot      = require('../services/liveSnapshot.service');
const AppError          = require('../utils/AppError');

/**
 * Start stream — ensure camera is registered in Stream Service, return URLs.
 * GET /api/stream/start/:monitorId
 */
const startStream = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  const quality = ['low', 'high', 'auto'].includes(req.query.quality)
    ? req.query.quality
    : 'auto';

  // The client probes its own decoder (MediaSource.isTypeSupported for hvc1/hev1)
  // and reports the result. When it can decode H.265 we hand it the camera's
  // native stream instead of spending an encoder slot re-coding to H.264.
  // Absent/anything-else ⇒ false, so an old client keeps the transcoded path.
  const clientHevc = req.query.hevc === '1' || req.query.hevc === 'true';

  const { webrtcUrl, hlsUrl, hlsSubUrl, provider, codec, transcoded, mainOpen } =
    await streamService.startStream(camera, { quality, clientHevc });

  // Media-plane authorization (audit H9): only the owner reaches this point
  // (Camera.findOne scoped by userId above), so mint a short-lived per-camera
  // token and drop it as a same-origin cookie the browser sends on every HLS
  // segment / WHEP request. nginx `auth_request` validates it via /stream/verify.
  // No-op unless STREAM_URL_SECRET is set, so current playback is unchanged
  // until the nginx side is deployed. See docs/STREAM_SECURITY.md.
  if (streamToken.enabled()) {
    const t = streamToken.sign(monitorId);
    if (t) {
      res.cookie(`st_${monitorId}`, `${t.token}.${t.expires}`, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: Math.max(0, t.expires * 1000 - Date.now()),
      });
    }
  }

  // Only advertise our custom master playlist when we know a sub-stream is
  // actually streaming. Otherwise it's a single-variant master that just
  // wraps the Stream Service URL — wrapping doesn't add value, and HLS.js can
  // sometimes misbehave on nested master playlists. When `null`, the
  // frontend falls back to `hlsUrl` (Stream Service's own master), which is
  // proven to work reliably.
  const masterUrl = null;

  res.json({
    mainOpen:  mainOpen || undefined,   // single view: why main was / wasn't served
    ok:        true,
    monitorId,
    webrtcUrl,          // primary — sub-500ms, WHEP protocol
    masterUrl,          // ABR HLS master — only set when sub-stream is live (else null)
    hlsUrl,             // main stream — full resolution (single view)
    hlsSubUrl,          // sub-stream — lower resolution for grid/multi-view (null if unsupported)
    streamUrl: hlsUrl,  // legacy field kept for backward compatibility
    provider,
    codec,              // 'H264' | 'H265' | null — source codec detected
    transcoded,         // true when hlsUrl points at the H.264 sidecar path
    message:   'Stream started',
  });
});

/**
 * Stop / remove stream path from Stream Service.
 * GET /api/stream/stop/:monitorId
 *
 * Note: in normal operation cameras stay in Stream Service 24/7 for recording.
 * This endpoint is mainly used during cleanup or manual testing.
 */
const stopStream = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  await streamService.stopStream(monitorId);
  res.json({ ok: true, monitorId, message: 'Stream stopped' });
});

/**
 * One still from a live camera, for the Monitor Wall editor's tiles.
 * GET /api/stream/snapshot/:monitorId → image/jpeg
 *
 * X-Snapshot-At says when the frame was taken (stills are shared and cached,
 * so it can be up to a minute old); X-Snapshot-Stale=1 means the latest grab
 * failed and an older still was served. See liveSnapshot.service for why this
 * never opens more than one extra session per recorder.
 */
const getSnapshot = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  let shot;
  try {
    shot = await liveSnapshot.getSnapshot(camera);
  } catch (err) {
    if (err.code === 'OFFLINE') throw new AppError('Camera is offline.', 409);
    throw new AppError('Could not get a still from this camera. It will be retried.', 502);
  }

  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=30',
    'X-Snapshot-At': new Date(shot.at).toISOString(),
    'X-Snapshot-Stale': shot.stale ? '1' : '0',
    'Access-Control-Expose-Headers': 'X-Snapshot-At, X-Snapshot-Stale',
  });
  res.send(shot.jpeg);
});

/**
 * Get stream status + live URLs for a camera.
 * GET /api/stream/status/:monitorId
 */
const getStreamStatus = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  const isActive = streamService.isStreamActive(camera);
  const stream = isActive
    ? await streamService.startStream(camera, { quality: 'auto' })
    : {};

  res.json({
    ok: true,
    monitorId,
    isActive,
    webrtcUrl: stream.webrtcUrl || null,
    hlsUrl:    stream.hlsUrl || null,
    streamUrl: stream.hlsUrl || null,  // legacy compat
    provider:  stream.provider || null,
    codec:     stream.codec || null,
    transcoded: !!stream.transcoded,
  });
});

/**
 * Manually trigger the self-healing watchdog.
 * POST /api/stream/watchdog/run
 *
 * Useful for forcing immediate recovery after a Stream Service restart or
 * to fix a camera stuck with a corrupted HLS muxer (HTTP 500) without
 * waiting for the 2-minute automatic cycle.
 */
const runWatchdog = asyncHandler(async (_req, res) => {
  // Fire and forget — watchdog logs its own progress
  recordingSync.runWatchdog().catch(() => {});
  res.json({ ok: true, message: 'Watchdog cycle triggered' });
});

/**
 * Serve a dynamic HLS master playlist (multi-bitrate) for a camera.
 * GET /api/stream/master/:monitorId/index.m3u8
 *
 * The master playlist references the camera's main + sub HLS streams as
 * separate variants. HLS.js (browser) automatically picks a variant based on
 * measured network throughput — adaptive bitrate streaming with no server
 * transcoding. The player exposes manual quality selection via `hls.levels`.
 */
const getMasterPlaylist = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  // Make sure the camera is registered in Stream Service (re-add if config was lost)
  await streamService.startStream(camera, { quality: 'auto' });

  const playlist = await streamService.buildMasterPlaylist(camera);

  res.writeHead(200, {
    'Content-Type':                 'application/vnd.apple.mpegurl',
    'Cache-Control':                'no-store, no-cache, must-revalidate',
    // Reflect only known app origins (the request already carried a valid JWT).
    'Access-Control-Allow-Origin':  req.headers.origin || 'null',
    'Vary':                         'Origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(playlist);
});

/**
 * Media-plane authorization endpoint for nginx `auth_request` (H9).
 * nginx subrequests this before proxying /hls/ and /live/; the browser's cookie
 * (set at stream-start) rides along. Returns 204 (allow) or 401/403 (deny).
 * No JWT here — the per-camera cookie token IS the authorization, and it's only
 * ever minted for the camera's owner. When STREAM_URL_SECRET is unset, allow
 * (feature off → unchanged behavior).
 */
const verifyStreamAccess = asyncHandler(async (req, res) => {
  if (!streamToken.enabled()) return res.status(204).end();

  const uri = req.headers['x-original-uri'] || req.query.path || '';
  const monitorId = streamToken.monitorIdFromPath(uri);
  if (!monitorId) return res.status(403).end();

  // Parse the st_<monitorId> cookie from the raw header (no cookie-parser dep).
  const cookieHeader = req.headers.cookie || '';
  const want = `st_${monitorId}=`;
  const hit = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(want));
  if (!hit) return res.status(401).end();

  const [token, expires] = decodeURIComponent(hit.slice(want.length)).split('.');
  return streamToken.verify(monitorId, token, expires) ? res.status(204).end() : res.status(401).end();
});

/**
 * Admin-only: warm ANY customer's camera stream (no ownership scope) so a
 * platform admin can live-preview it in the monitoring dashboard. Same flow as
 * startStream but keyed on monitorId across all tenants. Route is behind
 * adminAuth, so it's only reachable by a platform admin.
 */
const adminStartStream = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;
  const camera = await Camera.findOne({ where: { monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);

  const { webrtcUrl, hlsUrl, hlsSubUrl, codec, transcoded } = await streamService.startStream(camera, { quality: 'auto' });
  if (streamToken.enabled()) {
    const t = streamToken.sign(monitorId);
    if (t) {
      res.cookie(`st_${monitorId}`, `${t.token}.${t.expires}`, {
        httpOnly: true, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production',
        path: '/', maxAge: Math.max(0, t.expires * 1000 - Date.now()),
      });
    }
  }
  res.json({ ok: true, monitorId, webrtcUrl, hlsUrl, hlsSubUrl, codec, transcoded });
});

/**
 * POST /api/stream/warm — renew the caller's warm lease (see streamWarm.service).
 * Answers immediately; the camera starts run in the background, paced per NVR.
 */
const warmStreams = asyncHandler(async (req, res) => {
  const { monitorIds, hevc } = req.body || {};
  const result = await require('../services/streamWarm.service').touch(req.user.id, {
    monitorIds: Array.isArray(monitorIds) ? monitorIds.slice(0, 50) : undefined,
    hevc: hevc === true,
  });
  res.status(202).json(result);
});

/**
 * One-time ticket for the live relay WebSocket (GET ws …/api/stream/live?ticket=).
 * POST /api/stream/live/:monitorId/ticket?variant=sub|main&transcode=0|1
 *
 * Also makes sure the Stream Service path exists and starts the relay, so the
 * stream warms up while the browser opens its socket. `transcode=1` is for
 * browsers that cannot decode H.265: it serves the H.264 sidecar instead.
 */
const liveTicket = asyncHandler(async (req, res) => {
  const { monitorId } = req.params;
  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });
  if (!camera) throw new AppError('Camera not found', 404);
  const variant = req.query.variant === 'main' ? 'main' : 'sub';
  const relay = require('../services/liveRelay.service');
  let transcode = req.query.transcode === '1';
  // The browser says whether it decodes H.265 (hevc=1|0). If it can't and we
  // already know this camera sends H.265, go straight to the H.264 sidecar
  // instead of making it discover that on a cold start.
  if (!transcode && req.query.hevc === '0') {
    const rawPath = await streamService.ensureLivePath(camera, { variant });
    if (/^(hvc1|hev1)/.test(relay.codecOf(rawPath) || '')) transcode = true;
  }
  // Main has the right of way on the NVR's uplink (streamWarm.yieldForMain).
  if (variant === 'main') {
    require('../services/streamWarm.service').yieldForMain(camera).catch(() => {});
  }
  const path = await streamService.ensureLivePath(camera, { variant, transcode });
  const nvrUrl = transcode ? null : streamService.liveNvrUrl(camera, variant);
  const ticket = relay.issueTicket({ userId: req.user.id, monitorId, path, variant, nvrUrl });
  res.json({ ticket, path, variant, transcode });
});

module.exports = { liveTicket, warmStreams, startStream, stopStream, getStreamStatus, getSnapshot, runWatchdog, getMasterPlaylist, verifyStreamAccess, adminStartStream };
