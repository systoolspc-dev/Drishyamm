import { useMemo, useState } from 'react'
import { Topbar } from '../layout/Layout.jsx'
import TacticalActionsBar from '../common/TacticalActionsBar.jsx'

const assetTypes = [
  {
    id: 'floorplan',
    icon: 'architecture',
    title: 'Floorplans',
    description: 'PDF, DWG, SVG, PNG, JPG, or marked-up layout files.',
    accept: '.pdf,.dwg,.dxf,.svg,.png,.jpg,.jpeg',
  },
  {
    id: 'gis',
    icon: 'map',
    title: 'GIS Layouts',
    description: 'GeoJSON, KML, SHP, CSV, or campus coordinate sheets.',
    accept: '.geojson,.json,.kml,.kmz,.shp,.zip,.csv,.xlsx',
  },
  {
    id: 'camera',
    icon: 'videocam',
    title: 'Camera Mapping',
    description: 'Camera ID, location, direction, FOV, health, and stream references.',
    accept: '.csv,.xlsx,.json,.pdf',
  },
  {
    id: 'twin',
    icon: 'view_in_ar',
    title: '3D / Digital Twin',
    description: 'BIM, Revit exports, CAD, Blender, GLB, GLTF, OBJ, or FBX.',
    accept: '.rvt,.ifc,.dwg,.dxf,.blend,.glb,.gltf,.obj,.fbx,.zip',
  },
  {
    id: 'zones',
    icon: 'lock',
    title: 'Restricted Zones',
    description: 'Access-control areas, security boundaries, armory, server rooms, evidence rooms.',
    accept: '.pdf,.csv,.xlsx,.json,.geojson,.svg,.png,.jpg,.jpeg',
  },
]

const deliverables = [
  ['gisMap', 'Outdoor GIS map', 'Leaflet map with gates, roads, parking, cameras, incidents, and patrol overlays.'],
  ['floorplan', 'Indoor floorplan', 'SVG/image floorplan with rooms, corridors, restricted areas, and entity positions.'],
  ['digitalTwin', '3D digital twin', 'Simulated or imported 3D facility model with live operational overlays.'],
  ['cameraCoverage', 'Camera coverage', 'Camera markers, direction, FOV, health, and nearest-camera logic.'],
  ['heatmaps', 'Heatmaps and tracking', 'Crowd density, vehicle movement, suspect routes, and incident radius layers.'],
]

const initialForm = {
  organizationName: 'DRISHYAM AI Command Center',
  organizationType: 'Police Department',
  city: 'New Delhi',
  country: 'India',
  siteName: 'Headquarters Campus',
  address: '',
  primaryContact: '',
  contactRole: '',
  securityClassification: 'Demo / Simulated',
  mapSource: 'OpenStreetMap',
  indoorFloors: '3',
  cameraCount: '32',
  restrictedZoneCount: '6',
  patrolUnits: '5',
  notes: '',
}

