const asyncHandler = require('./asyncHandler');
const { assertAiEntitled } = require('../services/entitlements.service');

// Gate every AI route behind the account's plan tier. A "Basic VMS" account
// (plan.aiEnabled=false) gets a 403 even via curl — the frontend nav/route
// hides are UX only and never the sole boundary. Runs after `authenticate`,
// so req.user.id is present.
const requireAiCapability = asyncHandler(async (req, res, next) => {
  await assertAiEntitled(req.user.id);
  next();
});

module.exports = requireAiCapability;
