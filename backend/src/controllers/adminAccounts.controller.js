/**
 * adminAccounts.controller — the admin console's Accounts list and account hub.
 *
 *   GET  /api/admin/accounts                                   every customer account, one row each
 *   GET  /api/admin/accounts/:userId/hub                       one account: health, cameras, AI, users, billing
 *   GET  /api/admin/accounts/:userId/events                    that account's AI events, server-paged
 *   PUT  /api/admin/accounts/:userId/status                    { active: boolean, reason? } suspend / reactivate
 *   POST /api/admin/accounts/:userId/users/:memberId/password-reset
 *   GET  /api/admin/accounts/:userId/cameras/:cameraId/snapshot  one still, only when an operator clicks
 *   GET  /api/admin/audit                                      admin_audit_log, server-paged + filters
 *
 * An ACCOUNT is an owner row: users.parent_user_id IS NULL and not a platform
 * operator. Sub-users belong to their owner's row; operators are not customers.
 *
 * Licences: the enforced numbers are the owner's Subscription (camera_limit,
 * feature_limits, features) — the same rows cameraQuota and entitlements read.
 * The `licenses` table is the commercial record (pricing calculator); it is
 * reported next to the enforced numbers, with any disagreement spelled out,
 * and never enforced from here.
 *
 * Camera health comes from the same classification the customer's Health page
 * uses (cameraHealth.controller), not from the DB `cameras.status` column.
 * Every list query is one query for all accounts — nothing runs per row.
 */
const { Op, fn, col, literal } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { audit } = require('../utils/audit');
const {
  User, Subscription, Plan, Camera, RestrictedZone, License, LicenseResource,
  LicenseFeature, AIEvent, AdminAuditLog, RefreshToken, PasswordReset, Role,
} = require('../models');
const { AI_LICENCES, FEATURE_GROUPS } = require('../utils/featureCatalog');
const { countLicenceUsage, clearEntitlementCache } = require('../services/entitlements.service');
const { getCameraLicence } = require('../services/cameraQuota.service');
const { computeHealth, loadHealthContext, classifyCamera } = require('./cameraHealth.controller');
const accountStatus = require('../services/accountStatus.service');
const platformEvents = require('../services/platformEvents.service');
const { SUBSCRIPTION_STATUS } = require('../utils/constants');

const LIVE_SUB = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING];

// Engine state → the four buckets of the customer Health page
// (smart-cam-app/src/core/pages/camera-health/health-vocabulary.js).
const BUCKET = {
  healthy: 'online', standby: 'online', transcoding: 'online', starting: 'online',
  wobbling: 'unstable', offline: 'offline', unknown: 'setup',
};
const STREAMING = new Set(['healthy', 'transcoding', 'starting']);

// 'Open alerts' = unacknowledged warning/critical events of the last week. The
// all-time unacknowledged count (100k+ on a demo box that nobody acks) is not
// something an operator can act on.
const OPEN_ALERT_DAYS = 7;
const openAlertSince = () => new Date(Date.now() - OPEN_ALERT_DAYS * 86400000);

/** AI event type → the feature it comes from. */
function eventFeature(type) {
  const t = String(type || '');
  if (/^(person|face|watchlist|track)\./.test(t)) return 'face';
  if (/^(occupancy|headcount|crowd)\./.test(t)) return 'headcount';
  if (/^zone\./.test(t)) return 'restricted_zone';
  if (/^(activity|phone)\./.test(t)) return 'activity';
  if (/^weapon/.test(t)) return 'weapon';
  if (/^fire|^smoke/.test(t)) return 'fire';
  if (/^(aggression|fight|violence)/.test(t)) return 'aggression';
  if (/^(anpr|vehicle|plate|lpr)/.test(t)) return 'anpr';
  return null;
}

// AI features with no per-camera switch: licensed on/off only.
const SWITCH_ONLY_AI = ['weapon', 'fire', 'aggression', 'anpr'];

const emptyHealth = () => ({ total: 0, online: 0, unstable: 0, offline: 0, setup: 0, streaming: 0 });

