import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { KpiTile } from './account/parts.jsx'
import { AuditTable } from './account/HubTabs.jsx'
import { ACTION_LABELS, describeChange, downloadCsv, timeAgo } from './account/format.js'

/**
 * Audit log — what platform operators changed, from admin_audit_log.
 * Server-paged; filters by account, operator, change type and date. Export
 * CSV downloads every row of the current filter (up to EXPORT_MAX).
 */

const LIMIT = 50
const EXPORT_MAX = 5000

export default function AuditLog() {
  const [params, setParams] = useSearchParams()
  const filters = {
    accountId: params.get('accountId') || '',
    actorId: params.get('actorId') || '',
    action: params.get('action') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
  }
  const page = Math.max(1, Number(params.get('page')) || 1)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [exporting, setExporting] = useState(false)

  const setFilter = (patch) => {
    const next = { ...filters, ...patch }
    const out = {}
    for (const [k, v] of Object.entries(next)) if (v) out[k] = v
    if (patch.page) out.page = String(patch.page)
    setParams(out)
  }
  const key = params.toString()

  useEffect(() => {
    let live = true
    const q = Object.fromEntries(new URLSearchParams(key))
    adminApi.listAudit({ ...q, to: q.to ? `${q.to}T23:59:59` : '', page: Number(q.page) || 1, limit: LIMIT })
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [key])

  useEffect(() => {
    adminApi.listAccounts().then((d) => setAccounts(d.accounts || [])).catch(() => {})
  }, [])

  const exportCsv = async () => {
    setExporting(true)
    try {
      const rows = []
      for (let p = 1; rows.length < EXPORT_MAX; p += 1) {
        const d = await adminApi.listAudit({ ...filters, to: filters.to ? `${filters.to}T23:59:59` : '', page: p, limit: 500 })
        rows.push(...d.rows)
        if (rows.length >= d.total || !d.rows.length) break
      }
      downloadCsv(
        `drishyam-admin-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        ['When (UTC)', 'Change', 'Action key', 'Account', 'Account email', 'Detail', 'By', 'IP'],
        rows.slice(0, EXPORT_MAX).map((r) => [
          new Date(r.ts).toISOString(), ACTION_LABELS[r.action] || r.action, r.action,
          r.account?.name || r.resourceId || '', r.account?.email || '', describeChange(r),
          r.actor?.email || r.actor?.name || r.actor?.id || '', r.ip || '',
        ]),
      )
    } catch (e) {
      alert(`Export failed: ${e.message}`)
    }
    setExporting(false)
  }

  const facets = data?.facets || { actors: [], actions: [] }
  const filtered = Object.values(filters).some(Boolean)
  const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1

  return (
    <div className="page">
      <Topbar
        title="Audit log"
        subtitle="Every change a platform operator made to a customer account"
        actions={
          <button className="btn btn-ghost" onClick={exportCsv} disabled={exporting || !data?.total}>
            <span className="material-symbols-outlined icon-sm">download</span>
            <span className="hide-mobile-inline">{exporting ? 'Exporting…' : 'Export CSV'}</span>
          </button>
        }
      />
      <div className="page-inner">
        {data && (
          <div className="hub-tiles">
            <KpiTile label={filtered ? 'Matching changes' : 'Changes recorded'} value={data.total.toLocaleString('en-IN')} />
            <KpiTile label="Latest change" value={data.rows[0] ? timeAgo(data.rows[0].ts) : '—'} sub={data.rows[0] ? (ACTION_LABELS[data.rows[0].action] || data.rows[0].action) : null} />
            <KpiTile label="Operators" value={facets.actors.length} sub="have made changes" />
          </div>
        )}

        <div className="filter-bar">
          <select className="select" value={filters.accountId} onChange={(e) => setFilter({ accountId: e.target.value })} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ''}</option>)}
          </select>
          <select className="select" value={filters.actorId} onChange={(e) => setFilter({ actorId: e.target.value })} aria-label="Operator">
            <option value="">All operators</option>
            {facets.actors.map((a) => <option key={a.id} value={a.id}>{a.email || a.name || a.id}</option>)}
          </select>
          <select className="select" value={filters.action} onChange={(e) => setFilter({ action: e.target.value })} aria-label="Change type">
            <option value="">All changes</option>
            {facets.actions.map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
          <input type="date" className="filter-date-input" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter({ from: e.target.value })} aria-label="From date" />
          <input type="date" className="filter-date-input" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter({ to: e.target.value })} aria-label="To date" />
          {filtered && (
            <button className="filter-clear" onClick={() => setParams({})}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}
        </div>

        {error ? <div className="notice notice-danger">{error}</div> : !data ? <Spinner /> : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {data.rows.length === 0
              ? <EmptyState icon="receipt_long" title="No changes" message={filtered ? 'Nothing matches this filter.' : 'Plan, licence, feature and suspend changes appear here.'} />
              : (
                <>
                  <AuditTable rows={data.rows} showAccount />
                  <div className="pager">
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>Page {page} of {pages}</span>
                    <button className="btn btn-ghost" disabled={page <= 1} onClick={() => setFilter({ page: page - 1 })} aria-label="Previous page">
                      <span className="material-symbols-outlined icon-sm">chevron_left</span>
                    </button>
                    <button className="btn btn-ghost" disabled={page >= pages} onClick={() => setFilter({ page: page + 1 })} aria-label="Next page">
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
