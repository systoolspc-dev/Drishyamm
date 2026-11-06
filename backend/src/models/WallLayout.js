const { DataTypes } = require('sequelize');

/**
 * WallLayout — a saved Monitor Wall: the grid, its pages of camera slots, and
 * how the wall plays them (rotation, offline handling, audio).
 *
 * Scoped to the ACCOUNT OWNER, so every user on an account shares one list.
 * See migration 032 for why pages are JSON and the grid columns are renamed.
 */
module.exports = (sequelize) => {
  const WallLayout = sequelize.define(
    'WallLayout',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // No `references` here — the FK is added by the migration with the
      // correct collation (errno-150 lesson, migration 008).
      userId:    { type: DataTypes.UUID, allowNull: false },
      createdBy: { type: DataTypes.UUID, allowNull: true },
      updatedBy: { type: DataTypes.UUID, allowNull: true },
      name: {
        type: DataTypes.STRING(120),
        allowNull: false,
      },
      cols: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4, field: 'grid_cols' },
      rows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 4, field: 'grid_rows' },
      // [[monitorId | null, …cols*rows], …pages]
      pages: {
        type: DataTypes.JSON,
        allowNull: false,
        // mysql2 hands JSON back parsed, but a MariaDB or a raw query returns a
        // string; normalise so callers always get an array.
        get() {
          const v = this.getDataValue('pages');
          return typeof v === 'string' ? JSON.parse(v) : v;
        },
      },
      rotate:        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      rotateSeconds: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
      skipOffline:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      focusAudio:    { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      tableName: 'wall_layouts',
      underscored: true,
      indexes: [
        { fields: ['user_id'] },
        { unique: true, fields: ['user_id', 'name'] },
      ],
    },
  );

  WallLayout.associate = (models) => {
    WallLayout.belongsTo(models.User, { foreignKey: 'userId', as: 'account' });
  };

  return WallLayout;
};
