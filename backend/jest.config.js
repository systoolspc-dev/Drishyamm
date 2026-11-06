/** Jest config — unit tests for isolated backend logic (no live DB/MediaMTX).
 *  Tests mock external boundaries (axios .api, models) so they run anywhere,
 *  including CI where infra isn't available. */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  // Inject dummy env BEFORE any module loads so config/env.js validation passes
  // without a local .env — keeps the suite hermetic and green in CI.
  setupFiles: ['<rootDir>/test/jest.setup.env.js'],
  clearMocks: true,
  // Keep the first suite focused on the pure, high-value logic we depend on.
  collectCoverageFrom: [
    'src/services/streaming/**/*.js',
    'src/services/cameraQuota.service.js',
  ],
};
