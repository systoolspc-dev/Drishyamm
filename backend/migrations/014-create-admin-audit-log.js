'use strict';

const CHAR36 = 'CHAR(36) BINARY';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('admin_audit_log')) return;

    await queryInterface.createTable('admin_audit_log', {
      id: {
        type:          Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey:    true,
        allowNull:     false,
      },
      admin_user_id: {
        type:       CHAR36,
        allowNull:  false,
        references: { model: 'admin_users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'NO ACTION',
      },
      action:        { type: Sequelize.STRING(64),  allowNull: false },
      resource_type: { type: Sequelize.STRING(64),  allowNull: false },
      resource_id:   { type: CHAR36,                allowNull: true },
      payload:       { type: Sequelize.JSON,        allowNull: true },
      ip:            { type: Sequelize.STRING(64),  allowNull: true },
      user_agent:    { type: Sequelize.STRING(255), allowNull: true },
      ts: {
        type:        Sequelize.DATE,
        allowNull:   false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('admin_audit_log', ['admin_user_id', 'ts']).catch(() => {});
    await queryInterface.addIndex('admin_audit_log', ['resource_type', 'resource_id']).catch(() => {});
    await queryInterface.addIndex('admin_audit_log', ['action', 'ts']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('admin_audit_log').catch(() => {});
  },
};