function featureSet(sub) {
  const raw = Array.isArray(sub?.features) && sub.features.length ? sub.features : null;
  return raw; // null = every feature the tier allows
}

function featureOn(sub, keys) {
  if (sub?.plan?.aiEnabled !== true) return false;
  const f = featureSet(sub);
  return !f || keys.some((k) => f.includes(k));
}

/** Pick the newest live subscription per user from a createdAt-DESC list. */
function newestBy(rows, key = 'userId') {
  const out = new Map();
  for (const r of rows) if (!out.has(r[key])) out.set(r[key], r);
  return out;
}

/** Camera count bought on a licence record (HD + 4K lines). */
function recordCameraQuota(lic) {
  return (lic?.resources || [])
    .filter((r) => r.sku === 'cam_hd' || r.sku === 'cam_4k')
    .reduce((s, r) => s + (Number(r.quota) || 0), 0);
}

function cameraLimitFor(sub) {
  if (!sub || !sub.plan) return null; // free tier: unlimited unless FREE_TIER_MAX_CAMERAS
  if (sub.cameraLimit !== null && sub.cameraLimit !== undefined) return Math.max(0, sub.cameraLimit);
  return sub.plan.maxCameras > 0 ? sub.plan.maxCameras : null;
}

async function loadAccountOwner(userId) {
  const user = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
  if (!user) throw new AppError('Account not found', 404);
  if (user.parentUserId) {
    const err = new AppError(`${user.name} is a user inside another account. Open the account owner instead.`, 400);
    err.ownerId = user.parentUserId;
    throw err;
  }
  if (user.isPlatformAdmin) throw new AppError('This is a platform operator, not a customer account.', 400);
  return user;
}

function sendOwnerError(res, err) {
  if (err.ownerId) return res.status(400).json({ success: false, message: err.message, ownerId: err.ownerId });
  throw err;
}

async function writeAudit(req, action, ownerId, payload) {
  await AdminAuditLog.create({
    adminUserId: String(req.user.id),
    action,
    resourceType: 'account',
    resourceId: ownerId,
    payload,
    ip: String(req.ip || '').slice(0, 64) || null,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
  }).catch(() => { /* the file trail below still records it */ });
  audit(action, { req, targetType: 'account', targetId: ownerId, meta: payload });
}

/* ═════════════════════════ Accounts list ═════════════════════════ */

