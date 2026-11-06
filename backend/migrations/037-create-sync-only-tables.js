'use strict';

// Four tables were only ever created by `sequelize.sync()` in server.js, which
// runs in development only. A production boot on a fresh database therefore
// had no alert_emails / mail_config / password_resets / restricted_zones, and
// e-mail alerts, SMTP settings, password reset and restricted zones failed.
// This creates them from the models themselves — the same CREATE TABLE IF NOT
// EXISTS that sync() issues — so it is a no-op on databases that already have
// them (every dev database).
const MODELS = ['AlertEmail', 'MailConfig', 'PasswordReset', 'RestrictedZone'];

module.exports = {
  async up(queryInterface) {
    for (const name of MODELS) {
      const model = require(`../src/models/${name}`)(queryInterface.sequelize);
      await model.sync();
    }
  },

  async down(queryInterface) {
    for (const name of [...MODELS].reverse()) {
      const model = require(`../src/models/${name}`)(queryInterface.sequelize);
      await queryInterface.dropTable(model.getTableName());
    }
  },
};
