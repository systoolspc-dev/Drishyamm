import { useState, useEffect, useMemo } from 'react'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatCurrency } from '../data/index.js'

const CATEGORY_META = {
  camera:     { label: 'Cameras',          icon: 'videocam',       color: '#2563eb' },
  storage:    { label: 'Storage',          icon: 'database',       color: '#16a34a' },
  compute:    { label: 'Compute (GPU)',    icon: 'memory',         color: '#7c3aed' },
  ai_feature: { label: 'AI Features',      icon: 'smart_toy',      color: '#F7983A' },
  support:    { label: 'Support Tiers',    icon: 'support_agent',  color: '#0ea5e9' },
  one_time:   { label: 'One-Time Fees',    icon: 'receipt',        color: '#d97706' },
  discount:   { label: 'Term Multipliers', icon: 'discount',       color: '#dc2626' },
}

const CATEGORY_ORDER = ['camera', 'storage', 'compute', 'ai_feature', 'support', 'one_time', 'discount']

export default function PricingCatalog() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // sku of currently editing row
  const [draft, setDraft] = useState({})       // { unitPriceInr, name, description }
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('all')

  const load = () => {
    setLoading(true)
    adminApi.getPricingCatalog()
      .then(d => setItems(d.items || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const grouped = useMemo(() => {
    const q = search.toLowerCase()
    const filtered = items.filter(it => {
      if (filterCat !== 'all' && it.category !== filterCat) return false
      if (!q) return true
      return it.sku.toLowerCase().includes(q)
          || it.name.toLowerCase().includes(q)
          || (it.description || '').toLowerCase().includes(q)
    })
    const map = {}
    for (const it of filtered) {
      if (!map[it.category]) map[it.category] = []
      map[it.category].push(it)
    }
    return map
  }, [items, search, filterCat])

  const startEdit = (item) => {
    setEditing(item.id)
    setDraft({
      unitPriceInr: item.unitPriceInr,
      name: item.name,
      description: item.description || '',
    })
  }
  const cancelEdit = () => { setEditing(null); setDraft({}) }
  const saveEdit = async (item) => {
    setSaving(true)
    try {
      const d = await adminApi.updatePricingCatalogItem(item.id, draft)
      setItems(prev => prev.map(x => x.id === item.id ? d.item : x))
      setEditing(null); setDraft({})
    } catch (e) {
      alert('Save failed: ' + e.message)
    }
    setSaving(false)
  }

  const toggleActive = async (item) => {
    try {
      const d = await adminApi.updatePricingCatalogItem(item.id, { isActive: !item.isActive })
      setItems(prev => prev.map(x => x.id === item.id ? d.item : x))
    } catch (e) {
      alert('Update failed: ' + e.message)
    }
  }

  // Stat strip — useful at-a-glance pricing summary
  const stats = useMemo(() => {
    const get = (sku) => items.find(i => i.sku === sku)
    return {
      hd: get('cam_hd')?.unitPriceInr,
      k4: get('cam_4k')?.unitPriceInr,
      gb: get('storage_gb')?.unitPriceInr,
      gpu: get('gpu_hour')?.unitPriceInr,
      faceRec: get('feat_face_rec')?.unitPriceInr,
    }
  }, [items])

  return (
    <div className="page">
      <Topbar
        title="Pricing Catalog"
        subtitle="Edit per-unit rates used by the calculator and license builder"
        actions={
          <a href="/admin/calculator" className="btn btn-primary">
            <span className="material-symbols-outlined icon-sm">calculate</span>
            Open Calculator
          </a>
        }
      />
      <div className="page-inner">
        {/* Quick rates summary */}
        <div className="dash-kpi-grid" style={{ marginBottom: 18 }}>
          <RateCard label="HD camera"    value={stats.hd}     unit="/cam-mo"  icon="videocam"      color="#2563eb" />
          <RateCard label="4K camera"    value={stats.k4}     unit="/cam-mo"  icon="4k"            color="#7c3aed" />
          <RateCard label="Storage"      value={stats.gb}     unit="/GB-mo"   icon="database"      color="#16a34a" />
          <RateCard label="GPU hour"     value={stats.gpu}    unit="/hour"    icon="memory"        color="#F7983A" />
          <RateCard label="Face Rec"     value={stats.faceRec} unit="/cam-mo" icon="face"          color="#dc2626" />
          <RateCard label="Total SKUs"   value={items.length} unit="active"   icon="inventory_2"   color="#0ea5e9" raw />
        </div>

        {/* Filter bar */}
        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU, name, description…" />
          </div>
          <div className="filter-group">
            <button className={`filter-pill ${filterCat === 'all' ? 'active' : ''}`} onClick={() => setFilterCat('all')}>All</button>
            {CATEGORY_ORDER.map(cat => (
              <button key={cat} className={`filter-pill ${filterCat === cat ? 'active' : ''}`} onClick={() => setFilterCat(cat)}>
                {CATEGORY_META[cat].label}
              </button>
            ))}
          </div>
          <span className="filter-count">{items.length} SKUs</span>
        </div>

        {error && (
          <div style={{ padding: '14px 18px', background: 'var(--color-danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 'var(--radius-md)', color: 'var(--color-danger-text)', marginBottom: 18 }}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {loading ? <Spinner /> : (
          CATEGORY_ORDER.filter(cat => grouped[cat]?.length).length === 0 ? (
            <EmptyState title="No SKUs found" message="Try adjusting your filter." />
          ) : (
            CATEGORY_ORDER.map(cat => {
              const rows = grouped[cat] || []
              if (rows.length === 0) return null
              const meta = CATEGORY_META[cat]
              return (
                <div key={cat} className="panel" style={{ marginBottom: 18 }}>
                  <div className="panel-head">
                    <div className="panel-title">
                      <span className="material-symbols-outlined" style={{ color: meta.color }}>{meta.icon}</span>
                      {meta.label}
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Name</th>
                          <th className="hide-mobile">Description</th>
                          <th>Unit</th>
                          <th style={{ textAlign: 'right' }}>Price ({cat === 'discount' ? '× 100' : '₹'})</th>
                          <th>Status</th>
                          <th style={{ width: 1 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(it => {
                          const isEditing = editing === it.id
                          return (
                            <tr key={it.id} style={{ opacity: it.isActive ? 1 : 0.55 }}>
                              <td><code style={{ fontSize: 12, background: 'var(--color-bg)', padding: '2px 6px', borderRadius: 4 }}>{it.sku}</code></td>
                              <td>
                                {isEditing ? (
                                  <input className="input" style={{ padding: '4px 8px', fontSize: 13 }} value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
                                ) : (
                                  <span style={{ fontWeight: 600 }}>{it.name}</span>
                                )}
                              </td>
                              <td className="hide-mobile" style={{ color: 'var(--color-text-secondary)', maxWidth: 320 }}>
                                {isEditing ? (
                                  <input className="input" style={{ padding: '4px 8px', fontSize: 12 }} value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
                                ) : (
                                  <span className="truncate" style={{ display: 'block', fontSize: 12 }}>{it.description || '—'}</span>
                                )}
                              </td>
                              <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }} className="mono">{it.unit}</td>
                              <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                                {isEditing ? (
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    className="input"
                                    style={{ width: 120, padding: '4px 8px', fontSize: 13, textAlign: 'right' }}
                                    value={draft.unitPriceInr}
                                    onChange={e => setDraft(d => ({ ...d, unitPriceInr: e.target.value }))}
                                  />
                                ) : (
                                  cat === 'discount' ? `× ${(Number(it.unitPriceInr) / 100).toFixed(2)}`
                                  : Number(it.unitPriceInr).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                                )}
                              </td>
                              <td>
                                <span
                                  className={`chip ${it.isActive ? 'chip-green' : 'chip-gray'}`}
                                  onClick={() => toggleActive(it)}
                                  style={{ cursor: 'pointer' }}
                                  title="Click to toggle"
                                >
                                  <span className="chip-dot" />
                                  {it.isActive ? 'Active' : 'Hidden'}
                                </span>
                              </td>
                              <td>
                                {isEditing ? (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button className="btn btn-primary" disabled={saving} onClick={() => saveEdit(it)} style={{ padding: '5px 11px', fontSize: 12 }}>
                                      <span className="material-symbols-outlined icon-sm">save</span>
                                      {saving ? 'Saving' : 'Save'}
                                    </button>
                                    <button className="btn btn-ghost" disabled={saving} onClick={cancelEdit} style={{ padding: '5px 11px', fontSize: 12 }}>
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button className="btn btn-ghost" onClick={() => startEdit(it)} style={{ padding: '5px 11px', fontSize: 12 }}>
                                    <span className="material-symbols-outlined icon-sm">edit</span>
                                    Edit
                                  </button>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })
          )
        )}
      </div>
    </div>
  )
}

function RateCard({ label, value, unit, icon, color, raw }) {
  return (
    <div className="kpi-card">
      <span className="kpi-accent" style={{ background: color }} />
      <div className="kpi-head" style={{ color }}>
        <span className="material-symbols-outlined">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="kpi-value">
        {value === undefined || value === null ? '—'
          : raw ? value
          : formatCurrency(Number(value))}
      </div>
      <div className="kpi-sub">{unit}</div>
    </div>
  )
}
