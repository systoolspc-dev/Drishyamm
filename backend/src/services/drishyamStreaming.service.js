/**
 * drishyamStreaming.service.js
 *
 * Drishyam Streaming Service — the app-facing video data plane and the single
 * abstraction the backend talks to for live/record path control. The rest of
 * the code depends on THIS singleton, never on a concrete engine.
 *
 * The concrete engine is chosen by STREAMING_ENGINE (default 'mediamtx') and
 * built by ./streaming (the factory). Swapping the streaming backend — a
 * native/C++ core, GStreamer, a different SFU — means adding an engine that
 * implements ./streaming/StreamingEngine and registering it; controllers,
 * routes and sibling services are untouched.
 *
 * See ./streaming/StreamingEngine.js for the full method + behavioural contract.
 * The legacy path ./streamService.shim.js still re-exports this singleton.
 */
const { createEngine } = require('./streaming');

// The active engine IS the service surface. Exporting it directly (rather than
// wrapping every method) keeps the public API and semantics identical to the
// engine's, with zero delegation drift.
module.exports = createEngine();
