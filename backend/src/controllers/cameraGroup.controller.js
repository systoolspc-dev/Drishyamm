const { v4: uuidv4 } = require('uuid');
const { spawn }       = require('node:child_process');
const os              = require('node:os');
const path            = require('node:path');
const fs              = require('node:fs');
const fsp             = require('node:fs/promises');
const { pipeline }    = require('node:stream/promises');
const asyncHandler    = require('../middleware/asyncHandler');
const { CameraGroup, Camera, sequelize } = require('../models');
const streamingService = require('../services/drishyamStreaming.service');
const reachability    = require('../services/cameraReachability.service');
const recordingRetention = require('../services/recordingRetention.service');
const { assertCameraQuota } = require('../services/cameraQuota.service');
const deviceProbe     = require('../services/deviceProbe.service');

// A camera is "online" if Stream Service is actively streaming it (ready) OR its NVR
// host answers the reachability prober. On-demand cameras aren't `ready` until
// viewed, so without the reachability term this would mark every idle-but-
// healthy camera offline — and since GET /api/groups WRITES status, it would
// fight the streamSupervisor on every 30s poll (the flip-flop bug).
function deriveStatus(readyNames, cam) {
  return (readyNames.has(streamingService.pathName(cam.monitorId)) ||
          reachability.isReachable(cam.host) === true)
    ? 'online' : 'offline';
}
const vendors         = require('../services/vendors');
const { isMeaningfulDeviceName } = require('../utils/cameraNaming');
const s3Service       = require('../services/s3.service');
const localRecordings = require('../services/localRecordings.service');
const logger          = require('../config/logger');
const AppError        = require('../utils/AppError');
const redis           = require('../config/redis');
const { ffmpegThumbnailSemaphore } = require('../utils/semaphore');
const { emit, EVENTS } = require('../events/bus');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Safely call Stream Service — degrade gracefully if the media engine is down.
 * Camera DB records are still created/updated so the watchdog can re-add them.
 */
async function tryMTX(fn) {
  try { return await fn(); }
  catch (e) {
    logger.warn('Stream Service unavailable, skipping media engine call', { error: e.message });
    return null;
  }
}

/**
 * Build the RTSP path for a channel based on device type.
 * Delegates to the per-vendor driver registry (services/vendors) — the single
 * source of truth for all vendors (Hikvision, Dahua, CP Plus, Axis, Uniview,
 * Hanwha, Bosch, Honeywell, ONVIF). Throws UnsupportedVendorError (422) for an
 * unknown deviceType instead of silently producing a Hikvision path.
 */
function buildRtspPath(channel, deviceType = 'hikvision') {
  return vendors.buildRtspPath(deviceType, channel);
}

/**
 * Pull the real per-channel names the installer already configured on the
 * device (NVR/camera) so large fleets don't need manual renaming on add.
 *
 * One probe call returns every channel's name (Hikvision ISAPI / Dahua CGI /
 * Axis param.cgi / generic ONVIF GetProfiles), so this is cheap even for a
 * 64-channel NVR. Best-effort and bounded: any failure (device offline, bad
 * creds, unsupported firmware) yields {} and the caller falls back to a
 * generated "<group> - Camera NN" name — onboarding never blocks on it.
 *
 * @returns {Promise<Object<number,string>>} map of { channelNumber: deviceName }
 *   for channels that report a non-empty name. Caller-supplied `overrides`
 *   ([{ channel, name }] reviewed in the "Discover" UI) win over the live probe.
 */
async function discoverChannelNames({ host, httpPort, username, password, deviceType, overrides }) {
  const names = {};

  try {
    const result = await deviceProbe.probe({ host, httpPort, username, password, deviceType });
    for (const ch of result?.channels || []) {
      // Only adopt a device name that is GENUINELY custom. A factory-default
      // label ("Camera 01", "CH1", "IPCamera 1", profile names like
      // "mainStream") is less useful than our group-prefixed fallback
      // ("office 13 - Camera 01"), which stays unambiguous across many NVRs.
      if (ch && ch.channel != null && isMeaningfulDeviceName(ch.name)) {
        names[ch.channel] = String(ch.name).trim();
      }
    }
  } catch (err) {
    logger.warn('device name discovery failed during onboarding; using generated names', {
      host, error: err.message,
    });
  }

  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (o && o.channel != null && o.name && String(o.name).trim()) {
        names[o.channel] = String(o.name).trim();
      }
    }
  }

  return names;
}

/**
 * Sync camera statuses for a group from Stream Service live path state.
 * Single listPaths() call covers all cameras — no per-camera round-trips.
 */
async function syncGroupStatus(group, cameras) {
  const activePaths = await tryMTX(() => streamingService.listPaths()) ?? [];
  const readyNames  = new Set(activePaths.filter((p) => p.ready).map((p) => p.name));

  let groupOnline = false;
  const updates = [];

  for (const cam of cameras) {
    const newStatus = deriveStatus(readyNames, cam);
    if (cam.status !== newStatus) {
      updates.push(cam.update({ status: newStatus }).then(() => { cam.status = newStatus; }));
    }
    if (newStatus === 'online') groupOnline = true;
  }

  if (updates.length) await Promise.all(updates);

  const newGroupStatus = groupOnline ? 'online' : 'offline';
  if (group.status !== newGroupStatus) {
    await group.update({ status: newGroupStatus });
    group.status = newGroupStatus;
  }

  return cameras;
}

// ─────────────────────────────────────────────
// GET /api/groups
// ─────────────────────────────────────────────
const listGroups = asyncHandler(async (req, res) => {
  const groups = await CameraGroup.findAll({
    where: { userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
    order: [['name', 'ASC']],
  });

  if (groups.length > 0) {
    // Single Stream Service call for all cameras across all groups
    const activePaths = await tryMTX(() => streamingService.listPaths()) ?? [];
    const readyNames  = new Set(activePaths.filter((p) => p.ready).map((p) => p.name));

    const statusUpdates = [];
    for (const group of groups) {
      let groupOnline = false;
      for (const cam of group.cameras) {
        const newStatus = deriveStatus(readyNames, cam);
        if (cam.status !== newStatus) {
          statusUpdates.push(cam.update({ status: newStatus }).then(() => { cam.status = newStatus; }));
        }
        if (newStatus === 'online') groupOnline = true;
      }
      const newGroupStatus = groupOnline ? 'online' : 'offline';
      if (group.status !== newGroupStatus) {
        statusUpdates.push(group.update({ status: newGroupStatus }).then(() => { group.status = newGroupStatus; }));
      }
    }
    if (statusUpdates.length) await Promise.all(statusUpdates);
  }

  res.json({ success: true, data: groups });
});

// ─────────────────────────────────────────────
// GET /api/groups/:groupId
// ─────────────────────────────────────────────
const getGroup = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  await syncGroupStatus(group, group.cameras);
  res.json({ success: true, data: group });
});

