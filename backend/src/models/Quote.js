const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Quote = sequelize.define(
    'Quote',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId:        { type: DataTypes.UUID, allowNull: true },
      lineItems:     { type: DataTypes.JSON, allowNull: false },
      term:          { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'monthly' },
      discountPct:   { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      subtotal:      { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      totalMonthly:  { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      totalTerm:     { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      currency:      { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'INR' },
      status: {
        type: DataTypes.ENUM('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'),
        allowNull: false,
        defaultValue: 'draft',
      },
      expiresAt:     { type: DataTypes.DATE, allowNull: true },
      licenseId:     { type: DataTypes.UUID, allowNull: true },
      createdByAdminId: { type: DataTypes.UUID, allowNull: true },
      notes:         { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: 'quotes',
      underscored: true,
    }
  );

  Quote.associate = (models) => {
    Quote.belongsTo(models.User,    { foreignKey: 'userId',    as: 'user' });
    Quote.belongsTo(models.License, { foreignKey: 'licenseId', as: 'license' });
  };

  return Quote;
};
