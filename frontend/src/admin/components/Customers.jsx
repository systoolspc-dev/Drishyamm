import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatDate } from '../data/index.js'
import { UsageMeter, HealthCell, KpiTile, StatusDot } from './account/parts.jsx'
import { usageTone, expiryTone, toneText, timeAgo, AI_SHORT, EXPIRING_DAYS } from './account/format.js'
import { useActivityEvents } from './activity/activityStore.js'

/**
 * Accounts — one row per customer account (the owner). Platform operators and
 * the users inside an account are not listed; open an account to see its users.
 *
 * Camera health is the customer Health page's own classification (online
 * includes idle cameras that connect on demand), not the DB status column.
 *
 * Live: a new signup appears at the top (kept there for this visit) with a
 * brief highlight; a suspend/reactivate flips the row at once; camera, plan and
 * team events re-read the list (debounced) and highlight the affected row.
 */

const FRESH_MS = 6000

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
]

function isOverLimit(a) {
  if (usageTone(a.cameras.used, a.cameras.limit) === 'danger') return true
  return a.ai.some((l) => l.on && usageTone(l.used, l.limit) === 'danger')
}
function isExpiring(a) {
  const d = a.licenceRecord?.daysLeft
  return d !== null && d !== undefined && d <= EXPIRING_DAYS
}

