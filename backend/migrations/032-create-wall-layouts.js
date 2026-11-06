'use strict';

/**
 * wall_layouts — saved Monitor Wall layouts, shared across an account.
 *
 * A layout is a grid (cols × rows) and one or more PAGES. Each page is an array
 * of cols*rows slots holding a camera monitorId, or null for an empty slot.
 * Pages are JSON rather than a slot table: a layout is always read and written
 * whole, and a slot table would need a delete-and-reinsert on every save.
 *
 * `user_id` is the ACCOUNT OWNER (users.parent_user_id || users.id), not the
 * person who saved it, so every member of the account sees the same list.
 * created_by / updated_by record who actually did it.
 *
 * The grid columns are grid_cols / grid_rows because ROWS is a reserved word
 * in MySQL 8. Raw `CHAR(36) BINARY` for UUID columns so the FK collation
 * matches users.id (the errno-150 lesson from migration 008). Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => String(t).toLowerCase()).includes('wall_layouts')) return;

    await queryInterface.createTable('wall_layouts', {
      id:         { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
      user_id:    { type: 'CHAR(36) BINARY', allowNull: false },
      created_by: { type: 'CHAR(36) BINARY', allowNull: true },
      updated_by: { type: 'CHAR(36) BINARY', allowNull: true },
      name:       { type: Sequelize.STRING(120), allowNull: false },
      grid_cols:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 4 },
      grid_rows:  { type: Sequelize.INTEGER, allowNull: false, defaultValue: 4 },
      pages:      { type: Sequelize.JSON, allowNull: false },
      rotate:         { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      rotate_seconds: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 30 },
      skip_offline:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      focus_audio:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false,
                    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false,
                    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    await queryInterface.addIndex('wall_layouts', ['user_id']).catch(() => {});
    await queryInterface.addIndex('wall_layouts', ['user_id', 'name'],
      { unique: true, name: 'ux_wall_layouts_user_name' }).catch(() => {});
    await queryInterface.addConstraint('wall_layouts', {
      fields: ['user_id'], type: 'foreign key', name: 'fk_wall_layouts_user',
      references: { table: 'users', field: 'id' }, onDelete: 'CASCADE',
    }).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wall_layouts').catch(() => {});
  },
};
