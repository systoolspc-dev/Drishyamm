/**
 * reports.controller.js — the report library.
 *
 *   GET    /api/reports            saved reports (account-wide), newest first
 *   POST   /api/reports            generate and keep one
 *   GET    /api/reports/preview    generate WITHOUT keeping (the live view)
 *   GET    /api/reports/:id        one saved report, with its frozen payload
 *   POST   /api/reports/:id/rerun  same question, fresh answer
 *   DELETE /api/reports/:id        delete
 *   GET    /api/reports/:id/csv    download as CSV (logged)
 *   GET    /api/reports/:id/pdf    download as PDF (logged) — the printed
 *                                  report: summary, event records with
 *                                  stills, high-priority evidence
 *   GET    /api/reports/preview/pdf  the same document for a preview
 *                                  (nothing saved; marked as a preview)
 *
 * Reports belong to the ACCOUNT, not to whoever generated them (same rule as
 * wall layouts), so a manager sees the reports their team produced.
 *
 * A saved report keeps BOTH the question (`params`) and the answer
 * (`payload`). Downloading replays the answer, so a PDF that went to a manager
 * on Monday still says on Friday exactly what it said on Monday. Re-running
 * replays the question against today's data.
 */

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { Report, User } = require('../models');
const reports = require('../services/reports.service');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');

const MAX_SAVED = 500;
const MAX_SPAN_DAYS = 400;

async function accountOwner(req) {
  if (req._owner) return req._owner;
  const user = await User.findByPk(req.user.id, { attributes: ['id', 'parentUserId', 'name'] });
  if (!user) throw new AppError('User not found.', 401);
  req._owner = { id: user.parentUserId || user.id, name: user.name, self: user.id };
  return req._owner;
}

/** Period from either explicit dates or a named range, always a real window. */
function resolvePeriod({ from, to, days }) {
  const end = to ? new Date(to) : new Date();
  if (Number.isNaN(end.getTime())) throw new AppError('Invalid `to` date.', 400);

  let start;
  if (from) {
    start = new Date(from);
    if (Number.isNaN(start.getTime())) throw new AppError('Invalid `from` date.', 400);
  } else {
    const d = Math.max(1, Math.min(Number(days) || 7, MAX_SPAN_DAYS));
    start = new Date(end.getTime() - d * 864e5);
  }
  if (start >= end) throw new AppError('The report period must start before it ends.', 400);
  if ((end - start) / 864e5 > MAX_SPAN_DAYS) {
    throw new AppError(`Reports cover at most ${MAX_SPAN_DAYS} days.`, 400);
  }
  return { from: start, to: end };
}

function parseScope(src = {}) {
  const monitorIds = Array.isArray(src.monitorIds)
    ? src.monitorIds.filter(Boolean).map(String).slice(0, 500)
    : (typeof src.monitorIds === 'string' && src.monitorIds
      ? src.monitorIds.split(',').map((s) => s.trim()).filter(Boolean)
      : null);
  return {
    siteId: src.siteId && src.siteId !== 'all' ? String(src.siteId) : null,
    groupId: src.groupId && src.groupId !== 'all' ? String(src.groupId) : null,
    monitorIds: monitorIds && monitorIds.length ? monitorIds : null,
  };
}

/** Row shape for the library table — never the payload, which is large. */
function toRow(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    typeLabel: reports.TYPE_LABEL[r.type] || r.type,
    from: r.periodFrom,
    to: r.periodTo,
    status: r.status,
    error: r.error,
    schedule: r.schedule,
    createdBy: r.createdByName || 'Unknown',
    createdAt: r.createdAt,
    lastExportedAt: r.lastExportedAt,
    // Enough of a preview for the library row to be useful at a glance.
    summary: r.payload?.summary
      ? {
        // `actionable`, not `alerts` — the row says "needing attention", and
        // `alerts` counts routine face traffic too.
        alerts: r.payload.summary.actionable ?? r.payload.summary.alerts,
        awaitingReview: r.payload.summary.awaitingReview,
        cameras: r.payload.scope?.cameraCount ?? null,
        coverage: r.payload.coverage?.percent ?? null,
      }
      : null,
  };
}

