import { API_URL } from '@/core/config/endpoints'

// Share the host app's backend + auth. API_URL is the single source of truth
// (http://localhost:5000/api by default); VITE_API_BASE can still override it.
const BASE = import.meta.env.VITE_API_BASE || API_URL

// Same JWT the rest of the app uses — authService persists it as `auth_token`.
function authHeaders() {
  const token = localStorage.getItem('auth_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status })
  }
  return res.json()
}

export const api = {
  get:   (path)       => request(path),
  post:  (path, body) => request(path, { method: 'POST',   body: JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: 'PATCH',  body: JSON.stringify(body) }),
  del:   (path)       => request(path, { method: 'DELETE' }),
}

export const eventsApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString()
    return api.get(`/ai/events${qs ? `?${qs}` : ''}`)
  },
  threatFeed:  ()   => api.get('/ai/threat-feed'),
  acknowledge: (id) => api.patch(`/ai/events/${id}/acknowledge`),
  resolve:     (id) => api.patch(`/ai/events/${id}/resolve`),
}

export const dashboardApi = {
  stats: () => api.get('/dashboard/stats'),
}

export const camerasApi = {
  list:         ()           => api.get('/cameras'),
  getById:      (id)         => api.get(`/cameras/${id}`),
  updateStatus: (id, status) => api.patch(`/cameras/${id}/status`, { status }),
}

export const watchlistApi = {
  list:    () => api.get('/watchlist'),
  redList: () => api.get('/watchlist/red-list'),
}

export const crowdApi = {
  zones: () => api.get('/crowd'),
}

export const personnelApi = {
  list: () => api.get('/personnel'),
}
