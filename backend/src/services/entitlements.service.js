/**
 * entitlements.service — what one customer account may use.
 *
 *   tier      "Basic VMS" (plan.aiEnabled=false) vs "AI+VMS" (plan.aiEnabled=true)
 *   features  Subscription.features — NULL = everything the tier allows, an
 *             array = only those keys (the same keys the sidebar rows carry)
 *   licences  Subscription.featureLimits — per-camera AI caps, e.g. {face: 10}
 *
 * Everything resolves to the ACCOUNT OWNER (users.parent_user_id || users.id):
 * a sub-user has no subscription of its own, and reading theirs made every
 * sub-user look like a Basic account with no features.
 *
 * Mirrors cameraQuota.service's active/trialing subscription→plan lookup so
 * both read the same source.
 */
const { Op } = require('sequelize');
const AppError = require('../utils/AppError');
const { SUBSCRIPTION_STATUS } = require('../utils/constants');
const {
  AI_FEATURE_KEYS, FACE_ENGINE_KEYS, AI_LICENCES, featureLabel, licenceFor, isFeatureOn,
} = require('../utils/featureCatalog');

const LIVE_STATUSES = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIALING];

// Gated routes run this on every request, some of them polled every few
// seconds. A short cache keeps that to one lookup per user per window; the
// admin console clears it on every change so a switch takes effect at once.
const CACHE_MS = 5000;
const _cache = new Map();

function clearEntitlementCache() {
  _cache.clear();
}

/** users.parent_user_id || users.id */
async function resolveOwnerId(userId) {
  if (!userId) return userId;
  const { User } = require('../models');
  const u = await User.findByPk(userId, { attributes: ['id', 'parentUserId'], paranoid: false });
  return (u && u.parentUserId) || userId;
}

/** The owner's current (most recent active/trialing) subscription, plan included. */
async function activeSubscription(ownerId) {
  const { Subscription, Plan } = require('../models');
  return Subscription.findOne({
    where: { userId: ownerId, status: { [Op.in]: LIVE_STATUSES } },
    include: [{ model: Plan, as: 'plan' }],
    order: [['createdAt', 'DESC']],
  });
}

/** Owner + every sub-user id — cameras may sit under either. */
async function accountUserIds(ownerId) {
  const { User } = require('../models');
  const members = await User.findAll({ where: { parentUserId: ownerId }, attributes: ['id'] });
  return [ownerId, ...members.map((m) => m.id)];
}

/**
 * Full entitlement snapshot for the auth responses and the feature gates:
 *   { ownerId, aiEnabled, features, featureLimits, cameraLimit }
 * features === null  → every feature the tier allows.
 * features === array → the curated subset (returned for Basic accounts too, so
 *                      an admin can hide a VMS page such as Map from them).
 * @param {string} userId  any user of the account
 */
async function getEntitlements(userId) {
  const hit = _cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const ownerId = await resolveOwnerId(userId);
  const sub = await activeSubscription(ownerId);
  const aiEnabled = sub?.plan?.aiEnabled === true;
  const features = Array.isArray(sub?.features) && sub.features.length ? sub.features : null;
  const value = {
    ownerId,
    aiEnabled,
    features,
    featureLimits: (sub && sub.featureLimits && typeof sub.featureLimits === 'object') ? sub.featureLimits : {},
    hasSubscription: !!sub,
  };
  _cache.set(userId, { at: Date.now(), value });
  return value;
}

/** True if the account's current plan includes AI. */
async function getAiEntitlement(userId) {
  return (await getEntitlements(userId)).aiEnabled;
}

/** Throw 403 if the account's plan does not include AI. */
async function assertAiEntitled(userId) {
  if (!(await getAiEntitlement(userId))) {
    throw new AppError('AI features are not included in your plan. Upgrade to AI+VMS.', 403);
  }
}

/**
 * Does this snapshot allow ANY of `keys`? AI keys also need the AI tier.
 * Same rule the sidebar applies (core/nav/entitlements.js): a full account
 * (features null) has everything its tier allows; on a curated list a
 * defaultOn key (Video wall, Recordings, Alerts, …) is on unless "!key" is
 * stored — featureCatalog.isFeatureOn.
 */
function allowsAny(ent, keys) {
  return keys.some((k) => {
    if (AI_FEATURE_KEYS.includes(k) && !ent.aiEnabled) return false;
    return isFeatureOn(ent.features, k);
  });
}

