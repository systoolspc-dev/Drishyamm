const asyncHandler = require('../middleware/asyncHandler');
const { PricingCatalog } = require('../models');
const AppError = require('../utils/AppError');

// First-run defaults — if the pricing_catalog table is empty (e.g. migrations
// were applied but the seeder wasn't run), populate it on the first request.
// Idempotent: only runs when COUNT(*) === 0.
const DEFAULT_CATALOG = [
  { sku: 'cam_hd',         name: 'HD Camera (1080p / 2MP)', category: 'camera',     unit: 'per_camera_month', unitPriceInr:  599, description: 'H.264/H.265 stream up to 1080p, 30fps',     sortOrder: 10 },
  { sku: 'cam_4k',         name: '4K Camera (8MP)',         category: 'camera',     unit: 'per_camera_month', unitPriceInr: 1299, description: '4× compute & storage vs HD',                 sortOrder: 11 },
  { sku: 'storage_gb',     name: 'Storage (per GB / month)', category: 'storage',   unit: 'per_gb_month',     unitPriceInr:    3, description: 'Warm S3-class object storage with retention', sortOrder: 20 },
  { sku: 'gpu_hour',       name: 'GPU Inference Hour',      category: 'compute',    unit: 'per_gpu_hour',     unitPriceInr:   45, description: 'Blackwell-class GPU amortised',             sortOrder: 30 },
  { sku: 'feat_face_rec',  name: 'Face Recognition',        category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:  299, description: 'AdaFace + SCRFD pipeline',                  sortOrder: 40 },
  { sku: 'feat_behavior',  name: 'Behaviour Detection',     category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:  199, description: 'Tripwire, loitering, intrusion',            sortOrder: 41 },
  { sku: 'feat_lpr',       name: 'LPR / Vehicle',           category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:  249, description: 'Licence-plate + vehicle attributes',        sortOrder: 42 },
  { sku: 'feat_talkback',  name: 'Talkback Audio',          category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:   99, description: 'Two-way audio',                             sortOrder: 43 },
  { sku: 'feat_mobile',    name: 'Mobile App',              category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:   49, description: 'iOS + Android live + playback',             sortOrder: 44 },
  { sku: 'feat_api',       name: 'API Access',              category: 'ai_feature', unit: 'per_camera_month', unitPriceInr:   99, description: 'Programmatic stream/event access',          sortOrder: 45 },
  { sku: 'support_basic',     name: 'Basic Support',     category: 'support',  unit: 'flat_month',  unitPriceInr:     0, description: 'Email, 3 business-day response',            sortOrder: 50 },
  { sku: 'support_business',  name: 'Business Support',  category: 'support',  unit: 'flat_month',  unitPriceInr:  9990, description: '1 business-day SLA, phone + email',         sortOrder: 51 },
  { sku: 'support_24x7',      name: '24×7 Support',      category: 'support',  unit: 'flat_month',  unitPriceInr: 49990, description: 'Dedicated CSM, 1-hour critical response',   sortOrder: 52 },
  { sku: 'setup_fee',         name: 'Setup & Onboarding', category: 'one_time', unit: 'one_time',   unitPriceInr: 25000, description: 'Initial deployment, training, integration', sortOrder: 60 },
  { sku: 'term_monthly',      name: 'Monthly (no commit)', category: 'discount', unit: 'multiplier', unitPriceInr: 100.00, description: '×1.00 (no discount)',                       sortOrder: 70 },
  { sku: 'term_annual',       name: 'Annual',              category: 'discount', unit: 'multiplier', unitPriceInr:  85.00, description: '×0.85 (15% off)',                           sortOrder: 71 },
  { sku: 'term_biennial',     name: '2-Year',              category: 'discount', unit: 'multiplier', unitPriceInr:  75.00, description: '×0.75 (25% off)',                           sortOrder: 72 },
  { sku: 'term_triennial',    name: '3-Year',              category: 'discount', unit: 'multiplier', unitPriceInr:  65.00, description: '×0.65 (35% off)',                           sortOrder: 73 },
  { sku: 'term_trial_30',     name: 'Trial — 30 days',     category: 'discount', unit: 'multiplier', unitPriceInr:   0.00, description: 'Free pilot, expires after 30 days',         sortOrder: 74 },
  { sku: 'term_trial_60',     name: 'Trial — 60 days',     category: 'discount', unit: 'multiplier', unitPriceInr:   0.00, description: 'Free pilot, expires after 60 days',         sortOrder: 75 },
  { sku: 'term_trial_90',     name: 'Trial — 90 days',     category: 'discount', unit: 'multiplier', unitPriceInr:   0.00, description: 'Free pilot, expires after 90 days',         sortOrder: 76 },
];

