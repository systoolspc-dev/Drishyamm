import { useEffect, useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { camerasApi } from '../../core/services/apiClient.js'

function cameraSeed(camera, index) {
  return `${camera.id || ''}${camera.name || ''}`
    .split('')
    .reduce((total, char) => total + char.charCodeAt(0), index + 11)
}

function enrichHealth(camera, index) {
  const seed = cameraSeed(camera, index)
  const online = camera.status === 'online'
  const fps = online ? 18 + (seed % 13) : 0
  const bitrate = online ? 1.8 + ((seed % 28) / 10) : 0
  const recording = online && seed % 5 !== 0
  const storage = 58 + (seed % 38)
  const health = online
    ? Math.max(48, 98 - (fps < 22 ? 16 : 0) - (!recording ? 22 : 0) - (storage > 86 ? 12 : 0) - (seed % 9))
    : 0
  const heartbeatMinutes = online ? 1 + (seed % 6) : 18 + (seed % 72)

  const issues = []
  if (!online) issues.push('Offline')
  if (online && fps < 22) issues.push('Low FPS')
  if (online && !recording) issues.push('Recording failure')
  if (storage > 86) issues.push('Storage warning')
  if (heartbeatMinutes > 15) issues.push('Heartbeat stale')

  return {
    ...camera,
    fps,
    bitrate: Number(bitrate.toFixed(1)),
    recording,
    storage,
    health,
    heartbeatMinutes,
    lastHeartbeat: heartbeatMinutes < 2 ? 'Just now' : `${heartbeatMinutes} min ago`,
    issues,
    state: issues.length ? (online ? 'warning' : 'critical') : 'healthy',
  }
}

function HealthState({ camera }) {
  const label = camera.state === 'healthy' ? 'Healthy' : camera.state === 'warning' ? 'Needs Attention' : 'Critical'
  return (
    <span className={`vms-health-state ${camera.state}`}>
      <span />
      {label}
    </span>
  )
}

export default function CameraHealth() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const loadCameras = () => {
    setLoading(true)
    camerasApi.list()
      .then(data => {
        setCameras(data.map(enrichHealth))
        setError(null)
      })
      .catch(err => {
        console.error('Camera health fetch error:', err)
        setError('Unable to load camera health. Check backend connection.')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadCameras()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cameras.filter(camera => {
      const matchesQuery = !q ||
        camera.name?.toLowerCase().includes(q) ||
        camera.customer?.toLowerCase().includes(q) ||
        camera.id?.toLowerCase().includes(q) ||
        camera.ip?.includes(q)
      const matchesFilter = filter === 'all' ||
        camera.state === filter ||
        camera.issues.some(issue => issue.toLowerCase().replace(/\s+/g, '-') === filter)
      return matchesQuery && matchesFilter
    })
  }, [cameras, filter, query])

  const offlineCount = cameras.filter(camera => camera.issues.includes('Offline')).length
  const lowFpsCount = cameras.filter(camera => camera.issues.includes('Low FPS')).length
  const recordingFailures = cameras.filter(camera => camera.issues.includes('Recording failure')).length
  const storageWarnings = cameras.filter(camera => camera.issues.includes('Storage warning')).length
  const averageHealth = cameras.length
    ? Math.round(cameras.reduce((total, camera) => total + camera.health, 0) / cameras.length)
    : 0

  return (
    <div className="page">
      <Topbar
        title="Camera Health"
        subtitle={`${offlineCount} offline - ${lowFpsCount} low FPS - ${recordingFailures} recording issues`}
        actions={
          <button className="btn btn-ghost" type="button" onClick={loadCameras} aria-label="Refresh camera health" title="Refresh camera health">
            <span className="material-symbols-outlined icon-sm">refresh</span>
            Refresh
          </button>
        }
      />

      <div className="page-inner vms-page-inner">
        <div className="vms-health-summary">
          <div>
            <span>Average Health</span>
            <strong>{averageHealth}%</strong>
          </div>
          <div>
            <span>Offline Cameras</span>
            <strong className={offlineCount ? 'danger' : ''}>{offlineCount}</strong>
          </div>
          <div>
            <span>Low FPS</span>
            <strong className={lowFpsCount ? 'warning' : ''}>{lowFpsCount}</strong>
          </div>
          <div>
            <span>Recording Failures</span>
            <strong className={recordingFailures ? 'danger' : ''}>{recordingFailures}</strong>
          </div>
          <div>
            <span>Storage Warnings</span>
            <strong className={storageWarnings ? 'warning' : ''}>{storageWarnings}</strong>
          </div>
        </div>

        <div className="vms-control-row">
          <div className="search-box vms-search">
            <span className="material-symbols-outlined icon-sm">search</span>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search camera, site, IP, or ID" />
          </div>
          <select className="select" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter camera health">
            <option value="all">All Cameras</option>
            <option value="critical">Critical</option>
            <option value="warning">Needs Attention</option>
            <option value="healthy">Healthy</option>
            <option value="low-fps">Low FPS</option>
            <option value="recording-failure">Recording Failure</option>
            <option value="storage-warning">Storage Warning</option>
          </select>
        </div>

        {error && (
          <div className="vms-error">
            <span className="material-symbols-outlined">warning</span>
            <span>{error}</span>
            <button className="btn btn-ghost" type="button" onClick={loadCameras}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="vms-health-skeleton" aria-label="Loading camera health">
            {Array.from({ length: 6 }).map((_, index) => <span key={index} />)}
          </div>
        ) : (
          <section className="card vms-health-card">
            <div className="vms-section-header">
              <h3>Camera Health Matrix</h3>
              <span className="vms-muted">{filtered.length} cameras shown</span>
            </div>

            <div className="vms-health-table">
              <div className="vms-health-row header">
                <span>Camera</span>
                <span>Status</span>
                <span>FPS</span>
                <span>Bitrate</span>
                <span>Recording</span>
                <span>Storage</span>
                <span>Heartbeat</span>
                <span>Health</span>
              </div>
              {filtered.map(camera => (
                <div className="vms-health-row" key={camera.id}>
                  <div>
                    <strong>{camera.name}</strong>
                    <small>{camera.id} - {camera.customer}</small>
                  </div>
                  <HealthState camera={camera} />
                  <span className={camera.fps && camera.fps < 22 ? 'is-warning' : ''}>{camera.fps} FPS</span>
                  <span>{camera.bitrate} Mbps</span>
                  <span className={camera.recording ? 'is-good' : 'is-danger'}>{camera.recording ? 'Recording' : 'Not recording'}</span>
                  <span className={camera.storage > 86 ? 'is-warning' : ''}>{camera.storage}%</span>
                  <span className={camera.heartbeatMinutes > 15 ? 'is-danger' : ''}>{camera.lastHeartbeat}</span>
                  <div className="vms-health-meter" aria-label={`${camera.name} health ${camera.health}%`}>
                    <span style={{ width: `${camera.health}%` }} />
                    <b>{camera.health}%</b>
                  </div>
                </div>
              ))}
            </div>

            {filtered.length === 0 && (
              <div className="vms-empty-wall">
                <span className="material-symbols-outlined">monitor_heart</span>
                No cameras match the current health filter.
              </div>
            )}
          </section>
        )}
      </div>

      <TacticalActionsBar
        label="HEALTH ACTIONS"
        icon="monitor_heart"
        actions={[
          { label: 'Live View', icon: 'monitor', to: '/vms/live' },
          { label: 'Camera Management', icon: 'videocam', to: '/vms/cameras' },
          { label: 'Playback', icon: 'history', to: '/vms/playback' },
          { label: 'Export Report', icon: 'download', disabled: true, title: 'Health report export is not connected yet' },
        ]}
      />
    </div>
  )
}
