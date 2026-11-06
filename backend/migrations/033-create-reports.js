'use strict';

/**
 * reports — a generated report someone kept.
 *
 * A report is a QUERY plus a FROZEN RESULT. `params` is what was asked for
 * (type, period, scope, which sections to include); `payload` is what the
 * numbers were at generation time. Both are stored because they answer
 * different questions: params let the report be re-run later ("same report,
 * this month"), payload keeps the copy that was sent to a manager identical
 * forever, even after events are acknowledged or cameras are renamed.
 *
 * `user_id` is the ACCOUNT OWNER (users.parent_user_id || users.id), matching
 * wall_layouts (migration 032), so everyone on an account sees the same
 * library. created_by records who actually pressed Generate, which is what the
 * Created By column shows and what an export audit needs.
 *
 * Raw `CHAR(36) BINARY` for UUID columns so the FK collation matches users.id
 * (the errno-150 lesson from migration 008). Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());

    if (!tables.includes('reports')) {
      await queryInterface.createTable('reports', {
        id:         { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id:    { type: 'CHAR(36) BINARY', allowNull: false },
        created_by: { type: 'CHAR(36) BINARY', allowNull: true },
        // Denormalised so the library still shows who made a report after that
        // member is removed from the account.
        created_by_name: { type: Sequelize.STRING(120), allowNull: true },
        name: { type: Sequelize.STRING(160), allowNull: false },
        // 'ai_events' | 'face' | 'occupancy' | 'restricted_area' |
        // 'camera_health' | 'recording' | 'incident' | 'custom'
        type: { type: Sequelize.STRING(32), allowNull: false },
        // The window the report covers, in UTC.
        period_from: { type: Sequelize.DATE, allowNull: false },
        period_to:   { type: Sequelize.DATE, allowNull: false },
        // 'ready' | 'generating' | 'failed'. Generation is synchronous today,
        // so rows land as 'ready'; the column exists because a 90-day report
        // over a large estate will eventually need a queue, and the UI already
        // renders the in-progress state.
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'ready' },
        error:  { type: Sequelize.STRING(500), allowNull: true },
        params:  { type: Sequelize.JSON, allowNull: false },
        payload: { type: Sequelize.JSON, allowNull: true },
        // Set when this row is the recurring definition behind a schedule.
        schedule: { type: Sequelize.STRING(32), allowNull: true },
        last_exported_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('reports', ['user_id', 'created_at'],
        { name: 'ix_reports_user_created' }).catch(() => {});
      await queryInterface.addIndex('reports', ['user_id', 'type'],
        { name: 'ix_reports_user_type' }).catch(() => {});
      await queryInterface.addConstraint('reports', {
        fields: ['user_id'], type: 'foreign key', name: 'fk_reports_user',
        references: { table: 'users', field: 'id' }, onDelete: 'CASCADE',
      }).catch(() => {});
    }

    // Who acknowledged an alert. The timestamp was already recorded, but not
    // the person — so a report could say an incident was handled without being
    // able to say by whom, which is the first thing anyone asks.
    // Raw ALTER, not queryInterface.addColumn: given a raw string type
    // ('CHAR(36) BINARY') addColumn reports success and adds NOTHING, which
    // left every report query dying on "Unknown column acknowledged_by" while
    // the migration was recorded as applied. No .catch() either — a swallowed
    // failure here is the same bug wearing a different hat. The describeTable
    // guard is what makes this idempotent.
    const cols = await queryInterface.describeTable('ai_events');
    if (!cols.acknowledged_by) {
      await queryInterface.sequelize.query(
        'ALTER TABLE ai_events ADD COLUMN acknowledged_by CHAR(36) NULL');
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('reports').catch(() => {});
    await queryInterface.removeColumn('ai_events', 'acknowledged_by').catch(() => {});
  },
};
