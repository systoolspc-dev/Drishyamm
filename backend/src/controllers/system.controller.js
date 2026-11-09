/**
 * system.controller.js — system-level diagnostic endpoints.
 *
 *   GET /api/system/storage  — disk + recordings sizes; cached on the service
 */

const storageService = require('../services/storage.service');

async function storage(req, res, next) {
  try {
    // Disk snapshot is global; cloud usage is scoped to the caller's own
    // account so each user only sees their own footprint in the 10 PB tier.
    const [snap, cloud] = await Promise.all([
      storageService.snapshot(),
      storageService.cloudUsage(req.user && req.user.id),
    ]);
    res.json({ success: true, ...snap, cloud });
  } catch (err) { next(err); }
}

module.exports = { storage };