function AiCell({ account }) {
  if (!account.plan?.aiEnabled) return <span className="tone-muted" style={{ fontSize: 12.5 }}>No AI on plan</span>
  const inUse = account.ai.filter((l) => l.on && (l.used > 0 || l.limit !== null))
  if (!inUse.length) return <span className="tone-muted" style={{ fontSize: 12.5 }}>None in use</span>
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
      {inUse.map((l) => {
        const tone = usageTone(l.used, l.limit)
        return (
          <div key={l.key} style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{AI_SHORT[l.key] || l.label}</span>{' '}
            <span className="mono" style={{ fontWeight: 600, color: toneText(tone) }}>
              {l.used}{l.limit !== null ? `/${l.limit}` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function LicenceCell({ rec }) {
  if (!rec) return <span className="tone-muted" style={{ fontSize: 12.5 }}>No record</span>
  const tone = expiryTone(rec.daysLeft)
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
      <div style={{ fontWeight: 600, color: toneText(tone) }}>{rec.endDate ? formatDate(rec.endDate) : 'No end date'}</div>
      <div style={{ fontSize: 11.5, color: tone ? toneText(tone) : 'var(--color-text-muted)' }}>
        {rec.daysLeft === null ? rec.status : rec.daysLeft < 0 ? `expired ${-rec.daysLeft} d ago` : `${rec.daysLeft} d left · ${rec.status}`}
      </div>
    </div>
  )
}

export default function Customers() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [healthSource, setHealthSource] = useState('live')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [overLimit, setOverLimit] = useState(false)
  const [expiring, setExpiring] = useState(false)
  const [sortBy, setSortBy] = useState('cameras') // cameras | name | joined | active

  const load = useCallback(() => adminApi.listAccounts()
    .then((d) => { setAccounts(d.accounts || []); setHealthSource(d.healthSource); setError(null) })
    .catch((e) => setError(e.message))
    .finally(() => setLoading(false)), [])
  useEffect(() => { load() }, [load])

  // ── live ──
  const [pinned, setPinned] = useState(() => new Set())   // signups seen this visit, shown first
  const [fresh, setFresh] = useState(() => new Set())     // rows to highlight briefly
  const timers = useRef({ reload: null, fresh: [] })
  useEffect(() => () => { clearTimeout(timers.current.reload); timers.current.fresh.forEach(clearTimeout) }, [])
  const highlight = (id) => {
    setFresh((s) => new Set(s).add(id))
    timers.current.fresh.push(setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(id); return n }), FRESH_MS))
  }
  const reloadSoon = (ms) => {
    clearTimeout(timers.current.reload)
    timers.current.reload = setTimeout(() => { load() }, ms)
  }
  useActivityEvents((ev) => {
    if (!ev.accountId || ev.category === 'logins' || ev.category === 'system') return
    if (ev.type === 'account.created') {
      setPinned((s) => new Set(s).add(ev.accountId))
      highlight(ev.accountId)
      reloadSoon(600)
      return
    }
    if (ev.type === 'account.suspended' || ev.type === 'account.reactivated') {
      const status = ev.type === 'account.suspended' ? 'suspended' : 'active'
      setAccounts((list) => list.map((a) => (a.id === ev.accountId ? { ...a, status } : a)))
    }
    highlight(ev.accountId)
    reloadSoon(2000)
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts
      .filter((a) => !q || (a.name || '').toLowerCase().includes(q) || (a.email || '').toLowerCase().includes(q))
      .filter((a) => statusFilter === 'all' || a.status === statusFilter)
      .filter((a) => !overLimit || isOverLimit(a))
      .filter((a) => !expiring || isExpiring(a))
      .sort((a, b) => {
        const pa = pinned.has(a.id) ? 1 : 0
        const pb = pinned.has(b.id) ? 1 : 0
        if (pa !== pb) return pb - pa
        if (pa && pb) return new Date(b.createdAt) - new Date(a.createdAt)
        if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '')
        if (sortBy === 'joined') return new Date(b.createdAt) - new Date(a.createdAt)
        if (sortBy === 'active') return new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0)
        return (b.cameras.used - a.cameras.used) || (a.name || '').localeCompare(b.name || '')
      })
  }, [accounts, search, statusFilter, overLimit, expiring, sortBy, pinned])

  const suspended = accounts.filter((a) => a.status === 'suspended').length
  // Paying = an active commercial licence record. Plan price alone is not
  // revenue (every trial owner sits on a priced plan), so it is not used here.
  const paying = accounts.filter((a) => a.licenceRecord?.status === 'active').length
  const camsOnline = accounts.reduce((n, a) => n + (a.health?.online || 0), 0)
  const camsTotal = accounts.reduce((n, a) => n + (a.health?.total || 0), 0)
  const camsOffline = accounts.reduce((n, a) => n + (a.health?.offline || 0), 0)
  const overCount = accounts.filter(isOverLimit).length
  const expCount = accounts.filter(isExpiring).length
  const isFiltered = search.trim() !== '' || statusFilter !== 'all' || overLimit || expiring
  const clearFilters = () => { setSearch(''); setStatusFilter('all'); setOverLimit(false); setExpiring(false) }

  return (
    <div className="page">
      <Topbar
        title="Accounts"
        subtitle={loading ? 'Loading…' : `${accounts.length} customer accounts${suspended ? ` · ${suspended} suspended` : ''}`}
      />
      <div className="page-inner">
        {!loading && !error && (
          <div className="hub-tiles five">
            <KpiTile label="Paying accounts" value={paying} sub={`of ${accounts.length} · active licence record`} />
            <KpiTile label="Cameras online" value={`${camsOnline} / ${camsTotal}`} sub={camsOffline ? `${camsOffline} offline` : 'none offline'} subTone={camsOffline ? 'danger' : null} />
            <KpiTile label="At or over a limit" value={overCount} sub="cameras or an AI licence" tone={overCount ? 'danger' : null} onClick={() => setOverLimit((v) => !v)} active={overLimit} />
            <KpiTile label={`Licences ending ≤ ${EXPIRING_DAYS} d`} value={expCount} sub="or already expired" tone={expCount ? 'warning' : null} onClick={() => setExpiring((v) => !v)} active={expiring} />
            <KpiTile label="Suspended" value={suspended} sub="cannot sign in" onClick={() => setStatusFilter((v) => (v === 'suspended' ? 'all' : 'suspended'))} active={statusFilter === 'suspended'} />
          </div>
        )}

        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" aria-label="Search accounts" />
          </div>

          <div className="filter-group" role="group" aria-label="Status">
            {STATUS_OPTIONS.map((opt) => (
              <button key={opt.value} className={`filter-pill ${statusFilter === opt.value ? 'active' : ''}`} onClick={() => setStatusFilter(opt.value)}>
                {opt.label}
              </button>
            ))}
          </div>

          <button className={`filter-pill ${overLimit ? 'active' : ''}`} aria-pressed={overLimit} onClick={() => setOverLimit((v) => !v)}>
            At or over limit{overCount ? ` (${overCount})` : ''}
          </button>
          <button className={`filter-pill ${expiring ? 'active' : ''}`} aria-pressed={expiring} onClick={() => setExpiring((v) => !v)}>
            Licence ends ≤ {EXPIRING_DAYS} d{expCount ? ` (${expCount})` : ''}
          </button>

          <select className="select" value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort">
            <option value="cameras">Sort: Most cameras</option>
            <option value="name">Sort: Name (A→Z)</option>
            <option value="joined">Sort: Newest</option>
            <option value="active">Sort: Last active</option>
          </select>

          {isFiltered && (
            <button className="filter-clear" onClick={clearFilters}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}
          <span className="filter-count">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {healthSource !== 'live' && !loading && (
          <div className="notice notice-warning" style={{ marginBottom: 12 }}>
            The stream service did not answer, so camera health below may show cameras as idle or offline that are not.
          </div>
        )}

        {loading ? <Spinner /> : error ? (
          <div className="notice notice-danger">Error: {error}</div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {filtered.length === 0 ? <EmptyState title="No accounts found" message="Try a different search or filter." /> : (
              <>
              <div className="acct-cards">
                {filtered.map((a) => (
                  <button key={a.id} className={`acct-card ${fresh.has(a.id) ? 'row-fresh' : ''}`} onClick={() => navigate(`/admin/customers/${a.id}`)}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }} className="truncate">{a.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }} className="truncate">{a.email || 'no email'} · {a.plan ? a.plan.name : 'No plan'}</div>
                    </div>
                    <StatusDot tone={a.status === 'active' ? 'success' : 'danger'}>{a.status === 'active' ? 'Active' : 'Suspended'}</StatusDot>
                    <div className="acct-card-meta">
                      <UsageMeter used={a.cameras.used} limit={a.cameras.limit} unit="cams" />
                      <HealthCell health={a.health} />
                    </div>
                  </button>
                ))}
              </div>
              <div className="table-wrapper acct-table">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Plan</th>
                      <th>Cameras</th>
                      <th>AI in use</th>
                      <th>Camera health</th>
                      <th className="hide-mobile">Licence record</th>
                      <th>Status</th>
                      <th className="hide-mobile">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((a) => (
                      <tr
                        key={a.id}
                        className={fresh.has(a.id) ? 'row-fresh' : undefined}
                        tabIndex={0}
                        onClick={() => navigate(`/admin/customers/${a.id}`)}
                        onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/customers/${a.id}`) }}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{a.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                            {a.email || 'no email'}{a.members ? ` · ${a.members + 1} users` : ''}
                          </div>
                        </td>
                        <td style={{ fontSize: 13 }}>{a.plan ? a.plan.name : <span className="tone-muted">No plan</span>}</td>
                        <td><UsageMeter used={a.cameras.used} limit={a.cameras.limit} /></td>
                        <td><AiCell account={a} /></td>
                        <td><HealthCell health={a.health} /></td>
                        <td className="hide-mobile"><LicenceCell rec={a.licenceRecord} /></td>
                        <td><StatusDot tone={a.status === 'active' ? 'success' : 'danger'}>{a.status === 'active' ? 'Active' : 'Suspended'}</StatusDot></td>
                        <td className="hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(a.lastActiveAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 10 }}>
          Limits are the enforced ones (account → Licences & features). Last active = last sign-in or session refresh by anyone in the account.
        </p>
      </div>
    </div>
  )
}
