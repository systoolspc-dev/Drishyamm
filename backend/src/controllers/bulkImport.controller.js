/**
 * bulkImport.controller.js — onboard 2K cameras across many sites at once.
 *
 * Two endpoints:
 *
 *   POST /api/sites/:siteId/import/preview
 *      body: { csv: "<text>" } OR multipart file
 *      response: parsed rows, validation errors, expanded channel preview,
 *                count of rows we'll provision. Does NOT touch DB or Stream Service.
 *
 *   POST /api/sites/:siteId/import/commit
 *      body: { rows: [...validated row objects...], dryRun?: boolean }
 *      response: per-row result (created groupId / cameras, or error).
 *                Idempotent: re-running with the same hosts is safe (existing
 *                groups are returned untouched, not duplicated).
 *
 * CSV columns (case-insensitive, header required):
 *   name, host, port, http_port, username, password, device_type,
 *   total_channels, location, latitude, longitude
 *
 * Most are optional — only `name` and `host` are required. Each CSV row
 * provisions ONE camera-group (NVR/IP device); `total_channels` controls how
 * many camera channels get auto-created under that group.
 *
 * For 2,000 cameras across 30 sites, you'd typically have 30 CSV files
 * (one per site) of ~1-50 NVR rows each. The controller streams large files
 * so 10K-row CSVs work too.
 *
 * The actual Stream Service provisioning happens via the same logic as
 * cameraGroup.controller.createGroup, but in batches with per-row failure
 * isolation so one bad row doesn't kill the whole import.
 */

const multer    = require('multer');
const { v4: uuidv4 } = require('uuid');
const asyncHandler = require('../middleware/asyncHandler');
const AppError     = require('../utils/AppError');
const logger       = require('../config/logger');
const router       = require('../services/streamRouter.service');
const { assertCameraQuota } = require('../services/cameraQuota.service');
const vendors      = require('../services/vendors');
const { Site, CameraGroup, Camera, sequelize } = require('../models');

// 5 MB CSV — enough for 50K rows
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── CSV parsing ──────────────────────────────────────────────────────────────

// Derived from the vendor driver registry (ids + aliases) so adding a driver
// auto-opens bulk import — no second allow-list to keep in sync.
const SUPPORTED_DEVICE_TYPES = new Set(vendors.listAcceptedTypes());

const REQUIRED_HEADERS = ['name', 'host'];
const OPTIONAL_HEADERS = [
  'port', 'http_port', 'username', 'password', 'device_type',
  'total_channels', 'location', 'latitude', 'longitude',
];

/**
 * Tiny CSV parser — handles quoted fields, escaped quotes, BOM, CRLF.
 * Avoids pulling in a dep for ~30 lines of code.
 */
function parseCsv(text) {
  if (!text) return [];
  // Strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let cur = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { buf += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { buf += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cur.push(buf); buf = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { cur.push(buf); rows.push(cur); cur = []; buf = ''; }
      else buf += ch;
    }
  }
  if (buf.length > 0 || cur.length > 0) {
    cur.push(buf);
    rows.push(cur);
  }
  return rows.filter((r) => r.length && r.some((c) => c && c.trim() !== ''));
}

function parseAndValidate(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { headers: [], data: [], errors: ['CSV is empty.'] };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const errors  = [];

  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) errors.push(`Missing required column: ${required}`);
  }
  if (errors.length) return { headers, data: [], errors };

  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => !c || !c.trim())) continue;        // skip blank lines

    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] || '').trim(); });

    const rowErrors = [];
    if (!obj.name) rowErrors.push('name is required');
    if (!obj.host) rowErrors.push('host is required');
    const port           = obj.port ? parseInt(obj.port, 10) : 554;
    const httpPort       = obj.http_port ? parseInt(obj.http_port, 10) : 80;
    const totalChannels  = obj.total_channels ? parseInt(obj.total_channels, 10) : 1;
    if (Number.isNaN(port) || port < 1 || port > 65535) rowErrors.push('invalid port');
    if (Number.isNaN(httpPort)) rowErrors.push('invalid http_port');
    if (Number.isNaN(totalChannels) || totalChannels < 1 || totalChannels > 64) {
      rowErrors.push('total_channels must be 1-64');
    }
    const deviceType = (obj.device_type || 'hikvision').toLowerCase();
    if (!SUPPORTED_DEVICE_TYPES.has(deviceType)) {
      rowErrors.push(`unknown device_type "${deviceType}"`);
    }
    const lat = obj.latitude ? parseFloat(obj.latitude) : null;
    const lng = obj.longitude ? parseFloat(obj.longitude) : null;
    if (obj.latitude && Number.isNaN(lat))   rowErrors.push('invalid latitude');
    if (obj.longitude && Number.isNaN(lng))  rowErrors.push('invalid longitude');

    data.push({
      lineNumber: r + 1,
      name:           obj.name,
      host:           obj.host,
      port,
      httpPort,
      username:       obj.username || null,
      password:       obj.password || null,
      deviceType,
      totalChannels,
      location:       obj.location || null,
      latitude:       lat,
      longitude:      lng,
      errors:         rowErrors,
    });
  }
  return { headers, data, errors };
}

