'use strict';

/**
 * spaces + space_cameras — the ROOM model for occupancy analytics.
 *
 * Nothing existing could serve as a room: camera_groups is an NVR device,
 * restricted_zones is a polygon on ONE camera, sites is a building.
 * See docs/OCCUPANCY_LOGIC.md §1/§3.
 *
 * Raw `CHAR(36) BINARY` for UUID columns so FK collation matches
 * users/sites/cameras (the errno-150 lesson from migration 008). Idempotent:
 * every create/index/constraint is guarded.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const has = (t) => tables.map((x) => String(x).toLowerCase()).includes(t);

    if (!has('spaces')) {
      await queryInterface.createTable('spaces', {
        id:      { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        user_id: { type: 'CHAR(36) BINARY', allowNull: false },
        site_id: { type: 'CHAR(36) BINARY', allowNull: true },
        name:    { type: Sequelize.STRING(120), allowNull: false },
        slug:    { type: Sequelize.STRING(120), allowNull: false },
        type:    { type: Sequelize.ENUM('room', 'meeting_room', 'hall', 'floor',
                                        'entrance', 'queue', 'zone', 'other'),
                   allowNull: false, defaultValue: 'room' },
        capacity: { type: Sequelize.INTEGER, allowNull: true },   // NULL/0 = alerts off
        area_sqm: { type: Sequelize.DECIMAL(8, 2), allowNull: true },
        operating_hours: { type: Sequelize.JSON, allowNull: true },
        settings:        { type: Sequelize.JSON, allowNull: true },
        primary_monitor_id: { type: Sequelize.STRING(64), allowNull: true },
        purpose: { type: Sequelize.ENUM('safety_capacity', 'facilities_utilization', 'operations'),
                   allowNull: false, defaultValue: 'safety_capacity' },
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('spaces', ['user_id']).catch(() => {});
      await queryInterface.addIndex('spaces', ['site_id']).catch(() => {});
      await queryInterface.addIndex('spaces', ['user_id', 'slug'],
        { unique: true, name: 'ux_spaces_user_slug' }).catch(() => {});
      await queryInterface.addConstraint('spaces', {
        fields: ['user_id'], type: 'foreign key', name: 'fk_spaces_user',
        references: { table: 'users', field: 'id' }, onDelete: 'CASCADE',
      }).catch(() => {});
    }

    if (!has('space_cameras')) {
      await queryInterface.createTable('space_cameras', {
        id:         { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        space_id:   { type: 'CHAR(36) BINARY', allowNull: false },
        camera_id:  { type: 'CHAR(36) BINARY', allowNull: false },
        monitor_id: { type: Sequelize.STRING(64), allowNull: false },
        role:       { type: Sequelize.ENUM('gauge', 'line'), allowNull: false, defaultValue: 'gauge' },
        // Cameras sharing a group see the SAME people → MAX (no double-count).
        overlap_group: { type: Sequelize.STRING(32), allowNull: true },
        weight:     { type: Sequelize.FLOAT, allowNull: false, defaultValue: 1.0 },
        line_config:  { type: Sequelize.JSON, allowNull: true },
        mask_zone_id: { type: 'CHAR(36) BINARY', allowNull: true },
        enabled:    { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false,
                      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

      await queryInterface.addIndex('space_cameras', ['space_id', 'camera_id'],
        { unique: true, name: 'ux_space_cameras_pair' }).catch(() => {});
      await queryInterface.addIndex('space_cameras', ['camera_id']).catch(() => {});
      await queryInterface.addIndex('space_cameras', ['monitor_id']).catch(() => {});
      await queryInterface.addConstraint('space_cameras', {
        fields: ['space_id'], type: 'foreign key', name: 'fk_space_cameras_space',
        references: { table: 'spaces', field: 'id' }, onDelete: 'CASCADE',
      }).catch(() => {});
      await queryInterface.addConstraint('space_cameras', {
        fields: ['camera_id'], type: 'foreign key', name: 'fk_space_cameras_camera',
        references: { table: 'cameras', field: 'id' }, onDelete: 'CASCADE',
      }).catch(() => {});
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('space_cameras').catch(() => {});
    await queryInterface.dropTable('spaces').catch(() => {});
  },
};
