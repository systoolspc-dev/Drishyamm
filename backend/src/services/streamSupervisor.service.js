/**
 * streamSupervisor.service.js
 *
 * Real-time data-plane health monitor for every camera in every Stream Service server.
 *
 * Where streamRouter handles the CONTROL plane (add/remove paths) and
 * recordingSync.runWatchdog reconciles configured paths against the DB,
 * this service watches the DATA plane:
 *
 *   - polls every online Stream Service server's /v3/paths/list on a fast cadence
 *   - computes per-camera ingress bitrate from `bytesReceived` deltas
 *   - tracks an explicit per-camera state machine
 *   - flips Camera.status / persists supervisor fields on transitions
 *   - emits CAMERA_*  events on the in-process bus AND Redis Streams (cross-process)
 *   - exposes Prometheus gauges so Grafana can plot live stream health
 *
 * The state machine ─────────────────────────────────────────────────────────
 *
 *   PENDING   ─┐  initial state for every newly-loaded camera
 *              │
 *   CONNECTING ◄── path exists in MTX but ready=false (RTSP handshake in flight)
 *              │
 *   STREAMING  ◄── ready=true AND bps_in > MIN_HEALTHY_BPS
 *              │
 *   DEGRADED   ◄── ready=true BUT bps_in < MIN_HEALTHY_BPS for ≥ DEGRADED_AFTER_MS
 *              │
 *   OFFLINE    ◄── ready=false for ≥ OFFLINE_AFTER_MS, OR path missing
 *              │
 *   QUARANTINED ── too many flap cycles in a window; supervisor backs off and
 *                  asks the router to re-add the path on a longer cooldown
 *
 * Transitions are one-way per tick (no double-jumps). Persistence and event
 * emission happen ONLY on transitions, not every tick — Redis/DB don't need
 * 1Hz writes for thousands of cameras.
 *
 * Scaling notes ───────────────────────────────────────────────────────────────
 *
 *   - Polling work is per-server, not per-camera. One /v3/paths/list call gives
 *     us state for every camera on that Stream Service. So adding cameras costs ~zero;
 *     adding Stream Service servers costs one HTTP roundtrip per tick per server.
 *
 *   - DB writes are batched into one bulk update per tick, only for cameras whose
 *     visible state changed. At 2k cameras with low churn, expect <50 writes/tick.
 *
 *   - Cross-process events are written to Redis Streams (capped at MAX_STREAM_LEN
 *     entries via XADD MAXLEN ~). Consumers read via XREAD; no fan-out logic here.
 *
 *   - Designed for HORIZONTAL scale: only ONE instance should run the supervisor
 *     loop in any given deployment. A Redis lock ensures that — see acquireLeader().
 */

const Redis = require('ioredis');

const config       = require('../config/env');
const logger       = require('../config/logger');
const { bus, EVENTS } = require('../events/bus');
const streamBus    = require('./streamBus.service');
const cameraOfflineAlert = require('./cameraOfflineAlert.service');
const streamQuality = require('./streamQuality.service');
const metrics      = require('./metrics.service');
const reachability = require('./cameraReachability.service');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

// ── Tunables (env-overridable) ────────────────────────────────────────────────

const POLL_INTERVAL_MS    = parseInt(process.env.SUPERVISOR_POLL_MS         || '2000',  10);
const MIN_HEALTHY_BPS     = parseInt(process.env.SUPERVISOR_MIN_BPS         || '20000', 10); // 20 kbps floor
// Tolerances are deliberately generous: remote NVRs over the public internet
// have ~100ms latency and intermittent timeouts. Tight windows let a single bad
// poll cascade STREAMING->DEGRADED->OFFLINE->CONNECTING in a few ticks and arm
// an unnecessary heal. Bigger windows = far fewer false transitions/heals.
const DEGRADED_AFTER_MS   = parseInt(process.env.SUPERVISOR_DEGRADED_AFTER_MS || '20000', 10);
const OFFLINE_AFTER_MS    = parseInt(process.env.SUPERVISOR_OFFLINE_AFTER_MS  || '40000', 10);
const FLAP_WINDOW_MS      = parseInt(process.env.SUPERVISOR_FLAP_WINDOW_MS    || '120000', 10);
const FLAP_LIMIT          = parseInt(process.env.SUPERVISOR_FLAP_LIMIT        || '5', 10);
const QUARANTINE_MS       = parseInt(process.env.SUPERVISOR_QUARANTINE_MS     || '300000', 10);
const LEADER_LOCK_TTL_MS  = parseInt(process.env.SUPERVISOR_LEADER_TTL_MS     || '15000', 10);

