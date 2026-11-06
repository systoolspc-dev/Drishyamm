import { useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const recordings = [
  { name: 'Main Gate - Morning Rush', camera: 'CAM-102', site: 'Metro HQ', date: '2026-05-26', duration: '12m 34s', size: '248 MB', status: 'Ready', locked: false, storage: 'Hot Storage', health: 'Healthy' },
  { name: 'Bus Bay - Crowd Alert', camera: 'CAM-118', site: 'Transit Plaza', date: '2026-05-26', duration: '08m 12s', size: '176 MB', status: 'Evidence', locked: true, storage: 'Evidence Vault', health: 'Protected' },
  { name: 'Parking Zone - Vehicle Trace', camera: 'CAM-077', site: 'North Parking', date: '2026-05-25', duration: '19m 45s', size: '421 MB', status: 'Ready', locked: false, storage: 'Warm Storage', health: 'Healthy' },
  { name: 'Restricted Gate - Entry Event', camera: 'CAM-044', site: 'Service Gate', date: '2026-05-24', duration: '05m 18s', size: '104 MB', status: 'Locked', locked: true, storage: 'Evidence Vault', health: 'Protected' },
  { name: 'Warehouse Camera Gap', camera: 'CAM-203', site: 'Warehouse', date: '2026-05-24', duration: '02m 42s', size: '62 MB', status: 'Warning', locked: false, storage: 'Hot Storage', health: 'Missing Frames' },
]

export default function Recordings() {
  const [query, setQuery] = useState('')
  const [date, setDate] = useState('all')
  const [site, setSite] = useState('all')
  const [camera, setCamera] = useState('all')
  const [status, setStatus] = useState('all')
  const [locked, setLocked] = useState('all')
  const [storage, setStorage] = useState('all')
  const [selectedName, setSelectedName] = useState(recordings[0].name)

  const sites = [...new Set(recordings.map(item => item.site))]
  const cameras = [...new Set(recordings.map(item => item.camera))]
  const dates = [...new Set(recordings.map(item => item.date))]
  const storageTypes = [...new Set(recordings.map(item => item.storage))]

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return recordings.filter(item => {
      const matchesQuery = !q ||
        item.name.toLowerCase().includes(q) ||
        item.camera.toLowerCase().includes(q) ||
        item.site.toLowerCase().includes(q)
      const matchesDate = date === 'all' || item.date === date
      const matchesSite = site === 'all' || item.site === site
      const matchesCamera = camera === 'all' || item.camera === camera
      const matchesStatus = status === 'all' || item.status.toLowerCase() === status
      const matchesLocked = locked === 'all' || String(item.locked) === locked
      const matchesStorage = storage === 'all' || item.storage === storage
      return matchesQuery && matchesDate && matchesSite && matchesCamera && matchesStatus && matchesLocked && matchesStorage
    })
  }, [camera, date, locked, query, site, status, storage])

  const selected = recordings.find(item => item.name === selectedName) || filtered[0]
  const lockedCount = recordings.filter(item => item.locked).length
  const warningCount = recordings.filter(item => item.health !== 'Healthy' && item.health !== 'Protected').length

  return (
    <div className="page">
      <Topbar
        title="Recordings"
        subtitle={`${filtered.length} shown - ${lockedCount} evidence locked - ${warningCount} health warnings`}
      />
      <div className="page-inner vms-page-inner">
        <div className="vms-recording-summary">
          <div><span>Total Storage</span><strong>78%</strong></div>
          <div><span>Saved Clips</span><strong>{recordings.length}</strong></div>
          <div><span>Evidence Locked</span><strong>{lockedCount}</strong></div>
          <div><span>Health Warnings</span><strong className={warningCount ? 'warning' : ''}>{warningCount}</strong></div>
        </div>

        <section className="card vms-recordings-card">
          <div className="vms-section-header">
            <h3>Recording Library</h3>
            <div className="search-box">
              <span className="material-symbols-outlined icon-sm">search</span>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search recordings, site, camera" />
            </div>
          </div>

          <div className="vms-recording-filters">
            <select className="select" value={date} onChange={e => setDate(e.target.value)} aria-label="Filter by date">
              <option value="all">All Dates</option>
              {dates.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select className="select" value={site} onChange={e => setSite(e.target.value)} aria-label="Filter by site">
              <option value="all">All Sites</option>
              {sites.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select className="select" value={camera} onChange={e => setCamera(e.target.value)} aria-label="Filter by camera">
              <option value="all">All Cameras</option>
              {cameras.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="all">All Status</option>
              <option value="ready">Ready</option>
              <option value="evidence">Evidence</option>
              <option value="locked">Locked</option>
              <option value="warning">Warning</option>
            </select>
            <select className="select" value={locked} onChange={e => setLocked(e.target.value)} aria-label="Filter by evidence lock">
              <option value="all">Any Lock State</option>
              <option value="true">Evidence Locked</option>
              <option value="false">Not Locked</option>
            </select>
            <select className="select" value={storage} onChange={e => setStorage(e.target.value)} aria-label="Filter by storage type">
              <option value="all">All Storage</option>
              {storageTypes.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>

          <div className="vms-recordings-table">
            {filtered.map((item, index) => (
              <button
                className={`vms-recording-row as-button ${selected?.name === item.name ? 'active' : ''}`}
                key={item.name}
                type="button"
                onClick={() => setSelectedName(item.name)}
                aria-label={`Select recording ${item.name}`}
              >
                <div className={`vms-recording-thumb scene-${(index % 4) + 1}`}>
                  <span className="material-symbols-outlined icon-filled">videocam</span>
                </div>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.camera} - {item.site} - {item.duration}</span>
                </div>
                <span className="mono">{item.size}</span>
                <b className={item.status.toLowerCase()}>{item.status}</b>
                <span className={`vms-recording-health ${item.health === 'Missing Frames' ? 'warning' : 'healthy'}`}>
                  <i />
                  {item.health}
                </span>
                <span className="vms-recording-actions">
                  <span title="Open playback" className="material-symbols-outlined icon-sm">play_circle</span>
                  <span title="Export clip" className="material-symbols-outlined icon-sm">download</span>
                  <span title="Evidence details" className="material-symbols-outlined icon-sm">folder_special</span>
                </span>
              </button>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="vms-empty-wall">
              <span className="material-symbols-outlined">video_file</span>
              No recordings match the current filters.
            </div>
          )}
        </section>
      </div>
      <TacticalActionsBar
        label="RECORDING ACTIONS"
        icon="folder_open"
        actions={[
          { label: 'Open Playback', icon: 'history', to: '/vms/playback', disabled: !selected },
          { label: 'Export', icon: 'download', disabled: !selected, title: selected ? `Export ${selected.name}` : 'Select a recording to export' },
          { label: 'Lock Evidence', icon: 'lock', to: '/vms/evidence', title: 'Open evidence library' },
          { label: 'Retention Policy', icon: 'policy', disabled: true, title: 'Retention policy editing is not connected yet' },
        ]}
      />
    </div>
  )
}
