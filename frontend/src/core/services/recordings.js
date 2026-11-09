import api from './api';
import { API_URL } from '@/core/config/endpoints';

/**
 * List all recordings for every camera in a group.
 * Optionally filter by a single date (YYYY-MM-DD).
 *
 * Returns: [{ key, cameraName, date, filename, size, lastModified, playbackUrl }, ...]
 */
export async function getGroupRecordings(groupId, date = null) {
  const params = date ? { date, limit: 1000 } : { limit: 1000 }; // Request more results for timelapse view
  const { data } = await api.get(`/groups/${groupId}/recordings`, { params });
  return data.data;
}

/**
 * List recordings for a single camera within a group.
 * monitorId is the Shinobi monitor ID stored on the Camera model.
 *
 * Returns: [{ key, filename, size, lastModified, playbackUrl }, ...]
 */
export async function getCameraRecordings(groupId, monitorId, date = null) {
  const params = date ? { date, limit: 1000 } : { limit: 1000 }; // Request more results for timelapse view
  const { data } = await api.get(`/groups/${groupId}/cameras/${monitorId}/recordings`, { params });
  return data.data;
}

/**
 * Get a fresh 7-day playback URL for a single recording on demand.
 * Kept as fallback; prefer getStreamUrl() to avoid browser CORS on S3.
 *
 * Returns: { playbackUrl }
 */
export async function getPlaybackUrl(groupId, key) {
  const { data } = await api.get(`/groups/${groupId}/recordings/play`, {
    params: { key },
  });
  return data.playbackUrl;
}

/**
 * Build a backend proxy stream URL for a recording.
 * The browser loads video from /api/groups/.../recordings/stream — same backend origin,
 * so there are no S3 CORS issues and HTTP Range (seek) requests are fully supported.
 * Auth token is passed as a query param because <video> can't send custom headers.
 *
 * Returns a URL string synchronously.
 */
export function getStreamUrl(groupId, key) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_URL}/groups/${groupId}/recordings/stream?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

/**
 * Build a URL that exports a single trimmed MP4 covering [start, end] (epoch ms)
 * for one camera — the backend concatenates the cloud clips over that span and
 * cuts the result to the exact range. Loaded directly by the browser (anchor
 * download), so the auth token rides in the query like getStreamUrl.
 */
export function getExportUrl(groupId, monitorId, start, end, name) {
  const token = localStorage.getItem('auth_token') || '';
  const qs = new URLSearchParams({ monitorId, start: String(start), end: String(end), token });
  if (name) qs.set('name', name);
  return `${API_URL}/groups/${groupId}/recordings/export?${qs.toString()}`;
}

/**
 * Build a backend URL that returns the first-frame JPEG thumbnail for a recording.
 * The backend runs FFmpeg and caches the result for 24 h (Cache-Control: public max-age=86400).
 * Auth token is passed as a query param (same pattern as getStreamUrl).
 *
 * Returns a URL string synchronously.
 */
export function getThumbnailUrl(groupId, key) {
  const token = localStorage.getItem('auth_token') || '';
  return `${API_URL}/groups/${groupId}/recordings/thumbnail?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

/**
 * Get a forced-download signed URL for a recording.
 * The backend verifies the key belongs to the current user.
 *
 * Returns: { downloadUrl, filename }
 */
export async function getDownloadUrl(groupId, key, name) {
  const { data } = await api.get(`/groups/${groupId}/recordings/download`, {
    params: name ? { key, name } : { key },
  });
  return data;
}