// ── State ─────────────────────────────────────────────────────────────────────

// Per-camera in-memory state. Keyed by monitorId.
//   { state, lastReady, lastBytes, lastBytesAt, bpsIn, enteredStateAt,
//     lowBpsSince, flaps: [ts, ts, ...], quarantineUntil }
const _cam = new Map();

// Per-server axios clients (lazy, reused across ticks)
const axios = require('axios');
const _serverClients = new Map();
function clientFor(server) {
  if (_serverClients.has(server.id)) return _serverClients.get(server.id);
  const c = axios.create({
    baseURL: server.apiUrl,
    timeout: 4000,
    headers: { 'Content-Type': 'application/json' },
    auth: server.apiUser ? { username: server.apiUser, password: server.apiPass || '' } : undefined,
  });
  _serverClients.set(server.id, c);
  return c;
}

// Loop control
let _running = false;
let _timer   = null;
let _redis   = null;

// Leader election — only one instance drives the supervisor
const INSTANCE_ID = `${process.env.HOSTNAME || 'local'}:${process.pid}:${Date.now()}`;
const LEADER_KEY  = 'drisyam:supervisor:leader';
let   _isLeader   = false;

// ── State machine constants ───────────────────────────────────────────────────

const S = Object.freeze({
  PENDING:     'pending',
  CONNECTING:  'connecting',
  STREAMING:   'streaming',
  DEGRADED:    'degraded',
  // STANDBY: host is reachable (per cameraReachability prober) but no one is
  // viewing, so the sourceOnDemand path isn't being pulled and never reports
  // `ready`. This is a HEALTHY state — public-online — distinct from OFFLINE
  // (host actually unreachable). Without it, every idle on-demand camera looked
  // offline even when the NVR was perfectly up.
  STANDBY:     'standby',
  OFFLINE:     'offline',
  QUARANTINED: 'quarantined',
});

// Map supervisor state → public Camera.status enum (only 'online' / 'offline')
function publicStatus(state) {
  return state === S.STREAMING || state === S.DEGRADED || state === S.STANDBY
    ? 'online' : 'offline';
}

// Explain WHY a camera dropped, from the signals we already have at transition
// time. Turns the generic "camera offline" into an actionable message the
// operator can act on. Returns { code, text }.
function offlineReason(toState, pathInfo, hostReachable) {
  if (toState === S.QUARANTINED) {
    return { code: 'flapping', text: 'Unstable connection — repeatedly dropping (backing off)' };
  }
  if (hostReachable === false) {
    return { code: 'nvr_unreachable', text: 'Recorder / NVR unreachable — the site link or NVR appears down' };
  }
  if (!pathInfo) {
    return { code: 'stream_stopped', text: 'Stream not running — reconnecting' };
  }
  // path exists but never went ready / stopped sending data
  return { code: 'no_video', text: 'Reachable, but no video — check the camera power & cabling' };
}

// ── Leader election (single-tick, opportunistic) ──────────────────────────────