// ─────────────────────────────────────────────
// POST /api/groups
// Create group + auto-provision N camera channels
// ─────────────────────────────────────────────
const createGroup = asyncHandler(async (req, res) => {
  const {
    name, host, port = 554, httpPort = 80,
    username, password,
    totalChannels = 1,
    deviceType = 'hikvision',
    location,
  } = req.body;

  if (!name || !host) throw new AppError('name and host are required.', 400);
  if (totalChannels < 1 || totalChannels > 64) {
    throw new AppError('totalChannels must be between 1 and 64.', 400);
  }
  // Validate the vendor against the driver registry BEFORE any DB write so an
  // unknown/mislabeled deviceType fails with a clear 422 instead of orphaning
  // a half-provisioned group.
  vendors.getDriver(deviceType);

  const existingGroup = await CameraGroup.findOne({ where: { userId: req.user.id, host } });
  if (existingGroup) {
    throw new AppError(
      `A device at ${host} is already configured as "${existingGroup.name}". Delete it first or use the Edit option to update it.`,
      409,
    );
  }

  // Enforce the plan camera limit BEFORE creating anything, so exceeding it
  // can't leave an orphaned group + Stream Service paths behind (it used to be
  // checked after both were created).
  await assertCameraQuota(req.user.id, totalChannels);

  const safeGroupName = name.toLowerCase().replace(/\s+/g, '-');
  const s3Folder = `recordings/${req.user.id}/${safeGroupName}`;

  // Pull the real channel names already configured on the device so operators
  // don't hand-name large fleets. Best-effort (network) — do it before the DB
  // transaction so a slow probe doesn't hold a write lock open.
  const deviceNames = await discoverChannelNames({
    host, httpPort, username, password, deviceType, overrides: req.body.channels,
  });

  // Build per-channel configs
  const channelConfigs = Array.from({ length: totalChannels }, (_, i) => {
    const ch         = i + 1;
    const cameraName = deviceNames[ch] || `${name} - Camera ${String(ch).padStart(2, '0')}`;
    const monitorId  = uuidv4().replace(/-/g, '').slice(0, 24);
    const rtspPath   = buildRtspPath(ch, deviceType);
    const s3Path     = `${s3Folder}/${cameraName.toLowerCase().replace(/\s+/g, '-')}`;
    return { ch, monitorId, cameraName, rtspPath, s3Path };
  });

  // Persist the group + all cameras ATOMICALLY. If any camera row fails, the
  // group is rolled back too — no half-created group with missing channels.
  // (Stream Service is provisioned AFTER commit; the DB is the source of truth and
  // the watchdog re-adds any path that didn't land.)
  const { group, cameras } = await sequelize.transaction(async (t) => {
    const grp = await CameraGroup.create({
      userId: req.user.id,
      name, host, port, httpPort, username, password,
      deviceType, totalChannels, location, s3Folder,
      status: 'unknown',
    }, { transaction: t });

    const cams = [];
    for (const { ch, monitorId, cameraName, rtspPath, s3Path } of channelConfigs) {
      const data = {
        userId: req.user.id, groupId: grp.id, monitorId,
        name: cameraName, host, port, path: rtspPath,
        username, password, channel: ch,
        type: 'h264', width: 1920, height: 1080, fps: 25,
        s3Path, status: 'offline',
      };
      const [camera, created] = await Camera.findOrCreate({
        where: { userId: req.user.id, monitorId }, defaults: data, transaction: t,
      });
      if (!created) await camera.update(data, { transaction: t });
      cams.push(camera);
    }
    return { group: grp, cameras: cams };
  });

  // Register channels in Stream Service (post-commit, best-effort — watchdog reconciles).
  await Promise.all(channelConfigs.map(({ monitorId, rtspPath }) =>
    tryMTX(() => streamingService.addCamera(monitorId, {
      host, port, path: rtspPath, username, password,
    }))
  ));

  logger.info('CameraGroup created', { groupId: group.id, name, totalChannels });

  // Notify in-process subscribers (AI worker registry, search index, ws fanout, …)
  emit(EVENTS.GROUP_CREATED, { group, userId: req.user.id });
  for (const camera of cameras) {
    emit(EVENTS.CAMERA_CREATED, { camera, userId: req.user.id, groupName: group.name });
  }

  res.status(201).json({ success: true, data: { ...group.toJSON(), cameras } });
});

