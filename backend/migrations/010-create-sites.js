'use strict';

// Plain CHAR(36) (no BINARY) under utf8mb4_unicode_ci — must match users.id
// to avoid errno 150. See migration 008 for the same lesson learnt.
const CHAR36 = 'CHAR(36) BINARY';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('sites')) return;

    // A "site" is a physical location grouping camera_groups + (later) MediaMTX
    // servers. Customers with one location have one site. Big customers
    // (school chains, multi-branch businesses) have many.
    //
    // We don't introduce orgs in this migration on purpose — most current
    // customers are single-org. orgId can be added later as a nullable column
    // when multi-tenancy lands; existing rows just sit under the user's
    // implicit "default org".
    await queryInterface.createTable('sites', {
      id: {
        type: CHAR36,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: CHAR36,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      slug: { type: Sequelize.STRING(120), allowNull: false },
      address: { type: Sequelize.STRING(500), allowNull: true },
      timezone: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'Asia/Kolkata',
      },
      latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      // Default settings inherited by camera_groups + cameras created here.
      // Shape: { ai: { enabled, fps, ... }, retention_days, ... }
      settings: { type: Sequelize.JSON, allowNull: true },
      status: {
        type: Sequelize.ENUM('active', 'paused', 'archived'),
        defaultValue: 'active',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('sites', ['user_id']).catch(() => {});
    await queryInterface.addIndex('sites', ['user_id', 'slug'], { unique: true }).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sites').catch(() => {});
  },
};
