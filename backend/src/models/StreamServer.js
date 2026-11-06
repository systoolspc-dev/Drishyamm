const { DataTypes } = require('sequelize');

/**
 * StreamServer — one Stream Service instance in our pool.
 *
 * site_id can be NULL — that's the "global default" server (typically the
 * env-configured Stream Service). When a camera is created and the camera's site
 * has no dedicated server, the router falls back to a global one.
 *
 * The `current_cams` counter is maintained by the router on add/remove so
 * we don't have to COUNT(*) the cameras table every time we pick a server.
 */
module.exports = (sequelize) => {
  const StreamServer = sequelize.define(
    'StreamServer',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      siteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      name:     { type: DataTypes.STRING(120), allowNull: false },
      hostname: { type: DataTypes.STRING(255), allowNull: false },

      apiUrl:   { type: DataTypes.STRING(255), allowNull: false },
      apiUser:  { type: DataTypes.STRING(120), allowNull: true },
      apiPass:  { type: DataTypes.STRING(255), allowNull: true },

      hlsUrl:    { type: DataTypes.STRING(255), allowNull: false },
      webrtcUrl: { type: DataTypes.STRING(255), allowNull: false },

      rtspInternalHost: { type: DataTypes.STRING(255), allowNull: false },
      rtspInternalPort: { type: DataTypes.INTEGER,    defaultValue: 8554 },

      capacityCams: { type: DataTypes.INTEGER, defaultValue: 200 },
      currentCams:  { type: DataTypes.INTEGER, defaultValue: 0   },

      status: {
        type: DataTypes.ENUM('online', 'offline', 'draining'),
        defaultValue: 'online',
      },
      lastHeartbeat: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'mediamtx_servers',
      underscored: true,
      indexes: [
        { fields: ['site_id'] },
        { fields: ['status']  },
      ],
    },
  );

  StreamServer.associate = (models) => {
    StreamServer.belongsTo(models.Site,   { foreignKey: 'siteId', as: 'site' });
    StreamServer.hasMany(models.Camera,   { foreignKey: 'mediamtxServerId', as: 'cameras' });
  };

  // Helpers used by the router and stream service
  StreamServer.prototype.headroom = function () {
    return Math.max(0, (this.capacityCams || 0) - (this.currentCams || 0));
  };

  return StreamServer;
};
