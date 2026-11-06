import { useState } from 'react'
import { adminApi } from '../../services/api.js'
import { usageTone, usagePct, toneColor, toneText } from './format.js'

/** "used / limit" with a thin bar. Amber near the limit, red at or over it. */
export function UsageMeter({ used, limit, unit = '' }) {
  const tone = usageTone(used, limit)
  const unlimited = limit === null || limit === undefined
  return (
    <div className="use-bar">
      <span className="use-bar-text" style={{ color: toneText(tone) }}>
        {used}{unlimited ? '' : ` / ${limit}`}{unit ? ` ${unit}` : ''}
        {unlimited && <span className="tone-muted" style={{ fontWeight: 500 }}> · no limit</span>}
      </span>
      {!unlimited && (
        <div className="bar-track" aria-hidden="true">
          <div className="bar-fill" style={{ width: `${usagePct(used, limit)}%`, background: tone ? toneColor(tone) : 'var(--color-text-muted)' }} />
        </div>
      )}
    </div>
  )
}

/**
 * One decision-relevant number. `tone` colours the value only when it needs
 * action (danger / warning); `onClick` makes the tile a filter or a link.
 */
export function KpiTile({ label, value, sub, tone = null, subTone = null, onClick, active = false }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      className={`hub-tile ${onClick ? 'hub-tile-btn' : ''} ${active ? 'active' : ''}`}
      onClick={onClick}
      {...(onClick ? { type: 'button', 'aria-pressed': active } : {})}
    >
      <div className="hub-tile-label">{label}</div>
      <div className={`hub-tile-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
      {sub && <div className={`hub-tile-sub ${subTone ? `tone-${subTone}` : ''}`}>{sub}</div>}
    </Tag>
  )
}

/** Dot + word status pill. */
export function StatusDot({ tone = 'neutral', children }) {
  return <span className={`dot-pill dot-${tone}`}><span className="dot" />{children}</span>
}

/** online/total plus the problem counts, in the Health page's buckets. */
export function HealthCell({ health }) {
  if (!health || !health.total) return <span className="tone-muted">No cameras</span>
  const problems = []
  if (health.offline) problems.push(<span key="o" className="tone-danger">{health.offline} offline</span>)
  if (health.unstable) problems.push(<span key="u" className="tone-warning">{health.unstable} unstable</span>)
  if (health.setup) problems.push(<span key="s">{health.setup} need setup</span>)
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
      <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{health.online} / {health.total} online</div>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
        {problems.length ? problems.reduce((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), []) : `${health.streaming} streaming now`}
      </div>
    </div>
  )
}

/**
 * In-page confirmation for suspending / reactivating an account. Suspending
 * signs every user of the account out and refuses their logins and API calls
 * until it is reactivated.
 */
export function SuspendConfirm({ account, onDone, onCancel }) {
  const suspending = account.status === 'active'
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const users = (account.members || 0) + 1

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await adminApi.setAccountStatus(account.id, !suspending, reason.trim() || undefined)
      onDone(r.account.status)
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className={`confirm-panel ${suspending ? '' : 'reactivate'}`} role="alertdialog" aria-label={suspending ? 'Confirm suspend' : 'Confirm reactivate'}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>
        {suspending ? `Suspend ${account.name}?` : `Reactivate ${account.name}?`}
      </div>
      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
        {suspending
          ? `All ${users} user${users === 1 ? '' : 's'} of this account are signed out now and cannot sign in or use the API until you reactivate it. Cameras, recordings and settings are kept.`
          : `All ${users} user${users === 1 ? '' : 's'} can sign in again. They need to sign in afresh; old sessions were ended.`}
      </p>
      <input
        className="input"
        placeholder={suspending ? 'Reason (kept in the audit log)' : 'Note (optional, kept in the audit log)'}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        aria-label="Reason"
      />
      {error && <div className="tone-danger" style={{ fontSize: 12.5 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={`btn ${suspending ? 'btn-danger' : 'btn-primary'}`} onClick={go} disabled={busy}>
          {busy ? 'Saving…' : suspending ? 'Suspend account' : 'Reactivate account'}
        </button>
      </div>
    </div>
  )
}