async function ensureCatalogSeeded() {
  const count = await PricingCatalog.count();
  if (count > 0) return;
  await PricingCatalog.bulkCreate(DEFAULT_CATALOG.map(r => ({ ...r, isActive: true })));
}

// Cost-of-goods estimates used to compute gross margin in the calculator.
// These are admin-tunable in a future Phase but hard-coded for now since
// they reflect platform-level economics rather than customer-facing prices.
const COGS = {
  per_hd_camera_month:    180, // GPU + bandwidth
  per_4k_camera_month:    520, // 4× HD
  per_gb_month:             1, // S3-tier blended
  per_gpu_hour:            18, // hardware amortisation + power
  per_face_rec_cam_month: 110,
  per_behavior_cam_month:  60,
  per_lpr_cam_month:       70,
};

// Term → months and discount-multiplier-key mapping
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

/* ────────────── Pricing catalog CRUD ────────────── */

const getCatalog = asyncHandler(async (req, res) => {
  await ensureCatalogSeeded();
  const items = await PricingCatalog.findAll({
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });
  res.json({ success: true, items });
});

const updateCatalogItem = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { unitPriceInr, isActive, name, description } = req.body;

  const item = await PricingCatalog.findByPk(id);
  if (!item) throw new AppError('Catalog item not found', 404);

  if (unitPriceInr !== undefined) {
    const v = Number(unitPriceInr);
    if (isNaN(v) || v < 0) throw new AppError('unitPriceInr must be ≥ 0', 400);
    item.unitPriceInr = v;
  }
  if (isActive !== undefined)  item.isActive = !!isActive;
  if (name)        item.name        = String(name).slice(0, 120);
  if (description !== undefined) item.description = description ? String(description).slice(0, 255) : null;

  await item.save();
  res.json({ success: true, item });
});

/* ────────────── Quote calculator (stateless) ──────────────
 *
 * Body shape:
 * {
 *   resources: {
 *     cam_hd: { quota: 250 },
 *     cam_4k: { quota: 50 },
 *     storage_gb: { quota: 20000 },     // 20 TB
 *     gpu_hour:   { quota: 200 }        // monthly inference budget
 *   },
 *   features: {
 *     feat_face_rec:  { enabled: true, cameras: 300 },   // applied per camera
 *     feat_behavior:  { enabled: true, cameras: 200 },
 *     feat_lpr:       { enabled: false },
 *     feat_talkback:  { enabled: false },
 *     feat_mobile:    { enabled: true,  cameras: 300 },
 *     feat_api:       { enabled: true,  cameras: 300 }
 *   },
 *   support: 'support_business',                          // sku
 *   includeSetupFee: true,
 *   term: 'annual',                                       // see TERM_MONTHS
 *   discountPct: 10,                                      // 0..25, on top of term multiplier
 *   retentionDays: 30                                     // multiplies storage if > 30
 * }
 */
