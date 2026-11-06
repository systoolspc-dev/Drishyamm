/**
 * internal.routes.js — service-to-service endpoints.
 *
 * Mounted at /api/internal/* with:
 *   - serviceAuth middleware  (X-Service-Token / Bearer)
 *   - large JSON body limit   (event payloads with bbox arrays + thumbnails)
 *   - NO user rate limiter    (AI workers can burst during incidents)
 */

const { Router } = require('express');
const express    = require('express');
const serviceAuth = require('../middleware/serviceAuth');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('../config/logger');
const { emit, EVENTS } = require('../events/bus');
const { AIEvent, Camera } = require('../models');
const s3Service = require('../services/s3.service');
const streamingService = require('../services/drishyamStreaming.service');
const alertEngine = require('../services/alertEngine');
const { getClient } = require('../config/redis');
const { createOccupancyTracker } = require('../services/occupancyHysteresis');
const { cameraQuality, isUsable } = require('../services/occupancy/quality');
const config = require('../config/env');

const router = Router();

// Large JSON limit just for this router (default app uses 10kb).
router.use(express.json({ limit: '2mb' }));

// ── Stampede / crowd-crush alert webhook (BEFORE serviceAuth) ─────────────────
// The stempade detector service POSTs plain JSON `{camera, level, score}` on a
// rising edge into HIGH/CRITICAL. It can't set an X-Service-Token header, so we
// authenticate via a `?token=` shared secret instead. Maps the camera NAME to a
// VMS camera, records a crowd.stampede AIEvent, and fans it out to the operator
// (live toast) + the alert engine (email/push).
router.post('/stampede-alert', asyncHandler(async (req, res) => {
  const secret = (config.serviceToken || '').trim();
  if (secret && req.query.token !== secret) return res.status(401).json({ ok: false, error: 'bad token' });

  const { camera, level, score, time_s: timeS } = req.body || {};
  if (!camera || !level) return res.status(400).json({ ok: false, error: 'camera + level required' });

  const cam = await Camera.findOne({ where: { name: camera }, attributes: ['id', 'userId', 'monitorId', 'name'] });
  if (!cam) { logger.warn('stampede alert: unknown camera', { camera }); return res.json({ ok: true, skipped: 'unknown camera' }); }

  const severity = String(level).toUpperCase() === 'CRITICAL' ? 'critical' : 'warning';
  const row = await AIEvent.create({
    userId: cam.userId, cameraId: cam.id, monitorId: cam.monitorId,
    eventType: 'crowd.stampede', severity, ts: new Date(),
    confidence: Number(score) || null,
    payload: { detector: 'stampede', level: String(level), score: Number(score) || null, time_s: timeS ?? null, camera_name: cam.name },
  });
  const pushed = row.toJSON();
  emit(EVENTS.AI_EVENT_DETECTED, { event: pushed, userId: cam.userId });
  alertEngine.maybeAlert(pushed).catch(() => {});
  logger.warn('STAMPEDE alert', { camera: cam.name, level, severity, score });
  res.json({ ok: true, id: row.id });
}));

// All routes below require the service token.
router.use(serviceAuth);

