import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { StatusChip } from '../ui.jsx'
import { dashboardApi, eventsApi } from '../../core/services/apiClient.js'
import { SEVERITY_CONFIG, EVENT_TYPE_LABELS, EVENT_TYPE_ICONS } from '../../core/constants/index.js'

const quickActions = [
  { label: 'Broadcast', icon: 'campaign' },
  { label: 'View Cameras', icon: 'video_camera_front' },
  { label: 'Alert Report', icon: 'description' },
  { label: 'Deploy Unit', icon: 'person_pin_circle' },
]

const systemStatus = [
  { label: 'Video Feeds',  value: '256 / 278', state: 'Operational' },
  { label: 'AI Systems',   value: '12 / 12',   state: 'Operational' },
  { label: 'Storage',      value: '78%',        state: 'Operational' },
  { label: 'Network',      value: '94%',        state: 'Operational' },
  { label: 'Database',     value: '100%',       state: 'Operational' },
]

const deployments = [
  { unit: 'Unit 07', zone: 'Main Gate',      distance: '2.1 km', status: 'En Route' },
  { unit: 'Unit 03', zone: 'Bus Bay',        distance: '1.8 km', status: 'On Scene' },
  { unit: 'Unit 12', zone: 'Parking Area',   distance: '2.4 km', status: 'En Route' },
  { unit: 'Unit 05', zone: 'Transport Zone', distance: '3.2 km', status: 'On Scene' },
]

const mapLegend = [
  { label: 'Cameras',      tone: 'blue' },
  { label: 'Police Units', tone: 'green' },
  { label: 'Active Alerts',tone: 'red' },
  { label: 'Patrol Units', tone: 'purple' },
  { label: 'Zones',        tone: 'teal' },
]

function formatTs(ts) {
  if (!ts) return 'â€”'
  return new Date(String(ts).replace(' ', 'T')).toLocaleTimeString()
}

