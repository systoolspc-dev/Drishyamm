const asyncHandler = require('../middleware/asyncHandler');
const { Op } = require('sequelize');
const {
  Subscription, Plan,
  License, LicenseResource, LicenseFeature,
  Camera,
} = require('../models');

const getStatus = asyncHandler(async (req, res) => {
  const subscription = await Subscription.findOne({
    where: { userId: req.user.id, status: 'active' },
    order: [['createdAt', 'DESC']],
    include: [
      {
        model: Plan,
        as: 'plan',
        attributes: ['id', 'name', 'maxCameras', 'maxStorage', 'price', 'billingCycle'],
      },
    ],
  });

  res.json({
    success: true,
    subscription: subscription
      ? {
          id: subscription.id,
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
        }
      : null,
  });
});

/**
 * GET /subscription/license — returns the current user's active enterprise license
 * along with allocated resources, enabled features, and live utilisation. The
 * customer Settings page consumes this to render real quotas instead of
 * hardcoded pricing constants.
 */
const getMyLicense = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Prefer "active" or "trial" licenses; fall back to most-recent of any status
  const license = await License.findOne({
    where: {
      userId,
      status: { [Op.in]: ['active', 'trial', 'suspended'] },
    },
    include: [
      { model: LicenseResource, as: 'resources' },
      { model: LicenseFeature,  as: 'features'  },
    ],
    order: [
      [require('sequelize').literal(`FIELD(status, 'active', 'trial', 'suspended')`), 'ASC'],
      ['created_at', 'DESC'],
    ],
  });

  if (!license) {
    return res.json({ success: true, license: null });
  }

  // Live utilisation — count cameras currently provisioned for this user
  const userCameras = await Camera.findAll({
    where: { userId },
    attributes: ['id', 'status'],
  });
  const camsProvisioned = userCameras.length;
  const camsOnline      = userCameras.filter(c => c.status === 'online').length;

  // Days remaining until end_date
  let daysRemaining = null;
  if (license.endDate) {
    const ms = new Date(license.endDate) - new Date();
    daysRemaining = Math.ceil(ms / (24 * 60 * 60 * 1000));
  }

  res.json({
    success: true,
    license: {
      id: license.id,
      status: license.status,
      term: license.term,
      startDate: license.startDate,
      endDate:   license.endDate,
      daysRemaining,
      currency: license.currency,
      mrr: parseFloat(license.mrr),
      arr: parseFloat(license.arr),
      setupFee: parseFloat(license.setupFee),
      discountPct: parseFloat(license.discountPct),
      resources: license.resources.map(r => ({
        sku: r.sku,
        quota: r.quota,
        used: r.used,
        unitPrice: parseFloat(r.unitPriceSnapshot),
      })),
      features: license.features.map(f => ({
        featureKey: f.featureKey,
        enabled:    f.enabled,
        config:     f.configJson,
      })),
      utilisation: {
        camerasProvisioned: camsProvisioned,
        camerasOnline:      camsOnline,
      },
    },
  });
});

// GET /api/subscription/usage — the account's licences, used vs allowed, so
// Camera Setup and the AI switches can show what is left before the backend
// has to refuse. Same numbers the refusals are computed from.
const getUsage = asyncHandler(async (req, res) => {
  const { getCameraLicence } = require('../services/cameraQuota.service');
  const { getEntitlements, countLicenceUsage, allowsAny } = require('../services/entitlements.service');
  const { AI_LICENCES } = require('../utils/featureCatalog');

  const cameras = await getCameraLicence(req.user.id);
  const ent = await getEntitlements(req.user.id);
  const usage = await countLicenceUsage(ent.ownerId);
  const ai = AI_LICENCES
    .filter((lic) => allowsAny(ent, lic.features))
    .map((lic) => {
      const raw = ent.featureLimits?.[lic.key];
      const limit = raw === undefined || raw === null ? null : Number(raw);
      const used = usage.byLicence[lic.key]?.used || 0;
      return { key: lic.key, label: lic.label, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
    });

  res.json({
    success: true,
    data: {
      cameras: { limit: cameras.limit, used: cameras.used, remaining: cameras.remaining },
      ai,
    },
  });
});

module.exports = { getStatus, getMyLicense, getUsage };
