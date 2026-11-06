const asyncHandler = require('../middleware/asyncHandler');
const { User, Camera, Subscription, Plan } = require('../models');
const shinobiService = require('../services/shinobi.service');
const streamingService = require('../services/drishyamStreaming.service');
const { bus, EVENTS } = require('../events/bus');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');

/**
 * Verify user owns this groupKey (prevents cross-user access)
 */
async function verifyGroupKeyOwnership(userId, groupKey) {
  const user = await User.findByPk(userId);
  if (!user) {
    throw new AppError('User not found.', 404);
  }
  // Legacy Shinobi tenancy check. In Stream Service mode group_key is null by
  // design (see auth.controller) and cameras are already scoped by user_id
  // in every query below, so we skip the check. Only a user that actually
  // has a group_key must present the matching one.
  if (user.groupKey && groupKey && user.groupKey !== groupKey) {
    throw new AppError('Unauthorized: Invalid group key.', 403);
  }
  return user;
}

/**
 * Try to call Shinobi, but don't fail if it's unavailable
 */
async function tryShinobi(fn) {
  try {
    return await fn();
  } catch (error) {
    logger.warn('Shinobi VMS unavailable, using local DB only', { error: error.message });
    return null;
  }
}

const getCameras = asyncHandler(async (req, res) => {
  const { groupKey } = req.query;
  const user = await verifyGroupKeyOwnership(req.user.id, groupKey);

  // Fetch live status from Shinobi and sync to local DB
  const shinobiMonitors = await tryShinobi(() =>
    shinobiService.getCameras(user.apiKey, groupKey)
  );

  if (shinobiMonitors && Array.isArray(shinobiMonitors)) {
    for (const m of shinobiMonitors) {
      const isOnline =
        m.running === '1' || m.running === 1 || m.running === true ||
        m.status === 'Recording' || m.status === 'Watching';
      const status = isOnline ? 'online' : 'offline';

      // Upsert: insert camera if not in local DB, otherwise just update status
      const [, created] = await Camera.findOrCreate({
        where: { userId: req.user.id, monitorId: m.mid },
        defaults: {
          userId: req.user.id,
          monitorId: m.mid,
          name: m.name || m.mid,
          type: m.type || 'h264',
          host: m.host || '',
          port: parseInt(m.port, 10) || 554,
          path: m.path || '',
          width: m.width ? parseInt(m.width, 10) : null,
          height: m.height ? parseInt(m.height, 10) : null,
          fps: m.fps ? parseInt(m.fps, 10) : 30,
          status,
        },
      });

      if (!created) {
        await Camera.update(
          { status },
          { where: { userId: req.user.id, monitorId: m.mid } }
        );
      }
    }
  }

  // Return fresh data from local DB
  const cameras = await Camera.findAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
  });

  res.json(cameras.map((c) => ({
    mid: c.monitorId,
    name: c.name,
    type: c.type,
    host: c.host,
    port: c.port,
    path: c.path,
    width: c.width,
    height: c.height,
    fps: c.fps,
    status: c.status,
    mode: c.status === 'online' ? 'start' : 'stop',
  })));
});

const getCamera = asyncHandler(async (req, res) => {
  const { groupKey } = req.query;
  const { monitorId } = req.params;
  await verifyGroupKeyOwnership(req.user.id, groupKey);

  const camera = await Camera.findOne({
    where: { userId: req.user.id, monitorId },
  });

  if (!camera) {
    throw new AppError('Camera not found.', 404);
  }

  res.json({
    mid: camera.monitorId,
    name: camera.name,
    type: camera.type,
    host: camera.host,
    port: camera.port,
    path: camera.path,
    width: camera.width,
    height: camera.height,
    fps: camera.fps,
    status: camera.status,
    mode: camera.status === 'online' ? 'start' : 'stop',
  });
});