/** A readable default name: "AI Event Report · 12–18 Sep". */
function defaultName(type, from, to) {
  const fmt = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const label = reports.TYPE_LABEL[type] || 'Report';
  const a = fmt(from); const b = fmt(to);
  return `${label} · ${a === b ? a : `${a} – ${b}`}`.slice(0, 160);
}

/* ───────────────────────────────── routes ─────────────────────────────── */

const listReports = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

  const where = { userId: owner.id };
  if (req.query.type && req.query.type !== 'all') where.type = String(req.query.type);
  if (req.query.q) {
    const { Op } = require('sequelize');
    where.name = { [Op.like]: `%${String(req.query.q).slice(0, 80)}%` };
  }

  const { rows, count } = await Report.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset: (page - 1) * limit,
    limit,
  });

  res.json({
    success: true,
    reports: rows.map(toRow),
    total: count,
    page,
    limit,
    types: reports.REPORT_TYPES.map((t) => ({ type: t, label: reports.TYPE_LABEL[t] })),
  });
});

/**
 * Generate without saving. This is what a report type card opens — you look
 * first, and only keep it if it is worth keeping.
 */
const previewReport = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const { from, to } = resolvePeriod(req.query);
  const payload = await reports.buildReport(owner.id, {
    type: req.query.type || 'ai_events',
    from,
    to,
    scope: parseScope(req.query),
  });
  res.json({ success: true, report: payload });
});

/**
 * The printed version of a preview: same question, nothing saved. This is the
 * PDF a report type card leads to before anyone has decided to keep the
 * report, so the type cards never hand out a browser print-out instead of the
 * real document. The file says "Preview — not saved" on its first page.
 */
const exportPreviewPdf = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const type = String(req.query.type || 'ai_events');
  if (!reports.REPORT_TYPES.includes(type)) throw new AppError('Unknown report type.', 400);
  const { from, to } = resolvePeriod(req.query);
  const scope = parseScope(req.query);
  const payload = await reports.buildReport(owner.id, { type, from, to, scope });

  const now = new Date();
  const row = {
    id: null,
    preview: true,
    type,
    name: defaultName(type, from, to),
    periodFrom: from,
    periodTo: to,
    params: { type, from, to, scope, include: {} },
    payload,
    createdByName: owner.name || null,
    createdAt: now,
  };
  const { renderReportPdf } = require('../services/reportPdf');
  const started = Date.now();
  const { pdf, snapshots } = await renderReportPdf({ row, ownerId: owner.id, exportedBy: owner.name });
  logger.info('report.pdf rendered (preview)', { type, bytes: pdf.length, ms: Date.now() - started, snapshots });
  audit('report.exported', {
    req, targetType: 'report', targetId: null,
    meta: { format: 'pdf', preview: true, reportType: type, from, to, bytes: pdf.length },
  });

  const safe = row.name.replace(/[^\w\-. ]+/g, '_').slice(0, 80);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(pdf);
});