// ── Health (lets AI worker probe whether the backend is up + token is valid) ──
router.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── AI event ingest ──────────────────────────────────────────────────────────
//
// Body (smart-cam-ai EventDispatcher):
//   {
//     userId, monitorId, cameraId?, eventType, severity, ts,
//     bbox?:[x1,y1,x2,y2], trackId?, confidence?, payload?, snapshot?:base64
//   }
router.post('/ai/events', asyncHandler(async (req, res) => {
  const evt = req.body || {};

  if (!evt.userId || !evt.monitorId || !evt.eventType) {
    return res.status(400).json({ ok: false, error: 'userId, monitorId, eventType required' });
  }

  // Resolve cameraId if the worker didn't supply one (the cameras endpoint
  // does, but defending against drift)
  let cameraId = evt.cameraId || null;
  if (!cameraId) {
    const cam = await Camera.findOne({
      where: { userId: evt.userId, monitorId: evt.monitorId },
      attributes: ['id'],
    });
    cameraId = cam?.id || null;
  }

  // ── Persist-path dedup (framework §8 P0-1) ──────────────────────────────────
  // Fold repeated same-identity events into ONE open ai_events row instead of
  // inserting one per detection, so the Alerts LIST matches the (already-deduped)
  // notifications. Keyed on the identity ladder (personId ?? spatial-cell), never
  // the volatile trackId. Only warning/critical events are folded — info footfall
  // / metric ticks pass straight through so trend counts stay accurate. A new
  // episode (or Redis down) inserts as before.
  const dedupable = evt.severity === 'warning' || evt.severity === 'critical';
  let slot = { create: true, key: null };
  if (dedupable) {
    slot = await alertEngine.claimEventRow({
      userId: evt.userId, monitorId: evt.monitorId, eventType: evt.eventType,
      payload: evt.payload, bbox: evt.bbox,
    });
    if (!slot.create && slot.rowId) {
      try {
        const open = await AIEvent.findByPk(slot.rowId);
        if (open) {
          const payload = { ...(open.payload || {}) };
          payload.count = (Number(payload.count) || 1) + 1;
          payload.lastSeenTs = new Date().toISOString();
          await open.update({ payload, confidence: evt.confidence ?? open.confidence });
          return res.status(202).json({ ok: true, id: open.id, deduped: true });
        }
        // open row vanished (retention purge) → fall through and insert fresh
      } catch (e) {
        logger.warn('ai event dedup-update failed, inserting new row', { error: e.message });
      }
    }
  }

  // Upload snapshot to S3 first (best-effort — never fail ingest if S3 hiccups)
  let snapshotKey = null;
  if (evt.snapshot) {
    try {
      const buf = Buffer.from(evt.snapshot, 'base64');
      const ts  = new Date(evt.ts || Date.now()).toISOString().replace(/[:.]/g, '-');
      snapshotKey = `ai/events/${evt.userId}/${evt.monitorId}/${ts}.jpg`;
      await s3Service.putObject(snapshotKey, buf, 'image/jpeg');
    } catch (err) {
      logger.warn('snapshot upload failed (non-fatal)', { error: err.message });
      snapshotKey = null;
    }
  }

  const row = await AIEvent.create({
    userId:     evt.userId,
    cameraId,
    monitorId:  evt.monitorId,
    eventType:  evt.eventType,
    severity:   evt.severity || 'info',
    ts:         evt.ts ? new Date(evt.ts) : new Date(),
    bbox:       evt.bbox || null,
    trackId:    evt.trackId || null,
    confidence: evt.confidence ?? null,
    payload:    evt.payload || null,
    snapshotKey,
  });

  // Register this row as the open episode so subsequent detections fold into it.
  if (dedupable) await alertEngine.markOpenRow(slot.key, row.id);

  const pushed = row.toJSON();
  // Don't ship the snapshot bytes back — frontend fetches a signed URL on demand
  delete pushed.snapshot;

  // Fanout to in-process subscribers — ws.service forwards to that user's room
  emit(EVENTS.AI_EVENT_DETECTED, { event: pushed, userId: evt.userId });

  // Best-effort mobile push for meaningful events (warning/critical, deduped).
  // Never block or fail ingest on push problems.
  alertEngine.maybeAlert(pushed).catch(() => {});

  res.status(202).json({ ok: true, id: row.id });
}));

// ── AI occupancy ingest (head-count service) ──────────────────────────────────
//
// The head-count service POSTs live per-camera head counts here. We (a) keep a
// short-lived Redis gauge the headcount page reads, and (b) raise a debounced
// occupancy-threshold alert when a camera goes over capacity (framework §6 row g
// / P0-3: K-of-N confirm + N/(N−margin) deadband — no flapping at the threshold).
const OCC_GAUGE_TTL_SEC   = parseInt(process.env.OCCUPANCY_GAUGE_TTL_SEC || '30', 10);
const OCC_ALERT_THRESHOLD = parseInt(process.env.OCCUPANCY_ALERT_THRESHOLD || '0', 10); // 0 = off (global default)
const occupancyTracker = createOccupancyTracker({
  confirmPolls: parseInt(process.env.OCCUPANCY_CONFIRM_POLLS || '3', 10),
  clearMargin:  parseInt(process.env.OCCUPANCY_CLEAR_MARGIN || '5', 10),
});

