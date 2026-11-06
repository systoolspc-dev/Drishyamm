import { useState, useEffect } from 'react'
import { Topbar } from './layout/Layout.jsx'
import { EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'

const CATEGORY_COLORS = {
  students:  { bg: 'light-dark(#e8f4fd, var(--info-soft))', text: 'light-dark(#1a6fa8, var(--info-ink))' },
  staff:     { bg: 'light-dark(#e8f8f0, var(--success-soft))', text: 'light-dark(#1a7a45, var(--success-ink))' },
  security:  { bg: 'light-dark(#fff3e0, var(--warning-soft))', text: 'var(--color-warning-text)' },
  visitors:  { bg: 'light-dark(#f3e8fd, var(--ai-soft))', text: 'light-dark(#6b21a8, var(--ai-ink))' },
  general:   { bg: 'light-dark(#f0f0f0, var(--neutral-soft))', text: 'light-dark(#555, var(--neutral-ink))' },
}

function formatBytes(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export default function Downloads() {
  const [datasets, setDatasets]         = useState([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)
  const [search, setSearch]             = useState('')
  const [customerFilter, setCustomer]   = useState('all')
  const [rangeFilter, setRangeFilter]   = useState('all') // all | 24h | 7d | 30d | 90d
  const [sizeFilter, setSizeFilter]     = useState('all') // all | small (<1MB) | medium (1-10MB) | large (>10MB)
  const [sortBy, setSortBy]             = useState('newest') // newest | oldest | size | name
  const [downloading, setDownloading]   = useState(null)

  useEffect(() => {
    adminApi.getDatasets()
      .then(d => setDatasets(d.datasets || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const customers = [...new Set(datasets.map(d => d.userName).filter(Boolean))]

  const RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
  const rangeStart = RANGE_DAYS[rangeFilter]
    ? new Date(Date.now() - RANGE_DAYS[rangeFilter] * 24 * 60 * 60 * 1000)
    : null

  const filtered = datasets.filter(d => {
    const q = search.toLowerCase()
    const matchQ = !q
      || d.originalName?.toLowerCase().includes(q)
      || d.userName?.toLowerCase().includes(q)
      || d.userEmail?.toLowerCase().includes(q)
    const matchC = customerFilter === 'all' || d.userName === customerFilter
    const matchT = !rangeStart || new Date(d.lastModified) >= rangeStart
    const sz = d.sizeBytes || 0
    const matchSize = sizeFilter === 'all'
                   || (sizeFilter === 'small'  && sz < 1024 * 1024)
                   || (sizeFilter === 'medium' && sz >= 1024 * 1024 && sz < 10 * 1024 * 1024)
                   || (sizeFilter === 'large'  && sz >= 10 * 1024 * 1024)
    return matchQ && matchC && matchT && matchSize
  }).sort((a, b) => {
    if (sortBy === 'oldest') return new Date(a.lastModified || 0) - new Date(b.lastModified || 0)
    if (sortBy === 'size')   return (b.sizeBytes || 0) - (a.sizeBytes || 0)
    if (sortBy === 'name')   return (a.originalName || a.filename || '').localeCompare(b.originalName || b.filename || '')
    return new Date(b.lastModified || 0) - new Date(a.lastModified || 0)
  })

  const isFiltered = search.trim() !== ''
                  || customerFilter !== 'all'
                  || rangeFilter !== 'all'
                  || sizeFilter !== 'all'
  const clearFilters = () => {
    setSearch(''); setCustomer('all'); setRangeFilter('all'); setSizeFilter('all')
  }

  const handleDownload = async (dataset) => {
    setDownloading(dataset.key)
    try {
      const { url } = await adminApi.getDatasetDownloadUrl(dataset.key)
      const a = document.createElement('a')
      a.href = url
      a.download = dataset.filename
      a.target = '_blank'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      alert('Download failed: ' + e.message)
    } finally {
      setDownloading(null)
    }
  }

  const catStyle = (cat) => {
    const c = (cat || 'general').toLowerCase()
    return CATEGORY_COLORS[c] || CATEGORY_COLORS.general
  }

  return (
    <div className="page">
      <Topbar
        title="Dataset Downloads"
        subtitle={`Face training datasets uploaded by users · ${datasets.length} total`}
      />
      <div className="page-inner">
        {error && (
          <div style={{ background: 'var(--color-danger-bg)', border: '1px solid light-dark(#fca5a5, var(--danger-line))', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: 'var(--color-danger-text)', fontSize: 14 }}>
            {error}
          </div>
        )}

        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by filename or user…"
            />
          </div>

          <div className="filter-group">
            {[
              { value: 'all', label: 'All time' },
              { value: '24h', label: '24h' },
              { value: '7d',  label: '7d' },
              { value: '30d', label: '30d' },
              { value: '90d', label: '90d' },
            ].map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${rangeFilter === opt.value ? 'active' : ''}`}
                onClick={() => setRangeFilter(opt.value)}
              >{opt.label}</button>
            ))}
          </div>

          <select className="select" value={customerFilter} onChange={e => setCustomer(e.target.value)} style={{ minWidth: 180 }}>
            <option value="all">All Companies</option>
            {customers.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <select className="select" value={sizeFilter} onChange={e => setSizeFilter(e.target.value)}>
            <option value="all">Any size</option>
            <option value="small">&lt; 1 MB</option>
            <option value="medium">1–10 MB</option>
            <option value="large">&gt; 10 MB</option>
          </select>

          <select className="select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
            <option value="newest">Sort: Newest</option>
            <option value="oldest">Sort: Oldest</option>
            <option value="size">Sort: Largest</option>
            <option value="name">Sort: Name</option>
          </select>

          {isFiltered && (
            <button className="filter-clear" onClick={clearFilters}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}

          <span className="filter-count">{filtered.length} dataset{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No datasets found"
              message="No face training datasets have been uploaded yet, or none match your filters."
            />
          ) : (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Company / User</th>
                    <th>Category</th>
                    <th>Size</th>
                    <th>Uploaded</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(ds => {
                    const cs = catStyle(ds.category)
                    const isLoading = downloading === ds.key
                    return (
                      <tr key={ds.key}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 20, color: '#f59e0b' }}>folder_zip</span>
                            <div>
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{ds.originalName || ds.filename}</div>
                              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                                {ds.key.split('/').slice(0, 2).join('/')}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{ds.userName || 'Unknown'}</div>
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{ds.userEmail}</div>
                        </td>
                        <td>
                          {ds.category ? (
                            <span style={{
                              background: cs.bg,
                              color: cs.text,
                              padding: '2px 10px',
                              borderRadius: 99,
                              fontSize: 12,
                              fontWeight: 500,
                              textTransform: 'capitalize',
                            }}>
                              {ds.category}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                          {formatBytes(ds.sizeBytes)}
                        </td>
                        <td style={{ color: 'var(--color-text-muted)', fontSize: 12, fontFamily: 'monospace' }}>
                          {formatDate(ds.lastModified)}
                        </td>
                        <td>
                          <button
                            className="btn btn-ghost"
                            onClick={() => handleDownload(ds)}
                            disabled={isLoading}
                            style={{ fontSize: 12, padding: '4px 10px' }}
                          >
                            <span className="material-symbols-outlined icon-sm">
                              {isLoading ? 'hourglass_empty' : 'download'}
                            </span>
                            {isLoading ? 'Getting link…' : 'Download'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
