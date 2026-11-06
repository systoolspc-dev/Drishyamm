const jwt = require('jsonwebtoken');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const accountStatus = require('../services/accountStatus.service');

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Allow token as query param for endpoints that browsers load directly
  // (e.g. <video src="/stream?token=..."> cannot send custom headers)
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.split(' ')[1]
    : req.query.token || null;

  if (!token) {
    throw new AppError('Access denied. No token provided.', 401);
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded; // { id, email, role }
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AppError('Token expired. Please refresh your token.', 401);
    }
    throw new AppError('Invalid token.', 401);
  }

  // A suspended account (or a sub-user of one) is refused even with a token
  // minted before the suspension. 401 so the apps drop the session; the login
  // screen then says why (auth.controller refuses inactive accounts with 403).
  if (accountStatus.isBlocked(req.user.id)) {
    throw new AppError('This account is suspended. Contact support.', 401);
  }
  next();
};

module.exports = authenticate;
