'use strict';

/**
 * Per-account feature curation. NULL = every AI feature the plan tier allows
 * (default AI+VMS behaviour). A JSON array = only those feature keys are shown
 * (e.g. Sharda: face_detection, person_tracker, crowd_monitoring, restricted_zone).
 * Lets one AI+VMS account be scoped to a subset without a bespoke plan per customer.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('subscriptions', 'features', {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('subscriptions', 'features');
  },
};
