'use strict';

/**
 * Adds supervisor-tracked health fields to the cameras table.
 *
 *   supervisor_state   — last observed state machine state (pending/connecting/streaming/...)
 *   bps_in             — last computed ingress bitrate in bits/sec
 *   last_seen_at       — last time MediaMTX reported ready=true for this camera
 *   last_offline_at    — last transition into OFFLINE (used by alerting)
 *   flap_count_24h     — rolling 24h flap count (incremented on STREAMING -> non-STREAMING)
 *   quarantine_until   — if non-null, supervisor backs off until this timestamp
 *
 * All fields are nullable and default to NULL/0 — backfilled by the supervisor
 * within the first poll cycle after migration runs. Indexed by supervisor_state
 * because admin dashboards filter on it heavily.
 */
async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

async function addIndexIfNotExists(queryInterface, table, fields, name) {
  try {
    const indexes = await queryInterface.showIndex(table);
    if (indexes.find((i) => i.name === name)) return;
    await queryInterface.addIndex(table, fields, { name });
  } catch (_) { /* swallow — older drivers */ }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfNotExists(queryInterface, 'cameras', 'supervisor_state', {
      type: Sequelize.ENUM('pending', 'connecting', 'streaming', 'degraded', 'offline', 'quarantined'),
      allowNull: true,
    });
    await addColumnIfNotExists(queryInterface, 'cameras', 'bps_in', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      defaultValue: 0,
    });
    await addColumnIfNotExists(queryInterface, 'cameras', 'last_seen_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfNotExists(queryInterface, 'cameras', 'last_offline_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfNotExists(queryInterface, 'cameras', 'flap_count_24h', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfNotExists(queryInterface, 'cameras', 'quarantine_until', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await addIndexIfNotExists(queryInterface, 'cameras', ['supervisor_state'], 'idx_cameras_supervisor_state');
    await addIndexIfNotExists(queryInterface, 'cameras', ['last_seen_at'],     'idx_cameras_last_seen_at');
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('cameras', 'idx_cameras_last_seen_at').catch(() => {});
    await queryInterface.removeIndex('cameras', 'idx_cameras_supervisor_state').catch(() => {});
    for (const c of [
      'quarantine_until', 'flap_count_24h', 'last_offline_at',
      'last_seen_at', 'bps_in', 'supervisor_state',
    ]) {
      await queryInterface.removeColumn('cameras', c).catch(() => {});
    }
  },
};