// ─────────────────────────────────────────────
// PUT /api/groups/:groupId
// Update metadata; provision new channels if totalChannels increased
// ─────────────────────────────────────────────
const updateGroup = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  const {
    name, location, status, latitude, longitude,
    host, port, httpPort, username, password, deviceType,
    totalChannels,
  } = req.body;

  const existingCount = group.cameras ? group.cameras.length : 0;
  let newTotal = group.totalChannels;
  if (totalChannels !== undefined) {
    newTotal = parseInt(totalChannels);
    if (isNaN(newTotal) || newTotal < 1) throw new AppError('totalChannels must be at least 1.', 400);
    if (newTotal < existingCount) {
      throw new AppError(
        `totalChannels cannot be less than the number of provisioned cameras (${existingCount}).`,
        400,
      );
    }
    if (newTotal > 64) throw new AppError('totalChannels must not exceed 64.', 400);
  }

  const groupUpdates = {};
  if (name         !== undefined) groupUpdates.name         = name;
  if (location     !== undefined) groupUpdates.location     = location;
  if (status       !== undefined) groupUpdates.status       = status;
  if (latitude     !== undefined) groupUpdates.latitude     = latitude;
  if (longitude    !== undefined) groupUpdates.longitude    = longitude;
  if (host         !== undefined) groupUpdates.host         = host;
  if (port         !== undefined) groupUpdates.port         = parseInt(port) || group.port;
  if (httpPort     !== undefined) groupUpdates.httpPort     = parseInt(httpPort) || group.httpPort;
  if (username     !== undefined) groupUpdates.username     = username;
  if (password     !== undefined && String(password).trim()) groupUpdates.password = password;
  if (deviceType   !== undefined) groupUpdates.deviceType   = deviceType;
  if (totalChannels !== undefined) groupUpdates.totalChannels = newTotal;

  await group.update(groupUpdates);

  const eHost       = groupUpdates.host       ?? group.host;
  const ePort       = groupUpdates.port       ?? group.port;
  const eUsername   = groupUpdates.username   ?? group.username;
  const ePassword   = groupUpdates.password   ?? group.password;
  const eDeviceType = groupUpdates.deviceType ?? group.deviceType;
  const eName       = groupUpdates.name       ?? group.name;

  // If connection details changed, update existing camera DB records + Stream Service paths
  const connectionChanged = host !== undefined || port !== undefined ||
    username !== undefined || password !== undefined;
  if (connectionChanged && group.cameras.length > 0) {
    const camUpdates = {};
    if (host     !== undefined) camUpdates.host     = eHost;
    if (port     !== undefined) camUpdates.port     = ePort;
    if (username !== undefined) camUpdates.username = eUsername;
    if (password !== undefined && String(password).trim()) camUpdates.password = ePassword;

    await Promise.all(group.cameras.map(async (cam) => {
      await cam.update(camUpdates);
      // Re-register in Stream Service with updated RTSP credentials
      await tryMTX(() => streamingService.addCamera(cam.monitorId, {
        host: eHost, port: ePort, path: cam.path, username: eUsername, password: ePassword,
      }));
    }));
  }

  // Provision new cameras if totalChannels increased
  if (newTotal > existingCount) {
    const usedChannels = (group.cameras || []).map((c) => c.channel || 0);
    const maxChannel   = usedChannels.length > 0 ? Math.max(...usedChannels) : 0;

    // Same device-name discovery as create: name the new channels from the
    // device, not "<group> - Camera NN", when the device reports a name.
    const deviceNames = await discoverChannelNames({
      host:       eHost,
      httpPort:   groupUpdates.httpPort ?? group.httpPort,
      username:   eUsername,
      password:   ePassword,
      deviceType: eDeviceType,
      overrides:  req.body.channels,
    });

    const newConfigs = Array.from({ length: newTotal - maxChannel }, (_, i) => {
      const ch         = maxChannel + i + 1;
      const monitorId  = uuidv4().replace(/-/g, '').slice(0, 24);
      const cameraName = deviceNames[ch] || `${eName} - Camera ${String(ch).padStart(2, '0')}`;
      const rtspPath   = buildRtspPath(ch, eDeviceType);
      const s3Path     = `${group.s3Folder}/${cameraName.toLowerCase().replace(/\s+/g, '-')}`;
      return { ch, monitorId, cameraName, rtspPath, s3Path };
    });

    // Enforce the plan camera limit before adding new channels to this group.
    await assertCameraQuota(req.user.id, newConfigs.length);

    await Promise.all(newConfigs.map(({ monitorId, rtspPath }) =>
      tryMTX(() => streamingService.addCamera(monitorId, {
        host: eHost, port: ePort, path: rtspPath, username: eUsername, password: ePassword,
      }))
    ));

    await Promise.all(newConfigs.map(({ ch, monitorId, cameraName, rtspPath, s3Path }) =>
      Camera.create({
        userId: req.user.id, groupId: group.id, monitorId,
        name: cameraName, host: eHost, port: ePort, path: rtspPath,
        username: eUsername, password: ePassword, channel: ch,
        type: 'h264', width: 1920, height: 1080, fps: 25,
        s3Path, status: 'offline',
      })
    ));

    logger.info('Added camera channels', { groupId: group.id, added: newTotal - existingCount });
    require('../services/platformEvents.service').noteCameras('added', {
      userId: req.user.id,
      cameras: newConfigs.map((c) => ({ name: c.cameraName, groupName: eName })),
    });
  }

  const updatedGroup = await CameraGroup.findOne({
    where: { id: group.id },
    include: [{ model: Camera, as: 'cameras' }],
    order: [[{ model: Camera, as: 'cameras' }, 'channel', 'ASC']],
  });

  res.json({ success: true, data: updatedGroup });
});

// ─────────────────────────────────────────────
// POST /api/groups/:groupId/sync
// ─────────────────────────────────────────────
const syncGroup = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  const cameras = await syncGroupStatus(group, group.cameras);

  res.json({
    success: true,
    data: {
      groupStatus: group.status,
      cameras: cameras.map((c) => ({ id: c.id, monitorId: c.monitorId, name: c.name, status: c.status })),
    },
  });
});

// ─────────────────────────────────────────────
// DELETE /api/groups/:groupId
// ─────────────────────────────────────────────
const deleteGroup = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  // Remove all camera paths (main + sub) from Stream Service in parallel
  await Promise.all(group.cameras.flatMap((cam) => [
    tryMTX(() => streamingService.removeCamera(cam.monitorId)),
    tryMTX(() => streamingService.removeCameraSubStream(cam.monitorId)),
  ]));

  // Capture before destroy() so we can emit per-camera events
  const deletedCams = group.cameras.map((c) => ({ monitorId: c.monitorId, groupId: group.id, name: c.name }));

  // Delete the camera rows EXPLICITLY. Do not rely on a DB FK cascade: the
  // groupId FK is SET NULL on delete, so destroying the group alone leaves the
  // camera rows ORPHANED (groupId=null). Those orphans then linger forever —
  // the supervisor keeps polling them and they show as phantom offline cameras
  // (this is exactly how the deleted 192.x NVR's 17 rows survived).
  const removedCount = await Camera.destroy({ where: { groupId: group.id } });

  await group.destroy();
  logger.info('CameraGroup deleted', { groupId: group.id, camerasRemoved: removedCount });

  for (const { monitorId, groupId, name } of deletedCams) {
    emit(EVENTS.CAMERA_DELETED, { monitorId, groupId, userId: req.user.id, name, groupName: group.name });
  }
  emit(EVENTS.GROUP_DELETED, { groupId: group.id, userId: req.user.id });

  res.json({ success: true, message: 'Camera group and all cameras deleted.' });
});

