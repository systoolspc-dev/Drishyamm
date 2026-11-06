import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { anprDetections, blacklistedVehicles, vehicleJourneyData } from '../../data/ANPR';
import { buildVehicleGraph } from '../../utils/relationshipEngine';

const ownerByPlate = {
  'DL8CAF5678': 'Amit Kumar',
  'RJ14GH2345': 'City Shuttle Operator',
  'MH12AB1234': 'Rajesh Patil',
  'KA09MN9012': 'Unknown Owner',
  'TN22CD3456': 'Ravi Sharma',
  'GJ01EF7890': 'Unknown Owner',
  'UP32IJ6789': 'Priya Singh',
  'WB20KL1234': 'Unknown Owner',
};

const faceByPlate = {
  'DL8CAF5678': { name: 'Amit Kumar', identified: true, confidence: 0.94, faceId: 'FACE-001' },
  'RJ14GH2345': { name: 'Unknown Driver', identified: false, confidence: null, faceId: null },
  'MH12AB1234': { name: 'Unknown Person', identified: false, confidence: null, faceId: null },
  'KA09MN9012': { name: 'Unknown Person', identified: false, confidence: null, faceId: null },
  'TN22CD3456': { name: 'Ravi Sharma', identified: true, confidence: 0.88, faceId: 'FACE-004' },
  'GJ01EF7890': { name: 'Unknown Person', identified: false, confidence: null, faceId: null },
  'UP32IJ6789': { name: 'Priya Singh', identified: true, confidence: 0.91, faceId: 'FACE-007' },
  'WB20KL1234': { name: 'Unknown Person', identified: false, confidence: null, faceId: null },
};

const iconByType = {
  vehicle: 'directions_car',
  person: 'badge',
  face: 'face',
  camera: 'videocam',
  incident: 'warning',
};

const labelByType = {
  vehicle: 'Vehicle',
  person: 'Registered Owner',
  face: 'Detected Face',
  camera: 'Camera',
  incident: 'Incident',
};

const strengthMeta = {
  strong:   { label: 'Strong',   bar: 100, color: '#F7983A' },
  moderate: { label: 'Moderate', bar: 60,  color: '#F59E0B' },
  weak:     { label: 'Weak',     bar: 25,  color: '#94A3B8' },
  selected: { label: 'Origin',   bar: 100, color: '#F7983A' },
};

