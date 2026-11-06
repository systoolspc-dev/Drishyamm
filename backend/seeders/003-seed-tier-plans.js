'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Trial tier plans + correct ai_enabled on existing plans.
 *
 *   Basic VMS  → ai_enabled=false  (video management only)
 *   AI+VMS     → ai_enabled=true   (adds face/ANPR/weapon/fire/crowd/journey)
 *
 * Idempotent: safe to re-run (the deploy runs `db:seed:all` on every boot).
 * Also back-fills ai_enabled on the pre-existing catalogue so paid/unlimited
 * tiers keep AI after migration 027 (which defaults the new column to false).
 */
module.exports = {
  async up(queryInterface) {
    const trialTiers = [
      { name: 'Basic VMS', max_cameras: 8, ai_enabled: false },
      { name: 'AI+VMS', max_cameras: 8, ai_enabled: true },
    ];

    for (const t of trialTiers) {
      const [rows] = await queryInterface.sequelize.query(
        'SELECT id FROM plans WHERE name = ?',
        { replacements: [t.name] }
      );
      if (rows && rows.length) {
        await queryInterface.sequelize.query(
          'UPDATE plans SET ai_enabled = ? WHERE name = ?',
          { replacements: [t.ai_enabled, t.name] }
        );
        continue;
      }
      await queryInterface.bulkInsert('plans', [
        {
          id: uuidv4(),
          name: t.name,
          max_cameras: t.max_cameras,
          max_storage: 20 * 1024 * 1024 * 1024, // 20 GB trial
          price: 0.0,
          billing_cycle: 'monthly',
          ai_enabled: t.ai_enabled,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    }

    // Back-fill existing plans so AI-bearing tiers keep AI (027 defaulted false).
    await queryInterface.sequelize.query(
      "UPDATE plans SET ai_enabled = TRUE WHERE name IN ('Pro','Enterprise','Demo Unlimited')"
    );
    await queryInterface.sequelize.query(
      "UPDATE plans SET ai_enabled = FALSE WHERE name = 'Free'"
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('plans', { name: ['Basic VMS', 'AI+VMS'] }, {});
  },
};
