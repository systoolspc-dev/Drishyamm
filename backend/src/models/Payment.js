const { DataTypes } = require('sequelize');
const { PAYMENT_STATUS, GATEWAY } = require('../utils/constants');

module.exports = (sequelize) => {
  const Payment = sequelize.define(
    'Payment',
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
      subscriptionId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'subscriptions', key: 'id' },
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: 'INR',
      },
      gateway: {
        type: DataTypes.ENUM(Object.values(GATEWAY)),
        allowNull: false,
      },
      gatewayPaymentId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM(Object.values(PAYMENT_STATUS)),
        defaultValue: PAYMENT_STATUS.PENDING,
      },
    },
    {
      tableName: 'payments',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['gateway_payment_id'] },
      ],
    }
  );

  Payment.associate = (models) => {
    Payment.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Payment.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
  };

  return Payment;
};
