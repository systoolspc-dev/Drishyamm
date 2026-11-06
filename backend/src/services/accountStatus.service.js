/**
 * accountStatus.service — which users are blocked because their account is
 * suspended.
 *
 * A platform operator suspends a customer ACCOUNT (the owner row,
 * users.is_active = 0). Login and token refresh already refuse an inactive
 * user, but an access token that was minted before the suspension stayed good
 * until it expired (JWT_EXPIRES_IN, 2 h here), and the account's sub-users were
 * never checked at all. `authenticate` runs on every API request and is
 * synchronous, so it cannot ask the database each time. It asks this set
 * instead:
 *
 *   blocked = inactive users  +  every sub-user of an inactive owner
 *
 * The set is reloaded every REFRESH_MS (so a change made by another backend
 * replica, or straight in the database, lands within that window) and is
 * updated at once by the admin suspend/reactivate endpoint on this process.
 * Until start() runs (unit tests, scripts) it is empty and blocks nobody.
 */
const logger = require('../config/logger');

const REFRESH_MS = 30 * 1000;

let blocked = new Set();
let timer = null;

async function reload() {
  const { User } = require('../models');
  const { Op } = require('sequelize');
  const inactive = await User.findAll({ where: { isActive: false }, attributes: ['id', 'parentUserId'] });
  const ownerIds = inactive.filter((u) => !u.parentUserId).map((u) => u.id);
  const members = ownerIds.length
    ? await User.findAll({ where: { parentUserId: { [Op.in]: ownerIds } }, attributes: ['id'] })
    : [];
  blocked = new Set([...inactive.map((u) => u.id), ...members.map((m) => m.id)]);
  return blocked.size;
}

function start() {
  if (timer) return;
  const tick = () => reload().catch((err) => logger.warn('accountStatus reload failed', { error: err.message }));
  tick();
  timer = setInterval(tick, REFRESH_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** True when this user id belongs to a suspended account (or is itself inactive). */
function isBlocked(userId) {
  return !!userId && blocked.has(String(userId));
}

/** Apply a suspend/reactivate on this process right away (the reload confirms it). */
function setBlocked(userIds, on) {
  const next = new Set(blocked);
  for (const id of userIds) {
    if (on) next.add(String(id)); else next.delete(String(id));
  }
  blocked = next;
}

module.exports = { start, stop, reload, isBlocked, setBlocked, REFRESH_MS };
