const asyncHandler = require('./asyncHandler');
const { assertFeature } = require('../services/entitlements.service');

// Gate a route on the account's feature switches (Subscription.features, set in
// the admin console's Account control). Passes when ANY of `keys` is on — some
// endpoints serve several pages (the watchlist is read by search and tracking
// too). AI keys also need the AI+VMS tier. The sidebar hide and the route
// redirect in the SPA are UX only; this is the boundary.
//
// Usage: router.get('/x', requireFeature('headcount'), handler)
const requireFeature = (...keys) =>
  asyncHandler(async (req, res, next) => {
    await assertFeature(req.user.id, keys);
    next();
  });

module.exports = requireFeature;
