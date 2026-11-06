import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Topbar } from '../layout/Layout.jsx'
import { gisMockData } from '../../data/GISData.js'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const severityClass = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
}

const layerLabels = {
  cameras: 'Cameras',
  incidents: 'Incidents',
  suspects: 'Suspects',
  vehicles: 'Vehicles',
  heatmap: 'Crowd Heatmap',
  zones: 'Restricted Zones',
  patrols: 'Patrol Units',
  evacuation: 'Evacuation Routes',
}

const views = [
  { id: 'live', label: 'Live Tactical Map', icon: 'radar' },
  { id: 'floorplan', label: 'Floorplan View', icon: 'domain' },
  { id: 'tracking', label: 'Live Tracking', icon: 'route' },
  { id: 'incidents', label: 'Incident Map', icon: 'crisis_alert' },
  { id: 'evacuation', label: 'Crowd & Evacuation', icon: 'groups_3' },
  { id: 'coverage', label: 'Camera Coverage', icon: 'videocam' },
  { id: 'replay', label: 'Historical Replay', icon: 'history' },
  { id: 'twin', label: 'Digital Twin', icon: 'view_in_ar' },
  { id: 'sources', label: 'Data Sources', icon: 'database' },
]

const initialLayers = {
  cameras: true,
  incidents: true,
  suspects: true,
  vehicles: true,
  heatmap: true,
  zones: true,
  patrols: true,
  evacuation: true,
}

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L)

  return new Promise((resolve, reject) => {
    const existingLink = document.querySelector('link[data-leaflet-css]')
    if (!existingLink) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      link.dataset.leafletCss = 'true'
      document.head.appendChild(link)
    }

    const existingScript = document.querySelector('script[data-leaflet-js]')
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(window.L), { once: true })
      existingScript.addEventListener('error', reject, { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
    script.async = true
    script.dataset.leafletJs = 'true'
    script.onload = () => resolve(window.L)
    script.onerror = reject
    document.body.appendChild(script)
  })
}

function statusTone(status) {
  if (status === 'ONLINE' || status === 'SAFE' || status === 'RESPONDING' || status === 'SECURED') return 'green'
  if (status === 'LOW FPS' || status === 'MONITORED' || status === 'PATROLLING') return 'amber'
  if (status === 'BLOCKED' || status === 'OFFLINE') return 'red'
  return 'gray'
}

function routeColor(status) {
  if (status === 'SAFE') return '#16a34a'
  if (status === 'MONITORED') return '#f59e0b'
  return '#dc2626'
}

