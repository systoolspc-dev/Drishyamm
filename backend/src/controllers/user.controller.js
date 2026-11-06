const asyncHandler = require('../middleware/asyncHandler');
const { User } = require('../models');
const AppError = require('../utils/AppError');

const getGroupKey = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id, {
    attributes: ['id', 'groupKey', 'apiKey'],
  });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  // Stream Service mode: users have no Shinobi credentials by design (see
  // auth.controller — group_key/api_key are kept for backward-compat but
  // left null). Return them as-is (null) instead of 403'ing; the camera
  // APIs are scoped by the authenticated user, not by a group key.
  res.json({ groupKey: user.groupKey || null, apiKey: user.apiKey || null });
});

module.exports = { getGroupKey };
