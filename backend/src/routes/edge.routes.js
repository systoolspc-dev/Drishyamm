/**
 * edge.routes.js — endpoints called by site relays (drishyam-site-relay.ps1).
 *
 * Mounted at /api/edge/* with NO user auth: a relay has no account login. It
 * identifies itself by the site + token it puts in its stream names
 * (edge_<site>_<token>_chN), and is only answered if a camera is actually
 * configured with one of those paths.
 */
const { Router } = require('express');
const { Op } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { Camera } = require('../models');
const edgeRelay = require('../services/edgeRelay.service');

const router = Router();
const NAME_RE = /^[a-z0-9]{1,32}$/;

// site key → { known, at } — the camera lookup, cached so a poll every 2 s
// doesn't hit the database every time.
const KNOWN_TTL_MS = 60 * 1000;
const known = new Map();

async function isKnownRelay(site, token) {
  const key = `${site}_${token}`;
  const hit = known.get(key);
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.known;
  const n = await Camera.count({ where: { path: { [Op.like]: `%edge\\_${site}\\_${token}\\_ch%` } } });
  known.set(key, { known: n > 0, at: Date.now() });
  return n > 0;
}

// GET /api/edge/jobs?site=&token=&have=<ids it runs, comma-separated>
// → { jobs: [{ id, ch, start, end, push }] } (start/end: epoch ms). Held up to
// ~25 s while the list still equals `have`. The relay replays each job's
// channel over [start, end] and pushes it to `push`, and stops any replay
// whose id is no longer listed.
router.get('/jobs', asyncHandler(async (req, res) => {
  const site = String(req.query.site || '');
  const token = String(req.query.token || '');
  if (!NAME_RE.test(site) || !NAME_RE.test(token)) throw new AppError('site and token are required.', 400);
  if (!(await isKnownRelay(site, token))) throw new AppError('Unknown site relay.', 404);
  const have = String(req.query.have || '').split(',').filter((x) => /^[0-9a-f]{12}$/.test(x));
  res.json({ success: true, jobs: await edgeRelay.pollJobs(site, token, have) });
}));

module.exports = router;
