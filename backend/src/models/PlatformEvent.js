const { DataTypes } = require('sequelize');

/**
 * PlatformEvent — one decided platform event for the admin console's live
 * activity feed (migration 035). Written only by services/platformEvents.service.
 */
module.exports = (sequelize) => {
  const PlatformEvent = sequelize.define(
    'PlatformEvent',
    {
      id:           { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      type:         { type: DataTypes.STRING(48), allowNull: false },
      severity:     { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'info' },
      accountId:    { type: DataTypes.STRING(36), allowNull: true },
      accountLabel: { type: DataTypes.STRING(160), allowNull: true },
      actorKind:    { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'system' },
      actorId:      { type: DataTypes.STRING(36), allowNull: true },
      actorLabel:   { type: DataTypes.STRING(160), allowNull: true },
      summary:      { type: DataTypes.STRING(500), allowNull: false },
      data:         { type: DataTypes.JSON, allowNull: true },
      ip:           { type: DataTypes.STRING(64), allowNull: true },
      userAgent:    { type: DataTypes.STRING(255), allowNull: true },
      createdAt:    { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'platform_events',
      underscored: true,
      timestamps: false,
    }
  );

  return PlatformEvent;
};
