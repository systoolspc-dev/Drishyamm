const { DataTypes } = require('sequelize');
const fieldCrypto = require('../utils/fieldCrypto');

module.exports = (sequelize) => {
  const CameraGroup = sequelize.define(
    'CameraGroup',
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
      // Display name: "Office 13", "Office 14", "Warehouse A", etc.
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      // IP address of the NVR/DVR device
      host: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      port: {
        type: DataTypes.INTEGER,
        defaultValue: 554,
      },
      httpPort: {
        type: DataTypes.INTEGER,
        defaultValue: 80,
      },
      username: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      // NVR/device password — transparently encrypted at rest (AES-256-GCM)
      // when CAMERA_CRED_KEY is set; legacy plaintext passes through until re-saved.
      password: {
        type: DataTypes.STRING(512),
        allowNull: true,
        set(value) { this.setDataValue('password', fieldCrypto.encrypt(value)); },
        get() { return fieldCrypto.decrypt(this.getDataValue('password')); },
      },
      // Vendor id validated against the driver registry (services/vendors) at
      // the controller layer, not a DB enum — adding a vendor needs no migration.
      deviceType: {
        type: DataTypes.STRING(32),
        defaultValue: 'hikvision',
      },
      // Total camera channels on this device (e.g. 9 or 10)
      totalChannels: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.ENUM('online', 'offline', 'unknown'),
        defaultValue: 'unknown',
      },
      location: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      latitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
      },
      longitude: {
        type: DataTypes.DECIMAL(10, 7),
        allowNull: true,
      },
      // S3 folder: recordings/{userId}/{groupName}/
      s3Folder: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // Optional site this group belongs to. NULL = legacy / single-site.
      // FK is added at the migration level (012) with the right collation.
      siteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // Default recording retention (days) for all cameras in this group/location.
      // NULL = inherit from the site, then the global default (30d). A camera's
      // own retentionDays overrides this.
      retentionDays: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      },
      // Default playback quality for all cameras in this group. NULL = inherit
      // site/global ('auto'). A camera's own streamQuality overrides this.
      streamQuality: {
        type: DataTypes.ENUM('auto', 'main', 'sub'),
        allowNull: true,
      },
    },
    {
      tableName: 'camera_groups',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { unique: true, fields: ['user_id', 'host'] },
      ],
    }
  );

  CameraGroup.associate = (models) => {
    CameraGroup.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    CameraGroup.belongsTo(models.Site, { foreignKey: 'siteId', as: 'site' });
    CameraGroup.hasMany(models.Camera, { foreignKey: 'groupId', as: 'cameras' });
  };

  return CameraGroup;
};
