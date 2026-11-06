/**
 * notifications.controller.js — mobile push-token registration.
 *
 * The app posts its Expo push token after login (and on token refresh). A token
 * is globally unique to one physical device, so re-registering the same token
 * rebinds it to the current user and clears any `disabled` flag.
 */
const asyncHandler = require('../middleware/asyncHandler');
const { DeviceToken } = require('../models');

// POST /api/notifications/register  { token, platform?, deviceName? }
const registerToken = asyncHandler(async (req, res) => {
  const { token, platform = null, deviceName = null } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, error: 'token required' });
  }
  const userId = req.user.id;

  const existing = await DeviceToken.findOne({ where: { token } });
  if (existing) {
    await existing.update({
      userId, platform, deviceName, disabled: false, lastSeenAt: new Date(),
    });
  } else {
    await DeviceToken.create({
      userId, token, platform, deviceName, lastSeenAt: new Date(),
    });
  }
  return res.json({ ok: true });
});

// POST /api/notifications/unregister  { token }  (logout / disable on this device)
const unregisterToken = asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  await DeviceToken.destroy({ where: { token, userId: req.user.id } });
  return res.json({ ok: true });
});

module.exports = { registerToken, unregisterToken };
