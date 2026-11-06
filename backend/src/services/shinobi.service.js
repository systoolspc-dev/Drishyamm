const axios = require('axios');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');

class ShinobiService {
  constructor() {
    this.client = axios.create({
      baseURL: config.shinobi.url,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get all cameras (monitors) for a group
   * URL: GET /{apiKey}/monitor/{groupKey}
   */
  async getCameras(apiKey, groupKey) {
    try {
      const { data } = await this.client.get(`/${apiKey}/monitor/${groupKey}`);
      return data;
    } catch (error) {
      logger.error('Shinobi getCameras failed', { error: error.message });
      throw new AppError('Failed to fetch cameras from VMS server.', 502);
    }
  }

  /**
   * Get a single camera
   * URL: GET /{apiKey}/monitor/{groupKey}/{monitorId}
   */
  async getCamera(apiKey, groupKey, monitorId) {
    try {
      const { data } = await this.client.get(`/${apiKey}/monitor/${groupKey}/${monitorId}`);
      return data;
    } catch (error) {
      logger.error('Shinobi getCamera failed', { monitorId, error: error.message });
      throw new AppError('Failed to fetch camera from VMS server.', 502);
    }
  }

  /**
   * Add a new camera (monitor)
   * URL: POST /{apiKey}/configureMonitor/{groupKey}/{monitorId}
   * Body: { data: JSON.stringify(monitorConfig) }
   */
  async addCamera(apiKey, groupKey, monitorId, cameraConfig) {
    try {
      const shinobiConfig = this._buildShinobiConfig(monitorId, groupKey, cameraConfig);
      const { data } = await this.client.post(
        `/${apiKey}/configureMonitor/${groupKey}/${monitorId}`,
        { data: JSON.stringify(shinobiConfig) }
      );
      return data;
    } catch (error) {
      logger.error('Shinobi addCamera failed', { monitorId, error: error.message });
      throw new AppError('Failed to add camera to VMS server.', 502);
    }
  }

  /**
   * Update camera configuration
   * URL: POST /{apiKey}/configureMonitor/{groupKey}/{monitorId}
   * Body: { data: JSON.stringify(monitorConfig) }
   */
  async updateCamera(apiKey, groupKey, monitorId, cameraConfig) {
    try {
      const shinobiConfig = this._buildShinobiConfig(monitorId, groupKey, cameraConfig);
      const { data } = await this.client.post(
        `/${apiKey}/configureMonitor/${groupKey}/${monitorId}`,
        { data: JSON.stringify(shinobiConfig) }
      );
      return data;
    } catch (error) {
      logger.error('Shinobi updateCamera failed', { monitorId, error: error.message });
      throw new AppError('Failed to update camera on VMS server.', 502);
    }
  }

  /**
   * Stop a monitor (needed before recording config takes effect on running monitors)
   * URL: GET /{apiKey}/monitor/{groupKey}/{monitorId}/stop
   */
  async stopMonitor(apiKey, groupKey, monitorId) {
    try {
      const { data } = await this.client.get(
        `/${apiKey}/monitor/${groupKey}/${monitorId}/stop`
      );
      return data;
    } catch (error) {
      logger.warn('Shinobi stopMonitor failed', { monitorId, error: error.message });
    }
  }

  /**
   * Start a monitor in RECORD mode (saves MP4 files AND streams HLS).
   *
   * IMPORTANT: Always stop first, then call /record.
   * If the monitor is already in mode='record', calling /record again returns
   * "Monitor mode is already : record" and does NOT restart FFmpeg.
   * Stopping first resets the mode so /record actually triggers FFmpeg.
   */
  async startMonitor(apiKey, groupKey, monitorId) {
    try {
      // Stop first to clear the current mode (otherwise Shinobi ignores /record)
      await this.client.get(`/${apiKey}/monitor/${groupKey}/${monitorId}/stop`);
      await new Promise((r) => setTimeout(r, 1000));
      const { data } = await this.client.get(
        `/${apiKey}/monitor/${groupKey}/${monitorId}/record`
      );
      return data;
    } catch (error) {
      logger.warn('Shinobi startMonitor failed', { monitorId, error: error.message });
    }
  }

  /**
   * Delete a camera
   * URL: GET /{apiKey}/monitor/{groupKey}/{monitorId}/delete
   */
  async deleteCamera(apiKey, groupKey, monitorId) {
    try {
      const { data } = await this.client.get(
        `/${apiKey}/monitor/${groupKey}/${monitorId}/delete`
      );
      return data;
    } catch (error) {
      logger.error('Shinobi deleteCamera failed', { monitorId, error: error.message });
      throw new AppError('Failed to delete camera from VMS server.', 502);
    }
  }

  /**
   * Get recordings for a camera within a date range
   * URL: GET /{apiKey}/videos/{groupKey}/{monitorId}
   */
  async getRecordings(apiKey, groupKey, monitorId, start, end) {
    try {
      const { data } = await this.client.get(
        `/${apiKey}/videos/${groupKey}/${monitorId}`,
        { params: { start, end } }
      );
      return data;
    } catch (error) {
      logger.error('Shinobi getRecordings failed', { monitorId, error: error.message });
      throw new AppError('Failed to fetch recordings from VMS server.', 502);
    }
  }

  /**
   * Delete a local recording from Shinobi disk (called after successful S3 upload)
   * URL: GET /{apiKey}/videos/{groupKey}/{monitorId}/{filename}/delete
   */
  async deleteRecording(apiKey, groupKey, monitorId, filename) {
    try {
      await this.client.get(
        `/${apiKey}/videos/${groupKey}/${monitorId}/${encodeURIComponent(filename)}/delete`
      );
    } catch (error) {
      // Non-fatal — log and continue; S3 already has the file
      logger.warn('Shinobi deleteRecording failed', { monitorId, filename, error: error.message });
    }
  }

  /**
   * Provision a new Shinobi user/group (called after payment)
   * URL: POST /super/{superApiKey}/accounts/registerAdmin
   * Body: { data: JSON.stringify(userConfig) }
   * Then fetches auth token from accounts/list.
   */
  async provisionUser(email) {
    try {
      const ke = crypto.randomBytes(16).toString('hex');
      const uid = crypto.randomBytes(10).toString('hex');
      const pass = this._generateRandomPassword();

      const details = JSON.stringify({
        sub: true,
        allmonitors: '1',
        monitor_create: '1',
        monitor_edit: '1',
        monitor_delete: '1',
        video_delete: '1',
        video_view: '1',
      });

      const { data } = await this.client.post(
        `/super/${config.shinobi.superApiKey}/accounts/registerAdmin`,
        { data: JSON.stringify({ mail: email, pass, pass_again: pass, ke, uid, details }) }
      );

      if (!data || !data.ok) {
        throw new Error(`Shinobi registration failed: ${data && data.msg}`);
      }

      // Fetch the auth token Shinobi generated for this user
      const listRes = await this.client.get(
        `/super/${config.shinobi.superApiKey}/accounts/list`
      );
      const users = listRes.data && listRes.data.users;
      const user = Array.isArray(users) ? users.find((u) => u.mail === email) : null;

      if (!user || !user.auth) {
        throw new Error('Could not retrieve auth token for provisioned user');
      }

      return { groupKey: user.ke, apiKey: user.auth };
    } catch (error) {
      logger.error('Shinobi provisionUser failed', { email, error: error.message });
      throw new AppError('Failed to provision VMS account.', 502);
    }
  }

  _buildShinobiConfig(monitorId, groupKey, cameraConfig) {
    const { username, password, host, port, path, protocol, name, type, width, height, fps } = cameraConfig;
    // Build full RTSP URL with URL-encoded password for special chars (@, #, %, etc.)
    // encodeURIComponent ensures @ → %40, # → %23, etc. so the URL is valid.
    // FFmpeg decodes %40 back to @ before sending credentials to the camera — this is correct behaviour.
    const encodedPassword = password ? encodeURIComponent(password) : '';
    const auth = username ? `${username}:${encodedPassword}@` : '';
    const streamPath = path && !path.startsWith('/') ? `/${path}` : (path || '/');
    const rtspProtocol = protocol || 'rtsp';
    const fullUrl = `${rtspProtocol}://${auth}${host}:${port || 554}${streamPath}`;

    return {
      mid: monitorId,
      ke: groupKey,
      name,
      type: type || 'h264',
      ext: 'mp4',
      mode: 'record',     // 'record' = record MP4 to disk AND stream HLS (never use 'start' — HLS-only, no recording)
      protocol: rtspProtocol,
      host: host,
      port: String(port || 554),
      path: streamPath,
      fps: String(fps || '30'),
      width: String(width || '1920'),
      height: String(height || '1080'),
      details: JSON.stringify({
        // auto_host: full RTSP URL with URL-encoded password — used by Shinobi as the FFmpeg -i input directly.
        // auto_host_enable: '1' tells Shinobi to use this URL instead of building one from muser/mpass/host.
        auto_host: fullUrl,
        auto_host_enable: '1',
        // muser/mpass: RAW (un-encoded) credentials — used by Shinobi's internal URL builder
        // as a fallback when auto_host_enable is not respected. Do NOT pre-encode here;
        // Shinobi will URL-encode them when constructing the URL. Pre-encoding causes double
        // encoding: p@ss → p%40ss (correct) vs p%2540ss (broken).
        muser: username || '',
        mpass: password || '',  // raw password — Shinobi encodes special chars itself
        rtsp_transport: 'tcp',
        detail_streaming_type: type || 'h264',
        stream_type: 'hls',
        hls_time: '2',
        hls_list_size: '5',
        hls_flags: 'delete_segments+omit_endlist',
        // HLS live stream: copy H.264 directly from camera — zero transcoding.
        // Cameras now output H.264 (changed from HEVC on NVR). No re-encode needed.
        // stream_fps: '0' prevents Shinobi adding -vf fps=N (incompatible with copy mode).
        stream_vcodec: 'copy',
        stream_fps: '0',
        stream_acodec: 'no',
        // Recording to MP4: copy H.264 bitstream directly — no re-encode.
        vcodec: 'copy',
        acodec: 'no',
        // Recording output flags: use FRAGMENTED MP4 (fMP4) instead of regular MP4.
        // fMP4 writes self-contained fragments that are immediately playable without
        // any post-processing. Even if FFmpeg crashes mid-recording (RTSP drop, camera
        // offline), all fragments written before the crash are valid and playable.
        // This eliminates the moov-at-end problem that makes crash clips unplayable.
        //
        // Flags:
        //   frag_keyframe     — start new fragment at each keyframe (every 2-4s)
        //   empty_moov        — write empty moov box at file start (fMP4 standard)
        //   default_base_moof — use moof-relative addressing (makes fragments independent)
        //   +faststart        — keep this for compatibility (no-op with fMP4, but harmless)
        cust_record: '-movflags frag_keyframe+empty_moov+default_base_moof+faststart',
        time_limit: '15',   // 15-min segments — MUST be >0; Shinobi closes file after 15 min → S3 sync can upload it
        cust_input: '',
        cust_stream: '',
        wall_clock_timestamp_ignore: '1',
        detail_resolution_w: String(width || '1920'),
        detail_resolution_h: String(height || '1080'),
        detail_fps: String(fps || '30'),
        stream_quality: '50',
        snap: '0',          // DISABLED: snapshots cause FFmpeg overload (34 cameras × 1 fps = CPU death)
        snap_fps: '0',      // Use 0.1 if you need snapshots (1 every 10s), but 0 is best
        input_map_choices: '{}',
        skip_ping: '1',
      }),
    };
  }

  _generateRandomPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 24; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

module.exports = new ShinobiService();
