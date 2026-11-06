const { DataTypes } = require('sequelize');

/**
 * Site — physical location grouping camera_groups.
 *
 * Many small customers will only ever have one site (their office). Big
 * customers (school chains, multi-branch retail, hospital networks) will
 * have many. Sites are how we keep operator dashboards manageable and how
 * we route cameras to the right Stream Service instance.
 */
module.exports = (sequelize) => {
  const Site = sequelize.define(
    'Site',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // No `references` here — see migration 008 for the errno-150 lesson;
      // the FK is added at the migration level with the correct collation.
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      address:   { type: DataTypes.STRING(500), allowNull: true },
      timezone:  {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'Asia/Kolkata',
      },
      latitude:  { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
      // Default settings inherited by camera_groups + cameras under this site.
      // Shape: { ai: {...}, retentionDays: 30, ... }
      settings:  { type: DataTypes.JSON, allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'paused', 'archived'),
        defaultValue: 'active',
      },
    },
    {
      tableName: 'sites',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { unique: true, fields: ['user_id', 'slug'] },
      ],
    },
  );

  Site.associate = (models) => {
    Site.belongsTo(models.User,        { foreignKey: 'userId', as: 'user' });
    Site.hasMany(models.CameraGroup,   { foreignKey: 'siteId', as: 'cameraGroups' });
    Site.hasMany(models.StreamServer,{ foreignKey: 'siteId', as: 'mediamtxServers' });
  };

  return Site;
};
