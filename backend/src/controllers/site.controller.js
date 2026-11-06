/**
 * site.controller.js — CRUD for sites + a few power-user actions.
 *
 * Routes:
 *   GET    /api/sites                   list user's sites
 *   GET    /api/sites/:id               one site (with stats)
 *   POST   /api/sites                   create
 *   PUT    /api/sites/:id               update
 *   DELETE /api/sites/:id               delete (must be empty)
 *   POST   /api/sites/:id/archive       soft-archive (cameras stay, just hidden)
 *   POST   /api/sites/:id/restore       un-archive
 */

const asyncHandler = require('../middleware/asyncHandler');
const AppError     = require('../utils/AppError');
const logger       = require('../config/logger');
const { Site, CameraGroup, Camera, StreamServer } = require('../models');

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

async function uniqueSlug(userId, baseSlug, ignoreId = null) {
  let slug = baseSlug;
  let suffix = 1;
  // Up to 100 attempts — way more than enough in practice
  for (let i = 0; i < 100; i++) {
    const where = { userId, slug };
    const existing = await Site.findOne({ where });
    if (!existing || existing.id === ignoreId) return slug;
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }
  throw new AppError('Could not generate a unique site slug.', 500);
}

async function loadSite(userId, id, opts = {}) {
  const include = [];
  if (opts.withGroups) {
    include.push({
      model: CameraGroup,
      as: 'cameraGroups',
      include: [{ model: Camera, as: 'cameras' }],
    });
  }
  if (opts.withServers) {
    include.push({ model: StreamServer, as: 'mediamtxServers' });
  }

  const site = await Site.findOne({ where: { id, userId }, include });
  if (!site) throw new AppError('Site not found.', 404);
  return site;
}

// ── List ─────────────────────────────────────────────────────────────────────

const listSites = asyncHandler(async (req, res) => {
  const sites = await Site.findAll({
    where: { userId: req.user.id },
    order: [['name', 'ASC']],
    include: [{
      model: CameraGroup,
      as: 'cameraGroups',
      attributes: ['id', 'totalChannels', 'status'],
      include: [{ model: Camera, as: 'cameras', attributes: ['id', 'status'] }],
    }],
  });

  // Compute roll-up stats per site so the UI doesn't have to
  const data = sites.map((s) => {
    const groups = s.cameraGroups || [];
    let totalCams = 0, onlineCams = 0;
    for (const g of groups) {
      const cams = g.cameras || [];
      totalCams += cams.length;
      onlineCams += cams.filter((c) => c.status === 'online').length;
    }
    return {
      id:           s.id,
      name:         s.name,
      slug:         s.slug,
      address:      s.address,
      timezone:     s.timezone,
      latitude:     s.latitude,
      longitude:    s.longitude,
      status:       s.status,
      groupsCount:  groups.length,
      camerasTotal: totalCams,
      camerasOnline: onlineCams,
      createdAt:    s.createdAt,
      updatedAt:    s.updatedAt,
    };
  });

  res.json({ success: true, data });
});

// ── Get one ──────────────────────────────────────────────────────────────────

const getSite = asyncHandler(async (req, res) => {
  const site = await loadSite(req.user.id, req.params.id, {
    withGroups: true,
    withServers: true,
  });
  res.json({ success: true, data: site });
});

// ── Create ───────────────────────────────────────────────────────────────────

const createSite = asyncHandler(async (req, res) => {
  const {
    name, address, timezone, latitude, longitude, settings,
  } = req.body;

  if (!name || !name.trim()) throw new AppError('name is required.', 400);

  const baseSlug = slugify(name);
  if (!baseSlug) throw new AppError('Could not generate a slug from this name.', 400);
  const slug = await uniqueSlug(req.user.id, baseSlug);

  const site = await Site.create({
    userId:    req.user.id,
    name:      name.trim(),
    slug,
    address:   address || null,
    timezone:  timezone || 'Asia/Kolkata',
    latitude:  latitude ?? null,
    longitude: longitude ?? null,
    settings:  settings || null,
    status:    'active',
  });

  logger.info('site created', { siteId: site.id, name: site.name, userId: req.user.id });
  res.status(201).json({ success: true, data: site });
});

// ── Update ───────────────────────────────────────────────────────────────────

const updateSite = asyncHandler(async (req, res) => {
  const site = await loadSite(req.user.id, req.params.id);

  const updates = {};
  const allowed = ['name', 'address', 'timezone', 'latitude', 'longitude', 'settings'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }

  // If name changed, re-slug (preserving uniqueness)
  if (updates.name && updates.name.trim() !== site.name) {
    updates.slug = await uniqueSlug(req.user.id, slugify(updates.name), site.id);
  }

  await site.update(updates);
  res.json({ success: true, data: site });
});

// ── Delete (only when empty) ─────────────────────────────────────────────────

const deleteSite = asyncHandler(async (req, res) => {
  const site = await loadSite(req.user.id, req.params.id, { withGroups: true });

  if ((site.cameraGroups || []).length > 0) {
    throw new AppError(
      'Site still has camera groups. Move or delete them first, or use /archive.',
      409,
    );
  }

  await site.destroy();
  logger.info('site deleted', { siteId: site.id });
  res.json({ success: true, message: 'Site deleted.' });
});

// ── Archive / restore ────────────────────────────────────────────────────────

const archiveSite = asyncHandler(async (req, res) => {
  const site = await loadSite(req.user.id, req.params.id);
  if (site.status === 'archived') return res.json({ success: true, data: site });
  await site.update({ status: 'archived' });
  res.json({ success: true, data: site });
});

const restoreSite = asyncHandler(async (req, res) => {
  const site = await loadSite(req.user.id, req.params.id);
  if (site.status !== 'archived') return res.json({ success: true, data: site });
  await site.update({ status: 'active' });
  res.json({ success: true, data: site });
});

module.exports = {
  listSites,
  getSite,
  createSite,
  updateSite,
  deleteSite,
  archiveSite,
  restoreSite,
};
