// Single source of truth for every service URL the frontend talks to.
//
// New pages / services MUST import from here instead of reading
// `import.meta.env` directly or hardcoding `http://localhost:<port>`.
// To repoint the app at a different deployment, edit `.env.production`
// (or `.env` for dev) — no page changes needed.
//
// Bases never carry a trailing slash; consumers append paths starting with `/`.

const stripTrail = (s) => (s || '').replace(/\/+$/, '');

// Smart-cam-backend gateway. Operator API, JWT auth, Socket.IO, S3 uploads.
export const API_BASE = stripTrail(
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'
);

// All authenticated REST under /api lives here.
export const API_URL = `${API_BASE}/api`;

// Smart-cam-ai. Direct MJPEG / detections / status / WebSocket calls. In prod
// this is the same-origin nginx proxy `/ai/` so port 8001 stays internal.
export const AI_BASE = stripTrail(
  import.meta.env.VITE_AI_BASE_URL || 'http://localhost:8001'
);

// WebSocket scheme mirrors AI_BASE — http→ws, https→wss. The AI service mounts
// its event feed at /ws; callers append ?camera_id=... query.
export const AI_WS = AI_BASE.replace(/^http/, 'ws') + '/ws';

// MediaMTX WebRTC WHEP endpoint host. Per-camera WHEP path is
// `${WHEP_BASE}/cam_<monitorId>/whep` (POST + OPTIONS).
export const WHEP_BASE = stripTrail(
  import.meta.env.VITE_STREAM_SERVICE_WEBRTC_BASE || import.meta.env.VITE_MEDIAMTX_WEBRTC_BASE || 'http://localhost:8889'
);

// person-tracker — all calls go through smart-cam-backend's reverse proxy
// at /api/person-tracker/* (backend strips the prefix + adds service token).
// We never hit person-tracker (:8003) directly from the browser so the
// service-token stays server-side.
export const PERSON_TRACKER_BASE = `${API_URL}/person-tracker`;

// Note on Shinobi:
// We no longer use Shinobi — MediaMTX handles RTSP/HLS/WebRTC end-to-end
// (see WHEP_BASE above). The src/services/shinobi.js module still exists
// as a legacy shim because a few files import it; it self-contains its
// own URL lookup and is dead code at runtime. Full removal is a separate
// cleanup pass (touches services/shinobi.js, components/ShinobiEmbedPlayer.jsx,
// hooks/useQueries.js, store/authStore.js, pages/Footfall.jsx + Help.jsx +
// CameraGroups.jsx, services/cameraGroup.js, services/recordings.js).

// Helper: build a URL under a known base while gracefully handling
// leading-slash / no-leading-slash callers.
export function url(base, path) {
  const p = String(path || '');
  return p.startsWith('/') ? `${base}${p}` : `${base}/${p}`;
}
