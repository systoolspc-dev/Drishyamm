/**
 * ws.service.js — socket.io real-time channel.
 *
 * Auth model:
 *   Client connects with `auth: { token }` in the socket handshake.
 *   Token is the same JWT used for REST. We verify, attach req.user, and
 *   join the socket to a per-user room: `user:<userId>`.
 *
 * Fanout pattern:
 *   Code emits to a user room — never to all clients — so multi-tenancy is
 *   preserved automatically:
 *     ws.toUser(userId, 'event:detected', payload)
 *
 * Channels (events emitted to clients):
 *   stream.status     { monitorId, status: 'online'|'offline', reason?, reasonCode? }
 *   ai.event          full ai_event row when detector fires
 *   ai.alert          alert dispatch confirmation
 *   ai.live           ephemeral live-overlay frame (bounding boxes only; not persisted)
 *   recording.synced  { recordingId, monitorId, s3Key }
 *
 * Platform operators only (room 'platform-ops'):
 *   A socket asks to join with `ops.join` (ack). The server re-verifies the
 *   handshake JWT, requires the isPlatformAdmin claim AND a live operator row
 *   in the DB; anyone else is refused (ack { ok:false }) and never joins.
 *   platform.event     one decided platform event (platformEvents.service)
 *   platform.counters  { accounts, suspended, signupsToday, cameras } ≥5 s apart
 */

const { Server }       = require('socket.io');
const jwt              = require('jsonwebtoken');
const config           = require('../config/env');
const logger           = require('../config/logger');
const { on, EVENTS }   = require('../events/bus');

let _io = null;

/**
 * Initialize socket.io on top of an existing HTTP server.
 * Must be called once at boot from server.js after `app.listen(...)`.
 */
function init(httpServer) {
  if (_io) return _io;

  _io = new Server(httpServer, {
    cors: {
      origin: config.cors.origins,
      credentials: true,
    },
    // Path matches NGINX upstream config in production
    path: '/socket.io',
    // Reasonable defaults for surveillance UIs (long-lived connections)
    pingInterval: 25_000,
    pingTimeout:  20_000,
  });

  // ── JWT handshake auth ──────────────────────────────────────────────────────
  _io.use((socket, next) => {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('Missing auth token'));

    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      // Suspended account → no live socket either (same rule as authenticate).
      if (require('./accountStatus.service').isBlocked(decoded.id)) {
        return next(new Error('Account suspended'));
      }
      socket.data.userId = decoded.id;
      socket.data.role   = decoded.role;
      socket.data.token  = token;
      next();
    } catch (err) {
      logger.warn('ws auth failed', { error: err.message });
      next(new Error('Invalid token'));
    }
  });

  _io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);
    logger.debug('ws connected', { userId, socketId: socket.id });

    // Live-overlay viewers. AIOverlay tells us which camera it is drawing so
    // the AI can spend full-rate overlay work only where someone is looking
    // (GET /api/internal/ai/viewers, polled by its forwarder). Counted per
    // socket; a socket that drops takes its watches with it.
    socket.on('ai.watch',   (msg) => watchMonitor(socket.id, msg && msg.monitorId));
    socket.on('ai.unwatch', (msg) => unwatchMonitor(socket.id, msg && msg.monitorId));

    // Admin console live activity. Never joined implicitly — a customer socket
    // that asks is refused, and platform events only ever go to this room.
    socket.on('ops.join', (_msg, ack) => {
      const reply = typeof ack === 'function' ? ack : (typeof _msg === 'function' ? _msg : () => {});
      joinOps(socket)
        .then((ok) => {
          if (!ok) socket.emit('ops.denied', { reason: 'Platform operators only.' });
          reply(ok ? { ok: true } : { ok: false, error: 'Platform operators only.' });
        })
        .catch(() => reply({ ok: false, error: 'Could not verify the session.' }));
    });
    socket.on('ops.leave', () => socket.leave(OPS_ROOM));

    socket.on('disconnect', (reason) => {
      unwatchAll(socket.id);
      logger.debug('ws disconnected', { userId, reason });
    });
  });

  // ── Auto-fanout from event bus → connected clients ──────────────────────────
  // Anything we already emit on the in-process bus that's relevant to a user
  // gets pushed to that user's room. Components subscribe by event name.
  on(EVENTS.STREAM_READY,     ({ monitorId, userId }) => toUser(userId, 'stream.status', { monitorId, status: 'online'  }));
  on(EVENTS.STREAM_OFFLINE,   ({ monitorId, userId, reason, reasonCode }) => toUser(userId, 'stream.status', { monitorId, status: 'offline', reason, reasonCode }));
  on(EVENTS.RECORDING_SYNCED, (payload) => {
    if (payload?.userId) toUser(payload.userId, 'recording.synced', payload);
  });
  on(EVENTS.AI_EVENT_DETECTED,({ event, userId }) => toUser(userId, 'ai.event', event));
  on(EVENTS.AI_ALERT_TRIGGERED,({ event, rule, userId }) => toUser(userId, 'ai.alert', { event, rule }));
  // Ephemeral live-overlay frames — fanned out to the viewing user only. These
  // are display-only (bounding boxes) and are never stored; the AIOverlay
  // component subscribes to 'ai.live'.
  on(EVENTS.AI_LIVE_OVERLAY,  ({ userId, frame }) => {
    // Socket fan-out only where a browser is drawing this camera. Producers
    // other than the face engine (the zone-guard's person boxes) keep posting
    // for the zone engine on the bus; nobody watching means nothing to send.
    if (frame && frame.monitorId && !_viewers.has(frame.monitorId)) return;
    // Strip the (heavy) base64 person crops before fanning out to the browser —
    // the on-video overlay only needs bboxes; the crops are for the zone engine.
    const lean = frame && Array.isArray(frame.boxes)
      ? { ...frame, boxes: frame.boxes.map(({ snap, ...b }) => b) }
      : frame;
    toUser(userId, 'ai.live', lean);
  });

  logger.info('socket.io initialized');
  return _io;
}

