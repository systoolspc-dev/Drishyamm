/**
 * metrics.service.js
 *
 * Prometheus metrics registry — all backend services import the singleton from
 * here and increment / set gauges directly. The /metrics endpoint scrapes
 * `register.metrics()` and is the only thing Prometheus needs to know about.
 *
 * Naming convention: drisyam_<subsystem>_<name>_<unit>
 *   _total   — monotonically increasing counter
 *   _seconds — duration histogram in seconds
 *   _bytes   — sizes in bytes
 *   gauges have no suffix
 *
 * Cardinality discipline ─────────────────────────────────────────────────────
 *
 *   monitor_id is a CHAR(24) — at 2k cameras, that's 2k label values per metric.
 *   Prometheus copes with that fine; the cost is on the scrape side. We keep
 *   high-cardinality labels (monitor_id, server) only on metrics where per-
 *   camera visibility is essential (state, bps_in, transitions). Aggregate
 *   metrics (queue depth, http duration) use bounded labels (route, method,
 *   queue, status) only.
 *
 * Default metrics ────────────────────────────────────────────────────────────
 *   prom-client's collectDefaultMetrics() gives us nodejs_*, process_*,
 *   nodejs_eventloop_lag_seconds, etc. for free — invaluable for capacity work.
 */

const promClient = require('prom-client');

const register = new promClient.Registry();

// Process / Node.js defaults — eventloop lag is the canary for "backend is
// drowning"; CPU/RSS gauges feed capacity dashboards.
promClient.collectDefaultMetrics({
  register,
  prefix: 'drisyam_',
  // Default GC histograms are useful for tuning long-running BullMQ workers
});

// ── Stream supervisor ─────────────────────────────────────────────────────────

const cameraState = new promClient.Gauge({
  name:    'drisyam_camera_state',
  help:    'Per-camera supervisor state (1 if currently in this state, 0 otherwise)',
  labelNames: ['monitor_id', 'state'],
  registers: [register],
});

const cameraBpsIn = new promClient.Gauge({
  name:    'drisyam_camera_bps_in',
  help:    'Per-camera ingress bitrate in bits/second derived from Stream Service bytesReceived',
  labelNames: ['monitor_id'],
  registers: [register],
});

const cameraTransitions = new promClient.Counter({
  name:    'drisyam_camera_transitions_total',
  help:    'Total number of supervisor state transitions',
  labelNames: ['from', 'to'],
  registers: [register],
});

const supervisorIsLeader = new promClient.Gauge({
  name:    'drisyam_supervisor_is_leader',
  help:    '1 if this instance is the supervisor leader, 0 otherwise',
  registers: [register],
});

// ── Stream quality / healing ─────────────────────────────────────────────────

const cameraJitterMs = new promClient.Gauge({
  name:    'drisyam_camera_jitter_ms',
  help:    'Per-camera estimated inter-frame jitter in ms (proxy from bps stddev)',
  labelNames: ['monitor_id'],
  registers: [register],
});

const cameraFieRate = new promClient.Gauge({
  name:    'drisyam_camera_frames_in_error_per_second',
  help:    'Per-camera rate of Stream Service inboundFramesInError (corrupt RTP indicator)',
  labelNames: ['monitor_id'],
  registers: [register],
});

const cameraReaders = new promClient.Gauge({
  name:    'drisyam_camera_readers',
  help:    'Per-camera count of active WebRTC/HLS readers on Stream Service',
  labelNames: ['monitor_id'],
  registers: [register],
});

const cameraQualityWarn = new promClient.Counter({
  name:    'drisyam_camera_quality_warnings_total',
  help:    'Quality warnings emitted, grouped by kind (high-jitter, frames-in-error)',
  labelNames: ['kind'],
  registers: [register],
});

const streamHealsTriggered = new promClient.Counter({
  name:    'drisyam_stream_heals_triggered_total',
  help:    'Active heal actions performed by streamQuality, grouped by reason',
  labelNames: ['reason'],
  registers: [register],
});

const streamHealsRefused = new promClient.Counter({
  name:    'drisyam_stream_heals_refused_total',
  help:    'Heal requests refused (cooldown / budget / patch failure)',
  labelNames: ['reason'],
  registers: [register],
});

