/**
 * alertEngine.js — decides whether a persisted AI event becomes a phone alert
 * and/or an email, and delivers it. Called (best-effort) right after an AIEvent
 * is created.
 *
 * Policy (from product decisions 2026-07-09, revised 2026-07-27):
 *   • Only `warning` / `critical` events alert. `info` (routine recognised
 *     faces, footfall ticks) never alerts.
 *   • Non-critical alerts fire 24/7 ("always") — the `afterHours` gate is kept
 *     as a hook for future per-user quiet hours but is a no-op today.
 *
 * Anti-flood algorithm (2026-07-27 — "stop shooting mail continuously"):
 *   The old logic keyed dedup on `matchedName || trackId`. That flooded two
 *   ways: (a) a *different* known person each frame = a fresh subject = a fresh
 *   email; (b) an unknown person's `trackId` changes on every re-detection
 *   (slight movement re-tracks) so dedup never engaged at all. Now:
 *
 *   1. STABLE SUBJECT — dedup by identity, not by track:
 *        watchlist/known → personId or matchedName (stable per person)
 *        unknown         → the single token "unknown" per camera (a stranger
 *                          loitering & re-tracking = ONE alert, not one/frame)
 *   2. PER-IDENTITY COOLDOWN — one alert per (user,cam,category,subject) within
 *        a channel-specific window: push = ALERT_PUSH_COOLDOWN_SEC (90s),
 *        email = ALERT_EMAIL_COOLDOWN_SEC (600s — email is more intrusive so it
 *        re-fires far less often for the same person standing in view).
 *   3. PER-USER BURST CAP — a hard backstop so that "many different people at
 *        once" still can't flood: at most ALERT_EMAIL_MAX_PER_WINDOW emails
 *        per user per ALERT_EMAIL_WINDOW_SEC. Over budget → suppressed (logged),
 *        so 30 recognised staff walking in = a handful of mails, not 30.
 *
 *   The event itself is always persisted + shown in-app; only the push/email
 *   is throttled.
 */
const axios = require('axios');
const { getClient } = require('../config/redis');
const logger = require('../config/logger');
const config = require('../config/env');
const { aiAuthHeader } = require('../utils/aiTenant');
const pushService = require('./push.service');
const emailService = require('./email.service');
const { Camera, AlertEmail } = require('../models');

/**
 * Fetch the detection snapshot (unknown/watchlist face crop) so it can be
 * inlined in the alert email. The crop lives in the AI's MinIO under
 * payload.snapshotUri (s3://vms-snapshots/…); the backend's own S3 is a
 * different store, so we read it back through the AI's snapshot endpoint using
 * the owner's org JWT. Best-effort — a missing/slow crop never blocks the mail.
 */
async function fetchAlertSnapshot(evt) {
  try {
    // Backend-stored crop (zone.intrusion events set snapshotKey on our own S3).
    if (evt?.snapshotKey) {
      try {
        const s3 = require('./s3.service');
        const url = await s3.getPlaybackUrl(evt.snapshotKey, 300);
        if (url) {
          const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 6000, validateStatus: (s) => s < 500 });
          if (data && data.byteLength > 200) return Buffer.from(data);
        }
      } catch { /* fall through */ }
    }
    const uri = evt?.payload?.snapshotUri || evt?.payload?.snapshot_uri || null;
    if (!uri || !String(uri).startsWith('s3://')) return null;
    const { data } = await axios.get(`${config.aiServiceUrl}/journey/snapshot`, {
      params: { uri },
      headers: aiAuthHeader({ id: evt.userId }),
      responseType: 'arraybuffer',
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (!data || data.byteLength < 200) return null; // 4xx bodies / empty
    return Buffer.from(data);
  } catch {
    return null;
  }
}

// Severity rank for the per-recipient email priority gate.
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

const PUSH_SEVERITIES = new Set(['warning', 'critical']);
const COOLDOWN_SEC = parseInt(process.env.ALERT_PUSH_COOLDOWN_SEC || '90', 10);
// Email throttles (email is the channel that was flooding — hold it tighter).
const EMAIL_COOLDOWN_SEC = parseInt(process.env.ALERT_EMAIL_COOLDOWN_SEC || '600', 10);
const EMAIL_WINDOW_SEC = parseInt(process.env.ALERT_EMAIL_WINDOW_SEC || '600', 10);
const EMAIL_MAX_PER_WINDOW = parseInt(process.env.ALERT_EMAIL_MAX_PER_WINDOW || '8', 10);

