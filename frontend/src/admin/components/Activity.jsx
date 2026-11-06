import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { ActivityRow, CategoryChips } from './activity/parts.jsx'
import { useActivity, useActivityEvents } from './activity/activityStore.js'
import { CATEGORIES, readCategories, saveCategories } from './activity/format.js'

/**
 * Activity — the whole platform's live feed: signups, account changes,
 * cameras and NVRs, sign-ins, platform services. Server-paged history
 * (GET /admin/activity); page 1 also streams new events in as they happen.
 */

const LIMIT = 50
const CATS_KEY = 'admin_activity_page_cats'
const SEVERITY = [
  { value: '', label: 'All severities' },
  { value: 'warning,critical', label: 'Warnings and critical' },
  { value: 'critical', label: 'Critical only' },
]

export default function Activity() {
  const { status } = useActivity()
  const [params, setParams] = useSearchParams()
  const accountId = params.get('accountId') || ''
  const severity = params.get('severity') || ''
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [cats, setCatsState] = useState(() => readCategories(CATS_KEY))
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [fresh, setFresh] = useState(() => new Set())
  const [missed, setMissed] = useState(0)

  const setCats = (v) => { setCatsState(v); saveCategories(CATS_KEY, v); setParam({ page: '' }) }
  const setParam = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k) }
    setParams(next)
  }
  const allCats = cats.length === CATEGORIES.length
  const catKey = cats.slice().sort().join(',')

  useEffect(() => {
    let live = true
    if (!catKey) return undefined
    adminApi.listActivity({ page, limit: LIMIT, accountId, severity, category: allCats ? '' : catKey })
      .then((d) => { if (live) { setData(d); setError(null); setMissed(0) } })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [page, accountId, severity, catKey, allCats])

  useEffect(() => {
    adminApi.listAccounts().then((d) => setAccounts(d.accounts || [])).catch(() => {})
  }, [])

  // New events: on page 1 they slide in at the top; elsewhere they are counted.
  useActivityEvents((ev) => {
    if (!cats.includes(ev.category)) return
    if (accountId && ev.accountId !== accountId) return
    if (severity && !severity.split(',').includes(ev.severity)) return
    if (page !== 1) { setMissed((n) => n + 1); return }
    setData((d) => {
      if (!d || d.events.some((x) => x.id && x.id === ev.id)) return d
      return { ...d, total: d.total + 1, events: [ev, ...d.events].slice(0, LIMIT) }
    })
    if (ev.id) setFresh((s) => new Set(s).add(ev.id))
  })

  const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1
  const filtered = !!accountId || !!severity || cats.length !== CATEGORIES.length

  return (
    <div className="page">
      <Topbar
        title="Activity"
        subtitle={status === 'live' ? 'Everything happening on the platform, as it happens' : 'Live updates paused, reconnecting'}
      />
      <div className="page-inner">
        <div className="filter-bar">
          <CategoryChips value={cats} onChange={setCats} />
          <select className="select" value={accountId} onChange={(e) => setParam({ accountId: e.target.value, page: '' })} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ''}</option>)}
          </select>
          <select className="select" value={severity} onChange={(e) => setParam({ severity: e.target.value, page: '' })} aria-label="Severity">
            {SEVERITY.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {filtered && (
            <button className="filter-clear" onClick={() => { setCats(CATEGORIES.map((c) => c.id)); setParams({}) }}>
              <span className="material-symbols-outlined">close</span> Show everything
            </button>
          )}
          {data && <span className="filter-count">{data.total.toLocaleString('en-IN')} event{data.total === 1 ? '' : 's'}</span>}
        </div>

        {missed > 0 && (
          <button className="notice" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 12, cursor: 'pointer', font: 'inherit' }} onClick={() => setParam({ page: '' })}>
            {missed} new event{missed === 1 ? '' : 's'} since you opened this page. Show the latest
          </button>
        )}

        {!cats.length ? (
          <div className="card"><EmptyState icon="filter_alt_off" title="Nothing selected" message="Choose at least one kind of activity above." /></div>
        ) : error ? <div className="notice notice-danger">{error}</div> : !data ? <Spinner /> : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {data.events.length === 0
              ? <EmptyState icon="bolt" title="No activity" message={filtered ? 'Nothing matches this filter yet.' : 'Signups, account changes, camera problems and sign-ins appear here as they happen.'} />
              : (
                <>
                  {data.events.map((e) => <ActivityRow key={e.id || `${e.type}${e.createdAt}`} e={e} fresh={fresh.has(e.id)} />)}
                  <div className="pager" style={{ borderTop: '1px solid var(--color-border)' }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>Page {page} of {pages}</span>
                    <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setParam({ page: page - 1 > 1 ? String(page - 1) : '' })} aria-label="Previous page">
                      <span className="material-symbols-outlined icon-sm">chevron_left</span>
                    </button>
                    <button className="btn btn-ghost" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })} aria-label="Next page">
                      <span className="material-symbols-outlined icon-sm">chevron_right</span>
                    </button>
                  </div>
                </>
              )}
          </div>
        )}
      </div>
    </div>
  )
}
