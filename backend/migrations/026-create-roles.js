'use strict';

// Custom, account-defined roles (name + assigned capabilities) + the link from
// a user to one. Built-in tiers stay in code; this only adds the extra roles an
// admin creates. Idempotent.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const norm = tables.map((t) => (typeof t === 'string' ? t : t.tableName));

    if (!norm.includes('roles')) {
      await queryInterface.createTable('roles', {
        id:           { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id:      { type: 'CHAR(36) BINARY', allowNull: false },
        name:         { type: Sequelize.STRING(60), allowNull: false },
        capabilities: { type: Sequelize.JSON, allowNull: false },
        created_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at:   { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
      await queryInterface.addIndex('roles', ['user_id', 'name'], { unique: true, name: 'roles_user_name_unique' });
    }

    const cols = await queryInterface.describeTable('users');
    if (!cols.custom_role_id) {
      await queryInterface.addColumn('users', 'custom_role_id', {
        type: 'CHAR(36) BINARY', allowNull: true,
      });
      await queryInterface.addIndex('users', ['custom_role_id'], { name: 'users_custom_role_id_idx' });
    }
  },

  async down(queryInterface) {
    const cols = await queryInterface.describeTable('users');
    if (cols.custom_role_id) {
      try { await queryInterface.removeIndex('users', 'users_custom_role_id_idx'); } catch (_) {}
      await queryInterface.removeColumn('users', 'custom_role_id');
    }
    await queryInterface.dropTable('roles');
  },
};
