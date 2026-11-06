const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const LicenseResource = sequelize.define(
    'LicenseResource',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      licenseId: { type: DataTypes.UUID, allowNull: false },
      sku:       { type: DataTypes.STRING(64), allowNull: false },
      quota:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      used:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      unitPriceSnapshot: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'license_resources',
      underscored: true,
    }
  );

  LicenseResource.associate = (models) => {
    LicenseResource.belongsTo(models.License, { foreignKey: 'licenseId', as: 'license' });
  };

  return LicenseResource;
};
