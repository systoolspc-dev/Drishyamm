import { useState, useEffect } from 'react'
import { Topbar } from './layout/Layout.jsx'
import { Modal, StatusChip, InfoRow, EmptyState, Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'

export default function Cameras() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter]     = useState('all')
  const [customerFilter, setCustomerFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [selectedCompany, setSelectedCompany] = useState(null)

  useEffect(() => {
    adminApi.getCameras()
      .then(d => setCameras(d.cameras))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const online = cameras.filter(c => c.status === 'online').length
  const offline = cameras.length - online
  const types = [...new Set(cameras.map(c => c.type).filter(Boolean))]
  const customerNames = [...new Set(cameras.map(c => c.customer).filter(Boolean))]

  const filtered = cameras.filter(c => {
    const q = search.toLowerCase()
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.customer.toLowerCase().includes(q) || (c.ip || '').includes(q)
    const matchS = statusFilter === 'all' || c.status === statusFilter
    const matchT = typeFilter   === 'all' || c.type   === typeFilter
    const matchC = customerFilter === 'all' || c.customer === customerFilter
    return matchQ && matchS && matchT && matchC
  })

  const isFiltered = search.trim() !== ''
                  || statusFilter !== 'all'
                  || typeFilter !== 'all'
                  || customerFilter !== 'all'
  const clearFilters = () => {
    setSearch(''); setStatusFilter('all'); setTypeFilter('all'); setCustomerFilter('all')
  }

  const grouped = {}
  filtered.forEach(c => {
    if (!grouped[c.customer]) grouped[c.customer] = []
    grouped[c.customer].push(c)
  })

  const companies = Object.keys(grouped).map(customer => ({
    name: customer,
    cameras: grouped[customer],
    online: grouped[customer].filter(c => c.status === 'online').length,
    total: grouped[customer].length,
  }))

  const companyCameras = selectedCompany ? (grouped[selectedCompany] || []).filter(c => {
    const matchS = statusFilter === 'all' || c.status === statusFilter
    const q = search.toLowerCase()
    const matchQ = !q || c.name.toLowerCase().includes(q) || (c.ip || '').includes(q)
    return matchQ && matchS
  }) : []

  return (
    <div className="page">
      <Topbar
        title={selectedCompany ? `${selectedCompany} — Cameras` : 'Camera Monitoring'}
        subtitle={selectedCompany
          ? `${grouped[selectedCompany]?.filter(c => c.status === 'online').length} online · ${grouped[selectedCompany]?.filter(c => c.status !== 'online').length} offline`
          : `${online} online · ${offline} offline · ${cameras.length} total`}
        actions={selectedCompany ? (
          <button className="btn btn-ghost" onClick={() => { setSelectedCompany(null); setSearch(''); setStatusFilter('all') }}>
            <span className="material-symbols-outlined icon-sm">arrow_back</span>
            Back
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'var(--color-success-bg)', borderRadius: 99, border: '1px solid light-dark(#bbf7d0, var(--success-line))' }}>
              <span style={{ width: 8, height: 8, borderRadius: 50, background: '#16a34a', display: 'inline-block' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-success-text)' }}>{online} Online</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'var(--color-danger-bg)', borderRadius: 99, border: '1px solid var(--danger-line)' }}>
              <span style={{ width: 8, height: 8, borderRadius: 50, background: '#dc2626', display: 'inline-block' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: '#dc2626' }}>{offline} Offline</span>
            </div>
          </div>
        )}
      />
      <div className="page-inner">
        <div className="filter-bar">
          <div className="search-box">
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={selectedCompany ? 'Search cameras, IPs…' : 'Search customers, cameras, IPs…'} />
          </div>

          <div className="filter-group">
            {[
              { value: 'all',     label: 'All' },
              { value: 'online',  label: 'Online' },
              { value: 'offline', label: 'Offline' },
            ].map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${statusFilter === opt.value ? 'active' : ''}`}
                onClick={() => setStatusFilter(opt.value)}
              >{opt.label}</button>
            ))}
          </div>

          {!selectedCompany && customerNames.length > 1 && (
            <select className="select" value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} style={{ minWidth: 180 }}>
              <option value="all">All Customers</option>
              {customerNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          )}

          {types.length > 1 && (
            <select className="select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="all">All Types</option>
              {types.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
            </select>
          )}

          {isFiltered && (
            <button className="filter-clear" onClick={clearFilters}>
              <span className="material-symbols-outlined">close</span> Clear
            </button>
          )}

          <span className="filter-count">{filtered.length} camera{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        {loading ? <Spinner /> : error ? (
          <div style={{ padding: '16px 20px', background: 'var(--color-danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 'var(--radius-md)', color: 'var(--color-danger-text)' }}>Error: {error}</div>
        ) : selectedCompany ? (
          companyCameras.length === 0 ? <EmptyState title="No cameras match" /> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {companyCameras.map(cam => (
                <div key={cam.id} onClick={() => setSelected(cam)} style={{
                  padding: 16, background: 'var(--color-surface)',
                  border: `1px solid ${cam.status === 'offline' ? 'var(--danger-line)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-lg)', cursor: 'pointer', transition: 'box-shadow .15s',
                  boxShadow: 'var(--shadow-sm)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <span className="material-symbols-outlined icon-lg" style={{ color: cam.status === 'online' ? '#16a34a' : '#dc2626' }}>
                      {cam.status === 'online' ? 'videocam' : 'videocam_off'}
                    </span>
                    <StatusChip type={cam.status} />
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }} className="truncate">{cam.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }} className="mono">{cam.ip}</div>
                  {cam.group && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>{cam.group.name}</div>}
                </div>
              ))}
            </div>
          )
        ) : (
          companies.length === 0 ? <EmptyState title="No cameras found" icon="videocam_off" /> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {companies.map(co => (
                <div key={co.name} onClick={() => setSelectedCompany(co.name)} style={{
                  padding: 20, background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-lg)', cursor: 'pointer', transition: 'box-shadow .15s, transform .15s',
                  boxShadow: 'var(--shadow-sm)',
                }}
                  onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.transform = '' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                    <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--color-info-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span className="material-symbols-outlined icon-sm icon-filled" style={{ color: '#2563eb' }}>videocam</span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }} className="truncate">{co.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{co.total} cameras</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, textAlign: 'center', padding: '8px 4px', background: 'var(--color-success-bg)', borderRadius: 'var(--radius)', border: '1px solid light-dark(#bbf7d0, var(--success-line))' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-success-text)' }}>{co.online}</div>
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>Online</div>
                    </div>
                    <div style={{ flex: 1, textAlign: 'center', padding: '8px 4px', background: co.total - co.online > 0 ? 'var(--color-danger-bg)' : 'var(--surface-muted)', borderRadius: 'var(--radius)', border: co.total - co.online > 0 ? '1px solid var(--danger-line)' : '1px solid var(--color-border)' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: co.total - co.online > 0 ? '#dc2626' : 'var(--color-text-secondary)' }}>{co.total - co.online}</div>
                      <div style={{ fontSize: 11, color: co.total - co.online > 0 ? '#dc2626' : 'var(--color-text-muted)', fontWeight: 600 }}>Offline</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={selected?.customer}
        width={500}
        footer={<button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button>}
      >
        {selected && (
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <InfoRow label="Camera ID" value={<code style={{ fontSize: 12 }}>{selected.id}</code>} />
            <InfoRow label="Monitor ID" value={<code style={{ fontSize: 12 }}>{selected.monitorId}</code>} />
            <InfoRow label="IP Address" value={selected.ip} />
            <InfoRow label="Status" value={<StatusChip type={selected.status} />} />
            <InfoRow label="Type / Codec" value={selected.type} />
            <InfoRow label="Resolution" value={selected.resolution || (selected.width ? `${selected.width}×${selected.height}` : '—')} />
            <InfoRow label="FPS" value={selected.fps} />
            <InfoRow label="Group" value={selected.group?.name || '—'} />
            <InfoRow label="Customer" value={selected.customer} />
          </div>
        )}
      </Modal>
    </div>
  )
}
