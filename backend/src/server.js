// Load and validate environment first
const http = require('node:http');

const config        = require('./config/env');
const logger        = require('./config/logger');
const { sequelize } = require('./models');
const app           = require('./app');
const recordingSync = require('./services/recordingSync.service');
const wsService     = require('./services/ws.service');
const queueWorkers  = require('./queues/workers');
const queues        = require('./queues');
const streamSupervisor = require('./services/streamSupervisor.service');
const streamReconcile = require('./services/streamReconcile.service');
const streamQuality    = require('./services/streamQuality.service');
const streamBus        = require('./services/streamBus.service');
const aiLifecycle      = require('./services/aiLifecycle.service');
const aiEventRetention = require('./services/aiEventRetention.service');
const s3Retention      = require('./services/s3Retention.service');
const recordingBackfill = require('./services/recordingBackfill.service');
const transcoder       = require('./services/transcoder.service');
const streamingService = require('./services/drishyamStreaming.service');
const { bus, EVENTS }  = require('./events/bus');

const PORT = config.port;

function isTransientNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error || '');
  return (
    ['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(code) ||
    /write EPIPE|socket hang up|connection reset|network socket disconnected/i.test(message)
  );
}

async function startServer() {
  try {
    // Verify database connection
    await sequelize.authenticate();
    logger.info('Database connection established successfully.');

    // Schema is managed by migrations (sequelize-cli db:migrate in the start
    // command). sequelize.sync() is DISABLED: with cyclic-FK models it issues
    // ALTER ... UNIQUE on every boot, adding a duplicate index each time until
    // MySQL's 64-key limit crash-loops startup. (disabled 2026-10-12)

    // Create the HTTP server explicitly so socket.io can attach to it.
    const server = http.createServer(app);

    // Attach socket.io BEFORE listen so the upgrade handler is registered.
    wsService.init(server);
    // Live relay video socket (/api/stream/live): fMP4 over WebSocket, see liveRelay.service.js.
    require("./services/liveRelay.service").attach(server);

    server.listen(PORT, async () => {
      logger.info(`Server running on port ${PORT} in ${config.env} mode`);
      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info(`WS  available at ws://localhost:${PORT}/socket.io`);
      logger.info(`Health check at http://localhost:${PORT}/api/health`);

      // Suspended accounts: authenticate refuses their tokens from this set.
      require('./services/accountStatus.service').start();

      // Admin console live activity: coalesced camera/NVR status, camera
      // add/remove bursts, service health transitions → platform_events +
      // the operators' socket room. Must subscribe before the supervisor starts.
      require('./services/platformEvents.service').start();

      // Prefer BullMQ for background work. Fall back to legacy intervals
      // only if BullMQ can't connect to Redis (dev without Redis running).
      // Occupancy history: 5s ticks → minute rows → 15m/1h/1d rollups.
      // Leader-elected via Redis so replicas don't double-write.
      try {
        require('./services/occupancyAggregator.service').start();
        // Room-level capacity FSM: one alert per ROOM, paired breach→clear,
        // incidents persisted so a restart doesn't re-alert.
        require('./services/occupancyEvaluator.service').start();
      } catch (e) {
        logger.warn('occupancy aggregator failed to start', { error: e.message });
      }

      const bullmqOk = await queueWorkers.start();
      if (!bullmqOk) {
        logger.warn('Using legacy setInterval workers (no Redis)');
        recordingSync.start();
      }

      // Cross-process event bus — best effort, no-op if Redis missing.
      // Must start BEFORE the supervisor so its bridge is wired.
      await streamBus.start().catch((err) => {
        logger.warn('streamBus failed to start (continuing without cross-process bus)', { error: err.message });
      });

      // Real-time camera health watcher. Idempotent; only the leader tick does work.
      streamSupervisor.start().catch((err) => {
        logger.warn('streamSupervisor failed to start (continuing without supervisor)', { error: err.message });
      });

      // Continuous DB → Stream Service config sync (retention drift self-heal).
      // The API applies retention changes immediately; this loop re-converges
      // Stream Service after restarts / failed patches / site-level changes.
      streamReconcile.start();

      // Keep the persisted "AI Detection Cameras" list aligned with the
      // vms_face runtime: selected cameras run continuously, unselected ones stop.
      aiLifecycle.start();

      // Restricted-zone intrusion engine — evaluates live AI overlay boxes
      // against the user's RestrictedZones (K-of-N confirm + dwell + zone
      // cooldown) and emits zone.intrusion events → toasts/bell/email.
      require('./services/zoneIntrusion.service').init();

      // Prune the backend ai_events mirror so it can't grow unbounded (the AI
      // service prunes its own Postgres store; this covers the MySQL copy).
      aiEventRetention.start();

      // Enforce recording retention on the DURABLE 10pb copy (Stream Service only
      // bounds the local NAS). OFF by default; runs dry-run until S3_RETENTION_
      // DELETE=1 — review the "would delete" logs before enabling deletion.
      s3Retention.start();

      // Fill cloud-recording gaps (site link outages) from the NVR's own HDD
      // once the camera is back. BACKFILL_ENABLED=0 turns it off.
      recordingBackfill.start();

      // When a camera is deleted (any route), drop its in-memory supervisor +
      // quality state so the maps don't leak and a recycled monitorId can't
      // inherit a stale state machine. The Stream Service path teardown is handled by
      // the delete handlers + the watchdog's orphan reconciliation.
      bus.on(EVENTS.CAMERA_DELETED, ({ monitorId }) => {
        if (!monitorId) return;
        try { streamSupervisor.forget(monitorId); } catch (_) {}
        try { streamQuality.forget(monitorId); } catch (_) {}
        // Stop any transcoder FFmpeg for this camera. Without this the process
        // keeps running and republishing to its cam_<id>_h264 path, so the
        // stream lingers (zombie) and reappears after the watchdog deletes it
        // (duplicate). SIGTERM is treated as a deliberate stop (no auto-restart)
        // and the _processes entry is cleared on exit.
        try { transcoder.stopTranscoder(monitorId); } catch (_) {}
        // Remove the transcoded paths it produced so they don't linger.
        for (const name of [
          transcoder.transcodedPathName(monitorId),
          transcoder.transcodedSubPathName(monitorId),
          transcoder.transcodedLowPathName(monitorId),
        ]) {
          try { streamingService.deletePathByName(name).catch(() => {}); } catch (_) {}
        }
      });
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);

      server.close(async () => {
        logger.info('HTTP server closed.');
        recordingSync.stop();
        recordingBackfill.stop();
        aiLifecycle.stop();
        streamReconcile.stop();
        await streamSupervisor.stop().catch(() => {});
        await streamBus.stop().catch(() => {});
        await queues.shutdown();
        await sequelize.close();
        logger.info('Database connection closed.');
        process.exit(0);
      });

      // Force shutdown after 10s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  if (isTransientNetworkError(reason)) {
    logger.warn('Transient network rejection ignored:', reason);
    return;
  }

  logger.error('Unhandled Rejection:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  if (isTransientNetworkError(error)) {
    logger.warn('Transient network exception ignored:', error);
    return;
  }

  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();
