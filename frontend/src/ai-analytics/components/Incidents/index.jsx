import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Topbar } from '../layout/Layout.jsx'
import { Modal, StatusChip, InfoRow, EmptyState } from '../ui.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { API_URL } from '@/core/config/endpoints'

// Route through the single source of truth so this works in prod, not just
// localhost. API_URL already resolves to `${configured-base}/api`.
const API_BASE = API_URL

const SEV_COLOR = { info: '#2563eb', warning: '#b45309', critical: '#dc2626' }
const SEV_BG    = { info: '#eff6ff', warning: '#fffbeb', critical: '#fef2f2' }
const SEV_ICON  = { info: 'info', warning: 'warning', critical: 'error' }

const TYPE_LABEL = {
  'weapon_detected': 'Weapon Detection',
  'aggression_detected': 'Aggression Detection',
  'tripwire.entry':  'Tripwire Entry',
  'tripwire.exit':   'Tripwire Exit',
  'person.unknown':  'Unknown Person',
  'crowd.density':   'Crowd Density',
  'queue.long':      'Long Queue',
  'camera.tampered': 'Camera Tampered',
}
const TYPE_ICON = {
  'weapon_detected': 'military_tech',
  'aggression_detected': 'front_hand',
  'tripwire.entry':  'login',
  'tripwire.exit':   'logout',
  'person.unknown':  'person_off',
  'crowd.density':   'groups',
  'queue.long':      'queue',
  'camera.tampered': 'no_photography',
}

function EventChip({ severity }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99, background: SEV_BG[severity] || '#f1f5f9', color: SEV_COLOR[severity] || '#475569', fontSize: 12, fontWeight: 600 }}>
      <span className="material-symbols-outlined icon-sm">{SEV_ICON[severity] || 'info'}</span>
      {(severity || 'Info').charAt(0).toUpperCase() + (severity || 'info').slice(1)}
    </span>
  )
}

