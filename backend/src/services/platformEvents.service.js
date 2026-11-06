/**
 * platformEvents.service — the admin console's live platform activity.
 *
 *   record(type, { severity, accountId, actor, req, summary, data })
 *     → insert into platform_events, emit on the in-process bus, push to the
 *       'platform-ops' socket room (platform operators only). Fire-and-forget:
 *       it never throws into the caller; a failed insert is logged and the
 *       event is still pushed live.
 *
 * Decisions that need more than one signal live here too, so hooks stay
 * one-liners:
 *   - noteCameras()          bulk adds/removes → ONE event per account per burst
 *   - camera status          supervisor transitions → cameraStatusCoalescer →
 *                            one batch per account per 60 s → camera.offline /
 *                            nvr.down / *.recovered (never one event per flap)
 *   - noteLoginFailure()     ≥5 failures for one identifier in 10 min → one
 *                            warning, then quiet for 10 min
 *   - service monitor        DB / Redis / stream service / AI engine health,
 *                            2 checks in a row to change state
 *   - platform.counters      accounts / signups today / cameras online, pushed
 *                            at most every 5 s and only when they changed and an
 *                            operator is connected
 *
 * Types and categories: services/platformEvents/catalog.js.
 */
const logger = require('../config/logger');
const { on, emit, EVENTS } = require('../events/bus');
const { TYPE_CATEGORY, planLabel, plural, nameList } = require('./platformEvents/catalog');
const { createCameraStatusCoalescer } = require('./platformEvents/cameraStatusCoalescer');

const PLATFORM_EVENT = 'platform.event'; // bus + socket event name
const COUNTERS_EVENT = 'platform.counters';
const COUNTERS_MIN_MS = 5000;
const CAMERA_BURST_MS = 3000;            // add/remove coalescing window
const LOGIN_FAIL_WINDOW_MS = 10 * 60_000;
const LOGIN_FAIL_THRESHOLD = 5;
const SERVICE_CHECK_MS = 30_000;

const models = () => require('../models');
const ws = () => require('./ws.service');

/* ───────────────────────── people ───────────────────────── */

const _userCache = new Map(); // id -> { at, user }
const USER_TTL_MS = 60_000;

async function loadUser(id) {
  if (!id) return null;
  const hit = _userCache.get(String(id));
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;
  const u = await models().User.findByPk(id, {
    attributes: ['id', 'name', 'email', 'username', 'parentUserId', 'isPlatformAdmin'],
    paranoid: false,
  }).catch(() => null);
  const user = u ? u.get({ plain: true }) : null;
  _userCache.set(String(id), { at: Date.now(), user });
  if (_userCache.size > 5000) _userCache.delete(_userCache.keys().next().value);
  return user;
}

const labelOf = (u) => (u ? (u.name || u.email || u.username || String(u.id)) : null);
const kindOf = (u) => (!u ? 'system' : u.isPlatformAdmin ? 'operator' : u.parentUserId ? 'member' : 'owner');

/** Who did it, from a user id (a request's req.user.id). */
async function actorFromUserId(id) {
  const u = await loadUser(id);
  if (!u) return { kind: 'system', id: null, label: 'system' };
  return { kind: kindOf(u), id: u.id, label: labelOf(u), email: u.email || null };
}

/** The account (owner id) a user belongs to. */
async function accountOfUser(id) {
  const u = await loadUser(id);
  if (!u) return null;
  return u.parentUserId || u.id;
}

function reqIp(req) {
  if (!req) return null;
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null;
}

/* ───────────────────────── record ───────────────────────── */

function shape(row) {
  const r = row.get ? row.get({ plain: true }) : row;
  return {
    id: r.id !== undefined && r.id !== null ? String(r.id) : null,
    type: r.type,
    category: TYPE_CATEGORY[r.type] || 'system',
    severity: r.severity,
    accountId: r.accountId || null,
    account: r.accountId ? { id: r.accountId, name: r.accountLabel || null } : null,
    actor: { kind: r.actorKind || 'system', id: r.actorId || null, label: r.actorLabel || 'system' },
    summary: r.summary,
    data: r.data || null,
    ip: r.ip || null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  };
}

