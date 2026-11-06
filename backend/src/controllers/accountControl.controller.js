/**
 * accountControl.controller — the admin console's one screen per customer
 * account: plan tier, camera licence, per-camera AI licences, and which
 * features the account's sidebar (and API) has.
 *
 *   GET /api/admin/accounts/:userId/control    snapshot + recent changes
 *   PUT /api/admin/accounts/:userId/plan       { planId }
 *   PUT /api/admin/accounts/:userId/licences   { cameraLimit?, featureLimits?, confirmBelowUsage?, overLimit? }
 *   PUT /api/admin/accounts/:userId/features   { features: string[] } | { mode: 'all' }
 *
 * Everything writes the account owner's Subscription (the row cameraQuota and
 * entitlements already read) — there is no second licence store. Every change
 * lands in admin_audit_log (shown on the screen) and the file audit trail.
 *
 * Guard rails: a licence can be set below what is in use only when the admin
 * says what should happen (409 BELOW_USAGE otherwise). Cameras are never
 * deleted by a licence change; per-camera AI can be kept running (new switches
 * blocked) or switched off on the newest excess cameras.
 */
const { Op } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { audit } = require('../utils/audit');
const {
  User, Plan, Subscription, License, LicenseResource, Camera, RestrictedZone, AdminAuditLog,
} = require('../models');
const {
  FEATURE_GROUPS, ALL_FEATURE_KEYS, AI_LICENCES, licenceFor, featureStateOf, storedFeatures,
} = require('../utils/featureCatalog');
const {
  activeSubscription, countLicenceUsage, clearEntitlementCache, accountUserIds,
} = require('../services/entitlements.service');
const { getCameraLicence, ENFORCE_CAMERA_LIMITS } = require('../services/cameraQuota.service');
const { SUBSCRIPTION_STATUS } = require('../utils/constants');
const platformEvents = require('../services/platformEvents.service');

// "Every feature off" is stored as ["_none"] — featureCatalog.NO_FEATURES.
const MAX_LIMIT = 100000;

/* ───────────────────────── helpers ───────────────────────── */

const featureLabel = (k) => FEATURE_GROUPS.flatMap((g) => g.items).find((i) => i.key === k)?.label || k;
const limitText = (v) => (v === null || v === undefined ? 'no limit' : String(v));

/** Live activity feed line for a saved change (the audit row keeps the detail). */
function announce(req, type, owner, summary, data) {
  platformEvents.record(type, { accountId: owner.id, accountLabel: owner.name, req, summary, data });
}

async function loadOwner(userId) {
  const user = await User.findByPk(userId, { attributes: { exclude: ['password'] } });
  if (!user) throw new AppError('Account not found', 404);
  if (user.parentUserId) {
    const owner = await User.findByPk(user.parentUserId, { attributes: ['id', 'name', 'email'] });
    const err = new AppError(
      `${user.name} is a user inside ${owner ? owner.name : 'another'} account. Manage the account owner instead.`,
      400,
    );
    err.ownerId = user.parentUserId;
    throw err;
  }
  return user;
}

async function recordChange(req, action, ownerId, payload) {
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

function parseLimit(v, label) {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
    throw new AppError(`${label} must be a whole number from 0 to ${MAX_LIMIT}, or empty for no limit.`, 400);
  }
  return n;
}

// The read/write rule for Subscription.features lives in featureCatalog
// (defaultOn keys are stored as "!key" when off), shared with entitlements.
function featureState(sub) {
  return featureStateOf(Array.isArray(sub?.features) ? sub.features : null);
}

/** Switch a per-camera AI feature off on the given cameras. Returns their ids. */
async function switchOffOnCameras(licenceKey, cameras, ownerId) {
  const now = new Date().toISOString();
  const ids = [];
  for (const cam of cameras) {
    const s = cam.settings || {};
    let next = null;
    if (licenceKey === 'face') {
      next = { ...s, ai: { ...(s.ai || {}), enabled: false, mode: 'off', disabledAt: now, updatedAt: now } };
    } else if (licenceKey === 'headcount') {
      next = { ...s, headcount: { ...(s.headcount || {}), enabled: false, updatedAt: now } };
    } else if (licenceKey === 'activity') {
      next = { ...s, ai: { ...(s.ai || {}), activityMonitoring: false, updatedAt: now } };
    }
    if (next) {
      await Camera.update({ settings: next }, { where: { id: cam.id } });
      ids.push(cam.id);
    }
  }
  if (licenceKey === 'restricted_zone' && cameras.length) {
    const userIds = await accountUserIds(ownerId);
    await RestrictedZone.update(
      { enabled: false },
      { where: { userId: { [Op.in]: userIds }, monitorId: { [Op.in]: cameras.map((c) => c.monitorId) } } },
    );
    ids.push(...cameras.map((c) => c.id));
  }
  if (licenceKey === 'activity' && ids.length) {
    // The activity-monitor is told the full desired set; best-effort.
    require('./ai.controller').pushActivityCameras().catch(() => {});
  }
  return ids;
}

