const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const PricingCatalog = sequelize.define(
    'PricingCatalog',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // No `unique: true` here — uniqueness comes from the named index below.
      // On an attribute it makes sequelize.sync() re-issue an ALTER every boot
      // and MySQL adds a fresh anonymous index each time (sku_2, sku_3, …)
      // until the table hits its 64-key limit and the API stops starting.
      sku:           { type: DataTypes.STRING(64),  allowNull: false },
      name:          { type: DataTypes.STRING(120), allowNull: false },
      category: {
        type: DataTypes.ENUM('camera', 'storage', 'compute', 'ai_feature', 'support', 'one_time', 'discount'),
        allowNull: false,
      },
      unit:          { type: DataTypes.STRING(32),  allowNull: false },
      unitPriceInr:  { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0, field: 'unit_price_inr' },
      description:   { type: DataTypes.STRING(255), allowNull: true },
      isActive:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder:     { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'pricing_catalog',
      underscored: true,
    }
  );

  return PricingCatalog;
};