const listAccounts = asyncHandler(async (req, res) => {
  const [owners, members, subs, cameras, zones, licences, lastSessions, healthCtx, openAlerts] = await Promise.all([
    User.findAll({
      where: { parentUserId: null, isPlatformAdmin: { [Op.not]: true } },
      attributes: ['id', 'name', 'email', 'role', 'isActive', 'createdAt'],
      order: [['createdAt', 'DESC']],
    }),
    User.findAll({ where: { parentUserId: { [Op.ne]: null } }, attributes: ['id', 'parentUserId'] }),
    Subscription.findAll({
      where: { status: { [Op.in]: LIVE_SUB } },
      include: [{ model: Plan, as: 'plan', attributes: ['id', 'name', 'maxCameras', 'aiEnabled', 'price'] }],
      attributes: ['id', 'userId', 'status', 'features', 'cameraLimit', 'featureLimits', 'currentPeriodEnd', 'createdAt'],
      order: [['createdAt', 'DESC']],
    }),
    // Only the per-camera AI flags are read out of `settings`, so the list
    // never ships every camera's whole settings blob.
    Camera.findAll({
      attributes: [
        'id', 'userId', 'monitorId', 'status', 'groupId',
        [literal("JSON_EXTRACT(settings, '$.ai.enabled')"), 'aiEnabled'],
        [literal("JSON_UNQUOTE(JSON_EXTRACT(settings, '$.ai.mode'))"), 'aiMode'],
        [literal("JSON_EXTRACT(settings, '$.ai.activityMonitoring')"), 'activity'],
        [literal("JSON_EXTRACT(settings, '$.headcount.enabled')"), 'headcount'],
      ],
      raw: true,
    }),
    RestrictedZone.findAll({ where: { enabled: true }, attributes: ['userId', 'monitorId'], raw: true }),
    License.findAll({
      attributes: ['id', 'userId', 'status', 'term', 'endDate', 'createdAt'],
      include: [{ model: LicenseResource, as: 'resources', attributes: ['sku', 'quota'] }],
      order: [['createdAt', 'DESC']],
    }),
    RefreshToken.findAll({
      attributes: ['userId', [fn('MAX', col('created_at')), 'lastAt']],
      group: ['userId'],
      raw: true,
    }),
    loadHealthContext(),
    AIEvent.findAll({
      where: { acknowledgedAt: null, severity: { [Op.in]: ['warning', 'critical'] }, ts: { [Op.gte]: openAlertSince() } },
      attributes: ['userId', [fn('COUNT', col('id')), 'n']],
      group: ['userId'],
      raw: true,
    }),
  ]);

  // user id → owner id (owners map to themselves)
  const ownerOf = new Map(owners.map((o) => [o.id, o.id]));
  const memberCount = new Map();
  for (const m of members) {
    ownerOf.set(m.id, m.parentUserId);
    memberCount.set(m.parentUserId, (memberCount.get(m.parentUserId) || 0) + 1);
  }
  const subByOwner = newestBy(subs);
  const licByOwner = newestBy(licences);

  const truthy = (v) => v === true || v === 1 || v === 'true' || v === '1';
  const perOwner = new Map(owners.map((o) => [o.id, {
    cameras: 0, health: emptyHealth(), ai: { face: 0, headcount: 0, activity: 0, restricted_zone: 0 },
    groups: new Map(), // NVR / group id → { total, offline }
  }]));
  const monitorOwner = new Map();
  for (const c of cameras) {
    const owner = ownerOf.get(c.userId);
    const agg = owner && perOwner.get(owner);
    if (!agg) continue;
    monitorOwner.set(`${owner}:${c.monitorId}`, c.id);
    agg.cameras += 1;
    const { status } = classifyCamera(c, healthCtx);
    agg.health.total += 1;
    agg.health[BUCKET[status] || 'setup'] += 1;
    if (STREAMING.has(status)) agg.health.streaming += 1;
    if (c.groupId) {
      const g = agg.groups.get(c.groupId) || { total: 0, offline: 0 };
      g.total += 1;
      if (BUCKET[status] === 'offline') g.offline += 1;
      agg.groups.set(c.groupId, g);
    }
    if (truthy(c.aiEnabled) && c.aiMode !== 'off') agg.ai.face += 1;
    if (truthy(c.headcount)) agg.ai.headcount += 1;
    if (truthy(c.activity)) agg.ai.activity += 1;
  }
  // Restricted zones: a camera counts once however many armed zones it has,
  // and only while the camera still exists (same rule as countLicenceUsage).
  const zoneCams = new Set();
  for (const z of zones) {
    const owner = ownerOf.get(z.userId);
    const camId = owner && monitorOwner.get(`${owner}:${z.monitorId}`);
    if (camId && !zoneCams.has(camId)) {
      zoneCams.add(camId);
      perOwner.get(owner).ai.restricted_zone += 1;
    }
  }
  const lastByOwner = new Map();
  for (const r of lastSessions) {
    const owner = ownerOf.get(r.userId);
    if (!owner) continue;
    const t = new Date(r.lastAt).getTime();
    if (!lastByOwner.has(owner) || t > lastByOwner.get(owner)) lastByOwner.set(owner, t);
  }
  const alertsByOwner = new Map();
  for (const r of openAlerts) {
    const owner = ownerOf.get(r.userId);
    if (owner) alertsByOwner.set(owner, (alertsByOwner.get(owner) || 0) + Number(r.n || 0));
  }

  const today = new Date();
  const accounts = owners.map((o) => {
    const sub = subByOwner.get(o.id) || null;
    const agg = perOwner.get(o.id);
    const limits = (sub?.featureLimits && typeof sub.featureLimits === 'object') ? sub.featureLimits : {};
    const lic = licByOwner.get(o.id) || null;
    const daysLeft = lic?.endDate ? Math.ceil((new Date(`${lic.endDate}T23:59:59`) - today) / 86400000) : null;
    return {
      id: o.id,
      name: o.name,
      email: o.email,
      status: o.isActive ? 'active' : 'suspended',
      createdAt: o.createdAt,
      members: memberCount.get(o.id) || 0,
      plan: sub?.plan ? { name: sub.plan.name, aiEnabled: sub.plan.aiEnabled === true } : null,
      cameras: { used: agg.cameras, limit: cameraLimitFor(sub) },
      ai: AI_LICENCES.map((l) => {
        const raw = limits[l.key];
        return {
          key: l.key,
          label: l.label,
          on: featureOn(sub, l.features),
          used: agg.ai[l.key] || 0,
          limit: raw === undefined || raw === null || raw === '' ? null : Number(raw),
        };
      }),
      health: agg.health,
      // An NVR counts as down when every camera on it is offline.
      nvrs: { total: agg.groups.size, down: [...agg.groups.values()].filter((g) => g.total && g.offline === g.total).length },
      openAlerts: alertsByOwner.get(o.id) || 0,
      licenceRecord: lic ? { id: lic.id, status: lic.status, term: lic.term, endDate: lic.endDate, daysLeft } : null,
      lastActiveAt: lastByOwner.has(o.id) ? new Date(lastByOwner.get(o.id)).toISOString() : null,
    };
  });

  res.json({ success: true, accounts, openAlertDays: OPEN_ALERT_DAYS, healthSource: healthCtx.mtxOk ? 'live' : 'stream-service-unreachable' });
});

