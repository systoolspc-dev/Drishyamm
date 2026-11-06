'use strict';

// Device push-notification tokens. One row per registered mobile device;
// alerts fan out to every enabled token belonging to the camera's owner.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('device_tokens')) {
      await queryInterface.createTable('device_tokens', {
        id:          { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id:     { type: 'CHAR(36) BINARY', allowNull: false },
        token:       { type: Sequelize.STRING(255), allowNull: false },   // ExponentPushToken[...]
        platform: {
          type: Sequelize.ENUM('ios', 'android', 'web'),
          allowNull: true,
        },
        device_name: { type: Sequelize.STRING(120), allowNull: true },
        disabled:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        last_seen_at:{ type: Sequelize.DATE, allowNull: true },
        created_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updated_at: {
          type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      }, {
        charset: 'utf8mb4',
        collate: 'utf8mb4_unicode_ci',
      });

      await queryInterface.addIndex('device_tokens', ['user_id']).catch(() => {});
      await queryInterface.addIndex('device_tokens', ['token'], {
        unique: true, name: 'ux_device_tokens_token',
      }).catch(() => {});
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('device_tokens').catch(() => {});
  },
};
