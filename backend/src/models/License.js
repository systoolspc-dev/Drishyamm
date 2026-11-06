const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const License = sequelize.define(
    'License',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: { type: DataTypes.UUID, allowNull: false },
      status: {
        type: DataTypes.ENUM('draft', 'trial', 'active', 'suspended', 'expired', 'terminated'),
        allowNull: false,
        defaultValue: 'draft',
      },
      term: {
        type: DataTypes.ENUM('trial_30', 'trial_60', 'trial_90', 'monthly', 'annual', 'biennial', 'triennial'),
        allowNull: false,
        defaultValue: 'monthly',
      },
      startDate:    { type: DataTypes.DATEONLY, allowNull: true },
      endDate:      { type: DataTypes.DATEONLY, allowNull: true },
      licenseKey:   { type: DataTypes.TEXT, allowNull: true },
      currency:     { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'INR' },
      mrr:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      arr:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      setupFee:     { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      discountPct:  { type: DataTypes.DECIMAL(5, 2),  allowNull: false, defaultValue: 0 },
      notes:        { type: DataTypes.TEXT, allowNull: true },
      createdByAdminId: { type: DataTypes.UUID, allowNull: true },
    },
    {
      tableName: 'licenses',
      underscored: true,
    }
  );

  License.associate = (models) => {
    License.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    License.hasMany(models.LicenseResource, { foreignKey: 'licenseId', as: 'resources' });
    License.hasMany(models.LicenseFeature,  { foreignKey: 'licenseId', as: 'features' });
  };

  return License;
};