// ─────────────────────────────────────────────
// POST /api/groups/:groupId/reconfigure
// Re-push camera config to Stream Service (e.g. after credential change)
// ─────────────────────────────────────────────
const reconfigureGroup = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  const results = await Promise.all(group.cameras.map(async (cam) => {
    const ok = await tryMTX(() => streamingService.addCamera(cam.monitorId, {
      host:     cam.host,
      port:     cam.port,
      path:     cam.path,
      username: cam.username,
      password: cam.password,
    }));
    return { monitorId: cam.monitorId, name: cam.name, ok: ok !== null };
  }));

  const succeeded = results.filter((r) => r.ok).length;
  logger.info('reconfigureGroup complete', { groupId: group.id, succeeded, total: results.length });

  res.json({
    success: true,
    message: `Re-configured ${succeeded}/${results.length} cameras in media engine.`,
    cameras: results,
  });
});

// ─────────────────────────────────────────────
// DELETE /api/groups/:groupId/cameras/:monitorId
// ─────────────────────────────────────────────
const deleteCameraFromGroup = asyncHandler(async (req, res) => {
  const { groupId, monitorId } = req.params;

  const camera = await Camera.findOne({ where: { monitorId, groupId, userId: req.user.id } });
  if (!camera) throw new AppError('Camera not found in this group.', 404);

  const group = await CameraGroup.findOne({ where: { id: groupId, userId: req.user.id } });
  if (!group) throw new AppError('Group not found.', 404);

  await tryMTX(() => streamingService.removeCamera(monitorId));
  await tryMTX(() => streamingService.removeCameraSubStream(monitorId));
  await camera.destroy();

  const newTotal = Math.max(0, (group.totalChannels || 1) - 1);
  await group.update({ totalChannels: newTotal });

  logger.info('Camera removed from group', { groupId, monitorId, newTotal });
  emit(EVENTS.CAMERA_DELETED, { monitorId, groupId, userId: req.user.id, name: camera.name, groupName: group.name });

  res.json({ success: true, message: 'Camera channel removed successfully.', totalChannels: newTotal });
});

// ─────────────────────────────────────────────
// Recording retention (per-camera / per-location)
// ─────────────────────────────────────────────

/** Parse a retentionDays body value: a positive int, or null to clear (inherit). */
function parseRetentionDays(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;   // clear → inherit
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new AppError('retentionDays must be a positive integer, or null to inherit.', 400);
  }
  return n;
}

// POST /api/groups/:groupId/cameras/:monitorId/retention   { retentionDays }
const setCameraRetention = asyncHandler(async (req, res) => {
  const { groupId, monitorId } = req.params;
  const camera = await Camera.findOne({ where: { monitorId, groupId, userId: req.user.id } });
  if (!camera) throw new AppError('Camera not found in this group.', 404);

  const retentionDays = parseRetentionDays(req.body.retentionDays);
  await camera.update({ retentionDays });
  const effectiveDays = await recordingRetention.applyRetention(camera);

  logger.info('retention: camera override set', { monitorId, retentionDays, effectiveDays });
  res.json({ success: true, monitorId, retentionDays, effectiveDays });
});

// POST /api/groups/:groupId/cameras/retention   { monitorIds: [...], retentionDays }
// Bulk per-camera override for many cameras at once (multi-select in the UI).
const setCamerasRetentionBulk = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { monitorIds } = req.body;
  if (!Array.isArray(monitorIds) || monitorIds.length === 0) {
    throw new AppError('monitorIds must be a non-empty array.', 400);
  }
  const retentionDays = parseRetentionDays(req.body.retentionDays);

  const cameras = await Camera.findAll({
    where: { groupId, userId: req.user.id, monitorId: monitorIds },
  });
  if (!cameras.length) throw new AppError('No matching cameras in this group.', 404);

  await Camera.update(
    { retentionDays },
    { where: { groupId, userId: req.user.id, monitorId: cameras.map((c) => c.monitorId) } },
  );

  // All selected cameras get the SAME effective value: an explicit override is
  // that value; "inherit" (null) resolves to the group's effective retention.
  // Resolve once, apply in parallel.
  let days = retentionDays;
  if (days == null) {
    const group = await CameraGroup.findByPk(groupId, { attributes: ['retentionDays', 'siteId'], raw: true });
    days = await recordingRetention.resolveGroupRetentionDays(group);
  }
  const applied = await recordingRetention.applyToCameras(cameras, { days });

  logger.info('retention: bulk override set', { groupId, count: applied, retentionDays });
  res.json({ success: true, count: applied, retentionDays });
});

// POST /api/groups/:groupId/retention   { retentionDays }
// Sets the location/group default and re-applies to every camera that inherits.
const setGroupRetention = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const group = await CameraGroup.findOne({
    where: { id: groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Group not found.', 404);

  const retentionDays = parseRetentionDays(req.body.retentionDays);
  await group.update({ retentionDays });

  // Inheriting cameras (no own override) all resolve to the SAME effective
  // value — resolve once, then apply in parallel (scales to thousands).
  const groupDays  = await recordingRetention.resolveGroupRetentionDays(group);
  const inheriting = group.cameras.filter((c) => c.retentionDays == null);
  await recordingRetention.applyToCameras(inheriting, { days: groupDays });

  logger.info('retention: group default set', { groupId, retentionDays, camerasReapplied: inheriting.length });
  res.json({ success: true, groupId, retentionDays, camerasReapplied: inheriting.length });
});

// ─────────────────────────────────────────────
// Default stream quality (per-camera / per-location / bulk)
// ─────────────────────────────────────────────

const QUALITIES = ['auto', 'main', 'sub'];
/** Parse a streamQuality body value: 'auto'|'main'|'sub', or null to inherit. */
function parseQuality(raw) {
  if (raw === null || raw === '' || raw === undefined) return null;   // clear → inherit
  if (!QUALITIES.includes(raw)) {
    throw new AppError(`streamQuality must be one of ${QUALITIES.join('/')}, or null to inherit.`, 400);
  }
  return raw;
}

// POST /api/groups/:groupId/cameras/:monitorId/quality   { streamQuality }
const setCameraQuality = asyncHandler(async (req, res) => {
  const { groupId, monitorId } = req.params;
  const camera = await Camera.findOne({ where: { monitorId, groupId, userId: req.user.id } });
  if (!camera) throw new AppError('Camera not found in this group.', 404);

  const streamQuality = parseQuality(req.body.streamQuality);
  await camera.update({ streamQuality });
  res.json({ success: true, monitorId, streamQuality });
});

// POST /api/groups/:groupId/cameras/quality   { monitorIds:[...], streamQuality }
const setCamerasQualityBulk = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { monitorIds } = req.body;
  if (!Array.isArray(monitorIds) || monitorIds.length === 0) {
    throw new AppError('monitorIds must be a non-empty array.', 400);
  }
  const streamQuality = parseQuality(req.body.streamQuality);
  const [count] = await Camera.update(
    { streamQuality },
    { where: { groupId, userId: req.user.id, monitorId: monitorIds } },
  );
  res.json({ success: true, count, streamQuality });
});

