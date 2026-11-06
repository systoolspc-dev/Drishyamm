const { Op, fn, col, literal } = require('sequelize');
const axios = require('axios');
const asyncHandler = require('../middleware/asyncHandler');
const { User, Camera, CameraGroup, Subscription, Plan, AIEvent, DeviceToken, AlertEmail } = require('../models');
const AppError = require('../utils/AppError');
const { audit } = require('../utils/audit');
const s3Service = require('../services/s3.service');
const config = require('../config/env');
const { getClient } = require('../config/redis');
const { computeHealth } = require('./cameraHealth.controller');

const RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

const getStats = asyncHandler(async (req, res) => {
  const now = new Date();

  // ── Filter inputs ──────────────────────────────────────────────────────
  let range = RANGE_DAYS[req.query.range] ? req.query.range : '7d';
  let rangeDays = RANGE_DAYS[range];
  let rangeStart = new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  // Custom range support: pass `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`
  if (req.query.range === 'custom' && req.query.from) {
    const fromDate = new Date(req.query.from);
    const toDate   = req.query.to ? new Date(req.query.to) : now;
    if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate < toDate) {
      range = 'custom';
      rangeStart = fromDate;
      rangeDays = Math.max(1, Math.ceil((toDate - fromDate) / (24 * 60 * 60 * 1000)));
    }
  }

  const severityList = (req.query.severity || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => ['info', 'warning', 'critical'].includes(s));
  const userIdFilter = req.query.userId && req.query.userId !== 'all' ? req.query.userId : null;

  const eventWhere = { ts: { [Op.gte]: rangeStart } };
  if (severityList.length) eventWhere.severity = { [Op.in]: severityList };
  if (userIdFilter)        eventWhere.userId   = userIdFilter;

  // Custom range may also have an explicit `to` date — clamp event ts <= to
  if (range === 'custom' && req.query.to) {
    const toDate = new Date(req.query.to);
    if (!isNaN(toDate.getTime())) {
      eventWhere.ts = { [Op.between]: [rangeStart, toDate] };
    }
  }

  // For "all-time" event aggregates we ignore the time gate but keep severity/user filters
  const eventWhereAllTime = {};
  if (severityList.length) eventWhereAllTime.severity = { [Op.in]: severityList };
  if (userIdFilter)        eventWhereAllTime.userId   = userIdFilter;

  const cameraWhere = userIdFilter ? { userId: userIdFilter } : {};
  const userWhere   = userIdFilter ? { id: userIdFilter, deletedAt: null } : { deletedAt: null };

  // Older constants retained for backwards compatibility ─────────────────
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo    = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

  // Severity breakdown is the *unfiltered-by-severity* breakdown (filtering by
  // severity AND showing severity counts is redundant). Time + user still apply.
  const sevWhere = { ts: { [Op.gte]: rangeStart } };
  if (userIdFilter) sevWhere.userId = userIdFilter;

  const [
    totalUsers, activeUsers, newUsersInRange,
    totalCameras, onlineCameras, totalGroups,
    totalEvents, eventsInRange, unackedEvents,
    severityRows, eventTypeRows,
    cameraTypeRows, planRows,
    activeSubs, recentEventsRaw, recentSignupsRaw,
    eventTrendRaw, topOfflineCamsRaw,
  ] = await Promise.all([
    User.count({ where: userWhere }),
    User.count({ where: { ...userWhere, isActive: true } }),
    User.count({ where: { ...userWhere, createdAt: { [Op.gte]: rangeStart } } }),
    Camera.count({ where: cameraWhere }),
    Camera.count({ where: { ...cameraWhere, status: 'online' } }),
    CameraGroup.count(),
    AIEvent.count({ where: eventWhereAllTime }),
    AIEvent.count({ where: eventWhere }),
    AIEvent.count({ where: { ...eventWhereAllTime, acknowledgedAt: null } }),
    AIEvent.findAll({
      where: sevWhere,
      attributes: ['severity', [fn('COUNT', col('id')), 'count']],
      group: ['severity'],
      raw: true,
    }),
    AIEvent.findAll({
      where: eventWhere,
      attributes: [['event_type', 'eventType'], [fn('COUNT', col('id')), 'count']],
      group: ['event_type'],
      order: [[literal('count'), 'DESC']],
      limit: 5,
      raw: true,
    }),
    Camera.findAll({
      where: cameraWhere,
      attributes: ['type', [fn('COUNT', col('id')), 'count']],
      group: ['type'],
      raw: true,
    }),
    Subscription.findAll({
      where: { status: 'active', ...(userIdFilter ? { userId: userIdFilter } : {}) },
      include: [{ model: Plan, as: 'plan', attributes: ['name', 'price'] }],
      attributes: ['id', 'planId', 'userId'],
    }),
    Subscription.count({ where: { status: 'active', ...(userIdFilter ? { userId: userIdFilter } : {}) } }),
    AIEvent.findAll({
      where: eventWhere,
      include: [
        { model: Camera, as: 'camera', attributes: ['name'], required: false },
        { model: User,   as: 'user',   attributes: ['name'], required: false },
      ],
      order: [['ts', 'DESC']],
      limit: 8,
    }),
    User.findAll({
      where: { ...userWhere, createdAt: { [Op.gte]: rangeStart } },
      attributes: ['id', 'name', 'email', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 5,
    }),
    AIEvent.findAll({
      where: eventWhere,
      attributes: [
        [fn('DATE', col('ts')), 'day'],
        [fn('COUNT', col('id')), 'count'],
      ],
      group: [fn('DATE', col('ts'))],
      order: [[fn('DATE', col('ts')), 'ASC']],
      raw: true,
    }),
    Camera.findAll({
      where: { ...cameraWhere, status: 'offline' },
      include: [{ model: User, as: 'user', attributes: ['name', 'email'] }],
      order: [['lastOfflineAt', 'DESC']],
      limit: 5,
    }),
  ]);

  // ── Organisation growth (cumulative) ──────────────────────────────────
  const [orgGrowthRaw, orgsBefore, allCamerasWithSettings, eventsByOrgRaw] = await Promise.all([
    User.findAll({
      where: { ...userWhere, createdAt: { [Op.gte]: rangeStart } },
      attributes: [[fn('DATE', col('created_at')), 'day'], [fn('COUNT', col('id')), 'count']],
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
      raw: true,
    }),
    User.count({ where: { ...userWhere, createdAt: { [Op.lt]: rangeStart } } }),
    Camera.findAll({
      where: cameraWhere,
      attributes: ['id', 'userId', 'settings', 'type'],
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
      raw: false,
    }),
    AIEvent.findAll({
      where: eventWhere,
      attributes: ['userId', [fn('COUNT', col('id')), 'count']],
      group: ['userId'],
      raw: true,
    }),
  ]);

  // Densify growth across the range
  const growthMap = new Map();
  for (const r of orgGrowthRaw) {
    const key = typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10);
    growthMap.set(key, parseInt(r.count, 10));
  }
  const orgGrowth = [];
  let cumulative = orgsBefore;
  const growthDays = range === '24h' ? 1 : rangeDays;
  for (let i = growthDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    cumulative += (growthMap.get(key) || 0);
    orgGrowth.push({ day: key, total: cumulative, added: growthMap.get(key) || 0 });
  }

  // Top orgs by camera count + AI feature usage --------------------------
  // Group cameras by user and parse their AI feature settings
  const orgMap = new Map(); // userId -> { id, name, cameras, aiCameras, faceRec, personDet, behavior, types }
  const featureCounts = { face_recognition: 0, person_detection: 0, vehicle_detection: 0, behavior_alerts: 0 };
  for (const cam of allCamerasWithSettings) {
    const uid = cam.userId;
    const name = cam.user?.name || 'Unknown';
    if (!orgMap.has(uid)) {
      orgMap.set(uid, { id: uid, name, cameras: 0, aiCameras: 0, faceRec: 0, personDet: 0, behavior: 0 });
    }
    const o = orgMap.get(uid);
    o.cameras += 1;

    const settings = cam.settings || {};
    const ai = settings.ai || {};
    const detectors = ai.detectors || {};
    const behaviors = ai.behaviors || {};

    let camHasAi = false;
    if (ai.faceWatchlist || detectors.face_recognition || detectors.face) {
      o.faceRec += 1; featureCounts.face_recognition += 1; camHasAi = true;
    }
    if (detectors.person || detectors.person_detection) {
      o.personDet += 1; featureCounts.person_detection += 1; camHasAi = true;
    }
    if (detectors.vehicle || detectors.vehicle_detection) {
      featureCounts.vehicle_detection += 1; camHasAi = true;
    }
    if (behaviors.tripwire || behaviors.intrusion || behaviors.loitering || ai.enabled) {
      o.behavior += 1; featureCounts.behavior_alerts += 1; camHasAi = true;
    }
    if (camHasAi) o.aiCameras += 1;
  }

  // Layer in event counts per org
  const eventsByOrg = new Map();
  for (const r of eventsByOrgRaw) {
    eventsByOrg.set(r.userId, parseInt(r.count, 10));
  }
  // Layer in MRR per org
  const mrrByOrg = new Map();
  for (const sub of planRows) {
    const cur = mrrByOrg.get(sub.userId) || 0;
    mrrByOrg.set(sub.userId, cur + (sub.plan?.price ? parseFloat(sub.plan.price) : 0));
  }

  const topOrgs = Array.from(orgMap.values())
    .map(o => ({ ...o, events: eventsByOrg.get(o.id) || 0, mrr: mrrByOrg.get(o.id) || 0 }))
    .sort((a, b) => (b.cameras + b.events / 100) - (a.cameras + a.events / 100))
    .slice(0, 6);

  // Usage rollup -------------------------------------------------------------
  // "Compute" proxy: online cameras × hours in range. "DB" proxy: events stored.
  const cameraHours = onlineCameras * 24 * rangeDays;
  const totalAiCameras = Array.from(orgMap.values()).reduce((s, o) => s + o.aiCameras, 0);
  const aiAdoptionPct = totalCameras > 0 ? Math.round((totalAiCameras / totalCameras) * 100) : 0;

  // Plan distribution + MRR ----------------------------------------------------
  const planMap = new Map(); // planId -> { name, price, count }
  let totalMrr = 0;
  for (const sub of planRows) {
    const planId = sub.planId;
    const name   = sub.plan?.name || 'Unknown';
    const price  = sub.plan?.price ? parseFloat(sub.plan.price) : 0;
    if (!planMap.has(planId)) planMap.set(planId, { name, price, count: 0 });
    planMap.get(planId).count += 1;
    totalMrr += price;
  }
  const planDistribution = Array.from(planMap.values())
    .sort((a, b) => b.count - a.count)
    .map(p => ({ name: p.name, count: p.count, mrr: p.price * p.count, price: p.price }));

  // Severity breakdown — always include the three buckets ---------------------
  const sevMap = { info: 0, warning: 0, critical: 0 };
  for (const r of severityRows) sevMap[r.severity] = parseInt(r.count, 10);

  // Camera type breakdown -----------------------------------------------------
  const cameraTypes = cameraTypeRows.map(r => ({
    type: r.type || 'unknown',
    count: parseInt(r.count, 10),
  }));

  // Event trend — densify so every interval shows even with zero ------------
  const trendMap = new Map();
  for (const r of eventTrendRaw) {
    const key = typeof r.day === 'string' ? r.day : new Date(r.day).toISOString().slice(0, 10);
    trendMap.set(key, parseInt(r.count, 10));
  }
  // For 24h, group by hour instead of day — but keep it simple: for now,
  // 24h shows just today as a single day; 7d/30d/90d show day buckets.
  const trendDays = range === '24h' ? 1 : rangeDays;
  const eventTrend = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    eventTrend.push({ day: key, count: trendMap.get(key) || 0 });
  }

  res.json({
    success: true,
    filters: {
      range,
      severity: severityList,
      userId: userIdFilter,
    },
    stats: {
      totalUsers,
      activeUsers,
      suspendedUsers: totalUsers - activeUsers,
      newUsers7d: newUsersInRange, // legacy field name; now reflects current range
      newUsersInRange,
      range,
      rangeDays,
      totalCameras,
      onlineCameras,
      offlineCameras: totalCameras - onlineCameras,
      totalGroups,
      totalEvents,
      events24h: eventsInRange, // legacy field name; now reflects current range
      eventsInRange,
      unackedEvents,
      activeSubs,
      mrr: totalMrr,
      severity: sevMap,
      planDistribution,
      cameraTypes,
      topEventTypes: eventTypeRows.map(r => ({ type: r.eventType, count: parseInt(r.count, 10) })),
      eventTrend,
      recentEvents: recentEventsRaw.map(e => ({
        id: e.id,
        type: e.eventType,
        severity: e.severity,
        ts: e.ts,
        camera: e.camera?.name || e.monitorId,
        customer: e.user?.name || 'Unknown',
        acked: !!e.acknowledgedAt,
        confidence: e.confidence,
      })),
      recentSignups: recentSignupsRaw.map(u => ({
        id: u.id, name: u.name, email: u.email, joined: u.createdAt,
      })),
      topOfflineCameras: topOfflineCamsRaw.map(c => ({
        id: c.id,
        name: c.name,
        host: c.host,
        customer: c.user?.name || 'Unknown',
        lastSeenAt: c.lastSeenAt,
        lastOfflineAt: c.lastOfflineAt,
      })),
      orgGrowth,
      topOrgs,
      aiFeatures: featureCounts,
      usage: {
        cameraHours,
        aiCameras: totalAiCameras,
        aiAdoptionPct,
        eventsStored: totalEvents,
      },
    },
  });
});

