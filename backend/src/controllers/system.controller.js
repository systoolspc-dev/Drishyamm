/**
 * system.controller.js — system-level diagnostic endpoints.
 *
 *   GET /api/system/storage  — disk + recordings sizes; cached on the service
 */

const storageService = require('../services/storage.service');

async function storage(_req, res, next) {
  try {
    const snap = await storageService.snapshot();
    res.json({ success: true, ...snap });
  } catch (err) { next(err); }
}

module.exports = { storage };
