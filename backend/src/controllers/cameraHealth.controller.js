/**
 * cameraHealth.controller.js — operator-facing system health view.
 *
 * GET /api/cameras/health
 *   Returns the live state of every camera the user owns, joined with
 *   Stream Service path data + transcoder state. The frontend polls this every
 *   ~10s to render a colour-coded health table.
 *
 * Status values (decision tree, top-down):
 *   "transcoding"  → Stream Service has a path and FFmpeg is producing _h264 output
 *   "healthy"      → ready, bytes flowing, no transcoder needed
 *   "starting"     → path exists but readyTime < ~10s — first-frame window
 *   "wobbling"     → was ready recently but currently down with bytes_in > 0
 *   "offline"      → ready=false, no bytes have ever flowed (camera unreachable)
 *   "unknown"      → Stream Service has no record of this path (DB out of sync)
 *
 * All Stream Service/transcoder reads happen in parallel and are wrapped in
 * try/catch so a slow Stream Service never delays the response — we degrade
 * gracefully and just mark unknown.
 */

const asyncHandler  = require('../middleware/asyncHandler');
const AppError      = require('../utils/AppError');
const { Camera, CameraGroup, Site } = require('../models');
const streamingService   = require('../services/drishyamStreaming.service');
const transcoderService  = require('../services/transcoder.service');
const streamQuality      = require('../services/streamQuality.service');
const streamSupervisor   = require('../services/streamSupervisor.service');
const logger             = require('../config/logger');

const COLD_START_GRACE_MS = 10_000;

function classify(camera, mtxInfo, transcoderActive, supervisorState) {
  // Cameras run ON-DEMAND: the Stream Service only pulls the NVR while someone
  // is viewing. So `mtxInfo.ready === false` is the NORMAL idle state, NOT a
  // fault. "Reachable" means the supervisor/reachability prober can still see
  // the camera (DB status online/standby) — such a camera is idle, not offline.
  // Without this, every un-watched on-demand camera showed "offline" on Health
  // while the dashboard showed "online" — the status mismatch operators hit.
  const reachable =
    supervisorState === 'standby' || supervisorState === 'streaming' ||
    camera.status === 'online' || camera.status === 'standby';

  const idle = {
    status: 'standby',
    reason: 'Idle — connects on demand when someone opens this camera',
  };

  if (!mtxInfo) {
    return reachable ? idle : { status: 'unknown', reason: 'No Stream Service path — backend may need to re-add' };
  }

  const readyTime    = mtxInfo.readyTime ? new Date(mtxInfo.readyTime).getTime() : null;
  const readSinceMs  = readyTime ? Date.now() - readyTime : null;
  const inboundBytes = mtxInfo.inboundBytes || 0;

  if (mtxInfo.ready) {
    if (transcoderActive) {
      return { status: 'transcoding', reason: 'H.265 → H.264 transcoder running' };
    }
    if (readSinceMs !== null && readSinceMs < COLD_START_GRACE_MS) {
      return { status: 'starting', reason: 'Camera just connected, muxer warming up' };
    }
    return { status: 'healthy', reason: 'Streaming normally' };
  }

  // Not currently pulling. If the camera is still reachable it's just idle
  // (on-demand); only call it offline when the prober can't reach it either.
  if (inboundBytes === 0) {
    return reachable
      ? idle
      : { status: 'offline', reason: 'No RTSP data and camera unreachable — check power, cable, NVR channel and credentials' };
  }
  return {
    status: 'wobbling',
    reason: 'Was streaming earlier; RTSP source dropped — usually network/NVR load',
  };
}

/**
 * "Last Update" for one camera — the freshest moment we actually KNOW
 * something about it, which is what an operator reads that column for.
 *
 * Video arriving is the strongest signal, so it wins when a camera is
 * streaming. For one that is not, the newest of its state change / ready time
 * / persisted last-seen / last-offline stands in: for an offline camera that
 * is the moment it dropped, which is exactly the time an operator is looking
 * for. Nothing here invents a timestamp — a camera we have never observed
 * returns null and the column shows a dash.
 */
