'use strict';

const CHAR36 = 'CHAR(36) BINARY';

async function addColumnIfNotExists(queryInterface, table, column, definition) {
  const desc = await queryInterface.describeTable(table).catch(() => null);
  if (!desc || desc[column]) return;
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // camera_groups → site (optional). Nullable so existing rows keep working.
    await addColumnIfNotExists(queryInterface, 'camera_groups', 'site_id', {
      type: CHAR36,
      allowNull: true,
      references: { model: 'sites', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    // cameras → mediamtx_server (which instance hosts this camera).
    // Nullable for backward compat — null = use the default server (the
    // env-configured one, also seeded as site_id=NULL row in mediamtx_servers).
    await addColumnIfNotExists(queryInterface, 'cameras', 'mediamtx_server_id', {
      type: CHAR36,
      allowNull: true,
      references: { model: 'mediamtx_servers', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex('camera_groups', ['site_id']).catch(() => {});
    await queryInterface.addIndex('cameras', ['mediamtx_server_id']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cameras',       'mediamtx_server_id').catch(() => {});
    await queryInterface.removeColumn('camera_groups', 'site_id').catch(() => {});
  },
};