const addCamera = asyncHandler(async (req, res) => {
  const { groupKey, mid, name, type, host, port, path, username, password, width, height, fps, protocol } = req.body;
  const user = await verifyGroupKeyOwnership(req.user.id, groupKey);

  // NOTE: Shinobi is dead code — the live camera-create paths are in
  // cameraGroup.controller (create / add-channels) and bulkImport.controller,
  // where plan-limit enforcement now lives via services/cameraQuota.service.
  // (The old inline check that used to sit here has moved there.)

  // Try to add to Shinobi (non-blocking if unavailable)
  const cameraConfig = { name, type, protocol, host, port, path, username, password, width, height, fps };
  await tryShinobi(() => shinobiService.addCamera(user.apiKey, groupKey, mid, cameraConfig));

  // Save to local DB
  const camera = await Camera.create({
    userId: req.user.id,
    monitorId: mid,
    name,
    type: type || 'h264',
    host,
    port: parseInt(port, 10) || 554,
    path: path || '',
    width: width ? parseInt(width, 10) : null,
    height: height ? parseInt(height, 10) : null,
    fps: fps ? parseInt(fps, 10) : 30,
    status: 'offline',
  });

  res.status(201).json({
    ok: true,
    mid: camera.monitorId,
    name: camera.name,
    type: camera.type,
    host: camera.host,
    port: camera.port,
    path: camera.path,
    width: camera.width,
    height: camera.height,
    fps: camera.fps,
    status: camera.status,
  });
});

const updateCamera = asyncHandler(async (req, res) => {
  const { groupKey, ...cameraData } = req.body;
  const { monitorId } = req.params;
  const user = await verifyGroupKeyOwnership(req.user.id, groupKey);

  // Try Shinobi update (non-blocking)
  await tryShinobi(() => shinobiService.updateCamera(user.apiKey, groupKey, monitorId, cameraData));

  // Update local DB
  await Camera.update(
    {
      name: cameraData.name,
      type: cameraData.type,
      host: cameraData.host,
      port: cameraData.port ? parseInt(cameraData.port, 10) : undefined,
      path: cameraData.path,
    },
    { where: { userId: req.user.id, monitorId } }
  );

  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });

  res.json({
    ok: true,
    mid: camera.monitorId,
    name: camera.name,
    type: camera.type,
    host: camera.host,
    port: camera.port,
    path: camera.path,
    status: camera.status,
  });
});

const deleteCamera = asyncHandler(async (req, res) => {
  const { groupKey } = req.query;
  const { monitorId } = req.params;
  const user = await verifyGroupKeyOwnership(req.user.id, groupKey);

  // Capture the row before deletion so we can scope the delete event.
  const camera = await Camera.findOne({ where: { userId: req.user.id, monitorId } });

  // Try Shinobi delete (non-blocking)
  await tryShinobi(() => shinobiService.deleteCamera(user.apiKey, groupKey, monitorId));

  // Tear down the Stream Service paths (main + sub) so the deleted camera stops
  // pulling RTSP and disappears from the media engine. Best-effort: if Stream Service
  // is momentarily down, the recordingSync watchdog's orphan-reconciliation
  // pass purges the leftover path on a later tick.
  await Promise.allSettled([
    streamingService.removeCamera(monitorId),
    streamingService.removeCameraSubStream(monitorId),
  ]);

  // Remove from local DB
  await Camera.destroy({ where: { userId: req.user.id, monitorId } });

  // Let the supervisor/quality services forget their in-memory state for this
  // camera (CAMERA_DELETED listener wired in server.js).
  if (camera) {
    bus.emit(EVENTS.CAMERA_DELETED, {
      monitorId,
      userId: req.user.id,
      groupId: camera.groupId ?? null,
    });
  }

  res.json({ ok: true, message: 'Camera deleted successfully.' });
});

const getRecordings = asyncHandler(async (req, res) => {
  const { groupKey, start, end } = req.query;
  const { monitorId } = req.params;
  const user = await verifyGroupKeyOwnership(req.user.id, groupKey);

  // Try Shinobi recordings, return empty array if unavailable
  const recordings = await tryShinobi(() =>
    shinobiService.getRecordings(user.apiKey, groupKey, monitorId, start, end)
  );

  res.json(recordings || []);
});

module.exports = { getCameras, getCamera, addCamera, updateCamera, deleteCamera, getRecordings };
