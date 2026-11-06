import { useEffect } from 'react'
import { initials, avatarColors } from '../data/index.js'

// â”€â”€â”€ StatusChip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const chipMap = {
  // camera / user status
  active:           { cls: 'chip-green',  label: 'Active' },
  suspended:        { cls: 'chip-red',    label: 'Suspended' },
  online:           { cls: 'chip-green',  label: 'Online' },
  offline:          { cls: 'chip-red',    label: 'Offline' },
  // face
  registered:       { cls: 'chip-green',  label: 'Registered' },
  pending:          { cls: 'chip-amber',  label: 'Pending' },
  failed:           { cls: 'chip-red',    label: 'Failed' },
  // event severity
  info:             { cls: 'chip-blue',   label: 'Info' },
  warning:          { cls: 'chip-amber',  label: 'Warning' },
  critical:         { cls: 'chip-red',    label: 'Critical' },
  safe:             { cls: 'chip-green',  label: 'Safe' },
  // ticket status
  open:             { cls: 'chip-blue',   label: 'Open' },
  in_progress:      { cls: 'chip-amber',  label: 'In Progress' },
  resolved:         { cls: 'chip-green',  label: 'Resolved' },
  waiting_customer: { cls: 'chip-gray',   label: 'Waiting' },
  // ticket priority
  urgent:           { cls: 'chip-red',    label: 'Urgent' },
  high:             { cls: 'chip-orange', label: 'High' },
  normal:           { cls: 'chip-blue',   label: 'Normal' },
  low:              { cls: 'chip-gray',   label: 'Low' },
  // plan
  Enterprise:       { cls: 'chip-orange', label: 'Enterprise' },
  Pro:              { cls: 'chip-blue',   label: 'Pro' },
  Starter:          { cls: 'chip-gray',   label: 'Starter' },
  // admin role
  superadmin:       { cls: 'chip-orange', label: 'Superadmin' },
  support:          { cls: 'chip-blue',   label: 'Support' },
  billing:          { cls: 'chip-green',  label: 'Billing' },
  readonly:         { cls: 'chip-gray',   label: 'Read-only' },
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

// â”€â”€â”€ Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function Modal({ open, onClose, title, subtitle, children, width = 640, footer }) {
  useEffect(() => {
    if (!open) return
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = '' }
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
          <button className="btn btn-ghost" style={{ padding: '6px', minWidth: 0 }} onClick={onClose} type="button" aria-label="Close dialog" title="Close">
            <span className="material-symbols-outlined icon-sm">close</span>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

// â”€â”€â”€ Avatar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function Avatar({ name, size = '' }) {
  const c = avatarColors(name)
  return (
    <div className={`avatar ${size}`} style={{ background: c.bg, color: c.text }}>
      {initials(name)}
    </div>
  )
}

// â”€â”€â”€ InfoRow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function InfoRow({ label, value }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value ?? '-'}</span>
    </div>
  )
}

// â”€â”€â”€ EmptyState â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function EmptyState({ icon = 'search_off', title = 'No results', message = '' }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: 'var(--color-text-muted)' }}>
      <span className="material-symbols-outlined icon-xl" style={{ marginBottom: 12, display: 'block' }}>{icon}</span>
      <p style={{ fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{title}</p>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </div>
  )
}
