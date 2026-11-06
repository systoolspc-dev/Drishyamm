const asyncHandler = require('../middleware/asyncHandler');
const { Op } = require('sequelize');
const {
  License, LicenseResource, LicenseFeature,
  PricingCatalog, Quote, User, Camera, sequelize,
} = require('../models');
const AppError = require('../utils/AppError');

const TERM_MONTHS = {
  trial_30:  1,   trial_60: 2,   trial_90: 3,
  monthly:   1,   annual:  12,   biennial: 24,  triennial: 36,
};

const TERM_TO_DISCOUNT_SKU = {
  trial_30:  'term_trial_30',
  trial_60:  'term_trial_60',
  trial_90:  'term_trial_90',
  monthly:   'term_monthly',
  annual:    'term_annual',
  biennial:  'term_biennial',
  triennial: 'term_triennial',
};

const VALID_TERMS = Object.keys(TERM_MONTHS);

const FEATURE_SKUS = ['feat_face_rec', 'feat_behavior', 'feat_lpr', 'feat_talkback', 'feat_mobile', 'feat_api'];
const RESOURCE_SKUS = ['cam_hd', 'cam_4k', 'storage_gb', 'gpu_hour'];

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Recompute MRR/ARR + line items + monthly total from a license payload + the
 * pricing catalog. Returns the same shape as billing.controller's calculateQuote.
 */
async function computePricing(payload) {
  const term = VALID_TERMS.includes(payload.term) ? payload.term : 'monthly';
  const discountPct = Math.max(0, Math.min(25, Number(payload.discountPct) || 0));
  const retentionDays = Math.max(1, Number(payload.retentionDays) || 30);
  const supportSku = payload.support || 'support_basic';
  const includeSetupFee = !!payload.includeSetupFee;
  const resources = payload.resources || {};
  const features = payload.features || {};

  const catalogRows = await PricingCatalog.findAll({ where: { isActive: true } });
  const catalog = Object.fromEntries(catalogRows.map(r => [r.sku, r]));

  const lineItems = [];
  const addLine = (sku, qty, unitOverride) => {
    if (!qty) return;
    const item = catalog[sku];
    if (!item) return;
    const unitPrice = unitOverride !== undefined ? Number(unitOverride) : Number(item.unitPriceInr);
    lineItems.push({
      sku, name: item.name, category: item.category, unit: item.unit,
      qty,
      unit_price: unitPrice,
      line_total: +(unitPrice * qty).toFixed(2),
    });
  };

  const hd = Number(resources.cam_hd?.quota) || 0;
  const k4 = Number(resources.cam_4k?.quota) || 0;
  const totalCameras = hd + k4;
  addLine('cam_hd', hd);
  addLine('cam_4k', k4);

  const storageGb = Number(resources.storage_gb?.quota) || 0;
  const retentionFactor = retentionDays / 30;
  if (storageGb > 0) {
    const item = catalog['storage_gb'];
    const unit = item ? Number(item.unitPriceInr) : 0;
    addLine('storage_gb', storageGb, +(unit * retentionFactor).toFixed(4));
  }

  addLine('gpu_hour', Number(resources.gpu_hour?.quota) || 0);

  for (const sku of FEATURE_SKUS) {
    const f = features[sku];
    if (!f || !f.enabled) continue;
    const cams = Number(f.cameras !== undefined ? f.cameras : totalCameras);
    if (cams > 0) addLine(sku, cams);
  }

  if (supportSku && catalog[supportSku] && catalog[supportSku].category === 'support') {
    addLine(supportSku, 1);
  }

  const subtotalRecurring = lineItems
    .filter(l => l.unit !== 'one_time')
    .reduce((s, l) => s + l.line_total, 0);

  const termSku = TERM_TO_DISCOUNT_SKU[term];
  const termItem = catalog[termSku];
  const termMultiplier = termItem ? Number(termItem.unitPriceInr) / 100 : 1;
  const afterTerm = +(subtotalRecurring * termMultiplier).toFixed(2);
  const totalMonthly = +(afterTerm * (1 - discountPct / 100)).toFixed(2);
  const months = TERM_MONTHS[term];
  const totalTerm = +(totalMonthly * months).toFixed(2);
  const arr = +(totalMonthly * 12).toFixed(2);

  const setupFee = includeSetupFee && catalog['setup_fee'] ? Number(catalog['setup_fee'].unitPriceInr) : 0;
  if (includeSetupFee && setupFee > 0) addLine('setup_fee', 1);

  return {
    term, months, lineItems, subtotalRecurring: +subtotalRecurring.toFixed(2),
    termMultiplier, discountPct,
    totalMonthly, totalTerm, arr, setupFee,
    catalog, retentionDays, retentionFactor: +retentionFactor.toFixed(2),
  };
}