async function doRecord(type, opts = {}) {
  const severity = ['info', 'warning', 'critical'].includes(opts.severity) ? opts.severity : 'info';
  const req = opts.req || null;

  let actor = opts.actor || null;
  if (actor === 'system' || (!actor && !req?.user?.id)) actor = { kind: 'system', id: null, label: 'system' };
  else if (!actor) actor = await actorFromUserId(req.user.id);

  let accountLabel = opts.accountLabel || null;
  if (opts.accountId && !accountLabel) accountLabel = labelOf(await loadUser(opts.accountId));

  const row = {
    type,
    severity,
    accountId: opts.accountId ? String(opts.accountId) : null,
    accountLabel: accountLabel ? String(accountLabel).slice(0, 160) : null,
    actorKind: actor.kind || 'system',
    actorId: actor.id ? String(actor.id) : null,
    actorLabel: actor.label ? String(actor.label).slice(0, 160) : null,
    summary: String(opts.summary || type).slice(0, 500),
    data: opts.data || null,
    ip: opts.ip || reqIp(req),
    userAgent: String(opts.userAgent || req?.headers?.['user-agent'] || '').slice(0, 255) || null,
    createdAt: new Date(),
  };

  let saved = null;
  try {
    saved = await models().PlatformEvent.create(row);
  } catch (err) {
    logger.warn('platformEvents: insert failed (pushed live only)', { type, error: err.message });
  }
  const event = shape(saved || row);
  try { emit(PLATFORM_EVENT, event); } catch (_) { /* bus never throws into us */ }
  try { ws().toOps(PLATFORM_EVENT, event); } catch (_) { /* ws not running (tests, scripts) */ }
  if (['signups', 'changes', 'cameras'].includes(event.category)) scheduleCounters();
  return event;
}

/** Fire-and-forget. Returns a promise of the shaped event (or null) that never rejects. */
function record(type, opts) {
  return doRecord(type, opts).catch((err) => {
    logger.warn('platformEvents: record failed', { type, error: err.message });
    return null;
  });
}

/* ───────────────────────── cameras added / removed ───────────────────────── */

const _camBursts = new Map(); // `${userId}:${kind}` -> { userId, kind, cameras: [], timer }

/**
 * Note cameras added or removed. Calls inside CAMERA_BURST_MS for the same
 * user and kind become ONE event ("added 16 cameras at Office").
 * @param {'added'|'removed'} kind
 * @param {object} p { userId, cameras: [{ name, groupName }] }
 */
function noteCameras(kind, { userId, cameras = [] } = {}) {
  if (!userId || !cameras.length) return;
  const key = `${userId}:${kind}`;
  let b = _camBursts.get(key);
  if (!b) {
    b = { userId, kind, cameras: [], timer: null };
    _camBursts.set(key, b);
    b.timer = setTimeout(() => flushCameras(key), CAMERA_BURST_MS);
    if (b.timer.unref) b.timer.unref();
  }
  b.cameras.push(...cameras);
}

async function flushCameras(key) {
  const b = _camBursts.get(key);
  _camBursts.delete(key);
  if (!b || !b.cameras.length) return;
  const accountId = await accountOfUser(b.userId);
  const groups = [...new Set(b.cameras.map((c) => c.groupName).filter(Boolean))];
  const n = b.cameras.length;
  const verb = b.kind === 'added' ? 'Added' : 'Removed';
  const where = groups.length === 1 ? ` at ${groups[0]}` : groups.length > 1 ? ` across ${plural(groups.length, 'location')}` : '';
  const summary = n === 1
    ? `${verb} camera ${b.cameras[0].name || ''}${where}`.replace(/\s+/g, ' ').trim()
    : `${verb} ${n} cameras${where}`;
  record(b.kind === 'added' ? 'camera.added' : 'camera.removed', {
    accountId,
    actor: await actorFromUserId(b.userId),
    summary,
    data: { count: n, groups, cameras: b.cameras.slice(0, 50).map((c) => c.name).filter(Boolean) },
  });
}

/* ───────────────────────── camera / NVR status ───────────────────────── */

const _nvrDown = new Set(); // groupIds announced down

