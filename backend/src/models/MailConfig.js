const { DataTypes } = require('sequelize');
const fieldCrypto = require('../utils/fieldCrypto');

/**
 * MailConfig — singleton (id=1) SMTP config managed by a platform admin from the
 * admin dashboard. Supports webmail/cPanel or Gmail. Password is encrypted at
 * rest (AES-256-GCM via fieldCrypto, same as camera creds).
 */
module.exports = (sequelize) => {
  const MailConfig = sequelize.define(
    'MailConfig',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      provider: { type: DataTypes.STRING(20), defaultValue: 'custom' }, // gmail | webmail | custom
      host: { type: DataTypes.STRING(255), allowNull: true },
      port: { type: DataTypes.INTEGER, defaultValue: 465 },
      secure: { type: DataTypes.BOOLEAN, defaultValue: true },
      username: { type: DataTypes.STRING(255), allowNull: true },
      password: {
        type: DataTypes.TEXT,
        allowNull: true,
        set(v) { this.setDataValue('password', v ? fieldCrypto.encrypt(v) : v); },
        get() { const raw = this.getDataValue('password'); return raw ? fieldCrypto.decrypt(raw) : raw; },
      },
      fromName: { type: DataTypes.STRING(120), defaultValue: 'Drishyam Alerts' },
      fromEmail: { type: DataTypes.STRING(255), allowNull: true },
      enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    },
    {
      tableName: 'mail_config',
      underscored: true,
    },
  );

  return MailConfig;
};
