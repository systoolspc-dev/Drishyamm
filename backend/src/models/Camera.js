const { DataTypes } = require('sequelize');
const fieldCrypto = require('../utils/fieldCrypto');

module.exports = (sequelize) => {
  const Camera = sequelize.define(
    'Camera',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
      },
      monitorId: {
        type: DataTypes.STRING(24),
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'h264',
      },
      host: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      port: {
        type: DataTypes.INTEGER,
        defaultValue: 554,
      },
      path: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      username: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      // Camera RTSP password — transparently encrypted at rest (AES-256-GCM)
      // when CAMERA_CRED_KEY is set. Reads decrypt automatically; legacy
      // plaintext rows pass through until re-saved. Column widened for ciphertext.
      password: {
        type: DataTypes.STRING(512),
        allowNull: true,
        set(value) { this.setDataValue('password', fieldCrypto.encrypt(value)); },
        get() { return fieldCrypto.decrypt(this.getDataValue('password')); },
      },
      width: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      height: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      fps: {
        type: DataTypes.INTEGER,
        defaultValue: 30,
      },
      // Per-camera recording retention override (days). NULL = inherit from the
      // group, then the site, then the global default (30d). Applied to Stream Service
      // as recordDeleteAfter so old recordings auto-purge per camera.
      retentionDays: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },
      // Default playback quality for this camera. NULL = inherit group → 'auto'.
      // 'main' = full-res, 'sub' = low-res, 'auto' = ABR. Drives which Stream Service
      // stream the player pulls (sub = lighter ingest, the scale lever).
      streamQuality: {
        type: DataTypes.ENUM('auto', 'main', 'sub'),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('online', 'offline'),
        defaultValue: 'offline',
      },
      // Parent device group (1 IP → many cameras)
      groupId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'camera_groups', key: 'id' },
      },
      // Channel number on the NVR (1=ch101, 2=ch201, 3=ch301...)
      channel: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // S3 path: recordings/{userId}/{groupName}/{cameraName}/
      s3Path: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Per-camera AI/feature config — kept as JSON so we can evolve without migrations.
      // Shape: { ai: { enabled, fps, detectors, behaviors, faceWatchlist }, abr: { enabled } }
      settings: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
      },
      // Which Stream Service instance hosts this camera. NULL = use the default
      // server (env-configured). FK is added at migration 012 with the
      // right collation; we don't put `references` here on purpose.
      mediamtxServerId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // ── Supervisor-maintained health fields (migration 016) ─────────────────
      // The streamSupervisor service writes these on every state transition.
      supervisorState: {
        // 'standby' (migration 019): host reachable per the cameraReachability
        // prober but the on-demand path isn't being pulled — a healthy,
        // public-online state distinct from 'offline'.
        type: DataTypes.ENUM('pending', 'connecting', 'streaming', 'degraded', 'offline', 'quarantined', 'standby'),
        allowNull: true,
      },
      bpsIn: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
        defaultValue: 0,
      },
      lastSeenAt:     { type: DataTypes.DATE, allowNull: true },
      lastOfflineAt:  { type: DataTypes.DATE, allowNull: true },
      // Sequelize's `underscored` mode would map this to `flap_count24h` (no
      // underscore before digits), but the migration uses the more readable
      // `flap_count_24h`. Pin the column name explicitly to keep them aligned.
      flapCount24h: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        field: 'flap_count_24h',
      },
      quarantineUntil:{ type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'cameras',
      underscored: true,
      indexes: [
        { unique: true, fields: ['user_id', 'monitor_id'] },
        { fields: ['group_id'] },
      ],
    }
  );

  Camera.associate = (models) => {
    Camera.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Camera.belongsTo(models.CameraGroup, { foreignKey: 'groupId', as: 'group' });
    Camera.belongsTo(models.StreamServer, { foreignKey: 'mediamtxServerId', as: 'mediamtxServer' });
  };

  return Camera;
};
