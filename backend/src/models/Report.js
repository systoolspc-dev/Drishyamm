const { DataTypes } = require('sequelize');

/**
 * Report — a generated report someone kept.
 *
 * `params` is the question (type, period, scope, sections); `payload` is the
 * frozen answer. Re-running a report replays params; downloading one replays
 * payload, so a PDF sent to a manager never changes under them.
 *
 * Scoped to the ACCOUNT OWNER, like WallLayout — the report library is shared
 * by everyone on the account. See migration 033.
 */
module.exports = (sequelize) => {
  // mysql2 hands JSON back parsed; a MariaDB or a raw query returns a string.
  const json = (field) => ({
    get() {
      const v = this.getDataValue(field);
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
  });

  const Report = sequelize.define(
    'Report',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      // No `references` — the FK is added by the migration with the correct
      // collation (errno-150 lesson, migration 008).
      userId:        { type: DataTypes.UUID, allowNull: false },
      createdBy:     { type: DataTypes.UUID, allowNull: true },
      createdByName: { type: DataTypes.STRING(120), allowNull: true },
      name:          { type: DataTypes.STRING(160), allowNull: false },
      type:          { type: DataTypes.STRING(32), allowNull: false },
      periodFrom:    { type: DataTypes.DATE, allowNull: false },
      periodTo:      { type: DataTypes.DATE, allowNull: false },
      status:        { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'ready' },
      error:         { type: DataTypes.STRING(500), allowNull: true },
      params:        { type: DataTypes.JSON, allowNull: false, ...json('params') },
      payload:       { type: DataTypes.JSON, allowNull: true, ...json('payload') },
      schedule:      { type: DataTypes.STRING(32), allowNull: true },
      lastExportedAt: { type: DataTypes.DATE, allowNull: true },
    },
    {
      tableName: 'reports',
      underscored: true,
      indexes: [
        { fields: ['user_id', 'created_at'] },
        { fields: ['user_id', 'type'] },
      ],
    },
  );

  Report.associate = (models) => {
    Report.belongsTo(models.User, { foreignKey: 'userId', as: 'account' });
    Report.belongsTo(models.User, { foreignKey: 'createdBy', as: 'author' });
  };

  return Report;
};
