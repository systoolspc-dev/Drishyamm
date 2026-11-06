'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('cameras', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      monitor_id: {
        type: Sequelize.STRING(24),
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      type: {
        type: Sequelize.STRING(20),
        defaultValue: 'h264',
      },
      host: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      port: {
        type: Sequelize.INTEGER,
        defaultValue: 554,
      },
      path: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('online', 'offline'),
        defaultValue: 'offline',
      },
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
    });

    await queryInterface.addIndex('cameras', ['user_id', 'monitor_id'], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('cameras');
  },
};
