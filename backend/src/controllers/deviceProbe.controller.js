/**
 * deviceProbe.controller.js
 *
 * REST endpoints for probing NVRs / cameras to discover their device-side
 * configuration (channel names, model, video presence) before a group is
 * actually created in our DB.
 *
 *   POST /api/groups/probe        — probe BEFORE saving (frontend "Discover"
 *                                   button); body has the connection details
 *
 *   POST /api/groups/:groupId/probe — probe an EXISTING group (uses stored
 *                                     credentials); used by "refresh names"
 *
 *   POST /api/groups/:groupId/sync-names — probe + write discovered names
 *                                          back into Camera.name for every
 *                                          channel that has one on the device
 *                                          and isn't already user-edited.
 *
 * The "isn't already user-edited" part is heuristic: we only overwrite cameras
 * whose current name still looks auto-generated (matches `<group> - Camera NN`
 * or matches the pattern we set during initial provisioning). This lets users
 * who manually renamed a camera keep their name; first-time discovery picks
 * up real names right away.
 */

const Joi = require('joi');

const AppError       = require('../utils/AppError');
const logger         = require('../config/logger');
const deviceProbe    = require('../services/deviceProbe.service');
const vendors        = require('../services/vendors');
const { isMeaningfulDeviceName } = require('../utils/cameraNaming');
const { CameraGroup, Camera } = require('../models');

// ── Validation schemas ───────────────────────────────────────────────────────

const probeBodySchema = Joi.object({
  host:        Joi.string().hostname().required(),
  httpPort:    Joi.number().integer().min(1).max(65535).default(80),
  username:    Joi.string().allow('').required(),
  password:    Joi.string().allow('').required(),
  deviceType:  Joi.string().valid(...vendors.listAcceptedTypes()).default('hikvision'),
}).required();

