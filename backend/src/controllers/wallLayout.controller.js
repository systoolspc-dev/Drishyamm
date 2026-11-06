/**
 * wallLayout.controller.js — saved Monitor Wall layouts.
 *
 *   GET    /api/wall-layouts        the account's layouts, most recently edited first
 *   GET    /api/wall-layouts/:id    one layout
 *   POST   /api/wall-layouts        create
 *   PUT    /api/wall-layouts/:id    replace
 *   DELETE /api/wall-layouts/:id    delete
 *
 * Layouts belong to the ACCOUNT, not to whoever saved them. The JWT carries
 * only the signed-in user's own id, so the owner (parentUserId || id) is looked
 * up and every read and write is scoped to it. That is what makes the page's
 * "shared with everyone in your organisation" true.
 */

const asyncHandler = require('../middleware/asyncHandler');
const AppError     = require('../utils/AppError');
const { WallLayout, User, Camera } = require('../models');

const MAX_LAYOUTS = 100;

async function accountOwnerId(req) {
  if (req.accountOwnerId) return req.accountOwnerId;
  const user = await User.findByPk(req.user.id, { attributes: ['id', 'parentUserId'] });
  if (!user) throw new AppError('User not found.', 401);
  req.accountOwnerId = user.parentUserId || user.id;
  return req.accountOwnerId;
}

function serialize(l) {
  return {
    id:            l.id,
    name:          l.name,
    cols:          l.cols,
    rows:          l.rows,
    pages:         l.pages,
    rotate:        l.rotate,
    rotateSeconds: l.rotateSeconds,
    skipOffline:   l.skipOffline,
    focusAudio:    l.focusAudio,
    createdBy:     l.createdBy,
    updatedBy:     l.updatedBy,
    createdAt:     l.createdAt,
    updatedAt:     l.updatedAt,
  };
}

// Every filled slot must be a camera this account can see. Cameras are stored
// against the user who added them, so the owner's and the signed-in member's
// own cameras both count. A layout pointing at someone else's camera would
// otherwise leak its name and live stream to this account's wall.
async function assertCamerasVisible(req, owner, pages) {
  const ids = [...new Set(pages.flat().filter(Boolean))];
  if (!ids.length) return;
  const found = await Camera.findAll({
    where: { monitorId: ids, userId: [...new Set([owner, req.user.id])] },
    attributes: ['monitorId'],
    raw: true,
  });
  const known = new Set(found.map((c) => c.monitorId));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    throw new AppError(
      `${missing.length === 1 ? 'A camera in this layout is' : `${missing.length} cameras in this layout are`} not on this account. Remove ${missing.length === 1 ? 'it' : 'them'} and save again.`,
      400,
    );
  }
}

async function load(owner, id) {
  const layout = await WallLayout.findOne({ where: { id, userId: owner } });
  if (!layout) throw new AppError('Layout not found.', 404);
  return layout;
}

function rethrowNameClash(err, name) {
  if (err?.name === 'SequelizeUniqueConstraintError') {
    throw new AppError(`A layout called "${name}" already exists. Pick another name.`, 409);
  }
  throw err;
}

const listLayouts = asyncHandler(async (req, res) => {
  const owner = await accountOwnerId(req);
  const layouts = await WallLayout.findAll({ where: { userId: owner }, order: [['updatedAt', 'DESC']] });
  res.json({ success: true, data: layouts.map(serialize) });
});

const getLayout = asyncHandler(async (req, res) => {
  const owner = await accountOwnerId(req);
  res.json({ success: true, data: serialize(await load(owner, req.params.id)) });
});

const createLayout = asyncHandler(async (req, res) => {
  const owner = await accountOwnerId(req);
  if (await WallLayout.count({ where: { userId: owner } }) >= MAX_LAYOUTS) {
    throw new AppError(`An account can keep up to ${MAX_LAYOUTS} layouts. Delete one to save another.`, 409);
  }
  await assertCamerasVisible(req, owner, req.body.pages);
  let layout;
  try {
    layout = await WallLayout.create({ ...req.body, userId: owner, createdBy: req.user.id, updatedBy: req.user.id });
  } catch (err) {
    rethrowNameClash(err, req.body.name);
  }
  res.status(201).json({ success: true, data: serialize(layout) });
});

const updateLayout = asyncHandler(async (req, res) => {
  const owner = await accountOwnerId(req);
  const layout = await load(owner, req.params.id);
  await assertCamerasVisible(req, owner, req.body.pages);
  try {
    await layout.update({ ...req.body, updatedBy: req.user.id });
  } catch (err) {
    rethrowNameClash(err, req.body.name);
  }
  res.json({ success: true, data: serialize(layout) });
});

const deleteLayout = asyncHandler(async (req, res) => {
  const owner = await accountOwnerId(req);
  const layout = await load(owner, req.params.id);
  await layout.destroy();
  res.json({ success: true, data: { id: layout.id } });
});

module.exports = { listLayouts, getLayout, createLayout, updateLayout, deleteLayout };