async function acquireLeader() {
  if (!_redis) return false;
  try {
    // SET NX PX — classic Redis lock. TTL refreshed on every tick.
    const res = await _redis.set(LEADER_KEY, INSTANCE_ID, 'PX', LEADER_LOCK_TTL_MS, 'NX');
    if (res === 'OK') return true;
    // Already held by us? (allows refresh after the value matches)
    const cur = await _redis.get(LEADER_KEY);
    if (cur === INSTANCE_ID) {
      await _redis.pexpire(LEADER_KEY, LEADER_LOCK_TTL_MS);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn('streamSupervisor: leader acquire failed', { error: err.message });
    return false;
  }
}

// ── Per-camera tick reducer ───────────────────────────────────────────────────

/**
 * Apply one observation to a camera's state. Pure function over the entry +
 * the latest path snapshot from Stream Service.
 *
 * @param {object} entry  — current state (mutated in place)
 * @param {object|null} pathInfo — Stream Service /v3/paths/get item, or null when path missing
 * @param {number} now    — Date.now() at tick start (deterministic across cameras)
 * @returns {{transitioned:boolean, prevState:string}}
 */
function reduce(entry, pathInfo, now, hostReachable = null) {
  const prevState = entry.state;
  let next = prevState;

  // Bps update — derive bytes/sec from successive bytesReceived samples
  if (pathInfo && typeof pathInfo.bytesReceived === 'number') {
    if (entry.lastBytes != null && entry.lastBytesAt && now > entry.lastBytesAt) {
      const dB = pathInfo.bytesReceived - entry.lastBytes;
      const dT = (now - entry.lastBytesAt) / 1000;
      if (dB < 0) {
        // Counter went BACKWARDS: the path was just re-added/re-bound (by a heal
        // or the watchdog), which zeroes Stream Service's bytesReceived. This is NOT a
        // real 0-bps sample — carry the previous bpsIn forward. Treating it as 0
        // demoted STREAMING->DEGRADED and re-armed another heal: the feedback
        // loop that produced the 0->big->0 bps churn. Leave entry.bpsIn unchanged.
      } else {
        entry.bpsIn = dB > 0 && dT > 0 ? Math.round((dB * 8) / dT) : 0;
        // The last moment real video ARRIVED, as opposed to the last moment we
        // polled. The Health page's "Last Update" column reads this, so a
        // camera whose path is still up but whose source has frozen must not
        // keep advertising a fresh timestamp.
        if (dB > 0) entry.lastDataAt = now;
      }
    } else {
      entry.bpsIn = 0;
    }
    entry.lastBytes   = pathInfo.bytesReceived;
    entry.lastBytesAt = now;
  } else if (!pathInfo) {
    entry.bpsIn = 0;
  }

  const ready = pathInfo?.ready === true;
  entry.lastReady = ready;

  // Quarantine has its own timeout; ignore tick observations until it expires
  if (prevState === S.QUARANTINED) {
    if (now >= (entry.quarantineUntil || 0)) {
      next = S.PENDING;
    } else {
      return { transitioned: false, prevState };
    }
  }

  if (!pathInfo) {
    // Path missing entirely — could be MTX restart wiping config. Mark OFFLINE
    // immediately so the watchdog re-adds it; supervisor doesn't compete with router.
    next = S.OFFLINE;
  } else if (ready && entry.bpsIn >= MIN_HEALTHY_BPS) {
    next = S.STREAMING;
    entry.lowBpsSince = null;
    entry.notReadySince = null;
  } else if (ready && entry.bpsIn < MIN_HEALTHY_BPS) {
    entry.notReadySince = null;
    // Healthy ready but no/low data: degrade only after a sustained low-bps
    // window. Using enteredStateAt here made one low sample flap long-running
    // streams from STREAMING -> DEGRADED.
    if (!entry.lowBpsSince) entry.lowBpsSince = now;
    const lowForMs = now - entry.lowBpsSince;
    if (prevState === S.STREAMING && lowForMs < DEGRADED_AFTER_MS) next = S.STREAMING;
    else if ((prevState === S.PENDING || prevState === S.CONNECTING) && lowForMs < DEGRADED_AFTER_MS) next = S.CONNECTING;
    else if (prevState === S.DEGRADED) next = S.DEGRADED;
    else next = S.DEGRADED;
  } else {
    // not ready — debounce on how long the path has been CONTINUOUSLY not-ready,
    // NOT time-in-current-state. The old code compared now-enteredStateAt, so a
    // stream that had been STREAMING for minutes went OFFLINE on its FIRST
    // not-ready poll (enteredStateAt was already older than OFFLINE_AFTER_MS).
    // That single-poll knockout produced the bulk of the streaming->offline
    // churn on flaky links. Stream Service auto-reconnects sourceOnDemand:false paths,
    // so the vast majority of not-ready blips recover within the window.
    entry.lowBpsSince = null;
    if (!entry.notReadySince) entry.notReadySince = now;
    const notReadyMs = now - entry.notReadySince;
    // sourceOnDemand cameras are never `ready` while idle, but they ARE healthy
    // if their host answers. The reachability prober gives us that signal:
    //   reachable          → STANDBY (public-online), even with nobody viewing.
    //   unreachable/unknown → legacy CONNECTING→OFFLINE debounce, unchanged.
    if (prevState === S.STREAMING || prevState === S.DEGRADED) {
      // Keep an actively-streaming camera sticky through brief not-ready blips;
      // only after a sustained outage does it fall to standby (reachable) or
      // offline (unreachable).
      const idleTarget = hostReachable === true ? S.STANDBY : S.OFFLINE;
      next = notReadyMs >= OFFLINE_AFTER_MS ? idleTarget : prevState;
    } else if (hostReachable === true) {
      // Reachable + not currently streaming → STANDBY right away. Do NOT wait in
      // CONNECTING: on-demand cams never report `ready` until viewed, and brief
      // transcoder-reader `ready` blips kept resetting notReadySince, so these
      // real, healthy cameras got stuck in CONNECTING/offline indefinitely.
      entry.notReadySince = null;
      next = S.STANDBY;
    } else if (prevState === S.PENDING) {
      next = S.CONNECTING;
    } else if (prevState === S.CONNECTING) {
      next = notReadyMs >= OFFLINE_AFTER_MS ? S.OFFLINE : S.CONNECTING;
    } else {
      next = S.OFFLINE;
    }
  }

  if (next !== prevState) {
    // Flap accounting. Count a flap on:
    //   - any STREAMING → non-STREAMING departure (healthy stream dropped), AND
    //   - any transition INTO OFFLINE from a non-offline state.
    // The second case is essential: a camera on a saturated NVR often cycles
    // CONNECTING/DEGRADED ↔ OFFLINE without ever crossing into STREAMING, so the
    // STREAMING-only rule never armed quarantine for exactly the worst-behaved
    // cameras and they flapped forever. Counting OFFLINE entries lets the
    // backoff engage for them too. (One transition = at most one count.)
    const isFlap =
      // Going idle (STREAMING → STANDBY) is NOT a flap — the camera is healthy,
      // just unviewed. Only count genuine drops out of STREAMING.
      (prevState === S.STREAMING && next !== S.STREAMING && next !== S.STANDBY) ||
      (next === S.OFFLINE && prevState !== S.OFFLINE && prevState !== S.QUARANTINED);
    if (isFlap) {
      entry.flaps = (entry.flaps || []).filter((t) => now - t < FLAP_WINDOW_MS);
      entry.flaps.push(now);
      if (entry.flaps.length >= FLAP_LIMIT) {
        next = S.QUARANTINED;
        entry.quarantineUntil = now + QUARANTINE_MS;
        entry.flaps = []; // reset window
      }
    }
    entry.state = next;
    entry.enteredStateAt = now;
    return { transitioned: true, prevState };
  }

  return { transitioned: false, prevState };
}

// ── Tick: fetch paths from every server, fold into _cam map ───────────────────

// /v3/paths/list is paginated (100 items/page by default). Reading only the
// first page truncates the fleet at ~50 cameras (2 paths each) — and a camera
// missing from this map reads as "not streaming", so healthy cameras beyond the
// cut-off would be demoted to DEGRADED/OFFLINE. Walk every page.
const PATHS_PER_PAGE = 1000;
const PATHS_MAX_PAGES = 100;

async function fetchServerPaths(server) {
  try {
    const client = clientFor(server);
    const byPath = new Map();
    for (let page = 0; page < PATHS_MAX_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- pages must be fetched in order
      const { data } = await client.get('/v3/paths/list', {
        params: { page, itemsPerPage: PATHS_PER_PAGE },
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      for (const it of items) byPath.set(it.name, it);

      const pageCount = Number(data?.pageCount);
      if (Number.isFinite(pageCount) ? page + 1 >= pageCount : items.length < PATHS_PER_PAGE) break;
    }
    return byPath;
  } catch (err) {
    logger.debug('streamSupervisor: server poll failed', {
      server: server.name, error: err.message,
    });
    return null; // signal: skip cameras on this server this tick
  }
}

// ── Synthetic env-default server (when mediamtx_servers table is empty) ───────
// The router supports running without populating the pool table — a single
// Stream Service configured purely from env. The supervisor mirrors that fallback
// so a fresh dev install gets supervised without DBA setup.
function envDefaultServer() {
  return {
    id:        '__env_default__',
    name:      'env-default',
    apiUrl:    config.streamService.apiUrl,
    apiUser:   config.streamService.apiUser,
    apiPass:   config.streamService.apiPass,
  };
}

async function tick() {
  const { Camera, StreamServer } = loadModels();

  let servers = await StreamServer.findAll({
    where: { status: ['online', 'draining'] },
  });
  if (!servers.length) servers = [envDefaultServer()];

  // Fetch all servers' path snapshots in parallel
  const snapshots = await Promise.all(servers.map((s) => fetchServerPaths(s).then((m) => [s, m])));

  // Index cameras by id; we need bulkUpdate with monitor_id → status mapping later
  const cameras = await Camera.findAll({
    attributes: ['id', 'userId', 'monitorId', 'mediamtxServerId', 'status', 'flapCount24h', 'host', 'name'],
  });
  if (!cameras.length) return;

  const camerasByServer = new Map(); // serverId → [Camera...]
  for (const c of cameras) {
    const sid = c.mediamtxServerId || servers[0].id; // legacy fallback
    if (!camerasByServer.has(sid)) camerasByServer.set(sid, []);
    camerasByServer.get(sid).push(c);
  }

  const now = Date.now();
  const transitions = []; // { camera, fromState, toState, bps, ready }

  for (const [server, byPath] of snapshots) {
    if (byPath === null) continue; // server unreachable this tick
    const camList = camerasByServer.get(server.id) || [];
    for (const cam of camList) {
      let entry = _cam.get(cam.monitorId);
      if (!entry) {
        entry = {
          state: S.PENDING,
          enteredStateAt: now,
          bpsIn: 0,
          lastBytes: null,
          lastBytesAt: null,
          flaps: [],
          lowBpsSince: null,
          notReadySince: null,
        };
        _cam.set(cam.monitorId, entry);
      }
      const pathName = `cam_${cam.monitorId}`;
      const info = byPath.get(pathName) || null;
      const hostReachable = reachability.isReachable(cam.host);
      const { transitioned, prevState } = reduce(entry, info, now, hostReachable);
      if (transitioned) {
        // Attach a why-it-dropped reason on offline transitions (null when coming online).
        const r = publicStatus(entry.state) === 'online'
          ? null
          : offlineReason(entry.state, info, hostReachable);
        transitions.push({
          camera: cam,
          fromState: prevState,
          toState: entry.state,
          bps: entry.bpsIn,
          ready: entry.lastReady,
          quarantineUntil: entry.quarantineUntil || null,
          reasonCode: r?.code || null,
          reason: r?.text || null,
          server,
        });
      }
      // Update Prometheus gauges every tick (cheap, in-memory)
      metrics.cameraState.set({ monitor_id: cam.monitorId, state: entry.state }, 1);
      metrics.cameraBpsIn.set({ monitor_id: cam.monitorId }, entry.bpsIn || 0);

      // Quality observation — emits jitter/FIE/readers metrics + may advise heal.
      // Heal action is asynchronous and respects per-camera cooldown internally.
      const advice = streamQuality.observe({
        monitorId:       cam.monitorId,
        bpsIn:           entry.bpsIn,
        pathInfo:        info,
        supervisorState: entry.state,
        enteredStateAt:  entry.enteredStateAt,
      });
      if (advice.healAdvice && entry.state !== S.QUARANTINED) {
        // Fire-and-forget — supervisor's job is observation; healing happens
        // out of band so we don't block the next camera's tick.
        // Never auto-heal a quarantined camera: the whole point of quarantine
        // is to stop poking a flapping NVR. (Operators can still force a heal
        // via manualHeal / the streamHeal controller.)
        streamQuality.heal(cam, server, advice.healAdvice.reason).catch((err) =>
          logger.debug('streamQuality.heal failed', { monitor: cam.monitorId, error: err.message }),
        );
      }
    }
  }

  // ── Persist + emit only on transitions ──────────────────────────────────────
  if (transitions.length) {
    // We do per-camera updates here so each row gets the correct supervisor_state.
    // At 2k cameras with low churn the actual write count per tick is small
    // (only transitions, not every ready camera). If churn explodes we'll batch
    // via a single CASE-based UPDATE — wire that in when real load demands it.
    const nowDate = new Date(now);
    await Promise.all(transitions.map(async (t) => {
      const fields = {
        status:          publicStatus(t.toState),
        supervisorState: t.toState,
        bpsIn:           t.bps,
      };
      if (publicStatus(t.toState) === 'online') fields.lastSeenAt = nowDate;
      if (publicStatus(t.toState) === 'offline' && publicStatus(t.fromState) === 'online') {
        fields.lastOfflineAt = nowDate;
      }
      // Persist the quarantine window so other processes (the recordingSync
      // watchdog, a backend restart, the admin dashboard) can see and honour
      // the backoff. Without this, quarantine_until stayed NULL forever and
      // nothing outside this in-memory map respected the quarantine.
      if (t.toState === S.QUARANTINED) {
        fields.quarantineUntil = t.quarantineUntil ? new Date(t.quarantineUntil) : null;
      } else if (t.fromState === S.QUARANTINED) {
        fields.quarantineUntil = null; // backoff lifted — clear it
      }
      // Flap counter — bump on STREAMING -> non-STREAMING transitions only.
      if (t.fromState === S.STREAMING && t.toState !== S.STREAMING) {
        fields.flapCount24h = (t.camera.flapCount24h || 0) + 1;
      }
      try {
        await Camera.update(fields, { where: { id: t.camera.id } });
      } catch (err) {
        logger.warn('streamSupervisor: camera update failed', {
          monitor: t.camera.monitorId, error: err.message,
        });
      }
    }));

    for (const t of transitions) {
      const payload = {
        monitorId:   t.camera.monitorId,
        cameraId:    t.camera.id,
        userId:      t.camera.userId,
        fromState:   t.fromState,
        toState:     t.toState,
        bpsIn:       t.bps,
        ready:       t.ready,
        reason:      t.reason,       // why it dropped (null when coming online)
        reasonCode:  t.reasonCode,
        serverName:  t.server.name,
        at:          new Date(now).toISOString(),
      };
      const eventName = publicStatus(t.toState) === 'online' ? EVENTS.STREAM_READY : EVENTS.STREAM_OFFLINE;

      // In-process: triggers WS fan-out on this instance
      bus.emit(eventName, payload);

      // Camera-down / recovery email alerts (debounced, fire-and-forget).
      if (eventName === EVENTS.STREAM_OFFLINE) {
        cameraOfflineAlert.onOffline({ monitorId: t.camera.monitorId, cameraName: t.camera.name, userId: t.camera.userId, reason: t.reason, at: payload.at });
      } else if (eventName === EVENTS.STREAM_READY) {
        cameraOfflineAlert.onRecover({ monitorId: t.camera.monitorId, cameraName: t.camera.name, userId: t.camera.userId, at: payload.at });
      }

      // Cross-process: AI worker, other backend instances, gateway WS, dashboards
      streamBus.publish(eventName, payload).catch((e) =>
        logger.debug('streamSupervisor: streamBus publish failed', { error: e.message }),
      );

      metrics.cameraTransitions.inc({
        from: t.fromState, to: t.toState,
      });

      logger.info('[Supervisor] transition', {
        monitor: t.camera.monitorId,
        from: t.fromState,
        to: t.toState,
        bps: t.bps,
        reason: t.reasonCode || undefined,   // why it dropped (offline only)
        server: t.server.name,
      });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Re-seed the in-memory state for cameras that were under quarantine when the
 * process last stopped. The _cam map is wiped on restart, so without this a
 * quarantined camera would immediately re-enter the flap loop (and the watchdog
 * would re-add its path) the moment the supervisor came back up.
 */
async function rehydrateQuarantine() {
  try {
    const { Camera } = loadModels();
    const { Op } = require('sequelize');
    const now = Date.now();
    const quarantined = await Camera.findAll({
      where: { quarantineUntil: { [Op.gt]: new Date(now) } },
      attributes: ['monitorId', 'quarantineUntil'],
    });
    for (const c of quarantined) {
      _cam.set(c.monitorId, {
        state: S.QUARANTINED,
        enteredStateAt: now,
        quarantineUntil: new Date(c.quarantineUntil).getTime(),
        bpsIn: 0,
        lastBytes: null,
        lastBytesAt: null,
        flaps: [],
        lowBpsSince: null,
        notReadySince: null,
      });
    }
    if (quarantined.length) {
      logger.info('streamSupervisor: rehydrated quarantine state', { count: quarantined.length });
    }
  } catch (err) {
    logger.warn('streamSupervisor: quarantine rehydrate failed (continuing)', { error: err.message });
  }
}

async function start() {
  if (_running) return;
  _running = true;

  await rehydrateQuarantine();
  reachability.start();   // feeds isReachable(host) into reduce() → STANDBY vs OFFLINE

  if (!_redis && config.redisUrl) {
    try {
      _redis = new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
      await _redis.connect();
    } catch (err) {
      logger.warn('streamSupervisor: Redis unavailable — leader election skipped, running locally', {
        error: err.message,
      });
      _redis = null;
    }
  }

  logger.info('streamSupervisor: started', {
    instance: INSTANCE_ID, pollMs: POLL_INTERVAL_MS, leaderElection: !!_redis,
  });

  const loop = async () => {
    if (!_running) return;
    try {
      // Single-leader: when Redis is up, only the leader does any work
      _isLeader = _redis ? await acquireLeader() : true;
      metrics.supervisorIsLeader.set(_isLeader ? 1 : 0);
      if (_isLeader) await tick();
    } catch (err) {
      logger.error('streamSupervisor: tick failed', { error: err.message, stack: err.stack });
    } finally {
      if (_running) _timer = setTimeout(loop, POLL_INTERVAL_MS);
    }
  };

  // First tick after a short delay so DB and Stream Service have time to come up
  _timer = setTimeout(loop, 5000);
}

async function stop() {
  _running = false;
  reachability.stop();
  if (_timer) clearTimeout(_timer);
  _timer = null;
  if (_redis) {
    try {
      // Best-effort lock release
      const cur = await _redis.get(LEADER_KEY).catch(() => null);
      if (cur === INSTANCE_ID) await _redis.del(LEADER_KEY).catch(() => {});
      await _redis.quit().catch(() => {});
    } catch (_) { /* swallow */ }
    _redis = null;
  }
  logger.info('streamSupervisor: stopped');
}

/** Snapshot for /admin/diagnostics or admin dashboard. */
function snapshot() {
  const out = [];
  for (const [monitorId, entry] of _cam.entries()) {
    out.push({
      monitorId,
      state:   entry.state,
      bpsIn:   entry.bpsIn,
      ready:   entry.lastReady,
      enteredStateAt: entry.enteredStateAt,
      lastDataAt: entry.lastDataAt || null,
      flapCount: (entry.flaps || []).length,
      quarantineUntil: entry.quarantineUntil || null,
    });
  }
  return { isLeader: _isLeader, instance: INSTANCE_ID, cameras: out };
}

/** Used by tests / manual reset. Drops the in-memory state for a camera. */
function forget(monitorId) { _cam.delete(monitorId); }

/**
 * Cluster leadership signal for other singletons (e.g. the reconcile loop).
 * Single-instance (no Redis) → always leader. With Redis → the elected state,
 * so only ONE instance runs cluster-wide work.
 */
function isLeader() { return _redis ? _isLeader : true; }

module.exports = { start, stop, snapshot, forget, isLeader, S };