// Heuristic: did we set this name automatically during provisioning?
// (Auto-named cameras look like "MyGroup - Camera 01" or "Camera 1".)
function looksAutoNamed(camName, groupName) {
  if (!camName) return true;
  const trimmed = String(camName).trim();
  if (/^Camera\s+\d+$/i.test(trimmed)) return true;
  if (groupName && new RegExp(`^${escapeRegex(groupName)}\\s*[-_]\\s*Camera\\s*\\d+$`, 'i').test(trimmed)) return true;
  return false;
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * POST /api/groups/probe
 * Body: { host, httpPort, username, password, deviceType }
 * Returns: { vendor, model, deviceName, channels: [{ channel, name, hasVideo }] }
 */
async function probeUnsaved(req, res) {
  const { value, error } = probeBodySchema.validate(req.body);
  if (error) throw new AppError(error.details.map((d) => d.message).join('; '), 400);

  const result = await deviceProbe.probe(value);
  logger.info('[DeviceProbe] unsaved probe complete', {
    host: value.host, vendor: result.vendor, channels: result.channels.length,
  });
  res.json({
    success: true,
    ...result,
  });
}

/**
 * POST /api/groups/:groupId/probe
 * No body — uses stored credentials. Read-only: never writes back to DB.
 */
async function probeExisting(req, res) {
  const { groupId } = req.params;
  const group = await CameraGroup.findOne({
    where: { id: groupId, userId: req.user.id },
  });
  if (!group) throw new AppError('Group not found', 404);

  const result = await deviceProbe.probe({
    host:       group.host,
    httpPort:   group.httpPort || 80,
    username:   group.username,
    password:   group.password,
    deviceType: group.deviceType,
  });

  res.json({
    success: true,
    groupId: group.id,
    ...result,
  });
}

/**
 * POST /api/groups/:groupId/sync-names
 * Probe device + overwrite Camera.name for cameras that look auto-named.
 *
 * Returns: { updated: [{ monitorId, oldName, newName }], skipped: [...] }
 */
async function syncNames(req, res) {
  const { groupId } = req.params;
  const group = await CameraGroup.findOne({
    where: { id: groupId, userId: req.user.id },
  });
  if (!group) throw new AppError('Group not found', 404);

  const probe = await deviceProbe.probe({
    host:       group.host,
    httpPort:   group.httpPort || 80,
    username:   group.username,
    password:   group.password,
    deviceType: group.deviceType,
  });

  const cameras = await Camera.findAll({ where: { groupId } });

  const updated = [];
  const skipped = [];

  for (const ch of probe.channels) {
    if (!ch.name || !ch.channel) {
      skipped.push({ channel: ch.channel, reason: 'no name on device' });
      continue;
    }
    // A factory-default device label ("Camera 01", ONVIF "mainStream") is less
    // useful than the existing group-prefixed name — don't adopt it.
    if (!isMeaningfulDeviceName(ch.name)) {
      skipped.push({ channel: ch.channel, deviceName: ch.name, reason: 'device name is a factory default' });
      continue;
    }
    const cam = cameras.find((c) => c.channel === ch.channel);
    if (!cam) {
      skipped.push({ channel: ch.channel, reason: 'no matching camera in DB' });
      continue;
    }
    if (!looksAutoNamed(cam.name, group.name)) {
      skipped.push({
        channel: ch.channel, monitorId: cam.monitorId,
        currentName: cam.name, deviceName: ch.name,
        reason: 'user-edited name preserved',
      });
      continue;
    }
    if (cam.name === ch.name) {
      skipped.push({ channel: ch.channel, reason: 'name already in sync' });
      continue;
    }
    const oldName = cam.name;
    await cam.update({ name: ch.name });
    updated.push({ monitorId: cam.monitorId, channel: ch.channel, oldName, newName: ch.name });
  }

  logger.info('[DeviceProbe] sync-names complete', {
    groupId, updated: updated.length, skipped: skipped.length,
  });
  res.json({
    success: true,
    groupId,
    vendor: probe.vendor,
    deviceName: probe.deviceName,
    model: probe.model,
    updated,
    skipped,
  });
}

// ── Keyframe acceleration writer ─────────────────────────────────────────────

const keyframeBodySchema = Joi.object({
  channel:      Joi.number().integer().min(1).max(64).default(1),
  gopSec:       Joi.number().min(0.5).max(10).default(1),
  fps:          Joi.number().min(1).max(60).default(25),
  profileToken: Joi.string().optional(),       // ONVIF only
}).required();

/**
 * POST /api/groups/:groupId/cameras/:monitorId/keyframe-interval
 * Body: { channel?, gopSec?, fps?, profileToken? }
 *
 * Writes a new GOP length to the device. Snappy viewer pop-in needs gopSec ~ 1.
 */
async function setKeyframeInterval(req, res) {
  const { groupId, monitorId } = req.params;
  const { value, error } = keyframeBodySchema.validate(req.body || {});
  if (error) throw new AppError(error.details.map((d) => d.message).join('; '), 400);

  const group = await CameraGroup.findOne({ where: { id: groupId, userId: req.user.id } });
  if (!group) throw new AppError('Group not found', 404);

  const cam = await Camera.findOne({ where: { groupId, monitorId } });
  if (!cam) throw new AppError('Camera not found', 404);

  const result = await require('../services/deviceProbe.service').setKeyframeInterval({
    host:       group.host,
    httpPort:   group.httpPort || 80,
    username:   group.username,
    password:   group.password,
    deviceType: group.deviceType,
    channel:    value.channel || cam.channel || 1,
    gopSec:     value.gopSec,
    fps:        value.fps || cam.fps || 25,
    profileToken: value.profileToken,
  });

  logger.info('[DeviceProbe] setKeyframeInterval', { groupId, monitorId, ...result });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, ...result });
}

// ── Full encoder writer (bitrate + GOP + fps in one shot) ────────────────────

const encoderBodySchema = Joi.object({
  channel:      Joi.number().integer().min(1).max(64).default(1),
  bitrateKbps:  Joi.number().integer().min(256).max(20000).default(4096),
  gopSec:       Joi.number().min(0.5).max(10).default(1),
  fps:          Joi.number().min(1).max(60).default(25),
  profileToken: Joi.string().optional(),
}).required();