// ── Channel path builder (mirrors cameraGroup.controller) ────────────────────

// Delegates to the per-vendor driver registry (services/vendors) — same source
// of truth as cameraGroup.controller, so the two can no longer drift.
function buildRtspPath(channel, deviceType = 'hikvision') {
  return vendors.buildRtspPath(deviceType, channel);
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Step 1: preview.
 * Accepts a `csv` text body OR an uploaded file. Returns the parsed,
 * validated rows + an "expanded" projection showing exactly what will be
 * created — useful for the UI to show a summary like:
 *   "Will create 12 groups and 96 cameras (4 errors)"
 */
const previewImport = [
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const csvText = req.file ? req.file.buffer.toString('utf8') : (req.body?.csv || '');
    if (!csvText) throw new AppError('Provide either a `csv` text body or a `file` upload.', 400);

    const site = await Site.findOne({ where: { id: req.params.siteId, userId: req.user.id } });
    if (!site) throw new AppError('Site not found.', 404);

    const parsed = parseAndValidate(csvText);

    // Detect duplicates against existing groups (same userId + host) so we can
    // tell the user "this NVR is already configured".
    const hosts = parsed.data.map((r) => r.host).filter(Boolean);
    const existing = hosts.length === 0 ? [] : await CameraGroup.findAll({
      where: { userId: req.user.id, host: hosts },
      attributes: ['id', 'host', 'name', 'siteId', 'totalChannels'],
    });
    const existingByHost = new Map(existing.map((g) => [g.host, g]));

    let willCreate = 0;
    let willSkip   = 0;
    let totalCams  = 0;
    const projected = parsed.data.map((row) => {
      if (row.errors.length) {
        willSkip += 1;
        return { ...row, decision: 'error' };
      }
      const dup = existingByHost.get(row.host);
      if (dup) {
        willSkip += 1;
        return { ...row, decision: 'skip-duplicate', existingGroupId: dup.id };
      }
      willCreate += 1;
      totalCams  += row.totalChannels;
      return { ...row, decision: 'create' };
    });

    res.json({
      success: true,
      site:    { id: site.id, name: site.name },
      summary: {
        rows:        parsed.data.length,
        willCreate,
        willSkip,
        totalCameras: totalCams,
        headerErrors: parsed.errors,
      },
      rows: projected,
    });
  }),
];

/**
 * Step 2: commit.
 * Accepts the rows the UI is happy with (typically the projection from
 * preview, filtered to `decision === 'create'`). Provisions per-row with
 * isolation — a single failure does not abort the whole import.
 *
 * dryRun: true validates again but doesn't write anything.
 */