// ── Platform operators' room ────────────────────────────────────────────────
const OPS_ROOM = 'platform-ops';

/**
 * Verify, server-side and at join time, that this socket belongs to a platform
 * operator: the handshake JWT must still verify and carry isPlatformAdmin, and
 * the user row must still be an active operator (a demoted operator's
 * unexpired token is refused).
 */
async function joinOps(socket) {
  let decoded;
  try { decoded = jwt.verify(socket.data.token, config.jwt.secret); } catch { return false; }
  if (!decoded || decoded.isPlatformAdmin !== true) return false;
  const { User } = require('../models');
  const u = await User.findByPk(decoded.id, { attributes: ['id', 'isPlatformAdmin', 'isActive'] });
  if (!u || u.isPlatformAdmin !== true || u.isActive === false) return false;
  socket.data.isPlatformAdmin = true;
  await socket.join(OPS_ROOM);
  logger.debug('ws ops joined', { userId: decoded.id, socketId: socket.id });
  // The KPI counters right away for this socket; later ones only on change.
  require('./platformEvents.service').computeCounters()
    .then((c) => socket.emit('platform.counters', c))
    .catch(() => { /* counters are best-effort */ });
  return true;
}

/** Emit to connected platform operators only. No-op before init(). */
function toOps(eventName, payload) {
  if (!_io) return;
  _io.to(OPS_ROOM).emit(eventName, payload);
}

/** How many operator sockets are listening (counters are skipped when none). */
function opsCount() {
  if (!_io) return 0;
  return _io.sockets.adapter.rooms.get(OPS_ROOM)?.size || 0;
}

// ── Live-overlay viewers: monitorId -> Set<socketId> ────────────────────────
const _viewers = new Map();

function watchMonitor(socketId, monitorId) {
  if (!monitorId) return;
  let set = _viewers.get(monitorId);
  if (!set) { set = new Set(); _viewers.set(monitorId, set); }
  set.add(socketId);
}

function unwatchMonitor(socketId, monitorId) {
  if (!monitorId) return;
  const set = _viewers.get(monitorId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) _viewers.delete(monitorId);
}

function unwatchAll(socketId) {
  for (const [monitorId, set] of _viewers) {
    set.delete(socketId);
    if (set.size === 0) _viewers.delete(monitorId);
  }
}

/** Cameras with at least one browser drawing the AI overlay right now. */
function getWatchedMonitors() {
  return [..._viewers.keys()];
}

/**
 * Emit an event to all sockets belonging to a single user.
 * Safe to call before init() — becomes a no-op.
 */
function toUser(userId, eventName, payload) {
  if (!_io || !userId) return;
  _io.to(`user:${userId}`).emit(eventName, payload);
}

/** Close every live socket of these users (account suspended). No-op before init(). */
function disconnectUsers(userIds) {
  if (!_io) return;
  for (const id of userIds) _io.in(`user:${id}`).disconnectSockets(true);
}

/** Emit to everyone — admin broadcasts only. Use sparingly. */
function broadcast(eventName, payload) {
  if (!_io) return;
  _io.emit(eventName, payload);
}

module.exports = { init, toUser, toOps, opsCount, OPS_ROOM, broadcast, getWatchedMonitors, disconnectUsers };
