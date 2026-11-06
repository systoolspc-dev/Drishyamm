'use strict';

// RBAC: give users a login username, a resource scope (Sites/Groups), an
// account-owner link for sub-users, and the expanded role set. Idempotent +
// backward-compatible — existing email/`user`/`admin` rows keep working.

module.exports = {
  async up(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('users');

    if (!cols.username) {
      await queryInterface.addColumn('users', 'username', {
        type: Sequelize.STRING(100), allowNull: true,
      });
      await queryInterface.addIndex('users', ['username'], {
        unique: true, name: 'users_username_unique',
      });
    }

    if (!cols.scope) {
      await queryInterface.addColumn('users', 'scope', {
        type: Sequelize.JSON, allowNull: true, // NULL = no restriction
      });
    }

    if (!cols.parent_user_id) {
      await queryInterface.addColumn('users', 'parent_user_id', {
        type: 'CHAR(36) BINARY', allowNull: true,
      });
      await queryInterface.addIndex('users', ['parent_user_id'], {
        name: 'users_parent_user_id_idx',
      });
    }

    // Expand the role ENUM (admin/user → + manager/operator/viewer). Existing
    // 'admin' / 'user' rows are preserved; 'user' stays as a legacy full-access alias.
    await queryInterface.changeColumn('users', 'role', {
      type: Sequelize.ENUM('admin', 'manager', 'operator', 'viewer', 'user'),
      allowNull: false,
      defaultValue: 'viewer',
    });

    // A username-only sub-user may have no email.
    await queryInterface.changeColumn('users', 'email', {
      type: Sequelize.STRING(255), allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    const cols = await queryInterface.describeTable('users');
    if (cols.parent_user_id) {
      try { await queryInterface.removeIndex('users', 'users_parent_user_id_idx'); } catch (_) {}
      await queryInterface.removeColumn('users', 'parent_user_id');
    }
    if (cols.scope) await queryInterface.removeColumn('users', 'scope');
    if (cols.username) {
      try { await queryInterface.removeIndex('users', 'users_username_unique'); } catch (_) {}
      await queryInterface.removeColumn('users', 'username');
    }
    await queryInterface.changeColumn('users', 'role', {
      type: Sequelize.ENUM('admin', 'user'),
      allowNull: false,
      defaultValue: 'user',
    });
  },
};
