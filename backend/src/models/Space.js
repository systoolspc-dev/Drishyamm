const { DataTypes } = require('sequelize');

/**
 * Space — a ROOM (or hall, floor, entrance, queue). The unit occupancy is
 * measured, alerted and reported on.
 *
 * Deliberately NOT reusing an existing table: `CameraGroup` is an NVR device
 * (host/port/credentials/channels) — a room spanning two recorders, or a
 * recorder covering four rooms, breaks it. `RestrictedZone` is a polygon on
 * exactly one camera. `Site` is the building. See docs/OCCUPANCY_LOGIC.md §3.
 *
 * DPDP: rows under a space carry counts + timestamps only — never trackId,
 * bbox, snapshot or personId. Aggregate occupancy is not personal data, which
 * is what makes long retention lawful.
 */
module.exports = (sequelize) => {
  const Space = sequelize.define('Space', {
    id:     { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // No `references` here — FKs are added in the migration with matching
    // collation (the errno-150 lesson from migration 008).
    userId: { type: DataTypes.UUID, allowNull: false },
    siteId: { type: DataTypes.UUID, allowNull: true },   // supplies timezone / business day
    name:   { type: DataTypes.STRING(120), allowNull: false },
    slug:   { type: DataTypes.STRING(120), allowNull: false },
    type: {
      type: DataTypes.ENUM('room', 'meeting_room', 'hall', 'floor', 'entrance', 'queue', 'zone', 'other'),
      defaultValue: 'room',
    },
    // Declared safe/legal max headcount. NULL or 0 ⇒ capacity alerts OFF.
    capacity: { type: DataTypes.INTEGER, allowNull: true },
    areaSqm:  { type: DataTypes.DECIMAL(8, 2), allowNull: true },  // enables persons/m²
    // Reporting + arming window; NULL ⇒ 24×7.
    // { tz:'Asia/Kolkata', week:[{dow:1, open:'09:00', close:'18:00'}], holidays:[] }
    operatingHours: { type: DataTypes.JSON, allowNull: true },
    // { warnPct:0.85, confirmSec:60, clearSec:60, clearMargin:2, cooldownSec:900 }
    settings: { type: DataTypes.JSON, allowNull: true },
    // Denormalised so an occupancy alert can still deep-link to a camera.
    primaryMonitorId: { type: DataTypes.STRING(64), allowNull: true },
    // The declared lawful purpose justifying retention (DPDP).
    purpose: {
      type: DataTypes.ENUM('safety_capacity', 'facilities_utilization', 'operations'),
      defaultValue: 'safety_capacity',
    },
    enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
  }, {
    tableName: 'spaces',
    underscored: true,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['site_id'] },
      { unique: true, fields: ['user_id', 'slug'], name: 'ux_spaces_user_slug' },
    ],
  });

  Space.associate = (models) => {
    Space.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Space.belongsTo(models.Site, { foreignKey: 'siteId', as: 'site' });
    Space.hasMany(models.SpaceCamera, { foreignKey: 'spaceId', as: 'members', onDelete: 'CASCADE' });
  };

  return Space;
};
