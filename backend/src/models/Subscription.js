const { DataTypes } = require('sequelize');
const { SUBSCRIPTION_STATUS } = require('../utils/constants');

module.exports = (sequelize) => {
  const Subscription = sequelize.define(
    'Subscription',
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
      planId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
      },
      stripeSubscriptionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      razorpaySubscriptionId: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM(Object.values(SUBSCRIPTION_STATUS)),
        defaultValue: SUBSCRIPTION_STATUS.ACTIVE,
      },
      currentPeriodStart: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      currentPeriodEnd: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      // Per-account feature curation. NULL = all AI features the plan allows;
      // a JSON array of feature keys = only those (e.g. a customer who only
      // wants face_detection + person_tracker + crowd_monitoring). Used to scope
      // one AI+VMS account to a subset without minting a bespoke plan.
      features: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      // Per-account camera licence (migration 034). NULL = plan.maxCameras;
      // a number = this account's own cap (0 = no cameras). Set from the admin
      // console's Account control screen; enforced by cameraQuota.service.
      cameraLimit: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // Per-camera AI licences, e.g. { face: 10, headcount: 4 }. A missing key
      // = no separate cap. Keys = AI_LICENCES in utils/featureCatalog.js.
      featureLimits: {
        type: DataTypes.JSON,
        allowNull: true,
      },
    },
    {
      tableName: 'subscriptions',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { fields: ['status'] },
      ],
    }
  );

  Subscription.associate = (models) => {
    Subscription.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Subscription.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
    Subscription.hasMany(models.Payment, { foreignKey: 'subscriptionId', as: 'payments' });
  };

  return Subscription;
};