const createReport = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const type = String(req.body.type || 'ai_events');
  if (!reports.REPORT_TYPES.includes(type)) throw new AppError('Unknown report type.', 400);

  const { from, to } = resolvePeriod(req.body);
  const scope = parseScope(req.body.scope || req.body);
  const include = req.body.include || {};

  const kept = await Report.count({ where: { userId: owner.id } });
  if (kept >= MAX_SAVED) {
    throw new AppError(`You already have ${MAX_SAVED} saved reports. Delete some first.`, 400);
  }

  const params = { type, from, to, scope, include, schedule: req.body.schedule || null };
  const row = await Report.create({
    userId: owner.id,
    createdBy: owner.self,
    createdByName: owner.name || null,
    name: String(req.body.name || '').trim() || defaultName(type, from, to),
    type,
    periodFrom: from,
    periodTo: to,
    status: 'generating',
    params,
    schedule: req.body.schedule || null,
  });

  // Generation is synchronous — these aggregates are indexed and fast — but the
  // row is written first so a failure leaves a visible 'failed' report rather
  // than a silent nothing.
  try {
    const payload = await reports.buildReport(owner.id, { type, from, to, scope, include });
    await row.update({ payload, status: 'ready', error: null });
  } catch (err) {
    logger.error(`Report generation failed (${row.id}): ${err.message}`);
    await row.update({ status: 'failed', error: String(err.message).slice(0, 500) });
    throw new AppError('Could not generate that report. Try a shorter period.', 500);
  }

  res.status(201).json({ success: true, report: toRow(row), payload: row.payload });
});

const getReport = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const row = await Report.findOne({ where: { id: req.params.id, userId: owner.id } });
  if (!row) throw new AppError('Report not found.', 404);
  res.json({ success: true, report: toRow(row), payload: row.payload });
});

/** Same question, today's data — kept in place so the link does not change. */
const rerunReport = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const row = await Report.findOne({ where: { id: req.params.id, userId: owner.id } });
  if (!row) throw new AppError('Report not found.', 404);

  const p = row.params || {};
  // "Same window, moved to now" — a weekly report re-run next week should
  // cover next week, not re-render the same seven days.
  const span = new Date(row.periodTo) - new Date(row.periodFrom);
  const to = req.body?.slide === false ? new Date(row.periodTo) : new Date();
  const from = new Date(to.getTime() - span);

  await row.update({ status: 'generating' });
  try {
    const payload = await reports.buildReport(owner.id, {
      type: row.type, from, to, scope: p.scope || {}, include: p.include || {},
    });
    await row.update({
      payload, status: 'ready', error: null, periodFrom: from, periodTo: to,
      params: { ...p, from, to },
    });
  } catch (err) {
    await row.update({ status: 'failed', error: String(err.message).slice(0, 500) });
    throw new AppError('Could not re-run that report.', 500);
  }

  res.json({ success: true, report: toRow(row), payload: row.payload });
});

const deleteReport = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const n = await Report.destroy({ where: { id: req.params.id, userId: owner.id } });
  if (!n) throw new AppError('Report not found.', 404);
  res.json({ success: true });
});

/* ───────────────────────────────── CSV ────────────────────────────────── */

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