const calculateQuote = asyncHandler(async (req, res) => {
  await ensureCatalogSeeded();
  const body = req.body || {};
  const resources = body.resources || {};
  const features  = body.features  || {};
  const term      = TERM_MONTHS[body.term] ? body.term : 'monthly';
  const discountPct = Math.max(0, Math.min(25, Number(body.discountPct) || 0));
  const retentionDays = Math.max(1, Number(body.retentionDays) || 30);
  const supportSku  = body.support || 'support_basic';

  // Load catalog into a sku→item map
  const catalogRows = await PricingCatalog.findAll({ where: { isActive: true } });
  const catalog = Object.fromEntries(catalogRows.map(r => [r.sku, r]));

  const lineItems = [];
  const addLine = (sku, qty, unitOverride) => {
    if (!qty) return
    const item = catalog[sku];
    if (!item) return;
    const unitPrice = unitOverride !== undefined ? Number(unitOverride) : Number(item.unitPriceInr);
    const lineTotal = +(unitPrice * qty).toFixed(2);
    lineItems.push({
      sku,
      name: item.name,
      category: item.category,
      unit: item.unit,
      qty,
      unit_price: unitPrice,
      line_total: lineTotal,
    });
  };

  // ── Cameras (per-camera/month) ──────────────────────────────────────
  const hdCount = Number(resources.cam_hd?.quota) || 0;
  const k4Count = Number(resources.cam_4k?.quota) || 0;
  addLine('cam_hd', hdCount);
  addLine('cam_4k', k4Count);
  const totalCameras = hdCount + k4Count;

  // ── Storage (GB/month, scaled by retention beyond 30d) ──────────────
  const storageGb = Number(resources.storage_gb?.quota) || 0;
  const retentionFactor = retentionDays / 30;
  if (storageGb > 0) {
    const item = catalog['storage_gb'];
    const unit = item ? Number(item.unitPriceInr) : 0;
    const effectiveUnit = +(unit * retentionFactor).toFixed(4);
    addLine('storage_gb', storageGb, effectiveUnit);
  }

  // ── Compute (GPU hour) ──────────────────────────────────────────────
  const gpuHours = Number(resources.gpu_hour?.quota) || 0;
  addLine('gpu_hour', gpuHours);

  // ── AI features (per camera/month, scaled by per-feature camera count) ──
  const featureSkus = ['feat_face_rec', 'feat_behavior', 'feat_lpr', 'feat_talkback', 'feat_mobile', 'feat_api'];
  for (const sku of featureSkus) {
    const f = features[sku];
    if (!f || !f.enabled) continue;
    // If admin doesn't specify per-feature cameras, default to all cameras
    const cams = Number(f.cameras !== undefined ? f.cameras : totalCameras);
    if (cams > 0) addLine(sku, cams);
  }

  // ── Support tier ────────────────────────────────────────────────────
  if (supportSku && catalog[supportSku] && catalog[supportSku].category === 'support') {
    addLine(supportSku, 1);
  }

  // ── Compute monthly subtotal (recurring), separate from one-time ────
  const subtotalRecurring = lineItems
    .filter(l => l.unit !== 'one_time')
    .reduce((s, l) => s + l.line_total, 0);

  // Apply term multiplier (e.g. annual → ×0.85)
  const termSku = TERM_TO_DISCOUNT_SKU[term];
  const termItem = catalog[termSku];
  const termMultiplier = termItem ? Number(termItem.unitPriceInr) / 100 : 1;
  const afterTerm = +(subtotalRecurring * termMultiplier).toFixed(2);

  // Then apply discretionary discount on top
  const afterDiscount = +(afterTerm * (1 - discountPct / 100)).toFixed(2);

  const months = TERM_MONTHS[term];
  const totalMonthly = afterDiscount;
  const totalTerm    = +(totalMonthly * months).toFixed(2);
  const arr          = +(totalMonthly * 12).toFixed(2);

  // One-time setup fee (added to first invoice, NOT to MRR)
  const includeSetup = !!body.includeSetupFee;
  const setupFee = includeSetup && catalog['setup_fee'] ? Number(catalog['setup_fee'].unitPriceInr) : 0;
  if (includeSetup && setupFee > 0) addLine('setup_fee', 1);

  // ── Margin estimate ─────────────────────────────────────────────────
  const cogsHd      = hdCount * COGS.per_hd_camera_month;
  const cogsK4      = k4Count * COGS.per_4k_camera_month;
  const cogsStorage = storageGb * retentionFactor * COGS.per_gb_month;
  const cogsGpu     = gpuHours  * COGS.per_gpu_hour;
  const cogsFace    = features.feat_face_rec?.enabled
    ? (Number(features.feat_face_rec.cameras ?? totalCameras) * COGS.per_face_rec_cam_month) : 0;
  const cogsBeh     = features.feat_behavior?.enabled
    ? (Number(features.feat_behavior.cameras ?? totalCameras) * COGS.per_behavior_cam_month) : 0;
  const cogsLpr     = features.feat_lpr?.enabled
    ? (Number(features.feat_lpr.cameras ?? totalCameras) * COGS.per_lpr_cam_month) : 0;
  const totalCogs   = +(cogsHd + cogsK4 + cogsStorage + cogsGpu + cogsFace + cogsBeh + cogsLpr).toFixed(2);
  const grossProfit = +(totalMonthly - totalCogs).toFixed(2);
  const marginPct   = totalMonthly > 0 ? +((grossProfit / totalMonthly) * 100).toFixed(1) : 0;

  res.json({
    success: true,
    quote: {
      term,
      months,
      lineItems,
      subtotalRecurring: +subtotalRecurring.toFixed(2),
      termMultiplier,
      discountPct,
      totalMonthly,
      totalTerm,
      arr,
      setupFee,
      currency: 'INR',
      cogsMonthly: totalCogs,
      grossProfitMonthly: grossProfit,
      marginPct,
      retentionDays,
      retentionFactor: +retentionFactor.toFixed(2),
      cameras: { hd: hdCount, fourK: k4Count, total: totalCameras },
    },
  });
});

module.exports = {
  getCatalog,
  updateCatalogItem,
  calculateQuote,
};