/** Throw 403 unless the account has at least one of `keys` switched on. */
async function assertFeature(userId, keys) {
  const ent = await getEntitlements(userId);
  if (allowsAny(ent, keys)) return ent;
  const isAi = keys.every((k) => AI_FEATURE_KEYS.includes(k));
  if (isAi && !ent.aiEnabled) {
    throw new AppError('AI features are not included in your plan. Upgrade to AI+VMS.', 403);
  }
  throw new AppError(
    `${featureLabel(keys[0])} is not enabled for this account. Ask your administrator to switch it on.`,
    403,
  );
}

/**
 * Owners whose plan includes AI AND who still have a face-engine feature —
 * one query, for the runtime reconcile loop (aiLifecycle.service) that stops
 * detection for downgraded/Basic accounts. An account whose admin switched off
 * every face/tracking feature drops out too, so its cameras stop running the
 * face engine within one reconcile instead of burning GPU for a page it can
 * no longer open.
 * @returns {Promise<Set<string>>}
 */
async function getAiEntitledUserIds() {
  const { Subscription, Plan } = require('../models');
  const subs = await Subscription.findAll({
    where: { status: { [Op.in]: LIVE_STATUSES } },
    include: [{ model: Plan, as: 'plan', where: { aiEnabled: true }, required: true, attributes: [] }],
    attributes: ['userId', 'features'],
  });
  return new Set(
    subs
      .filter((s) => !Array.isArray(s.features) || !s.features.length
        || s.features.some((k) => FACE_ENGINE_KEYS.includes(k)))
      .map((s) => s.userId),
  );
}

/**
 * How many cameras each per-camera AI licence is in use on, for one account.
 * @returns {Promise<{ cameras: number, byLicence: Object<string, {used:number, cameraIds:string[]}> }>}
 */
async function countLicenceUsage(ownerId) {
  const { Camera, RestrictedZone } = require('../models');
  const userIds = await accountUserIds(ownerId);
  const cams = await Camera.findAll({
    where: { userId: { [Op.in]: userIds } },
    attributes: ['id', 'name', 'monitorId', 'settings', 'updatedAt'],
  });
  const byLicence = {};
  for (const lic of AI_LICENCES) {
    if (lic.isOn) {
      const on = cams.filter(lic.isOn);
      byLicence[lic.key] = { used: on.length, cameraIds: on.map((c) => c.id) };
    }
  }
  // Restricted zones: a camera uses the licence when it has at least one
  // armed zone. Counted by monitorId (zones are keyed by it, not camera id).
  const zones = await RestrictedZone.findAll({
    where: { userId: { [Op.in]: userIds }, enabled: true },
    attributes: ['monitorId'],
  });
  const zoneMonitors = new Set(zones.map((z) => z.monitorId));
  const zoneCams = cams.filter((c) => zoneMonitors.has(c.monitorId));
  // Only zones on cameras that still exist count — a zone left behind by a
  // deleted camera arms nothing.
  byLicence.restricted_zone = {
    used: zoneCams.length,
    cameraIds: zoneCams.map((c) => c.id),
  };
  return { cameras: cams.length, byLicence, cameraRows: cams };
}

/**
 * Refuse switching a per-camera AI feature ON for `adding` more cameras when
 * the account lacks the feature or its licence is used up. Call only on an
 * off→on transition — switching a feature OFF is always allowed.
 *
 * @param {string} userId       the requesting user (any user of the account)
 * @param {string} licenceKey   AI_LICENCES key: face | headcount | activity | restricted_zone
 * @param {number} adding       cameras about to be switched on
 */
async function assertAiLicence(userId, licenceKey, adding = 1) {
  const lic = licenceFor(licenceKey);
  if (!lic || adding <= 0) return;
  const ent = await assertFeature(userId, lic.features);

  const raw = ent.featureLimits?.[licenceKey];
  if (raw === undefined || raw === null || raw === '') return; // no separate cap
  const limit = Math.max(0, parseInt(raw, 10) || 0);

  const { byLicence } = await countLicenceUsage(ent.ownerId);
  const used = byLicence[licenceKey]?.used || 0;
  if (used + adding > limit) {
    const remaining = Math.max(0, limit - used);
    const plural = limit === 1 ? '' : 's';
    throw new AppError(
      `${lic.label} licence limit reached. This account is licensed for ${limit} camera${plural} ` +
      `(${used} in use, ${remaining} remaining)` +
      (adding > 1 ? `; you tried to switch on ${adding}` : '') +
      '. Ask your administrator to add licences.',
      403,
    );
  }
}

module.exports = {
  getAiEntitlement,
  getEntitlements,
  assertAiEntitled,
  assertFeature,
  allowsAny,
  assertAiLicence,
  countLicenceUsage,
  accountUserIds,
  resolveOwnerId,
  activeSubscription,
  getAiEntitledUserIds,
  clearEntitlementCache,
};
