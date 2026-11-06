/**
 * cameraQuota.service — camera-licence enforcement.
 *
 * The only prior limit check lived in the now-dead Shinobi controller, so the
 * real create paths (cameraGroup create / add-channels, bulkImport) had NO
 * enforcement — any user could add unlimited cameras regardless of plan.
 *
 * Resolution order for an account's cap (always the ACCOUNT OWNER's, so a
 * sub-user adding cameras spends the same licence):
 *   1. Active/trialing subscription with camera_limit set → that number
 *      (per-account licence set in the admin console; 0 = no cameras)
 *   2. Active/trialing subscription → plan.maxCameras (null/0 = unlimited plan)
 *   3. No subscription               → FREE_TIER_MAX_CAMERAS (0/unset = unlimited)
 *
 * Toggle the whole feature with ENFORCE_CAMERA_LIMITS=false (default ON), so a
 * dev/demo box can add freely without editing code.
 */
const { Op } = require('sequelize');
const AppError = require('../utils/AppError');
const { resolveOwnerId, activeSubscription, accountUserIds } = require('./entitlements.service');

const ENFORCE       = process.env.ENFORCE_CAMERA_LIMITS !== 'false';        // default ON
const FREE_TIER_MAX = parseInt(process.env.FREE_TIER_MAX_CAMERAS || '0', 10); // 0 = unlimited

/**
 * The account's camera licence and how much of it is used.
 * @returns {Promise<{ownerId, limit: number|null, used: number, remaining: number|null,
 *                    source: 'account'|'plan'|'free', planName: string, planDefault: number|null}>}
 *          limit null = unlimited.
 */
async function getCameraLicence(userId) {
  const { Camera } = require('../models');
  const ownerId = await resolveOwnerId(userId);
  const sub = await activeSubscription(ownerId);

  let limit;
  let source;
  let planName;
  let planDefault = null;
  if (sub && sub.plan) {
    planName = sub.plan.name;
    planDefault = sub.plan.maxCameras > 0 ? sub.plan.maxCameras : null;
    if (sub.cameraLimit !== null && sub.cameraLimit !== undefined) {
      limit = Math.max(0, sub.cameraLimit);
      source = 'account';
    } else {
      limit = planDefault;
      source = 'plan';
    }
  } else {
    planName = 'Free';
    limit = FREE_TIER_MAX > 0 ? FREE_TIER_MAX : null;
    source = 'free';
  }

  const userIds = await accountUserIds(ownerId);
  const used = await Camera.count({ where: { userId: { [Op.in]: userIds } } });
  return {
    ownerId,
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    source,
    planName,
    planDefault,
  };
}

/**
 * Throw a 403 AppError if adding `addingCount` cameras would exceed the
 * account's camera licence. No-op when enforcement is off or the cap is unlimited.
 *
 * @param {string} userId
 * @param {number} addingCount  how many cameras this operation will create
 */
async function assertCameraQuota(userId, addingCount = 1) {
  if (!ENFORCE) return;
  const lic = await getCameraLicence(userId);
  if (lic.limit === null) return;

  if (lic.used + addingCount > lic.limit) {
    const plural = lic.limit === 1 ? '' : 's';
    const who = lic.source === 'account' ? 'This account is' : `Your ${lic.planName} plan is`;
    throw new AppError(
      `Camera licence limit reached. ${who} licensed for ${lic.limit} camera${plural} ` +
      `(${lic.used} in use, ${lic.remaining} remaining)` +
      (addingCount > 1 ? `; you tried to add ${addingCount}` : '') +
      '. Ask your administrator to add camera licences.',
      403,
    );
  }
}

module.exports = { assertCameraQuota, getCameraLicence, ENFORCE_CAMERA_LIMITS: ENFORCE };