function SeverityBadge({ severity }) {
  const cfg = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info
  return (
    <span style={{
      color: cfg.color, background: cfg.bg,
      padding: '2px 8px', borderRadius: 99,
      fontSize: 10, fontWeight: 800,
      letterSpacing: '.06em',
    }}>
      {cfg.label}
    </span>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState({
    totalCameras: 0, onlineCameras: 0,
    totalEvents: 0, criticalEvents: 0,
    warningEvents: 0, activeEvents: 0,
  })
  const [recentDetections, setRecentDetections] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  const fetchData = useCallback(async () => {
    try {
      const [statsData, eventsData] = await Promise.all([
        dashboardApi.stats(),
        eventsApi.threatFeed(),
      ])
      setStats(statsData)
      setRecentDetections(eventsData)
      setError(null)
    } catch (err) {
      console.error('Dashboard fetch error:', err)
      setError('Unable to reach the server. Retryingâ€¦')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [fetchData])

  const displayStats = [
    {
      label: 'Active Cameras',
      value: stats.onlineCameras,
      sub: `${stats.offlineCameras ?? (stats.totalCameras - stats.onlineCameras)} offline`,
      icon: 'videocam',
      tone: '#3b82f6',
      accent: 'Online',
    },
    {
      label: 'Active Alerts',
      value: stats.activeEvents ?? stats.totalEvents,
      sub: `${stats.criticalEvents} Critical  Â·  ${stats.warningEvents} Warning`,
      icon: 'notifications_active',
      tone: '#ef4444',
      accent: 'Last 24h',
    },
    {
      label: 'AI Accuracy',
      value: '96.2%',
      sub: 'Stable operation',
      icon: 'my_location',
      tone: '#22c55e',
      accent: 'Stable',
    },
    {
      label: 'Units Deployed',
      value: '08',
      sub: '2 ready reserve',
      icon: 'groups_3',
      tone: '#0A1F44',
      accent: 'On Duty',
    },
  ]

  return (
    <div className="page">
      <Topbar
        title="Live Command Center"
        subtitle="Real-time citywide surveillance and operations overview"
        actions={
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: 'var(--color-primary-bg)',
            borderRadius: 99,
            border: '1px solid var(--color-primary-light)',
          }}>
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text)', fontSize: 14 }}>shield</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '.06em' }}>
              CONTROL ROOM LIVE
            </span>
          </div>
        }
      />

      <div className="page-inner overview-page">

        {error && (
          <div style={{
            marginBottom: 16, padding: '10px 16px',
            background: 'var(--color-danger-bg)',
            border: '1px solid rgba(239,68,68,.25)',
            borderRadius: 'var(--radius)',
            fontSize: 13, color: 'var(--color-danger-text)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span className="material-symbols-outlined icon-sm">warning</span>
            {error}
          </div>
        )}

        {/* Stat cards */}
        <div className="stats-grid overview-stats-grid">
          {displayStats.map(stat => (
            <div key={stat.label} className="stat-card overview-stat-card">
              <div className="overview-stat-icon" style={{
                background: `${stat.tone}18`,
                color: stat.tone,
              }}>
                <span className="material-symbols-outlined icon-lg">{stat.icon}</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <p className="overview-stat-label">{stat.label}</p>
                <p className="overview-stat-value">{loading ? 'â€”' : stat.value}</p>
                <p className="overview-stat-sub">{stat.sub}</p>
              </div>
              <span className="overview-stat-accent">{stat.accent}</span>
            </div>
          ))}
        </div>

        <div className="overview-main-grid">
          {/* Left column */}
          <div className="overview-left-column">
            <div className="card overview-panel">
              <div className="overview-panel-header">
                <h3>Live Tactical Map</h3>
                <div className="mono" style={{ fontSize: 10, color: 'var(--color-accent)', letterSpacing: '.08em' }}>
                  ACTIVE_TRACKING: ON
                </div>
              </div>
              <div className="overview-map-surface" style={{ height: 380 }}>
                <div className="overview-map-gridlines" />
                <div className="overview-map-heat heat-a" />
                <div className="overview-map-heat heat-b" />
                <div className="overview-map-legend">
                  {mapLegend.map(item => (
                    <div key={item.label} className="overview-legend-item">
                      <span className={`overview-legend-dot ${item.tone}`} />
                      {item.label}
                    </div>
                  ))}
                </div>
                <span className="overview-map-node blue n1" />
                <span className="overview-map-node blue n2" />
                <span className="overview-map-node blue n3" />
                <span className="overview-map-node green n4" />
                <span className="overview-map-node green n5" />
                <span className="overview-map-node red n6" />
                <span className="overview-map-node red n7" />
                <span className="overview-map-node purple n8" />
                <span className="overview-map-node teal n9" />
                <div className="overview-map-controls">
                  <button className="btn btn-ghost icon-only">+</button>
                  <button className="btn btn-ghost icon-only">-</button>
                </div>
              </div>
            </div>

            <div className="overview-bottom-grid">
              <div className="card overview-panel" style={{ gridColumn: 'span 2' }}>
                <div className="overview-panel-header">
                  <h3>Recent AI Detections</h3>
                  <Link to="/incidents" style={{ fontSize: 12, color: 'var(--color-text)', textDecoration: 'none', fontWeight: 600 }}>
                    View All
                  </Link>
                </div>
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        <th className="hide-mobile">Location</th>
                        <th>Camera</th>
                        <th>Confidence</th>
                        <th>Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentDetections.slice(0, 8).map(item => (
                        <tr key={item.id}>
                          <td className="mono" style={{ fontSize: 12 }}>{formatTs(item.created_at)}</td>
                          <td style={{ fontWeight: 600 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
                                {EVENT_TYPE_ICONS[item.event_type] || 'notifications'}
                              </span>
                              {EVENT_TYPE_LABELS[item.event_type] || item.event_type}
                            </div>
                          </td>
                          <td className="hide-mobile" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>
                            {item.location}
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>{item.camera_id}</td>
                          <td className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                            {(parseFloat(item.confidence) * 100).toFixed(1)}%
                          </td>
                          <td><SeverityBadge severity={item.severity} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {recentDetections.length === 0 && !loading && (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>
                      Waiting for AI eventsâ€¦
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="overview-right-column">

            {/* Active alerts */}
            <div className="card overview-panel">
              <div className="overview-panel-header">
                <h3>Active Alerts</h3>
                <Link to="/incidents" style={{ fontSize: 12, color: 'var(--color-text)', textDecoration: 'none', fontWeight: 600 }}>
                  View All
                </Link>
              </div>
              <div className="overview-alert-list">
                {recentDetections
                  .filter(d => d.severity === 'critical')
                  .slice(0, 5)
                  .map(alert => (
                    <div key={alert.id} className="overview-alert-item"
                      style={{ borderLeft: '3px solid #ef4444' }}>
                      <div className="overview-alert-icon" style={{ color: '#ef4444' }}>
                        <span className="material-symbols-outlined icon-sm">
                          {EVENT_TYPE_ICONS[alert.event_type] || 'crisis_alert'}
                        </span>
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="overview-alert-title">
                          {EVENT_TYPE_LABELS[alert.event_type] || alert.event_type}
                        </div>
                        <div className="overview-alert-meta">
                          {alert.location} Â· {formatTs(alert.created_at)}
                        </div>
                      </div>
                      <div className="overview-alert-state critical">CRITICAL</div>
                    </div>
                  ))}
                {recentDetections.filter(d => d.severity === 'critical').length === 0 && !loading && (
                  <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                    No critical alerts
                  </div>
                )}
              </div>
            </div>

            {/* System status */}
            <div className="card overview-panel">
              <div className="overview-panel-header">
                <h3>System Status</h3>
              </div>
              <div className="overview-status-list">
                {systemStatus.map(item => (
                  <div key={item.label} className="overview-status-row">
                    <div className="overview-status-label">
                      <span className="material-symbols-outlined icon-sm">check_circle</span>
                      {item.label}
                    </div>
                    <div className="overview-status-value mono">{item.value}</div>
                    <div className="overview-status-state">
                      {item.state}
                      <span className="overview-online-dot" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Unit deployment */}
            <div className="card overview-panel">
              <div className="overview-panel-header">
                <h3>Unit Deployment</h3>
              </div>
              <div className="overview-deployment-list">
                {deployments.map(item => (
                  <div key={item.unit} className="overview-deployment-row">
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{item.unit}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{item.zone}</div>
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {item.distance}
                    </div>
                    <StatusChip type={item.status === 'On Scene' ? 'warning' : 'safe'} label={item.status} />
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      </div>
      <TacticalActionsBar
        label="COMMAND ACTIONS"
        icon="dashboard"
        actions={[
          { label: 'Broadcast Alert',  icon: 'campaign',             tone: 'danger' },
          { label: 'View Cameras',     icon: 'video_camera_front',   tone: ''       },
          { label: 'Dispatch Units',   icon: 'local_police',         tone: ''       },
          { label: 'Lock All Zones',   icon: 'lock',                 tone: ''       },
          { label: 'Incident Report',  icon: 'summarize',            tone: ''       },
          { label: 'System Status',    icon: 'monitor_heart',        tone: ''       },
        ]}
      />
    </div>
  )
}
