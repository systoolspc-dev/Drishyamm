'use strict';

// Licenses + supporting tables for the custom enterprise billing model.
// One license per active customer engagement; resources & features are
// rows-not-JSON so we can index, query, and report on them.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('licenses')) {
      await queryInterface.createTable('licenses', {
        id:        { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id:   { type: 'CHAR(36) BINARY', allowNull: false },
        status: {
          type: Sequelize.ENUM('draft', 'trial', 'active', 'suspended', 'expired', 'terminated'),
          allowNull: false,
          defaultValue: 'draft',
        },
        term: {
          type: Sequelize.ENUM('trial_30', 'trial_60', 'trial_90', 'monthly', 'annual', 'biennial', 'triennial'),
          allowNull: false,
          defaultValue: 'monthly',
        },
        start_date:    { type: Sequelize.DATEONLY, allowNull: true },
        end_date:      { type: Sequelize.DATEONLY, allowNull: true },
        license_key:   { type: Sequelize.TEXT, allowNull: true },              // Signed JWT (Phase D)
        currency:      { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'INR' },
        mrr:           { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        arr:           { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        setup_fee:     { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        discount_pct:  { type: Sequelize.DECIMAL(5, 2),  allowNull: false, defaultValue: 0 },
        notes:         { type: Sequelize.TEXT, allowNull: true },
        created_by_admin_id: { type: 'CHAR(36) BINARY', allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('licenses', ['user_id']).catch(() => {});
      await queryInterface.addIndex('licenses', ['status']).catch(() => {});
      await queryInterface.addIndex('licenses', ['end_date']).catch(() => {});
    }

    if (!tables.includes('license_resources')) {
      await queryInterface.createTable('license_resources', {
        id:         { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        license_id: { type: 'CHAR(36) BINARY', allowNull: false },
        sku:        { type: Sequelize.STRING(64),  allowNull: false },          // 'cam_hd', 'cam_4k', 'storage_gb', 'gpu_hour'
        quota:      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        used:       { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        unit_price_snapshot: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
        created_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('license_resources', ['license_id']).catch(() => {});
      await queryInterface.addIndex('license_resources', ['license_id', 'sku'], { unique: true }).catch(() => {});
    }

    if (!tables.includes('license_features')) {
      await queryInterface.createTable('license_features', {
        id:         { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        license_id: { type: 'CHAR(36) BINARY', allowNull: false },
        feature_key: { type: Sequelize.STRING(64), allowNull: false },          // 'face_recognition', 'behavior', 'lpr', 'talkback', 'mobile', 'api', 'redundancy'
        enabled:     { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        config_json: { type: Sequelize.JSON, allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('license_features', ['license_id']).catch(() => {});
      await queryInterface.addIndex('license_features', ['license_id', 'feature_key'], { unique: true }).catch(() => {});
    }

    if (!tables.includes('quotes')) {
      await queryInterface.createTable('quotes', {
        id:           { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id:      { type: 'CHAR(36) BINARY', allowNull: true },             // null = anonymous quote
        line_items:   { type: Sequelize.JSON, allowNull: false },               // [{sku, qty, unit_price, line_total}, …]
        term:         { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'monthly' },
        discount_pct: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        subtotal:     { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        total_monthly:{ type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        total_term:   { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
        currency:     { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'INR' },
        status: {
          type: Sequelize.ENUM('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'),
          allowNull: false,
          defaultValue: 'draft',
        },
        expires_at:   { type: Sequelize.DATE, allowNull: true },
        license_id:   { type: 'CHAR(36) BINARY', allowNull: true },              // set when converted
        created_by_admin_id: { type: 'CHAR(36) BINARY', allowNull: true },
        notes:        { type: Sequelize.TEXT, allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('quotes', ['user_id']).catch(() => {});
      await queryInterface.addIndex('quotes', ['status']).catch(() => {});
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('quotes').catch(() => {});
    await queryInterface.dropTable('license_features').catch(() => {});
    await queryInterface.dropTable('license_resources').catch(() => {});
    await queryInterface.dropTable('licenses').catch(() => {});
  },
};
