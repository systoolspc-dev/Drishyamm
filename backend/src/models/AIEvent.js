const { DataTypes } = require('sequelize');

/**
 * AIEvent — one row per detection emitted by smart-cam-ai.
 *
 * Indexed for the two access patterns we care about:
 *   1. "Show me this user's recent events" → (user_id, ts DESC)
 *   2. "Show me events from this camera"   → (camera_id, ts DESC)
 *
 * snapshotKey is the S3 key for the JPEG evidence image. The base64 blob
 * arriving from the worker is uploaded to S3 in the controller so we never
 * store image bytes in MySQL.
 */
module.exports = (sequelize) => {
  const AIEvent = sequelize.define(
    'AIEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // No `references` here on purpose — Sequelize.UUID renders as
      // CHAR(36) BINARY which collides with the existing users/cameras
      // CHAR(36) utf8mb4_unicode_ci columns and trips errno 150 at sync()
      // time. The FK constraints are added by migration 008 with the right
      // collation; the ORM association below still works for joins.
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      cameraId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      monitorId: {
        type: DataTypes.STRING(24),
        allowNull: false,
      },
      // 'tripwire.entry' | 'tripwire.exit' | 'person.unknown' | …
      eventType: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      severity: {
        type: DataTypes.ENUM('info', 'warning', 'critical'),
        defaultValue: 'info',
      },
      ts: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      // [x1, y1, x2, y2] — pixel coords on the inference frame
      bbox: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      // AI tracker IDs are opaque strings (e.g. "t00000047"), NOT integers.
      // Was INTEGER → every AI event with a real track id 500'd on insert
      // ("Incorrect integer value") and the alert-forwarder rejected the event.
      trackId: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      confidence: {
        type: DataTypes.FLOAT,
        allowNull: true,
      },
      // Free-form per-event fields (matchedName, action, zoneId, …)
      payload: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      // S3 key for the evidence JPEG, if a snapshot was uploaded
      snapshotKey: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Set by users acknowledging the alert in the UI
      acknowledgedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // WHO acknowledged it. Reports have to be able to say "handled by
      // Suresh", not just "handled" — see migration 033.
      acknowledgedBy: {
        type: DataTypes.UUID,
        allowNull: true,
      },
    },
    {
      tableName: 'ai_events',
      underscored: true,
      indexes: [
        { fields: ['user_id', 'ts'] },
        { fields: ['camera_id', 'ts'] },
        { fields: ['monitor_id', 'ts'] },
        { fields: ['event_type'] },
        // Alert queries (see migration 022): unacknowledged + severity filters.
        { name: 'ix_ai_events_user_severity_ts', fields: ['user_id', 'severity', 'ts'] },
        { name: 'ix_ai_events_user_ack', fields: ['user_id', 'acknowledged_at'] },
      ],
    },
  );

  AIEvent.associate = (models) => {
    AIEvent.belongsTo(models.User,   { foreignKey: 'userId',   as: 'user'   });
    AIEvent.belongsTo(models.Camera, { foreignKey: 'cameraId', as: 'camera' });
  };

  return AIEvent;
};