/* ═════════════════════════ Account hub ═════════════════════════ */

function licenceMismatches(lic, sub, camLimit) {
  if (!lic) return [];
  const out = [];
  const fmt = (v) => (v === null || v === undefined ? 'unlimited' : String(v));
  const recordCams = recordCameraQuota(lic);
  if (recordCams > 0 && recordCams !== camLimit) {
    out.push({ key: 'cameras', label: 'Cameras', record: String(recordCams), enforced: fmt(camLimit) });
  }
  const feats = new Map((lic.features || []).map((f) => [f.featureKey, f]));
  const limits = (sub?.featureLimits && typeof sub.featureLimits === 'object') ? sub.featureLimits : {};
  const face = feats.get('feat_face_rec');
  if (face) {
    const recordFace = face.enabled ? (Number(face.configJson?.cameras) || null) : 0;
    const faceOn = featureOn(sub, AI_LICENCES.find((l) => l.key === 'face').features);
    const enforcedFace = !faceOn ? 0 : (limits.face === undefined || limits.face === null ? camLimit : Number(limits.face));
    if (recordFace !== null && recordFace !== enforcedFace) {
      out.push({ key: 'face', label: 'Face recognition cameras', record: fmt(recordFace), enforced: fmt(enforcedFace) });
    }
  }
  const lpr = feats.get('feat_lpr');
  if (lpr) {
    const on = featureOn(sub, ['anpr']);
    if (!!lpr.enabled !== on) {
      out.push({ key: 'anpr', label: 'ANPR / vehicles', record: lpr.enabled ? 'on' : 'off', enforced: on ? 'on' : 'off' });
    }
  }
  const live = ['active', 'trial'].includes(lic.status);
  if (!live && sub) {
    out.push({ key: 'status', label: 'Status', record: lic.status, enforced: `subscription ${sub.status}` });
  }
  return out;
}