async function buildSnapshot(owner) {
  const sub = await activeSubscription(owner.id);
  const [plans, members, licenceRow, camLic, usage, changes] = await Promise.all([
    Plan.findAll({ where: { isActive: true }, order: [['price', 'ASC']] }),
    User.count({ where: { parentUserId: owner.id } }),
    License.findOne({
      where: { userId: owner.id },
      include: [{ model: LicenseResource, as: 'resources' }],
      order: [['createdAt', 'DESC']],
    }),
    getCameraLicence(owner.id),
    countLicenceUsage(owner.id),
    AdminAuditLog.findAll({
      where: { resourceType: 'account', resourceId: owner.id },
      order: [['ts', 'DESC']],
      limit: 30,
    }),
  ]);

  const adminIds = [...new Set(changes.map((c) => c.adminUserId))];
  const admins = adminIds.length
    ? await User.findAll({ where: { id: { [Op.in]: adminIds } }, attributes: ['id', 'name', 'email'], paranoid: false })
    : [];
  const adminById = Object.fromEntries(admins.map((a) => [a.id, a]));

  const fs = featureState(sub);
  const aiOn = sub?.plan?.aiEnabled === true;
  const limits = (sub?.featureLimits && typeof sub.featureLimits === 'object') ? sub.featureLimits : {};
  const camNames = Object.fromEntries(usage.cameraRows.map((c) => [c.id, c.name]));

  return {
    account: {
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: owner.role,
      isActive: owner.isActive,
      createdAt: owner.createdAt,
      members,
    },
    subscription: sub ? {
      id: sub.id,
      status: sub.status,
      planId: sub.planId,
      planName: sub.plan?.name || null,
      aiEnabled: aiOn,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
    } : null,
    plans: plans.map((p) => ({
      id: p.id, name: p.name, maxCameras: p.maxCameras, aiEnabled: p.aiEnabled === true,
    })),
    // The commercial licence record from Licenses (pricing calculator), when
    // there is one: shown for its term and validity. Enforcement reads the
    // subscription above, not this.
    licenceRecord: licenceRow ? {
      id: licenceRow.id,
      status: licenceRow.status,
      term: licenceRow.term,
      startDate: licenceRow.startDate,
      endDate: licenceRow.endDate,
      cameraQuota: (licenceRow.resources || [])
        .filter((r) => r.sku === 'cam_hd' || r.sku === 'cam_4k')
        .reduce((s, r) => s + r.quota, 0),
    } : null,
    cameras: {
      limit: camLic.limit,
      used: camLic.used,
      remaining: camLic.remaining,
      source: camLic.source,
      planDefault: camLic.planDefault,
      override: sub && sub.cameraLimit !== null && sub.cameraLimit !== undefined ? sub.cameraLimit : null,
      enforced: ENFORCE_CAMERA_LIMITS,
    },
    aiLicences: AI_LICENCES.map((lic) => {
      const u = usage.byLicence[lic.key] || { used: 0, cameraIds: [] };
      const raw = limits[lic.key];
      const limit = raw === undefined || raw === null ? null : Number(raw);
      const featureOn = aiOn && (fs.mode === 'all' || lic.features.some((k) => fs.enabled.includes(k)));
      return {
        key: lic.key,
        label: lic.label,
        features: lic.features,
        featureOn,
        limit,
        used: u.used,
        remaining: limit === null ? null : Math.max(0, limit - u.used),
        cameras: u.cameraIds.map((id) => ({ id, name: camNames[id] || id })),
      };
    }),
    features: {
      mode: fs.mode,
      enabled: fs.enabled,
      unknown: fs.unknown,
      groups: FEATURE_GROUPS.map((g) => ({
        id: g.id,
        label: g.label,
        description: g.description || null,
        ai: g.ai,
        licence: g.licence || null,
        // description = plain helper text from the catalog, when it has one.
        items: g.items.map((i) => ({
          key: i.key, label: i.label, note: i.note || null, description: i.description || null, on: fs.enabled.includes(i.key),
        })),
      })),
    },
    changes: changes.map((c) => ({
      id: String(c.id),
      ts: c.ts,
      action: c.action,
      admin: adminById[c.adminUserId]
        ? { name: adminById[c.adminUserId].name, email: adminById[c.adminUserId].email }
        : { name: null, email: null },
      payload: c.payload,
    })),
  };
}

