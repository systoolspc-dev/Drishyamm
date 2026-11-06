/**
 * manageUsers.controller.js — RBAC user administration (Settings → Manage Users).
 *
 * All routes are gated by requireCapability(MANAGE_USERS) (admins only). Every
 * query is scoped to the caller's ACCOUNT — an admin only ever sees/edits users
 * under their own account owner, never another tenant's.
 */
const { Op } = require('sequelize');
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { User, Site, CameraGroup, Role } = require('../models');
const { ASSIGNABLE_ROLES, ROLE_CAPABILITIES } = require('../utils/constants');
const platformEvents = require('../services/platformEvents.service');

const MIN_PASSWORD = 8;

// The account this admin belongs to (their own id, or their parent's).
const accountId = (req) => (req.dbUser || req.user).accountOwnerId
  ? (req.dbUser || req.user).accountOwnerId()
  : (req.dbUser?.parentUserId || req.user.id);

function normalizeScope(scope) {
  const s = scope || {};
  return {
    siteIds: Array.isArray(s.siteIds) ? s.siteIds.filter(Boolean) : [],
    groupIds: Array.isArray(s.groupIds) ? s.groupIds.filter(Boolean) : [],
  };
}

function shape(u) {
  const j = u.toSafeJSON ? u.toSafeJSON() : u;
  return {
    id: j.id, name: j.name, username: j.username, email: j.email,
    role: j.role, customRoleId: j.customRoleId || null,
    customRoleName: u.customRole ? u.customRole.name : null,
    roleLabel: u.customRole ? u.customRole.name : j.role, // what the UI shows
    scope: j.scope || { siteIds: [], groupIds: [] },
    isActive: j.isActive, isAccountOwner: !j.parentUserId,
    createdAt: j.createdAt,
  };
}

// Resolve the role input: either a built-in tier (`role`) OR a custom role
// (`customRoleId` that belongs to this account). Returns { role, customRoleId }.
async function resolveRole(req, { role, customRoleId }) {
  if (customRoleId) {
    const cr = await Role.findByPk(customRoleId);
    if (!cr || cr.userId !== accountId(req)) throw new AppError('Invalid custom role.', 400);
    return { role: 'viewer', customRoleId }; // built-in kept as a safe base
  }
  if (!ASSIGNABLE_ROLES.includes(role)) throw new AppError('Invalid role.', 400);
  return { role, customRoleId: null };
}

// GET /api/manage/users — the account owner + all their sub-users.
const listUsers = asyncHandler(async (req, res) => {
  const owner = accountId(req);
  const users = await User.findAll({
    where: { [Op.or]: [{ id: owner }, { parentUserId: owner }] },
    include: [{ model: Role, as: 'customRole', required: false }],
    order: [['createdAt', 'ASC']],
  });
  res.json({ success: true, data: users.map(shape) });
});

// GET /api/manage/users/options — roles + the account's Sites/Groups for the scope picker.
const options = asyncHandler(async (req, res) => {
  const owner = accountId(req);
  const [sites, groups, customRoles] = await Promise.all([
    Site.findAll({ where: { userId: owner }, attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    CameraGroup.findAll({ where: { userId: owner }, attributes: ['id', 'name'], order: [['name', 'ASC']] }),
    Role.findAll({ where: { userId: owner }, attributes: ['id', 'name', 'capabilities'], order: [['name', 'ASC']] }),
  ]);
  res.json({
    success: true,
    data: {
      roles: ASSIGNABLE_ROLES.map((r) => ({ value: r, capabilities: ROLE_CAPABILITIES[r] })),
      customRoles: customRoles.map((r) => ({ id: r.id, name: r.name, capabilities: r.capabilities || [] })),
      sites: sites.map((s) => ({ id: s.id, name: s.name })),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    },
  });
});

// POST /api/manage/users — create a sub-user under this account.
const createUser = asyncHandler(async (req, res) => {
  const { name, username, email, password, role, customRoleId, scope } = req.body || {};
  if (!name || !name.trim()) throw new AppError('Name is required.', 400);
  if (!username && !email) throw new AppError('A username or email is required.', 400);
  if (!password || password.length < MIN_PASSWORD) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }
  const resolved = await resolveRole(req, { role, customRoleId });

  try {
    const created = await User.create({
      name: name.trim(),
      username: username ? username.trim() : null,
      email: email ? email.trim() : null,
      password,
      role: resolved.role,
      customRoleId: resolved.customRoleId,
      scope: normalizeScope(scope),
      parentUserId: accountId(req),
      isActive: true,
      emailVerified: true, // admin-provisioned
    });
    // Load the custom role so the response shows its name (not the base tier).
    if (resolved.customRoleId) created.customRole = await Role.findByPk(resolved.customRoleId);
    const roleName = created.customRole ? created.customRole.name : created.role;
    platformEvents.record('member.added', {
      accountId: accountId(req),
      req,
      summary: `Team member added: ${created.name}${created.email || created.username ? ` (${created.email || created.username})` : ''} as ${roleName}`,
      data: { userId: created.id, name: created.name, email: created.email, username: created.username, role: roleName },
    });
    res.status(201).json({ success: true, data: shape(created) });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new AppError('That username or email is already taken.', 409);
    }
    throw err;
  }
});

// Load a user that belongs to this account (else 404 — never leak other tenants).
async function ownedUser(req) {
  const owner = accountId(req);
  const u = await User.findByPk(req.params.id);
  if (!u || (u.id !== owner && u.parentUserId !== owner)) {
    throw new AppError('User not found.', 404);
  }
  return u;
}

// PUT /api/manage/users/:id — update name / role / scope / active.
const updateUser = asyncHandler(async (req, res) => {
  const u = await ownedUser(req);
  const { name, role, customRoleId, scope, isActive } = req.body || {};

  if (!u.parentUserId && (role || customRoleId || isActive === false)) {
    // The account owner can't demote or disable themselves via this endpoint.
    throw new AppError("You can't change the account owner's role or status here.", 400);
  }
  if (role !== undefined || customRoleId !== undefined) {
    const resolved = await resolveRole(req, { role, customRoleId });
    u.role = resolved.role;
    u.customRoleId = resolved.customRoleId;
  }
  if (name !== undefined && name.trim()) u.name = name.trim();
  if (scope !== undefined) u.scope = normalizeScope(scope);
  if (isActive !== undefined) u.isActive = !!isActive;
  await u.save();
  res.json({ success: true, data: shape(u) });
});

// PUT /api/manage/users/:id/password — admin resets a user's password.
const resetPassword = asyncHandler(async (req, res) => {
  const u = await ownedUser(req);
  const { password } = req.body || {};
  if (!password || password.length < MIN_PASSWORD) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }
  u.password = password; // beforeUpdate hook hashes it
  await u.save();
  res.json({ success: true });
});

// DELETE /api/manage/users/:id — soft-delete a sub-user (never the owner or self).
const deleteUser = asyncHandler(async (req, res) => {
  const u = await ownedUser(req);
  if (!u.parentUserId) throw new AppError("The account owner can't be deleted.", 400);
  if (u.id === req.user.id) throw new AppError("You can't delete your own account.", 400);
  await u.destroy(); // paranoid → soft delete
  platformEvents.record('member.removed', {
    accountId: accountId(req),
    req,
    summary: `Team member removed: ${u.name}${u.email || u.username ? ` (${u.email || u.username})` : ''}`,
    data: { userId: u.id, name: u.name, email: u.email, username: u.username },
  });
  res.json({ success: true });
});

module.exports = { listUsers, options, createUser, updateUser, resetPassword, deleteUser };