function prettySize(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function Field({ label, children }) {
  return (
    <label className="intake-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function UploadDropzone({ asset, files, onFiles, onRemove }) {
  const [dragActive, setDragActive] = useState(false)

  const ingestFiles = (fileList) => {
    const nextFiles = Array.from(fileList).map((file) => ({
      id: `${asset.id}-${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      type: file.type || 'Unknown',
      lastModified: file.lastModified,
    }))
    onFiles(asset.id, nextFiles)
  }

  return (
    <div
      className={`intake-dropzone ${dragActive ? 'active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragActive(false)
        ingestFiles(event.dataTransfer.files)
      }}
    >
      <div className="intake-dropzone-head">
        <span className="material-symbols-outlined">{asset.icon}</span>
        <div>
          <strong>{asset.title}</strong>
          <small>{asset.description}</small>
        </div>
      </div>
      <input
        id={`upload-${asset.id}`}
        type="file"
        multiple
        accept={asset.accept}
        onChange={(event) => ingestFiles(event.target.files)}
      />
      <label htmlFor={`upload-${asset.id}`} className="intake-upload-button">
        <span className="material-symbols-outlined icon-sm">upload_file</span>
        Add files
      </label>
      <small className="intake-file-types">{asset.accept.replaceAll(',', ', ')}</small>

      {files.length > 0 && (
        <div className="intake-file-list">
          {files.map((file) => (
            <div key={file.id}>
              <span className="material-symbols-outlined icon-sm">description</span>
              <div>
                <strong>{file.name}</strong>
                <small>{prettySize(file.size)} | {file.type}</small>
              </div>
              <button type="button" onClick={() => onRemove(asset.id, file.id)} aria-label={`Remove ${file.name}`}>
                <span className="material-symbols-outlined icon-sm">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function GISIntakePage() {
  const [form, setForm] = useState(initialForm)
  const [selectedDeliverables, setSelectedDeliverables] = useState({
    gisMap: true,
    floorplan: true,
    digitalTwin: true,
    cameraCoverage: true,
    heatmaps: true,
  })
  const [filesByType, setFilesByType] = useState(() => Object.fromEntries(assetTypes.map((asset) => [asset.id, []])))

  const totalFiles = useMemo(
    () => Object.values(filesByType).reduce((sum, files) => sum + files.length, 0),
    [filesByType]
  )
  const readiness = useMemo(() => {
    let score = 20
    if (form.organizationName && form.siteName) score += 18
    if (form.city && form.country) score += 12
    if (Number(form.cameraCount) > 0) score += 14
    if (filesByType.floorplan.length) score += 14
    if (filesByType.camera.length) score += 10
    if (filesByType.gis.length || form.mapSource) score += 8
    if (selectedDeliverables.digitalTwin && filesByType.twin.length) score += 4
    return Math.min(score, 100)
  }, [filesByType, form, selectedDeliverables.digitalTwin])

  const updateField = (field, value) => setForm((prev) => ({ ...prev, [field]: value }))
  const addFiles = (assetId, files) => {
    setFilesByType((prev) => {
      const existing = prev[assetId] || []
      const known = new Set(existing.map((file) => file.id))
      return {
        ...prev,
        [assetId]: [...existing, ...files.filter((file) => !known.has(file.id))],
      }
    })
  }
  const removeFile = (assetId, fileId) => {
    setFilesByType((prev) => ({
      ...prev,
      [assetId]: prev[assetId].filter((file) => file.id !== fileId),
    }))
  }

  const submitPackage = () => {
    const packageSummary = {
      organization: form,
      deliverables: Object.entries(selectedDeliverables)
        .filter(([, enabled]) => enabled)
        .map(([id]) => deliverables.find((item) => item[0] === id)?.[1] || id),
      uploadedFiles: Object.fromEntries(
        Object.entries(filesByType).map(([key, files]) => [key, files.map((file) => file.name)])
      ),
      readiness,
    }
    window.localStorage.setItem('drishyam-gis-intake', JSON.stringify(packageSummary, null, 2))
  }

  return (
    <div className="page intake-page-shell">
      <Topbar
        title="GIS Project Intake"
        subtitle="Collect organization inputs for maps, floorplans, camera overlays, and digital twins"
        actions={
          <button className="btn btn-primary" onClick={submitPackage}>
            <span className="material-symbols-outlined icon-sm">save</span>
            Save Intake
          </button>
        }
      />

      <main className="intake-page">
        <section className="intake-hero card">
          <div>
            <span>Enterprise input workflow</span>
            <strong>Build GIS from official organization data, not AI-generated sensitive assets.</strong>
            <p>Use this page to collect the files and metadata needed to create a real outdoor GIS map, indoor floorplan, or simulated 3D digital twin.</p>
          </div>
          <div className="intake-readiness">
            <span>Readiness</span>
            <strong>{readiness}%</strong>
            <div><i style={{ width: `${readiness}%` }} /></div>
            <small>{totalFiles} uploaded source files</small>
          </div>
        </section>

        <section className="intake-grid">
          <div className="intake-main">
            <div className="card intake-section">
              <div className="intake-section-title">
                <span className="material-symbols-outlined">apartment</span>
                <div>
                  <strong>Organization Details</strong>
                  <small>Basic identity and location metadata for the GIS project.</small>
                </div>
              </div>
              <div className="intake-form-grid">
                <Field label="Organization name">
                  <input value={form.organizationName} onChange={(event) => updateField('organizationName', event.target.value)} />
                </Field>
                <Field label="Organization type">
                  <select value={form.organizationType} onChange={(event) => updateField('organizationType', event.target.value)}>
                    <option>Police Department</option>
                    <option>Railway Security</option>
                    <option>Smart City Command Center</option>
                    <option>Airport Security</option>
                    <option>Private Campus Security</option>
                  </select>
                </Field>
                <Field label="City">
                  <input value={form.city} onChange={(event) => updateField('city', event.target.value)} />
                </Field>
                <Field label="Country">
                  <input value={form.country} onChange={(event) => updateField('country', event.target.value)} />
                </Field>
                <Field label="Site / campus name">
                  <input value={form.siteName} onChange={(event) => updateField('siteName', event.target.value)} />
                </Field>
                <Field label="Security classification">
                  <select value={form.securityClassification} onChange={(event) => updateField('securityClassification', event.target.value)}>
                    <option>Demo / Simulated</option>
                    <option>Internal</option>
                    <option>Confidential</option>
                    <option>Restricted</option>
                  </select>
                </Field>
                <Field label="Address or map reference">
                  <input value={form.address} onChange={(event) => updateField('address', event.target.value)} placeholder="Campus address, landmark, or coordinate reference" />
                </Field>
                <Field label="Preferred outdoor map source">
                  <select value={form.mapSource} onChange={(event) => updateField('mapSource', event.target.value)}>
                    <option>OpenStreetMap</option>
                    <option>Bhuvan / ISRO</option>
                    <option>Government GIS Portal</option>
                    <option>Mapbox</option>
                    <option>Google Maps</option>
                    <option>Organization-provided GIS</option>
                  </select>
                </Field>
              </div>
            </div>

            <div className="card intake-section">
              <div className="intake-section-title">
                <span className="material-symbols-outlined">upload_file</span>
                <div>
                  <strong>Drag and Drop Source Files</strong>
                  <small>Upload the official inputs used to create the GIS map, floorplan, device registry, and digital twin.</small>
                </div>
              </div>
              <div className="intake-upload-grid">
                {assetTypes.map((asset) => (
                  <UploadDropzone
                    key={asset.id}
                    asset={asset}
                    files={filesByType[asset.id]}
                    onFiles={addFiles}
                    onRemove={removeFile}
                  />
                ))}
              </div>
            </div>
          </div>

          <aside className="intake-side">
            <div className="card intake-section">
              <div className="intake-section-title compact">
                <span className="material-symbols-outlined">task_alt</span>
                <div>
                  <strong>Required Outputs</strong>
                  <small>Select what the organization wants built.</small>
                </div>
              </div>
              <div className="intake-deliverables">
                {deliverables.map(([id, title, detail]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={selectedDeliverables[id]}
                      onChange={() => setSelectedDeliverables((prev) => ({ ...prev, [id]: !prev[id] }))}
                    />
                    <div>
                      <strong>{title}</strong>
                      <span>{detail}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="card intake-section">
              <div className="intake-section-title compact">
                <span className="material-symbols-outlined">tune</span>
                <div>
                  <strong>Operational Inputs</strong>
                  <small>Initial sizing for the map and overlays.</small>
                </div>
              </div>
              <div className="intake-form-grid single">
                <Field label="Indoor floors">
                  <input type="number" min="0" value={form.indoorFloors} onChange={(event) => updateField('indoorFloors', event.target.value)} />
                </Field>
                <Field label="Camera count">
                  <input type="number" min="0" value={form.cameraCount} onChange={(event) => updateField('cameraCount', event.target.value)} />
                </Field>
                <Field label="Restricted zones">
                  <input type="number" min="0" value={form.restrictedZoneCount} onChange={(event) => updateField('restrictedZoneCount', event.target.value)} />
                </Field>
                <Field label="Patrol / response units">
                  <input type="number" min="0" value={form.patrolUnits} onChange={(event) => updateField('patrolUnits', event.target.value)} />
                </Field>
                <Field label="Project notes">
                  <textarea value={form.notes} onChange={(event) => updateField('notes', event.target.value)} placeholder="Mention zones, floors, gates, watchlist needs, or simulation constraints." />
                </Field>
              </div>
            </div>

            <div className="card intake-section">
              <div className="intake-section-title compact">
                <span className="material-symbols-outlined">security</span>
                <div>
                  <strong>Data Handling Reminder</strong>
                  <small>For real deployments, keep sensitive facility files under organizational control.</small>
                </div>
              </div>
              <div className="intake-reminder">
                <div><span>1</span><p>Use official CAD, BIM, GIS, and camera registry data where available.</p></div>
                <div><span>2</span><p>Use simulated or redacted data for demos and portfolio presentations.</p></div>
                <div><span>3</span><p>Convert received files into SVG overlays, GeoJSON layers, and 3D assets before rendering.</p></div>
              </div>
            </div>
          </aside>
        </section>
      </main>
      <TacticalActionsBar
        label="GIS INTAKE ACTIONS"
        icon="edit_document"
        actions={[
          { label: 'Submit Project',   icon: 'send',                 tone: ''       },
          { label: 'Upload Files',     icon: 'upload',               tone: ''       },
          { label: 'Preview Map',      icon: 'map',                  tone: ''       },
          { label: 'Validate Data',    icon: 'fact_check',           tone: ''       },
          { label: 'Export Draft',     icon: 'download',             tone: ''       },
          { label: 'Save to Vault',    icon: 'folder_special',       tone: ''       },
        ]}
      />
    </div>
  )
}
