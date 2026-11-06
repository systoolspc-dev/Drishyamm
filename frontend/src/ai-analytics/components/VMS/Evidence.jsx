import { useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const evidenceItems = [
  {
    id: 'EVD-2405-018',
    title: 'Main Gate weapon alert clip',
    camera: 'CAM-102',
    incident: 'INC-7821',
    timestamp: '2026-05-26 09:12:44',
    owner: 'Sahil A.',
    status: 'Locked',
    exportStatus: 'Ready',
    size: '248 MB',
    chain: ['Created by AI event', 'Reviewed by Operator', 'Locked as evidence'],
  },
  {
    id: 'EVD-2405-019',
    title: 'Bus Bay crowd escalation',
    camera: 'CAM-118',
    incident: 'INC-7824',
    timestamp: '2026-05-26 10:38:12',
    owner: 'Control Room',
    status: 'Review',
    exportStatus: 'Queued',
    size: '176 MB',
    chain: ['Created from playback', 'Export queued'],
  },
  {
    id: 'EVD-2405-020',
    title: 'Restricted gate entry',
    camera: 'CAM-044',
    incident: 'INC-7830',
    timestamp: '2026-05-26 11:04:33',
    owner: 'Investigation Team',
    status: 'Locked',
    exportStatus: 'Exported',
    size: '104 MB',
    chain: ['Created by operator', 'Linked to incident', 'Exported for report'],
  },
  {
    id: 'EVD-2405-021',
    title: 'Parking vehicle trace',
    camera: 'CAM-077',
    incident: 'INC-7837',
    timestamp: '2026-05-26 12:26:05',
    owner: 'ANPR Desk',
    status: 'Draft',
    exportStatus: 'Pending',
    size: '421 MB',
    chain: ['Clip marked', 'Awaiting review'],
  },
]

export default function Evidence() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [selectedId, setSelectedId] = useState(evidenceItems[0]?.id)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return evidenceItems.filter(item => {
      const matchesQuery = !q ||
        item.title.toLowerCase().includes(q) ||
        item.camera.toLowerCase().includes(q) ||
        item.incident.toLowerCase().includes(q) ||
        item.owner.toLowerCase().includes(q)
      const matchesStatus = status === 'all' || item.status.toLowerCase() === status
      return matchesQuery && matchesStatus
    })
  }, [query, status])

  const selected = evidenceItems.find(item => item.id === selectedId) || filtered[0]
  const lockedCount = evidenceItems.filter(item => item.status === 'Locked').length
  const queuedCount = evidenceItems.filter(item => item.exportStatus === 'Queued').length

  return (
    <div className="page">
      <Topbar
        title="Evidence"
        subtitle={`${lockedCount} locked clips - ${queuedCount} export queued - ${evidenceItems.length} total evidence files`}
      />

      <div className="page-inner vms-page-inner">
        <div className="vms-evidence-summary">
          <div><span>Evidence Files</span><strong>{evidenceItems.length}</strong></div>
          <div><span>Locked Clips</span><strong>{lockedCount}</strong></div>
          <div><span>Queued Exports</span><strong>{queuedCount}</strong></div>
          <div><span>Linked Incidents</span><strong>{new Set(evidenceItems.map(item => item.incident)).size}</strong></div>
        </div>

        <div className="vms-control-row">
          <div className="search-box vms-search">
            <span className="material-symbols-outlined icon-sm">search</span>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search evidence, camera, incident, or owner" />
          </div>
          <select className="select" value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter evidence by status">
            <option value="all">All Evidence</option>
            <option value="locked">Locked</option>
            <option value="review">Review</option>
            <option value="draft">Draft</option>
          </select>
        </div>

        <div className="vms-evidence-layout">
          <section className="card vms-evidence-list">
            <div className="vms-section-header">
              <h3>Evidence Library</h3>
              <span className="vms-muted">{filtered.length} shown</span>
            </div>

            {filtered.map(item => (
              <button
                className={`vms-evidence-item ${selected?.id === item.id ? 'active' : ''}`}
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                aria-label={`Open evidence ${item.title}`}
              >
                <div className="vms-evidence-thumb">
                  <span className="material-symbols-outlined icon-filled">folder_special</span>
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.id} - {item.camera} - {item.incident}</span>
                </div>
                <b className={item.status.toLowerCase()}>{item.status}</b>
              </button>
            ))}

            {filtered.length === 0 && (
              <div className="vms-empty-wall">
                <span className="material-symbols-outlined">folder_off</span>
                No evidence files match the current filters.
              </div>
            )}
          </section>

          <aside className="card vms-evidence-detail">
            {selected ? (
              <>
                <div className="vms-section-header">
                  <h3>Evidence Details</h3>
                  <b className={`vms-evidence-status ${selected.status.toLowerCase()}`}>{selected.status}</b>
                </div>
                <div className="vms-evidence-preview">
                  <span className="material-symbols-outlined icon-filled">play_circle</span>
                  <strong>{selected.camera}</strong>
                  <small>{selected.timestamp}</small>
                </div>
                <div className="vms-evidence-facts">
                  <div><span>Evidence ID</span><b>{selected.id}</b></div>
                  <div><span>Linked Incident</span><b>{selected.incident}</b></div>
                  <div><span>Camera ID</span><b>{selected.camera}</b></div>
                  <div><span>Owner</span><b>{selected.owner}</b></div>
                  <div><span>Export Status</span><b>{selected.exportStatus}</b></div>
                  <div><span>File Size</span><b>{selected.size}</b></div>
                </div>
                <div className="vms-chain">
                  <h4>Chain of Custody</h4>
                  {selected.chain.map((step, index) => (
                    <div key={step}>
                      <span>{index + 1}</span>
                      <p>{step}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="vms-empty-wall">Select evidence to inspect details.</div>
            )}
          </aside>
        </div>
      </div>

      <TacticalActionsBar
        label="EVIDENCE ACTIONS"
        icon="folder_special"
        actions={[
          { label: 'Playback', icon: 'history', to: '/vms/playback' },
          { label: 'Recordings', icon: 'folder_open', to: '/vms/recordings' },
          { label: 'Export Evidence', icon: 'download', disabled: true, title: 'Select final export options in a later backend phase' },
          { label: 'Create Incident', icon: 'crisis_alert', tone: 'danger', to: '/incidents' },
        ]}
      />
    </div>
  )
}
