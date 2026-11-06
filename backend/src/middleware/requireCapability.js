const asyncHandler = require('./asyncHandler');
const AppError = require('../utils/AppError');
const { userCan } = require('../utils/constants');
const { User, Role } = require('../models');

// Capability gate. Loads the FRESH user record (not the JWT snapshot) so a
// role change, scope change, or account deactivation takes effect immediately
// without waiting for the token to expire. Attaches req.dbUser for downstream
// scope enforcement.
//
// Usage: router.post('/users', authenticate, requireCapability(CAPABILITIES.MANAGE_USERS), ...)
const requireCapability = (capability) =>
  asyncHandler(async (req, res, next) => {
    const user = await User.findByPk(req.user.id, {
      include: [{ model: Role, as: 'customRole', required: false }],
    });
    if (!user) throw new AppError('User no longer exists', 401);
    if (!user.isActive) throw new AppError('This account has been deactivated.', 403);
    req.dbUser = user;
    if (!userCan(user, capability)) {
      throw new AppError('You do not have permission to perform this action.', 403);
    }
    next();
  });

module.exports = requireCapability;
