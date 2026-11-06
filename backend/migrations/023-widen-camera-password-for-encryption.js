'use strict';

/**
 * Widen cameras.password and camera_groups.password from VARCHAR(255) to
 * VARCHAR(512) so AES-256-GCM ciphertext (nonce+ct+tag, base64, with the
 * `enc:v1:` tag) fits. Transparent field encryption is applied in the models
 * when CAMERA_CRED_KEY is set; legacy plaintext rows keep working and re-encrypt
 * the next time they're saved. See src/utils/fieldCrypto.js.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of ['cameras', 'camera_groups']) {
      const desc = await queryInterface.describeTable(table).catch(() => null);
      if (!desc || !desc.password) continue;
      await queryInterface.changeColumn(table, 'password', {
        type: Sequelize.STRING(512),
        allowNull: true,
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // NOTE: narrowing back to 255 would truncate encrypted values — only safe
    // if encryption was never enabled. Left as a best-effort revert.
    for (const table of ['cameras', 'camera_groups']) {
      await queryInterface.changeColumn(table, 'password', {
        type: Sequelize.STRING(255),
        allowNull: true,
      }).catch(() => {});
    }
  },
};