function payloadToCsv(p, name) {
  const date = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '');
  const rows = [
    [name],
    ['Type', p.typeLabel],
    ['Period', `${date(p.from)} to ${date(p.to)}`],
    ['Generated', date(p.generatedAt)],
    ['Cameras in scope', p.scope?.cameraCount],
    ['Cameras that reported data', `${p.coverage?.reporting} of ${p.coverage?.cameras} (${p.coverage?.percent}%)`],
    [],
    ['Summary'],
    ['Needs attention', p.summary?.actionable],
    ['Needs attention, previous period', p.summary?.actionablePrevious],
    ['Awaiting review', p.summary?.awaitingReview],
    ['All incidents, routine face traffic included', p.summary?.alerts],
    ['Open longer than 24h', p.summary?.openOver24h],
    ['Median response (seconds)', p.summary?.medianSeconds ?? ''],
    ['Known people seen', p.summary?.knownPeople],
    ['Unrecognised sightings', p.summary?.unknownSightings],
    ['Total detections (raw rows)', p.summary?.detections],
    [],
    ['What the cameras saw', 'Count', 'Unit', 'Detections (raw rows)', 'Previous period'],
    ...(p.breakdown || []).map((b) => [b.name, b.primary, b.primaryUnit, b.detections, b.previous]),
    [],
    ['Needs attention', 'Severity', 'Where', 'Camera', 'Times', 'Still open', 'First seen', 'Last seen', 'Detections'],
    ...(p.incidents || []).map((i) => [
      `${(i.subject ? `${i.subject} — ` : '')}${i.eventType}`, i.severity, i.zone || '', i.cameraName,
      i.occurrences, i.openOccurrences, date(i.firstSeen), date(i.lastSeen), i.detections,
    ]),
    [],
    ['Camera', 'Site', 'Detections', 'Alerts', 'Previous period', 'Status now'],
    ...(p.byCamera || []).map((c) => [c.name, c.siteName || '', c.count, c.alerts, c.previous, c.status]),
  ];

  if ((p.people || []).length) {
    rows.push([], ['Person', 'On watchlist', 'Sightings', 'First seen', 'Last seen', 'Cameras'],
      ...p.people.map((x) => [x.name, x.watchlisted ? 'yes' : 'no', x.sightings,
        date(x.firstSeen), date(x.lastSeen), x.cameras.join(' / ')]));
  }
  if ((p.zones || []).length) {
    rows.push([], ['Zone', 'Camera', 'Entries', 'Detections'],
      ...p.zones.map((z) => [z.zone, z.cameraName, z.entries, z.detections]));
  }
  if ((p.coverage?.silent || []).length) {
    rows.push([], ['Cameras with no data in this period — anything there is missing from this report'],
      ...p.coverage.silent.map((c) => [c.name, c.status]));
  }
  return csvRows(rows);
}

const exportCsv = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const row = await Report.findOne({ where: { id: req.params.id, userId: owner.id } });
  if (!row) throw new AppError('Report not found.', 404);
  if (!row.payload) throw new AppError('That report has no data yet.', 409);

  // An export leaves the system, so it goes in the append-only audit trail
  // (who, what, from where) as well as on the row the library shows.
  await row.update({ lastExportedAt: new Date() });
  audit('report.exported', {
    req, targetType: 'report', targetId: row.id,
    meta: { format: 'csv', reportType: row.type, from: row.periodFrom, to: row.periodTo },
  });

  const safe = row.name.replace(/[^\w\-. ]+/g, '_').slice(0, 80);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
  res.send(`﻿${payloadToCsv(row.payload, row.name)}`);
});

/* ───────────────────────────────── PDF ────────────────────────────────── */

/**
 * The printed report. Numbers come from the frozen payload (so the file says
 * what the screen said); the event records and evidence stills are read back
 * for the same period and scope. Rendered fully in memory before any byte is
 * sent, so a failure mid-way is a clean 500 rather than a truncated PDF.
 */
const exportPdf = asyncHandler(async (req, res) => {
  const owner = await accountOwner(req);
  const row = await Report.findOne({ where: { id: req.params.id, userId: owner.id } });
  if (!row) throw new AppError('Report not found.', 404);
  if (!row.payload) throw new AppError('That report has no data yet.', 409);

  const { renderReportPdf } = require('../services/reportPdf');
  const started = Date.now();
  const { pdf, snapshots } = await renderReportPdf({ row, ownerId: owner.id, exportedBy: owner.name });
  logger.info('report.pdf rendered', {
    reportId: row.id, type: row.type, bytes: pdf.length, ms: Date.now() - started, snapshots,
  });

  await row.update({ lastExportedAt: new Date() });
  audit('report.exported', {
    req, targetType: 'report', targetId: row.id,
    meta: { format: 'pdf', reportType: row.type, from: row.periodFrom, to: row.periodTo, bytes: pdf.length },
  });

  const safe = row.name.replace(/[^\w\-. ]+/g, '_').slice(0, 80);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(pdf);
});

module.exports = {
  listReports,
  previewReport,
  createReport,
  getReport,
  rerunReport,
  deleteReport,
  exportCsv,
  exportPdf,
  exportPreviewPdf,
};
