import { useState, useEffect, useMemo } from 'react'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'

const severityColor = { info: '#2563eb', warning: '#d97706', critical: '#dc2626' }
const severityBg    = { info: 'var(--color-info-bg)', warning: 'var(--color-warning-bg)', critical: 'var(--color-danger-bg)' }
const severityIcon  = { info: 'info', warning: 'warning', critical: 'error' }

const RANGE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'custom', label: 'Custom' },
]
const SEVERITY_OPTIONS = [
  { value: 'critical', label: 'Critical', color: '#dc2626' },
  { value: 'warning',  label: 'Warning',  color: '#d97706' },
  { value: 'info',     label: 'Info',     color: '#2563eb' },
]
const ACK_OPTIONS = [
  { value: 'all',     label: 'All' },
  { value: 'unacked', label: 'Unacked' },
  { value: 'acked',   label: 'Acked' },
]
const DEFAULT_FILTERS = { range: 'all', severity: [], userId: 'all', ack: 'all', from: '', to: '' }

const RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }

function todayISO() { return new Date().toISOString().slice(0, 10) }
function daysAgoISO(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export default function Events() {
  const [events, setEvents] = useState([])
  const [users, setUsers]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [search, setSearch]   = useState('')
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  useEffect(() => {
    Promise.all([
      adminApi.getEvents(1, 500),
      adminApi.getUsers(),
    ])
      .then(([ev, us]) => {
        setEvents(ev.events || [])
        setUsers(us.users || [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const updateFilter   = (patch) => setFilters(prev => {
    const next = { ...prev, ...patch }
    if (patch.range === 'custom' && (!prev.from || !prev.to)) {
      next.from = daysAgoISO(14)
      next.to   = todayISO()
    }
    return next
  })
  const toggleSeverity = (sev) => setFilters(prev => ({
    ...prev,
    severity: prev.severity.includes(sev)
      ? prev.severity.filter(s => s !== sev)
      : [...prev.severity, sev],
  }))
  const clearFilters   = () => { setFilters(DEFAULT_FILTERS); setSearch('') }
  const isFiltered     = filters.range !== DEFAULT_FILTERS.range
                      || filters.severity.length > 0
                      || filters.userId !== 'all'
                      || filters.ack !== 'all'
                      || search.trim() !== ''

  // Compute filter window
  const rangeStart = useMemo(() => {
    if (filters.range === 'all')    return null
    if (filters.range === 'custom') return filters.from ? new Date(filters.from) : null
    const days = RANGE_DAYS[filters.range]
    return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null
  }, [filters.range, filters.from])
  const rangeEnd = useMemo(() => {
    if (filters.range === 'custom' && filters.to) {
      const d = new Date(filters.to); d.setHours(23, 59, 59, 999); return d
    }
    return null
  }, [filters.range, filters.to])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return events.filter(ev => {
      if (q) {
        const hit = ev.type?.toLowerCase().includes(q)
                 || ev.camera?.toLowerCase().includes(q)
                 || ev.customer?.toLowerCase().includes(q)
                 || ev.label?.toLowerCase().includes(q)
        if (!hit) return false
      }
      if (filters.severity.length && !filters.severity.includes(ev.severity)) return false
      if (filters.userId !== 'all' && ev.userId !== filters.userId) return false
      if (filters.ack === 'unacked' && ev.acked) return false
      if (filters.ack === 'acked'   && !ev.acked) return false
      if (rangeStart && new Date(ev.ts) < rangeStart) return false
      if (rangeEnd   && new Date(ev.ts) > rangeEnd)   return false
      return true
    })
  }, [events, search, filters, rangeStart, rangeEnd])

  // Quick stats from the filtered set
  const counts = {
    critical: filtered.filter(e => e.severity === 'critical').length,
    warning:  filtered.filter(e => e.severity === 'warning').length,
    info:     filtered.filter(e => e.severity === 'info').length,
    unacked:  filtered.filter(e => !e.acked).length,
  }

  const formatTs = (ts) => {
    if (!ts) return '—'
    return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
  }

  return (
    <div className="page">
      <Topbar title="AI Events" subtitle={`${events.length} total · ${filtered.length} matching`} />
      <div className="page-inner">
        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search type, camera, customer, label…" />
          </div>

          <div className="filter-group">
            {RANGE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${filters.range === opt.value ? 'active' : ''}`}
                onClick={() => updateFilter({ range: opt.value })}
              >{opt.label}</button>
            ))}
          </div>

          {filters.range === 'custom' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="date" className="filter-date-input" value={filters.from || ''} max={filters.to || todayISO()} onChange={e => updateFilter({ from: e.target.value })} />
              <span className="filter-date-sep">→</span>
              <input type="date" className="filter-date-input" value={filters.to || ''} min={filters.from || ''} max={todayISO()} onChange={e => updateFilter({ to: e.target.value })} />
            </div>
          )}

          {SEVERITY_OPTIONS.map(opt => {
            const active = filters.severity.includes(opt.value)
            return (
              <button
                key={opt.value}
                className={`filter-chip ${active ? 'active' : ''}`}
                style={active ? { background: opt.color, borderColor: opt.color } : {}}
                onClick={() => toggleSeverity(opt.value)}
              >
                <span className="chip-dot" style={{ background: active ? '#fff' : opt.color }} />
                {opt.label}
              </button>
            )
          })}

          <div className="filter-group">
            {ACK_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${filters.ack === opt.value ? 'active' : ''}`}
                onClick={() => updateFilter({ ack: opt.value })}
              >{opt.label}</button>
            ))}
          </div>

          <select className="select" value={filters.userId} onChange={e => updateFilter({ userId: e.target.value })} style={{ minWidth: 180 }}>
            <option value="all">All Customers</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>

          {isFiltered && (
            <button className="filter-clear" onClick={clearFilters}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}

          <span className="filter-count">{filtered.length} events</span>
        </div>

        {/* Quick severity summary cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }} className="events-summary">
          <SummaryCard label="Critical" value={counts.critical} color="#dc2626" icon="error" />
          <SummaryCard label="Warning"  value={counts.warning}  color="#d97706" icon="warning" />
          <SummaryCard label="Info"     value={counts.info}     color="#2563eb" icon="info" />
          <SummaryCard label="Unacked"  value={counts.unacked}  color={counts.unacked > 0 ? '#dc2626' : '#16a34a'} icon="notifications_active" />
        </div>

        {loading ? <Spinner /> : error ? (
          <div style={{ padding: '16px 20px', background: 'var(--color-danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 'var(--radius-md)', color: 'var(--color-danger-text)' }}>Error: {error}</div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {filtered.length === 0 ? <EmptyState icon="crisis_alert" title="No events match" message="Try adjusting your filters or search." /> : (
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Event Type</th>
                      <th className="hide-mobile">Camera</th>
                      <th className="hide-mobile">Customer</th>
                      <th>Time</th>
                      <th>Ack</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(ev => (
                      <tr key={ev.id}>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 99, background: severityBg[ev.severity] || 'var(--surface-muted)', color: severityColor[ev.severity] || 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600 }}>
                            <span className="material-symbols-outlined icon-sm">{severityIcon[ev.severity] || 'info'}</span>
                            {ev.severity}
                          </span>
                        </td>
                        <td style={{ fontWeight: 500 }}>{ev.type}</td>
                        <td className="hide-mobile" style={{ color: 'var(--color-text-secondary)' }}>{ev.camera}</td>
                        <td className="hide-mobile" style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{ev.customer}</td>
                        <td className="mono" style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{formatTs(ev.ts)}</td>
                        <td>
                          {ev.acked
                            ? <span className="material-symbols-outlined icon-sm icon-filled" style={{ color: '#16a34a' }}>check_circle</span>
                            : <span className="material-symbols-outlined icon-sm" style={{ color: '#d97706' }}>pending</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, color, icon }) {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-md)',
      padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 12,
      boxShadow: 'var(--shadow-sm)',
      transition: 'box-shadow .15s, transform .15s',
    }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.transform = '' }}
    >
      <div style={{ width: 36, height: 36, borderRadius: 10, background: color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-outlined" style={{ color, fontSize: 20 }}>{icon}</span>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-on-bg)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{value.toLocaleString()}</div>
      </div>
    </div>
  )
}
