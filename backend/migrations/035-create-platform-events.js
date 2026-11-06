'use strict';

/**
 * platform_events — what happened on the platform, for the admin console's
 * live activity feed (Home panel, bell, Activity page, account hub Activity tab).
 *
 * One row per decided event, not per raw signal: a bulk import of 16 cameras is
 * one row, a flapping NVR is one row per real state change (see
 * services/platformEvents.service — coalescing lives there).
 *
 *   type         'account.created', 'camera.offline', 'nvr.down', … (dot names)
 *   severity     'info' | 'warning' | 'critical'
 *   account_id   the customer ACCOUNT (owner users.id). NULL for platform-wide
 *                events (a service going down). No FK on purpose: the history
 *                outlives a deleted account.
 *   account_label  owner name at the time, so the feed still reads after the
 *                account is renamed or deleted.
 *   actor_kind   'owner' | 'member' | 'operator' | 'system' | 'visitor'
 *   actor_id / actor_label   who did it (users.id + name/email), or 'system'
 *   summary      the plain sentence the feed shows
 *   data         structured detail (plan, counts, camera names, before/after)
 *
 * Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('platform_events')) return;

    await queryInterface.createTable('platform_events', {
      id:            { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      type:          { type: Sequelize.STRING(48), allowNull: false },
      severity:      { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'info' },
      account_id:    { type: 'CHAR(36) BINARY', allowNull: true },
      account_label: { type: Sequelize.STRING(160), allowNull: true },
      actor_kind:    { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'system' },
      actor_id:      { type: 'CHAR(36) BINARY', allowNull: true },
      actor_label:   { type: Sequelize.STRING(160), allowNull: true },
      summary:       { type: Sequelize.STRING(500), allowNull: false },
      data:          { type: Sequelize.JSON, allowNull: true },
      ip:            { type: Sequelize.STRING(64), allowNull: true },
      user_agent:    { type: Sequelize.STRING(255), allowNull: true },
      // Millisecond precision: the feed orders by it and a reconnecting client
      // backfills from it.
      created_at:    { type: Sequelize.DATE(3), allowNull: false,
                       defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    await queryInterface.addIndex('platform_events', ['created_at'], { name: 'ix_platform_events_created' });
    await queryInterface.addIndex('platform_events', ['account_id', 'created_at'], { name: 'ix_platform_events_account_created' });
    await queryInterface.addIndex('platform_events', ['type', 'created_at'], { name: 'ix_platform_events_type_created' });
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('platform_events')) await queryInterface.dropTable('platform_events');
  },
};
