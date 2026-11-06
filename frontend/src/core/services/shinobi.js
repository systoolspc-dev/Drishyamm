import api from './api';
import { API_BASE } from '@/core/config/endpoints';

// LEGACY: drisyam no longer uses Shinobi — MediaMTX is the canonical
// RTSP/HLS/WebRTC layer (see WHEP_BASE in @/core/config/endpoints). This
// module is kept as a shim because a handful of legacy imports remain
// (useQueries.js / authStore.js / ShinobiEmbedPlayer.jsx / CameraGroups.jsx /
// Footfall.jsx / Help.jsx). SHINOBI_BASE is read from env directly here
// so the central endpoints config no longer carries dead state. The
// URL-builders below return null/empty for dead code paths — callers
// already handle that gracefully.
const SHINOBI_BASE = (import.meta.env.VITE_SHINOBI_URL || '').replace(/\/+$/, '');

class ShinobiService {
  constructor() {
    // In-memory cache — resets on every page load so stale localStorage values never linger
    this._groupKey = null;
    this._apiKey = null;
    // Clear any stale localStorage keys from previous sessions
    localStorage.removeItem('group_key');
    localStorage.removeItem('shinobi_api_key');
  }

  // Get user's group key and api key (fetches once per page session)
  async getUserGroupKey() {
    if (this._groupKey) return this._groupKey;

    try {
      const response = await api.get('/user/group-key');
      const { groupKey, apiKey } = response.data;
      this._groupKey = groupKey || null;
      this._apiKey = apiKey || null;
      return this._groupKey;
    } catch (e) {
      // MediaMTX mode: no per-user Shinobi credentials (older backends 403
      // here). Cameras are scoped by the authenticated user, so we proceed
      // without a group key instead of failing the whole page.
      this._groupKey = null;
      this._apiKey = null;
      return null;
    }
  }

  clearCache() {
    this._groupKey = null;
    this._apiKey = null;
  }

  // Get all cameras for user
  async getCameras() {
    const groupKey = await this.getUserGroupKey();  
    const response = await api.get(`/shinobi/cameras`, {
      params: { groupKey },
    });
    return response.data;
  }

  // Get single camera
  async getCamera(monitorId) {
    const groupKey = await this.getUserGroupKey();
    const response = await api.get(`/shinobi/cameras/${monitorId}`, {
      params: { groupKey },
    });
    return response.data;
  }

  // Add new camera
  async addCamera(cameraData) {
    const groupKey = await this.getUserGroupKey();
    const response = await api.post('/shinobi/cameras', {
      ...cameraData,
      groupKey,
    });
    return response.data;
  }

  // Update camera
  async updateCamera(monitorId, cameraData) {
    const groupKey = await this.getUserGroupKey();
    const response = await api.put(`/shinobi/cameras/${monitorId}`, {
      ...cameraData,
      groupKey,
    });
    return response.data;
  }

  // Delete camera
  async deleteCamera(monitorId) {
    const groupKey = await this.getUserGroupKey();
    const response = await api.delete(`/shinobi/cameras/${monitorId}`, {
      params: { groupKey },
    });
    return response.data;
  }

  // Get recordings
  async getRecordings(monitorId, startDate, endDate) {
    const groupKey = await this.getUserGroupKey();
    const response = await api.get(`/shinobi/recordings/${monitorId}`, {
      params: { groupKey, start: startDate, end: endDate },
    });
    return response.data;
  }

  // Get live stream URL (uses Shinobi embed player with WebSockets)
  async getLiveStreamUrl(monitorId) {
    await this.getUserGroupKey();

    // Use embed player - most reliable streaming method
    const url = `${SHINOBI_BASE}/${this._apiKey}/embed/${this._groupKey}/${monitorId}`;

    console.log('🎥 Generated embed stream URL:', url);

    return url;
  }

  // Get Shinobi's native HLS stream URL
  async getShinobiHlsUrl(monitorId) {
    await this.getUserGroupKey();
    return `${SHINOBI_BASE}/${this._apiKey}/hls/${this._groupKey}/${monitorId}/s.m3u8`;
  }

  // Get MJPEG stream URL (more compatible fallback)
  async getMjpegStreamUrl(monitorId) {
    await this.getUserGroupKey();
    return `${SHINOBI_BASE}/${this._apiKey}/mjpeg/${this._groupKey}/${monitorId}`;
    
  }

  // Get embed player URL
  async getEmbedUrl(monitorId) {
    await this.getUserGroupKey();
    return `${SHINOBI_BASE}/${this._apiKey}/embed/${this._groupKey}/${monitorId}`;
  }

  // Get snapshot URL (auto-refreshing image)
  async getSnapshotUrl(monitorId) {
    await this.getUserGroupKey();
    return `${SHINOBI_BASE}/${this._apiKey}/jpeg/${this._groupKey}/${monitorId}/s.jpg`;
  }

  // Get recording URL
  async getRecordingUrl(monitorId, filename) {
    await this.getUserGroupKey();
    return `${SHINOBI_BASE}/${this._apiKey}/videos/${this._groupKey}/${monitorId}/${filename}`;
  }

  // Check if stream is already active
  async getStreamStatus(monitorId) {
    try {
      const response = await api.get(`/stream/status/${monitorId}`);
      return response.data;
    } catch (error) {
      console.warn('Failed to get stream status:', error);
      return { isActive: false, streamUrl: null };
    }
  }

  // Start a live stream and return { webrtcUrl, hlsUrl, provider }
  // webrtcUrl is non-null when MediaMTX is available (< 1s latency via WHEP)
  // hlsUrl    is always present as fallback (~2–4s)
  async getDirectStreamUrl(monitorId) {
    const response = await api.get(`/stream/start/${monitorId}`);
    console.log('🎬 Stream started:', response.data);

    const { webrtcUrl, hlsUrl, streamUrl, provider } = response.data;

    // hlsUrl comes absolute from MediaMTX; streamUrl is a relative path from FFmpeg fallback
    const resolvedHlsUrl = hlsUrl || (streamUrl ? `${API_BASE}${streamUrl}` : null);

    return { webrtcUrl: webrtcUrl || null, hlsUrl: resolvedHlsUrl, provider };
  }

  // Stop direct stream
  async stopDirectStream(monitorId) {
    await api.get(`/stream/stop/${monitorId}`);
    console.log('⏹️ Direct stream stopped for:', monitorId);
  }
}

export const shinobiService = new ShinobiService();
