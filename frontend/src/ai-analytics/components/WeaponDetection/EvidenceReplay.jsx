import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
// Optional demo clip — the media binaries aren't part of the checkout, so this
// resolves the file when present and yields null when it isn't, instead of
// failing the module graph at import time.
const demoClips = import.meta.glob('../../assets/*.webm', { eager: true, query: '?url', import: 'default' });
const weaponDemoVideo = demoClips['../../assets/weapondetection video demo.webm'] || null;

const INCIDENTS = [
  {
    incident_id: 'WPN-DEMO-001',
    weapon_id: 'WEAP-HGN-VIDEO-001',
    weapon_type: 'Handgun',
    face_id: null,
    face_name: 'Unknown Face',
    location: 'Main Gate',
    camera: 'CAM-04',
    severity: 'critical',
    status: 'active',
    confidence: 98,
    notes: 'Demo handgun alert generated at 00:02 from the live weapon overview feed.',
    clips: ['CAM-04 live handgun alert', 'CAM-04 six-second alert overlay', 'CAM-04 evidence snapshot'],
    journey: ['CAM-04 / 00:02', 'CAM-04 / 00:03', 'CAM-04 / 00:06'],
    isDemoVideo: true,
  },
  {
    incident_id: 'WPN-001',
    weapon_id: 'WEAP-RFL-00042',
    weapon_type: 'Rifle',
    face_id: null,
    face_name: 'Unknown Face',
    location: 'Main Gate',
    camera: 'CAM-04',
    severity: 'critical',
    status: 'active',
    confidence: 94,
    notes: 'Critical weapon alert. Unknown carrier needs face intake.',
    clips: ['CAM-01 approach', 'CAM-03 queue handoff', 'CAM-04 main gate alert', 'CAM-08 north corridor'],
    journey: ['CAM-01 / 14:17:42', 'CAM-03 / 14:18:36', 'CAM-04 / 14:20:31', 'CAM-08 / 14:21:08'],
  },
  {
    incident_id: 'WPN-002',
    weapon_id: 'WEAP-PST-00017',
    weapon_type: 'Pistol',
    face_id: 'FACE-00921',
    face_name: 'Ravi Sharma',
    location: 'Parking Area',
    camera: 'CAM-07',
    severity: 'critical',
    status: 'active',
    confidence: 91,
    notes: 'Face is red-list linked. Relationship graph available in Face Watchlist.',
    clips: ['CAM-07 parking lane', 'CAM-10 parking exit', 'CAM-12 service road'],
    journey: ['CAM-07 / 14:19:45', 'CAM-10 / 14:20:11', 'CAM-12 / 14:20:48'],
  },
  {
    incident_id: 'WPN-003',
    weapon_id: 'WEAP-KNF-00031',
    weapon_type: 'Knife',
    face_id: null,
    face_name: 'Face Pending',
    location: 'North Entry',
    camera: 'CAM-01',
    severity: 'high',
    status: 'acknowledged',
    confidence: 88,
    notes: 'Face matching pending. Keep clip chain attached to incident.',
    clips: ['CAM-01 entry frame', 'CAM-06 security desk', 'CAM-09 food court'],
    journey: ['CAM-01 / 14:18:22', 'CAM-06 / 14:18:59', 'CAM-09 / 14:19:33'],
  },
];

const SEV = {
  critical: { color: '#dc2626', bg: '#fef2f2' },
  high: { color: '#b45309', bg: '#fffbeb' },
  warning: { color: '#2563eb', bg: '#eff6ff' },
};

