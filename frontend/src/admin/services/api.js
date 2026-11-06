import { API_URL as BASE } from '@/core/config/endpoints'

function getToken() {
  return localStorage.getItem('admin_token')
}

async function request(path, options = {}) {
  const token = getToken()
  // Pull out our internal flag before spreading into fetch options
  const skipAuthRedirect = options._skipAuthRedirect
  const fetchOptions = { ...options }
  delete fetchOptions._skipAuthRedirect

  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
    ...fetchOptions,
  })

  // 401 on a real protected call → token expired, redirect to login
  // But on the login call itself, a 401 means wrong credentials — don't redirect
  if (res.status === 401 && !skipAuthRedirect) {
    localStorage.removeItem('admin_token')
    localStorage.removeItem('admin_user')
    window.location.href = '/admin/login'
    return
  }

  // Safely parse JSON — server might return HTML on unexpected errors
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error(`Server error (HTTP ${res.status}). Is the backend running?`)
  }

  if (!res.ok) {
    // status + body ride along so a caller can act on structured refusals
    // (e.g. Account control's 409 BELOW_USAGE conflicts list).
    const err = new Error(data?.message || `Request failed (${res.status})`)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export const adminApi = {
  // _skipAuthRedirect: true so wrong-password 401 shows as an error in the form
  login: (email, password) =>
    request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      _skipAuthRedirect: true,
    }),

  getStats: (filters = {}) => {
    const qs = new URLSearchParams()
    if (filters.range)        qs.set('range', filters.range)
    if (filters.severity?.length) qs.set('severity', filters.severity.join(','))
    if (filters.userId && filters.userId !== 'all') qs.set('userId', filters.userId)
    if (filters.range === 'custom') {
      if (filters.from) qs.set('from', filters.from)
      if (filters.to)   qs.set('to',   filters.to)
    }
    const q = qs.toString()
    return request(`/admin/stats${q ? `?${q}` : ''}`)
  },
  getUsers: () => request('/admin/users'),
  getUser: (id) => request(`/admin/users/${id}`),
  toggleUserStatus: (id) => request(`/admin/users/${id}/toggle-status`, { method: 'PUT' }),
  getCameras: (userId) => request(`/admin/cameras${userId && userId !== 'all' ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  getEvents: (page = 1, limit = 100) => request(`/admin/events?page=${page}&limit=${limit}`),

  // ── Live monitoring ───────────────────────────────────────────────────
  getSystemHealth: () => request('/admin/system-health'),
  getCustomerCameraHealth: (userId) => request(`/admin/customers/${encodeURIComponent(userId)}/camera-health`),
  getOpsMetrics: (userId) => request(`/admin/customers/${encodeURIComponent(userId)}/ops-metrics`),
  adminStreamStart: (monitorId) => request(`/admin/cameras/${encodeURIComponent(monitorId)}/stream-start`),
  getDatasets: () => request('/admin/datasets'),
  getDatasetDownloadUrl: (key) => request(`/admin/datasets/download?key=${encodeURIComponent(key)}`),

  // ── Billing / licensing ──────────────────────────────────────────────
  getPricingCatalog: () => request('/admin/pricing-catalog'),
  updatePricingCatalogItem: (id, payload) =>
    request(`/admin/pricing-catalog/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  calculateQuote: (payload) =>
    request('/admin/quotes/calculate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // ── Licenses ─────────────────────────────────────────────────────────
  listLicenses: (filters = {}) => {
    const qs = new URLSearchParams()
    if (filters.status && filters.status !== 'all') qs.set('status', filters.status)
    if (filters.term   && filters.term   !== 'all') qs.set('term',   filters.term)
    if (filters.userId && filters.userId !== 'all') qs.set('userId', filters.userId)
    if (filters.search) qs.set('search', filters.search)
    const q = qs.toString()
    return request(`/admin/licenses${q ? `?${q}` : ''}`)
  },
  getLicense: (id) => request(`/admin/licenses/${id}`),
  createLicense: (body) =>
    request('/admin/licenses', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setLicenseStatus: (id, status, notes) =>
    request(`/admin/licenses/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status, notes }),
    }),
  saveQuote: (body) =>
    request('/admin/quotes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── Account control (one customer account) ───────────────────────────
  getAccountControl: (userId) => request(`/admin/accounts/${encodeURIComponent(userId)}/control`),
  setAccountPlan: (userId, planId) =>
    request(`/admin/accounts/${encodeURIComponent(userId)}/plan`, { method: 'PUT', body: JSON.stringify({ planId }) }),
  setAccountLicences: (userId, body) =>
    request(`/admin/accounts/${encodeURIComponent(userId)}/licences`, { method: 'PUT', body: JSON.stringify(body) }),
  setAccountFeatures: (userId, body) =>
    request(`/admin/accounts/${encodeURIComponent(userId)}/features`, { method: 'PUT', body: JSON.stringify(body) }),

  // ── Accounts list + account hub ──────────────────────────────────────
  listAccounts: () => request('/admin/accounts'),
  getAccountHub: (userId) => request(`/admin/accounts/${encodeURIComponent(userId)}/hub`),
  getAccountEvents: (userId, { page = 1, limit = 25, severity = '', open = false } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (severity) qs.set('severity', severity)
    if (open) qs.set('open', '1')
    return request(`/admin/accounts/${encodeURIComponent(userId)}/events?${qs}`)
  },
  setAccountStatus: (userId, active, reason) =>
    request(`/admin/accounts/${encodeURIComponent(userId)}/status`, { method: 'PUT', body: JSON.stringify({ active, reason }) }),
  sendPasswordReset: (userId, memberId) =>
    request(`/admin/accounts/${encodeURIComponent(userId)}/users/${encodeURIComponent(memberId)}/password-reset`, { method: 'POST' }),
  // One still, fetched only when the operator clicks (never on page load).
  getCameraSnapshot: async (userId, cameraId) => {
    const res = await fetch(`${BASE}/admin/accounts/${encodeURIComponent(userId)}/cameras/${encodeURIComponent(cameraId)}/snapshot`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) {
      let msg = `Snapshot failed (${res.status})`
      try { msg = (await res.json()).message || msg } catch { /* not JSON */ }
      throw new Error(msg)
    }
    return { url: URL.createObjectURL(await res.blob()), at: res.headers.get('X-Snapshot-At') }
  },

  // ── Audit log (admin_audit_log) ──────────────────────────────────────
  listAudit: ({ page = 1, limit = 50, accountId = '', actorId = '', action = '', from = '', to = '' } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (accountId) qs.set('accountId', accountId)
    if (actorId) qs.set('actorId', actorId)
    if (action) qs.set('action', action)
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return request(`/admin/audit?${qs}`)
  },

  // ── Live platform activity (platform_events; live via the ops socket) ──
  listActivity: ({ page = 1, limit = 25, category = '', type = '', accountId = '', severity = '', afterId = '', since = '' } = {}) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (category) qs.set('category', Array.isArray(category) ? category.join(',') : category)
    if (type) qs.set('type', type)
    if (accountId) qs.set('accountId', accountId)
    if (severity) qs.set('severity', severity)
    if (afterId) qs.set('afterId', String(afterId))
    if (since) qs.set('since', since)
    return request(`/admin/activity?${qs}`)
  },

  // ── Email / SMTP settings ────────────────────────────────────────────
  getMailConfig: () => request('/admin/mail-config'),
  saveMailConfig: (body) =>
    request('/admin/mail-config', { method: 'PUT', body: JSON.stringify(body) }),
  testMailConfig: (to) =>
    request('/admin/mail-config/test', { method: 'POST', body: JSON.stringify({ to }) }),
}
