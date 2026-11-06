'use strict';

// Pricing catalog: per-SKU rates the admin can edit. The pricing calculator
// and license builder both read from this table. One row per pricing primitive.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('pricing_catalog')) return;

    await queryInterface.createTable('pricing_catalog', {
      id: {
        type: 'CHAR(36) BINARY',
        primaryKey: true,
        allowNull: false,
      },
      sku:        { type: Sequelize.STRING(64),  allowNull: false },
      name:       { type: Sequelize.STRING(120), allowNull: false },
      category: {
        type: Sequelize.ENUM('camera', 'storage', 'compute', 'ai_feature', 'support', 'one_time', 'discount'),
        allowNull: false,
      },
      unit:       { type: Sequelize.STRING(32),  allowNull: false },           // 'per_camera_month', 'per_gb_month', 'per_gpu_hour', 'flat_month', 'one_time', 'multiplier'
      unit_price_inr: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      description: { type: Sequelize.STRING(255), allowNull: true },
      is_active:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('pricing_catalog', ['sku'], { unique: true }).catch(() => {});
    await queryInterface.addIndex('pricing_catalog', ['category']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('pricing_catalog').catch(() => {});
  },
};
