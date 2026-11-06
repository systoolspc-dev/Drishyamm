'use strict';

/**
 * Composite indexes for the two operator alert queries that were full scans:
 *   • "unacknowledged alerts for me"  → WHERE user_id=? AND acknowledged_at IS NULL ORDER BY ts
 *   • "critical alerts for me"        → WHERE user_id=? AND severity=? ORDER BY ts DESC
 *
 * user_id leads both so the index also scopes per tenant. The table already has
 * (user_id, ts), (camera_id, ts), (monitor_id, ts) and event_type; this closes
 * the severity / acknowledged_at gap (M2). Idempotent — skips if the index exists.
 */
async function addIndexIfMissing(queryInterface, table, fields, name) {
  try {
    const existing = await queryInterface.showIndex(table).catch(() => []);
    if (existing.some((ix) => ix.name === name)) return;
    await queryInterface.addIndex(table, { fields, name });
  } catch (err) {
    // Non-fatal: a concurrent run or pre-existing index shouldn't break migrate.
    if (!/duplicate|exists/i.test(err.message)) throw err;
  }
}

module.exports = {
  async up(queryInterface) {
    await addIndexIfMissing(queryInterface, 'ai_events', ['user_id', 'severity', 'ts'], 'ix_ai_events_user_severity_ts');
    await addIndexIfMissing(queryInterface, 'ai_events', ['user_id', 'acknowledged_at'], 'ix_ai_events_user_ack');
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ai_events', 'ix_ai_events_user_severity_ts').catch(() => {});
    await queryInterface.removeIndex('ai_events', 'ix_ai_events_user_ack').catch(() => {});
  },
};