// POST /api/groups/:groupId/quality   { streamQuality }
const setGroupQuality = asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const group = await CameraGroup.findOne({ where: { id: groupId, userId: req.user.id } });
  if (!group) throw new AppError('Group not found.', 404);

  const streamQuality = parseQuality(req.body.streamQuality);
  await group.update({ streamQuality });
  res.json({ success: true, groupId, streamQuality });
});

// ─────────────────────────────────────────────
// Recording endpoints — local-disk first, S3 fallback
// ─────────────────────────────────────────────

/**
 * Authorize a LOCAL recording key (cam_<monitorId>/<date>/<file>.mp4) for the
 * caller — the camera must belong to them. S3 keys carry the userId in the path
 * so they're checked inline at each call site.
 */
async function ownsLocalRecording(key, userId) {
  const mid = localRecordings.monitorIdFromKey(key);
  if (!mid) return false;
  const cam = await Camera.findOne({ where: { monitorId: mid, userId } });
  return !!cam;
}

const getGroupRecordings = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  const { date, camera } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));

  // Every camera's clips from BOTH stores (see cameraRecordingsMerged): the old
  // local-first rule hid every uploaded clip whenever one fresh, not-yet-
  // uploaded segment sat on local disk. Rows carry the camera's display name
  // so local and cloud clips group under the same camera. Newest first.
  const targets = (group.cameras || []).filter((c) => !camera || c.name === camera);
  const perCamera = await Promise.all(targets.map(async (cam) => (
    (await cameraRecordingsMerged(req.user.id, group, cam, date || null))
      .map((r) => ({ ...r, cameraName: cam.name, monitorId: cam.monitorId }))
  )));
  let allRecordings = perCamera.flat()
    .sort((a, b) => `${b.date}${b.filename}`.localeCompare(`${a.date}${a.filename}`));

  const isLocal = allRecordings.length > 0 && String(allRecordings[0].key).startsWith('cam_');

  // Optional minute-window grouping (local recordings): collapse the flood of
  // seconds-long segments into tidy time windows for the timeline UI.
  const windowMin = parseInt(req.query.window, 10);
  if (windowMin > 0 && isLocal) {
    let windows = await localRecordings.listWindows(group.cameras || [], date || null, windowMin);
    if (camera) windows = windows.filter((w) => w.cameraName === camera);
    const wTotal = windows.length;
    const wPages = Math.max(1, Math.ceil(wTotal / limit));
    const wStart = (page - 1) * limit;
    return res.json({
      success: true,
      mode: 'windows',
      data: windows.slice(wStart, wStart + limit),
      pagination: { total: wTotal, page, limit, totalPages: wPages, hasNext: page < wPages, hasPrev: page > 1 },
      source: 'local',
    });
  }

  const total      = allRecordings.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start      = (page - 1) * limit;
  const data       = allRecordings.slice(start, start + limit);

  res.json({
    success: true, mode: 'clips', data,
    pagination: { total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
    source: isLocal ? 'local' : 's3',
  });
});

const getCameraRecordings = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({ where: { id: req.params.groupId, userId: req.user.id } });
  if (!group) throw new AppError('Camera group not found.', 404);

  const camera = await Camera.findOne({
    where: { monitorId: req.params.monitorId, userId: req.user.id, groupId: group.id },
  });
  if (!camera) throw new AppError('Camera not found.', 404);

  const recordings = await cameraRecordingsMerged(req.user.id, group, camera, req.query.date || null);
  res.json({ success: true, data: recordings });
});

/**
 * One camera's recordings from BOTH stores. Uploaded clips live in the cloud
 * bucket and their local segments are deleted (RECORDING_KEEP_LOCAL=0), while
 * the newest few minutes are still on local disk waiting to be stitched. The
 * old local-first rule ("cloud only if local is empty") therefore hid every
 * uploaded clip whenever a single fresh segment existed, so a day's timeline
 * showed only its last few minutes. Merge the two, and drop a local segment
 * whose start already falls inside an uploaded clip (the brief window between
 * upload and local delete) so nothing plays twice. Every row carries `date`.
 */
async function cameraRecordingsMerged(userId, group, camera, date) {
  const local = await localRecordings.listGroupRecordings([camera], date);
  let cloud = [];
  try {
    cloud = (await s3Service.listRecordings(userId, group.name, camera.name, date))
      .map((r) => ({ ...r, date: r.date || String(r.key).split('/')[4] || date, source: 'cloud' }));
  } catch (err) {
    logger.warn('recordings: S3 list failed; serving local only', { monitorId: camera.monitorId, error: err.message });
  }
  const spans = cloud.map((r) => exportClipTimes(r.date, r.filename)).filter(Boolean);
  const localKept = local
    .filter((r) => {
      const t = exportClipTimes(r.date, r.filename);
      return !t || !spans.some((s) => t.start >= s.start && t.start < s.end);
    })
    .map((r) => ({ ...r, source: 'local' }));
  return [...cloud, ...localKept]
    .sort((a, b) => `${a.date}${a.filename}`.localeCompare(`${b.date}${b.filename}`));
}