function markerIcon(L, type, label) {
  return L.divIcon({
    className: `gis-marker gis-marker-${type}`,
    html: `<span class="material-symbols-outlined icon-sm">${label}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

function getPoint(entity) {
  return entity.currentPosition || entity.position
}

function distanceMeters(a, b) {
  const lat = (a.lat - b.lat) * 111320
  const lng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.round(Math.sqrt(lat * lat + lng * lng))
}

function GISLeafletMap({ mode, layers, height = 560, focusTarget = null }) {
  const mapRef = useRef(null)
  const containerRef = useRef(null)
  const overlayRef = useRef([])
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return
        const map = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: true,
        }).setView(gisMockData.mapConfig.center, gisMockData.mapConfig.zoom)

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map)

        L.control.zoom({ position: 'bottomright' }).addTo(map)
        mapRef.current = map
        setReady(true)
      })
      .catch(() => setFailed(true))

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!ready || !mapRef.current || !window.L) return
    const L = window.L
    const map = mapRef.current

    overlayRef.current.forEach((layer) => layer.remove())
    overlayRef.current = []

    const add = (layer) => {
      layer.addTo(map)
      overlayRef.current.push(layer)
    }

    const incidentMode = mode === 'incidents' || mode === 'live' || mode === 'replay'
    const trackingMode = mode === 'tracking' || mode === 'live' || mode === 'replay'
    const evacuationMode = mode === 'evacuation' || mode === 'live'
    const coverageMode = mode === 'coverage' || mode === 'live'

    if (layers.heatmap && (mode === 'live' || mode === 'evacuation' || mode === 'tracking')) {
      gisMockData.crowdHeatmap.forEach((point) => {
        add(L.circle([point.lat, point.lng], {
          radius: 34 + point.intensity * 70,
          color: point.risk === 'HIGH' ? '#dc2626' : '#0A1F44',
          weight: 0,
          fillOpacity: point.intensity * 0.42,
          fillColor: point.risk === 'HIGH' ? '#dc2626' : '#f59e0b',
        }).bindTooltip(`${point.risk} crowd density: ${point.crowdCount}`))
      })
    }

    if (layers.zones && (mode === 'live' || mode === 'incidents')) {
      gisMockData.restrictedZones.forEach((zone) => {
        add(L.polygon(zone.coordinates, {
          color: '#dc2626',
          weight: 1,
          dashArray: '6 6',
          fillColor: '#dc2626',
          fillOpacity: 0.12,
        }).bindTooltip(`${zone.name} - ${zone.type}`))
      })
    }

    if (layers.evacuation && evacuationMode) {
      gisMockData.evacuationRoutes.forEach((route) => {
        add(L.polyline(route.path, {
          color: routeColor(route.status),
          weight: 4,
          dashArray: route.status === 'SAFE' ? '0' : '8 8',
        }).bindTooltip(`${route.name}: ${route.status}`))
      })
    }

    if (layers.cameras && coverageMode) {
      gisMockData.cameras.forEach((camera) => {
        const point = [camera.position.lat, camera.position.lng]
        add(L.marker(point, { icon: markerIcon(L, 'camera', 'videocam') }).bindTooltip(`${camera.id} - ${camera.status}`))
        add(L.circle(point, {
          radius: camera.fov,
          color: camera.status === 'ONLINE' ? '#2563eb' : '#b45309',
          weight: 1,
          fillOpacity: 0.08,
        }))
      })
    }

    if (layers.incidents && incidentMode) {
      gisMockData.liveIncidents.forEach((incident) => {
        const point = [incident.position.lat, incident.position.lng]
        add(L.circle(point, {
          radius: incident.threatRadius,
          color: incident.severity === 'CRITICAL' ? '#dc2626' : '#0A1F44',
          weight: 1,
          fillColor: incident.severity === 'CRITICAL' ? '#dc2626' : '#0A1F44',
          fillOpacity: 0.12,
        }))
        add(L.marker(point, { icon: markerIcon(L, 'incident', 'crisis_alert') }).bindPopup(`<strong>${incident.title}</strong><br>${incident.timestamp}<br>${incident.linkedCamera}`))
      })
    }

    if (layers.suspects && trackingMode) {
      gisMockData.suspects.forEach((suspect) => {
        const isFocused = focusTarget?.id === suspect.id
        add(L.polyline(suspect.movementPath, { color: '#dc2626', weight: isFocused ? 6 : 4, dashArray: '7 7' }).bindTooltip(`${suspect.name} movement`))
        add(L.marker([suspect.currentPosition.lat, suspect.currentPosition.lng], { icon: markerIcon(L, 'suspect', 'person_alert') }).bindPopup(`<strong>${suspect.name}</strong><br>${suspect.watchlist}<br>${Math.round(suspect.confidence * 100)}% confidence`))
      })
    }

    if (layers.vehicles && trackingMode) {
      gisMockData.vehicles.forEach((vehicle) => {
        const isFocused = focusTarget?.id === vehicle.id
        add(L.polyline(vehicle.movementPath, { color: '#f59e0b', weight: isFocused ? 6 : 4, dashArray: '12 8' }).bindTooltip(`${vehicle.plate} route`))
        add(L.marker([vehicle.currentPosition.lat, vehicle.currentPosition.lng], { icon: markerIcon(L, 'vehicle', 'directions_car') }).bindPopup(`<strong>${vehicle.plate}</strong><br>${vehicle.color} ${vehicle.type}<br>${vehicle.speed} km/h`))
      })
    }

    if (layers.patrols && (mode === 'live' || mode === 'tracking' || mode === 'evacuation')) {
      gisMockData.patrolUnits.forEach((unit) => {
        add(L.marker([unit.currentPosition.lat, unit.currentPosition.lng], { icon: markerIcon(L, 'patrol', 'local_police') }).bindTooltip(`${unit.officer}: ${unit.status}`))
      })
    }

    if (focusTarget) {
      const point = getPoint(focusTarget)
      if (point) map.setView([point.lat, point.lng], Math.max(map.getZoom(), 17), { animate: true })
    }

    setTimeout(() => map.invalidateSize(), 80)
  }, [ready, layers, mode, focusTarget])

  if (failed) {
    return (
      <div className="gis-map-fallback" style={{ minHeight: height }}>
        <span className="material-symbols-outlined icon-xl">map</span>
        <strong>Map tiles unavailable</strong>
        <p>Leaflet will render here when the browser can load the OpenStreetMap assets.</p>
      </div>
    )
  }

  return <div ref={containerRef} className="gis-leaflet-map" style={{ minHeight: height }} />
}

function MetricCard({ icon, label, value, sub, tone = 'orange' }) {
  return (
    <div className="gis-metric card">
      <div className={`gis-metric-icon ${tone}`}>
        <span className="material-symbols-outlined icon-lg">{icon}</span>
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{sub}</span>
      </div>
    </div>
  )
}

function LayerPanel({ layers, setLayers }) {
  return (
    <div className="gis-layer-panel card">
      <div className="gis-panel-title">
        <strong>Map Layers</strong>
        <span className="material-symbols-outlined icon-sm">layers</span>
      </div>
      {Object.entries(layerLabels).map(([key, label]) => (
        <label key={key} className="gis-layer-row">
          <span>{label}</span>
          <input
            type="checkbox"
            checked={layers[key]}
            onChange={() => setLayers((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        </label>
      ))}
    </div>
  )
}

function IncidentList() {
  return (
    <div className="gis-side-card card">
      <div className="gis-panel-title">
        <strong>Live Incidents</strong>
        <button className="btn btn-ghost">View All</button>
      </div>
      <div className="gis-incident-list">
        {gisMockData.liveIncidents.map((incident) => (
          <div key={incident.id} className={`gis-incident-item ${severityClass[incident.severity]}`}>
            <div className="gis-incident-icon">
              <span className="material-symbols-outlined icon-sm">crisis_alert</span>
            </div>
            <div>
              <strong>{incident.type}</strong>
              <span>{incident.description}</span>
              <small>{incident.severity} | {incident.linkedCamera}</small>
            </div>
            <time>{incident.timestamp}</time>
          </div>
        ))}
      </div>
    </div>
  )
}

function EntityPanel() {
  const entities = [
    ...gisMockData.suspects.map((item) => ({ id: item.id, title: item.name, sub: item.watchlist, meta: item.lastSeenCamera, icon: 'person_alert', tone: 'red' })),
    ...gisMockData.vehicles.map((item) => ({ id: item.id, title: item.plate, sub: `${item.color} ${item.type}`, meta: item.direction, icon: 'directions_car', tone: 'amber' })),
    ...gisMockData.patrolUnits.map((item) => ({ id: item.id, title: item.officer, sub: item.status, meta: item.eta || item.vehicle, icon: 'local_police', tone: 'green' })),
  ]

  return (
    <div className="gis-side-card card">
      <div className="gis-panel-title">
        <strong>Tracked Entities</strong>
        <span>{entities.length}</span>
      </div>
      <div className="gis-entity-list">
        {entities.map((entity) => (
          <div key={entity.id} className="gis-entity-row">
            <span className={`gis-entity-icon ${entity.tone} material-symbols-outlined icon-sm`}>{entity.icon}</span>
            <div>
              <strong>{entity.title}</strong>
              <span>{entity.sub}</span>
            </div>
            <small>{entity.meta}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function GovernanceStrip() {
  const rules = [
    ['Face Watchlist', 'Owns REID and suspect identity'],
    ['ANPR', 'Owns vehicle intelligence'],
    ['Crowd Monitoring', 'Owns density and panic analysis'],
    ['Incident Center', 'Owns lifecycle and assignment'],
    ['GIS', 'Owns spatial fusion and visualization'],
  ]

  return (
    <div className="gis-governance card">
      {rules.map(([module, role]) => (
        <div key={module}>
          <strong>{module}</strong>
          <span>{role}</span>
        </div>
      ))}
    </div>
  )
}

function LiveView({ layers, setLayers }) {
  return (
    <div className="gis-live-grid">
      <div className="gis-map-wrap card">
        <LayerPanel layers={layers} setLayers={setLayers} />
        <GISLeafletMap mode="live" layers={layers} height={620} />
      </div>
      <aside className="gis-side-stack">
        <IncidentList />
        <EntityPanel />
      </aside>
    </div>
  )
}

function FloorplanView() {
  const indoorOccupancy = gisMockData.floorplan.sections.reduce((sum, section) => sum + section.occupancy, 0)
  const indoorCameras = gisMockData.cameras.filter((camera) => ['Dome', 'Fixed'].includes(camera.type)).length
  const restrictedAlerts = gisMockData.liveIncidents.filter((incident) => incident.type === 'Restricted Access').length
  const floorSignals = [
    { icon: 'groups_3', label: 'Occupancy', value: indoorOccupancy, sub: 'Across mapped indoor zones' },
    { icon: 'videocam', label: 'Indoor Cameras', value: indoorCameras, sub: 'Best-view cameras available' },
    { icon: 'warning', label: 'Restricted Alerts', value: restrictedAlerts, sub: 'Maintenance corridor breach' },
  ]
  const floorHotspots = [
    {
      className: 'marker-a',
      icon: 'person_alert',
      title: 'Watchlist suspect',
      detail: 'Face Watchlist and REID place Rahul Sharma near the North Corridor. GIS only visualizes this indoor position.',
      source: 'Face Watchlist',
    },
    {
      className: 'marker-b',
      icon: 'videocam',
      title: 'Best camera view',
      detail: 'CAM-01 has the strongest line of sight for the selected corridor and can be opened by the operator.',
      source: 'Camera Module',
    },
    {
      className: 'marker-c',
      icon: 'crisis_alert',
      title: 'Indoor threat point',
      detail: 'Weapon alert projected into the floorplan so patrol units can avoid entering the danger radius blindly.',
      source: 'Weapon Detection',
    },
    {
      className: 'marker-d',
      icon: 'directions_run',
      title: 'Safe movement route',
      detail: 'Evacuation path prefers lower-density sections and avoids the restricted corridor breach.',
      source: 'Crowd + Incident Center',
    },
  ]

  return (
    <div className="gis-view-stack">
      <div className="gis-view-brief card">
        <div className="gis-brief-icon">
          <span className="material-symbols-outlined">domain</span>
        </div>
        <div>
          <strong>Indoor Floorplan Intelligence</strong>
          <span>Use this view when GPS is not enough. It converts camera, crowd, access-control, and incident signals into room-level awareness for indoor response.</span>
        </div>
      </div>

      <div className="gis-two-col">
        <div className="card gis-floorplan">
          <div className="gis-floor-toolbar">
            <div>
              <strong>Railway Station Floor 1</strong>
              <span>Live indoor occupancy, restricted areas, alerts, and camera positions</span>
            </div>
            <select className="select" defaultValue="floor1">
              <option value="floor1">Floor 1</option>
              <option value="roof">Roof</option>
              <option value="floor2">Floor 2</option>
              <option value="ground">Ground</option>
            </select>
          </div>
          <div className="gis-floorplan-shell">
          <div className="gis-floor-compass">N</div>
          {gisMockData.floorplan.sections.map((section, index) => (
            <div
              key={section.id}
              className={`gis-room room-${index + 1}`}
            >
              <strong>{section.name}</strong>
              <span>{section.occupancy} occupants</span>
              <span className="gis-node-tip">
                <b>{section.name}: {section.status}</b>
                <small>{section.occupancy} occupants. Occupancy and panic signals are consumed from Crowd Monitoring.</small>
              </span>
            </div>
          ))}
          <div
            className="gis-floor-route"
          >
            <span className="gis-node-tip bottom">
              <b>Recommended indoor route</b>
              <small>GIS compares crowd pressure, incident position, and restricted zones to show the least risky path.</small>
            </span>
          </div>
          {floorHotspots.map((spot) => (
            <span
              key={spot.title}
              className={`gis-floor-marker ${spot.className} material-symbols-outlined`}
            >
              {spot.icon}
              <span className="gis-node-tip">
                <b>{spot.title}</b>
                <small>{spot.detail} Source: {spot.source}.</small>
              </span>
            </span>
          ))}
          <div className="gis-floor-legend">
            <span><i className="red" /> Threat</span>
            <span><i className="orange" /> Camera / person</span>
            <span><i className="green" /> Safe route</span>
          </div>
        </div>
      </div>
      <div className="gis-side-card card">
        <div className="gis-panel-title"><strong>Indoor Intelligence</strong></div>
        <div className="gis-floor-signal-grid">
          {floorSignals.map((signal) => (
            <div key={signal.label}>
              <span className="material-symbols-outlined icon-sm">{signal.icon}</span>
              <b>{signal.value}</b>
              <strong>{signal.label}</strong>
              <small>{signal.sub}</small>
            </div>
          ))}
        </div>
        {gisMockData.floorplan.sections.map((section) => (
          <div key={section.id} className="gis-section-row">
            <div>
              <strong>{section.name}</strong>
              <span>{section.status}</span>
            </div>
            <b>{section.occupancy}</b>
          </div>
        ))}
        <div className="gis-floor-action">
          <strong>Suggested operator action</strong>
          <span>Open Platform A cameras, keep South Exit available, and avoid routing patrol through the restricted corridor.</span>
        </div>
      </div>
      </div>
    </div>
  )
}

function TrackingView({ layers }) {
  const targets = [
    ...gisMockData.suspects.map((item) => ({
      ...item,
      category: 'person',
      title: item.name,
      subtitle: item.watchlist,
      owner: 'Face Watchlist + REID',
      icon: 'person_alert',
      tone: 'red',
      status: item.threatLevel,
      speed: 'Walking',
      routeLabel: item.predictedRoute,
    })),
    ...gisMockData.vehicles.map((item) => ({
      ...item,
      category: 'vehicle',
      title: item.plate,
      subtitle: `${item.color} ${item.type}`,
      owner: 'ANPR',
      icon: 'directions_car',
      tone: 'amber',
      status: item.watchlist,
      confidence: 0.91,
      routeLabel: item.direction,
    })),
    ...gisMockData.patrolUnits.map((item) => ({
      ...item,
      category: 'patrol',
      title: item.officer,
      subtitle: item.vehicle,
      owner: 'Incident Center + GPS',
      icon: 'local_police',
      tone: 'green',
      status: item.status,
      confidence: 1,
      speed: item.status === 'RESPONDING' ? 'Fast response' : 'Patrol pace',
      routeLabel: item.assignedIncident || 'Routine patrol',
    })),
  ]
  const [selectedId, setSelectedId] = useState(targets[0]?.id)
  const [filter, setFilter] = useState('all')
  const visibleTargets = filter === 'all' ? targets : targets.filter((target) => target.category === filter)
  const selectedTarget = targets.find((target) => target.id === selectedId) || targets[0]
  const selectedPoint = getPoint(selectedTarget)
  const nearbyCameras = selectedPoint
    ? gisMockData.cameras
      .map((camera) => ({ ...camera, distance: distanceMeters(selectedPoint, camera.position) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
    : []
  const nearestUnit = selectedPoint
    ? gisMockData.patrolUnits
      .map((unit) => ({ ...unit, distance: distanceMeters(selectedPoint, unit.currentPosition) }))
      .sort((a, b) => a.distance - b.distance)[0]
    : null
  const movementLabel = typeof selectedTarget.speed === 'number' ? `${selectedTarget.speed} km/h` : selectedTarget.speed

  return (
    <div className="gis-tracking-grid">
      <div className="card gis-map-wrap">
        <div className="gis-tracking-overlay">
          <div>
            <span>Selected Target</span>
            <strong>{selectedTarget.title}</strong>
          </div>
          <div>
            <span>Source Owner</span>
            <strong>{selectedTarget.owner}</strong>
          </div>
          <div>
            <span>Prediction</span>
            <strong>{selectedTarget.routeLabel}</strong>
          </div>
        </div>
        <GISLeafletMap mode="tracking" layers={layers} height={600} focusTarget={selectedTarget} />
      </div>

      <div className="gis-tracking-side">
        <div className="gis-side-card card">
          <div className="gis-panel-title"><strong>Live Tracking</strong></div>
          <div className="gis-track-filters">
            {['all', 'person', 'vehicle', 'patrol'].map((item) => (
              <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="gis-track-list">
            {visibleTargets.map((target) => (
              <button
                key={target.id}
                className={`gis-track-card ${selectedTarget.id === target.id ? 'active' : ''}`}
                onClick={() => setSelectedId(target.id)}
              >
                {target.image ? <img src={target.image} alt="" /> : <span className={`gis-track-icon ${target.tone} material-symbols-outlined`}>{target.icon}</span>}
                <div>
                  <strong>{target.title}</strong>
                  <span>{target.subtitle}</span>
                  <small>{target.owner}</small>
                </div>
                <b>{Math.round((target.confidence || 1) * 100)}%</b>
              </button>
            ))}
          </div>
        </div>

        <div className="gis-side-card card">
          <div className="gis-panel-title"><strong>Target Intelligence</strong></div>
          <div className="gis-target-hero">
            {selectedTarget.image ? (
              <img src={selectedTarget.image} alt="" />
            ) : (
              <span className={`gis-track-icon ${selectedTarget.tone} material-symbols-outlined`}>{selectedTarget.icon}</span>
            )}
            <div>
              <strong>{selectedTarget.title}</strong>
              <span>{selectedTarget.status}</span>
            </div>
          </div>
          <div className="gis-target-kpis">
            <div><b>{Math.round((selectedTarget.confidence || 1) * 100)}%</b><span>Confidence</span></div>
            <div><b>{movementLabel || 'Live'}</b><span>Movement</span></div>
            <div><b>{selectedTarget.movementPath?.length || 1}</b><span>Track Points</span></div>
          </div>
          <div className="gis-target-block">
            <strong>Nearby cameras</strong>
            {nearbyCameras.map((camera) => (
              <div key={camera.id} className="gis-mini-row">
                <span>{camera.id}</span>
                <small>{camera.distance}m | {camera.status}</small>
              </div>
            ))}
          </div>
          {nearestUnit && (
            <div className="gis-target-block">
              <strong>Nearest response unit</strong>
              <div className="gis-mini-row">
                <span>{nearestUnit.officer}</span>
                <small>{nearestUnit.distance}m | {nearestUnit.status}</small>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function IncidentsView({ layers }) {
  return (
    <div className="gis-two-col wide-left">
      <div className="card gis-map-wrap">
        <GISLeafletMap mode="incidents" layers={layers} height={520} />
      </div>
      <IncidentList />
    </div>
  )
}

function EvacuationView({ layers }) {
  return (
    <div className="gis-two-col wide-left">
      <div className="card gis-map-wrap">
        <GISLeafletMap mode="evacuation" layers={layers} height={520} />
      </div>
      <div className="gis-side-card card">
        <div className="gis-panel-title"><strong>Evacuation Routes</strong></div>
        {gisMockData.evacuationRoutes.map((route) => (
          <div key={route.id} className="gis-route-row">
            <span className={`gis-route-dot ${route.status.toLowerCase()}`} />
            <div>
              <strong>{route.name}</strong>
              <span>{route.status}</span>
            </div>
            <time>{route.estimatedTime || '--:--'}</time>
          </div>
        ))}
        <div className="gis-density-score">
          <span>Crowd Density</span>
          <strong>{gisMockData.analytics.crowdDensityScore}%</strong>
          <small>Consumed from Crowd Monitoring</small>
        </div>
      </div>
    </div>
  )
}

function CoverageView({ layers }) {
  return (
    <div className="gis-two-col wide-left">
      <div className="card gis-map-wrap">
        <GISLeafletMap mode="coverage" layers={layers} height={520} />
      </div>
      <div className="gis-side-card card">
        <div className="gis-panel-title"><strong>Camera Coverage</strong></div>
        {gisMockData.cameras.map((camera) => (
          <div key={camera.id} className="gis-camera-row">
            <span className={`gis-status-dot ${statusTone(camera.status)}`} />
            <div>
              <strong>{camera.id}</strong>
              <span>{camera.name}</span>
            </div>
            <small>{camera.fov}m FOV</small>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReplayView({ layers }) {
  return (
    <div className="gis-two-col wide-left">
      <div className="card gis-map-wrap">
        <GISLeafletMap mode="replay" layers={layers} height={500} />
        <div className="gis-replay-control">
          <span>14:00</span>
          <input type="range" min="0" max="100" defaultValue="62" />
          <span>14:30</span>
        </div>
      </div>
      <div className="gis-side-card card">
        <div className="gis-panel-title"><strong>Spatial Replay</strong></div>
        {gisMockData.incidentTimeline.map((item) => (
          <div key={`${item.timestamp}-${item.event}`} className="gis-timeline-row">
            <time>{item.timestamp}</time>
            <div>
              <strong>{item.event}</strong>
              <span>{item.severity}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DigitalTwinView() {
  const twinObjects = [
    {
      className: 'pin-critical',
      icon: 'crisis_alert',
      title: 'Active threat radius',
      detail: 'Weapon Detection emits the threat event. GIS projects it into the 3D operating model.',
    },
    {
      className: 'pin-camera',
      icon: 'videocam',
      title: 'Camera coverage node',
      detail: 'Camera Module supplies location, health, and field-of-view. Operators use it to select the best live feed.',
    },
    {
      className: 'pin-unit',
      icon: 'local_police',
      title: 'Patrol response unit',
      detail: 'Incident Center assignment and GPS position show Unit Alpha moving toward the threat.',
    },
    {
      className: 'pin-vehicle',
      icon: 'directions_car',
      title: 'ANPR vehicle hit',
      detail: 'ANPR detected a blacklisted SUV outside the station. GIS links it spatially to the active incident.',
    },
  ]

  return (
    <div className="gis-view-stack">
      <div className="gis-view-brief card">
        <div className="gis-brief-icon twin">
          <span className="material-symbols-outlined">view_in_ar</span>
        </div>
        <div>
          <strong>Digital Twin Mode</strong>
          <span>This is a live virtual command model of the facility. It fuses cameras, incidents, crowd zones, vehicles, and patrol movement into one spatial operating picture.</span>
        </div>
      </div>

      <div className="card gis-twin">
        <div className="gis-twin-scene">
          <div className="gis-twin-status-ribbon">
            <span className="live-dot" />
            Live Twin Sync
          </div>
          <div className="gis-twin-explain">
            <strong>What you are seeing</strong>
            <span>A 3D operational model: buildings, routes, active threats, patrols, cameras, crowd pressure, and ANPR hits in one view.</span>
          </div>
          <div className="gis-twin-board">
            <div className="gis-twin-grid" />
            <div className="gis-twin-track" />
            <div className="gis-twin-link link-a" />
            <div className="gis-twin-link link-b" />
            <div className="gis-twin-link link-c" />
            <div className="gis-building block-a">
              <span>North Gate</span><small>Weapon alert</small>
              <span className="gis-node-tip">
                <b>North Gate</b>
                <small>Entry zone with active weapon alert and nearby camera coverage.</small>
              </span>
            </div>
            <div className="gis-building block-b">
              <span>Main Lobby</span><small>Route node</small>
              <span className="gis-node-tip">
                <b>Main Lobby</b>
                <small>Routing junction connecting suspect movement, patrol approach, and evacuation decisions.</small>
              </span>
            </div>
            <div className="gis-building block-c">
              <span>Platform A</span><small>High density</small>
              <span className="gis-node-tip bottom">
                <b>Platform A</b>
                <small>Crowd Monitoring reports high density and panic movement. GIS renders it as pressure on the twin.</small>
              </span>
            </div>
            <div className="gis-building block-d">
              <span>Parking Area</span><small>ANPR hit</small>
              <span className="gis-node-tip edge-right">
                <b>Parking Area</b>
                <small>ANPR event from the parking corridor, linked to blacklisted SUV intelligence.</small>
              </span>
            </div>
            <div className="gis-twin-heat heat-platform" />
            <div className="gis-twin-heat heat-gate" />
            {twinObjects.map((item) => (
              <span
                key={item.title}
              className={`gis-twin-pin ${item.className} material-symbols-outlined`}
            >
              {item.icon}
              <span className="gis-node-tip">
                <b>{item.title}</b>
                <small>{item.detail}</small>
              </span>
            </span>
            ))}
          </div>
          <div className="gis-twin-legend">
            <span><i className="red" /> Threat</span>
            <span><i className="blue" /> Camera</span>
            <span><i className="green" /> Patrol</span>
            <span><i className="amber" /> Vehicle</span>
          </div>
        </div>
        <div className="gis-twin-side">
          <strong>Digital Twin Status</strong>
          <span>Live organization model synced from cameras, incidents, crowd zones, patrol units, and routes.</span>
          <div className="gis-twin-kpis">
            <div><b>5</b><span>Linked systems</span></div>
            <div><b>12</b><span>Geo events</span></div>
            <div><b>3</b><span>Risk zones</span></div>
          </div>
          <div className="gis-twin-flow">
            <strong>Current intelligence flow</strong>
            <div><span>Face Watchlist</span><b>Suspect path active</b></div>
            <div><span>Weapon Detection</span><b>Threat radius projected</b></div>
            <div><span>Crowd Monitoring</span><b>Platform A pressure rising</b></div>
            <div><span>Incident Center</span><b>Unit Alpha responding</b></div>
          </div>
          <div className="gis-floor-action twin">
            <strong>What operators use this for</strong>
            <span>Understand building context faster, test response paths visually, and coordinate teams before they enter the affected zone.</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function DataSourcesView() {
  const sourceCards = [
    {
      icon: 'architecture',
      title: 'Architectural Floorplans',
      source: 'Provided by police engineering, public works, infrastructure vendors, or facility teams.',
      formats: 'PDF, DWG, SVG, PNG/JPG, BIM/Revit',
      output: 'Converted into SVG, image overlays, and coordinate maps for frontend rendering.',
    },
    {
      icon: 'public',
      title: 'GIS / Outdoor Location Data',
      source: 'Built from OpenStreetMap, Mapbox, Google Maps, Bhuvan/ISRO maps, or government GIS portals.',
      formats: 'Map tiles, GeoJSON, shapefiles, road/campus coordinates',
      output: 'Rendered as real outdoor maps with checkpoints, roads, parking, gates, and surveillance overlays.',
    },
    {
      icon: 'videocam',
      title: 'Camera Locations',
      source: 'Provided by security teams, camera vendors, or police IT administrators.',
      formats: 'Camera ID, latitude, longitude, location, direction, field-of-view, health',
      output: 'Registered on the map as camera markers, coverage cones, and best-view routing for incidents.',
    },
    {
      icon: 'lock',
      title: 'Restricted Zones',
      source: 'Provided by security admins and operational departments.',
      formats: 'Evidence rooms, armory, server rooms, staff corridors, control rooms',
      output: 'Rendered as protected polygons and indoor zones with access level and breach alerts.',
    },
    {
      icon: 'view_in_ar',
      title: '3D Digital Twin Data',
      source: 'Usually comes from BIM/Revit, CAD, engineering teams, or a Blender recreation.',
      formats: 'BIM, CAD, GLB/GLTF, FBX, Blender scene files',
      output: 'Used to simulate buildings, routes, device positions, and AI event overlays.',
    },
  ]

  const buildSteps = [
    ['Import building data', 'Use CAD, BIM, GIS, or a custom SVG floorplan supplied by the organization.'],
    ['Register devices', 'Map cameras, sensors, checkpoints, patrol units, and coverage direction.'],
    ['Connect AI events', 'Attach weapon, ANPR, crowd, object, face, and access-control events to coordinates.'],
    ['Run live operations', 'Update the GIS map and digital twin in real time as incidents change.'],
  ]

  const demoStack = [
    ['Outdoor', 'OpenStreetMap + Leaflet'],
    ['Indoor', 'Custom SVG floorplans'],
    ['Overlay logic', 'React + mapped coordinates'],
    ['Advanced twin', 'Blender + React Three Fiber'],
  ]

  return (
    <div className="gis-view-stack">
      <div className="gis-view-brief card">
        <div className="gis-brief-icon">
          <span className="material-symbols-outlined">database</span>
        </div>
        <div>
          <strong>Enterprise GIS Data Workflow</strong>
          <span>Real police GIS, floorplan, camera, and infrastructure data should come from official organizational sources. This demo uses simulated data because those assets are sensitive security material.</span>
        </div>
      </div>

      <div className="gis-source-grid">
        {sourceCards.map((card) => (
          <div key={card.title} className="gis-source-card card">
            <span className="material-symbols-outlined">{card.icon}</span>
            <strong>{card.title}</strong>
            <p>{card.source}</p>
            <div>
              <small>Typical files</small>
              <b>{card.formats}</b>
            </div>
            <div>
              <small>Frontend use</small>
              <b>{card.output}</b>
            </div>
          </div>
        ))}
      </div>

      <div className="gis-two-col">
        <div className="gis-source-panel card">
          <div className="gis-panel-title">
            <strong>How Enterprises Build It</strong>
          </div>
          <div className="gis-source-steps">
            {buildSteps.map(([title, detail], index) => (
              <div key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="gis-source-panel card">
          <div className="gis-panel-title">
            <strong>Recommended Demo Architecture</strong>
          </div>
          <div className="gis-stack-list">
            {demoStack.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="gis-floor-action">
            <strong>Project positioning</strong>
            <span>Use a fictional organization such as DRISHYAM AI Command Center, simulate restricted zones and 3D infrastructure, and clearly state that real deployments ingest official CAD, BIM, GIS, and camera mapping data.</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function GISPage() {
  const [activeView, setActiveView] = useState('live')
  const [layers, setLayers] = useState(initialLayers)

  const metrics = useMemo(() => [
    { icon: 'crisis_alert', label: 'Active Incidents', value: gisMockData.analytics.activeIncidents, sub: '2 new', tone: 'orange' },
    { icon: 'videocam', label: 'Live Cameras', value: `${gisMockData.analytics.onlineCameras} / ${gisMockData.analytics.onlineCameras + 4}`, sub: '4 offline', tone: 'blue' },
    { icon: 'person_pin_circle', label: 'Tracked Persons', value: gisMockData.analytics.activeTracking, sub: '3 moving', tone: 'amber' },
    { icon: 'directions_car', label: 'Tracked Vehicles', value: gisMockData.vehicles.length, sub: '5 moving', tone: 'amber' },
    { icon: 'groups_3', label: 'Crowd Density', value: `${gisMockData.analytics.crowdDensityScore}%`, sub: 'High', tone: 'orange' },
  ], [])

  return (
    <div className="page gis-page-shell">
      <Topbar
        title="GIS Tactical Map"
        subtitle="Real-time situational awareness and intelligence fusion"
        actions={
          <>
            <select className="select" defaultValue="all">
              <option value="all">All Zones</option>
              <option value="north">North Corridor</option>
              <option value="platform">Platform A</option>
              <option value="parking">Parking Area</option>
            </select>
            <motion.div
              animate={{ opacity: [1, 0.6, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px', border: '1px solid #fecaca', borderRadius: 999, background: '#fef2f2', color: '#dc2626', fontSize: 12, fontWeight: 800 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 99, background: '#ef4444', display: 'inline-block' }} />
              5 Critical Alerts
            </motion.div>
          </>
        }
      />

      {/* Sub-navigation bar â€” same pattern as weapon/aggression detection */}
      <div className="subnav-bar" style={{
        display: 'flex', alignItems: 'center',
        padding: '0 20px', gap: 2,
        overflowX: 'auto', flexShrink: 0,
      }}>
        {views.map(view => {
          const isActive = activeView === view.id;
          return (
            <button
              key={view.id}
              onClick={() => setActiveView(view.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '11px 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--color-text)' : '#64748b',
                borderBottom: isActive ? '2px solid var(--color-text)' : '2px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
                transition: 'color 0.12s',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: isActive ? 'var(--color-text)' : '#94a3b8' }}>
                {view.icon}
              </span>
              {view.label}
            </button>
          );
        })}
      </div>

      <main className="gis-page">
        <div className="gis-content">
          <div className="gis-metrics-grid">
            {metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
          </div>

          <GovernanceStrip />

          {activeView === 'live' && <LiveView layers={layers} setLayers={setLayers} />}
          {activeView === 'floorplan' && <FloorplanView />}
          {activeView === 'tracking' && <TrackingView layers={layers} />}
          {activeView === 'incidents' && <IncidentsView layers={layers} />}
          {activeView === 'evacuation' && <EvacuationView layers={layers} />}
          {activeView === 'coverage' && <CoverageView layers={layers} />}
          {activeView === 'replay' && <ReplayView layers={layers} />}
          {activeView === 'twin' && <DigitalTwinView />}
          {activeView === 'sources' && <DataSourcesView />}
        </div>
      </main>
      <TacticalActionsBar
        label="GIS COMMAND ACTIONS"
        icon="map"
        actions={[
          { label: 'Broadcast Alert',  icon: 'campaign',             tone: 'danger' },
          { label: 'Deploy Units',     icon: 'local_police',         tone: ''       },
          { label: 'Lock Zone',        icon: 'lock',                 tone: ''       },
          { label: 'Initiate Evac',    icon: 'emergency_share',      tone: ''       },
          { label: 'Export Map',       icon: 'download',             tone: ''       },
          { label: 'Save Evidence',    icon: 'folder_special',       tone: ''       },
        ]}
      />
    </div>
  )
}
