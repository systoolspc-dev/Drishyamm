'use strict';

async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfNotExists(queryInterface, 'camera_groups', 'latitude', {
      type: Sequelize.DECIMAL(10, 7),
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, 'camera_groups', 'longitude', {
      type: Sequelize.DECIMAL(10, 7),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('camera_groups', 'longitude').catch(() => {});
    await queryInterface.removeColumn('camera_groups', 'latitude').catch(() => {});
  },
};