function isBlacklist(evt) {
  const p = evt.payload || {};
  return p.role === 'blacklist' || evt.eventType === 'person.alert'
    || String(evt.eventType || '').includes('watchlist');
}

function titleFor(evt) {
  const mark = evt.severity === 'critical' ? '🔴' : '⚠️';
  const t = String(evt.eventType || '');
  if (isBlacklist(evt)) return `${mark} Watchlist match`;
  if (t.includes('unknown')) return `${mark} Unknown person`;
  if (t.includes('weapon')) return `${mark} Weapon detected`;
  if (t.includes('fire') || t.includes('smoke')) return `${mark} Fire / smoke`;
  if (t.includes('stampede') || t.includes('crush')) return `${mark} Stampede risk`;
  if (t.includes('crowd') || t.includes('occupancy')) return `${mark} Crowd threshold`;
  if (t.includes('intrusion') || t.includes('zone')) return `${mark} Zone intrusion`;
  return `${mark} Security alert`;
}

function bodyFor(evt, cameraName) {
  const p = evt.payload || {};
  const who = p.matchedName || p.name || null;
  const cam = cameraName || evt.monitorId || 'a camera';
  const t = String(evt.eventType || '');
  if (who && isBlacklist(evt)) return `${who} seen on ${cam}`;
  if (t.includes('unknown')) return `Unrecognised person on ${cam}`;
  if (t.includes('stampede') || t.includes('crush')) {
    const lvl = String(p.level || '').toUpperCase();
    return `Dangerous crowd surge${lvl ? ` (${lvl})` : ''} on ${cam}`;
  }
  if (isBlacklist(evt)) return `Flagged person on ${cam}`;
  return `Detected on ${cam}`;
}

// Classify an event into a recipient-selectable category (mirrors titleFor).
function categoryOf(evt) {
  const t = String(evt.eventType || '');
  if (isBlacklist(evt)) return 'watchlist';
  if (t.includes('unknown')) return 'unknown';
  if (t.includes('weapon')) return 'weapon';
  if (t.includes('fire') || t.includes('smoke')) return 'fire';
  if (t.includes('crowd') || t.includes('occupancy')) return 'crowd';
  if (t.includes('intrusion') || t.includes('zone')) return 'intrusion';
  return 'other';
}

/** Atomic "claim" of a cooldown slot. true = go, false = suppressed. */
async function claimCooldown(key, ttlSec = COOLDOWN_SEC) {
  const client = getClient();
  if (!client) return true; // redis down → fail open (a duplicate beats a miss)
  try {
    const r = await client.set(key, '1', 'EX', ttlSec, 'NX');
    return r === 'OK' || r === true; // ioredis → 'OK' when set, null when blocked
  } catch {
    return true;
  }
}

/** Increment a per-user daily delivery counter so the admin monitor can show
 * REAL "alerts sent" numbers (2-day TTL keeps it self-cleaning). */
async function bumpSent(channel, userId, by = 1) {
  const client = getClient();
  if (!client || !by) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `metrics:alert:${channel}:${userId}:${day}`;
    const n = await client.incrby(key, by);
    if (n === by) await client.expire(key, 172800);
  } catch { /* metrics are best-effort */ }
}

/**
 * Rolling-window rate limiter. Returns true while the caller is within budget
 * for this window, false once the cap is hit. INCR + first-hit EXPIRE so the
 * window slides forward on its own. Fails open if redis is down.
 */
async function withinBurstBudget(key, max, windowSec) {
  const client = getClient();
  if (!client) return true;
  try {
    const n = await client.incr(key);
    if (n === 1) await client.expire(key, windowSec);
    return n <= max;
  } catch {
    return true;
  }
}

/**
 * Stable dedup subject — keyed on *identity*, never on the volatile trackId.
 * A slightly-moving person re-tracks under a new trackId; keying on that made
 * dedup useless. Known/watchlist people key on their name/id; every unknown
 * collapses to a single "unknown" token per camera.
 */
function subjectFor(evt) {
  const p = evt.payload || {};
  const named = p.personId || p.matchedName || p.name;
  if (named && String(named).toLowerCase() !== 'unknown') return `id:${named}`;
  return 'unknown';
}