/* ───────────────────────── handlers ───────────────────────── */

const getControl = asyncHandler(async (req, res) => {
  let owner;
  try {
    owner = await loadOwner(req.params.userId);
  } catch (err) {
    if (err.ownerId) {
      return res.status(400).json({ success: false, message: err.message, ownerId: err.ownerId });
    }
    throw err;
  }
  res.json({ success: true, data: await buildSnapshot(owner) });
});

const setPlan = asyncHandler(async (req, res) => {
  const owner = await loadOwner(req.params.userId);
  const plan = await Plan.findByPk(req.body?.planId);
  if (!plan) throw new AppError('Choose a plan.', 400);

  const sub = await activeSubscription(owner.id);
  const before = sub ? { planId: sub.planId, planName: sub.plan?.name || null } : null;
  if (sub) {
    await sub.update({ planId: plan.id });
  } else {
    // Same shape self-registration creates: an open-ended active subscription.
    const now = new Date();
    const end = new Date(now);
    end.setFullYear(end.getFullYear() + 100);
    await Subscription.create({
      userId: owner.id,
      planId: plan.id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: end,
    });
  }
  clearEntitlementCache();
  await recordChange(req, 'account.plan.changed', owner.id, {
    before, after: { planId: plan.id, planName: plan.name, aiEnabled: plan.aiEnabled === true },
  });
  announce(req, 'account.plan_changed', owner,
    `Plan changed: ${platformEvents.planLabel(before?.planName) || 'none'} → ${platformEvents.planLabel(plan.name)}`,
    { before: before?.planName || null, after: plan.name });
  res.json({ success: true, data: await buildSnapshot(owner) });
});

const setLicences = asyncHandler(async (req, res) => {
  const owner = await loadOwner(req.params.userId);
  const sub = await activeSubscription(owner.id);
  if (!sub) throw new AppError('This account has no plan yet. Assign a plan first.', 409);

  const body = req.body || {};
  const overLimit = (body.overLimit && typeof body.overLimit === 'object') ? body.overLimit : {};

  const touchCameras = Object.prototype.hasOwnProperty.call(body, 'cameraLimit');
  const nextCameraLimit = touchCameras ? parseLimit(body.cameraLimit, 'Camera licences') : sub.cameraLimit;

  const prevLimits = (sub.featureLimits && typeof sub.featureLimits === 'object') ? { ...sub.featureLimits } : {};
  const nextLimits = { ...prevLimits };
  const touched = [];
  if (body.featureLimits && typeof body.featureLimits === 'object') {
    for (const [key, v] of Object.entries(body.featureLimits)) {
      const lic = licenceFor(key);
      if (!lic) throw new AppError(`Unknown AI licence: ${key}`, 400);
      const n = parseLimit(v, `${lic.label} licences`);
      if (n === null) delete nextLimits[key]; else nextLimits[key] = n;
      touched.push(key);
    }
  }

  // Guard rails — what is in use right now.
  const camLic = await getCameraLicence(owner.id);
  const usage = await countLicenceUsage(owner.id);
  const conflicts = [];
  if (touchCameras && nextCameraLimit !== null && nextCameraLimit < camLic.used && body.confirmBelowUsage !== true) {
    conflicts.push({ key: 'cameras', label: 'Camera licences', limit: nextCameraLimit, used: camLic.used });
  }
  for (const key of touched) {
    const limit = nextLimits[key];
    const used = usage.byLicence[key]?.used || 0;
    if (limit !== undefined && limit < used && !['keep', 'disable_excess'].includes(overLimit[key])) {
      conflicts.push({ key, label: licenceFor(key).label, limit, used });
    }
  }
  if (conflicts.length) {
    return res.status(409).json({
      success: false,
      code: 'BELOW_USAGE',
      message: 'Some limits are below what this account is using now. Choose what should happen first.',
      conflicts,
    });
  }

  const prevCameraLimit = sub.cameraLimit ?? null;
  await sub.update({ cameraLimit: nextCameraLimit, featureLimits: nextLimits });

  // Excess cameras: newest first, so the cameras a customer set up first and
  // relies on keep running.
  const switchedOff = {};
  for (const key of touched) {
    const limit = nextLimits[key];
    const u = usage.byLicence[key];
    if (overLimit[key] !== 'disable_excess' || limit === undefined || !u || u.used <= limit) continue;
    const onCams = usage.cameraRows
      .filter((c) => u.cameraIds.includes(c.id))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const excess = onCams.slice(0, u.used - limit);
    switchedOff[key] = await switchOffOnCameras(key, excess, owner.id);
  }

  clearEntitlementCache();
  await recordChange(req, 'account.licences.changed', owner.id, {
    before: { cameraLimit: prevCameraLimit, featureLimits: prevLimits },
    after: { cameraLimit: nextCameraLimit, featureLimits: nextLimits },
    inUse: { cameras: camLic.used, ...Object.fromEntries(touched.map((k) => [k, usage.byLicence[k]?.used || 0])) },
    overLimit: Object.keys(overLimit).length ? overLimit : undefined,
    confirmBelowUsage: body.confirmBelowUsage === true || undefined,
    switchedOff: Object.keys(switchedOff).length ? switchedOff : undefined,
  });
  {
    const parts = [];
    if (touchCameras && prevCameraLimit !== nextCameraLimit) parts.push(`cameras ${limitText(prevCameraLimit)} → ${limitText(nextCameraLimit)}`);
    for (const k of touched) {
      if (prevLimits[k] !== nextLimits[k]) parts.push(`${licenceFor(k).label} ${limitText(prevLimits[k])} → ${limitText(nextLimits[k])}`);
    }
    if (parts.length) {
      announce(req, 'account.licences_changed', owner, `Licences changed: ${parts.join(', ')}`, {
        before: { cameraLimit: prevCameraLimit, featureLimits: prevLimits },
        after: { cameraLimit: nextCameraLimit, featureLimits: nextLimits },
      });
    }
  }
  res.json({ success: true, switchedOff, data: await buildSnapshot(owner) });
});

