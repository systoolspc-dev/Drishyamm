/**
 * space.controller — rooms for occupancy analytics.
 *
 * A space is 1..N cameras plus a capacity. The only subtle field is
 * `overlapGroup` on each member: cameras that SEE THE SAME PEOPLE must share
 * one, or the room double-counts (docs/OCCUPANCY_LOGIC.md §2.1).
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize, Space, SpaceCamera, Camera } = require('../models');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { getClient } = require('../config/redis');
const { fuseSpace } = require('../services/occupancy/fuse');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);

/** Latest gauge sample per camera (same shape the evaluator consumes). */
async function readSamples(monitorIds) {
  const redis = getClient();
  if (!redis || !monitorIds.length) return {};
  const out = {};
  try {
    const vals = await redis.mget(monitorIds.map((m) => `occupancy:live:${m}`));
    monitorIds.forEach((m, i) => {
      if (!vals[i]) return;
      try {
        const g = JSON.parse(vals[i]);
        out[m] = {
          heads: g.heads, connected: g.connected,
          reliable: g.quality === 'measured',
          ageSec: g.ts ? (Date.now() - g.ts) / 1000 : null,
          degraded: g.degraded,
        };
      } catch { /* skip */ }
    });
  } catch { /* no samples ⇒ unknown, which is honest */ }
  return out;
}

const listSpaces = asyncHandler(async (req, res) => {
  const spaces = await Space.findAll({
    where: { userId: req.user.id },
    include: [{ model: SpaceCamera, as: 'members' }],
    order: [['name', 'ASC']],
  });
  res.json({ success: true, data: spaces });
});

const createSpace = asyncHandler(async (req, res) => {
  const { name, type, capacity, areaSqm, siteId, operatingHours, settings, cameras } = req.body || {};
  if (!name) throw new AppError('name is required', 400);

  const space = await Space.create({
    userId: req.user.id,
    siteId: siteId || null,
    name,
    slug: `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`,
    type: type || 'room',
    capacity: capacity === undefined || capacity === null ? null : Number(capacity),
    areaSqm: areaSqm ?? null,
    operatingHours: operatingHours ?? null,
    settings: settings ?? null,
  });

  if (Array.isArray(cameras) && cameras.length) {
    await addMembers(space, cameras, req.user.id);
  }

  const full = await Space.findByPk(space.id, { include: [{ model: SpaceCamera, as: 'members' }] });
  res.status(201).json({ success: true, data: full });
});

/** Attach cameras, carrying the fusion rule. Verifies tenant ownership. */
async function addMembers(space, cameras, userId) {
  const ids = cameras.map((c) => (typeof c === 'string' ? c : c.cameraId)).filter(Boolean);
  const owned = await Camera.findAll({
    where: { id: ids, userId }, attributes: ['id', 'monitorId'],
  });
  const byId = new Map(owned.map((c) => [c.id, c.monitorId]));

  const rows = [];
  for (const c of cameras) {
    const cameraId = typeof c === 'string' ? c : c.cameraId;
    const monitorId = byId.get(cameraId);
    if (!monitorId) continue;                     // not this tenant's camera — skip
    rows.push({
      spaceId: space.id,
      cameraId,
      monitorId,
      overlapGroup: (typeof c === 'object' && c.overlapGroup) || null,
      weight: (typeof c === 'object' && Number(c.weight)) || 1.0,
    });
  }
  if (rows.length) {
    await SpaceCamera.bulkCreate(rows, { ignoreDuplicates: true });
    if (!space.primaryMonitorId) {
      await space.update({ primaryMonitorId: rows[0].monitorId });
    }
  }
  return rows.length;
}

const updateSpace = asyncHandler(async (req, res) => {
  const space = await Space.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!space) throw new AppError('Space not found', 404);

  const patch = {};
  for (const k of ['name', 'type', 'capacity', 'areaSqm', 'siteId',
                   'operatingHours', 'settings', 'enabled']) {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  }
  await space.update(patch);

  // Replace membership when supplied (the editor sends the full set).
  if (Array.isArray(req.body.cameras)) {
    await SpaceCamera.destroy({ where: { spaceId: space.id } });
    await addMembers(space, req.body.cameras, req.user.id);
  }

  const full = await Space.findByPk(space.id, { include: [{ model: SpaceCamera, as: 'members' }] });
  res.json({ success: true, data: full });
});

const deleteSpace = asyncHandler(async (req, res) => {
  const n = await Space.destroy({ where: { id: req.params.id, userId: req.user.id } });
  if (!n) throw new AppError('Space not found', 404);
  res.json({ success: true });
});

/**
 * GET /api/spaces/live — the wall: every room's current occupancy.
 * Returns `count: null` when the room can't be seen — the UI must show
 * "unknown", never a confident 0.
 */
const liveOccupancy = asyncHandler(async (req, res) => {
  const spaces = await Space.findAll({
    where: { userId: req.user.id, enabled: true },
    include: [{ model: SpaceCamera, as: 'members' }],
    order: [['name', 'ASC']],
  });

  const monitorIds = [...new Set(spaces.flatMap((s) => (s.members || []).map((m) => m.monitorId)))];
  const samples = await readSamples(monitorIds);

  const openIncidents = await sequelize.query(
    `SELECT space_id, started_at FROM occupancy_incidents
      WHERE user_id = :userId AND status = 'open'`,
    { replacements: { userId: req.user.id }, type: QueryTypes.SELECT },
  );
  const openBySpace = new Map(openIncidents.map((i) => [i.space_id, i.started_at]));

  const data = spaces.map((s) => {
    const members = (s.members || []).map((m) => m.get({ plain: true }));
    const fused = fuseSpace(members, samples);
    const cap = Number(s.capacity) || 0;
    const warnAt = cap > 0 ? Math.ceil(cap * (s.settings?.warnPct ?? 0.85)) : null;
    let state = 'unknown';
    if (fused.count !== null && cap > 0) {
      state = fused.count >= cap ? 'over' : (fused.count >= warnAt ? 'warn' : 'ok');
    } else if (fused.count !== null) {
      state = 'ok';
    }
    return {
      id: s.id, name: s.name, type: s.type, capacity: cap || null,
      count: fused.count,               // null ⇒ we cannot see the room
      quality: fused.quality,
      coveragePct: fused.coveragePct,
      degraded: fused.degraded,
      cameras: members.length,
      state,
      occupancyPct: cap > 0 && fused.count !== null
        ? Math.round((100 * fused.count) / cap) : null,
      breachOpenSince: openBySpace.get(s.id) || null,
    };
  });

  res.json({
    success: true,
    data: {
      spaces: data,
      // Only sum rooms we can actually see; blind rooms must not read as 0.
      totalKnown: data.reduce((a, s) => a + (s.count ?? 0), 0),
      spacesUnknown: data.filter((s) => s.count === null).length,
    },
  });
});

module.exports = { listSpaces, createSpace, updateSpace, deleteSpace, liveOccupancy };
