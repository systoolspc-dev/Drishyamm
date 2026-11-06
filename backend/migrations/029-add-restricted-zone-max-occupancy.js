'use strict';

/**
 * restricted_zones.max_occupancy — optional capacity threshold.
 *
 * When set (>0) the zone alerts on OCCUPANCY (this many people inside), with
 * hysteresis (K-of-N confirm + N/N−margin deadband), instead of on any single
 * intrusion. NULL keeps the existing intrusion behaviour. See
 * docs/DETECTION_DECISION_ALERT_FRAMEWORK.md §8 (P0-3) and the
 * occupancyHysteresis service.
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
    await addColumnIfNotExists(queryInterface, 'restricted_zones', 'max_occupancy', {
      type: Sequelize.INTEGER,
      allowNull: true, // NULL = intrusion mode (alert on any); >0 = capacity mode
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('restricted_zones', 'max_occupancy').catch(() => {});
  },
};
