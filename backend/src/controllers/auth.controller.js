const { Op } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const { User, Subscription, Plan, PasswordReset, Role } = require('../models');
const authService = require('../services/auth.service');
const emailService = require('../services/email.service');
const AppError = require('../utils/AppError');
const { audit } = require('../utils/audit');
const { ROLE_CAPABILITIES, ROLES, resolveCapabilities } = require('../utils/constants');
const { getAiEntitlement, getEntitlements } = require('../services/entitlements.service');
const platformEvents = require('../services/platformEvents.service');
const { hostOf } = require('../services/platformEvents/catalog');

// Trial signup tier → plan name. Basic VMS = video management only,
// AI+VMS = adds face/ANPR/weapon/fire/crowd/journey.
const TIER_TO_PLAN = { basic_vms: 'Basic VMS', ai_vms: 'AI+VMS' };

// The frontend gates AI UI on `capabilities`. Strip the AI capability for
// accounts whose plan doesn't include it so the list is truthful. This is UX
// correctness — the backend AI routes still 403 regardless (the real boundary).
function capabilitiesFor(user, aiEnabled) {
  const caps = resolveCapabilities(user);
  return aiEnabled ? caps : caps.filter((c) => c !== 'use_ai');
}

// A sub-user can sign in only while its account owner is active.
async function ownerIsActive(user) {
  if (!user.parentUserId) return true;
  const owner = await User.findByPk(user.parentUserId, { attributes: ['id', 'isActive'] });
  return !!owner && owner.isActive !== false;
}

const register = asyncHandler(async (req, res) => {
  const { name, email, password, tier } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new AppError('An account with this email already exists.', 409);
  }

  // Self-registration creates an ACCOUNT OWNER (admin of their own tenant).
  // Sub-users are provisioned later via Settings → Manage Users with lesser roles.
  // NOTE: only name/email/password/role are written here — a client cannot set
  // role, isPlatformAdmin, or any other column by stuffing extra body fields.
  const user = await User.create({ name, email, password, role: ROLES.ADMIN });

  // Assign the trial plan for the chosen tier (default Basic VMS). Falls back to
  // Free, then nothing, so signup never hard-fails on a missing seed.
  const planName = TIER_TO_PLAN[tier] || TIER_TO_PLAN.basic_vms;
  const plan =
    (await Plan.findOne({ where: { name: planName } })) ||
    (await Plan.findOne({ where: { name: 'Free' } }));
  if (plan) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setFullYear(periodEnd.getFullYear() + 100); // trial plan never expires
    await Subscription.create({
      userId: user.id,
      planId: plan.id,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });
  }

  // Admin console live activity: who signed up, on which plan, from where.
  const source = hostOf(req.headers.origin) || hostOf(req.headers.referer) || req.headers.host || null;
  const chosen = plan ? platformEvents.planLabel(plan.name) : 'no plan';
  platformEvents.record('account.created', {
    accountId: user.id,
    accountLabel: user.name,
    actor: { kind: 'owner', id: user.id, label: user.name },
    req,
    summary: `New account: ${user.name} (${user.email}) chose ${chosen}`,
    data: { name: user.name, email: user.email, plan: plan ? plan.name : null, tier: tier || 'basic_vms', source, via: 'self-signup' },
  });

  // Generate tokens
  const { accessToken, refreshToken } = await authService.generateTokenPair(user);
  const { aiEnabled, features } = await getEntitlements(user.id);

  res.status(201).json({
    success: true,
    user: { ...user.toSafeJSON(), aiEnabled, features },
    capabilities: capabilitiesFor(user, aiEnabled),
    token: accessToken,
    refreshToken,
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const identifier = String(email || '').trim();

  // Accept an email OR a username (RBAC sub-users log in by username).
  const user = await User.findOne({
    where: { [Op.or]: [{ email: identifier.toLowerCase() }, { username: identifier }] },
    include: [{ model: Role, as: 'customRole', required: false }],
  });
  if (!user) {
    platformEvents.noteLoginFailure(identifier, { req, reason: 'unknown_user' });
    throw new AppError('Invalid credentials.', 401);
  }

  // Check if active — the user itself, and for a sub-user its account owner
  // (suspending an account suspends everyone in it).
  if (!user.isActive || !(await ownerIsActive(user))) {
    throw new AppError('Your account has been deactivated. Please contact support.', 403);
  }

  // Validate password
  const isValid = await user.validatePassword(password);
  if (!isValid) {
    platformEvents.noteLoginFailure(identifier, { req, user, reason: 'bad_password' });
    throw new AppError('Invalid email or password.', 401);
  }

  platformEvents.noteLogin(user, req);

  // Generate tokens
  const { accessToken, refreshToken } = await authService.generateTokenPair(user);
  const { aiEnabled, features } = await getEntitlements(user.id);

  res.json({
    success: true,
    user: { ...user.toSafeJSON(), aiEnabled, features },
    capabilities: capabilitiesFor(user, aiEnabled),
    token: accessToken,
    refreshToken,
  });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findByPk(req.user.id, {
    attributes: { exclude: ['password'] },
    include: [
      { model: Role, as: 'customRole', required: false },
      {
        model: Subscription,
        as: 'subscriptions',
        where: { status: 'active' },
        required: false,
        limit: 1,
        order: [['createdAt', 'DESC']],
        include: [
          {
            model: Plan,
            as: 'plan',
            attributes: ['id', 'name', 'maxCameras', 'maxStorage', 'price', 'billingCycle'],
          },
        ],
      },
    ],
  });

  if (!user) {
    throw new AppError('User not found.', 404);
  }

  const userData = user.toJSON();
  const activeSubscription = userData.subscriptions?.[0] || null;
  delete userData.password;

  const { aiEnabled, features } = await getEntitlements(req.user.id);

  res.json({
    success: true,
    user: {
      ...userData,
      aiEnabled,
      features,
      subscription: activeSubscription,
      subscriptions: undefined, // remove array
    },
    // Capabilities the frontend uses to gate UI (custom role overrides tier).
    capabilities: capabilitiesFor(user, aiEnabled),
  });
});