// ── Stream Service servers ──────────────────────────────────────────────────────────

const mediamtxServerOnline = new promClient.Gauge({
  name:    'drisyam_mediamtx_server_online',
  help:    '1 if a Stream Service server is reachable and online, 0 otherwise',
  labelNames: ['server'],
  registers: [register],
});

const mediamtxPathsActive = new promClient.Gauge({
  name:    'drisyam_mediamtx_paths_active',
  help:    'Number of ready paths on a Stream Service server',
  labelNames: ['server'],
  registers: [register],
});

const mediamtxCapacityUsed = new promClient.Gauge({
  name:    'drisyam_mediamtx_capacity_ratio',
  help:    'currentCams / capacityCams per Stream Service server',
  labelNames: ['server'],
  registers: [register],
});

// ── Transcoder sidecar ────────────────────────────────────────────────────────

const transcoderActive = new promClient.Gauge({
  name:    'drisyam_transcoder_active',
  help:    'Number of transcoder ffmpeg processes currently running',
  labelNames: ['kind'],   // 'h265-to-h264' | 'low-bitrate'
  registers: [register],
});

// ── Queues (BullMQ) ───────────────────────────────────────────────────────────

const queueJobsTotal = new promClient.Counter({
  name:    'drisyam_queue_jobs_total',
  help:    'Total BullMQ jobs grouped by queue and status',
  labelNames: ['queue', 'status'],   // status: completed | failed | stalled | retried
  registers: [register],
});

const queueDepth = new promClient.Gauge({
  name:    'drisyam_queue_depth',
  help:    'Pending jobs by queue and state (waiting, active, delayed, failed)',
  labelNames: ['queue', 'state'],
  registers: [register],
});

// ── HTTP API ──────────────────────────────────────────────────────────────────

const httpRequestDuration = new promClient.Histogram({
  name:    'drisyam_http_request_seconds',
  help:    'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new promClient.Counter({
  name:    'drisyam_http_requests_total',
  help:    'Total HTTP requests by method, route, status',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// ── AI ingest ─────────────────────────────────────────────────────────────────

const aiEventsIngestedTotal = new promClient.Counter({
  name:    'drisyam_ai_events_ingested_total',
  help:    'AI events accepted by /api/internal/ai/events grouped by detector + result',
  labelNames: ['detector', 'result'],   // result: matched | unknown | error
  registers: [register],
});

// ── Stream bus ────────────────────────────────────────────────────────────────

const busEventsPublished = new promClient.Counter({
  name:    'drisyam_bus_events_published_total',
  help:    'Cross-process Redis Streams events published by stream + type',
  labelNames: ['stream', 'event'],
  registers: [register],
});

const busEventsConsumed = new promClient.Counter({
  name:    'drisyam_bus_events_consumed_total',
  help:    'Cross-process Redis Streams events consumed by stream + group + result',
  labelNames: ['stream', 'group', 'result'],
  registers: [register],
});

// ── HTTP middleware factory ──────────────────────────────────────────────────

/**
 * Express middleware that records request duration + count.
 * Mount AFTER the router so req.route is populated; otherwise label is "unknown".
 */
function httpMiddleware() {
  return function metricsMiddleware(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedNs = Number(process.hrtime.bigint() - start);
      const seconds   = elapsedNs / 1e9;
      const route     = req.route?.path || req.baseUrl || 'unknown';
      const method    = req.method;
      const status    = String(res.statusCode);
      httpRequestDuration.observe({ method, route, status }, seconds);
      httpRequestsTotal.inc({ method, route, status });
    });
    next();
  };
}

module.exports = {
  register,
  // gauges / counters / histograms
  cameraState,
  cameraBpsIn,
  cameraJitterMs,
  cameraFieRate,
  cameraReaders,
  cameraQualityWarn,
  streamHealsTriggered,
  streamHealsRefused,
  cameraTransitions,
  supervisorIsLeader,
  mediamtxServerOnline,
  mediamtxPathsActive,
  mediamtxCapacityUsed,
  transcoderActive,
  queueJobsTotal,
  queueDepth,
  httpRequestDuration,
  httpRequestsTotal,
  aiEventsIngestedTotal,
  busEventsPublished,
  busEventsConsumed,
  // helpers
  httpMiddleware,
};
