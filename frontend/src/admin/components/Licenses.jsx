import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatCurrency } from '../data/index.js'

const STATUS_META = {
  draft:      { label: 'Draft',      color: 'var(--color-text-secondary)', bg: 'var(--surface-muted)' },
  trial:      { label: 'Trial',      color: '#7c3aed', bg: 'light-dark(#faf5ff, var(--ai-soft))' },
  active:     { label: 'Active',     color: '#16a34a', bg: 'var(--color-success-bg)' },
  suspended:  { label: 'Suspended',  color: '#d97706', bg: 'var(--color-warning-bg)' },
  expired:    { label: 'Expired',    color: '#dc2626', bg: 'var(--color-danger-bg)' },
  terminated: { label: 'Terminated', color: '#dc2626', bg: 'var(--color-danger-bg)' },
}

const TERM_LABELS = {
  trial_30:  'Trial 30',  trial_60: 'Trial 60',  trial_90: 'Trial 90',
  monthly:   'Monthly',   annual:   '1-Year',
  biennial:  '2-Year',    triennial: '3-Year',
}

function daysUntil(iso) {
  if (!iso) return null
  const ms = new Date(iso) - new Date()
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

export default function Licenses() {
  const navigate = useNavigate()
  const [licenses, setLicenses] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  const [search, setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [termFilter, setTermFilter]     = useState('all')

  useEffect(() => {
    setLoading(true)
    adminApi.listLicenses({ status: statusFilter, term: termFilter, search })
      .then(d => setLicenses(d.licenses || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [statusFilter, termFilter, search])

  // Aggregate KPIs ────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const active = licenses.filter(l => l.status === 'active')
    const trial  = licenses.filter(l => l.status === 'trial')
    const totalMrr = active.reduce((s, l) => s + (l.mrr || 0), 0)
    const totalArr = active.reduce((s, l) => s + (l.arr || 0), 0)
    const expiringSoon = licenses.filter(l => {
      const d = daysUntil(l.endDate)
      return d !== null && d <= 30 && d >= 0 && (l.status === 'active' || l.status === 'trial')
    }).length
    return { total: licenses.length, active: active.length, trial: trial.length, totalMrr, totalArr, expiringSoon }
  }, [licenses])

  const isFiltered = search.trim() !== '' || statusFilter !== 'all' || termFilter !== 'all'
  const clearFilters = () => { setSearch(''); setStatusFilter('all'); setTermFilter('all') }

  return (
    <div className="page">
      <Topbar
        title="Licenses"
        subtitle="Custom enterprise licenses across all customers"
        actions={
          <a href="/admin/calculator" className="btn btn-primary">
            <span className="material-symbols-outlined icon-sm">add</span>
            New License
          </a>
        }
      />
      <div className="page-inner">
        {/* KPI strip */}
        <div className="dash-kpi-grid" style={{ marginBottom: 18 }}>
          <KpiTile label="Total Licenses"  value={kpis.total}    icon="workspace_premium" color="#2563eb" />
          <KpiTile label="Active"          value={kpis.active}   icon="verified"          color="#16a34a" />
          <KpiTile label="On Trial"        value={kpis.trial}    icon="schedule"          color="#7c3aed" />
          <KpiTile label="MRR"             value={formatCurrency(kpis.totalMrr)} icon="payments" color="#16a34a" raw />
          <KpiTile label="ARR"             value={formatCurrency(kpis.totalArr)} icon="trending_up" color="#0ea5e9" raw />
          <KpiTile label="Expiring ≤30d"   value={kpis.expiringSoon} icon="event_busy" color={kpis.expiringSoon > 0 ? '#dc2626' : '#16a34a'} />
        </div>

        {/* Filter bar */}
        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by customer name or email…" />
          </div>

          <div className="filter-group">
            {[
              { value: 'all',        label: 'All' },
              { value: 'active',     label: 'Active' },
              { value: 'trial',      label: 'Trial' },
              { value: 'suspended',  label: 'Suspended' },
              { value: 'expired',    label: 'Expired' },
              { value: 'terminated', label: 'Terminated' },
            ].map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${statusFilter === opt.value ? 'active' : ''}`}
                onClick={() => setStatusFilter(opt.value)}
              >{opt.label}</button>
            ))}
          </div>

          <select className="select" value={termFilter} onChange={e => setTermFilter(e.target.value)}>
            <option value="all">All terms</option>
            {Object.entries(TERM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>

          {isFiltered && (
            <button className="filter-clear" onClick={clearFilters}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}

          <span className="filter-count">{licenses.length} license{licenses.length !== 1 ? 's' : ''}</span>
        </div>

        {error && (
          <div style={{ padding: '14px 18px', background: 'var(--color-danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 'var(--radius-md)', color: 'var(--color-danger-text)', marginBottom: 18 }}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {loading ? <Spinner /> : (
          licenses.length === 0 ? (
            <EmptyState
              icon="workspace_premium"
              title="No licenses yet"
              message="Open the Pricing Calculator to build the first license."
            />
          ) : (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Term</th>
                      <th className="hide-mobile">Cameras</th>
                      <th className="hide-mobile">Features</th>
                      <th style={{ textAlign: 'right' }}>MRR</th>
                      <th style={{ textAlign: 'right' }} className="hide-mobile">ARR</th>
                      <th>Ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {licenses.map(l => {
                      const meta = STATUS_META[l.status] || STATUS_META.draft
                      const dLeft = daysUntil(l.endDate)
                      const camPct = l.cameraQuota > 0 ? Math.round((l.camerasUsed / l.cameraQuota) * 100) : 0
                      const camColor = camPct >= 90 ? '#dc2626' : camPct >= 75 ? '#d97706' : '#16a34a'
                      return (
                        <tr key={l.id} onClick={() => navigate(`/admin/licenses/${l.id}`)}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div className="avatar" style={{ background: 'var(--color-primary-bg)', color: 'var(--color-primary-dark)' }}>
                                {(l.customer?.name || '?').slice(0, 2).toUpperCase()}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600 }}>{l.customer?.name || 'Unknown'}</div>
                                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }} className="truncate">{l.customer?.email}</div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, background: meta.bg, color: meta.color, fontSize: 12, fontWeight: 600 }}>
                              <span className="chip-dot" style={{ background: meta.color }} />
                              {meta.label}
                            </span>
                          </td>
                          <td style={{ fontSize: 12, fontWeight: 600 }}>{TERM_LABELS[l.term] || l.term}</td>
                          <td className="hide-mobile">
                            {l.cameraQuota > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ width: 80, height: 6, background: 'var(--color-bg)', borderRadius: 99, overflow: 'hidden' }}>
                                  <div style={{ width: `${Math.min(100, camPct)}%`, height: '100%', background: camColor, transition: 'width .3s' }} />
                                </div>
                                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: camColor }}>
                                  {l.camerasUsed}/{l.cameraQuota}
                                </span>
                              </div>
                            ) : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                          </td>
                          <td className="hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                            {l.featuresEnabled} enabled
                          </td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                            {formatCurrency(l.mrr)}
                          </td>
                          <td className="mono hide-mobile" style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                            {formatCurrency(l.arr)}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {l.endDate ? (
                              <div>
                                <div style={{ color: 'var(--color-text-secondary)' }}>{l.endDate}</div>
                                {dLeft !== null && (
                                  <div style={{
                                    fontSize: 11, fontWeight: 600,
                                    color: dLeft < 0 ? '#dc2626' : dLeft <= 30 ? '#d97706' : 'var(--color-text-muted)',
                                  }}>
                                    {dLeft < 0 ? `${Math.abs(dLeft)}d expired` : `${dLeft}d left`}
                                  </div>
                                )}
                              </div>
                            ) : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function KpiTile({ label, value, icon, color, raw }) {
  return (
    <div className="kpi-card">
      <span className="kpi-accent" style={{ background: color }} />
      <div className="kpi-head" style={{ color }}>
        <span className="material-symbols-outlined">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="kpi-value">{raw ? value : (value ?? 0).toLocaleString()}</div>
    </div>
  )
}
