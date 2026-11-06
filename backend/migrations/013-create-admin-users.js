'use strict';

// Plain CHAR(36) (no BINARY) under utf8mb4_unicode_ci — same convention as
// migrations 008-012. See migration 008 for the errno-150 backstory.
const CHAR36 = 'CHAR(36) BINARY';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('admin_users')) return;

    await queryInterface.createTable('admin_users', {
      id: {
        type: CHAR36,
        primaryKey: true,
        allowNull: false,
      },
      email:         { type: Sequelize.STRING(255), allowNull: false },
      name:          { type: Sequelize.STRING(120), allowNull: false },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      role: {
        type: Sequelize.ENUM('superadmin', 'support', 'billing', 'readonly'),
        allowNull: false,
        defaultValue: 'support',
      },
      mfa_enabled:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      mfa_secret:    { type: Sequelize.STRING(255), allowNull: true },
      last_login_at: { type: Sequelize.DATE, allowNull: true },
      last_login_ip: { type: Sequelize.STRING(64), allowNull: true },
      status: {
        type: Sequelize.ENUM('active', 'suspended'),
        allowNull: false,
        defaultValue: 'active',
      },
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

    await queryInterface.addIndex('admin_users', ['email'], { unique: true }).catch(() => {});
    await queryInterface.addIndex('admin_users', ['role']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('admin_users').catch(() => {});
  },
};
