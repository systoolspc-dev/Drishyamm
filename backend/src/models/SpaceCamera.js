const { DataTypes } = require('sequelize');

/**
 * SpaceCamera — which cameras measure a space, and HOW their counts combine.
 *
 *     space_count = Σ over overlapGroup g ( max(count × weight over cameras in g) )
 *
 * Cameras that SEE THE SAME PEOPLE must share an `overlapGroup` → MAX, so a
 * hall covered by two cameras reading 12 and 14 is 14 people, not 26.
 * Cameras covering DISJOINT parts of the room leave it NULL → each becomes its
 * own group → they SUM. Never inferred; always declared by the operator,
 * because getting it wrong silently doubles every number in the report.
 */
module.exports = (sequelize) => {
  const SpaceCamera = sequelize.define('SpaceCamera', {
    id:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    spaceId:   { type: DataTypes.UUID, allowNull: false },
    cameraId:  { type: DataTypes.UUID, allowNull: false },
    monitorId: { type: DataTypes.STRING(64), allowNull: false },  // denormalised ingest key
    // 'gauge' = counts people in view (today). 'line' = in/out crossing (P3).
    role:         { type: DataTypes.ENUM('gauge', 'line'), defaultValue: 'gauge' },
    overlapGroup: { type: DataTypes.STRING(32), allowNull: true },
    // Partial-coverage correction: a camera seeing ~60% of the room → 1.6.
    weight:       { type: DataTypes.FLOAT, defaultValue: 1.0 },
    lineConfig:   { type: DataTypes.JSON, allowNull: true },   // P3
    maskZoneId:   { type: DataTypes.UUID, allowNull: true },   // P2: count only inside a polygon
    enabled:      { type: DataTypes.BOOLEAN, defaultValue: true },
  }, {
    tableName: 'space_cameras',
    underscored: true,
    indexes: [
      { unique: true, fields: ['space_id', 'camera_id'], name: 'ux_space_cameras_pair' },
      { fields: ['camera_id'] },
      { fields: ['monitor_id'] },
    ],
  });

  SpaceCamera.associate = (models) => {
    // onDelete MUST be declared here, not only in the migration: on an install
    // where sequelize.sync() creates the table it is the only source of the
    // constraint, and without it MySQL defaults to NO ACTION — which makes a
    // camera that belongs to any space undeletable ("Failed to delete device").
    // Removing a camera should drop its space membership; the space survives.
    SpaceCamera.belongsTo(models.Space, {
      foreignKey: 'spaceId', as: 'space', onDelete: 'CASCADE', hooks: true,
    });
    SpaceCamera.belongsTo(models.Camera, {
      foreignKey: 'cameraId', as: 'camera', onDelete: 'CASCADE', hooks: true,
    });
    models.Camera.hasMany(SpaceCamera, {
      foreignKey: 'cameraId', as: 'spaceMemberships', onDelete: 'CASCADE', hooks: true,
    });
  };

  return SpaceCamera;
};
