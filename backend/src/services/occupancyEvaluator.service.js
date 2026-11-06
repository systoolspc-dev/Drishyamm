/**
 * occupancyEvaluator.service — the room-level capacity state machine (use case A1).
 *
 * Every 10s it fuses each space's cameras into one number and decides whether
 * that room is in breach. Unlike the old per-camera check this:
 *   • alerts ONCE per room, not once per camera;
 *   • pairs every breach with a CLEAR, and records both as one incident row,
 *     which is what makes "42 min over capacity across 6 breaches in July"
 *     provable instead of a guess;
 *   • keeps its state in the DB (occupancy_incidents), so a backend restart
 *     mid-breach neither re-alerts nor loses the pairing;
 *   • refuses to clear on a count it cannot trust — a blind camera must never
 *     look like "the room emptied" (docs/OCCUPANCY_LOGIC.md §2.2).
 *
 * Hysteresis (doctrine M1/M2): breach needs `confirmSec` above capacity; clear
 * needs `clearSec` at or below capacity − margin. Asymmetric on purpose.
 */
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize, Space, SpaceCamera, AIEvent } = require('../models');
const { getClient } = require('../config/redis');
const { emit, EVENTS } = require('../events/bus');
const alertEngine = require('./alertEngine');
const logger = require('../config/logger');
const { fuseSpace } = require('./occupancy/fuse');
const { canBreach, canClear } = require('./occupancy/quality');

const TICK_MS = parseInt(process.env.OCCUPANCY_EVAL_MS || '10000', 10);

const DEFAULTS = {
  warnPct: 0.85,      // "act before the breach" tier
  confirmSec: 60,     // sustained above capacity before alerting
  clearSec: 60,       // sustained below (capacity − margin) before clearing
  clearMargin: 2,     // deadband so 49↔51 at cap 50 doesn't flap
  cooldownSec: 900,
};

let timer = null;
// In-memory edge timers only. The AUTHORITATIVE state is the incidents table,
// so a restart resumes correctly rather than re-alerting.
const pending = new Map();   // spaceId -> { aboveSince, belowSince, warnedAt }

const settingsOf = (space) => ({ ...DEFAULTS, ...(space.settings || {}) });

/** Is the space inside its operating window? NULL hours ⇒ always armed. */
function isArmed(space, now = new Date()) {
  const oh = space.operatingHours;
  if (!oh || !Array.isArray(oh.week) || oh.week.length === 0) return true;
  try {
    const tz = oh.tz || 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dowMap[get('weekday')];
    const hhmm = `${get('hour')}:${get('minute')}`;
    const today = oh.week.find((w) => Number(w.dow) === dow);
    if (!today) return false;
    return hhmm >= String(today.open) && hhmm <= String(today.close);
  } catch { return true; }   // never let a TZ bug suppress a safety alert
}

/** Latest per-camera sample straight from the live gauges. */
async function readSamples(monitorIds) {
  const redis = getClient();
  if (!redis || monitorIds.length === 0) return {};
  const out = {};
  try {
    const vals = await redis.mget(monitorIds.map((m) => `occupancy:live:${m}`));
    monitorIds.forEach((m, i) => {
      if (!vals[i]) return;
      try {
        const g = JSON.parse(vals[i]);
        out[m] = {
          heads: g.heads,
          connected: g.connected,
          // The gauge already carries the verdict; a NULL count means unknown.
          reliable: g.quality === 'measured',
          ageSec: g.ts ? (Date.now() - g.ts) / 1000 : null,
          degraded: g.degraded,
        };
      } catch { /* skip malformed */ }
    });
  } catch { /* redis down → no samples → everything reads unknown, which is honest */ }
  return out;
}

async function openIncident(space, count) {
  const id = crypto.randomUUID();
  await sequelize.query(
    `INSERT INTO occupancy_incidents
       (id, space_id, user_id, started_at, capacity, peak_count, over_cap_sec, status, created_at, updated_at)
     VALUES (:id, :spaceId, :userId, NOW(), :capacity, :peak, 0, 'open', NOW(), NOW())`,
    { replacements: { id, spaceId: space.id, userId: space.userId,
                      capacity: space.capacity, peak: count }, type: QueryTypes.INSERT },
  );
  return id;
}

async function findOpenIncident(spaceId) {
  const rows = await sequelize.query(
    `SELECT id, started_at, peak_count FROM occupancy_incidents
      WHERE space_id = :spaceId AND status = 'open' ORDER BY started_at DESC LIMIT 1`,
    { replacements: { spaceId }, type: QueryTypes.SELECT },
  );
  return rows[0] || null;
}

/**
 * Emit one room-level occupancy event.
 *
 * Three distinct kinds — a CLEAR must never be published as a critical
 * "over capacity" alert, or emptying a room would page the operator.
 */
const EVENT_KINDS = {
  threshold: {
    eventType: 'occupancy.threshold', severity: 'critical',
    text: (s, n) => `${s.name}: ${n} people — over capacity (${s.capacity})`,
  },
  warning: {
    eventType: 'occupancy.warning', severity: 'warning',
    text: (s, n) => `${s.name}: ${n}/${s.capacity} — approaching capacity`,
  },
  cleared: {
    eventType: 'occupancy.cleared', severity: 'info',
    text: (s, n) => `${s.name}: back under capacity (${n}/${s.capacity})`,
  },
};

