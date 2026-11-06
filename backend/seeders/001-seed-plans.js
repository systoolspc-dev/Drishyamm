'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM plans');
    if (Number(rows?.[0]?.count || 0) > 0) return;

    await queryInterface.bulkInsert('plans', [
      {
        id: uuidv4(),
        name: 'Free',
        max_cameras: 2,
        max_storage: 5 * 1024 * 1024 * 1024, // 5 GB
        price: 0.0,
        billing_cycle: 'monthly',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: uuidv4(),
        name: 'Pro',
        max_cameras: 16,
        max_storage: 100 * 1024 * 1024 * 1024, // 100 GB
        price: 999.0,
        billing_cycle: 'monthly',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: uuidv4(),
        name: 'Enterprise',
        max_cameras: 64,
        max_storage: 1024 * 1024 * 1024 * 1024, // 1 TB
        price: 4999.0,
        billing_cycle: 'monthly',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('plans', null, {});
  },
};
