const logger = require('../config/logger');
const AppError = require('../utils/AppError');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Sequelize validation error
  if (err.name === 'SequelizeValidationError') {
    statusCode = 400;
    message = err.errors.map((e) => e.message).join(', ');
  }

  // Sequelize unique constraint error
  if (err.name === 'SequelizeUniqueConstraintError') {
    statusCode = 409;
    const field = err.errors?.[0]?.path || 'field';
    message = `A record with this ${field} already exists`;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }
  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  }

  // Log error
  if (statusCode >= 500) {
    logger.error(`${statusCode} - ${message}`, {
      error: err.stack,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.user?.id,
    });
  } else {
    logger.warn(`${statusCode} - ${message}`, {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
    });
  }

  // Never leak internal error text to clients. 5xx bodies (unhandled throws,
  // SequelizeDatabaseError with raw SQL, etc.) return a generic message;
  // intentional 4xx AppErrors keep their human-readable message. The stack is
  // never returned (it's logged server-side above) — independent of NODE_ENV,
  // so a public deploy leaks nothing even if it boots in dev mode.
  const safeMessage = statusCode >= 500 ? 'Internal Server Error' : message;

  res.status(statusCode).json({
    success: false,
    message: safeMessage,
  });
};

module.exports = errorHandler;
