'use strict';

/**
 * Add `settings JSON` to cameras + camera_groups so per-camera/per-group
 * AI config (and future feature flags) can live without further migrations.
 */

async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfNotExists(queryInterface, 'cameras', 'settings', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await addColumnIfNotExists(queryInterface, 'camera_groups', 'settings', {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cameras',       'settings').catch(() => {});
    await queryInterface.removeColumn('camera_groups', 'settings').catch(() => {});
  },
};
