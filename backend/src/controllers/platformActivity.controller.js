/**
 * platformActivity.controller — history and backfill for the admin console's
 * live activity feed. Operator-only (mounted under /api/admin).
 *
 *   GET /api/admin/activity
 *       ?type=a,b          exact event types
 *       &category=a,b      signups | changes | cameras | logins | system
 *       &accountId=        one customer account (owner id)
 *       &severity=a,b      info | warning | critical
 *       &since=ISO         created after this instant (reconnect backfill)
 *       &afterId=N         id greater than N (reconnect backfill; exact)
 *       &page=&limit=      server-paged, newest first (limit ≤ 200)
 *   GET /api/admin/activity/counters   the same numbers platform.counters pushes
 */
const { Op } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const { PlatformEvent } = require('../models');
const platformEvents = require('../services/platformEvents.service');
const { CATEGORIES, ALL_TYPES } = require('../services/platformEvents/catalog');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const listActivity = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = {};

  const types = new Set(list(req.query.type).filter((t) => ALL_TYPES.includes(t)));
  for (const c of list(req.query.category)) for (const t of CATEGORIES[c] || []) types.add(t);
  if (list(req.query.type).length || list(req.query.category).length) where.type = { [Op.in]: [...types] };

  if (req.query.accountId) where.accountId = String(req.query.accountId);
  const sev = list(req.query.severity).filter((s) => ['info', 'warning', 'critical'].includes(s));
  if (sev.length) where.severity = { [Op.in]: sev };

  const since = req.query.since ? new Date(req.query.since) : null;
  if (since && !isNaN(since)) where.createdAt = { [Op.gt]: since };
  const afterId = parseInt(req.query.afterId, 10);
  if (Number.isFinite(afterId) && afterId > 0) where.id = { [Op.gt]: afterId };

  const { count, rows } = await PlatformEvent.findAndCountAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  res.json({ success: true, total: count, page, limit, events: rows.map(platformEvents.shape) });
});

const getCounters = asyncHandler(async (req, res) => {
  res.json({ success: true, counters: await platformEvents.computeCounters() });
});

module.exports = { listActivity, getCounters };