const getRecordingPlayUrl = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw new AppError('key query parameter is required.', 400);

  if (String(key).startsWith('cam_')) {
    // Local clip — play it back through our own range-streaming proxy endpoint.
    if (!(await ownsLocalRecording(key, req.user.id))) throw new AppError('Access denied.', 403);
    const playbackUrl = `/api/groups/${req.params.groupId}/recordings/stream?key=${encodeURIComponent(key)}`;
    return res.json({ success: true, playbackUrl });
  }
  if (!key.startsWith(`recordings/${req.user.id}/`)) throw new AppError('Access denied.', 403);

  // Presigned URLs are bearer credentials — a 7-day link that leaks (shared,
  // logged, browser history) grants a week of unauthenticated access. Recording
  // clips are short, so a few hours is ample; the SPA re-fetches per play.
  const ttl = parseInt(process.env.RECORDING_PLAY_URL_TTL_SEC || '14400', 10); // 4h (was 7d)
  const playbackUrl = await s3Service.getPlaybackUrl(key, ttl);
  res.json({ success: true, playbackUrl });
});

const getThumbnailForRecording = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw new AppError('key query parameter is required.', 400);
  if (String(key).startsWith('cam_')) {
    if (!(await ownsLocalRecording(key, req.user.id))) throw new AppError('Access denied.', 403);
  } else if (!key.startsWith(`recordings/${req.user.id}/`)) {
    throw new AppError('Access denied.', 403);
  }

  const cacheKey = `thumbnail:v1:${key}`;
  const cached   = await redis.getBuffer(cacheKey);
  if (cached) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': cached.length,
      'Cache-Control': 'public, max-age=86400',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Cache': 'HIT',
    });
    return res.end(cached);
  }

  await ffmpegThumbnailSemaphore.acquire();
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {
    // The 10PB endpoint randomly resets reads (see streamS3Resumable); a fresh
    // presigned URL and another try almost always succeeds, so retry before
    // showing "No preview".
    let jpeg = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3 && !clientGone; attempt += 1) {
      try {
        const presignedUrl = String(key).startsWith('cam_')
          ? localRecordings.safeResolve(key)            // local file path for ffmpeg -i
          : await s3Service.getPlaybackUrl(key, 300);
        const ff = spawn('ffmpeg', [
          // 10PB resets reads part-way; without an I/O timeout ffmpeg sat on a dead
          // connection until the 20 s cap. 6 s, then the next attempt gets a fresh URL.
          '-loglevel', 'error', ...(String(presignedUrl).startsWith('http') ? ['-rw_timeout', '6000000'] : []), '-i', presignedUrl,
          '-vframes', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
        ]);

        req.on('close', () => ff.kill('SIGKILL'));
        const chunks  = [];
        let ffStderr  = '';
        ff.stdout.on('data', (chunk) => chunks.push(chunk));
        ff.stderr.on('data', (chunk) => { ffStderr += chunk; });

        await new Promise((resolve, reject) => {
          let settled = false;
          // Without this, an ffmpeg that hangs (stalled S3 fetch, wedged decode)
          // while the client stays connected never fires close/error — the await
          // hangs forever and the semaphore slot is never released, eventually
          // starving all thumbnail generation.
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.error('thumbnail: ffmpeg timed out; killing', { key });
            try { ff.kill('SIGKILL'); } catch (_) {}
            reject(new Error('ffmpeg thumbnail timed out'));
          }, 20_000);
          timer.unref?.();
          ff.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
              logger.error('thumbnail: ffmpeg exited non-zero', { key, code, stderr: ffStderr.slice(-300) });
              reject(new Error(`ffmpeg exited ${code}`));
            } else {
              resolve();
            }
          });
          ff.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
          });
        });

        jpeg = Buffer.concat(chunks);
        if (jpeg.length) break;
        lastErr = new Error('ffmpeg produced empty output');
      } catch (e) { lastErr = e; }
    }
    if (clientGone) return;
    if (!jpeg || jpeg.length === 0) throw lastErr || new Error('thumbnail failed');

    redis.setBuffer(cacheKey, jpeg, redis.THUMB_TTL);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length,
      'Cache-Control': 'public, max-age=86400',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Cache': 'MISS',
    });
    res.end(jpeg);
  } finally {
    ffmpegThumbnailSemaphore.release();
  }
});

/**
 * Stream a cloud clip to the browser, surviving connection resets.
 *
 * The 10PB endpoint randomly resets a GET part-way through the object
 * (measured: ~2 in 8 full-clip reads), and a plain pipe then either truncated
 * the response or left it hanging — the <video> froze or stopped mid-clip.
 * Here the response headers come from the first GET, and if the body breaks
 * before every promised byte is sent, we re-request just the remainder
 * (Range: bytes=<next>-<end>) and keep writing to the same response, so the
 * player never sees the break. Gives up after a few consecutive failures.
 */
