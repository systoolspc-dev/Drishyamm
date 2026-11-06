'use strict';

// The admin Accounts list counts open alerts for EVERY account in one query
// (ts window + severity + unacknowledged, grouped by user). The existing
// indexes all lead with user_id, so that query scanned the whole table:
// 24.7 s on prod with 463k rows. This covering index makes it a range scan.
const INDEX = 'ix_ai_events_ts_sev_ack_user';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: [INDEX] });
    if (rows.length) return;
    await queryInterface.sequelize.query(
      `ALTER TABLE ai_events ADD INDEX ${INDEX} (ts, severity, acknowledged_at, user_id), ALGORITHM=INPLACE, LOCK=NONE`);
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: [INDEX] });
    if (!rows.length) return;
    await queryInterface.removeIndex('ai_events', INDEX);
  },
};
