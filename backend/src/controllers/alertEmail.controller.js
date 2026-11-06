/**
 * alertEmail.controller.js — user-managed email recipients for security alerts.
 *
 * Users add addresses here (Settings / Alerts page) and alertEngine fans out
 * warning/critical alerts to them. `minSeverity` is the per-recipient priority.
 */
const asyncHandler = require('../middleware/asyncHandler');
const { AlertEmail } = require('../models');
const emailService = require('../services/email.service');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normSeverity = (v) => (v === 'critical' ? 'critical' : 'warning');

const CATEGORIES = ['watchlist', 'unknown', 'intrusion', 'weapon', 'fire', 'crowd', 'other'];
// null = ALL categories; a non-empty subset = only those.
function normTypes(v) {
  if (!Array.isArray(v)) return null;
  const clean = [...new Set(v.filter((x) => CATEGORIES.includes(x)))];
  return clean.length ? clean : null;
}

// GET /api/notifications/emails
const list = asyncHandler(async (req, res) => {
  const rows = await AlertEmail.findAll({
    where: { userId: req.user.id },
    order: [['created_at', 'ASC']],
  });
  res.json({ success: true, emails: rows });
});

// POST /api/notifications/emails  { email, label?, minSeverity? }
const add = asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const label = req.body?.label ? String(req.body.label).trim().slice(0, 80) : null;
  const minSeverity = normSeverity(req.body?.minSeverity);
  const eventTypes = normTypes(req.body?.eventTypes);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }
  const [row, created] = await AlertEmail.findOrCreate({
    where: { userId: req.user.id, email },
    defaults: { userId: req.user.id, email, label, minSeverity, eventTypes, disabled: false },
  });
  if (!created) await row.update({ label, minSeverity, eventTypes, disabled: false });
  return res.status(created ? 201 : 200).json({ success: true, email: row });
});

// PATCH /api/notifications/emails/:id  { minSeverity?, disabled?, label? }
const update = asyncHandler(async (req, res) => {
  const row = await AlertEmail.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!row) return res.status(404).json({ success: false, message: 'Recipient not found.' });
  const patch = {};
  if (req.body?.minSeverity) patch.minSeverity = normSeverity(req.body.minSeverity);
  if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
  if (req.body?.label != null) patch.label = String(req.body.label).slice(0, 80);
  if ('eventTypes' in (req.body || {})) patch.eventTypes = normTypes(req.body.eventTypes);
  await row.update(patch);
  res.json({ success: true, email: row });
});

// DELETE /api/notifications/emails/:id
const remove = asyncHandler(async (req, res) => {
  const n = await AlertEmail.destroy({ where: { id: req.params.id, userId: req.user.id } });
  res.json({ success: true, removed: n });
});

// POST /api/notifications/emails/:id/test — send a test alert to verify delivery.
const test = asyncHandler(async (req, res) => {
  const row = await AlertEmail.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!row) return res.status(404).json({ success: false, message: 'Recipient not found.' });
  try {
    await emailService.sendAlertEmail(row.email, {
      title: '✅ Test alert — Drishyam',
      body: 'This is a test alert. If you received this, email alerts are configured correctly.',
      cameraName: 'Test camera',
      severity: 'warning',
      ts: new Date(),
    });
    res.json({ success: true, message: `Test email sent to ${row.email}.` });
  } catch (e) {
    res.status(502).json({ success: false, message: `Email could not be sent: ${e.message}` });
  }
});

module.exports = { list, add, update, remove, test };
