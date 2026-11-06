/**
 * restrictedZone.controller.js — CRUD for user-drawn restricted zones.
 * Zones are per-user + per-camera; a user may have many per camera and across
 * cameras (each is a row). Scoped to req.user.id.
 */
const asyncHandler = require('../middleware/asyncHandler');
const { RestrictedZone } = require('../models');
const { assertAiLicence } = require('../services/entitlements.service');

// A camera spends one restricted-zone licence while it has at least one armed
// zone, so arming the FIRST zone on a camera is the licensed step.
async function assertZoneLicence(req, monitorId) {
  const armed = await RestrictedZone.count({
    where: { userId: req.user.id, monitorId: String(monitorId), enabled: true },
  });
  if (armed === 0) await assertAiLicence(req.user.id, 'restricted_zone', 1);
}

// GET /api/restricted-zones?monitorId=...
const list = asyncHandler(async (req, res) => {
  const where = { userId: req.user.id };
  if (req.query.monitorId) where.monitorId = String(req.query.monitorId);
  const zones = await RestrictedZone.findAll({ where, order: [['created_at', 'DESC']] });
  res.json({ success: true, zones });
});

// POST /api/restricted-zones
const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.monitorId || !b.name) {
    return res.status(400).json({ success: false, message: 'Camera and zone name are required.' });
  }
  if (b.enabled !== false) await assertZoneLicence(req, b.monitorId);
  const zone = await RestrictedZone.create({
    userId: req.user.id,
    monitorId: String(b.monitorId),
    cameraName: b.cameraName ? String(b.cameraName).slice(0, 120) : null,
    name: String(b.name).slice(0, 120),
    shape: b.shape === 'rectangle' ? 'rectangle' : 'polygon',
    points: Array.isArray(b.points) ? b.points : null,
    rect: b.rect && typeof b.rect === 'object' ? b.rect : null,
    priority: b.priority || 'high',
    schedule: b.schedule || 'always',
    armWindow: b.armWindow || b.window || null,
    dwellSec: Number.isFinite(+b.dwellSec) ? +b.dwellSec : 5,
    alertOnEntry: b.alertOnEntry !== false,
    allowed: Array.isArray(b.allowed) ? b.allowed : [],
    enabled: b.enabled !== false,
  });
  res.status(201).json({ success: true, zone });
});

// PUT /api/restricted-zones/:id
const update = asyncHandler(async (req, res) => {
  const zone = await RestrictedZone.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!zone) return res.status(404).json({ success: false, message: 'Zone not found.' });
  const b = req.body || {};
  if (b.enabled === true && zone.enabled !== true) await assertZoneLicence(req, zone.monitorId);
  const patch = {};
  ['name', 'priority', 'schedule', 'shape', 'cameraName'].forEach((k) => { if (b[k] != null) patch[k] = b[k]; });
  if (b.points != null) patch.points = b.points;
  if (b.rect != null) patch.rect = b.rect;
  if (b.armWindow != null || b.window != null) patch.armWindow = b.armWindow || b.window;
  if (b.dwellSec != null) patch.dwellSec = +b.dwellSec;
  if (typeof b.alertOnEntry === 'boolean') patch.alertOnEntry = b.alertOnEntry;
  if (Array.isArray(b.allowed)) patch.allowed = b.allowed;
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  await zone.update(patch);
  res.json({ success: true, zone });
});

// DELETE /api/restricted-zones/:id
const remove = asyncHandler(async (req, res) => {
  const n = await RestrictedZone.destroy({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) return res.status(404).json({ success: false, message: 'Zone not found.' });
  res.json({ success: true, removed: n });
});

module.exports = { list, create, update, remove };