const setFeatures = asyncHandler(async (req, res) => {
  const owner = await loadOwner(req.params.userId);
  const sub = await activeSubscription(owner.id);
  if (!sub) throw new AppError('This account has no plan yet. Assign a plan first.', 409);

  const before = featureState(sub);
  let stored;
  if (req.body?.mode === 'all') {
    stored = null;
  } else {
    if (!Array.isArray(req.body?.features)) throw new AppError('features must be a list of feature keys.', 400);
    const bad = req.body.features.filter((k) => !ALL_FEATURE_KEYS.includes(k));
    if (bad.length) throw new AppError(`Unknown feature: ${bad.join(', ')}`, 400);
    const chosen = ALL_FEATURE_KEYS.filter((k) => req.body.features.includes(k));
    // Keys this console does not know (set by hand, e.g. crowd_monitoring) are
    // kept as they were, so saving here never silently removes them.
    stored = storedFeatures(chosen, before.unknown);
  }

  // A per-camera feature switched off entirely also stops on its cameras.
  // Head count and activity are run by services that read the per-camera flag
  // directly, so the flag is cleared (the ids go into the audit entry, so it
  // can be put back). Face and restricted zones need no camera edit: the AI
  // reconcile loop and the zone engine both read the account's switches.
  const after = featureState({ features: stored });
  const switchedOff = {};
  if (sub.plan?.aiEnabled === true) {
    const usage = await countLicenceUsage(owner.id);
    for (const key of ['headcount', 'activity']) {
      const lic = licenceFor(key);
      const wasOn = before.mode === 'all' || lic.features.some((k) => before.enabled.includes(k));
      const nowOn = after.mode === 'all' || lic.features.some((k) => after.enabled.includes(k));
      const u = usage.byLicence[key];
      if (wasOn && !nowOn && u && u.used) {
        const cams = usage.cameraRows.filter((c) => u.cameraIds.includes(c.id));
        switchedOff[key] = await switchOffOnCameras(key, cams, owner.id);
      }
    }
  }

  await sub.update({ features: stored });
  clearEntitlementCache();
  await recordChange(req, 'account.features.changed', owner.id, {
    before: before.mode === 'all' ? 'all' : before.enabled,
    after: stored === null ? 'all' : after.enabled,
    added: after.enabled.filter((k) => !before.enabled.includes(k)),
    removed: before.enabled.filter((k) => !after.enabled.includes(k)),
    switchedOff: Object.keys(switchedOff).length ? switchedOff : undefined,
  });
  {
    const added = after.enabled.filter((k) => !before.enabled.includes(k));
    const removed = before.enabled.filter((k) => !after.enabled.includes(k));
    const parts = [];
    if (stored === null && before.mode !== 'all') parts.push('all features on');
    if (added.length && stored !== null) parts.push(`on: ${platformEvents.nameList(added.map(featureLabel), 3)}`);
    if (removed.length) parts.push(`off: ${platformEvents.nameList(removed.map(featureLabel), 3)}`);
    if (parts.length) {
      announce(req, 'account.features_changed', owner, `Features changed: ${parts.join(' · ')}`, { added, removed, all: stored === null });
    }
  }
  res.json({ success: true, switchedOff, data: await buildSnapshot(owner) });
});

module.exports = { getControl, setPlan, setLicences, setFeatures };
