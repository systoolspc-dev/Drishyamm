/**
 * streamService.shim.js — DEPRECATED back-compat shim.
 *
 * The streaming control service was renamed to the Drishyam Streaming Service.
 * Import from './drishyamStreaming.service' instead. This re-export keeps any
 * missed / external reference working during the transition.
 */
module.exports = require('./drishyamStreaming.service');