const commitImport = asyncHandler(async (req, res) => {
  const { rows, dryRun = false } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError('rows array is required.', 400);
  }

  const site = await Site.findOne({ where: { id: req.params.siteId, userId: req.user.id } });
  if (!site) throw new AppError('Site not found.', 404);

  const results = [];
  let groupsCreated  = 0;
  let camerasCreated = 0;
  const importedCams = []; // → ONE live-activity event for the whole import

  for (const row of rows) {
    try {
      // Re-validate at commit time (UI may have drifted from preview)
      if (!row.name || !row.host) {
        results.push({ host: row.host, status: 'error', error: 'name + host required' });
        continue;
      }

      // Skip if already configured for this user
      const existing = await CameraGroup.findOne({
        where: { userId: req.user.id, host: row.host },
        attributes: ['id'],
      });
      if (existing) {
        results.push({ host: row.host, status: 'skipped', groupId: existing.id, reason: 'already-configured' });
        continue;
      }

      if (dryRun) {
        results.push({ host: row.host, status: 'would-create' });
        groupsCreated += 1;
        camerasCreated += (row.totalChannels || 1);
        continue;
      }

      // Enforce the plan camera limit before provisioning this row. Thrown
      // here, it's caught by the per-row catch below and recorded as a row
      // error (partial import), so rows up to the limit still succeed.
      await assertCameraQuota(req.user.id, row.totalChannels || 1);

      // Pick the right Stream Service server BEFORE provisioning so all channels
      // land on the same instance (better cache locality, simpler ops).
      const server = await router.pickServerForSite(site.id);

      const safeGroupName = row.name.toLowerCase().replace(/\s+/g, '-');
      const s3Folder      = `recordings/${req.user.id}/${safeGroupName}`;

      const group = await CameraGroup.create({
        userId:        req.user.id,
        siteId:        site.id,
        name:          row.name,
        host:          row.host,
        port:          row.port || 554,
        httpPort:      row.httpPort || 80,
        username:      row.username || null,
        password:      row.password || null,
        deviceType:    row.deviceType || 'hikvision',
        totalChannels: row.totalChannels || 1,
        location:      row.location || null,
        latitude:      row.latitude  ?? null,
        longitude:     row.longitude ?? null,
        s3Folder,
        status:        'unknown',
      });

      // Build per-channel configs
      const ch       = row.totalChannels || 1;
      const channels = Array.from({ length: ch }, (_, i) => {
        const channel    = i + 1;
        const monitorId  = uuidv4().replace(/-/g, '').slice(0, 24);
        const cameraName = `${row.name} - Camera ${String(channel).padStart(2, '0')}`;
        const rtspPath   = buildRtspPath(channel, row.deviceType);
        const s3Path     = `${s3Folder}/${cameraName.toLowerCase().replace(/\s+/g, '-')}`;
        return { channel, monitorId, cameraName, rtspPath, s3Path };
      });

      // Provision in Stream Service (best-effort — if Stream Service is down, watchdog
      // will re-add later when it's back).
      await Promise.all(channels.map((c) =>
        router.addCamera(
          { monitorId: c.monitorId, mediamtxServerId: server.id },
          { host: row.host, port: row.port, path: c.rtspPath, username: row.username, password: row.password },
          server,
        ).catch((e) => {
          logger.warn('bulkImport: Stream Service add failed (will retry via watchdog)', {
            host: row.host, monitor: c.monitorId, error: e.message,
          });
        })
      ));

      // DB rows for cameras
      const created = await Promise.all(channels.map((c) => Camera.create({
        userId:           req.user.id,
        groupId:          group.id,
        monitorId:        c.monitorId,
        name:             c.cameraName,
        host:             row.host,
        port:             row.port || 554,
        path:             c.rtspPath,
        username:         row.username || null,
        password:         row.password || null,
        channel:          c.channel,
        type:             'h264',
        width:            1920,
        height:           1080,
        fps:              25,
        s3Path:           c.s3Path,
        status:           'offline',
        mediamtxServerId: server.id,
      })));

      // Update server load atomically
      await router.incrementServerLoad(server, ch);

      groupsCreated += 1;
      camerasCreated += created.length;
      importedCams.push(...created.map((c) => ({ name: c.name, groupName: row.name })));

      results.push({
        host: row.host,
        status: 'created',
        groupId: group.id,
        cameras: created.length,
        serverId: server.id,
      });
    } catch (err) {
      logger.error('bulkImport row failed', { host: row.host, error: err.message });
      results.push({ host: row.host, status: 'error', error: err.message });
    }
  }

  if (importedCams.length) {
    require('../services/platformEvents.service').noteCameras('added', { userId: req.user.id, cameras: importedCams });
  }

  res.json({
    success: true,
    dryRun,
    summary: {
      rowsProcessed:  rows.length,
      groupsCreated,
      camerasCreated,
      errors:         results.filter((r) => r.status === 'error').length,
    },
    results,
  });
});

// ── CSV template download ────────────────────────────────────────────────────

const csvTemplate = (req, res) => {
  const headers = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS].join(',');
  const sample = [
    headers,
    'Office NVR,192.168.1.10,554,80,admin,admin,hikvision,16,Mumbai HQ,19.07,72.87',
    'Warehouse NVR,192.168.1.11,554,80,admin,admin,dahua,8,,,,',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="drishyam-cameras-template.csv"');
  res.send(sample);
};

module.exports = {
  previewImport,
  commitImport,
  csvTemplate,
};