// ── Persist-path dedup (framework §8 P0-1) ────────────────────────────────────
// subjectFor + maybeAlert throttle push/email but run AFTER the row is written,
// so the Alerts LIST still floods. These helpers let /ai/events fold repeated
// same-identity events into ONE open row. Applied only to warning/critical
// events (the ones that flood the list); info footfall/metric ticks are left
// alone so trend counts stay accurate.
const SPATIAL_CELL_PX = parseInt(process.env.POSITIONAL_DEDUP_CELL_PX || '64', 10);
const EVENT_DEDUP_SEC = parseInt(process.env.AI_EVENT_DEDUP_SEC || '120', 10);

/**
 * Coarse spatial-cell token from a bbox foot-point (framework §2 rung R3). Lets a
 * STATIONARY unknown keep a stable key across re-tracks without the volatile
 * trackId. Returns null when there is no usable bbox.
 */
function spatialCell(bbox, cellPx = SPATIAL_CELL_PX) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x1, y1, x2, y2] = bbox.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const cx = (x1 + x2) / 2;
  const fy = Math.max(y1, y2); // foot-point = bottom edge
  return `cell:${Math.floor(cx / cellPx)}:${Math.floor(fy / cellPx)}`;
}

/**
 * Subject for the PERSIST/LOG path — identity ladder R1 ?? R3 ?? fallback.
 * Differs from subjectFor (alerts) on purpose: the log biases toward completeness
 * (distinct stationary unknowns at different spots stay distinct rows), while the
 * alert channel biases toward silence (all unknowns → one token). A person moving
 * slightly stays in one spatial cell → folds into one row either way.
 */
function persistSubjectFor(evt) {
  const p = evt.payload || {};
  const named = p.personId || p.matchedName || p.name;
  if (named && String(named).toLowerCase() !== 'unknown') return `id:${named}`;
  return spatialCell(evt.bbox) || 'unknown';
}

function eventDedupKey(evt) {
  return `aievent:open:${evt.userId}:${evt.monitorId}:${evt.eventType}:${persistSubjectFor(evt)}`;
}

/**
 * Claim an ai_events "episode" slot. Returns:
 *   { create:true,  key }    → caller inserts a new row, then calls markOpenRow(key,id)
 *   { create:false, rowId }  → caller updates that open row in place (bump count/last-seen)
 * Sliding window: while the same identity keeps appearing, the TTL is refreshed so
 * it stays ONE row; a gap ≥ AI_EVENT_DEDUP_SEC starts a new episode. Fails open
 * (create:true) when Redis is unavailable — a duplicate row beats a miss.
 */
async function claimEventRow(evt, ttlSec = EVENT_DEDUP_SEC) {
  const client = getClient();
  if (!client) return { create: true, key: null };
  const key = eventDedupKey(evt);
  try {
    const won = await client.set(key, 'pending', 'EX', ttlSec, 'NX');
    if (won === 'OK' || won === true) return { create: true, key };
    const rowId = await client.get(key);
    if (!rowId || rowId === 'pending') return { create: true, key: null };
    await client.expire(key, ttlSec); // slide the window while still present
    return { create: false, rowId };
  } catch {
    return { create: true, key: null };
  }
}

/** Record the created row id under the dedup key so later events fold into it. */
async function markOpenRow(key, rowId, ttlSec = EVENT_DEDUP_SEC) {
  if (!key) return;
  const client = getClient();
  if (!client) return;
  try { await client.set(key, String(rowId), 'EX', ttlSec); } catch { /* best-effort */ }
}

/**
 * @param {object} evt  the persisted AIEvent (as JSON — has id, userId,
 *   monitorId, cameraId, eventType, severity, trackId, payload)
 */