router.post('/ai/occupancy', asyncHandler(async (req, res) => {
  const streams = Array.isArray(req.body?.streams) ? req.body.streams : [];
  const redis = getClient();
  let stored = 0;

  for (const s of streams) {
    const monitorId = String(s.monitorId || s.monitor_id || '').trim();
    if (!monitorId) continue;
    const heads = Math.max(0, Math.round(Number(s.heads) || 0));
    const connected = s.connected !== false;

    const cam = await Camera.findOne({
      where: { monitorId }, attributes: ['id', 'userId', 'name', 'settings'],
    });
    if (!cam) continue;
    stored += 1;

    // Is this number trustworthy? A dead/stale camera must NOT be recorded as
    // an empty room — see services/occupancy/quality.js.
    const quality = cameraQuality({
      heads, connected, reliable: s.reliable, ageSec: s.ageSec,
    });
    const usable = isUsable(quality);

    // (a) live gauge for the headcount page — short TTL so it auto-clears when
    //     the head-count service stops forwarding. Carries `quality` so the UI
    //     can show "unknown" instead of a confident 0.
    if (redis) {
      try {
        await redis.set(`occupancy:live:${monitorId}`,
          JSON.stringify({
            heads: usable ? heads : null, quality, connected,
            degraded: s.degraded === true, ts: Date.now(),
          }), 'EX', OCC_GAUGE_TTL_SEC);
      } catch { /* best-effort */ }
    }

    // (a2) minute accumulator — the raw material for occupancy_camera_minute.
    // A Redis hash per (camera, minute); the aggregator flushes it to MySQL.
    // Only MEASURED samples contribute to the count fields, so a blind minute
    // lands as quality='unknown' with NULL counts rather than a fake zero.
    if (redis) {
      try {
        const minute = Math.floor(Date.now() / 60000) * 60000;
        const key = `occ:acc:${cam.id}:${minute}`;
        const p = redis.pipeline ? redis.pipeline() : null;
        const bump = (f, v) => (p ? p.hincrby(key, f, v) : redis.hincrby(key, f, v));
        bump('samples', 1);
        // ALWAYS stamp the tenant — a minute where the camera was blind the whole
        // time must still be written (as quality='unknown'), not dropped.
        if (p) p.hset(key, 'user_id', cam.userId, 'monitor_id', monitorId);
        else await redis.hset(key, 'user_id', cam.userId, 'monitor_id', monitorId);
        if (usable) {
          bump('samples_measured', 1);
          bump('sum', heads);
          // peak/min need compare-and-set; done after the pipeline resolves.
        }
        if (s.degraded === true) bump('degraded', 1);
        if (p) {
          p.expire(key, 240);   // survive the 60s flush + retries, then vanish
          await p.exec();
        } else {
          await redis.expire(key, 240);
        }
        if (usable) {
          const [pk, mn] = await Promise.all([
            redis.hget(key, 'peak'), redis.hget(key, 'min'),
          ]);
          if (pk === null || heads > Number(pk)) await redis.hset(key, 'peak', heads);
          if (mn === null || heads < Number(mn)) await redis.hset(key, 'min', heads);
        }
      } catch { /* accumulation is best-effort; never break ingest */ }
    }

    // (b) camera-level occupancy-threshold alert. Threshold is per-camera
    //     (settings.headcount.threshold) or the global default; 0 disables it.
    //     Only a trustworthy count may move the alert state machine — a stale
    //     or offline camera must neither raise nor clear a breach.
    const threshold = Number(cam.settings?.headcount?.threshold) || OCC_ALERT_THRESHOLD;
    if (threshold > 0 && usable) {
      if (occupancyTracker.update(monitorId, heads, threshold) === 'breach') {
        try {
          const row = await AIEvent.create({
            userId: cam.userId, cameraId: cam.id, monitorId,
            eventType: 'occupancy.threshold', severity: 'warning', ts: new Date(),
            confidence: null,
            payload: {
              count: heads, capacity: threshold, source: 'head-count',
              personId: `cam:${monitorId}`,             // dedup subject = the camera
              matchedName: `${heads} people (limit ${threshold})`,
              cameraName: cam.name,
            },
          });
          const pushed = row.toJSON();
          emit(EVENTS.AI_EVENT_DETECTED, { event: pushed, userId: cam.userId });
          alertEngine.maybeAlert(pushed).catch(() => {});
          logger.warn('OCCUPANCY over threshold', { monitorId, heads, cap: threshold });
        } catch (e) {
          logger.warn('occupancy alert failed (non-fatal)', { error: e.message });
        }
      }
    } else if (threshold <= 0) {
      occupancyTracker.reset(monitorId);
    }
  }

  res.json({ ok: true, stored });
}));