async function onStatusBatch({ accountId: userId, offline, recovered }) {
  const { Camera, CameraGroup } = models();
  const { Op } = require('sequelize');
  const accountId = await accountOfUser(userId);
  if (!accountId) return;
  const keys = [...offline, ...recovered].map((c) => c.key);
  const rows = await Camera.findAll({ where: { monitorId: { [Op.in]: keys } }, attributes: ['monitorId', 'name', 'groupId'], raw: true });
  const byKey = new Map(rows.map((r) => [r.monitorId, r]));
  const groupIds = [...new Set(rows.map((r) => r.groupId).filter(Boolean))];
  const [groups, groupCams] = await Promise.all([
    groupIds.length ? CameraGroup.findAll({ where: { id: { [Op.in]: groupIds } }, attributes: ['id', 'name'], raw: true }) : [],
    groupIds.length ? Camera.findAll({ where: { groupId: { [Op.in]: groupIds } }, attributes: ['groupId', 'status'], raw: true }) : [],
  ]);
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const groupStat = new Map();
  for (const c of groupCams) {
    const s = groupStat.get(c.groupId) || { total: 0, offline: 0 };
    s.total += 1;
    if (c.status !== 'online') s.offline += 1;
    groupStat.set(c.groupId, s);
  }
  const cam = (c) => byKey.get(c.key) || { name: c.name || c.key, groupId: c.groupId || null };

  // ── went offline ──
  const offByGroup = new Map();
  for (const c of offline) {
    const r = cam(c);
    const g = r.groupId || null;
    if (!offByGroup.has(g)) offByGroup.set(g, []);
    offByGroup.get(g).push(r.name);
  }
  const looseOffline = []; // [{ group, names }]
  for (const [g, names] of offByGroup) {
    const st = g ? groupStat.get(g) : null;
    if (g && st && st.total >= 2 && st.offline === st.total) {
      if (_nvrDown.has(g)) continue; // already announced; this is the tail of it
      _nvrDown.add(g);
      record('nvr.down', {
        severity: 'critical',
        accountId,
        actor: 'system',
        summary: `NVR ${groupName.get(g) || 'recorder'} is down: all ${st.total} cameras offline`,
        data: { groupId: g, groupName: groupName.get(g) || null, cameras: st.total },
      });
    } else {
      looseOffline.push({ group: g ? groupName.get(g) || null : null, names });
    }
  }
  if (looseOffline.length) {
    const all = looseOffline.flatMap((x) => x.names);
    const groupsNamed = looseOffline.filter((x) => x.group);
    const where = groupsNamed.length === 1 && looseOffline.length === 1 ? ` at ${groupsNamed[0].group}` : '';
    const summary = all.length === 1
      ? `Camera ${all[0]}${where} went offline`
      : looseOffline.length > 1
        ? `${all.length} cameras went offline (${looseOffline.map((x) => `${x.group || 'no NVR'} ${x.names.length}`).join(', ')})`
        : `${all.length} cameras${where} went offline`;
    record('camera.offline', {
      severity: 'warning', accountId, actor: 'system', summary,
      data: { count: all.length, cameras: all.slice(0, 50), groups: looseOffline.map((x) => ({ name: x.group, count: x.names.length })) },
    });
  }

  // ── came back ──
  const backByGroup = new Map();
  for (const c of recovered) {
    const r = cam(c);
    const g = r.groupId || null;
    if (!backByGroup.has(g)) backByGroup.set(g, []);
    backByGroup.get(g).push(r.name);
  }
  const looseBack = [];
  for (const [g, names] of backByGroup) {
    if (g && _nvrDown.has(g)) {
      _nvrDown.delete(g);
      const st = groupStat.get(g) || { total: names.length, offline: 0 };
      record('nvr.recovered', {
        accountId, actor: 'system',
        summary: `NVR ${groupName.get(g) || 'recorder'} is back: ${st.total - st.offline} of ${st.total} cameras online`,
        data: { groupId: g, groupName: groupName.get(g) || null, cameras: st.total, online: st.total - st.offline },
      });
    } else {
      looseBack.push({ group: g ? groupName.get(g) || null : null, names });
    }
  }
  if (looseBack.length) {
    const all = looseBack.flatMap((x) => x.names);
    const where = looseBack.length === 1 && looseBack[0].group ? ` at ${looseBack[0].group}` : '';
    record('camera.recovered', {
      accountId, actor: 'system',
      summary: all.length === 1 ? `Camera ${all[0]}${where} is back online` : `${all.length} cameras${where} are back online`,
      data: { count: all.length, cameras: all.slice(0, 50) },
    });
  }
  scheduleCounters();
}

let _coalescer = null;
function coalescer() {
  if (!_coalescer) {
    _coalescer = createCameraStatusCoalescer({
      onBatch: (batch) => onStatusBatch(batch).catch((err) => logger.warn('platformEvents: status batch failed', { error: err.message })),
    });
  }
  return _coalescer;
}

/* ───────────────────────── failed sign-in bursts ───────────────────────── */