const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;

  // Verify old refresh token
  const decoded = await authService.verifyRefreshToken(token);

  // Revoke old token (single-use rotation)
  await authService.revokeRefreshToken(token);

  // Find user
  const user = await User.findByPk(decoded.id);
  if (!user || !user.isActive || !(await ownerIsActive(user))) {
    throw new AppError('User not found or deactivated.', 401);
  }

  // Generate new pair
  const { accessToken, refreshToken: newRefreshToken } = await authService.generateTokenPair(user);

  res.json({
    success: true,
    token: accessToken,
    refreshToken: newRefreshToken,
  });
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;

  if (token) {
    await authService.revokeRefreshToken(token);
  }

  res.json({ success: true, message: 'Logged out successfully.' });
});

/**
 * POST /auth/forgot-password
 * Sends a password reset email with a secure token
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  // Always respond with success to prevent email enumeration
  const user = await User.findOne({ where: { email } });
  if (!user || !user.isActive) {
    return res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  }

  // Invalidate any existing unused reset tokens for this user
  await PasswordReset.update(
    { usedAt: new Date() },
    { where: { userId: user.id, usedAt: null } }
  );

  // Generate token (96 hex chars = 48 bytes)
  const token = PasswordReset.generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await PasswordReset.create({ userId: user.id, token, expiresAt });

  platformEvents.record('password.reset_requested', {
    accountId: user.parentUserId || user.id,
    actor: { kind: user.parentUserId ? 'member' : 'owner', id: user.id, label: user.name || user.email },
    req,
    summary: `${user.name || user.email} asked for a password reset link`,
    data: { userId: user.id, email: user.email, via: 'forgot-password' },
  });

  // Send email (errors are logged but don't fail the request)
  try {
    await emailService.sendPasswordResetEmail(user.email, user.name, token);
  } catch (err) {
    // Token was created - user can retry. Don't expose email errors.
  }

  res.json({
    success: true,
    message: 'If an account with that email exists, a password reset link has been sent.',
  });
});

/**
 * POST /auth/reset-password
 * Validates token and sets new password
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  // Find valid, unused, non-expired token
  const resetRecord = await PasswordReset.findOne({
    where: {
      token,
      usedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    include: [{ model: User, as: 'user' }],
  });

  if (!resetRecord || !resetRecord.user || !resetRecord.user.isActive) {
    throw new AppError('This password reset link is invalid or has expired.', 400);
  }

  const user = resetRecord.user;

  // Update password (the User model hook will hash it)
  await user.update({ password });

  // Mark token as used
  await resetRecord.update({ usedAt: new Date() });

  // Revoke all existing sessions for security
  await authService.revokeAllUserTokens(user.id);

  audit('user.password.reset', {
    req,
    targetType: 'user',
    targetId: user.id,
    meta: { email: user.email, via: 'reset-token', sessionsRevoked: true },
  });

  res.json({
    success: true,
    message: 'Password reset successfully. Please log in with your new password.',
  });
});

/**
 * PUT /auth/profile
 * Update name and/or email of the authenticated user
 */
const updateProfile = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  const user = await User.findByPk(req.user.id);

  if (!user) throw new AppError('User not found.', 404);

  // Check email uniqueness if changing
  if (email && email !== user.email) {
    const existing = await User.findOne({ where: { email } });
    if (existing) throw new AppError('This email is already in use.', 409);
  }

  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email;

  await user.update(updates);

  res.json({
    success: true,
    user: user.toSafeJSON(),
    message: 'Profile updated successfully.',
  });
});

/**
 * PUT /auth/change-password
 * Change password while authenticated (requires current password)
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findByPk(req.user.id);

  if (!user) throw new AppError('User not found.', 404);

  const isValid = await user.validatePassword(currentPassword);
  if (!isValid) throw new AppError('Current password is incorrect.', 401);

  if (currentPassword === newPassword) {
    throw new AppError('New password must be different from your current password.', 400);
  }

  // Update password (model hook will re-hash)
  await user.update({ password: newPassword });

  // Revoke all refresh tokens to force re-login on other devices
  await authService.revokeAllUserTokens(user.id);

  audit('user.password.changed', {
    req,
    targetType: 'user',
    targetId: user.id,
    meta: { email: user.email, via: 'self-service', sessionsRevoked: true },
  });

  res.json({
    success: true,
    message: 'Password changed successfully. Please log in again.',
  });
});

module.exports = { register, login, me, refreshToken, logout, forgotPassword, resetPassword, updateProfile, changePassword };
