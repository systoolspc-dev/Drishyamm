/**
 * manageRoles.controller.js — custom, account-defined roles.
 * Gated by requireCapability(MANAGE_USERS). Each role is a name + the set of
 * capabilities (features) an admin assigns to it.
 */
const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { Role, User } = require('../models');
const { CAPABILITIES, CAPABILITY_LABELS } = require('../utils/constants');

const VALID_CAPS = Object.values(CAPABILITIES);
const accountId = (req) => (req.dbUser?.parentUserId || req.user.id);

function sanitizeCaps(caps) {
  if (!Array.isArray(caps)) return [];
  return [...new Set(caps.filter((c) => VALID_CAPS.includes(c)))];
}

function shape(r) {
  return { id: r.id, name: r.name, capabilities: r.capabilities || [], builtin: false };
}

// GET /api/manage/roles — the account's custom roles.
const listRoles = asyncHandler(async (req, res) => {
  const roles = await Role.findAll({ where: { userId: accountId(req) }, order: [['name', 'ASC']] });
  res.json({ success: true, data: roles.map(shape) });
});

// GET /api/manage/roles/capabilities — the assignable features (for the editor).
const capabilities = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: VALID_CAPS.map((key) => ({ key, label: CAPABILITY_LABELS[key] || key })),
  });
});

// POST /api/manage/roles — { name, capabilities:[...] }
const createRole = asyncHandler(async (req, res) => {
  const { name, capabilities: caps } = req.body || {};
  if (!name || !name.trim()) throw new AppError('Role name is required.', 400);
  const clean = sanitizeCaps(caps);
  if (!clean.length) throw new AppError('Assign at least one feature to the role.', 400);
  try {
    const role = await Role.create({ userId: accountId(req), name: name.trim(), capabilities: clean });
    res.status(201).json({ success: true, data: shape(role) });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw new AppError('A role with that name already exists.', 409);
    throw err;
  }
});

async function ownedRole(req) {
  const role = await Role.findByPk(req.params.id);
  if (!role || role.userId !== accountId(req)) throw new AppError('Role not found.', 404);
  return role;
}

// PUT /api/manage/roles/:id — { name?, capabilities? }
const updateRole = asyncHandler(async (req, res) => {
  const role = await ownedRole(req);
  const { name, capabilities: caps } = req.body || {};
  if (name !== undefined && name.trim()) role.name = name.trim();
  if (caps !== undefined) {
    const clean = sanitizeCaps(caps);
    if (!clean.length) throw new AppError('Assign at least one feature to the role.', 400);
    role.capabilities = clean;
  }
  await role.save();
  res.json({ success: true, data: shape(role) });
});

// DELETE /api/manage/roles/:id — blocked while users still hold it.
const deleteRole = asyncHandler(async (req, res) => {
  const role = await ownedRole(req);
  const inUse = await User.count({ where: { customRoleId: role.id } });
  if (inUse > 0) throw new AppError(`${inUse} user(s) still use this role. Reassign them first.`, 409);
  await role.destroy();
  res.json({ success: true });
});

module.exports = { listRoles, capabilities, createRole, updateRole, deleteRole };