const getUsers = asyncHandler(async (req, res) => {
  const users = await User.findAll({
    attributes: { exclude: ['password'] },
    include: [
      {
        model: Subscription,
        as: 'subscriptions',
        include: [{ model: Plan, as: 'plan' }],
        where: { status: 'active' },
        required: false,
        separate: true,
        order: [['createdAt', 'DESC']],
        limit: 1,
      },
      {
        model: Camera,
        as: 'cameras',
        attributes: ['id', 'status'],
        required: false,
      },
    ],
    order: [['createdAt', 'DESC']],
  });

  const result = users.map((u) => {
    const sub = u.subscriptions && u.subscriptions[0];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      status: u.isActive ? 'active' : 'suspended',
      joined: u.createdAt,
      cameras: u.cameras ? u.cameras.length : 0,
      plan: sub?.plan?.name || 'Free',
      mrr: sub?.plan?.price ? parseFloat(sub.plan.price) : 0,
      emailVerified: u.emailVerified,
    };
  });

  res.json({ success: true, users: result });
});

const getUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const user = await User.findByPk(id, {
    attributes: { exclude: ['password'] },
    include: [
      {
        model: Subscription,
        as: 'subscriptions',
        include: [{ model: Plan, as: 'plan' }],
        separate: true,
        order: [['createdAt', 'DESC']],
        limit: 1,
        required: false,
      },
    ],
  });

  if (!user) throw new AppError('User not found', 404);

  const cameras = await Camera.findAll({
    where: { userId: id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'host'] }],
  });

  const sub = user.subscriptions && user.subscriptions[0];

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      status: user.isActive ? 'active' : 'suspended',
      joined: user.createdAt,
      cameras: cameras.length,
      plan: sub?.plan?.name || 'Free',
      mrr: sub?.plan?.price ? parseFloat(sub.plan.price) : 0,
      emailVerified: user.emailVerified,
    },
    cameras: cameras.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      ip: c.host,
      type: c.type,
      monitorId: c.monitorId,
      group: c.group ? { id: c.group.id, name: c.group.name } : null,
    })),
    subscription: sub
      ? {
          status: sub.status,
          plan: sub.plan?.name,
          price: sub.plan?.price ? parseFloat(sub.plan.price) : 0,
          currentPeriodEnd: sub.currentPeriodEnd,
        }
      : null,
  });
});

const toggleUserStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await User.findByPk(id);
  if (!user) throw new AppError('User not found', 404);

  // Every self-registered owner has role 'admin', so a role check made owners
  // impossible to suspend. Only platform operators are off limits.
  if (user.isPlatformAdmin) {
    throw new AppError('Cannot suspend a platform operator.', 403);
  }
  if (String(user.id) === String(req.user.id)) {
    throw new AppError('You cannot suspend your own account.', 400);
  }

  user.isActive = !user.isActive;
  await user.save();
  // Same effect as PUT /admin/accounts/:id/status for this one user row.
  require('../services/accountStatus.service').setBlocked([user.id], !user.isActive);
  if (!user.parentUserId) require('../services/accountStatus.service').reload().catch(() => {});

  audit('user.status.toggled', {
    req,
    targetType: 'user',
    targetId: user.id,
    meta: { email: user.email, status: user.isActive ? 'active' : 'suspended' },
  });
  // Legacy per-user toggle (Users page). An owner row is the whole account.
  require('../services/platformEvents.service').record(user.isActive ? 'account.reactivated' : 'account.suspended', {
    severity: user.isActive ? 'info' : 'warning',
    accountId: user.parentUserId || user.id,
    req,
    summary: user.parentUserId
      ? `Team member ${user.name || user.email} was ${user.isActive ? 'reactivated' : 'suspended'}`
      : `${user.name || user.email} was ${user.isActive ? 'reactivated' : 'suspended'}`,
    data: { email: user.email, userId: user.id, member: !!user.parentUserId, via: 'toggle-status' },
  });

  res.json({
    success: true,
    user: { id: user.id, isActive: user.isActive, status: user.isActive ? 'active' : 'suspended' },
  });
});

