const { DataTypes } = require('sequelize');

/**
 * AdminAuditLog — what a platform operator changed, and on which account.
 *
 * Table from migration 014 (unused until the Account control screen).
 * admin_user_id holds the operator's users.id (migration 034 dropped the old
 * FK to the never-populated admin_users table). `payload` carries before/after
 * so the change can be read back without the request log. Rows are also
 * mirrored to the append-only file trail in utils/audit.js.
 */
module.exports = (sequelize) => {
  const AdminAuditLog = sequelize.define(
    'AdminAuditLog',
    {
      id:           { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      adminUserId:  { type: DataTypes.STRING(36), allowNull: false },
      action:       { type: DataTypes.STRING(64), allowNull: false },
      resourceType: { type: DataTypes.STRING(64), allowNull: false },
      resourceId:   { type: DataTypes.STRING(36), allowNull: true },
      payload:      { type: DataTypes.JSON, allowNull: true },
      ip:           { type: DataTypes.STRING(64), allowNull: true },
      userAgent:    { type: DataTypes.STRING(255), allowNull: true },
      ts:           { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'admin_audit_log',
      underscored: true,
      timestamps: false,
    }
  );

  return AdminAuditLog;
};