/* ────────────── List licenses ────────────── */

const listLicenses = asyncHandler(async (req, res) => {
  const { status, term, userId, search } = req.query;
  const where = {};
  if (status && status !== 'all') where.status = status;
  if (term && term !== 'all')     where.term   = term;
  if (userId && userId !== 'all') where.userId = userId;

  const userWhere = {};
  if (search && search.trim()) {
    userWhere[Op.or] = [
      { name:  { [Op.like]: `%${search.trim()}%` } },
      { email: { [Op.like]: `%${search.trim()}%` } },
    ];
  }

  const licenses = await License.findAll({
    where,
    include: [
      { model: User, as: 'user', attributes: ['id', 'name', 'email'], required: search ? true : false, where: search ? userWhere : undefined },
      { model: LicenseResource, as: 'resources' },
      { model: LicenseFeature,  as: 'features'  },
    ],
    order: [['created_at', 'DESC']],
  });

  // Compute live used counts (cameras created after license issuance)
  const userIds = [...new Set(licenses.map(l => l.userId))];
  const cameraCounts = await Camera.findAll({
    where: { userId: { [Op.in]: userIds.length ? userIds : ['__none__'] } },
    attributes: ['userId', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
    group: ['userId'],
    raw: true,
  });
  const camMap = Object.fromEntries(cameraCounts.map(r => [r.userId, parseInt(r.count, 10)]));

  res.json({
    success: true,
    licenses: licenses.map(l => {
      const totalCamQuota = l.resources
        .filter(r => r.sku === 'cam_hd' || r.sku === 'cam_4k')
        .reduce((s, r) => s + r.quota, 0);
      const camsUsed = camMap[l.userId] || 0;
      return {
        id: l.id,
        userId: l.userId,
        customer: l.user ? { id: l.user.id, name: l.user.name, email: l.user.email } : null,
        status: l.status,
        term:   l.term,
        startDate: l.startDate,
        endDate:   l.endDate,
        mrr: parseFloat(l.mrr),
        arr: parseFloat(l.arr),
        setupFee: parseFloat(l.setupFee),
        discountPct: parseFloat(l.discountPct),
        currency: l.currency,
        notes: l.notes,
        cameraQuota: totalCamQuota,
        camerasUsed: camsUsed,
        resourceCount: l.resources.length,
        featuresEnabled: l.features.filter(f => f.enabled).length,
        createdAt: l.createdAt,
      };
    }),
  });
});

/* ────────────── Get one license ────────────── */

const getLicense = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const license = await License.findByPk(id, {
    include: [
      { model: User, as: 'user', attributes: ['id', 'name', 'email'] },
      { model: LicenseResource, as: 'resources' },
      { model: LicenseFeature,  as: 'features'  },
    ],
  });
  if (!license) throw new AppError('License not found', 404);

  // Live utilisation
  const userCameras = await Camera.findAll({
    where: { userId: license.userId },
    attributes: ['id', 'name', 'status', 'width', 'height'],
  });
  const onlineCams = userCameras.filter(c => c.status === 'online').length;

  res.json({
    success: true,
    license: {
      id: license.id,
      user: license.user ? { id: license.user.id, name: license.user.name, email: license.user.email } : null,
      status: license.status,
      term: license.term,
      startDate: license.startDate,
      endDate:   license.endDate,
      licenseKey: license.licenseKey,
      mrr: parseFloat(license.mrr),
      arr: parseFloat(license.arr),
      setupFee: parseFloat(license.setupFee),
      discountPct: parseFloat(license.discountPct),
      currency: license.currency,
      notes: license.notes,
      resources: license.resources.map(r => ({
        sku: r.sku, quota: r.quota, used: r.used,
        unitPriceSnapshot: parseFloat(r.unitPriceSnapshot),
      })),
      features: license.features.map(f => ({
        featureKey: f.featureKey,
        enabled: f.enabled,
        config: f.configJson,
      })),
      utilisation: {
        cameras: { used: userCameras.length, online: onlineCams },
      },
      createdAt: license.createdAt,
      updatedAt: license.updatedAt,
    },
  });
});

