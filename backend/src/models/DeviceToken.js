const { DataTypes } = require('sequelize');

/**
 * DeviceToken — one row per mobile device registered for push notifications.
 *
 * `token` is an Expo push token ("ExponentPushToken[...]"). A user can have
 * several (phone + tablet), so we key alerts by user and fan out to every
 * enabled token. When Expo reports a token as dead (DeviceNotRegistered), the
 * push sender flips `disabled` so we stop wasting sends on it.
 *
 * Like AIEvent, no `references` on the UUID columns — CHAR(36) BINARY collation
 * is handled by the migration; the association below still drives ORM joins.
 */
module.exports = (sequelize) => {
  const DeviceToken = sequelize.define(
    'DeviceToken',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      // Expo push token — unique across the fleet (one device = one token).
      token: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      platform: {
        type: DataTypes.ENUM('ios', 'android', 'web'),
        allowNull: true,
      },
      deviceName: {
        type: DataTypes.STRING(120),
        allowNull: true,
      },
      // Flipped true when Expo says the token no longer routes to a device.
      disabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'device_tokens',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { name: 'ux_device_tokens_token', unique: true, fields: ['token'] },
      ],
    },
  );

  DeviceToken.associate = (models) => {
    DeviceToken.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };

  return DeviceToken;
};