const S3_STREAM_RETRIES = 4;
async function streamS3Resumable(req, res, key, range) {
  let clientGone = false;
  let current = null;
  req.on('close', () => { clientGone = true; try { current?.destroy(); } catch (_) {} });

  // First GET — retried, since a reset can also land before any bytes arrive.
  let first;
  for (let attempt = 1; ; attempt += 1) {
    try { first = await s3Service.getReadStream(key, range); break; } catch (err) {
      if (attempt > S3_STREAM_RETRIES || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) throw new AppError('Recording not found.', 404);
        throw err;
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }

  // Absolute byte window we promised the client.
  let startByte = 0;
  let endByte = (first.contentLength || 0) - 1;
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(first.contentRange || '');
  if (m) { startByte = parseInt(m[1], 10); endByte = parseInt(m[2], 10); }
  const total = endByte - startByte + 1;

  const headers = {
    'Content-Type': first.contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
  if (req.query.download) {
    headers['Content-Disposition'] = `attachment; filename="${String(key).split('/').pop() || 'clip.mp4'}"`;
  }
  if (range && first.contentRange) headers['Content-Range'] = first.contentRange;
  if (first.contentLength) headers['Content-Length'] = first.contentLength;
  res.writeHead(first.statusCode, headers);

  let sent = 0;
  let failures = 0;
  let body = first.stream;
  while (!clientGone && sent < total) {
    current = body;
    body.on('error', () => {}); // a broken socket can emit twice; never let it go unhandled
    const before = sent;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await new Promise((resolve) => {
      body.on('data', (chunk) => {
        let c = chunk;
        if (sent + c.length > total) c = c.subarray(0, total - sent);
        sent += c.length;
        if (!res.write(c)) { body.pause(); res.once('drain', () => body.resume()); }
      });
      body.once('end', () => resolve('end'));
      body.once('error', (err) => resolve(err));
    });
    if (clientGone || sent >= total) break;
    try { body.destroy?.(); } catch (_) {}

    // Body ended early or errored: resume from the next unsent byte.
    failures = sent > before ? 1 : failures + 1;
    if (failures > S3_STREAM_RETRIES) {
      logger.warn('streamRecording: giving up after repeated S3 resets', { key, sent, total, error: outcome?.message || outcome });
      break;
    }
    logger.info('streamRecording: S3 read broke, resuming', { key, at: startByte + sent, of: endByte + 1, error: outcome?.code || outcome?.message || outcome });
    try {
      // eslint-disable-next-line no-await-in-loop
      const next = await s3Service.getReadStream(key, `bytes=${startByte + sent}-${endByte}`);
      body = next.stream;
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300 * failures));
      body = { on() {}, once(ev, fn) { if (ev === 'error') setImmediate(() => fn(err)); }, destroy() {} };
    }
  }
  if (sent >= total) res.end(); else { try { res.destroy(); } catch (_) {} }
}

const streamRecording = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw new AppError('key query parameter is required.', 400);

  const range = req.headers.range || null;
  let streamData;
  if (String(key).startsWith('cam_')) {
    // Local recording — stream off disk with Range support.
    if (!(await ownsLocalRecording(key, req.user.id))) throw new AppError('Access denied.', 403);
    streamData = localRecordings.getReadStream(key, range);
  } else {
    if (!key.startsWith(`recordings/${req.user.id}/`)) throw new AppError('Access denied.', 403);
    return streamS3Resumable(req, res, key, range);
  }
  const { stream, contentLength, contentType, contentRange, statusCode } = streamData;

  // Guard the source stream: an S3/disk read error mid-transfer would otherwise
  // surface as an unhandled 'error' event and crash the process.
  stream.on('error', (err) => {
    logger.warn('streamRecording: source stream error', { key, error: err.message });
    if (!res.headersSent) { try { res.status(502).end(); } catch (_) {} }
    else { try { res.destroy(); } catch (_) {} }
  });

  const headers = {
    'Content-Type': contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
  if (req.query.download) {
    headers['Content-Disposition'] = `attachment; filename="${String(key).split('/').pop() || 'clip.mp4'}"`;
  }
  if (range && contentRange) headers['Content-Range'] = contentRange;
  if (contentLength) headers['Content-Length'] = contentLength;

  res.writeHead(statusCode, headers);
  stream.pipe(res);
  req.on('close', () => { try { stream.destroy(); } catch (_) {} });
});

const getRecordingDownloadUrl = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key) throw new AppError('key query parameter is required.', 400);

  // Build a clean, human, filesystem-safe download name so the browser saves a
  // recognisable video file — NOT an unnamed UUID blob. Cloud recording keys
  // are UUIDs; using the raw basename gave downloads with no extension that the
  // user couldn't find. Prefer an explicit ?name= from the client, else the key
  // basename, then guarantee a video extension.
  const raw = String(req.query.name || String(key).split('/').pop() || 'recording');
  let filename = raw.replace(/[/\\:*?"<>|]+/g, '_').replace(/\s+/g, '_').trim() || 'recording';
  if (!/\.(mp4|mkv|mov|avi|webm|ts)$/i.test(filename)) filename += '.mp4';

  if (String(key).startsWith('cam_')) {
    // Local clip — download via our own stream proxy (attachment, same-origin).
    if (!(await ownsLocalRecording(key, req.user.id))) throw new AppError('Access denied.', 403);
    const downloadUrl = `/api/groups/${req.params.groupId}/recordings/stream?key=${encodeURIComponent(key)}&download=1&name=${encodeURIComponent(filename)}`;
    return res.json({ success: true, downloadUrl, filename });
  }
  if (!key.startsWith(`recordings/${req.user.id}/`)) throw new AppError('Access denied.', 403);

  const downloadUrl = await s3Service.getDownloadUrl(key, filename, 86400);
  res.json({ success: true, downloadUrl, filename });
});