/* ────────────── Create license (from calculator/quote payload) ────────────── */

const createLicense = asyncHandler(async (req, res) => {
  const { userId, payload, notes } = req.body;
  if (!userId) throw new AppError('userId is required', 400);

  const user = await User.findByPk(userId);
  if (!user) throw new AppError('User not found', 404);

  const term = VALID_TERMS.includes(payload?.term) ? payload.term : 'monthly';
  const isTrial = term.startsWith('trial_');
  const months = TERM_MONTHS[term];

  const pricing = await computePricing(payload || {});

  const startDate = todayISO();
  const endDate = addMonths(new Date(), months).toISOString().slice(0, 10);

  const t = await sequelize.transaction();
  try {
    const license = await License.create({
      userId,
      status: isTrial ? 'trial' : 'active',
      term,
      startDate, endDate,
      mrr: pricing.totalMonthly,
      arr: pricing.arr,
      setupFee: pricing.setupFee,
      discountPct: pricing.discountPct,
      notes: notes || null,
      currency: 'INR',
      createdByAdminId: req.user?.id || null,
    }, { transaction: t });

    // Resources — write a row per camera/storage/gpu SKU
    const resourceWrites = [];
    for (const sku of RESOURCE_SKUS) {
      const quota = Number(payload?.resources?.[sku]?.quota) || 0;
      if (quota <= 0) continue;
      const item = pricing.catalog[sku];
      resourceWrites.push({
        licenseId: license.id,
        sku,
        quota,
        used: 0,
        unitPriceSnapshot: item ? Number(item.unitPriceInr) : 0,
      });
    }
    if (resourceWrites.length) {
      await LicenseResource.bulkCreate(resourceWrites, { transaction: t });
    }

    // Features — one row per feature with enabled flag + per-feature config
    const featureWrites = FEATURE_SKUS.map(sku => {
      const f = payload?.features?.[sku] || {};
      return {
        licenseId: license.id,
        featureKey: sku,
        enabled: !!f.enabled,
        configJson: f.cameras !== undefined ? { cameras: Number(f.cameras) } : null,
      };
    });
    await LicenseFeature.bulkCreate(featureWrites, { transaction: t });

    await t.commit();

    res.status(201).json({
      success: true,
      license: {
        id: license.id,
        userId: license.userId,
        status: license.status,
        term:   license.term,
        startDate, endDate,
        mrr: pricing.totalMonthly,
        arr: pricing.arr,
      },
    });
  } catch (err) {
    await t.rollback();
    throw err;
  }
});

/* ────────────── Update license status ────────────── */

const setLicenseStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const allowed = ['draft', 'trial', 'active', 'suspended', 'expired', 'terminated'];
  if (!allowed.includes(status)) throw new AppError(`Invalid status. Must be one of: ${allowed.join(', ')}`, 400);

  const license = await License.findByPk(id);
  if (!license) throw new AppError('License not found', 404);

  license.status = status;
  if (notes !== undefined) license.notes = notes ? String(notes).slice(0, 5000) : null;
  await license.save();

  res.json({ success: true, license: { id: license.id, status: license.status } });
});

/* ────────────── Save quote (draft) ────────────── */

const saveQuote = asyncHandler(async (req, res) => {
  const { userId, payload, notes } = req.body;
  const pricing = await computePricing(payload || {});
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const quote = await Quote.create({
    userId: userId || null,
    lineItems: pricing.lineItems,
    term: pricing.term,
    discountPct: pricing.discountPct,
    subtotal: pricing.subtotalRecurring,
    totalMonthly: pricing.totalMonthly,
    totalTerm: pricing.totalTerm,
    currency: 'INR',
    status: 'draft',
    expiresAt,
    notes: notes || null,
    createdByAdminId: req.user?.id || null,
  });

  res.status(201).json({
    success: true,
    quote: {
      id: quote.id,
      userId: quote.userId,
      totalMonthly: parseFloat(quote.totalMonthly),
      totalTerm: parseFloat(quote.totalTerm),
      term: quote.term,
      status: quote.status,
      expiresAt: quote.expiresAt,
      createdAt: quote.createdAt,
    },
  });
});

module.exports = {
  listLicenses,
  getLicense,
  createLicense,
  setLicenseStatus,
  saveQuote,
};