function lastUpdateAt(camera, mtxInfo, supervisor) {
  const times = [
    supervisor?.lastDataAt,
    supervisor?.enteredStateAt,
    mtxInfo?.readyTime ? Date.parse(mtxInfo.readyTime) : null,
    camera.lastSeenAt ? new Date(camera.lastSeenAt).getTime() : null,
    camera.lastOfflineAt ? new Date(camera.lastOfflineAt).getTime() : null,
  ].filter((t) => Number.isFinite(t));

  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

// The global half of a health read — Stream Service paths, transcoders,
// stream quality, supervisor — fetched ONCE so it can be applied to any number
// of cameras (one account here, every account in the admin Accounts list).
async function loadHealthContext() {
  // Bulk-fetch Stream Service path state once (vs N round-trips)
  let mtxItems = [];
  try {
    const r = await streamingService.api.get('/v3/paths/list', { timeout: 3000 });
    mtxItems = r.data?.items || [];
  } catch (err) {
    logger.warn('cameraHealth: Stream Service list failed', { error: err.message });
  }
  return {
    mtxOk: mtxItems.length > 0,
    mtxByName: new Map(mtxItems.map((it) => [it.name, it])),
    transcodersByMonitor: new Map(transcoderService.listActive().map((t) => [t.monitorId, t])),
    qualityByMonitor: streamQuality.snapshot(),
    supervisorByMonitor: new Map(
      (streamSupervisor.snapshot().cameras || []).map((entry) => [entry.monitorId, entry]),
    ),
  };
}

/** Just the engine state of one camera (needs only id/monitorId/status). */
function classifyCamera(c, ctx) {
  const mtx = ctx.mtxByName.get(streamingService.pathName(c.monitorId)) || null;
  const transcoder = ctx.transcodersByMonitor.get(c.monitorId) || null;
  const supervisor = ctx.supervisorByMonitor.get(c.monitorId) || null;
  return classify(c, mtx, !!transcoder, supervisor?.state);
}

// Core health computation for one organization's cameras. Everything except
// the camera query (MediaMTX paths, transcoders, quality, supervisor) is global,
// so this same logic serves both the owner (getHealth) and a platform admin
// monitoring a specific customer (getHealthForUser). `userId` may be one id
// or a list (an account owner plus its sub-users).
async function computeHealth(userId) {
  // Pull cameras for this user with their group + site
  const cameras = await Camera.findAll({
    where: { userId },
    attributes: [
      'id', 'monitorId', 'name', 'channel', 'groupId', 'status',
      // Persisted history — survives a backend restart, which the in-memory
      // supervisor state does not, so the Health table still has a "last
      // update" and a flap count for every camera after a deploy.
      'lastSeenAt', 'lastOfflineAt', 'flapCount24h',
    ],
    include: [{
      model: CameraGroup,
      as: 'group',
      attributes: ['id', 'name', 'siteId', 'host'],
      include: [{ model: Site, as: 'site', attributes: ['id', 'name'] }],
    }],
    order: [['name', 'ASC']],
  });

  const ctx = await loadHealthContext();

  // Build per-camera rows
  const rows = cameras.map((c) => {
    const mtx = ctx.mtxByName.get(streamingService.pathName(c.monitorId)) || null;
    const transcoder = ctx.transcodersByMonitor.get(c.monitorId) || null;
    const quality = ctx.qualityByMonitor[c.monitorId] || null;
    const supervisor = ctx.supervisorByMonitor.get(c.monitorId) || null;
    const { status, reason } = classify(c, mtx, !!transcoder, supervisor?.state);

    const tracks = (mtx?.tracks2 || []);
    const video  = tracks.find((t) => t.codec === 'H264' || t.codec === 'H265');
    const audio  = tracks.find((t) => t.codec !== 'H264' && t.codec !== 'H265');
    const readSinceSec = mtx?.readyTime
      ? Math.round((Date.now() - new Date(mtx.readyTime).getTime()) / 1000)
      : null;

    return {
      id:            c.id,
      monitorId:     c.monitorId,
      name:          c.name,
      channel:       c.channel,
      groupId:       c.groupId,
      groupName:     c.group?.name || null,
      siteId:        c.group?.site?.id || null,
      siteName:      c.group?.site?.name || null,
      status,
      reason,
      codec:         video?.codec || null,
      resolution:    video ? `${video.codecProps.width}x${video.codecProps.height}` : null,
      audioCodec:    audio?.codec || null,
      ready:         mtx?.ready ?? false,
      readSinceSec,
      inboundBytes:  mtx?.inboundBytes || 0,
      framesInError: mtx?.inboundFramesInError || 0,
      readers:       quality?.readers ?? (mtx?.readers || []).length,
      jitterMs:      quality?.jitterMs ?? 0,
      fieRate:       quality?.fieRate ?? 0,
      meanBps:       quality?.meanBps ?? 0,
      healsToday:    quality?.healsToday ?? 0,
      bpsIn:         supervisor?.bpsIn ?? 0,
      supervisorState: supervisor?.state || null,
      // In-memory flap count is reset by a restart; the persisted 24 h counter
      // is not. Report whichever knows about more drops.
      flapCount:     Math.max(supervisor?.flapCount ?? 0, c.flapCount24h ?? 0),
      lastUpdate:    lastUpdateAt(c, mtx, supervisor),
      lastSeenAt:    c.lastSeenAt ? new Date(c.lastSeenAt).toISOString() : null,
      lastOfflineAt: c.lastOfflineAt ? new Date(c.lastOfflineAt).toISOString() : null,
      transcoder:    transcoder
        ? { running: transcoder.alive, uptimeSec: transcoder.uptimeSec, restarts: transcoder.restartCount }
        : null,
    };
  });

  // Roll-up summary
  const summary = rows.reduce((acc, r) => {
    acc.total += 1;
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, { total: 0 });

  return {
    success:     true,
    summary,
    cameras:     rows,
    lastUpdated: new Date().toISOString(),
    mediamtxOk:  ctx.mtxOk,
  };
}

// Owner view — the caller's own organization.
const getHealth = asyncHandler(async (req, res) => {
  res.json(await computeHealth(req.user.id));
});

// Platform-admin view — live stream health for a SPECIFIC customer. Gated by
// adminAuth on the route. Lets the admin see how each of a client's cameras is
// streaming (codec/fps/transcoder/flap) during a trial installation.
const getHealthForUser = asyncHandler(async (req, res) => {
  if (!req.params.userId) throw new AppError('userId is required.', 400);
  res.json(await computeHealth(req.params.userId));
});

module.exports = { getHealth, getHealthForUser, computeHealth, loadHealthContext, classifyCamera };
