'use strict';

/**
 * Per-camera / per-location recording retention.
 *
 *   cameras.retention_days        — override for a single camera (NULL = inherit)
 *   camera_groups.retention_days  — default for all cameras in the group/location
 *
 * Site-level default already lives in sites.settings.retentionDays (JSON).
 * Effective retention resolves Camera → Group → Site → global default (30d) and
 * is applied to MediaMTX as recordDeleteAfter (`<days*24>h`).
 *
 * Idempotent: addColumn only if the column is absent.
 */
async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfNotExists(queryInterface, 'cameras', 'retention_days', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,   // NULL = inherit from group/site
    });
    await addColumnIfNotExists(queryInterface, 'camera_groups', 'retention_days', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,   // NULL = inherit from site/global
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cameras', 'retention_days').catch(() => {});
    await queryInterface.removeColumn('camera_groups', 'retention_days').catch(() => {});
  },
};
