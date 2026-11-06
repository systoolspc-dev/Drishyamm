'use strict';

// Match the project-wide pattern from migration 007: explicit
// CHAR(36) BINARY for UUID FK columns + utf8mb4_unicode_ci table charset
// to avoid `errno 150 — Foreign key constraint is incorrectly formed`
// on MySQL when joining against users/cameras (which use the same).
// Plain CHAR(36) (NOT `CHAR(36) BINARY`) — must match users.id / cameras.id
// which were created via plain CHAR(36) under utf8mb4_unicode_ci. Adding
// BINARY would force binary collation and make the FK fail with errno 150.
const CHAR36 = 'CHAR(36) BINARY';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('ai_events')) return;   // idempotent — re-runnable

    await queryInterface.createTable('ai_events', {
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
      camera_id: {
        type: CHAR36,
        allowNull: true,
        references: { model: 'cameras', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      monitor_id: {
        type: Sequelize.STRING(24),
        allowNull: false,
      },
      event_type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      severity: {
        type: Sequelize.ENUM('info', 'warning', 'critical'),
        defaultValue: 'info',
      },
      ts: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      bbox:        { type: Sequelize.JSON,  allowNull: true },
      track_id:    { type: Sequelize.INTEGER, allowNull: true },
      confidence:  { type: Sequelize.FLOAT,   allowNull: true },
      payload:     { type: Sequelize.JSON,    allowNull: true },
      snapshot_key:{ type: Sequelize.STRING(500), allowNull: true },
      acknowledged_at: { type: Sequelize.DATE, allowNull: true },
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

    // Indexes for the common access patterns
    await queryInterface.addIndex('ai_events', ['user_id', 'ts']).catch(() => {});
    await queryInterface.addIndex('ai_events', ['camera_id', 'ts']).catch(() => {});
    await queryInterface.addIndex('ai_events', ['monitor_id', 'ts']).catch(() => {});
    await queryInterface.addIndex('ai_events', ['event_type']).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_events').catch(() => {});
  },
};
