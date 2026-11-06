import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Topbar } from '../layout/Layout.jsx'
import { StatusChip, EmptyState } from '../ui.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { personnelMockData } from '../../data/personnelMockData.js'
import { API_URL } from '@/core/config/endpoints'

// Route through the single source of truth so this works in prod, not just
// localhost. API_URL already resolves to `${configured-base}/api`.
const API_BASE = API_URL
const filters = ['All', 'Student', 'Staff', 'Faculty']

export default function PersonnelSearch() {
  const [personnel, setPersonnel] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('All')

  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE}/personnel`)
      if (!res.ok) throw new Error('API error')
      const data = await res.json()
      setPersonnel(data)
    } catch {
      setPersonnel(personnelMockData)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 8000)
    return () => clearInterval(interval)
  }, [])

  const filtered = personnel.filter(p => {
    const q = search.toLowerCase()
    const matchQ = !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || p.department.toLowerCase().includes(q) || p.location.toLowerCase().includes(q)
    const matchF = activeFilter === 'All' || p.id.includes(activeFilter.toUpperCase())
    return matchQ && matchF
  })

  return (
    <div className="page">
      <Topbar
        title="Personnel Search"
        subtitle="Biometric tracking and historical movement analysis for registered campus entities"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <motion.div
              animate={{ opacity: [1, 0.6, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px', border: '1px solid #fecaca', borderRadius: 999, background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 800 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: '#ef4444', display: 'inline-block' }} />
              2 Active Alerts
            </motion.div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 14px', borderRadius: 99, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d', fontSize: 12, fontWeight: 700 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>badge</span>
              {filtered.length} Personnel
            </div>
          </div>
        }
      />

      <div className="page-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 20 }}>
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
            <p className="section-label">Personnel Intelligence</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, color: 'var(--color-on-surface)', letterSpacing: '-0.025em' }}>Personnel Search</h2>
            <p style={{ color: 'var(--color-text-secondary)', marginTop: 4, maxWidth: 560 }}>
              Search identities, review current status, and open journey trails without leaving the admin console.
            </p>
          </motion.div>
          <div style={{ display: 'flex', gap: 6, padding: 4, background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)' }}>
            {filters.map(filter => (
              <button
                key={filter}
                className={filter === activeFilter ? 'btn btn-primary' : 'btn btn-ghost'}
                style={{ padding: '7px 14px', border: filter === activeFilter ? 'none' : '1px solid transparent' }}
                onClick={() => setActiveFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className="card" style={{ overflow: 'hidden', marginBottom: 24 }}>
          <div className="toolbar-row" style={{ padding: 16, marginBottom: 0, borderBottom: '1px solid var(--color-border)' }}>
            <div className="search-box">
              <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
              <input 
                placeholder="Filter by name, ID, department, or location..." 
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button className="btn btn-ghost">
              <span className="material-symbols-outlined icon-sm">filter_list</span>
              Advanced
            </button>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Full Name / ID</th>
                  <th>Department</th>
                  <th>Current Status</th>
                  <th>Last Seen Location</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {filtered.map(person => (
                    <motion.tr 
                      key={person.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <td>
                        <div style={{ position: 'relative', width: 44, height: 44 }}>
                          <div className="avatar avatar-lg" style={{ borderRadius: 10, background: person.chip_bg, color: person.chip_text, border: '1px solid var(--color-border)', fontWeight: 800 }}>
                            {person.avatar}
                          </div>
                          <span style={{
                            position: 'absolute',
                            right: -2,
                            bottom: -2,
                            width: 12,
                            height: 12,
                            borderRadius: 99,
                            border: '2px solid #fff',
                            background: person.status === 'offline' ? '#cbd5e1' : person.status === 'alert' ? 'var(--color-primary)' : 'var(--color-success)',
                          }} />
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 700 }}>{person.name}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{person.id}</div>
                      </td>
                      <td>
                        <span className="chip" style={{ background: person.chip_bg, color: person.chip_text, fontWeight: 700 }}>
                          {person.department}
                        </span>
                      </td>
                      <td>{renderStatus(person)}</td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)' }}>
                          <span className="material-symbols-outlined icon-sm" style={{ color: person.status === 'live' ? 'var(--color-text)' : 'inherit' }}>location_on</span>
                          <span className="mono" style={{ fontWeight: person.status === 'live' ? 700 : 400 }}>{person.location}</span>
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                          {person.status === 'offline' ? (
                            <button className="btn btn-ghost" disabled style={{ opacity: .55, cursor: 'not-allowed' }}>
                              <span className="material-symbols-outlined icon-sm">videocam_off</span>
                              Offline
                            </button>
                          ) : person.status === 'alert' ? (
                            <button className="btn btn-danger" style={{ fontWeight: 800 }}>
                              <span className="material-symbols-outlined icon-sm">emergency</span>
                              VIEW_ALERT
                            </button>
                          ) : (
                            <button className="btn btn-ghost" style={{ color: 'var(--color-success-text)', borderColor: '#bbf7d0', background: 'var(--color-success-bg)', fontWeight: 800 }}>
                              <span className="material-symbols-outlined icon-sm">videocam</span>
                              LIVE_FEED
                            </button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </tbody>
            </table>
            {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>Synchronizing biometric node...</div>}
            {!loading && filtered.length === 0 && <EmptyState title="No personnel found" />}
          </div>
          <div style={{ padding: '13px 16px', borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', gap: 12 }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Biometric synchronization active Â· Last update: {new Date().toLocaleTimeString()}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button className="btn btn-ghost" style={{ padding: 6 }}><span className="material-symbols-outlined icon-sm">chevron_left</span></button>
              <strong>1</strong>
              <button className="btn btn-ghost" style={{ padding: 6 }}><span className="material-symbols-outlined icon-sm">chevron_right</span></button>
            </div>
          </div>
        </div>

        <div className="personnel-insight-grid">
          <section className="card" style={{ padding: 20, overflow: 'hidden', position: 'relative' }}>
            <span className="material-symbols-outlined" style={{ position: 'absolute', right: 18, top: 12, fontSize: 92, color: 'var(--color-text)', opacity: .06 }}>route</span>
            <p className="section-label" style={{ color: 'var(--color-primary-dark)' }}>Analysis Spotlight</p>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>Recent Movement Density Map</h3>
            <div className="density-map">
              <div className="density-line density-line-a" />
              <div className="density-line density-line-b" />
              <span className="density-node" style={{ left: '16%', top: '62%' }} />
              <span className="density-node" style={{ left: '42%', top: '36%' }} />
              <motion.span 
                animate={{ scale: [1, 1.5, 1], opacity: [0.8, 0.4, 0.8] }}
                transition={{ repeat: Infinity, duration: 2 }}
                className="density-hotspot" 
                style={{ left: '64%', top: '44%' }} 
              />
              <motion.span 
                animate={{ scale: [1, 1.2, 1], opacity: [0.6, 0.3, 0.6] }}
                transition={{ repeat: Infinity, duration: 2, delay: 0.5 }}
                className="density-hotspot small" 
                style={{ left: '78%', top: '28%' }} 
              />
            </div>
          </section>
          <section style={{ background: '#0b1c30', color: '#fff', borderRadius: 'var(--radius-lg)', padding: 22, boxShadow: 'var(--shadow-md)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 220, borderLeft: '4px solid var(--color-primary)' }}>
            <div>
              <span className="material-symbols-outlined icon-filled" style={{ fontSize: 38, color: 'var(--color-primary)' }}>shield_person</span>
              <h3 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15, marginTop: 14 }}>Sentinel Intelligence</h3>
              <p style={{ marginTop: 10, color: 'rgba(255,255,255,.7)' }}>AI-suggested profiles requiring immediate review based on irregular access patterns and gait mismatch detected at Node_04.</p>
            </div>
            <button className="btn" style={{ marginTop: 18, background: 'var(--color-primary)', color: '#fff', justifyContent: 'center', fontWeight: 800, border: 'none' }}>
              REVIEW 12 BIOMETRIC ALERTS
              <span className="material-symbols-outlined icon-sm">arrow_forward</span>
            </button>
          </section>
        </div>
      </div>
      <TacticalActionsBar
        label="PERSONNEL ACTIONS"
        icon="badge"
        actions={[
          { label: 'Track Live',       icon: 'my_location',          tone: ''       },
          { label: 'View Trail',       icon: 'route',                tone: ''       },
          { label: 'Alert Security',   icon: 'notifications_active', tone: 'danger' },
          { label: 'Flag Suspect',     icon: 'person_search',        tone: ''       },
          { label: 'Export Profile',   icon: 'download',             tone: ''       },
          { label: 'Save Evidence',    icon: 'folder_special',       tone: ''       },
        ]}
      />
    </div>
  )
}

function renderStatus(person) {
  if (person.status === 'live') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-success-text)', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        <motion.span 
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          className="live-dot" 
        />
        Tracked Live
      </span>
    )
  }
  if (person.status === 'alert') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--color-primary-dark)' }}>
        <motion.span 
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ repeat: Infinity, duration: 1 }}
          className="material-symbols-outlined icon-sm"
        >
          warning
        </motion.span>
        <span>
          <strong style={{ display: 'block', fontSize: 12, fontWeight: 800 }}>ALERT_TRIGGERED</strong>
          <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>{person.alert}</span>
        </span>
      </span>
    )
  }
  return (
    <span style={{ color: 'var(--color-text-secondary)' }}>
      <span style={{ display: 'block', fontWeight: 600 }}>Offline</span>
      <span className="mono" style={{ fontSize: 11 }}>{person.last_seen}</span>
    </span>
  )
}