const getHub = asyncHandler(async (req, res) => {
  let owner;
  try { owner = await loadAccountOwner(req.params.userId); } catch (err) { return sendOwnerError(res, err); }

  const members = await User.findAll({
    where: { parentUserId: owner.id },
    attributes: ['id', 'name', 'email', 'username', 'role', 'isActive', 'createdAt', 'customRoleId'],
    include: [{ model: Role, as: 'customRole', attributes: ['id', 'name'], required: false }],
    order: [['createdAt', 'ASC']],
  });
  const userIds = [owner.id, ...members.map((m) => m.id)];
  const since24h = new Date(Date.now() - 24 * 3600 * 1000);

  const [sub, camLic, usage, health, licences, lastByType, openAlerts, critical24h, events24h, sessions, recent] = await Promise.all([
    Subscription.findOne({
      where: { userId: owner.id, status: { [Op.in]: LIVE_SUB } },
      include: [{ model: Plan, as: 'plan' }],
      order: [['createdAt', 'DESC']],
    }),
    getCameraLicence(owner.id),
    countLicenceUsage(owner.id),
    computeHealth(userIds),
    License.findAll({
      where: { userId: owner.id },
      include: [
        { model: LicenseResource, as: 'resources', attributes: ['sku', 'quota', 'used'] },
        { model: LicenseFeature, as: 'features', attributes: ['featureKey', 'enabled', 'configJson'] },
      ],
      order: [['createdAt', 'DESC']],
    }),
    AIEvent.findAll({
      where: { userId: { [Op.in]: userIds } },
      attributes: ['eventType', [fn('MAX', col('ts')), 'lastAt'], [fn('COUNT', col('id')), 'n']],
      group: ['eventType'],
      raw: true,
    }),
    AIEvent.count({ where: { userId: { [Op.in]: userIds }, acknowledgedAt: null, severity: { [Op.in]: ['warning', 'critical'] }, ts: { [Op.gte]: openAlertSince() } } }),
    AIEvent.count({ where: { userId: { [Op.in]: userIds }, severity: 'critical', ts: { [Op.gte]: since24h } } }),
    AIEvent.count({ where: { userId: { [Op.in]: userIds }, ts: { [Op.gte]: since24h } } }),
    RefreshToken.findAll({
      where: { userId: { [Op.in]: userIds } },
      attributes: ['userId', [fn('MAX', col('created_at')), 'lastAt']],
      group: ['userId'],
      raw: true,
    }),
    AdminAuditLog.findAll({
      where: { resourceType: 'account', resourceId: owner.id },
      order: [['ts', 'DESC']],
      limit: 5,
    }),
  ]);

  // Health summary in the Health page's buckets
  const summary = emptyHealth();
  for (const c of health.cameras) {
    summary.total += 1;
    summary[BUCKET[c.status] || 'setup'] += 1;
    if (STREAMING.has(c.status)) summary.streaming += 1;
  }

  // AI services: per feature, cameras switched on vs licensed + last event
  const lastEvent = {};
  for (const r of lastByType) {
    const f = eventFeature(r.eventType);
    if (!f) continue;
    const t = new Date(r.lastAt).getTime();
    const cur = lastEvent[f] || { at: 0, count: 0 };
    lastEvent[f] = { at: Math.max(cur.at, t), count: cur.count + Number(r.n || 0) };
  }
  const limits = (sub?.featureLimits && typeof sub.featureLimits === 'object') ? sub.featureLimits : {};
  const featureLabel = (k) => FEATURE_GROUPS.flatMap((g) => g.items).find((i) => i.key === k)?.label || k;
  const aiServices = [
    ...AI_LICENCES.map((l) => {
      const raw = limits[l.key];
      return {
        key: l.key,
        label: l.label,
        perCamera: true,
        on: featureOn(sub, l.features),
        used: usage.byLicence[l.key]?.used || 0,
        limit: raw === undefined || raw === null || raw === '' ? null : Number(raw),
        lastEventAt: lastEvent[l.key]?.at ? new Date(lastEvent[l.key].at).toISOString() : null,
        events: lastEvent[l.key]?.count || 0,
      };
    }),
    ...SWITCH_ONLY_AI.map((k) => ({
      key: k,
      label: featureLabel(k),
      perCamera: false,
      on: featureOn(sub, [k]),
      used: null,
      limit: null,
      lastEventAt: lastEvent[k]?.at ? new Date(lastEvent[k].at).toISOString() : null,
      events: lastEvent[k]?.count || 0,
    })),
  ];

  const lastSeen = Object.fromEntries(sessions.map((s) => [s.userId, new Date(s.lastAt).toISOString()]));
  const person = (u, isOwner) => ({
    id: u.id,
    name: u.name,
    email: u.email || null,
    username: u.username || null,
    role: isOwner ? 'owner' : (u.customRole?.name || u.role),
    isOwner,
    status: u.isActive ? 'active' : 'suspended',
    createdAt: u.createdAt,
    lastActiveAt: lastSeen[u.id] || null,
  });

  const adminIds = [...new Set(recent.map((c) => c.adminUserId))];
  const admins = adminIds.length
    ? await User.findAll({ where: { id: { [Op.in]: adminIds } }, attributes: ['id', 'name', 'email'], paranoid: false })
    : [];
  const adminById = Object.fromEntries(admins.map((a) => [a.id, a]));

  const camLimit = camLic.limit;
  res.json({
    success: true,
    data: {
      account: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        status: owner.isActive ? 'active' : 'suspended',
        createdAt: owner.createdAt,
        members: members.length,
      },
      plan: sub?.plan ? { name: sub.plan.name, aiEnabled: sub.plan.aiEnabled === true, status: sub.status, validUntil: sub.currentPeriodEnd } : null,
      cameras: { used: camLic.used, limit: camLimit, source: camLic.source },
      health: { summary, source: health.mediamtxOk ? 'live' : 'stream-service-unreachable', cameras: health.cameras.map((c) => ({
        id: c.id,
        monitorId: c.monitorId,
        name: c.name,
        channel: c.channel,
        groupName: c.groupName,
        siteName: c.siteName,
        status: c.status,
        bucket: BUCKET[c.status] || 'setup',
        reason: c.reason,
        codec: c.codec,
        resolution: c.resolution,
        flapCount: c.flapCount,
        lastUpdate: c.lastUpdate,
      })) },
      alerts: { open: openAlerts, openDays: OPEN_ALERT_DAYS, critical24h, events24h },
      aiServices,
      users: [person(owner, true), ...members.map((m) => person(m, false))],
      billing: {
        records: licences.map((l) => ({
          id: l.id,
          status: l.status,
          term: l.term,
          startDate: l.startDate,
          endDate: l.endDate,
          currency: l.currency,
          mrr: Number(l.mrr) || 0,
          arr: Number(l.arr) || 0,
          cameraQuota: recordCameraQuota(l),
          createdAt: l.createdAt,
        })),
        mismatches: licenceMismatches(licences[0] || null, sub, camLimit),
      },
      recentChanges: recent.map((c) => ({
        id: String(c.id),
        ts: c.ts,
        action: c.action,
        by: adminById[c.adminUserId]?.email || adminById[c.adminUserId]?.name || null,
        payload: c.payload,
      })),
    },
  });
});