// ── AI live overlay (ephemeral — bounding boxes only) ─────────────────────────
//
// High-frequency, display-only frames that drive the on-video AIOverlay. Unlike
// /ai/events these are NEVER persisted and NEVER become alerts — they're fanned
// straight out to the viewing user's socket and dropped. This is what stops the
// "continuous alerts" flood: routine face boxes ride this channel, not ai_events.
//
// Body (smart-cam-ai backend_forwarder, one message per camera frame):
//   { userId, monitorId, ts?, frameW, frameH,
//     boxes: [ { bbox:[x1,y1,x2,y2], trackId?, name?, gender?, age?, conf? } ] }
// ── Live-overlay viewers ─────────────────────────────────────────────────────
// Which cameras have at least one browser drawing the AI overlay right now.
// The AI's forwarder polls this every couple of seconds: cameras nobody is
// watching get their boxes published at a 1 Hz keep-alive instead of 5 Hz and
// no overlay POST at all — measured at ~1.2 cores on the AI primary at 37
// cameras, all of it for pictures nobody was looking at.
router.get('/ai/viewers', (_req, res) => {
  const { getWatchedMonitors } = require('../services/ws.service');
  res.json({ ok: true, monitorIds: getWatchedMonitors() });
});

router.post('/ai/overlay', (req, res) => {
  const f = req.body || {};
  if (!f.userId || !f.monitorId) {
    return res.status(400).json({ ok: false, error: 'userId, monitorId required' });
  }
  const boxes = Array.isArray(f.boxes) ? f.boxes : [];
  emit(EVENTS.AI_LIVE_OVERLAY, {
    userId: f.userId,
    frame: {
      monitorId: f.monitorId,
      ts:        f.ts || Date.now(),
      frameW:    f.frameW || 0,
      frameH:    f.frameH || 0,
      boxes,
    },
  });
  res.status(202).json({ ok: true });
});

// ── Camera registry (read-only for the AI worker) ────────────────────────────
// Returns the list of cameras + their RTSP egress URLs in Stream Service so the
// worker knows what to subscribe to.
router.get('/cameras', asyncHandler(async (_req, res) => {
  const cameras = await Camera.findAll({
    attributes: ['id', 'userId', 'monitorId', 'name', 'path', 'status', 'settings'],
  });

  const data = cameras.map((c) => ({
    id:        c.id,
    userId:    c.userId,
    monitorId: c.monitorId,
    name:      c.name,
    status:    c.status,
    settings:  c.settings,
    rtsp:      streamingService.getRtspEgressUrl(c.monitorId, false),
    rtspSub:   streamingService.deriveSubPath(c.path)
                 ? streamingService.getRtspEgressUrl(c.monitorId, true)
                 : null,
  }));

  res.json({ ok: true, cameras: data });
}));

module.exports = router;