const getCameras = asyncHandler(async (req, res) => {
  // Optional ?userId= scopes the fleet to one customer (used by the live
  // monitoring view); omit it for the global cross-tenant list.
  const where = req.query.userId ? { userId: req.query.userId } : undefined;
  const cameras = await Camera.findAll({
    ...(where ? { where } : {}),
    include: [
      { model: User, as: 'user', attributes: ['id', 'name', 'email'] },
      { model: CameraGroup, as: 'group', attributes: ['id', 'name', 'host'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  res.json({
    success: true,
    cameras: cameras.map((c) => ({
      id: c.id,
      monitorId: c.monitorId,
      name: c.name,
      status: c.status,
      ip: c.host,
      type: c.type,
      userId: c.userId,
      customer: c.user?.name || 'Unknown',
      customerEmail: c.user?.email || '',
      group: c.group ? { id: c.group.id, name: c.group.name } : null,
      width: c.width,
      height: c.height,
      fps: c.fps,
      resolution: c.width && c.height ? `${c.width}x${c.height}` : null,
    })),
  });
});

const getEvents = asyncHandler(async (req, res) => {
  const { limit = 100, page = 1 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const { count, rows } = await AIEvent.findAndCountAll({
    include: [
      { model: Camera, as: 'camera', attributes: ['name', 'host'], required: false },
      { model: User, as: 'user', attributes: ['id', 'name', 'email'], required: false },
    ],
    order: [['ts', 'DESC']],
    limit: parseInt(limit),
    offset,
  });

  res.json({
    success: true,
    total: count,
    page: parseInt(page),
    events: rows.map((e) => ({
      id: e.id,
      userId: e.userId,
      customer: e.user?.name || 'Unknown',
      camera: e.camera?.name || e.monitorId,
      cameraId: e.cameraId,
      type: e.eventType,
      severity: e.severity,
      ts: e.ts,
      acked: !!e.acknowledgedAt,
      confidence: e.confidence,
      label: e.payload?.matchedName || null,
    })),
  });
});

const getAllDatasets = asyncHandler(async (req, res) => {
  // List all objects under watchlist-datasets/
  const all = await s3Service.listObjects('watchlist-datasets/');

  // Fetch all users in one query for name mapping
  const userIds = [...new Set(all.map(o => o.Key.split('/')[1]).filter(Boolean))];
  const users = await User.findAll({
    where: { id: userIds },
    attributes: ['id', 'name', 'email'],
  });
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const datasets = all.map(obj => {
    const parts  = obj.Key.split('/');
    const userId = parts[1];
    const user   = userMap[userId];
    const filename = parts[parts.length - 1];
    // Extract metadata encoded in filename: {timestamp}_{originalname}
    const tsMatch = filename.match(/^(\d+)_(.+)$/);
    return {
      key:          obj.Key,
      filename,
      originalName: tsMatch ? tsMatch[2] : filename,
      sizeBytes:    obj.Size,
      lastModified: obj.LastModified,
      userId,
      userName:     user?.name || 'Unknown',
      userEmail:    user?.email || '',
    };
  });

  datasets.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
  res.json({ success: true, datasets });
});

const getDatasetDownload = asyncHandler(async (req, res) => {
  const { key } = req.query;
  if (!key || !key.startsWith('watchlist-datasets/')) {
    throw new AppError('Invalid key.', 400);
  }
  const filename = key.split('/').pop();
  const url = await s3Service.getFileDownloadUrl(key, filename, 3600);
  res.json({ success: true, url });
});

/**
 * Live operational metrics for ONE customer — all DYNAMIC, nothing hardcoded.
 * Pulls: AI engine live status (frames processed = model inferences, persons
 * detected now, detecting cameras, fps) filtered to the customer's cameras;
 * live stream viewers; alerts triggered / delivered (push+email) / unacked; and
 * push/email delivery targets configured. Powers the admin monitoring panel.
 */
const getOpsMetrics = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  if (!userId) throw new AppError('userId is required.', 400);

  const cams = await Camera.findAll({ where: { userId }, attributes: ['monitorId'] });
  const mine = new Set(cams.map((c) => c.monitorId).filter(Boolean));

  // ── AI engine live status (global snapshot → filtered to this customer) ──
  const ai = { framesProcessed: 0, personsNow: 0, detectingCameras: 0, activeCameras: 0, boxesNow: 0, avgFps: 0 };
  try {
    const { data } = await axios.get(`${config.aiServiceUrl}/status`, { timeout: 4000 });
    let fpsSum = 0; let n = 0;
    for (const [mid, c] of Object.entries(data?.cameras || {})) {
      if (!mine.has(mid)) continue;
      if (c.running) ai.activeCameras += 1;
      if (c.detecting) { ai.detectingCameras += 1; if (c.fps) { fpsSum += Number(c.fps) || 0; n += 1; } }
      ai.framesProcessed += Number(c.frames) || 0;
      ai.personsNow += Number(c.persons) || 0;
      ai.boxesNow += Number(c.n_boxes) || 0;
    }
    ai.avgFps = n ? Number((fpsSum / n).toFixed(1)) : 0;
  } catch { /* AI busy/unreachable — leave zeros */ }

  // ── live stream viewers (readers across the customer's cameras) ──
  const streams = { liveViewers: 0, streaming: 0 };
  try {
    const h = await computeHealth(userId);
    for (const c of (h.cameras || [])) {
      streams.liveViewers += Number(c.readers) || 0;
      if (['healthy', 'transcoding', 'streaming'].includes(c.status)) streams.streaming += 1;
    }
  } catch { /* ignore */ }

  // ── alerts (triggered from events + delivered from counters + targets) ──
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [triggered24h, critical24h, unacked, totalEvents, events24h, pushDevices, emailRecipients] = await Promise.all([
    AIEvent.count({ where: { userId, severity: { [Op.in]: ['warning', 'critical'] }, ts: { [Op.gte]: since } } }),
    AIEvent.count({ where: { userId, severity: 'critical', ts: { [Op.gte]: since } } }),
    // Last 7 days only: an all-time unacknowledged count (100k+ on a box nobody
    // acks) is not something an operator can act on.
    AIEvent.count({ where: { userId, acknowledgedAt: null, severity: { [Op.in]: ['warning', 'critical'] }, ts: { [Op.gte]: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } }),
    AIEvent.count({ where: { userId } }),
    AIEvent.count({ where: { userId, ts: { [Op.gte]: since } } }),
    DeviceToken.count({ where: { userId } }).catch(() => 0),
    AlertEmail.count({ where: { userId, disabled: false } }).catch(() => 0),
  ]);

  let sentPush = 0; let sentEmail = 0;
  try {
    const rc = getClient();
    if (rc) {
      const day = new Date().toISOString().slice(0, 10);
      sentPush = Number(await rc.get(`metrics:alert:push:${userId}:${day}`)) || 0;
      sentEmail = Number(await rc.get(`metrics:alert:email:${userId}:${day}`)) || 0;
    }
  } catch { /* ignore */ }

  res.json({
    success: true,
    ai,
    streams,
    alerts: { triggered24h, critical24h, unacked, sentPush, sentEmail, pushDevices, emailRecipients },
    events: { total: totalEvents, last24h: events24h },
    ts: Date.now(),
  });
});

module.exports = { getStats, getUsers, getUser, toggleUserStatus, getCameras, getEvents, getAllDatasets, getDatasetDownload, getOpsMetrics };