async function raise(space, count, quality, kind = 'threshold') {
  const spec = EVENT_KINDS[kind] || EVENT_KINDS.threshold;
  const row = await AIEvent.create({
    userId: space.userId,
    cameraId: null,
    monitorId: space.primaryMonitorId || null,
    eventType: spec.eventType,
    severity: spec.severity,
    ts: new Date(),
    payload: {
      spaceId: space.id, spaceName: space.name,
      count, capacity: space.capacity, quality, source: 'occupancy-evaluator',
      // Dedup subject = the ROOM, so N cameras can't produce N alerts.
      personId: `space:${space.id}`,
      matchedName: spec.text(space, count),
    },
  });
  const pushed = row.toJSON();
  emit(EVENTS.AI_EVENT_DETECTED, { event: pushed, userId: space.userId });
  alertEngine.maybeAlert(pushed).catch(() => {});
  return pushed;
}

async function evaluateSpace(space, members) {
  const monitorIds = members.map((m) => m.monitorId);
  const samples = await readSamples(monitorIds);
  const fused = fuseSpace(members, samples);
  const cfg = settingsOf(space);
  const cap = Number(space.capacity) || 0;
  const now = Date.now();

  const st = pending.get(space.id) || { aboveSince: null, belowSince: null, warnedAt: 0 };
  const open = await findOpenIncident(space.id);

  // No capacity configured, or nothing trustworthy to judge → do nothing.
  // Critically: an unknown count NEVER clears an open incident.
  if (cap <= 0 || fused.count === null) {
    pending.set(space.id, { ...st, aboveSince: null });
    return { space: space.name, count: fused.count, quality: fused.quality, action: 'skip' };
  }

  const over = fused.count >= cap;
  const under = fused.count <= cap - (Number(cfg.clearMargin) || 0);
  let action = 'none';

  if (over && !open) {
    st.belowSince = null;
    st.aboveSince = st.aboveSince || now;
    const heldSec = (now - st.aboveSince) / 1000;
    if (heldSec >= cfg.confirmSec && canBreach(fused.quality) && isArmed(space)) {
      await openIncident(space, fused.count);
      await raise(space, fused.count, fused.quality, 'threshold');
      logger.warn('OCCUPANCY breach', { space: space.name, count: fused.count, cap });
      action = 'breach';
    }
  } else if (!over) {
    st.aboveSince = null;
    if (open) {
      // Only a count we can TRUST may end an incident.
      if (under && canClear(fused.quality)) {
        st.belowSince = st.belowSince || now;
        if ((now - st.belowSince) / 1000 >= cfg.clearSec) {
          await sequelize.query(
            `UPDATE occupancy_incidents
                SET status='cleared', ended_at=NOW(),
                    over_cap_sec = TIMESTAMPDIFF(SECOND, started_at, NOW()),
                    updated_at=NOW()
              WHERE id = :id`,
            { replacements: { id: open.id }, type: QueryTypes.UPDATE },
          );
          await raise({ ...space, capacity: cap }, fused.count, fused.quality, 'cleared')
            .catch(() => {});
          logger.info('OCCUPANCY cleared', { space: space.name, count: fused.count });
          st.belowSince = null;
          action = 'clear';
        }
      } else {
        st.belowSince = null;   // untrustworthy or still in the deadband
      }
    } else if (cfg.warnPct > 0 && fused.count >= Math.ceil(cap * cfg.warnPct)
               && canBreach(fused.quality) && isArmed(space)
               && (now - st.warnedAt) / 1000 >= cfg.cooldownSec) {
      // The actionable tier: act BEFORE the room is over capacity.
      await raise(space, fused.count, fused.quality, 'warning');
      st.warnedAt = now;
      action = 'warn';
    }
  }

  // Keep the incident's peak honest while it's open.
  if (open && fused.count > (open.peak_count ?? 0)) {
    await sequelize.query(
      'UPDATE occupancy_incidents SET peak_count = :peak, updated_at = NOW() WHERE id = :id',
      { replacements: { peak: fused.count, id: open.id }, type: QueryTypes.UPDATE },
    ).catch(() => {});
  }

  pending.set(space.id, st);
  return { space: space.name, count: fused.count, quality: fused.quality,
           coveragePct: fused.coveragePct, action };
}

async function tick() {
  const redis = getClient();
  if (redis) {   // single evaluator across replicas
    try {
      const got = await redis.set('occ:leader:evaluator', process.pid, 'EX', 30, 'NX');
      if (got !== 'OK' && got !== true) return [];
    } catch { /* fail open */ }
  }
  try {
    const spaces = await Space.findAll({ where: { enabled: true } });
    if (spaces.length === 0) return [];
    const memberRows = await SpaceCamera.findAll({
      where: { spaceId: spaces.map((s) => s.id) },
    });
    const bySpace = new Map();
    memberRows.forEach((m) => {
      if (!bySpace.has(m.spaceId)) bySpace.set(m.spaceId, []);
      bySpace.get(m.spaceId).push(m.get({ plain: true }));
    });
    const out = [];
    for (const s of spaces) {
      try {
        out.push(await evaluateSpace(s.get({ plain: true }), bySpace.get(s.id) || []));
      } catch (e) {
        logger.warn('occupancy evaluate failed', { space: s.name, error: e.message });
      }
    }
    return out;
  } catch (e) {
    logger.warn('occupancy evaluator tick failed', { error: e.message });
    return [];
  } finally {
    if (redis) await redis.del('occ:leader:evaluator').catch(() => {});
  }
}

function start() {
  stop();
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref && timer.unref();
  logger.info('occupancy evaluator started', { tickMs: TICK_MS });
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, evaluateSpace, isArmed, _internals: { pending, DEFAULTS } };