export default function Events() {
  const [search, setSearch] = useState('')
  const [sevFilter, setSevFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchEvents = async () => {
    try {
      const res = await fetch(`${API_BASE}/ai/threat-feed`)
      const data = await res.json()
      setEvents(data)
      setLoading(false)
    } catch (err) {
      console.error('Events fetch error:', err)
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEvents()
    const interval = setInterval(fetchEvents, 10000)
    return () => clearInterval(interval)
  }, [])

  const filtered = events.filter(ev => {
    const q = search.toLowerCase()
    const typeLabel = TYPE_LABEL[ev.event_type] || ev.event_type || ''
    const matchQ = !q || 
                   (ev.location && ev.location.toLowerCase().includes(q)) || 
                   (ev.camera_id && ev.camera_id.toLowerCase().includes(q)) || 
                   (typeLabel.toLowerCase().includes(q))
    const matchS = sevFilter === 'all' || ev.severity === sevFilter
    return matchQ && matchS
  })

  const criticalCount = events.filter(e => e.severity === 'critical').length

  return (
    <div className="page">
      <Topbar
        title="Tactical Event Log"
        subtitle={`${events.length} total events synchronized from nodes`}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <motion.div
              animate={{ opacity: [1, 0.6, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px', border: '1px solid #fecaca', borderRadius: 999, background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 800 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: '#ef4444', display: 'inline-block' }} />
              {criticalCount} Critical Incidents
            </motion.div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 14px', borderRadius: 99, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 12, fontWeight: 700 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>videocam</span>
              12 Cameras Live
            </div>
          </div>
        }
      />
      <div className="page-inner">
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          <div className="search-box" style={{ flex: 1, minWidth: 240 }}>
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tactical log, nodes, typesâ€¦" />
          </div>
          <select className="select" value={sevFilter} onChange={e => setSevFilter(e.target.value)}>
            <option value="all">All Severity</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', alignSelf: 'center', marginLeft: 'auto' }}>{filtered.length} matching events</div>
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          {loading ? (
             <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>Syncing tactical event stream...</div>
          ) : filtered.length === 0 ? <EmptyState title="No events found" /> : (
            <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Intelligence Type</th>
                  <th>Node Location</th>
                  <th>Camera_ID</th>
                  <th>Confidence</th>
                  <th>Timestamp</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {filtered.map(ev => (
                    <motion.tr
                      key={ev.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      onClick={() => setSelected(ev)}
                      style={{ borderLeft: `3px solid ${SEV_COLOR[ev.severity] || 'transparent'}` }}
                    >
                      <td><EventChip severity={ev.severity} /></td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>{TYPE_ICON[ev.event_type] || 'sensors'}</span>
                          <span style={{ fontWeight: 700 }}>{TYPE_LABEL[ev.event_type]?.toUpperCase() || ev.event_type?.toUpperCase()}</span>
                        </div>
                      </td>
                      <td style={{ fontWeight: 600 }}>{ev.location}</td>
                      <td className="mono" style={{ color: 'var(--color-text-secondary)' }}>{ev.camera_id}</td>
                      <td className="mono">
                        <span style={{ color: parseFloat(ev.confidence) >= 0.9 ? '#16a34a' : parseFloat(ev.confidence) >= 0.8 ? '#b45309' : '#dc2626', fontWeight: 800 }}>
                          {(parseFloat(ev.confidence) * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="mono" style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{new Date(ev.created_at?.replace(' ', 'T')).toLocaleString()}</td>
                      <td>
                        <button className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 10, fontWeight: 800 }}>DRILL_DOWN</button>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={`${TYPE_LABEL[selected?.event_type]?.toUpperCase() || 'EVENT'} ANALYSIS`}
        subtitle={`LOG_ID: EVT-${selected?.id}`}
        width={580}
      >
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: SEV_BG[selected.severity], border: `1px solid ${SEV_COLOR[selected.severity]}30`, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="material-symbols-outlined icon-lg" style={{ color: SEV_COLOR[selected.severity] }}>{SEV_ICON[selected.severity]}</span>
              <div>
                <div style={{ fontWeight: 800, color: SEV_COLOR[selected.severity], fontSize: 14 }}>{selected.severity.toUpperCase()} THREAT LEVEL</div>
                <div style={{ fontSize: 11, color: SEV_COLOR[selected.severity] + 'cc', fontWeight: 700 }}>AI_NODE: {selected.camera_id}</div>
              </div>
            </div>

            <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <InfoRow label="EVENT_TYPE"      value={<strong>{TYPE_LABEL[selected.event_type] || selected.event_type}</strong>} />
              <InfoRow label="NODE_LOCATION"   value={selected.location} />
              <InfoRow label="CAMERA_ID"       value={<code className="mono" style={{ fontSize: 12 }}>{selected.camera_id}</code>} />
              <InfoRow label="AI_CONFIDENCE"   value={<strong className="mono" style={{ color: '#dc2626' }}>{(parseFloat(selected.confidence) * 100).toFixed(2)}%</strong>} />
              <InfoRow label="DATETIME"        value={<span className="mono">{new Date(selected.created_at?.replace(' ', 'T')).toLocaleString()}</span>} />
            </div>

            <div>
              <p className="section-label">Tactical Metadata</p>
              <div style={{ background: '#0b1c30', borderRadius: 'var(--radius-md)', padding: '14px 16px', fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0', lineHeight: 1.8, borderLeft: '4px solid var(--color-primary)' }}>
                {selected.metadata && Object.entries(selected.metadata).map(([k, v]) => (
                  <div key={k}>
                    <span style={{ color: '#94a3b8', fontWeight: 800 }}>{k.toUpperCase()}:</span>{' '}
                    <span style={{ color: '#fb923c' }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button className="btn btn-ghost" style={{ fontWeight: 800 }} onClick={() => setSelected(null)}>CLOSE_LOG</button>
              <button className="btn btn-primary" style={{ fontWeight: 800 }}>GENERATE_INCIDENT_REPORT</button>
            </div>
          </div>
        )}
      </Modal>
      <TacticalActionsBar
        label="INCIDENT ACTIONS"
        icon="crisis_alert"
        actions={[
          { label: 'Raise Incident',   icon: 'add_alert',            tone: 'danger' },
          { label: 'Dispatch Units',   icon: 'local_police',         tone: ''       },
          { label: 'Open Live Feed',   icon: 'monitor',              tone: ''       },
          { label: 'Tag Evidence',     icon: 'label',                tone: ''       },
          { label: 'Generate Report',  icon: 'summarize',            tone: ''       },
          { label: 'Save Evidence',    icon: 'folder_special',       tone: ''       },
        ]}
      />
    </div>
  )
}
