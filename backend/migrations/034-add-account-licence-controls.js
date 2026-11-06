'use strict';

/**
 * Account control (admin console → Customers → Manage account).
 *
 * 1. subscriptions.camera_limit — per-account camera licence. NULL = inherit
 *    plan.max_cameras (the old behaviour); a number = this account's own cap,
 *    so one customer can be sold 40 cameras without minting a 40-camera plan.
 *    0 here means "no cameras" (unlike plan.max_cameras, where 0 = unlimited).
 *
 * 2. subscriptions.feature_limits — per-camera AI licences, e.g.
 *    { "face": 10, "headcount": 4 }. A missing key = no separate cap (bounded
 *    only by the camera licence). Keys are AI_LICENCES in utils/featureCatalog.
 *
 * 3. admin_audit_log.admin_user_id — migration 014 pointed it at admin_users,
 *    a table nothing ever wrote to; platform operators are users with
 *    is_platform_admin=1. The FK is dropped so the existing (empty, unused)
 *    audit table can record who changed an account. Column type is unchanged.
 *
 * Idempotent: each step checks before acting.
 */
async function fkNames(queryInterface, table, column) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
        AND REFERENCED_TABLE_NAME IS NOT NULL`,
    { replacements: [table, column] },
  );
  return rows.map((r) => r.name);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const subs = await queryInterface.describeTable('subscriptions');
    if (!subs.camera_limit) {
      await queryInterface.addColumn('subscriptions', 'camera_limit', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }
    if (!subs.feature_limits) {
      await queryInterface.addColumn('subscriptions', 'feature_limits', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('admin_audit_log')) {
      for (const name of await fkNames(queryInterface, 'admin_audit_log', 'admin_user_id')) {
        await queryInterface.removeConstraint('admin_audit_log', name);
      }
    }
  },

  async down(queryInterface) {
    const subs = await queryInterface.describeTable('subscriptions');
    if (subs.feature_limits) await queryInterface.removeColumn('subscriptions', 'feature_limits');
    if (subs.camera_limit) await queryInterface.removeColumn('subscriptions', 'camera_limit');
    // The admin_users FK is not restored: rows written since reference users.id
    // and would fail it.
  },
};