export default function VehicleRelationshipGraph() {
  const navigate = useNavigate();
  const routeParams = useParams();
  const [params] = useSearchParams();
  const plate = params.get('plate') || routeParams.plate || anprDetections[0].plate;
  const nodes = useMemo(
    () =>
      buildVehicleGraph({
        plate,
        detections: anprDetections,
        blacklist: blacklistedVehicles,
        ownerMap: ownerByPlate,
        faceMap: faceByPlate,
        journeyData: vehicleJourneyData,
      }),
    [plate],
  );
  const [activeId, setActiveId] = useState('vehicle');
  const active = nodes.find((n) => n.id === activeId) || nodes[0];
  const edges = nodes.filter((n) => n.id !== 'vehicle');
  const center = nodes.find((n) => n.id === 'vehicle');
  const meta = strengthMeta[active.strength] || strengthMeta.weak;

  return (
    <main className="anpr-relationship-page">
      <div className="anpr-section-head">
        <div>
          <h2>Vehicle Relationship Graph</h2>
          <p>{plate} — registered owner, detection camera, face co-match, and alert links</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="anpr-live-state">
            <span className="material-symbols-outlined icon-sm">hub</span>
            {edges.length} entity links
          </span>
          <button className="btn btn-ghost" onClick={() => navigate(`/ai-analytics/vehicle/journey?plate=${plate}`)}>
            <span className="material-symbols-outlined icon-sm">route</span>
            View Journey
          </button>
        </div>
      </div>

      <section className="anpr-graph-layout">
        <div className="card anpr-graph-canvas">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <radialGradient id="rg-center" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(247,152,58,0.14)" />
                <stop offset="100%" stopColor="rgba(247,152,58,0)" />
              </radialGradient>
            </defs>
            <ellipse cx="50" cy="50" rx="20" ry="13" fill="url(#rg-center)" />
            {edges.filter((n) => n.strength === 'strong').map((node) => (
              <line key={`glow-${node.id}`} x1={center.x} y1={center.y} x2={node.x} y2={node.y}
                stroke="rgba(247,152,58,0.1)" strokeWidth="3" />
            ))}
            {edges.map((node) => (
              <line key={node.id} x1={center.x} y1={center.y} x2={node.x} y2={node.y}
                className={`anpr-graph-link ${node.strength}`} />
            ))}
          </svg>

          {nodes.map((node) => (
            <button
              key={node.id}
              className={`anpr-graph-node ${node.type} ${node.id === active.id ? 'active' : ''}`}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
              onClick={() => setActiveId(node.id)}
            >
              <span className="anpr-graph-node-icon material-symbols-outlined">
                {iconByType[node.type]}
              </span>
              <strong className="anpr-graph-node-label">{node.label}</strong>
              <small className="anpr-graph-node-sub">{node.category}</small>
            </button>
          ))}
        </div>

        <aside className="card anpr-graph-side">
          <div className="anpr-graph-node-detail">
            <div className={`anpr-graph-detail-icon ${active.type}`}>
              <span className="material-symbols-outlined">{iconByType[active.type]}</span>
            </div>
            <div>
              <span className={`anpr-graph-type-badge ${active.type}`}>{labelByType[active.type]}</span>
              <strong style={{ fontSize: 'var(--type-body)', display: 'block', marginTop: 4 }}>{active.label}</strong>
              <small style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--type-small)' }}>{active.category}</small>
            </div>
          </div>

          <div>
            <div className="anpr-graph-strength-row">
              <span className="section-label">Link Strength</span>
              <span className="anpr-graph-strength-label" style={{ color: meta.color }}>{meta.label}</span>
            </div>
            <div className="anpr-graph-strength-bar">
              <div className="anpr-graph-strength-fill" style={{ width: `${meta.bar}%`, background: meta.color }} />
            </div>
          </div>

          <div className="anpr-profile-grid compact">
            <div><span>Relationship</span><strong>{active.relation}</strong></div>
            {active.id === 'camera' && <div><span>Confidence</span><strong>{Math.round((active.confidence || 0) * 100)}%</strong></div>}
            {active.id === 'camera' && <div><span>Speed</span><strong>{active.speed} km/h</strong></div>}
            {active.id !== 'camera' && <div><span>Graph Owner</span><strong>Vehicle Intelligence</strong></div>}
            <div><span>Evidence State</span><strong>Reviewable</strong></div>
          </div>

          {/* Re-ID panel for unidentified face */}
          {active.id === 'face' && !active.identified && (
            <div className="anpr-graph-reid-panel">
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span className="material-symbols-outlined" style={{ color: '#0EA5E9', fontSize: 20, flexShrink: 0 }}>manage_search</span>
                <div>
                  <strong style={{ fontSize: 'var(--type-small)', display: 'block' }}>Face not matched in database</strong>
                  <small style={{ color: 'var(--color-text-secondary)' }}>Run Re-ID to trace this person's movement across all cameras</small>
                </div>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: '100%' }}
                onClick={() => navigate(`/ai-analytics/face?reid=1&from=${plate}`)}
              >
                <span className="material-symbols-outlined icon-sm">person_search</span>
                Run Re-ID
              </button>
            </div>
          )}

          {/* Identified face — show journey link */}
          {active.id === 'face' && active.identified && (
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => navigate(`/ai-analytics/face?faceId=${active.faceId}`)}
            >
              <span className="material-symbols-outlined icon-sm">route</span>
              View Person Journey
            </button>
          )}

          {/* Camera — view feed */}
          {active.id === 'camera' && (
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => navigate(`/ai-analytics/vehicle/live?camera=${active.label}`)}
            >
              <span className="material-symbols-outlined icon-sm">videocam</span>
              View Camera Feed
            </button>
          )}

          <div>
            <span className="section-label" style={{ display: 'block', marginBottom: 8 }}>Entity Links</span>
            <div className="anpr-graph-connections">
              {edges.map((node) => (
                <button
                  key={node.id}
                  className={`anpr-graph-conn-item ${active.id === node.id ? 'active' : ''}`}
                  onClick={() => setActiveId(node.id)}
                >
                  <span className={`material-symbols-outlined icon-sm anpr-graph-conn-icon ${node.type}`}>
                    {iconByType[node.type]}
                  </span>
                  <span className="anpr-graph-conn-label">{node.label}</span>
                  <span className={`anpr-graph-conn-strength ${node.strength}`}>{node.strength}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="section-label" style={{ display: 'block', marginBottom: 8 }}>Legend</span>
            <div className="anpr-graph-legend">
              {Object.entries(labelByType).filter(([t]) => t !== 'vehicle').map(([type, label]) => (
                <div key={type} className="anpr-graph-legend-item">
                  <span className={`anpr-graph-legend-dot ${type}`} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>

          <button className="btn btn-primary" onClick={() => navigate(`/ai-analytics/vehicle/profile?plate=${plate}`)}>
            <span className="material-symbols-outlined icon-sm">person_search</span>
            Open Vehicle Profile
          </button>
        </aside>
      </section>
    </main>
  );
}
