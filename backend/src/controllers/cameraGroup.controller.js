const { v4: uuidv4 } = require('uuid');
const { spawn }       = require('node:child_process');
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

  // Local-first: serve from the on-disk recordings volume (fast, no cloud
  // dependency — ideal for on-prem/demo). Fall back to S3 only when nothing is
  // on local disk for this group.
  let allRecordings = await localRecordings.listGroupRecordings(group.cameras || [], date || null);
  if (allRecordings.length === 0) {
    try {
      allRecordings = await s3Service.listGroupRecordings(req.user.id, group.name, date || null);
    } catch (err) {
      logger.warn('getGroupRecordings: local empty + S3 unavailable', { error: err.message });
      allRecordings = [];
    }
  }
  if (camera) allRecordings = allRecordings.filter((r) => r.cameraName === camera);

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

  let recordings = await localRecordings.listGroupRecordings([camera], req.query.date || null);
  if (recordings.length === 0) {
    try { recordings = await s3Service.listRecordings(req.user.id, group.name, camera.name, req.query.date || null); }
    catch { recordings = []; }
  }
  res.json({ success: true, data: recordings });
});

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
    const presignedUrl = String(key).startsWith('cam_')
      ? localRecordings.safeResolve(key)            // local file path for ffmpeg -i
      : await s3Service.getPlaybackUrl(key, 300);
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error', '-i', presignedUrl,
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

    if (clientGone) return;
    const jpeg = Buffer.concat(chunks);
    if (jpeg.length === 0) throw new Error('ffmpeg produced empty output');

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
    streamData = await s3Service.getReadStream(key, range);
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

module.exports = {
  listGroups, getGroup, createGroup, updateGroup, deleteGroup,
  syncGroup, reconfigureGroup, deleteCameraFromGroup,
  setCameraRetention, setGroupRetention, setCamerasRetentionBulk,
  setCameraQuality, setGroupQuality, setCamerasQualityBulk,
  getGroupRecordings, getCameraRecordings,
  getRecordingPlayUrl, streamRecording,
  getThumbnailForRecording, getRecordingDownloadUrl,
};
