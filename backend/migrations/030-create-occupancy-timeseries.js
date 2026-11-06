'use strict';

/**
 * Occupancy time series — the head-count log.
 *
 * Before this, occupancy lived ONLY in a Redis gauge with a 30s TTL: "how many
 * people were in the cafeteria at 2pm yesterday?" was unanswerable. These tables
 * are the history behind capacity-compliance proof, utilization reports and peak
 * analytics (docs/OCCUPANCY_LOGIC.md).
 *
 * Tiering (cadence drops as data ages):
 *   occupancy_camera_minute  camera × minute   7d    debug + recompute
 *   occupancy_space_minute   space  × minute   90d   the history chart
 *   occupancy_space_rollup   space × bucket    13-25mo/forever   every report
 *
 * THE RULE, enforced by schema: count columns are NULLABLE and
 *   count IS NULL  ⟺  quality = 'unknown'
 * A camera going offline logs NULL/'unknown' — never 0. `0` means the model
 * looked and saw nobody. Nothing may COALESCE(count, 0).
 *
 * DPDP: counts + timestamps only. No trackId, bbox, snapshot or personId — that
 * is what keeps aggregate occupancy non-personal and lawful to retain.
 *
 * Idempotent: every create/index/constraint is guarded, matching migration 008's
 * errno-150 lesson (raw CHAR(36) BINARY so FK collation matches users/cameras).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const has = (t) => tables.map((x) => String(x).toLowerCase()).includes(t);

    // ── T1: per-camera minute (raw sensor truth; short retention) ────────────
    if (!has('occupancy_camera_minute')) {
      await queryInterface.createTable('occupancy_camera_minute', {
        camera_id:  { type: 'CHAR(36) BINARY', allowNull: false, primaryKey: true },
        ts:         { type: Sequelize.DATE, allowNull: false, primaryKey: true }, // minute-truncated UTC
        user_id:    { type: 'CHAR(36) BINARY', allowNull: false },  // denormalised: tenant scope w/o join
        monitor_id: { type: Sequelize.STRING(64), allowNull: false },
        count_avg:  { type: Sequelize.SMALLINT, allowNull: true },  // NULL ⇔ quality='unknown'
        count_peak: { type: Sequelize.SMALLINT, allowNull: true },
        count_min:  { type: Sequelize.SMALLINT, allowNull: true },
        samples:          { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
        samples_measured: { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
        quality:    { type: Sequelize.ENUM('measured', 'stale', 'unknown'),
                      allowNull: false, defaultValue: 'unknown' },
        degraded:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('occupancy_camera_minute', ['user_id', 'ts'],
        { name: 'ix_ocm_user_ts' }).catch(() => {});
    }

    // ── T2: per-space minute (post-fusion; drives the chart) ────────────────
    if (!has('occupancy_space_minute')) {
      await queryInterface.createTable('occupancy_space_minute', {
        space_id:   { type: 'CHAR(36) BINARY', allowNull: false, primaryKey: true },
        ts:         { type: Sequelize.DATE, allowNull: false, primaryKey: true },
        user_id:    { type: 'CHAR(36) BINARY', allowNull: false },
        count_avg:  { type: Sequelize.SMALLINT, allowNull: true },
        count_peak: { type: Sequelize.SMALLINT, allowNull: true },
        count_min:  { type: Sequelize.SMALLINT, allowNull: true },
        samples:          { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
        samples_measured: { type: Sequelize.SMALLINT, allowNull: false, defaultValue: 0 },
        // 'partial' = some overlap groups blind → the value is a LOWER BOUND:
        // it may raise a breach (a floor ≥ N is proof) but may never clear one.
        quality:    { type: Sequelize.ENUM('measured', 'partial', 'stale', 'unknown'),
                      allowNull: false, defaultValue: 'unknown' },
        // % of the space's cameras that contributed a fresh count this minute
        coverage_pct: { type: Sequelize.SMALLINT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('occupancy_space_minute', ['user_id', 'ts'],
        { name: 'ix_osm_user_ts' }).catch(() => {});
    }

    // ── T3: rollups (15m / 1h / 1d) — every report reads these ──────────────
    if (!has('occupancy_space_rollup')) {
      await queryInterface.createTable('occupancy_space_rollup', {
        space_id: { type: 'CHAR(36) BINARY', allowNull: false, primaryKey: true },
        bucket:   { type: Sequelize.ENUM('15m', '1h', '1d'), allowNull: false, primaryKey: true },
        ts:       { type: Sequelize.DATE, allowNull: false, primaryKey: true },  // bucket start, UTC
        user_id:  { type: 'CHAR(36) BINARY', allowNull: false },
        count_avg:  { type: Sequelize.FLOAT, allowNull: true },
        count_peak: { type: Sequelize.SMALLINT, allowNull: true },
        count_min:  { type: Sequelize.SMALLINT, allowNull: true },
        // Seconds we actually MEASURED — the honest denominator for averages.
        measured_sec: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        // Seconds the space held ≥1 person (utilization numerator).
        occupied_sec: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        // Seconds at/over capacity (compliance reporting).
        over_cap_sec: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        // Integral of count·time → average = person_sec / measured_sec, and the
        // cleaning trigger (person-minutes since last service).
        person_sec:   { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        capacity:     { type: Sequelize.INTEGER, allowNull: true },  // as configured for this bucket
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('occupancy_space_rollup', ['user_id', 'bucket', 'ts'],
        { name: 'ix_osr_user_bucket_ts' }).catch(() => {});
    }

    // ── T5: incidents — one over-capacity EPISODE, and the FSM's durable state ─
    // Durable so a backend restart mid-breach neither re-alerts nor loses the
    // pairing of breach→clear (doctrine L6: correlated episode, not per-sample).
    if (!has('occupancy_incidents')) {
      await queryInterface.createTable('occupancy_incidents', {
        id:       { type: 'CHAR(36) BINARY', allowNull: false, primaryKey: true },
        space_id: { type: 'CHAR(36) BINARY', allowNull: false },
        user_id:  { type: 'CHAR(36) BINARY', allowNull: false },
        started_at: { type: Sequelize.DATE, allowNull: false },
        ended_at:   { type: Sequelize.DATE, allowNull: true },   // NULL = still open
        capacity:   { type: Sequelize.INTEGER, allowNull: true },
        peak_count: { type: Sequelize.SMALLINT, allowNull: true },
        over_cap_sec: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        status:   { type: Sequelize.ENUM('open', 'cleared'), allowNull: false, defaultValue: 'open' },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('occupancy_incidents', ['user_id', 'started_at'],
        { name: 'ix_oi_user_started' }).catch(() => {});
      await queryInterface.addIndex('occupancy_incidents', ['space_id', 'status'],
        { name: 'ix_oi_space_status' }).catch(() => {});
    }
  },

  async down(queryInterface) {
    for (const t of ['occupancy_incidents', 'occupancy_space_rollup',
                     'occupancy_space_minute', 'occupancy_camera_minute']) {
      await queryInterface.dropTable(t).catch(() => {});
    }
  },
};
