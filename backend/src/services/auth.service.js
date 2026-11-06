const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { RefreshToken } = require('../models');
const AppError = require('../utils/AppError');

const authService = {
  /**
   * Generate access token (short-lived)
   */
  generateAccessToken(user) {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role, isPlatformAdmin: user.isPlatformAdmin === true },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
  },

  /**
   * Generate refresh token (long-lived, stored in DB, single-use)
   */
  async generateRefreshToken(user) {
    const token = jwt.sign(
      { id: user.id },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn }
    );

    // Parse expiry from JWT config (e.g., "7d" -> 7 days)
    const expiresAt = new Date();
    const match = config.jwt.refreshExpiresIn.match(/^(\d+)([smhd])$/);
    if (match) {
      const [, num, unit] = match;
      const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      expiresAt.setTime(expiresAt.getTime() + parseInt(num) * multipliers[unit]);
    } else {
      expiresAt.setDate(expiresAt.getDate() + 7); // fallback 7 days
    }

    await RefreshToken.create({
      userId: user.id,
      token,
      expiresAt,
    });

    return token;
  },

  /**
   * Verify access token
   */
  verifyAccessToken(token) {
    return jwt.verify(token, config.jwt.secret);
  },

  /**
   * Verify refresh token (check DB for revoked/expired)
   */
  async verifyRefreshToken(token) {
    const decoded = jwt.verify(token, config.jwt.refreshSecret);

    const storedToken = await RefreshToken.findOne({
      where: { token, isRevoked: false },
    });

    if (!storedToken) {
      throw new AppError('Refresh token is invalid or has been revoked.', 401);
    }

    if (new Date() > storedToken.expiresAt) {
      await storedToken.update({ isRevoked: true });
      throw new AppError('Refresh token has expired.', 401);
    }

    return decoded;
  },

  /**
   * Revoke a refresh token (single-use rotation)
   */
  async revokeRefreshToken(token) {
    await RefreshToken.update(
      { isRevoked: true },
      { where: { token } }
    );
  },

  /**
   * Revoke all refresh tokens for a user (e.g., on password change)
   */
  async revokeAllUserTokens(userId) {
    await RefreshToken.update(
      { isRevoked: true },
      { where: { userId, isRevoked: false } }
    );
  },

  /**
   * Generate both access and refresh tokens
   */
  async generateTokenPair(user) {
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user);
    return { accessToken, refreshToken };
  },
};

module.exports = authService;
