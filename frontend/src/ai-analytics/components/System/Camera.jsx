import { useCallback, useEffect, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import { Modal, StatusChip, InfoRow, EmptyState } from '../ui.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { camerasApi } from '../../core/services/apiClient.js'

function sceneFor(camera) {
  const raw = `${camera.id || ''}${camera.name || ''}`
  const seed = raw.split('').reduce((total, char) => total + char.charCodeAt(0), 7)
  return `scene-${(seed % 4) + 1}`
}

function CameraPreview({ camera, large = false }) {
  const online = camera.status === 'online'
  return (
    <div className={`camera-admin-preview ${sceneFor(camera)} ${online ? '' : 'offline'} ${large ? 'large' : ''}`}>
      <div className="camera-admin-grid" />
      {online && (
        <>
          <span className="camera-admin-target target-a" />
          <span className="camera-admin-target target-b" />
        </>
      )}
      <div className={`camera-admin-live ${online ? '' : 'offline'}`}>
        <span />
        {online ? 'LIVE PREVIEW' : 'OFFLINE'}
      </div>
      <div className="camera-admin-preview-center">
        <span className="material-symbols-outlined icon-filled">{online ? 'videocam' : 'videocam_off'}</span>
        <strong>{online ? `${camera.resolution} - ${camera.codec?.toUpperCase()}` : 'Signal lost'}</strong>
      </div>
    </div>
  )
}

export default function Cameras() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [selectedCompany, setSelectedCompany] = useState(null)

  const loadCameras = useCallback(() => {
    setLoading(true)
    camerasApi.list()
      .then(data => {
        setCameras(data)
        setError(null)
      })
      .catch(err => {
        console.error('Error fetching cameras:', err)
        setError('Unable to load cameras. Check backend connection.')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadCameras()
  }, [loadCameras])

  const filtered = cameras.filter(c => {
    const q = search.toLowerCase()
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.customer.toLowerCase().includes(q) || c.ip.includes(q) || c.id.includes(q)
    const matchS = statusFilter === 'all' || c.status === statusFilter
    return matchQ && matchS
  })

  const onlineCount = cameras.filter(c => c.status === 'online').length
  const offlineCount = cameras.length - onlineCount

  const grouped = {}
  filtered.forEach(c => {
    if (!grouped[c.customer]) grouped[c.customer] = []
    grouped[c.customer].push(c)
  })

  const companies = Object.keys(grouped).filter(customer => {
    const q = search.toLowerCase()
    return !q || customer.toLowerCase().includes(q)
  }).map(customer => ({
    name: customer,
    cameras: grouped[customer],
    online: grouped[customer].filter(c => c.status === 'online').length,
    total: grouped[customer].length,
  }))

  const selectedCompanyCameras = selectedCompany ? grouped[selectedCompany] || [] : []
  const visibleCameras = selectedCompanyCameras.filter(c => {
    const matchS = statusFilter === 'all' || c.status === statusFilter
    const q = search.toLowerCase()
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.ip.includes(q) || c.id.includes(q)
    return matchQ && matchS
  })

  return (
    <div className="page">
      <Topbar
        title={selectedCompany ? `${selectedCompany} Camera Management` : 'Camera Management'}
        subtitle={selectedCompany ? `${selectedCompanyCameras.filter(c => c.status === 'online').length} online - ${selectedCompanyCameras.filter(c => c.status === 'offline').length} offline - ${selectedCompanyCameras.length} total` : `${onlineCount} online - ${offlineCount} offline - ${cameras.length} total`}
        actions={
          selectedCompany ? (
            <button className="btn btn-ghost" type="button" onClick={() => { setSelectedCompany(null); setSearch(''); setStatusFilter('all') }}>
              <span className="material-symbols-outlined icon-sm">arrow_back</span>
              Back to Sites
            </button>
          ) : (
            <div className="camera-admin-top-stats">
              <span className="camera-admin-pill online"><i />{onlineCount} Online</span>
              <span className="camera-admin-pill offline"><i />{offlineCount} Offline</span>
            </div>
          )
        }
      />
      <div className="page-inner camera-admin-page">
        <div className="camera-admin-toolbar">
          <div className="search-box camera-admin-search">
            <span className="material-symbols-outlined icon-sm">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={selectedCompany ? 'Search cameras or IPs...' : 'Search sites or customers...'} />
          </div>
          {selectedCompany && (
            <select className="select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter cameras by status">
              <option value="all">All Status</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>
          )}
          <div className="camera-admin-count">{selectedCompany ? `${visibleCameras.length} cameras` : `${companies.length} sites`}</div>
        </div>

        {error && (
          <div className="vms-error">
            <span className="material-symbols-outlined">warning</span>
            <span>{error}</span>
            <button className="btn btn-ghost" type="button" onClick={loadCameras}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="camera-admin-skeleton" aria-label="Loading camera management">
            {Array.from({ length: 6 }).map((_, index) => <span key={index} />)}
          </div>
        ) : selectedCompany ? (
          visibleCameras.length > 0 ? (
            <div className="camera-admin-grid-list">
              {visibleCameras.map(cam => (
                <button key={cam.id} className={`camera-admin-card ${cam.status === 'offline' ? 'offline' : ''}`} type="button" onClick={() => setSelected(cam)} aria-label={`Open camera ${cam.name}`}>
                  <CameraPreview camera={cam} />
                  <div className="camera-admin-card-meta">
                    <div>
                      <strong>{cam.name}</strong>
                      <span className="mono">{cam.ip}</span>
                    </div>
                    <StatusChip type={cam.status} />
                  </div>
                  <div className="camera-admin-id mono">{cam.id}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="card camera-admin-empty">
              <EmptyState title="No cameras found" message="Try adjusting the search or filter." />
            </div>
          )
        ) : (
          companies.length === 0 ? (
            <div className="card camera-admin-empty">
              <EmptyState title="No sites found" message="Try adjusting the search." />
            </div>
          ) : (
            <div className="camera-admin-site-grid">
              {companies.map(company => (
                <button key={company.name} className="camera-admin-site-card" type="button" onClick={() => setSelectedCompany(company.name)} aria-label={`Open ${company.name} cameras`}>
                  <div className="camera-admin-site-title">
                    <span className="material-symbols-outlined icon-sm">business</span>
                    <h3>{company.name}</h3>
                  </div>
                  <div className="camera-admin-site-stats">
                    <span>{company.total} cameras</span>
                    <span>{company.online} online</span>
                  </div>
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name}
        subtitle={`${selected?.id} - ${selected?.customer}`}
        width={500}
        footer={
          <>
            <button className="btn btn-ghost" type="button" onClick={() => setSelected(null)}>Close</button>
            <button className="btn btn-danger" type="button">
              <span className="material-symbols-outlined icon-sm">delete</span>
              Remove Camera
            </button>
          </>
        }
      >
        {selected && (
          <div>
            <CameraPreview camera={selected} large />
            <div className="camera-admin-info-panel">
              <InfoRow label="Camera ID" value={<code>{selected.id}</code>} />
              <InfoRow label="Customer" value={selected.customer} />
              <InfoRow label="Location / Name" value={selected.name} />
              <InfoRow label="IP Address" value={<code>{selected.ip}</code>} />
              <InfoRow label="Resolution" value={selected.resolution} />
              <InfoRow label="Codec" value={selected.codec.toUpperCase()} />
              <InfoRow label="Status" value={<StatusChip type={selected.status} />} />
            </div>
          </div>
        )}
      </Modal>
      <TacticalActionsBar
        label="CAMERA ACTIONS"
        icon="videocam"
        actions={[
          { label: 'Add Camera', icon: 'add_a_photo', disabled: true, title: 'Camera provisioning is not connected yet' },
          { label: 'Open Live Feed', icon: 'monitor', to: '/vms/live' },
          { label: 'Health Check', icon: 'monitor_heart', to: '/vms/health' },
          { label: 'Flag Offline', icon: 'videocam_off', tone: 'danger', disabled: true, title: 'Select status workflow is not connected yet' },
          { label: 'Export Footage', icon: 'download', to: '/vms/playback' },
          { label: 'Save Evidence', icon: 'folder_special', to: '/vms/evidence' },
        ]}
      />
    </div>
  )
}
