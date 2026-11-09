/**
 * StreamServiceEngine — StreamingEngine implementation backed by Stream Service.
 *
 * Talks to the Stream Service REST control API (default http://localhost:9997):
 *   - Pulls RTSP from IP cameras (port 8554)
 *   - Serves WebRTC WHEP for live single-view (port 8889, sub-500ms)
 *   - Serves HLS for grid/mobile (port 8888, ~2s latency)
 *   - Records segmented MP4 to a shared volume (Node reads, uploads to S3)
 *
 * Camera paths follow the convention cam_<monitorId> so the watchdog can filter
 * on the namespace. All control calls carry bounded transient-retry so a brief
 * engine blip doesn't leave a stale/zombie path.
 */
const axios  = require('axios');
const config = require('../../config/env');
const logger = require('../../config/logger');
const AppError = require('../../utils/AppError');
const vendors = require('../vendors');
const StreamingEngine = require('./StreamingEngine');

// ── Recording config written to every camera path ─────────────────────────────
// recordDeleteAfter: 0s means Stream Service never auto-deletes; Node manages lifecycle.
const RECORD_PATH    = '/recordings/%path/%Y-%m-%d/%H-%M-%S-%f';
const RECORD_SEGMENT = config.streamService.segmentDuration || '10m0s';