function InfoTile({ label, value }) {
  return (
    <div className="weapon-evidence-info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function EvidenceReplay() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedIncident = params.get('incident');
  const initial = INCIDENTS.find(item => item.incident_id === requestedIncident) || INCIDENTS[0];
  const [selectedId, setSelectedId] = useState(initial.incident_id);
  const [packStatus, setPackStatus] = useState('');
  const selected = useMemo(() => INCIDENTS.find(item => item.incident_id === selectedId) || INCIDENTS[0], [selectedId]);
  const tone = SEV[selected.severity] || SEV.warning;

  const goFace = () => {
    if (selected.face_id) {
      navigate(`/ai-analytics/watchlist/suspect/${selected.face_id}?source=weapon&incident=${selected.incident_id}&weapon=${selected.weapon_id}`);
      return;
    }
    const params = new URLSearchParams({
      source: 'weapon',
      mode: 'add',
      incident: selected.incident_id,
      weapon: selected.weapon_id,
      face: 'unknown',
      image: '/weapon-demo.jpg',
      notes: `Unknown face captured with ${selected.weapon_type} at ${selected.camera}, ${selected.location}.`,
    });
    navigate(`/ai-analytics/watchlist/watchlist?${params.toString()}`);
  };

  return (
    <main className="weapon-evidence-page">
      <div className="weapon-evidence-header">
        <div>
          <h2>Incident Evidence Pack</h2>
          <p>Weapon evidence, face crop, camera clips, journey segments, metadata and exportable report context.</p>
        </div>
        <select className="select" value={selectedId} onChange={event => setSelectedId(event.target.value)}>
          {INCIDENTS.map(item => (
            <option key={item.incident_id} value={item.incident_id}>{item.incident_id} - {item.weapon_id}</option>
          ))}
        </select>
      </div>

      <div className="weapon-evidence-summary">
        <InfoTile label="Incident" value={selected.incident_id} />
        <InfoTile label="Weapon ID" value={selected.weapon_id} />
        <InfoTile label="Camera" value={selected.camera} />
        <InfoTile label="Journey Stops" value={selected.journey.length} />
      </div>

      <div className="weapon-evidence-grid">
        <section className="card weapon-card weapon-evidence-capture">
          <div className="weapon-panel-title-row">
            <h3>Primary Evidence</h3>
            <span className="weapon-status-inline"><span />{selected.status}</span>
          </div>
          <div className="weapon-evidence-preview">
            {selected.isDemoVideo ? (
              <video
                src={weaponDemoVideo}
                autoPlay
                muted
                loop
                playsInline
                aria-label="Weapon evidence capture"
                style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#020617' }}
              />
            ) : (
              <img src="/weapon-demo.jpg" alt="Weapon evidence capture" />
            )}
            <div className={`weapon-evidence-box ${selected.isDemoVideo ? 'demo-gun' : ''}`} style={{ borderColor: tone.color }}>
              <span style={{ background: tone.color }}>{selected.weapon_type.toUpperCase()} {selected.confidence}%</span>
            </div>
            <em>{selected.camera} / {selected.location}{selected.isDemoVideo ? ' / detected at 00:02' : ''}</em>
          </div>
          <div className="weapon-evidence-meta">
            <InfoTile label="Weapon" value={selected.weapon_type} />
            <InfoTile label="Severity" value={selected.severity} />
            <InfoTile label="Confidence" value={`${selected.confidence}%`} />
            <InfoTile label="Journey Stops" value={selected.journey.length} />
          </div>
        </section>

        <aside className="card weapon-card weapon-evidence-side">
          <div className="weapon-panel-title-row">
            <h3>Face Crop</h3>
            <button className="btn btn-ghost" type="button" onClick={goFace}>{selected.face_id ? 'Open Face' : 'Add Face'}</button>
          </div>
          <div className="weapon-evidence-face">
            <span className="material-symbols-outlined">face</span>
            <strong>{selected.face_name}</strong>
            <em>{selected.face_id || 'Unknown face intake required'}</em>
          </div>
          <div className="weapon-evidence-notes">
            <span>Investigation Notes</span>
            <p>{selected.notes}</p>
          </div>
        </aside>
      </div>

      <div className="weapon-evidence-lower">
        <section className="card weapon-card">
          <div className="weapon-panel-title-row">
            <h3>Camera Clips</h3>
            <button className="btn btn-ghost" type="button" onClick={() => setPackStatus(`${selected.clips.length} clips queued for ${selected.incident_id}.`)}>
              Export Clips
            </button>
          </div>
          <div className="weapon-evidence-list">
            {selected.clips.map((clip, index) => (
              <button type="button" key={clip} onClick={() => setPackStatus(`${clip} selected for evidence review.`)}>
                <span className="material-symbols-outlined">movie</span>
                <strong>{clip}</strong>
                <em>Segment {index + 1}</em>
              </button>
            ))}
          </div>
        </section>

        <section className="card weapon-card">
          <div className="weapon-panel-title-row">
            <h3>Journey Segments</h3>
            <button className="btn btn-primary" type="button" onClick={() => navigate(`/ai-analytics/weapon/journey/${selected.weapon_id}`)}>Open Journey</button>
          </div>
          <div className="weapon-evidence-list">
            {selected.journey.map((stop, index) => (
              <button type="button" key={stop} onClick={() => setPackStatus(`${stop} selected in journey report.`)}>
                <span className="material-symbols-outlined">route</span>
                <strong>{stop}</strong>
                <em>Stop {index + 1}</em>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="card weapon-card weapon-evidence-report">
        <div className="weapon-panel-title-row">
          <div>
            <h3>Evidence Report</h3>
            <p>Operator-ready pack grouped by incident, suspect link, weapon journey and evidence.</p>
          </div>
          <span className="weapon-registry-chip" style={{ color: tone.color, background: tone.bg }}>{selected.severity}</span>
        </div>
        <div className="weapon-report-grid">
          <div>
            <span>Incident Summary</span>
            <strong>{selected.incident_id} / {selected.weapon_id}</strong>
            <em>{selected.weapon_type} detected at {selected.location} from {selected.camera}</em>
          </div>
          <div>
            <span>Identity Link</span>
            <strong>{selected.face_name}</strong>
            <em>{selected.face_id || 'Face Watchlist intake pending'}</em>
          </div>
          <div>
            <span>Journey Map Report</span>
            <strong>{selected.journey.length} camera stops reconstructed</strong>
            <em>{selected.journey[0]} to {selected.journey[selected.journey.length - 1]}</em>
          </div>
          <div>
            <span>Evidence Included</span>
            <strong>{selected.clips.length} clips / {selected.journey.length} journey stops</strong>
            <em>Weapon snapshot, face crop, journey map, metadata and investigation notes</em>
          </div>
        </div>
        <div className="weapon-evidence-actions">
          {packStatus && <span className="weapon-evidence-status">{packStatus}</span>}
          <button className="btn btn-ghost" type="button" onClick={() => setPackStatus(`Investigation notes saved for ${selected.incident_id}.`)}>Save Notes</button>
          <button className="btn btn-ghost" type="button" onClick={() => setPackStatus(`Report generated for ${selected.incident_id} with journey and suspect context.`)}>Generate Report</button>
          <button className="btn btn-primary" type="button" onClick={() => setPackStatus(`Evidence pack exported for ${selected.incident_id}.`)}>Export Evidence Pack</button>
        </div>
      </section>
    </main>
  );
}
