/**
 * Internal event bus — single Node EventEmitter shared by all services.
 *
 * Use for cross-service notifications that should not become direct imports
 * (controllers calling services calling other services). Examples:
 *
 *   bus.emit(EVENTS.CAMERA_CREATED, { camera, userId })
 *   bus.on(EVENTS.CAMERA_CREATED, (payload) => { ... })
 *
 * Why an EventEmitter and not BullMQ?
 *   - In-process pub/sub for things that don't need durability (UI fanout, cache
 *     invalidation, search-index upserts on the same node).
 *   - Anything that needs retries / cross-process delivery / backoff goes through
 *     BullMQ instead (alert dispatch, AI event ingest, S3 sync, snapshots).
 *
 * Listeners must be idempotent and never throw — wrap risky work in try/catch
 * because EventEmitter does not isolate listener failures.
 */

const { EventEmitter } = require('node:events');
const logger = require('../config/logger');

// One shared bus for the process. Increase max listeners — many services subscribe.
const bus = new EventEmitter();
bus.setMaxListeners(50);

// Catch-all for listener errors so a buggy subscriber never crashes the emitter.
bus.on('error', (err) => {
  logger.error('event-bus listener error', { error: err.message, stack: err.stack });
});

/**
 * Typed event channels. Keep this list short and meaningful — every name here is
 * a contract. Payload shapes are documented in JSDoc next to each emit site.
 */
const EVENTS = Object.freeze({
  // Camera lifecycle (emitted by cameraGroup.controller)
  CAMERA_CREATED:  'camera.created',     // { camera, userId }
  CAMERA_UPDATED:  'camera.updated',     // { camera, userId, changedFields }
  CAMERA_DELETED:  'camera.deleted',     // { monitorId, userId, groupId }
  GROUP_CREATED:   'group.created',      // { group, userId }
  GROUP_DELETED:   'group.deleted',      // { groupId, userId }

  // Stream / recording
  STREAM_READY:        'stream.ready',         // { monitorId, userId }
  STREAM_OFFLINE:      'stream.offline',       // { monitorId, userId }
  RECORDING_SYNCED:    'recording.synced',     // { recordingId, monitorId, s3Key, startedAt, endedAt }

  // AI pipeline (emitted by aiEvents.service when worker posts an event)
  AI_EVENT_DETECTED:  'ai.event.detected',     // { event, userId } — full normalized event row
  AI_ALERT_TRIGGERED: 'ai.alert.triggered',    // { event, rule, userId }
  // Ephemeral live-overlay frame — drives the on-video bounding boxes only.
  // NOT persisted, NOT an alert; high-frequency, safe to drop. See
  // internal.routes POST /ai/overlay and ws.service 'ai.live'.
  AI_LIVE_OVERLAY:    'ai.live.overlay',        // { userId, frame } — { monitorId, ts, frameW, frameH, boxes[] }
});

/**
 * Helper that wraps a listener to (a) auto-log errors and (b) ensure listeners
 * never crash the bus. Prefer this over raw `bus.on(...)`.
 */
function on(eventName, handler) {
  bus.on(eventName, async (payload) => {
    try {
      await handler(payload);
    } catch (err) {
      logger.error(`event-bus handler failed for ${eventName}`, {
        error: err.message,
        stack: err.stack,
      });
    }
  });
}

/**
 * Emit with logging at debug level so the event flow is observable in dev.
 */
function emit(eventName, payload) {
  logger.debug(`event-bus emit: ${eventName}`, {
    keys: payload ? Object.keys(payload) : [],
  });
  bus.emit(eventName, payload);
}

module.exports = { bus, EVENTS, on, emit };
