/**
 * Formatting rules shared by the Accounts list and the account hub, so the two
 * can never disagree about what "near the limit" or "expiring" means.
 *
 * Colour: red = at/over a limit, offline, expired; amber = near a limit
 * (80 %+), unstable, expiring within 30 days. Nothing else is tinted.
 */

export const NEAR_LIMIT = 0.8
export const EXPIRING_DAYS = 30

/** 'danger' | 'warning' | null for a used/limit pair. limit null = no limit. */
export function usageTone(used, limit) {
  if (limit === null || limit === undefined) return null
  if (limit === 0) return used > 0 ? 'danger' : null
  if (used >= limit) return 'danger'
  if (used / limit >= NEAR_LIMIT) return 'warning'
  return null
}

export function usagePct(used, limit) {
  if (limit === null || limit === undefined) return 0
  if (limit === 0) return used > 0 ? 100 : 0
  return Math.min(100, Math.round((used / limit) * 100))
}

/** Licence-record expiry tone from days left (negative = expired). */
export function expiryTone(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return null
  if (daysLeft < 0) return 'danger'
  if (daysLeft <= EXPIRING_DAYS) return 'warning'
  return null
}

export function toneColor(tone) {
  if (tone === 'danger') return 'var(--color-danger)'
  if (tone === 'warning') return 'var(--color-warning)'
  return 'var(--color-text-secondary)'
}

export function toneText(tone) {
  if (tone === 'danger') return 'var(--color-danger-text)'
  if (tone === 'warning') return 'var(--color-warning-text)'
  return 'var(--color-on-surface)'
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 60) return `${d} d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Short names for the per-camera AI licences, for compact table cells. */
export const AI_SHORT = {
  face: 'Face',
  headcount: 'Head count',
  activity: 'Activity',
  restricted_zone: 'Zones',
}

/** Health buckets (same four as the customer Health page). */
export const BUCKET_LABEL = {
  online: 'Online',
  unstable: 'Unstable',
  offline: 'Offline',
  setup: 'Needs setup',
}
export const BUCKET_TONE = { online: null, unstable: 'warning', offline: 'danger', setup: null }

/** Engine state detail shown under the bucket. */
export const ENGINE_DETAIL = {
  healthy: 'Streaming',
  transcoding: 'Streaming (converting H.265)',
  starting: 'Connecting',
  standby: 'Idle, connects when opened',
  wobbling: 'Stream keeps dropping',
  offline: 'No video, unreachable',
  unknown: 'Not registered with the stream engine',
}

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Download rows as CSV. The URL is revoked on a timer: revoking right after
 *  click() races the browser's async blob read and truncates the file. */
export function downloadCsv(filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
  const BOM = String.fromCharCode(0xfeff) // so Excel reads the file as UTF-8
  const blob = new Blob([BOM + body], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/* ── Audit entries ────────────────────────────────────────────────── */

export const ACTION_LABELS = {
  'account.plan.changed': 'Plan changed',
  'account.licences.changed': 'Licences changed',
  'account.features.changed': 'Features changed',
  'account.suspended': 'Account suspended',
  'account.reactivated': 'Account reactivated',
  'account.user.password_reset_sent': 'Password reset sent',
}

/** One plain line per audit entry, from its before/after payload. */
export function describeChange(c) {
  const p = c.payload || {}
  if (c.action === 'account.plan.changed') {
    return `${p.before?.planName || 'none'} → ${p.after?.planName || '?'}`
  }
  if (c.action === 'account.features.changed') {
    if (p.after === 'all') return 'All features'
    const parts = []
    if (p.added?.length) parts.push(`on: ${p.added.join(', ')}`)
    if (p.removed?.length) parts.push(`off: ${p.removed.join(', ')}`)
    return parts.join(' · ') || 'No change'
  }
  if (c.action === 'account.licences.changed') {
    const fmt = (v) => (v === null || v === undefined ? 'default' : v)
    const parts = []
    if ((p.before?.cameraLimit ?? null) !== (p.after?.cameraLimit ?? null)) {
      parts.push(`cameras ${fmt(p.before?.cameraLimit)} → ${fmt(p.after?.cameraLimit)}`)
    }
    const keys = new Set([...Object.keys(p.before?.featureLimits || {}), ...Object.keys(p.after?.featureLimits || {})])
    for (const k of keys) {
      const b = p.before?.featureLimits?.[k]
      const a = p.after?.featureLimits?.[k]
      if (b !== a) parts.push(`${k} ${b ?? 'no limit'} → ${a ?? 'no limit'}`)
    }
    if (p.switchedOff) parts.push(`switched off: ${Object.entries(p.switchedOff).map(([k, ids]) => `${ids.length} ${k}`).join(', ')}`)
    return parts.join(' · ') || 'No change'
  }
  if (c.action === 'account.suspended' || c.action === 'account.reactivated') {
    const bits = []
    if (p.reason) bits.push(`“${p.reason}”`)
    if (p.users) bits.push(`${p.users} user${p.users === 1 ? '' : 's'}`)
    if (p.sessionsEnded) bits.push(`${p.sessionsEnded} session${p.sessionsEnded === 1 ? '' : 's'} ended`)
    return bits.join(' · ')
  }
  if (c.action === 'account.user.password_reset_sent') {
    return `${p.email || p.userId || ''}${p.sent === false ? ' (email failed)' : ''}`
  }
  return ''
}

/** Whole days from now until the end of a YYYY-MM-DD date (negative = past). */
export function daysUntil(dateOnly) {
  if (!dateOnly) return null
  return Math.ceil((new Date(`${dateOnly}T23:59:59`).getTime() - Date.now()) / 86400000)
}