const _loginFails = new Map(); // identifier -> { times: [], alertedAt }

/**
 * Count a failed sign-in. The FIFTH failure inside 10 min for one identifier
 * records one warning; the identifier then stays quiet for 10 min.
 * @returns {boolean} true when this failure raised the warning
 */
function noteLoginFailure(identifier, { req, user = null, reason = 'bad_password', now = Date.now() } = {}) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return false;
  let f = _loginFails.get(id);
  if (!f) { f = { times: [], alertedAt: 0, ips: new Set() }; _loginFails.set(id, f); }
  f.times = f.times.filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  f.times.push(now);
  const ip = reqIp(req);
  if (ip) f.ips.add(ip);
  if (_loginFails.size > 10000) _loginFails.delete(_loginFails.keys().next().value);

  if (f.times.length < LOGIN_FAIL_THRESHOLD || (f.alertedAt && now - f.alertedAt < LOGIN_FAIL_WINDOW_MS)) return false;
  f.alertedAt = now;
  const ips = [...f.ips];
  f.ips = new Set();
  (async () => {
    const accountId = user ? (user.parentUserId || user.id) : null;
    record('account.login_failed', {
      severity: 'warning',
      accountId,
      actor: user ? { kind: kindOf(user), id: user.id, label: labelOf(user) } : { kind: 'visitor', id: null, label: id },
      req,
      summary: `${f.times.length} failed sign-ins for ${id} in 10 min${user ? '' : ' (no such user)'}`,
      data: { identifier: id, failures: f.times.length, ips, reason, knownUser: !!user },
    });
  })();
  return true;
}

/** A successful sign-in (owners and sub-users; operators are not accounts). */
function noteLogin(user, req) {
  if (!user || user.isPlatformAdmin) return;
  const id = String(user.email || user.username || '').toLowerCase();
  if (id) _loginFails.delete(id);
  const accountId = user.parentUserId || user.id;
  const who = labelOf(user);
  record('account.login', {
    accountId,
    actor: { kind: kindOf(user), id: user.id, label: who },
    req,
    summary: user.parentUserId ? `${who} signed in (team member)` : `${who} signed in`,
    data: { userId: user.id, member: !!user.parentUserId },
  });
}

/* ───────────────────────── counters ───────────────────────── */

let _countersTimer = null;
let _countersLastRun = 0;
let _countersLast = null;

function istDayStart(now = new Date()) {
  const IST = 330 * 60_000;
  const d = new Date(now.getTime() + IST);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST);
}

/** Accounts / signups today / cameras online, in the Accounts list's own buckets. */
async function computeCounters() {
  const { User, Camera } = models();
  const { Op } = require('sequelize');
  const { loadHealthContext, classifyCamera } = require('../controllers/cameraHealth.controller');
  const [owners, members, cameras, ctx] = await Promise.all([
    User.findAll({ where: { parentUserId: null, isPlatformAdmin: { [Op.not]: true } }, attributes: ['id', 'isActive', 'createdAt'], raw: true }),
    User.findAll({ where: { parentUserId: { [Op.ne]: null } }, attributes: ['id', 'parentUserId'], raw: true }),
    Camera.findAll({ attributes: ['id', 'userId', 'monitorId', 'status'], raw: true }),
    loadHealthContext(),
  ]);
  const ownerOf = new Map(owners.map((o) => [o.id, o.id]));
  for (const m of members) ownerOf.set(m.id, m.parentUserId);
  const since = istDayStart();
  const BUCKET_ONLINE = new Set(['healthy', 'standby', 'transcoding', 'starting']);
  let total = 0; let online = 0; let offline = 0;
  for (const c of cameras) {
    if (!ownerOf.has(c.userId)) continue;
    total += 1;
    const { status } = classifyCamera(c, ctx);
    if (BUCKET_ONLINE.has(status)) online += 1;
    else if (status === 'offline') offline += 1;
  }
  return {
    accounts: owners.length,
    suspended: owners.filter((o) => !o.isActive).length,
    signupsToday: owners.filter((o) => new Date(o.createdAt) >= since).length,
    cameras: { total, online, offline },
    at: new Date().toISOString(),
  };
}

async function emitCounters() {
  _countersTimer = null;
  _countersLastRun = Date.now();
  if (!ws().opsCount || ws().opsCount() === 0) return;
  try {
    const c = await computeCounters();
    const sig = JSON.stringify({ ...c, at: undefined });
    if (sig === _countersLast) return;
    _countersLast = sig;
    ws().toOps(COUNTERS_EVENT, c);
  } catch (err) {
    logger.debug('platformEvents: counters failed', { error: err.message });
  }
}

