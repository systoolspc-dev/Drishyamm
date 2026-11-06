import { useEffect, useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'
import { camerasApi } from '../../core/services/apiClient.js'

const fallbackCameras = [
  { id: 'CAM-102', name: 'Main Gate Entrance', ip: '192.168.1.24', customer: 'Metro HQ', status: 'online', area: 'Main Gate' },
  { id: 'CAM-118', name: 'Bus Bay Overview', ip: '192.168.1.38', customer: 'Transit Plaza', status: 'online', area: 'Bus Bay' },
  { id: 'CAM-044', name: 'Restricted Entry Gate', ip: '192.168.1.44', customer: 'Service Gate', status: 'offline', area: 'Restricted Entry' },
  { id: 'CAM-077', name: 'Parking Zone North', ip: '192.168.1.77', customer: 'North Parking', status: 'online', area: 'Parking Area' },
  { id: 'CAM-203', name: 'Warehouse Loading Bay', ip: '192.168.1.203', customer: 'Warehouse', status: 'online', area: 'Warehouse' },
]

const eventTypes = [
  { value: 'all', label: 'All events' },
  { value: 'motion', label: 'Motion' },
  { value: 'weapon', label: 'Weapon' },
  { value: 'fire', label: 'Fire' },
  { value: 'crowd', label: 'Crowd' },
  { value: 'restricted', label: 'Restricted zone' },
  { value: 'signal', label: 'Signal loss' },
]

const eventMarkers = [
  { id: 'EVT-0912-A', date: '2026-05-26', time: '09:12', endTime: '09:13', camera: 'CAM-102', type: 'motion', event: 'Motion spike', status: 'Reviewed', area: 'Main Gate', severity: 'Medium', confidence: 86 },
  { id: 'EVT-1040-B', date: '2026-05-26', time: '10:40', endTime: '10:43', camera: 'CAM-102', type: 'crowd', event: 'Crowd movement', status: 'Flagged', area: 'Main Gate', severity: 'High', confidence: 91 },
  { id: 'EVT-1038-A', date: '2026-05-26', time: '10:38', endTime: '10:41', camera: 'CAM-118', type: 'crowd', event: 'Crowd density alert', status: 'Flagged', area: 'Bus Bay', severity: 'High', confidence: 94 },
  { id: 'EVT-1104-A', date: '2026-05-26', time: '11:04', endTime: '11:06', camera: 'CAM-044', type: 'restricted', event: 'Restricted zone entry', status: 'Evidence saved', area: 'Restricted Entry', severity: 'Critical', confidence: 97 },
  { id: 'EVT-0914-B', date: '2026-05-26', time: '09:14', endTime: '09:16', camera: 'CAM-077', type: 'motion', event: 'Vehicle movement match', status: 'Reviewed', area: 'Parking Area', severity: 'Medium', confidence: 82 },
  { id: 'EVT-1043-C', date: '2026-05-26', time: '10:43', endTime: '10:45', camera: 'CAM-203', type: 'crowd', event: 'Overflow route detected', status: 'Pending', area: 'Warehouse', severity: 'High', confidence: 88 },
  { id: 'EVT-1106-B', date: '2026-05-26', time: '11:06', endTime: '11:08', camera: 'CAM-203', type: 'restricted', event: 'Exit route confirmation', status: 'Evidence saved', area: 'Warehouse', severity: 'Critical', confidence: 92 },
  { id: 'EVT-1226-A', date: '2026-05-26', time: '12:26', endTime: '12:31', camera: 'CAM-203', type: 'signal', event: 'Signal interruption', status: 'Pending', area: 'Warehouse', severity: 'Low', confidence: 79 },
]

function areaForCamera(camera) {
  if (camera.area) return camera.area
  const text = `${camera.name || ''} ${camera.customer || ''}`.toLowerCase()
  if (text.includes('gate') || text.includes('main')) return 'Main Gate'
  if (text.includes('parking')) return 'Parking Area'
  if (text.includes('bus') || text.includes('transit')) return 'Bus Bay'
  if (text.includes('warehouse')) return 'Warehouse'
  if (text.includes('restricted') || text.includes('service')) return 'Restricted Entry'
  return camera.customer || 'Unassigned Area'
}

function normalizeCamera(camera, index) {
  return {
    id: String(camera.id || `CAM-${String(index + 1).padStart(3, '0')}`),
    name: camera.name || 'Unnamed Camera',
    ip: camera.ip || 'No IP assigned',
    customer: camera.customer || 'Unassigned Site',
    status: camera.status || 'unknown',
    area: areaForCamera(camera),
  }
}

function timeToMinutes(value) {
  const [hours = 0, minutes = 0] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function markerOffset(time, startTime, endTime) {
  const start = timeToMinutes(startTime)
  const end = timeToMinutes(endTime)
  const current = timeToMinutes(time)
  if (end <= start) return 0
  return Math.min(100, Math.max(0, ((current - start) / (end - start)) * 100))
}

function isWithinWindow(item, date, startTime, endTime) {
  const itemStart = timeToMinutes(item.time)
  const itemEnd = timeToMinutes(item.endTime || item.time)
  return item.date === date && itemEnd >= timeToMinutes(startTime) && itemStart <= timeToMinutes(endTime)
}

function severityClass(severity = '') {
  return severity.toLowerCase()
}

export default function Playback() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [usingFallback, setUsingFallback] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [cameraSearch, setCameraSearch] = useState('')
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [eventType, setEventType] = useState('all')
  const [date, setDate] = useState('2026-05-26')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('13:00')
  const [playhead, setPlayhead] = useState(0)
  const [selectedEventId, setSelectedEventId] = useState(null)

  const loadCameras = () => {
    setLoading(true)
    camerasApi.list()
      .then(data => {
        const normalized = data.map(normalizeCamera)
        setCameras(normalized)
        setSelectedCameraId(current => current || normalized[0]?.id || '')
        setUsingFallback(false)
        setError(null)
      })
      .catch(err => {
        console.error('Playback camera fetch error:', err)
        const normalized = fallbackCameras.map(normalizeCamera)
        setCameras(normalized)
        setSelectedCameraId(current => current || normalized[0]?.id || '')
        setUsingFallback(true)
        setError('Camera API is offline. Showing demo playback data.')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadCameras()
  }, [])

  const selectedCamera = useMemo(
    () => cameras.find(camera => camera.id === selectedCameraId) || cameras[0],
    [cameras, selectedCameraId],
  )

  const visibleCameras = useMemo(() => {
    const q = cameraSearch.trim().toLowerCase()
    return cameras.filter(camera => {
      if (!q) return true
      return camera.name.toLowerCase().includes(q) ||
        camera.id.toLowerCase().includes(q) ||
        camera.ip.toLowerCase().includes(q) ||
        camera.area.toLowerCase().includes(q) ||
        camera.customer.toLowerCase().includes(q)
    })
  }, [cameraSearch, cameras])

  const matchingEvents = useMemo(() => {
    if (!selectedCamera) return []
    return eventMarkers
      .filter(item => item.camera === selectedCamera.id)
      .filter(item => eventType === 'all' || item.type === eventType)
      .filter(item => isWithinWindow(item, date, startTime, endTime))
      .map(item => ({ ...item, offset: markerOffset(item.time, startTime, endTime) }))
      .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
  }, [date, endTime, eventType, selectedCamera, startTime])

  const selectedEvent = useMemo(
    () => matchingEvents.find(item => item.id === selectedEventId) || matchingEvents[0] || null,
    [matchingEvents, selectedEventId],
  )

  useEffect(() => {
    if (!selectedEvent) {
      setSelectedEventId(null)
      setPlayhead(0)
      return
    }
    if (selectedEvent.id !== selectedEventId) {
      setSelectedEventId(selectedEvent.id)
    }
    setPlayhead(selectedEvent.offset)
  }, [selectedEvent, selectedEventId])

  const currentIndex = selectedEvent ? matchingEvents.findIndex(item => item.id === selectedEvent.id) : -1
  const selectedTypeLabel = eventTypes.find(item => item.value === eventType)?.label || 'All events'
  const reviewSummary = selectedCamera
    ? `${selectedCamera.id} - ${selectedCamera.name} - ${selectedCamera.area} - ${date} ${startTime}-${endTime}`
    : 'Select a camera to review playback'

  const selectEvent = (event) => {
    setSelectedEventId(event.id)
    setPlayhead(event.offset)
  }

  const jumpEvent = (direction) => {
    if (!matchingEvents.length) return
    const nextIndex = currentIndex < 0
      ? 0
      : Math.min(matchingEvents.length - 1, Math.max(0, currentIndex + direction))
    selectEvent(matchingEvents[nextIndex])
  }

  return (
    <div className="page">
      <Topbar title="Playback" subtitle={reviewSummary} />

      <div className="page-inner vms-page-inner playback-workspace">
        {error && (
          <div className="vms-error">
            <span className="material-symbols-outlined">warning</span>
            <span>{error}</span>
            <button className="btn btn-ghost" type="button" onClick={loadCameras}>Retry</button>
          </div>
        )}

        <section className="playback-shell">
          <aside className="card playback-control-panel">
            <div className="vms-section-header">
              <div>
                <h3>Playback Search</h3>
                <p>Choose one camera and a time window.</p>
              </div>
              <button className="btn btn-ghost icon-only" type="button" onClick={loadCameras} aria-label="Refresh cameras" title="Refresh cameras">
                <span className="material-symbols-outlined">refresh</span>
              </button>
            </div>

            <div className="playback-time-grid">
              <label>
                Date
                <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
              </label>
              <label>
                Start
                <input className="input" type="time" value={startTime} onChange={e => setStartTime(e.target.value)} />
              </label>
              <label>
                End
                <input className="input" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} />
              </label>
              <label>
                Highlight
                <select className="select" value={eventType} onChange={e => setEventType(e.target.value)}>
                  {eventTypes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
            </div>

            <label className="playback-camera-search">
              Camera ID / name / area
              <input
                className="input"
                value={cameraSearch}
                onChange={e => setCameraSearch(e.target.value)}
                placeholder="Search cameras"
              />
            </label>

            <div className="playback-camera-list">
              {loading && <div className="vms-empty-wall">Loading cameras...</div>}
              {!loading && visibleCameras.map(camera => (
                <button
                  key={camera.id}
                  className={`playback-camera-option ${selectedCamera?.id === camera.id ? 'active' : ''}`}
                  type="button"
                  onClick={() => {
                    setSelectedCameraId(camera.id)
                    setSelectedEventId(null)
                  }}
                  aria-label={`Review ${camera.name}`}
                >
                  <span className={`vms-camera-status-dot ${camera.status}`} />
                  <span>
                    <strong>{camera.name}</strong>
                    <small>{camera.id} - {camera.area}</small>
                  </span>
                  <b>{camera.status}</b>
                </button>
              ))}
              {!loading && visibleCameras.length === 0 && (
                <div className="vms-empty-wall">No camera matches this search.</div>
              )}
            </div>
          </aside>

          <main className="playback-review">
            <section className="card playback-viewer-card">
              <div className="playback-viewer-topline">
                <div>
                  <span className="section-label">Now reviewing</span>
                  <h3>{selectedCamera?.name || 'No camera selected'}</h3>
                  <p>{selectedCamera ? `${selectedCamera.id} - ${selectedCamera.area} - ${selectedCamera.customer}` : 'Select a camera to see recordings.'}</p>
                </div>
                <div className="playback-window-pill">
                  <span className="material-symbols-outlined icon-sm">calendar_clock</span>
                  {date} {startTime}-{endTime}
                </div>
              </div>

              <div className="playback-video-surface">
                <div className="playback-video-grid" />
                <div className="playback-video-overlay">
                  <span className="material-symbols-outlined icon-filled">videocam</span>
                  <strong>{selectedEvent ? selectedEvent.event : 'Recorded footage'}</strong>
                  <small>
                    {selectedEvent
                      ? `${selectedEvent.time}-${selectedEvent.endTime} - ${selectedEvent.severity} - ${selectedEvent.status}`
                      : selectedCamera ? 'No event marker selected in this range.' : 'Choose a camera to begin.'}
                  </small>
                </div>
                {selectedEvent && (
                  <div className={`playback-detection-box ${severityClass(selectedEvent.severity)}`}>
                    <span>{selectedEvent.type}</span>
                  </div>
                )}
              </div>

              <div className="playback-timeline-panel">
                <div className="vms-timeline-labels">
                  <span>{startTime}</span>
                  <strong>{matchingEvents.length} {selectedTypeLabel.toLowerCase()} markers</strong>
                  <span>{endTime}</span>
                </div>
                <div className="playback-timeline-track">
                  <input type="range" min="0" max="100" value={playhead} onChange={e => setPlayhead(Number(e.target.value))} aria-label="Playback scrubber" />
                  <span className="playback-progress" style={{ width: `${playhead}%` }} />
                  {matchingEvents.map(item => (
                    <button
                      key={item.id}
                      className={`playback-event-marker ${severityClass(item.severity)} ${selectedEvent?.id === item.id ? 'active' : ''}`}
                      style={{ left: `${item.offset}%` }}
                      type="button"
                      onClick={() => selectEvent(item)}
                      aria-label={`Jump to ${item.event} at ${item.time}`}
                      title={`${item.time} - ${item.event} - ${item.severity}`}
                    />
                  ))}
                </div>
                <div className="playback-player-controls">
                  <button className="btn btn-ghost icon-only" type="button" onClick={() => jumpEvent(-1)} disabled={currentIndex <= 0} aria-label="Previous event" title="Previous event">
                    <span className="material-symbols-outlined">skip_previous</span>
                  </button>
                  <button className="btn btn-primary icon-only" type="button" aria-label="Play playback" title="Play">
                    <span className="material-symbols-outlined">play_arrow</span>
                  </button>
                  <button className="btn btn-ghost icon-only" type="button" onClick={() => jumpEvent(1)} disabled={currentIndex === -1 || currentIndex >= matchingEvents.length - 1} aria-label="Next event" title="Next event">
                    <span className="material-symbols-outlined">skip_next</span>
                  </button>
                  <span className="mono">{selectedEvent?.time || startTime} / {endTime}</span>
                </div>
              </div>
            </section>

            <section className="card vms-playback-events">
              <div className="vms-section-header">
                <h3>Events On This Camera</h3>
                <span className="vms-muted">{matchingEvents.length} in selected time</span>
              </div>
              <div className="playback-event-table">
                {matchingEvents.map(item => (
                  <button
                    className={`vms-playback-event-row ${selectedEvent?.id === item.id ? 'active' : ''}`}
                    key={item.id}
                    type="button"
                    onClick={() => selectEvent(item)}
                    aria-label={`Select ${item.event}`}
                  >
                    <span className="mono">{item.time}</span>
                    <strong>{item.event}</strong>
                    <span>{item.camera}</span>
                    <span>{item.area}</span>
                    <b className={severityClass(item.severity)}>{item.severity}</b>
                  </button>
                ))}
                {matchingEvents.length === 0 && (
                  <div className="vms-empty-wall">
                    <span className="material-symbols-outlined">manage_search</span>
                    No highlighted events in this camera and time window.
                  </div>
                )}
              </div>
            </section>
          </main>

          <aside className="card playback-detail-panel">
            <div className="vms-section-header">
              <h3>Details</h3>
              {usingFallback && <span className="vms-demo-pill">Demo data</span>}
            </div>

            <div className="playback-focus-card">
              <span className="material-symbols-outlined icon-filled">photo_camera</span>
              <div>
                <strong>{selectedCamera?.id || 'No camera'}</strong>
                <span>{selectedCamera?.name || 'Select camera'}</span>
              </div>
            </div>

            <div className="playback-facts">
              <div><span>Camera ID</span><b>{selectedCamera?.id || '-'}</b></div>
              <div><span>Name</span><b>{selectedCamera?.name || '-'}</b></div>
              <div><span>Area</span><b>{selectedCamera?.area || '-'}</b></div>
              <div><span>Status</span><b>{selectedCamera?.status || '-'}</b></div>
              <div><span>Date</span><b>{date}</b></div>
              <div><span>Time range</span><b>{startTime} - {endTime}</b></div>
            </div>

            <div className="playback-selected-event">
              <span className="section-label">Highlighted event</span>
              {selectedEvent ? (
                <>
                  <h3>{selectedEvent.event}</h3>
                  <p>{selectedEvent.time}-{selectedEvent.endTime} - {selectedEvent.status}</p>
                  <div className="playback-confidence">
                    <span style={{ width: `${selectedEvent.confidence}%` }} />
                    <b>{selectedEvent.confidence}%</b>
                  </div>
                  <b className={`playback-severity ${severityClass(selectedEvent.severity)}`}>{selectedEvent.severity}</b>
                </>
              ) : (
                <p>No event is highlighted for this range.</p>
              )}
            </div>
          </aside>
        </section>
      </div>

      {exportOpen && (
        <div className="modal-overlay" onClick={() => setExportOpen(false)}>
          <div className="modal-box vms-export-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Export Clip</h2>
                <p>Prepare this single-camera playback range for evidence export.</p>
              </div>
              <button className="btn btn-ghost" type="button" aria-label="Close export clip dialog" onClick={() => setExportOpen(false)}>
                <span className="material-symbols-outlined icon-sm">close</span>
              </button>
            </div>
            <div className="modal-body vms-export-body">
              <label>
                Clip name
                <input className="input" defaultValue={selectedEvent ? `${selectedCamera?.id} ${selectedEvent.event}` : `${selectedCamera?.id || 'Camera'} playback`} />
              </label>
              <label>
                Export range
                <input className="input" defaultValue={`${date} ${startTime} - ${endTime}`} />
              </label>
              <label>
                Camera
                <input className="input" defaultValue={selectedCamera ? `${selectedCamera.id} - ${selectedCamera.name}` : 'No camera selected'} />
              </label>
              <label>
                Export reason
                <select className="select" defaultValue="incident">
                  <option value="incident">Incident review</option>
                  <option value="evidence">Evidence lock</option>
                  <option value="audit">Audit request</option>
                </select>
              </label>
              <button className="btn btn-primary" type="button" onClick={() => setExportOpen(false)}>
                <span className="material-symbols-outlined icon-sm">download</span>
                Queue Export
              </button>
            </div>
          </div>
        </div>
      )}

      <TacticalActionsBar
        label="PLAYBACK ACTIONS"
        icon="history"
        actions={[
          { label: 'Export Clip', icon: 'download', onClick: () => setExportOpen(true), disabled: !selectedCamera },
          { label: 'Save Evidence', icon: 'folder_special', to: '/vms/evidence', disabled: !selectedEvent },
          { label: 'Create Incident', icon: 'crisis_alert', tone: 'danger', to: '/incidents', disabled: !selectedEvent },
        ]}
      />
    </div>
  )
}
