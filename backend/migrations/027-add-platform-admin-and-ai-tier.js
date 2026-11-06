'use strict';

/**
 * A3 — users.is_platform_admin: gates the cross-tenant /api/admin/* console.
 *      Self-registration can never set it (register writes only
 *      name/email/password/role), so a trial user can't self-grant.
 * B1 — plans.ai_enabled: the "Basic VMS" vs "AI+VMS" tier capability.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'is_platform_admin', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('plans', 'ai_enabled', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'is_platform_admin');
    await queryInterface.removeColumn('plans', 'ai_enabled');
  },
};