// ── Cloud clip export ─────────────────────────────────────────────────────────
// GET /api/groups/:groupId/recordings/export?monitorId=&start=&end=&name=&token=
// Cut a single MP4 covering [start,end] from the cloud/local recordings of one
// camera. The NVR export re-replays from the NVR; the cloud has discrete MP4
// clips instead, so we concat the clips that overlap the window and trim the
// result to the exact [start,end] with ffmpeg (re-encoded, so the cut is
// frame-accurate, not keyframe-rounded). Streamed as a fragmented MP4 so the
// browser saves it as it arrives.
const EXPORT_MAX_MS = parseInt(process.env.RECORDING_EXPORT_MAX_MS || '1800000', 10); // 30 min
const p2exp = (n) => String(n).padStart(2, '0');
function exportDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2exp(d.getMonth() + 1)}-${p2exp(d.getDate())}`;
}
// Absolute [start,end] of a clip, from its date + "HH-MM-SS[_to_HH-MM-SS]" name.
// The filename is device-local wall-clock and the backend runs in that same
// zone (TZ=Asia/Kolkata), so a local Date constructor lines up with playback.
function exportClipTimes(dateStr, filename) {
  const s = String(filename || '').match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (!s || !dateStr) return null;
  const [Y, M, D] = dateStr.split('-').map(Number);
  const start = new Date(Y, M - 1, D, +s[1], +s[2], +s[3]).getTime();
  const e = String(filename).match(/_to_(\d{2})-(\d{2})-(\d{2})/);
  let end;
  if (e) {
    end = new Date(Y, M - 1, D, +e[1], +e[2], +e[3]).getTime();
    if (end < start) end += 86400000; // crossed midnight
  } else {
    end = start + 60000; // raw segment with no end in the name — assume ~1 min
  }
  return { start, end };
}

const exportRecordingRange = asyncHandler(async (req, res) => {
  const group = await CameraGroup.findOne({
    where: { id: req.params.groupId, userId: req.user.id },
    include: [{ model: Camera, as: 'cameras' }],
  });
  if (!group) throw new AppError('Camera group not found.', 404);

  const monitorId = String(req.query.monitorId || '');
  const start = parseInt(req.query.start, 10);
  const end   = parseInt(req.query.end, 10);
  if (!monitorId) throw new AppError('monitorId is required.', 400);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError('Valid start and end (epoch ms, end after start) are required.', 400);
  }
  if (end - start > EXPORT_MAX_MS) {
    throw new AppError(`Clip is too long. The maximum is ${Math.round(EXPORT_MAX_MS / 60000)} minutes.`, 400);
  }
  const camera = (group.cameras || []).find((c) => c.monitorId === monitorId);
  if (!camera) throw new AppError('Camera not found in this group.', 404);

  // Gather the camera's clips for the day(s) the window spans. Local disk first
  // (fast), then the cloud bucket — the same order playback resolves them.
  const days = [...new Set([exportDayKey(start), exportDayKey(end)])];
  const recs = [];
  for (const day of days) {
    recs.push(...(await cameraRecordingsMerged(req.user.id, group, camera, day)));
  }

  // Keep the clips that overlap [start,end], in order.
  const clips = recs
    .map((r) => ({ rec: r, t: exportClipTimes(r.date, r.filename) }))
    .filter((c) => c.t && c.t.end > start && c.t.start < end)
    .sort((a, b) => a.t.start - b.t.start);

  if (!clips.length) throw new AppError('No footage in the selected range.', 404);

  // Resolve each clip to a LOCAL file for ffmpeg. Cloud clips are downloaded
  // through the S3 SDK first: letting ffmpeg read the presigned https URL
  // directly fails on the 10PB endpoint — it resets the long ranged reads an
  // MP4 demux needs ("Connection reset by peer"), and the export came out
  // truncated (a 5-min window yielded ~2 min). The SDK retries and streams the
  // whole object in one GET.
  const workDir = path.join(os.tmpdir(), `export-${uuidv4()}`);
  await fsp.mkdir(workDir, { recursive: true });
  const cleanup = () => { fsp.rm(workDir, { recursive: true, force: true }).catch(() => {}); };

  let inputs;
  try {
    inputs = await Promise.all(clips.map(async (c, i) => {
      const key = c.rec.key;
      if (String(key).startsWith('cam_')) return localRecordings.safeResolve(key);
      const dest = path.join(workDir, `${String(i).padStart(3, '0')}.mp4`);
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const { stream } = await s3Service.getReadStream(key);
          await pipeline(stream, fs.createWriteStream(dest));
          return dest;
        } catch (err) { lastErr = err; }
      }
      throw lastErr;
    }));
  } catch (err) {
    cleanup();
    logger.error('export: fetching clips failed', { error: err.message });
    throw new AppError('Could not fetch the recordings for this range. Please try again.', 502);
  }

  // Cut to the window: the output starts `offsetSec` into the first clip (an
  // output-side -ss, which decodes and discards, so it is frame-accurate), and
  // the last clip gets an `outpoint` at the window's end. Using an outpoint
  // instead of a fixed -t keeps the cut exact even when the window has a gap in
  // the footage (the concat closes gaps, so a duration would run past `end`).
  const firstStart = clips[0].t.start;
  const offsetSec  = Math.max(0, (start - firstStart) / 1000);
  const last       = clips[clips.length - 1];
  const lastOut    = Math.max(0, (Math.min(end, last.t.end) - last.t.start) / 1000);

  const listPath = path.join(workDir, 'list.txt');
  const listBody = inputs.map((u, i) => {
    const line = `file '${String(u).replace(/'/g, "'\\''")}'`;
    return i === inputs.length - 1 && last.t.end > end ? `${line}\noutpoint ${lastOut.toFixed(3)}` : line;
  }).join('\n');
  await fsp.writeFile(listPath, `${listBody}\n`, 'utf8');

  const rawName = String(req.query.name || `${camera.name}_${exportDayKey(start)}`);
  let filename = rawName.replace(/[/\\:*?"<>|]+/g, '_').replace(/\s+/g, '_').trim() || 'clip';
  if (!/\.mp4$/i.test(filename)) filename += '.mp4';

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-ss', offsetSec.toFixed(3), '-t', ((end - start) / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ]);

  let started = false;
  let ffErr = '';
  const headers = {
    'Content-Type': 'video/mp4',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  };

  const kill = () => { try { ff.kill('SIGKILL'); } catch (_) {} };
  const timer = setTimeout(() => { logger.error('export: ffmpeg timed out', { groupId: req.params.groupId }); kill(); }, 5 * 60_000);
  timer.unref?.();
  req.on('close', () => { kill(); });

  ff.stdout.on('data', (chunk) => {
    if (!started) { started = true; res.writeHead(200, headers); }
    if (!res.write(chunk)) { ff.stdout.pause(); res.once('drain', () => ff.stdout.resume()); }
  });
  ff.stderr.on('data', (b) => { ffErr += b.toString(); });
  ff.on('error', (e) => { clearTimeout(timer); cleanup(); logger.error('export: ffmpeg spawn error', { error: e.message }); if (!res.headersSent) res.status(500).json({ success: false, message: 'Export failed to start.' }); });
  ff.on('close', (code) => {
    clearTimeout(timer);
    cleanup();
    if (started) { res.end(); return; }
    logger.error('export: ffmpeg produced no output', { code, stderr: ffErr.slice(-400) });
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Could not build the clip.' });
  });
});

module.exports = {
  listGroups, getGroup, createGroup, updateGroup, deleteGroup,
  syncGroup, reconfigureGroup, deleteCameraFromGroup,
  setCameraRetention, setGroupRetention, setCamerasRetentionBulk,
  setCameraQuality, setGroupQuality, setCamerasQualityBulk,
  getGroupRecordings, getCameraRecordings,
  getRecordingPlayUrl, streamRecording,
  getThumbnailForRecording, getRecordingDownloadUrl,
  exportRecordingRange,
};
