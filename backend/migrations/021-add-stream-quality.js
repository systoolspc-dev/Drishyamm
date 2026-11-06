'use strict';

/**
 * Per-camera / per-location default stream quality.
 *
 *   cameras.stream_quality        — override for a single camera (NULL = inherit)
 *   camera_groups.stream_quality  — default for the group/location
 *
 * Values: 'auto' (ABR), 'main' (full-res), 'sub' (low-res). Effective quality
 * resolves Camera → Group → global ('auto'). Drives which MediaMTX stream the
 * player pulls by default — picking 'sub' cuts per-camera ingest/egress load,
 * the key lever for scaling to very large camera counts.
 *
 * Idempotent: addColumn only if absent.
 */
async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfNotExists(queryInterface, 'cameras', 'stream_quality', {
      type: Sequelize.ENUM('auto', 'main', 'sub'),
      allowNull: true,
    });
    await addColumnIfNotExists(queryInterface, 'camera_groups', 'stream_quality', {
      type: Sequelize.ENUM('auto', 'main', 'sub'),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cameras', 'stream_quality').catch(() => {});
    await queryInterface.removeColumn('camera_groups', 'stream_quality').catch(() => {});
  },
};
