const { DataTypes } = require('sequelize');

// A custom, account-defined role: a name + the set of capabilities (features)
// the admin assigns to it. Built-in tiers (admin/manager/operator/viewer) live
// in code (utils/constants); these are the extra roles an account creates.
module.exports = (sequelize) => {
  const Role = sequelize.define(
    'Role',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // The account (owner user) this custom role belongs to.
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(60),
        allowNull: false,
      },
      // Array of capability strings from CAPABILITIES (utils/constants).
      capabilities: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
      },
    },
    {
      tableName: 'roles',
      underscored: true,
      indexes: [
        { unique: true, fields: ['user_id', 'name'] },
      ],
    }
  );

  Role.associate = (models) => {
    Role.belongsTo(models.User, { foreignKey: 'userId', as: 'account' });
    Role.hasMany(models.User, { foreignKey: 'customRoleId', as: 'users' });
  };

  return Role;
};
