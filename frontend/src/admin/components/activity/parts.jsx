import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { timeAgo } from '../account/format.js'
import { useActivity } from './activityStore.js'
import { CATEGORIES, eventLink, iconFor, inBell, severityTone, whoLine } from './format.js'

/** Topbar connection pill: green "Live" only while the operator socket is joined. */
export function LivePill() {
  const { status } = useActivity()
  const live = status === 'live'
  const label = live ? 'Live' : status === 'denied' ? 'Not live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
  return (
    <div className={`live-pill ${live ? 'on' : 'off'}`} title={live ? 'Receiving platform activity in real time' : status === 'denied' ? 'This sign-in cannot receive live platform activity' : 'Connection lost, retrying'}>
      {live ? <span className="live-dot" /> : <span className="live-dot-off" />}
      <span className="live-text">{label}</span>
    </div>
  )
}

/** One event: icon, plain summary, who, relative time. */
export function ActivityRow({ e, onClick, fresh = false, compact = false }) {
  const tone = severityTone(e.severity)
  return (
    <Link to={eventLink(e)} onClick={onClick} className={`act-row ${fresh ? 'act-fresh' : ''} ${compact ? 'compact' : ''}`}>
      <span className={`act-icon tone-${tone}`} aria-hidden="true">
        <span className="material-symbols-outlined icon-sm">{iconFor(e.type)}</span>
      </span>
      <span className="act-main">
        <span className="act-summary">{e.summary}</span>
        <span className="act-meta">{whoLine(e)}</span>
      </span>
      <time className="act-time" dateTime={e.createdAt} title={new Date(e.createdAt).toLocaleString('en-IN')}>{timeAgo(e.createdAt)}</time>
    </Link>
  )
}

/** Toggle chips for the five categories. */
export function CategoryChips({ value, onChange }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="act-chips" role="group" aria-label="Show">
      {CATEGORIES.map((c) => (
        <button key={c.id} type="button" className={`filter-pill ${value.includes(c.id) ? 'active' : ''}`} aria-pressed={value.includes(c.id)} onClick={() => toggle(c.id)}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

/** Topbar bell: unread count (no sign-ins) + the latest 20 events. */
export function ActivityBell() {
  const { events, unread, markSeen } = useActivity()
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const navigate = useNavigate()
  const list = events.filter(inBell).slice(0, 20)

  useEffect(() => {
    if (!open) return
    const onDoc = (ev) => { if (wrap.current && !wrap.current.contains(ev.target)) setOpen(false) }
    const onKey = (ev) => { if (ev.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  const toggle = () => {
    if (!open) markSeen()
    setOpen((v) => !v)
  }

  return (
    <div className="act-bell-wrap" ref={wrap}>
      <button className="btn btn-ghost act-bell" onClick={toggle} aria-haspopup="true" aria-expanded={open} aria-label={unread ? `Activity, ${unread} new` : 'Activity'}>
        <span className="material-symbols-outlined">notifications</span>
        {unread > 0 && <span className="act-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="act-drop" role="dialog" aria-label="Latest activity">
          <div className="act-drop-head">
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>Activity</span>
            <button className="panel-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => { setOpen(false); navigate('/admin/activity') }}>
              See all<span className="material-symbols-outlined icon-sm">chevron_right</span>
            </button>
          </div>
          <div className="act-drop-body">
            {list.length === 0
              ? <p className="act-empty">Nothing yet. Signups, account changes and camera problems appear here as they happen.</p>
              : list.map((e) => <ActivityRow key={e.id || `${e.type}${e.createdAt}`} e={e} compact onClick={() => setOpen(false)} />)}
          </div>
        </div>
      )}
    </div>
  )
}