/* ═════════════════════════ Account events (paged) ═════════════════════════ */

const listAccountEvents = asyncHandler(async (req, res) => {
  let owner;
  try { owner = await loadAccountOwner(req.params.userId); } catch (err) { return sendOwnerError(res, err); }
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const members = await User.findAll({ where: { parentUserId: owner.id }, attributes: ['id'] });
  const where = { userId: { [Op.in]: [owner.id, ...members.map((m) => m.id)] } };
  const sev = String(req.query.severity || '').split(',').filter((s) => ['info', 'warning', 'critical'].includes(s));
  if (sev.length) where.severity = { [Op.in]: sev };
  if (req.query.open === '1') where.acknowledgedAt = null;

  const { count, rows } = await AIEvent.findAndCountAll({
    where,
    attributes: ['id', 'eventType', 'severity', 'ts', 'acknowledgedAt', 'confidence', 'monitorId', 'payload'],
    include: [{ model: Camera, as: 'camera', attributes: ['name'], required: false }],
    order: [['ts', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  res.json({
    success: true,
    total: count,
    page,
    limit,
    events: rows.map((e) => ({
      id: e.id,
      type: e.eventType,
      severity: e.severity,
      ts: e.ts,
      camera: e.camera?.name || e.monitorId,
      acked: !!e.acknowledgedAt,
      confidence: e.confidence,
      label: e.payload?.matchedName || e.payload?.zoneName || null,
    })),
  });
});

/* ═════════════════════════ Suspend / reactivate ═════════════════════════ */

const setAccountStatus = asyncHandler(async (req, res) => {
  let owner;
  try { owner = await loadAccountOwner(req.params.userId); } catch (err) { return sendOwnerError(res, err); }
  if (typeof req.body?.active !== 'boolean') throw new AppError('active must be true or false.', 400);
  if (String(owner.id) === String(req.user.id)) throw new AppError('You cannot suspend your own account.', 400);

  const active = req.body.active;
  const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
  if (owner.isActive === active) {
    return res.json({ success: true, unchanged: true, account: { id: owner.id, status: active ? 'active' : 'suspended' } });
  }

  const members = await User.findAll({ where: { parentUserId: owner.id }, attributes: ['id'] });
  const ids = [owner.id, ...members.map((m) => m.id)];

  owner.isActive = active;
  await owner.save();
  // Effective on this process now; other replicas pick it up on their reload.
  accountStatus.setBlocked(ids, !active);

  let revoked = 0;
  if (!active) {
    // Sessions end now: refresh tokens go, live sockets close. Access tokens
    // are refused by authenticate until they expire.
    const [n] = await RefreshToken.update(
      { isRevoked: true },
      { where: { userId: { [Op.in]: ids }, isRevoked: false } },
    ).catch(() => [0]);
    revoked = n;
    try { require('../services/ws.service').disconnectUsers(ids); } catch { /* ws not running */ }
  }
  clearEntitlementCache();

  await writeAudit(req, active ? 'account.reactivated' : 'account.suspended', owner.id, {
    email: owner.email,
    reason,
    users: ids.length,
    sessionsEnded: active ? undefined : revoked,
  });
  platformEvents.record(active ? 'account.reactivated' : 'account.suspended', {
    severity: active ? 'info' : 'warning',
    accountId: owner.id,
    accountLabel: owner.name,
    req,
    summary: active
      ? `${owner.name} was reactivated${reason ? `: “${reason}”` : ''}`
      : `${owner.name} was suspended${reason ? `: “${reason}”` : ''} (${platformEvents.plural(ids.length, 'user')} signed out)`,
    data: { email: owner.email, reason, users: ids.length, sessionsEnded: active ? undefined : revoked },
  });

  res.json({ success: true, account: { id: owner.id, status: active ? 'active' : 'suspended' }, usersAffected: ids.length });
});

/* ═════════════════════════ Password reset (operator-triggered) ═════════════════════════ */

const sendPasswordReset = asyncHandler(async (req, res) => {
  let owner;
  try { owner = await loadAccountOwner(req.params.userId); } catch (err) { return sendOwnerError(res, err); }
  const target = await User.findByPk(req.params.memberId, { attributes: ['id', 'name', 'email', 'parentUserId', 'isActive'] });
  if (!target || (target.id !== owner.id && target.parentUserId !== owner.id)) {
    throw new AppError('That user is not in this account.', 404);
  }
  if (!target.email) throw new AppError('This user signs in with a username and has no email. Reset it from the customer’s Users page.', 400);
  if (!target.isActive || !owner.isActive) throw new AppError('Reactivate the account before sending a reset link.', 409);

  await PasswordReset.update({ usedAt: new Date() }, { where: { userId: target.id, usedAt: null } });
  const token = PasswordReset.generateToken();
  await PasswordReset.create({ userId: target.id, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

  let sent = true;
  let error = null;
  try {
    await require('../services/email.service').sendPasswordResetEmail(target.email, target.name, token);
  } catch (err) {
    sent = false;
    error = err.message;
  }
  await writeAudit(req, 'account.user.password_reset_sent', owner.id, { userId: target.id, email: target.email, sent });
  platformEvents.record('password.reset_requested', {
    accountId: owner.id,
    accountLabel: owner.name,
    req,
    summary: `Password reset link ${sent ? 'sent' : 'could not be emailed'} to ${target.email}`,
    data: { userId: target.id, email: target.email, sent, via: 'operator' },
  });
  if (!sent) {
    return res.status(502).json({ success: false, message: `The reset link was created but the email could not be sent (${error || 'mail error'}). Check Email / SMTP.` });
  }
  res.json({ success: true, message: `Reset link sent to ${target.email}. It is valid for 1 hour.` });
});

/* ═════════════════════════ Click-to-load snapshot ═════════════════════════ */

const getCameraSnapshot = asyncHandler(async (req, res) => {
  let owner;
  try { owner = await loadAccountOwner(req.params.userId); } catch (err) { return sendOwnerError(res, err); }
  const members = await User.findAll({ where: { parentUserId: owner.id }, attributes: ['id'] });
  const camera = await Camera.findOne({
    where: { id: req.params.cameraId, userId: { [Op.in]: [owner.id, ...members.map((m) => m.id)] } },
  });
  if (!camera) throw new AppError('Camera not found', 404);

  let shot;
  try {
    // Cached, one grab per recorder at a time, sub-stream — see liveSnapshot.service.
    shot = await require('../services/liveSnapshot.service').getSnapshot(camera);
  } catch (err) {
    if (err.code === 'OFFLINE') throw new AppError('Camera is offline.', 409);
    throw new AppError('Could not get a still from this camera right now.', 502);
  }
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=30',
    'X-Snapshot-At': new Date(shot.at).toISOString(),
    'Access-Control-Expose-Headers': 'X-Snapshot-At',
  });
  res.send(shot.jpeg);
});

/* ═════════════════════════ Audit log ═════════════════════════ */

const listAudit = asyncHandler(async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const where = {};
  if (req.query.accountId) { where.resourceType = 'account'; where.resourceId = String(req.query.accountId); }
  if (req.query.actorId) where.adminUserId = String(req.query.actorId);
  if (req.query.action) where.action = String(req.query.action);
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if ((from && !isNaN(from)) || (to && !isNaN(to))) {
    where.ts = {};
    if (from && !isNaN(from)) where.ts[Op.gte] = from;
    if (to && !isNaN(to)) where.ts[Op.lte] = to;
  }

  const [{ count, rows }, actorRows, actionRows] = await Promise.all([
    AdminAuditLog.findAndCountAll({ where, order: [['ts', 'DESC'], ['id', 'DESC']], limit, offset: (page - 1) * limit }),
    AdminAuditLog.findAll({ attributes: [[fn('DISTINCT', col('admin_user_id')), 'id']], raw: true }),
    AdminAuditLog.findAll({ attributes: [[fn('DISTINCT', col('action')), 'action']], raw: true }),
  ]);

  const ids = new Set([...actorRows.map((r) => r.id), ...rows.map((r) => r.adminUserId)]);
  for (const r of rows) if (r.resourceType === 'account' && r.resourceId) ids.add(r.resourceId);
  if (req.query.accountId) ids.add(String(req.query.accountId));
  const people = ids.size
    ? await User.findAll({ where: { id: { [Op.in]: [...ids] } }, attributes: ['id', 'name', 'email'], paranoid: false })
    : [];
  const byId = Object.fromEntries(people.map((p) => [p.id, { id: p.id, name: p.name, email: p.email }]));

  res.json({
    success: true,
    total: count,
    page,
    limit,
    rows: rows.map((r) => ({
      id: String(r.id),
      ts: r.ts,
      action: r.action,
      actor: byId[r.adminUserId] || { id: r.adminUserId, name: null, email: null },
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      account: r.resourceType === 'account' ? (byId[r.resourceId] || { id: r.resourceId, name: null, email: null }) : null,
      payload: r.payload,
      ip: r.ip,
    })),
    facets: {
      actors: actorRows.map((r) => byId[r.id] || { id: r.id, name: null, email: null }),
      actions: actionRows.map((r) => r.action).sort(),
    },
  });
});

module.exports = {
  listAccounts, getHub, listAccountEvents, setAccountStatus, sendPasswordReset, getCameraSnapshot, listAudit,
  // exported for unit tests
  eventFeature, licenceMismatches,
};
