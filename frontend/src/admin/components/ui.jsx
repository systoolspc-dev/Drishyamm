import { useEffect } from 'react'
import { initials, avatarColors } from '../data/index.js'

const chipMap = {
  active:           { cls: 'chip-green',  label: 'Active' },
  suspended:        { cls: 'chip-red',    label: 'Suspended' },
  online:           { cls: 'chip-green',  label: 'Online' },
  offline:          { cls: 'chip-red',    label: 'Offline' },
  registered:       { cls: 'chip-green',  label: 'Registered' },
  pending:          { cls: 'chip-amber',  label: 'Pending' },
  failed:           { cls: 'chip-red',    label: 'Failed' },
  info:             { cls: 'chip-blue',   label: 'Info' },
  warning:          { cls: 'chip-amber',  label: 'Warning' },
  critical:         { cls: 'chip-red',    label: 'Critical' },
  open:             { cls: 'chip-blue',   label: 'Open' },
  in_progress:      { cls: 'chip-amber',  label: 'In Progress' },
  resolved:         { cls: 'chip-green',  label: 'Resolved' },
  waiting_customer: { cls: 'chip-gray',   label: 'Waiting' },
  urgent:           { cls: 'chip-red',    label: 'Urgent' },
  high:             { cls: 'chip-orange', label: 'High' },
  normal:           { cls: 'chip-blue',   label: 'Normal' },
  low:              { cls: 'chip-gray',   label: 'Low' },
  Enterprise:       { cls: 'chip-orange', label: 'Enterprise' },
  Pro:              { cls: 'chip-blue',   label: 'Pro' },
  Starter:          { cls: 'chip-gray',   label: 'Starter' },
  Free:             { cls: 'chip-gray',   label: 'Free' },
  admin:            { cls: 'chip-orange', label: 'Admin' },
  superadmin:       { cls: 'chip-orange', label: 'Superadmin' },
  support:          { cls: 'chip-blue',   label: 'Support' },
}

export function StatusChip({ type, dot = true }) {
  const c = chipMap[type] || { cls: 'chip-gray', label: type }
  return (
    <span className={`chip ${c.cls}`}>
      {dot && <span className="chip-dot" />}
      {c.label}
    </span>
  )
}

export function Modal({ open, onClose, title, subtitle, children, width = 640, footer }) {
  useEffect(() => {
    if (!open) return
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: width }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-on-surface)', lineHeight: 1.3 }}>{title}</h2>
            {subtitle && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 3 }}>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost" style={{ padding: '6px', minWidth: 0 }} onClick={onClose}>
            <span className="material-symbols-outlined icon-sm">close</span>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export function Avatar({ name = '?', size = '' }) {
  const c = avatarColors(name)
  return (
    <div className={`avatar ${size}`} style={{ background: c.bg, color: c.text }}>
      {initials(name)}
    </div>
  )
}

export function InfoRow({ label, value }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value ?? '—'}</span>
    </div>
  )
}

export function EmptyState({ icon = 'search_off', title = 'No results', message = '' }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--color-text-muted)' }}>
      <span className="material-symbols-outlined icon-xl" style={{ marginBottom: 12, display: 'block' }}>{icon}</span>
      <p style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{title}</p>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </div>
  )
}

export function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--color-text-muted)' }}>
      <div style={{
        width: 32, height: 32, border: '3px solid var(--color-border)',
        borderTopColor: 'var(--color-primary)', borderRadius: '50%',
        animation: 'spin 0.7s linear infinite', margin: '0 auto',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
