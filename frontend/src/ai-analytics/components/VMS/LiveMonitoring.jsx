import { useEffect, useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { camerasApi } from '../../core/services/apiClient.js'

const LAYOUTS = [
  { id: '2x2', label: '2x2', count: 4 },
  { id: '3x3', label: '3x3', count: 9 },
  { id: '4x4', label: '4x4', count: 16 },
  { id: 'single', label: 'Single', count: 1 },
]

const ALERTS = [
  { type: 'weapon', label: 'Weapon', icon: 'report', tone: 'critical' },
  { type: 'fire', label: 'Fire', icon: 'local_fire_department', tone: 'critical' },
  { type: 'crowd', label: 'Crowd', icon: 'groups_3', tone: 'warning' },
  { type: 'object', label: 'Object', icon: 'work_alert', tone: 'warning' },
]

function cameraNumber(camera, index) {
  const raw = `${camera.id || ''}${camera.name || ''}`
  const sum = raw.split('').reduce((total, char) => total + char.charCodeAt(0), index + 3)
  return sum
}

function enrichCamera(camera, index) {
  const seed = cameraNumber(camera, index)
  const isOnline = camera.status === 'online'
  const alert = isOnline && seed % 5 === 0 ? ALERTS[seed % ALERTS.length] : null

  return {
    ...camera,
    fps: isOnline ? 24 + (seed % 7) : 0,
    recording: isOnline && seed % 4 !== 0,
    aiEnabled: isOnline && seed % 6 !== 1,
    health: isOnline ? 84 + (seed % 15) : 0,
    alert,
  }
}

function CameraTile({ camera, selected, onSelect, large = false }) {
  const statusLabel = camera.status === 'online' ? 'LIVE' : 'OFFLINE'
  const scene = `scene-${(cameraNumber(camera, 0) % 4) + 1}`

  return (
    <button
      className={`vms-camera-tile ${selected ? 'selected' : ''} ${camera.status !== 'online' ? 'offline' : ''} ${large ? 'large' : ''}`}
      onClick={() => onSelect(camera)}
      type="button"
      aria-label={`Select ${camera.name} camera. Status ${camera.status}. ${camera.recording ? 'Recording' : 'Not recording'}. ${camera.alert ? `${camera.alert.label} alert active.` : 'No alert active.'}`}
    >
      <div className={`vms-feed-surface ${scene}`}>
        <div className="vms-feed-grid" />
        {camera.status === 'online' && (
          <>
            <span className="vms-feed-scan scan-a" />
            <span className="vms-feed-scan scan-b" />
            <span className="vms-person-marker marker-a" />
            <span className="vms-person-marker marker-b" />
          </>
        )}

        <div className={`vms-live-pill ${camera.status === 'online' ? '' : 'offline'}`}>
          <span />
          {statusLabel}
        </div>

        {camera.alert && (
          <div className={`vms-alert-ribbon ${camera.alert.tone}`}>
            <span className="material-symbols-outlined">{camera.alert.icon}</span>
            {camera.alert.label}
          </div>
        )}

        <div className="vms-feed-center">
          <span className="material-symbols-outlined icon-filled">
            {camera.status === 'online' ? 'videocam' : 'videocam_off'}
          </span>
          <strong>{camera.status === 'online' ? camera.resolution || '1080p' : 'Signal lost'}</strong>
        </div>

        <div className="vms-feed-footer">
          <span>{camera.id}</span>
          <span>{camera.fps} FPS</span>
        </div>
      </div>

      <div className="vms-camera-meta">
        <div>
          <strong>{camera.name}</strong>
          <span>{camera.customer}</span>
        </div>
        <div className="vms-camera-flags">
          <span className={camera.recording ? 'on' : 'off'}>{camera.recording ? 'REC' : 'NO REC'}</span>
          <span className={camera.aiEnabled ? 'on blue' : 'off'}>{camera.aiEnabled ? 'AI' : 'AI OFF'}</span>
        </div>
      </div>

      <div className="vms-camera-actions">
        <span><span className="material-symbols-outlined">open_in_full</span> Focus</span>
        <span><span className="material-symbols-outlined">history</span> Playback</span>
        <span><span className="material-symbols-outlined">folder_special</span> Evidence</span>
      </div>
    </button>
  )
}

export default function LiveMonitoring() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [layout, setLayout] = useState('3x3')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [alertFilter, setAlertFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)

  useEffect(() => {
    let mounted = true
    camerasApi.list()
      .then(data => {
        if (!mounted) return
        const next = data.map(enrichCamera)
        setCameras(next)
        setSelectedId(next.find(cam => cam.status === 'online')?.id || next[0]?.id || null)
        setError(null)
      })
      .catch(err => {
        console.error('Live monitoring fetch error:', err)
        if (mounted) setError('Unable to load camera network. Check backend connection.')
      })
      .finally(() => mounted && setLoading(false))
    return () => { mounted = false }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cameras.filter(camera => {
      const matchesQuery = !q ||
        camera.name?.toLowerCase().includes(q) ||
        camera.customer?.toLowerCase().includes(q) ||
        camera.id?.toLowerCase().includes(q) ||
        camera.ip?.includes(q)
      const matchesStatus = status === 'all' || camera.status === status
      const matchesAlert = alertFilter === 'all' ||
        (alertFilter === 'alerts' && camera.alert) ||
        camera.alert?.type === alertFilter
      return matchesQuery && matchesStatus && matchesAlert
    })
  }, [alertFilter, cameras, query, status])

  const activeLayout = LAYOUTS.find(item => item.id === layout) || LAYOUTS[1]
  const selectedCamera = cameras.find(camera => camera.id === selectedId) || filtered[0]
  const visibleCameras = layout === 'single'
    ? (selectedCamera ? [selectedCamera] : [])
    : filtered.slice(0, activeLayout.count)

  const onlineCount = cameras.filter(camera => camera.status === 'online').length
  const alertCount = cameras.filter(camera => camera.alert).length
  const recordingCount = cameras.filter(camera => camera.recording).length

  return (
    <div className="page vms-live-page">
      <Topbar
        title="Live Monitoring"
        subtitle={`${onlineCount} online - ${recordingCount} recording - ${alertCount} AI alerts`}
        actions={
          <div className="vms-topbar-status">
            <span className="live-dot" />
            Control Room Live
          </div>
        }
      />

      <div className="page-inner vms-page-inner">
        <div className="vms-ops-strip">
          <div>
            <span>Online Cameras</span>
            <strong>{onlineCount}/{cameras.length}</strong>
          </div>
          <div>
            <span>Recording</span>
            <strong>{recordingCount}</strong>
          </div>
          <div>
            <span>Active AI Alerts</span>
            <strong className={alertCount ? 'danger' : ''}>{alertCount}</strong>
          </div>
          <div>
            <span>Selected Feed</span>
            <strong>{selectedCamera?.id || 'None'}</strong>
          </div>
        </div>

        <div className="vms-control-row">
          <div className="search-box vms-search">
            <span className="material-symbols-outlined icon-sm">search</span>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search camera, site, IP, or ID" />
          </div>
          <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="maintenance">Maintenance</option>
          </select>
          <select className="select" value={alertFilter} onChange={e => setAlertFilter(e.target.value)}>
            <option value="all">All Alerts</option>
            <option value="alerts">With AI Alert</option>
            <option value="weapon">Weapon</option>
            <option value="fire">Fire</option>
            <option value="crowd">Crowd</option>
            <option value="object">Object</option>
          </select>
          <div className="vms-layout-switcher" aria-label="Video wall layout">
            {LAYOUTS.map(item => (
              <button
                key={item.id}
                className={layout === item.id ? 'active' : ''}
                onClick={() => setLayout(item.id)}
                type="button"
                aria-pressed={layout === item.id}
                aria-label={`Switch video wall to ${item.label} layout`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="vms-error">
            <span className="material-symbols-outlined">warning</span>
            {error}
          </div>
        )}

        {loading ? (
          <div className="card vms-loading">Loading live camera wall...</div>
        ) : (
          <div className={`vms-live-layout ${layout === 'single' ? 'single' : ''}`}>
            <div className={`vms-grid-wall layout-${layout}`}>
              {visibleCameras.map(camera => (
                <CameraTile
                  key={camera.id}
                  camera={camera}
                  selected={camera.id === selectedCamera?.id}
                  onSelect={camera => setSelectedId(camera.id)}
                  large={layout === 'single'}
                />
              ))}
              {visibleCameras.length === 0 && (
                <div className="card vms-empty-wall">
                  <span className="material-symbols-outlined">videocam_off</span>
                  No cameras match the current filters.
                </div>
              )}
            </div>

            <aside className="vms-operator-panel">
              <div className="vms-panel-section">
                <h3>Operator Focus</h3>
                {selectedCamera ? (
                  <>
                    <strong>{selectedCamera.name}</strong>
                    <span>{selectedCamera.customer}</span>
                    <div className="vms-focus-facts">
                      <div><span>Status</span><b>{selectedCamera.status}</b></div>
                      <div><span>IP</span><b>{selectedCamera.ip}</b></div>
                      <div><span>Stream</span><b>{selectedCamera.resolution} / {selectedCamera.fps} FPS</b></div>
                      <div><span>Health</span><b>{selectedCamera.health}%</b></div>
                    </div>
                  </>
                ) : (
                  <span>No camera selected</span>
                )}
              </div>

              <div className="vms-panel-section">
                <h3>Live AI Alerts</h3>
                <div className="vms-alert-list">
                  {cameras.filter(camera => camera.alert).slice(0, 5).map(camera => (
                    <button
                      key={camera.id}
                      onClick={() => setSelectedId(camera.id)}
                      type="button"
                      aria-label={`Focus camera ${camera.name} with ${camera.alert.label} alert`}
                    >
                      <span className="material-symbols-outlined">{camera.alert.icon}</span>
                      <div>
                        <strong>{camera.alert.label}</strong>
                        <small>{camera.name}</small>
                      </div>
                    </button>
                  ))}
                  {alertCount === 0 && <span className="vms-muted">No active AI alerts</span>}
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>

      <TacticalActionsBar
        label="LIVE ACTIONS"
        icon="monitor"
        actions={[
          { label: 'Dispatch Unit', icon: 'local_police', tone: 'danger', disabled: true, title: 'Dispatch workflow will be connected with incidents in a later phase' },
          { label: 'Open Playback', icon: 'history', to: '/vms/playback' },
          { label: 'Save Evidence', icon: 'folder_special', to: '/vms/evidence' },
          { label: 'Broadcast', icon: 'campaign', disabled: true, title: 'Broadcast workflow is not connected yet' },
          { label: 'Camera Health', icon: 'monitor_heart', to: '/vms/health' },
        ]}
      />
    </div>
  )
}
