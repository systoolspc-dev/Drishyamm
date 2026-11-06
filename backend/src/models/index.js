const { Sequelize } = require('sequelize');
const dbConfig = require('../config/database');
const logger = require('../config/logger');

const env = process.env.NODE_ENV || 'development';
const config = dbConfig[env];

const sequelize = new Sequelize(config.database, config.username, config.password, {
  host: config.host,
  port: config.port,
  dialect: config.dialect,
  logging: config.logging || false,
  pool: config.pool,
  define: config.define,
  dialectOptions: config.dialectOptions,
});

// Import models
const User = require('./User')(sequelize);
const Plan = require('./Plan')(sequelize);
const Subscription = require('./Subscription')(sequelize);
const Payment = require('./Payment')(sequelize);
const CameraGroup = require('./CameraGroup')(sequelize);
const Camera = require('./Camera')(sequelize);
const RefreshToken = require('./RefreshToken')(sequelize);
const PasswordReset = require('./PasswordReset')(sequelize);
const AIEvent = require('./AIEvent')(sequelize);
const DeviceToken = require('./DeviceToken')(sequelize);
const AlertEmail = require('./AlertEmail')(sequelize);
const MailConfig = require('./MailConfig')(sequelize);
const RestrictedZone = require('./RestrictedZone')(sequelize);
const Space = require('./Space')(sequelize);
const SpaceCamera = require('./SpaceCamera')(sequelize);
const Site = require('./Site')(sequelize);
const StreamServer = require('./StreamServer')(sequelize);
const PricingCatalog = require('./PricingCatalog')(sequelize);
const License = require('./License')(sequelize);
const LicenseResource = require('./LicenseResource')(sequelize);
const LicenseFeature = require('./LicenseFeature')(sequelize);
const Quote = require('./Quote')(sequelize);
const Role = require('./Role')(sequelize);
const WallLayout = require('./WallLayout')(sequelize);
const Report = require('./Report')(sequelize);
const AdminAuditLog = require('./AdminAuditLog')(sequelize);
const PlatformEvent = require('./PlatformEvent')(sequelize);

const models = {
  User, Plan, Subscription, Payment,
  Site, StreamServer,
  CameraGroup, Camera,
  RefreshToken, PasswordReset, AIEvent, DeviceToken, AlertEmail, MailConfig, RestrictedZone,
  Space, SpaceCamera,
  PricingCatalog, License, LicenseResource, LicenseFeature, Quote,
  Role,
  WallLayout,
  Report,
  AdminAuditLog,
  PlatformEvent,
};

// Set up associations
Object.values(models).forEach((model) => {
  if (model.associate) {
    model.associate(models);
  }
});

module.exports = {
  sequelize,
  Sequelize,
  ...models,
};
