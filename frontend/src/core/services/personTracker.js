// Thin wrapper over the person-tracker API. All calls go through
// smart-cam-backend's /api/person-tracker/* proxy (auth + service-token
// injected by the backend). New PersonTracker pages should consume only
// this module, never axios + a URL directly — that's what kept the
// rest of the codebase from drifting and what lets us repoint with one
// env var change.
import api from './api';
import { API_BASE } from '@/core/config/endpoints';

// Build a URL the browser loads directly via <img>/<video>/<a> (not axios).
// These can't send the Authorization header, so the JWT rides as ?token=
// (the backend's authenticate middleware accepts it for exactly this case).
// We use the absolute API_BASE — there's no Vite /api proxy in dev, so a
// relative "/api/..." would hit the SPA dev server, not the backend.
function browserUrl(path) {
  const token = localStorage.getItem('auth_token') || '';
  const sep = path.includes('?') ? '&' : '?';
  return `${API_BASE}/api/person-tracker${path}${sep}token=${encodeURIComponent(token)}`;
}

export const personTrackerService = {
  /**
   * POST /api/person-tracker/search
   * Multipart upload of the face photo. Optional time window + threshold.
   * Resolves to:
   *   { query_face_quality, candidates: [...], window_start, window_end, total_matched }
   */
  async search(file, opts = {}) {
    const fd = new FormData();
    fd.append('file', file, file.name || 'face.jpg');
    if (opts.windowStart) fd.append('window_start', opts.windowStart);
    if (opts.windowEnd)   fd.append('window_end',   opts.windowEnd);
    if (opts.minSimilarity != null) fd.append('min_similarity', String(opts.minSimilarity));
    if (opts.cameraIds?.length) fd.append('camera_ids', opts.cameraIds.join(','));
    // Scope to chosen cameras by their monitor_id/code (the camera dropdown).
    if (opts.cameraCodes?.length) fd.append('camera_codes', opts.cameraCodes.join(','));
    const { data } = await api.post('/person-tracker/search', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60_000,
      onUploadProgress: opts.onUploadProgress,
    });
    return data;
  },

  /**
   * POST /api/person-tracker/sightings/cluster
   * Collapse Qdrant candidates into per-camera sightings.
   */
  async clusterSightings(candidates, windowSec) {
    const { data } = await api.post('/person-tracker/sightings/cluster', {
      candidates,
      window_sec: windowSec ?? null,
    });
    return data.sightings ?? [];
  },

  /**
   * POST /api/person-tracker/stitch
   * Returns { job_id, status:'queued', poll_url }.
   */
  async createStitchJob(sightings, { includeOverlays = true, includeIntroCard = true } = {}) {
    const { data } = await api.post('/person-tracker/stitch', {
      sightings,
      include_overlays: includeOverlays,
      include_intro_card: includeIntroCard,
    });
    return data;
  },

  /**
   * GET /api/person-tracker/stitch/{jobId}
   * Operator polls every 2-3s until status is 'done' or 'failed'.
   */
  async getJobStatus(jobId) {
    const { data } = await api.get(`/person-tracker/stitch/${jobId}`);
    return data;
  },

  /**
   * URLs the operator opens directly (browser follows the 302 to a
   * presigned MinIO URL). Returned as strings — caller uses them as
   * <video src=...> or window.open(...).
   */
  videoUrl: (jobId)  => browserUrl(`/stitch/${jobId}/video`),
  reportUrl: (jobId) => browserUrl(`/stitch/${jobId}/report.pdf`),

  /**
   * GET /api/person-tracker/snapshot?uri=s3://...
   * Direct <img src> for a sighting's best face crop. Returns null when
   * there's no snapshot pointer so the caller can show a placeholder.
   */
  snapshotUrl: (uri) => (uri ? browserUrl(`/snapshot?uri=${encodeURIComponent(uri)}`) : null),

  /**
   * GET /api/person-tracker/stitch/{jobId}/map.json
   * Returns { stops: [...], path: [[lat,lng],...] }.
   */
  async getMap(jobId) {
    const { data } = await api.get(`/person-tracker/stitch/${jobId}/map.json`);
    return data;
  },
};

export default personTrackerService;