// Accounts whose cameras record the MAIN stream continuously, as a comma-separated
// list of user UUIDs. This exists so recording can be switched on for ONE tenant
// without RECORD_CONTINUOUS=1 turning it on estate-wide — full-res continuous
// recording across every camera is what knocked recorders offline before.
//
// Recording on the main path (not the sub) is deliberate: recordingSync's
// syncCamera() scans /recordings/<pathName(monitorId)>, i.e. the main path's
// directory, so only main-path segments are ever uploaded to S3.
//
// Empty (the default) → nobody records, exactly as before this change.
const RECORD_USER_IDS = new Set(
  (process.env.RECORD_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const recordsForAccount = (userId) => !!userId && RECORD_USER_IDS.has(userId);

// Transient-failure retry for engine CONTROL calls (add/patch/delete path). A
// brief engine blip during a delete would otherwise leave a path configured — a
// zombie stream until the watchdog reconciles. Retries turn the common blip into
// a non-event; the watchdog stays the last-resort safety net.
const ENGINE_RETRIES    = 3;
const ENGINE_BACKOFF_MS = [200, 600, 1500];

// How long the MAIN (fullscreen) NVR pull is held after its last reader.
const MAIN_SOURCE_CLOSE_AFTER = process.env.MAIN_SOURCE_CLOSE_AFTER || '30s';

class StreamServiceEngine extends StreamingEngine {
  constructor() {
    super();
    this._engineName = 'stream-service';
    this.api = axios.create({
      baseURL: config.streamService.apiUrl,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
      auth: {
        username: config.streamService.apiUser,
        password: config.streamService.apiPass,
      },
    });
  }

  get engineName() { return this._engineName; }

  /** Active engine name + control API base — for status/health/diagnostics. */
  engineInfo() {
    return { engine: this._engineName, controlApi: config.streamService.apiUrl };
  }

  // ── Engine control resilience helpers ───────────────────────────────────────

  /** A failure worth retrying: no HTTP response (network) or a 5xx. 4xx
   *  (including 404) are definitive answers — never retried. */
  _isTransient(err) {
    return !err.response || err.response.status >= 500;
  }

  _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /**
   * Add-or-patch a path with transient retry. POST creates; on 400/409 (already
   * exists) it PATCHes → idempotent. Throws on failure when `fatal` is true
   * (main path); returns false without throwing when `fatal` is false.
   */
  async _putPath(name, pathConfig, { logLabel = 'path', fatal = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.api.post(`/v3/config/paths/add/${name}`, pathConfig);
        return true;
      } catch (err) {
        const st = err.response?.status;
        if (st === 400 || st === 409) {
          try {
            await this.api.patch(`/v3/config/paths/patch/${name}`, pathConfig);
            return true;
          } catch (patchErr) {
            if (attempt < ENGINE_RETRIES && this._isTransient(patchErr)) {
              await this._sleep(ENGINE_BACKOFF_MS[attempt] ?? 1500); continue;
            }
            logger.error(`DrishyamStreaming[stream-service]: ${logLabel} patch failed`, { name, error: patchErr.message });
            if (fatal) throw new AppError('Failed to configure camera in media engine.', 502);
            return false;
          }
        }
        if (attempt < ENGINE_RETRIES && this._isTransient(err)) {
          await this._sleep(ENGINE_BACKOFF_MS[attempt] ?? 1500); continue;
        }
        logger.error(`DrishyamStreaming[stream-service]: ${logLabel} add failed`, { name, error: err.message });
        if (fatal) throw new AppError('Failed to add camera to media engine.', 502);
        return false;
      }
    }
  }

  /**
   * DELETE a path with transient retry. Returns true if the path is GONE
   * (deleted now, or already absent → 404), false only if every attempt failed
   * (the watchdog's orphan pass is the fallback).
   */
  async _deletePath(name, { logLabel = 'path' } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.api.delete(`/v3/config/paths/delete/${name}`);
        return true;
      } catch (err) {
        if (err.response?.status === 404) return true; // already gone
        if (attempt < ENGINE_RETRIES && this._isTransient(err)) {
          await this._sleep(ENGINE_BACKOFF_MS[attempt] ?? 1500); continue;
        }
        logger.warn(`DrishyamStreaming[stream-service]: delete ${logLabel} failed after retries (watchdog will reconcile)`,
          { name, error: err.message });
        return false;
      }
    }
  }

  // ── Path naming ─────────────────────────────────────────────────────────────

  /** Camera path name: "cam_<monitorId>" */
  pathName(monitorId) {
    return `cam_${monitorId}`;
  }

  /** Extract monitorId from a path name */
  monitorIdFromPath(name) {
    return name.startsWith('cam_') ? name.slice(4) : null;
  }

  /** Sub-stream path name: "cam_<monitorId>_sub" */
  subPathName(monitorId) {
    return `cam_${monitorId}_sub`;
  }

  /**
   * Derive the RTSP sub-stream path from the main stream path via the vendor
   * registry (Hikvision N01→N02, Dahua subtype, Uniview s0→s1, Bosch inst=1→2,
   * Hanwha profileN→N+1). Returns null when none match.
   */
  deriveSubPath(mainPath) {
    return vendors.deriveSubPath(mainPath);
  }

  // ── RTSP URL builder ────────────────────────────────────────────────────────

  /** Build a full RTSP URL; password is URI-encoded so @/#/% don't break it. */
  buildRtspUrl({ host, port, path: rtspPath, username, password }) {
    const encodedPass = password ? encodeURIComponent(password) : '';
    const auth        = username ? `${username}:${encodedPass}@` : '';
    const safePath    = rtspPath
      ? (rtspPath.startsWith('/') ? rtspPath : `/${rtspPath}`)
      : '/';
    return `rtsp://${auth}${host}:${port || 554}${safePath}`;
  }

  // ── Camera path management ──────────────────────────────────────────────────

  /**
   * Add a camera. Stream Service starts pulling RTSP (and recording, if continuous).
   * Idempotent — patches on "already exists".
   */
  async addCamera(monitorId, camConfig) {
    const name    = this.pathName(monitorId);
    const rtspUrl = this.buildRtspUrl(camConfig);

    // Default on-demand: remote NVRs / office uplink can't sustain many
    // continuous full-res pulls. RECORD_CONTINUOUS=1 restores always-on 24/7
    // recording; SOURCE_ALWAYS_ON=1 keeps sources live without forcing record.
    // Per-account opt-in (RECORD_USER_IDS) OR the global RECORD_CONTINUOUS=1.
    // camConfig.userId is supplied by both call sites (recordingSync's watchdog
    // and stream.service); if it is ever absent this evaluates false, so the
    // safe default is "do not record".
    const continuous = process.env.RECORD_CONTINUOUS === '1' || recordsForAccount(camConfig.userId);
    const alwaysOn   = continuous || process.env.SOURCE_ALWAYS_ON === '1';
    const pathConfig = {
      source:                rtspUrl,
      sourceOnDemand:        !alwaysOn,
      // How long the RTSP pull is held after the LAST reader leaves.
      //
      // At the old 20 s this produced a reconnect storm: a transcoder idles out,
      // the pull closes, something asks again seconds later and the whole
      // RTSP handshake runs again — measured cycling every ~75 s per camera,
      // around the clock. Hikvision NVRs throttle rapid reconnects, so the
      // cameras that "randomly" failed were the ones caught mid-cycle.
      //
      // Holding the pull across a viewing session removes the churn without
      // permanent sessions: an unwatched camera still releases its session, so
      // we do NOT repeat the always-on config that once jammed a customer's
      // NVR (see addCameraSubStream). Bandwidth is not the constraint —
      // measured 0.5 Mbps main / 0.12 Mbps sub.
      //
      // EXCEPT for main, which is only pulled for a fullscreen view and costs
      // the customer's uplink several sub-streams' worth: held 5 min after
      // every fullscreen it starved the grid on a ~2.7 Mbit/s site
      // (2026-10-20). The transcoder already keeps it 60 s after the viewer
      // leaves, so re-entering fullscreen soon after doesn't reconnect.
      sourceOnDemandCloseAfter: MAIN_SOURCE_CLOSE_AFTER,
      sourceProtocol:        'tcp',     // TCP avoids UDP loss / FU-A fragmentation
      record:                continuous,
      recordPath:            RECORD_PATH,
      recordSegmentDuration: RECORD_SEGMENT,
      recordDeleteAfter:     '0s',      // never auto-delete; Node manages lifecycle
    };

    await this._putPath(name, pathConfig, { logLabel: 'camera path', fatal: true });
    logger.info('DrishyamStreaming[stream-service]: camera path added', {
      name, host: camConfig.host, record: continuous, segment: RECORD_SEGMENT,
    });
  }

  /** Remove a camera path (stops RTSP pull + recording). Returns true if gone. */
  async removeCamera(monitorId) {
    const name = this.pathName(monitorId);
    const gone = await this._deletePath(name, { logLabel: 'camera path' });
    if (gone) logger.info('DrishyamStreaming[stream-service]: camera path removed', { name });
    return gone;   // callers may confirm teardown; false → watchdog reconciles
  }

  /**
   * Add a camera's sub-stream — and RECORD HERE by default.
   *
   * Recording deliberately runs on the SUB-stream, never main: the sub-stream is a
   * fraction of main's bitrate, so 24/7 recording fits the same uplink that full-res
   * recording saturated (the reason RECORD_CONTINUOUS was reverted after it knocked
   * cameras offline). Continuous recording needs the source held open, so this path
   * is always-on rather than on-demand.
   *
   * DEFAULT IS OFF (opt-in), because recording the sub-stream forces
   * `sourceOnDemand: false` — i.e. ONE PERMANENT RTSP SESSION PER CAMERA, 24/7.
   * Entry-level NVRs only serve a handful of concurrent sessions, and that
   * config is what jammed a customer's Hikvision (all cameras offline until it
   * was rebooted). Nothing currently consumes these recordings either:
   * recordingSync uploads from `pathName()` (main) only, and playback is served
   * from S3 — so the default was paying the full NVR + uplink + disk cost for
   * no product function. Turn it on deliberately, per deployment, only where
   * the NVR and uplink have been sized for permanent sessions.
   *
   *   RECORD_SUB=1        → opt IN (always-on source + sub-stream recording)
   *   RECORD_DELETE_AFTER → retention, default 168h (7 days), so the disk can't fill
   *   RECORD_CONTINUOUS=1 → ALSO record main full-res (warning: saturates remote NVRs)
   */
  async addCameraSubStream(monitorId, camConfig) {
    const name      = this.subPathName(monitorId);
    const rtspUrl   = this.buildRtspUrl(camConfig);
    // Opt-in: see the NVR-session warning above before enabling.
    const recordSub = process.env.RECORD_SUB === '1';
    const pathConfig = {
      source:         rtspUrl,
      sourceOnDemand: !recordSub,   // recording requires the source to stay connected
      // Same anti-churn reasoning as the main path above. Still on-demand, so
      // an unwatched camera releases its NVR session.
      sourceOnDemandCloseAfter: process.env.SOURCE_CLOSE_AFTER || '5m',
      sourceProtocol: 'tcp',
      record:         recordSub,
      ...(recordSub ? {
        recordPath:            RECORD_PATH,
        recordSegmentDuration: RECORD_SEGMENT,
        // Auto-delete old segments. 24/7 recording WILL fill a disk otherwise —
        // the main path's legacy '0s' (never delete) is only safe because it
        // doesn't actually record.
        recordDeleteAfter:     process.env.RECORD_DELETE_AFTER || '168h',
      } : {}),
    };
    const ok = await this._putPath(name, pathConfig, { logLabel: 'sub-stream path', fatal: false });
    if (ok) logger.info('DrishyamStreaming[stream-service]: sub-stream path added', { name, record: recordSub });
  }

  /** Remove the sub-stream path (called alongside removeCamera). */
  async removeCameraSubStream(monitorId) {
    return this._deletePath(this.subPathName(monitorId), { logLabel: 'sub-stream path' });
  }

  /**
   * Delete an arbitrary configured path by exact name. Used by the watchdog's
   * orphan-reconciliation pass. Returns true if gone, false on error.
   */
  async deletePathByName(name) {
    const gone = await this._deletePath(name, { logLabel: 'orphan path' });
    if (gone) logger.info('DrishyamStreaming[stream-service]: orphan path removed', { name });
    return gone;
  }

  // ── Status queries ──────────────────────────────────────────────────────────

  /** Live runtime info for a single path, or null if absent / engine down. */
  /**
   * Bring an EXISTING main path's hold time in line with
   * MAIN_SOURCE_CLOSE_AFTER: paths created before it changed keep 5 min. Only
   * that one field is patched (a full re-PUT would reset retention), once per
   * camera per process; an unchanged value is a no-op in Stream Service.
   */
  async ensureMainCloseAfter(monitorId) {
    this._mainCloseAfterDone ||= new Set();
    if (this._mainCloseAfterDone.has(monitorId)) return;
    this._mainCloseAfterDone.add(monitorId);
    try {
      await this.api.patch(`/v3/config/paths/patch/${this.pathName(monitorId)}`, {
        sourceOnDemandCloseAfter: MAIN_SOURCE_CLOSE_AFTER,
      });
    } catch (err) {
      logger.debug('DrishyamStreaming[stream-service]: main close-after patch failed', { monitorId, error: err.message });
    }
  }

  async getPath(monitorId) {
    const name = this.pathName(monitorId);
    try {
      const { data } = await this.api.get(`/v3/paths/get/${name}`);
      return data;
    } catch (err) {
      if (err.response?.status === 404) return null;
      logger.debug('DrishyamStreaming[stream-service]: getPath failed', { name, error: err.message });
      return null;
    }
  }

  /** True if the camera stream is currently active (RTSP feed received). */
  async isReady(monitorId) {
    const info = await this.getPath(monitorId);
    return info?.ready === true;
  }

  /**
   * Walk EVERY page of a Stream Service list endpoint.
   *
   * These endpoints are paginated and default to 100 items per page. Reading
   * only the first page silently truncates the fleet at ~50 cameras (each
   * camera owns 2 paths: `cam_<id>` and `cam_<id>_sub`), and a truncated list
   * is actively harmful rather than merely incomplete: the watchdog treats any
   * path it can't see as MISSING and re-adds it every cycle, and a re-add is a
   * real config write that makes the media server tear down and re-open the
   * RTSP source. That turns into a permanent reconnect storm against the NVR —
   * the exact behaviour the per-NVR rate limits exist to prevent.
   *
   * Returns [] if the engine is unreachable; returns whatever was collected if
   * a later page fails, so a partial read degrades instead of losing everything.
   */
  async _listAllPages(endpoint, logLabel) {
    const PER_PAGE  = 1000;   // one round-trip for any realistic single-server fleet
    const MAX_PAGES = 100;    // runaway guard; 100k paths is far beyond any real deployment
    const items = [];
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- pages must be fetched in order
        const { data } = await this.api.get(endpoint, { params: { page, itemsPerPage: PER_PAGE } });
        const batch = data?.items ?? [];
        items.push(...batch);

        const pageCount = Number(data?.pageCount);
        // Stop on the server's own page count when it gives one, else when a
        // short/empty page proves we've reached the end.
        if (Number.isFinite(pageCount) ? page + 1 >= pageCount : batch.length < PER_PAGE) break;
      }
    } catch (err) {
      logger.debug(`DrishyamStreaming[stream-service]: ${logLabel} failed`, {
        error: err.message, collected: items.length,
      });
    }
    return items;
  }

  /** All ACTIVE paths (streaming now). [] if engine unreachable. */
  async listPaths() {
    return this._listAllPages('/v3/paths/list', 'listPaths');
  }

  /** All CONFIGURED paths (incl. not-yet-streaming). Used by the watchdog. */
  async listConfiguredPaths() {
    return this._listAllPages('/v3/config/paths/list', 'listConfiguredPaths');
  }

  // ── URL builders ────────────────────────────────────────────────────────────

  /** WebRTC WHEP URL — sub-500ms, primary egress for single-camera live view. */
  getWebrtcUrl(monitorId) {
    return `${config.streamService.webrtcUrl}/${this.pathName(monitorId)}`;
  }

  /** HLS URL — ~2s latency, reliable fallback for grid view and mobile. */
  getHlsUrl(monitorId) {
    return `${config.streamService.hlsUrl}/${this.pathName(monitorId)}/index.m3u8`;
  }

  /** HLS URL for the sub-stream (lower bitrate/resolution) — grid tiles. */
  getHlsSubUrl(monitorId) {
    return `${config.streamService.hlsUrl}/${this.subPathName(monitorId)}/index.m3u8`;
  }

  /** RTSP egress URL for the AI worker / sidecars. Internal-only. */
  getRtspEgressUrl(monitorId, sub = false) {
    const host = config.streamService.rtspHost || 'localhost';
    const port = config.streamService.rtspPort || 8554;
    const name = sub ? this.subPathName(monitorId) : this.pathName(monitorId);
    return `rtsp://${host}:${port}/${name}`;
  }
}

module.exports = StreamServiceEngine;