/**
 * POST /api/groups/:groupId/cameras/:monitorId/encoder
 * Body: { channel?, bitrateKbps?, gopSec?, fps?, profileToken? }
 *
 * Pushes a fuller encoder profile to the camera in a single call. Fixes the
 * #1 perceived "stream is blurry" complaint, which usually traces to the
 * camera's encoder being configured to a low bitrate at the source.
 */
async function setEncoder(req, res) {
  const { groupId, monitorId } = req.params;
  if (!groupId || groupId === 'undefined' || groupId === 'null') {
    throw new AppError('groupId missing — pass selectedCamera.groupId from the frontend', 400);
  }
  const { value, error } = encoderBodySchema.validate(req.body || {});
  if (error) throw new AppError(error.details.map((d) => d.message).join('; '), 400);

  const group = await CameraGroup.findOne({ where: { id: groupId, userId: req.user.id } });
  if (!group) throw new AppError('Group not found or not owned by user', 404);
  const cam = await Camera.findOne({ where: { groupId, monitorId } });
  if (!cam) throw new AppError('Camera not found in group', 404);

  let result;
  try {
    result = await require('../services/deviceProbe.service').setEncoderConfig({
      host:       group.host,
      httpPort:   group.httpPort || 80,
      username:   group.username,
      password:   group.password,
      deviceType: group.deviceType,
      channel:    value.channel || cam.channel || 1,
      bitrateKbps: value.bitrateKbps,
      gopSec:     value.gopSec,
      fps:        value.fps || cam.fps || 25,
      profileToken: value.profileToken,
    });
  } catch (err) {
    // Network / parse failures from the device should be 502 (bad upstream),
    // not 500 (our bug). The 500 the frontend was seeing was an unhandled
    // throw bubbling from deeper in the writer.
    logger.warn('[DeviceProbe] setEncoder threw', { groupId, monitorId, error: err.message });
    return res.status(502).json({ success: false, error: err.message });
  }

  logger.info('[DeviceProbe] setEncoder', { groupId, monitorId, ...result });
  res.status(result.ok ? 200 : 502).json({ success: result.ok, ...result });
}

/**
 * GET /api/groups/:groupId/cameras/:monitorId/encoder-debug
 *
 * Returns the raw GET response from the camera/NVR's encoder endpoint —
 * useful when a Boost call returns "no encoder fields matched" and we need
 * to see what XML the firmware actually exposes so we can extend the
 * schema list. Authenticated; no writes.
 */
async function encoderDebug(req, res) {
  const { groupId, monitorId } = req.params;
  const group = await CameraGroup.findOne({ where: { id: groupId, userId: req.user.id } });
  if (!group) throw new AppError('Group not found', 404);
  const cam = await Camera.findOne({ where: { groupId, monitorId } });
  if (!cam) throw new AppError('Camera not found', 404);

  const channel = cam.channel || 1;
  const candidatePaths = [
    `/ISAPI/Streaming/channels/${channel * 100 + 1}`,
    `/ISAPI/ContentMgmt/StreamingProxy/channels/${channel * 100 + 1}`,
    `/ISAPI/ContentMgmt/InputProxy/channels/${channel}/video`,
  ];
  const out = [];
  const { digestRequest } = require('../utils/digestAuth');
  for (const p of candidatePaths) {
    try {
      const r = await digestRequest({
        url: `http://${group.host}:${group.httpPort || 80}${p}`,
        username: group.username, password: group.password,
        timeout: 4000,
      });
      out.push({
        path: p,
        status: r.status,
        // First 4 KB is enough to see the encoder schema; trim to keep
        // responses small.
        body: String(r.data || '').slice(0, 4096),
        encoderTags: [...new Set((String(r.data || '').match(/<\w[\w:-]+>/g) || [])
          .map((t) => t.slice(1, -1))
          .filter((t) => /(rate|gov|key|quality|frame|bit)/i.test(t)))],
      });
    } catch (err) {
      out.push({ path: p, error: err.message });
    }
  }
  res.json({ success: true, deviceType: group.deviceType, channel, results: out });
}

module.exports = { probeUnsaved, probeExisting, syncNames, setKeyframeInterval, setEncoder, encoderDebug };