async function maybeAlert(evt) {
  try {
    if (!evt || !evt.userId) return;
    if (!PUSH_SEVERITIES.has(evt.severity)) return; // info → no push

    // afterHours hook — currently always-on per product decision. Left here so
    // per-user quiet hours can gate `warning` (never `critical`) later.

    const cat = categoryOf(evt);
    const subject = subjectFor(evt); // stable identity, never trackId
    const base = `${evt.userId}:${evt.monitorId}:${cat}:${subject}`;

    // Per-channel dedup: has this identity already alerted on this camera
    // recently? Push and email keep independent (differently-sized) windows.
    const pushOk = await claimCooldown(`alert:push:${base}`, COOLDOWN_SEC);
    const emailCooldownOk = await claimCooldown(`alert:email:${base}`, EMAIL_COOLDOWN_SEC);
    if (!pushOk && !emailCooldownOk) return; // both channels still cooling down

    let cameraName = null;
    if (evt.cameraId) {
      try {
        const cam = await Camera.findByPk(evt.cameraId, { attributes: ['name'] });
        cameraName = cam?.name || null;
      } catch { /* best-effort */ }
    }
    // Fallback: resolve the readable name by monitorId (zone.intrusion and other
    // events created without a cameraId) so the alert shows "demo-12 - Camera 01"
    // instead of the raw monitor-id hash.
    if (!cameraName && evt.monitorId) {
      try {
        const cam = await Camera.findOne({ where: { monitorId: evt.monitorId }, attributes: ['name'] });
        cameraName = cam?.name || null;
      } catch { /* best-effort */ }
    }

    const title = titleFor(evt);
    const body = bodyFor(evt, cameraName);

    // Account switches (admin console › Account control): Phone alerts and
    // Email alerts. Read through the cached entitlement snapshot; a lookup
    // failure keeps the channel on rather than silently dropping an alert.
    let pushAllowed = true;
    let emailAllowed = true;
    try {
      const { getEntitlements, allowsAny } = require('./entitlements.service');
      const ent = await getEntitlements(evt.userId);
      pushAllowed = allowsAny(ent, ['mobile_app']);
      emailAllowed = allowsAny(ent, ['email_alerts']);
    } catch { /* keep both channels on */ }

    // Channel 1 — mobile push (Expo).
    if (pushOk && pushAllowed) {
      const res = await pushService.notifyUser(evt.userId, {
        title,
        body,
        data: {
          eventId: evt.id,
          monitorId: evt.monitorId,
          cameraId: evt.cameraId,
          type: evt.eventType,
          severity: evt.severity,
        },
      });
      if (res.sent) {
        logger.info('alert push sent', {
          userId: evt.userId, type: evt.eventType, severity: evt.severity, sent: res.sent,
        });
        bumpSent('push', evt.userId, res.sent);
      }
    }

    // Channel 2 — email. Fan out to the user's configured recipients, each
    // gated by its own minSeverity (priority). Best-effort; a send failure
    // never breaks ingest. Two guards keep the inbox sane: the per-identity
    // cooldown above (same person = 1 mail / EMAIL_COOLDOWN_SEC) and a per-user
    // burst cap below (many different people at once still can't flood).
    if (emailCooldownOk && emailAllowed) {
      try {
        const recips = await AlertEmail.findAll({ where: { userId: evt.userId, disabled: false } });
        const rank = SEV_RANK[evt.severity] ?? 0;
        const eligible = recips.filter((r) => {
          if (rank < (SEV_RANK[r.minSeverity] ?? 1)) return false;          // priority gate
          const types = Array.isArray(r.eventTypes) ? r.eventTypes : null;   // category gate
          return !types || types.length === 0 || types.includes('all') || types.includes(cat);
        });
        if (eligible.length) {
          const budgetOk = await withinBurstBudget(
            `alert:email:budget:${evt.userId}`, EMAIL_MAX_PER_WINDOW, EMAIL_WINDOW_SEC,
          );
          if (!budgetOk) {
            logger.warn('alert email burst cap hit — suppressing', {
              userId: evt.userId, cap: EMAIL_MAX_PER_WINDOW, windowSec: EMAIL_WINDOW_SEC, cat, subject,
            });
          } else {
            // Fetch the detection crop ONCE and inline it in every recipient's mail.
            const imageBuffer = await fetchAlertSnapshot(evt);
            await Promise.all(eligible.map((r) =>
              emailService.sendAlertEmail(r.email, { title, body, cameraName, severity: evt.severity, ts: evt.ts, imageBuffer })
                .catch((e) => logger.warn('alert email failed', { to: r.email, error: e.message })),
            ));
            logger.info('alert emails sent', { userId: evt.userId, count: eligible.length, severity: evt.severity, cat, subject });
          bumpSent('email', evt.userId, eligible.length);
          }
        }
      } catch (e) {
        logger.warn('alert email fan-out failed (non-fatal)', { error: e.message });
      }
    }
  } catch (err) {
    logger.warn('alertEngine.maybeAlert failed (non-fatal)', { error: err.message });
  }
}

module.exports = {
  maybeAlert, claimEventRow, markOpenRow, persistSubjectFor, spatialCell, subjectFor, categoryOf,
  // Shared with the report PDF renderer, which embeds the same evidence stills.
  fetchAlertSnapshot,
};
