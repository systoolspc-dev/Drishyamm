const AppError = require('../utils/AppError');

const adminAuth = (req, res, next) => {
  // Platform-operator only. Every self-registered owner is role:admin, so a
  // plain role check would expose /api/admin/* (all tenants' users, cameras,
  // MRR) to any trial user. isPlatformAdmin is a JWT claim minted only for
  // DB-flagged ops accounts; self-registration can never set it.
  if (!req.user?.isPlatformAdmin) {
    throw new AppError('Access denied. Platform operator only.', 403);
  }
  next();
};

module.exports = adminAuth;
