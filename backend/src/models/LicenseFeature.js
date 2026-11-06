const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const LicenseFeature = sequelize.define(
    'LicenseFeature',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      licenseId:  { type: DataTypes.UUID, allowNull: false },
      featureKey: { type: DataTypes.STRING(64), allowNull: false },
      enabled:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      configJson: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'license_features',
      underscored: true,
    }
  );

  LicenseFeature.associate = (models) => {
    LicenseFeature.belongsTo(models.License, { foreignKey: 'licenseId', as: 'license' });
  };

  return LicenseFeature;
};