/** Push fresh counters soon — at most once every COUNTERS_MIN_MS. */
function scheduleCounters() {
  if (_countersTimer) return;
  const wait = Math.max(500, _countersLastRun + COUNTERS_MIN_MS - Date.now());
  _countersTimer = setTimeout(() => { emitCounters(); }, wait);
  if (_countersTimer.unref) _countersTimer.unref();
}

/* ───────────────────────── platform services ───────────────────────── */

const SERVICE_NAMES = { db: 'Database', redis: 'Redis', stream: 'Stream service', ai: 'AI engine' };
const _svc = new Map(); // key -> { announced: bool (up), streak: number, lastOk }
let _svcTimer = null;

async function checkServices() {
  const { checks } = require('../controllers/health.controller');
  const [db, redis, mtx, ai] = await Promise.all([
    checks.checkDb(), checks.checkRedis(), checks.checkStreamServers(), checks.checkAiService(),
  ]);
  const results = { db, stream: { ok: (mtx || []).some((m) => m.ok), error: (mtx || []).map((m) => m.error).filter(Boolean)[0] } };
  // Not configured is not "down".
  if (!/not configured|not set/i.test(redis.error || '')) results.redis = redis;
  if (!/not configured|not set/i.test(ai.error || '')) results.ai = ai;

  for (const [key, r] of Object.entries(results)) {
    const s = _svc.get(key) || { announced: true, streak: 0 };
    if (r.ok === s.announced) { s.streak = 0; _svc.set(key, s); continue; }
    s.streak += 1;
    // Two checks in a row (≈60 s) before saying anything: one slow answer is not an outage.
    if (s.streak >= 2) {
      s.announced = r.ok;
      s.streak = 0;
      record(r.ok ? 'service.up' : 'service.down', {
        severity: r.ok ? 'info' : 'critical',
        actor: 'system',
        summary: r.ok ? `${SERVICE_NAMES[key]} is back up` : `${SERVICE_NAMES[key]} is down`,
        data: { service: key, error: r.ok ? undefined : String(r.error || '').slice(0, 200) },
      });
    }
    _svc.set(key, s);
  }
}

/* ───────────────────────── wiring ───────────────────────── */

let _started = false;

function start() {
  if (_started) return;
  _started = true;

  // Cameras created through the NVR form (one bus event per camera) and
  // deleted through any route. Bulk import and "add channels" call noteCameras
  // directly (they do not emit per-camera bus events).
  on(EVENTS.CAMERA_CREATED, ({ camera, userId, groupName }) => {
    noteCameras('added', { userId, cameras: [{ name: camera?.name, groupName: groupName || null }] });
  });
  on(EVENTS.CAMERA_DELETED, ({ monitorId, userId, name, groupName }) => {
    if (monitorId) coalescer().forget(monitorId);
    noteCameras('removed', { userId, cameras: [{ name: name || monitorId, groupName: groupName || null }] });
  });

  // Stream supervisor transitions → coalesced per account.
  const onTransition = (p) => {
    if (!p || !p.monitorId || !p.userId) return;
    coalescer().observe({ key: p.monitorId, accountId: p.userId, fromState: p.fromState, toState: p.toState });
    scheduleCounters();
  };
  on(EVENTS.STREAM_READY, onTransition);
  on(EVENTS.STREAM_OFFLINE, onTransition);

  if (process.env.PLATFORM_SERVICE_MONITOR !== '0') {
    const tick = () => checkServices().catch((err) => logger.debug('platformEvents: service check failed', { error: err.message }));
    _svcTimer = setInterval(tick, SERVICE_CHECK_MS);
    if (_svcTimer.unref) _svcTimer.unref();
    tick();
  }
  logger.info('platformEvents: started');
}

function stop() {
  if (_svcTimer) clearInterval(_svcTimer);
  _svcTimer = null;
  if (_coalescer) _coalescer.stop();
}

module.exports = {
  PLATFORM_EVENT, COUNTERS_EVENT,
  record, shape, noteCameras, noteLogin, noteLoginFailure,
  actorFromUserId, accountOfUser, planLabel, plural, nameList,
  computeCounters, scheduleCounters, start, stop,
  // tests
  _internal: { onStatusBatch, checkServices, _loginFails, _svc, _nvrDown, coalescer, istDayStart },
};
