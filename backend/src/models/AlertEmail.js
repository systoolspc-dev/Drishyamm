const { DataTypes } = require('sequelize');

/**
 * AlertEmail — an email address a user wants security alerts delivered to.
 *
 * Mirrors DeviceToken (push) but for the email channel: alertEngine fans out
 * to every enabled row for the event's user. `minSeverity` is the per-recipient
 * PRIORITY gate — a recipient set to 'critical' only gets critical alerts, one
 * set to 'warning' gets warning + critical. `info` never emails.
 */
module.exports = (sequelize) => {
  const AlertEmail = sequelize.define(
    'AlertEmail',
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
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      // Optional friendly name ("Security desk", "My phone")
      label: {
        type: DataTypes.STRING(80),
        allowNull: true,
      },
      // Priority threshold: lowest severity that emails this recipient.
      minSeverity: {
        type: DataTypes.ENUM('warning', 'critical'),
        defaultValue: 'warning',
      },
      // Which alert categories this recipient gets. NULL/empty = ALL categories.
      // Values: watchlist | unknown | intrusion | weapon | fire | crowd | other
      eventTypes: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      disabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'alert_emails',
      underscored: true,
      indexes: [
        { unique: true, name: 'uq_alert_emails_user_email', fields: ['user_id', 'email'] },
        { fields: ['user_id'] },
      ],
    },
  );

  AlertEmail.associate = (models) => {
    AlertEmail.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };

  return AlertEmail;
};
