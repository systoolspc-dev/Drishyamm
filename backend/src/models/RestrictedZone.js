const { DataTypes } = require('sequelize');

/**
 * RestrictedZone — a no-entry area drawn on ONE camera. A user can have many
 * zones per camera and across many cameras (that's just multiple rows). The AI
 * intrusion engine reads these per monitorId (see docs/RESTRICTED_ZONE_DETECTION.md).
 */
module.exports = (sequelize) => {
  const RestrictedZone = sequelize.define(
    'RestrictedZone',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      monitorId: { type: DataTypes.STRING(64), allowNull: false },
      cameraName: { type: DataTypes.STRING(120), allowNull: true },
      name: { type: DataTypes.STRING(120), allowNull: false },
      shape: { type: DataTypes.STRING(16), defaultValue: 'polygon' }, // polygon | rectangle
      points: { type: DataTypes.JSON, allowNull: true },  // [{x,y}, …] normalized 0..100
      rect: { type: DataTypes.JSON, allowNull: true },    // {x,y,w,h} normalized 0..100
      priority: { type: DataTypes.STRING(16), defaultValue: 'high' },
      schedule: { type: DataTypes.STRING(24), defaultValue: 'always' },
      armWindow: { type: DataTypes.JSON, allowNull: true }, // {from,to} for custom schedule (window is reserved)
      dwellSec: { type: DataTypes.INTEGER, defaultValue: 5 },
      alertOnEntry: { type: DataTypes.BOOLEAN, defaultValue: true },
      // >0 → capacity/occupancy-threshold mode: alert when this many people are
      // inside (with hysteresis), instead of on any intrusion. NULL = intrusion
      // mode (current behaviour). See docs/DETECTION_DECISION_ALERT_FRAMEWORK.md §8.
      maxOccupancy: { type: DataTypes.INTEGER, allowNull: true },
      allowed: { type: DataTypes.JSON, allowNull: true },   // ['Staff', …] categories that pass through
      enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    },
    {
      tableName: 'restricted_zones',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['user_id', 'monitor_id'] },
      ],
    },
  );

  RestrictedZone.associate = (models) => {
    RestrictedZone.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };

  return RestrictedZone;
};
