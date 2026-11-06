'use strict';

// Use CHAR(36) BINARY to exactly match Sequelize.UUID which creates CHAR(36) BINARY on MySQL
const CHAR36 = 'CHAR(36) BINARY';

/**
 * Helper: add a column only if it does not already exist
 */
async function addColumnIfNotExists(queryInterface, Sequelize, table, column, definition) {
  const tableDesc = await queryInterface.describeTable(table).catch(() => null);
  if (!tableDesc || tableDesc[column]) return; // table missing or column already exists
  await queryInterface.addColumn(table, column, definition);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Create camera_groups table if it doesn't already exist
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('camera_groups')) {
      await queryInterface.createTable('camera_groups', {
        id: {
          type: CHAR36,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        user_id: {
          type: CHAR36,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(100), allowNull: false },
        host: { type: Sequelize.STRING(255), allowNull: false },
        port: { type: Sequelize.INTEGER, defaultValue: 554 },
        http_port: { type: Sequelize.INTEGER, defaultValue: 80 },
        username: { type: Sequelize.STRING(100), allowNull: true },
        password: { type: Sequelize.STRING(255), allowNull: true },
        device_type: {
          type: Sequelize.ENUM('hikvision', 'dahua', 'axis', 'generic'),
          defaultValue: 'hikvision',
        },
        total_channels: { type: Sequelize.INTEGER, defaultValue: 0 },
        status: {
          type: Sequelize.ENUM('online', 'offline', 'unknown'),
          defaultValue: 'unknown',
        },
        location: { type: Sequelize.STRING(255), allowNull: true },
        latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
        s3_folder: { type: Sequelize.STRING(255), allowNull: true },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('camera_groups', ['user_id']).catch(() => {});
      await queryInterface.addIndex('camera_groups', ['user_id', 'host'], { unique: true }).catch(() => {});
    }

    // 2. Add new columns to cameras table — skip any that already exist
    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'group_id', {
      type: CHAR36,
      allowNull: true,
      references: { model: 'camera_groups', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'channel', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'username', {
      type: Sequelize.STRING(100),
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'password', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'width', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'height', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 'fps', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 25,
    });

    // S3 path prefix for this camera's recordings in object storage
    await addColumnIfNotExists(queryInterface, Sequelize, 'cameras', 's3_path', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });

    // Add index on group_id if not already there
    await queryInterface.addIndex('cameras', ['group_id']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('cameras', 's3_path').catch(() => {});
    await queryInterface.removeColumn('cameras', 'fps').catch(() => {});
    await queryInterface.removeColumn('cameras', 'height').catch(() => {});
    await queryInterface.removeColumn('cameras', 'width').catch(() => {});
    await queryInterface.removeColumn('cameras', 'password').catch(() => {});
    await queryInterface.removeColumn('cameras', 'username').catch(() => {});
    await queryInterface.removeColumn('cameras', 'channel').catch(() => {});
    await queryInterface.removeColumn('cameras', 'group_id').catch(() => {});
    await queryInterface.dropTable('camera_groups').catch(() => {});
  },
};
