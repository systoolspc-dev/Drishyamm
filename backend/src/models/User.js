const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../utils/constants');

// Cost factor for password hashing. 13 (OWASP/NIST floor) over the old 12 —
// ~2x slower to brute-force. Existing hashes keep their embedded cost and still
// verify; only new/changed passwords are hashed at the higher factor.
const BCRYPT_ROUNDS = 13;

module.exports = (sequelize) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      // Login identifier for RBAC sub-users (admins keep using email). Unique,
      // optional so existing email-only accounts are untouched.
      // NOTE: uniqueness is enforced by the named index created in the
      // migration, NOT by `unique: true` here. Declaring it on the attribute
      // makes sequelize.sync() emit `ALTER TABLE ... CHANGE username ... UNIQUE`
      // on every boot, and MySQL adds ANOTHER anonymous index each time
      // (username_2, username_3, …). The table hits its 64-key ceiling and the
      // API then refuses to start. Twice observed in one day — see the unique
      // indexes in the migration instead.
      username: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: true, // relaxed: a username-only sub-user may have no email
        // Uniqueness lives in the migration's named index — see the note on
        // `username` above for why it must not be declared here.
        validate: { isEmail: { msg: 'Invalid email' }, },
      },
      password: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM(Object.values(ROLES)),
        defaultValue: ROLES.VIEWER,
      },
      // RBAC resource scope — which Sites/Groups this user may access. NULL or
      // empty arrays = no restriction (admins/managers see the whole account).
      // Nullable to match existing rows (pre-RBAC) and avoid a NOT NULL alter.
      scope: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: { siteIds: [], groupIds: [] },
      },
      // Account owner for a sub-user (the admin who created them). NULL = this
      // user IS an account owner and owns its own cameras/groups/sites.
      parentUserId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      // If set, this user's capabilities come from a custom Role (roles table)
      // instead of the built-in `role` tier.
      customRoleId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      groupKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      apiKey: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      emailVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      // Platform operator flag — grants access to the cross-tenant /api/admin/*
      // console (all tenants' users/cameras/revenue). NEVER settable via
      // self-registration (register only writes name/email/password/role); set
      // manually on ops accounts only. Minted into the access-token JWT so the
      // adminAuth guard can trust it without a DB round-trip.
      isPlatformAdmin: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
    },
    {
      tableName: 'users',
      paranoid: true, // soft deletes
      underscored: true,
      hooks: {
        beforeCreate: async (user) => {
          if (user.password) {
            user.password = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
          }
        },
        beforeUpdate: async (user) => {
          if (user.changed('password')) {
            user.password = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
          }
        },
      },
    }
  );

  User.prototype.validatePassword = async function (plainPassword) {
    return bcrypt.compare(plainPassword, this.password);
  };

  User.prototype.toSafeJSON = function () {
    const { password, ...user } = this.toJSON();
    return user;
  };

  // The account that owns the resources this user works with: their parent
  // (for sub-users) or themselves (for account owners). Resource queries scope
  // to this id, then narrow further by `scope`.
  User.prototype.accountOwnerId = function () {
    return this.parentUserId || this.id;
  };

  User.associate = (models) => {
    User.hasMany(models.Subscription, { foreignKey: 'userId', as: 'subscriptions' });
    User.hasMany(models.Payment, { foreignKey: 'userId', as: 'payments' });
    User.hasMany(models.Camera, { foreignKey: 'userId', as: 'cameras' });
    User.hasMany(models.RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
    User.belongsTo(models.User, { foreignKey: 'parentUserId', as: 'accountOwner' });
    User.hasMany(models.User, { foreignKey: 'parentUserId', as: 'members' });
    User.belongsTo(models.Role, { foreignKey: 'customRoleId', as: 'customRole' });
  };

  return User;
};
