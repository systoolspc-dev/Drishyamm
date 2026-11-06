/**
 * streaming/index — engine factory.
 *
 * Selects the streaming engine implementation by STREAMING_ENGINE (default
 * 'mediamtx'). To add an engine: implement StreamingEngine, register it in the
 * ENGINES map below, and set STREAMING_ENGINE=<key>. Nothing else in the
 * backend changes — everyone imports the drishyamStreaming.service singleton.
 */
const logger = require('../../config/logger');
const StreamServiceEngine = require('./StreamServiceEngine');

const ENGINES = {
  mediamtx: () => new StreamServiceEngine(),
  // native:   () => new NativeCoreEngine(),   // future
};

function createEngine() {
  const name = (process.env.STREAMING_ENGINE || 'mediamtx').toLowerCase();
  const factory = ENGINES[name];
  if (!factory) {
    const known = Object.keys(ENGINES).join(', ');
    throw new Error(`Unknown STREAMING_ENGINE '${name}'. Known engines: ${known}`);
  }
  const engine = factory();
  logger.info('DrishyamStreaming: engine active', {
    engine: engine.engineName, ...engine.engineInfo(),
  });
  return engine;
}

module.exports = { createEngine, ENGINES };
