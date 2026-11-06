'use strict';

const { v4: uuidv4 } = require('uuid');

// Default pricing rates for the a-la-carte enterprise license model.
// Admin can edit any of these in the Pricing Catalog page after seeding.

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM pricing_catalog');
    if (Number(rows?.[0]?.count || 0) > 0) return;

    const now = new Date();
    const make = (sku, name, category, unit, price, description, sortOrder) => ({
      id: uuidv4(),
      sku, name, category, unit,
      unit_price_inr: price,
      description,
      is_active: true,
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    });

    await queryInterface.bulkInsert('pricing_catalog', [
      // ── Cameras ──────────────────────────────────────────────────────
      make('cam_hd',   'HD Camera (1080p / 2MP)', 'camera', 'per_camera_month',  599, 'H.264/H.265 stream up to 1080p, 30fps', 10),
      make('cam_4k',   '4K Camera (8MP)',         'camera', 'per_camera_month', 1299, '4× compute & storage vs HD',          11),

      // ── Storage ──────────────────────────────────────────────────────
      make('storage_gb', 'Storage (per GB / month)', 'storage', 'per_gb_month', 3, 'Warm S3-class object storage with retention', 20),

      // ── Compute ──────────────────────────────────────────────────────
      make('gpu_hour', 'GPU Inference Hour', 'compute', 'per_gpu_hour', 45, 'Blackwell-class GPU amortised', 30),

      // ── AI Features (priced per camera/month) ────────────────────────
      make('feat_face_rec',  'Face Recognition',    'ai_feature', 'per_camera_month', 299, 'AdaFace + SCRFD pipeline',           40),
      make('feat_behavior',  'Behaviour Detection', 'ai_feature', 'per_camera_month', 199, 'Tripwire, loitering, intrusion',     41),
      make('feat_lpr',       'LPR / Vehicle',       'ai_feature', 'per_camera_month', 249, 'Licence-plate + vehicle attributes', 42),
      make('feat_talkback',  'Talkback Audio',      'ai_feature', 'per_camera_month',  99, 'Two-way audio',                      43),
      make('feat_mobile',    'Mobile App',          'ai_feature', 'per_camera_month',  49, 'iOS + Android live + playback',      44),
      make('feat_api',       'API Access',          'ai_feature', 'per_camera_month',  99, 'Programmatic stream/event access',   45),

      // ── Support tiers (flat / month) ─────────────────────────────────
      make('support_basic',    'Basic Support',    'support', 'flat_month',     0, 'Email, 3 business-day response',          50),
      make('support_business', 'Business Support', 'support', 'flat_month',  9990, '1 business-day SLA, phone + email',       51),
      make('support_24x7',     '24×7 Support',     'support', 'flat_month', 49990, 'Dedicated CSM, 1-hour critical response', 52),

      // ── One-time fees ────────────────────────────────────────────────
      make('setup_fee', 'Setup & Onboarding', 'one_time', 'one_time', 25000, 'Initial deployment, training, integration', 60),

      // ── Term-commitment discount multipliers ─────────────────────────
      // unit = 'multiplier' — `unit_price_inr` here is the multiplier × 100 (so 100.00 = ×1.00, 85.00 = ×0.85)
      make('term_monthly',   'Monthly (no commit)', 'discount', 'multiplier', 100.00, '×1.00 (no discount)',                 70),
      make('term_annual',    'Annual',              'discount', 'multiplier',  85.00, '×0.85 (15% off)',                     71),
      make('term_biennial',  '2-Year',              'discount', 'multiplier',  75.00, '×0.75 (25% off)',                     72),
      make('term_triennial', '3-Year',              'discount', 'multiplier',  65.00, '×0.65 (35% off)',                     73),
      make('term_trial_30',  'Trial — 30 days',     'discount', 'multiplier',   0.00, 'Free pilot, expires after 30 days',   74),
      make('term_trial_60',  'Trial — 60 days',     'discount', 'multiplier',   0.00, 'Free pilot, expires after 60 days',   75),
      make('term_trial_90',  'Trial — 90 days',     'discount', 'multiplier',   0.00, 'Free pilot, expires after 90 days',   76),
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('pricing_catalog', null, {});
  },
};
