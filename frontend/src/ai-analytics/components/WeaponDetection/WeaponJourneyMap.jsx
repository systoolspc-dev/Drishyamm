import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Route, Video } from 'lucide-react';

const WEAPON_JOURNEYS = [
  {
    weapon_id: 'WEAP-HGN-VIDEO-001',
    incident_id: 'WPN-DEMO-001',
    weapon_type: 'Handgun',
    face_link: 'Unknown Face',
    severity: 'critical',
    status: 'active',
    confidence: 98,
    stops: [
      { camera: 'CAM-04', zone: 'Main Gate', time: '00:02', confidence: 98, action: 'Handgun visible in live overview feed', x: 36, y: 57 },
      { camera: 'CAM-04', zone: 'Main Gate', time: '00:04', confidence: 98, action: 'Six-second live alert overlay retained', x: 45, y: 52 },
      { camera: 'CAM-04', zone: 'Main Gate', time: '00:06', confidence: 96, action: 'Evidence pack generated from captured clip', x: 58, y: 48 },
    ],
  },
  {
    weapon_id: 'WEAP-RFL-00042',
    incident_id: 'WPN-001',
    weapon_type: 'Rifle',
    face_link: 'Unknown Face',
    severity: 'critical',
    status: 'active',
    confidence: 94,
    stops: [
      { camera: 'CAM-01', zone: 'South Approach', time: '14:17:42', confidence: 79, action: 'Possible long object visible', x: 18, y: 64 },
      { camera: 'CAM-03', zone: 'Entry Queue', time: '14:18:36', confidence: 86, action: 'Weapon outline verified', x: 34, y: 48 },
      { camera: 'CAM-04', zone: 'Main Gate', time: '14:20:31', confidence: 94, action: 'Critical rifle alert created', x: 58, y: 52 },
      { camera: 'CAM-08', zone: 'North Corridor', time: '14:21:08', confidence: 91, action: 'Weapon carrier direction tracked', x: 76, y: 36 },
    ],
  },
  {
    weapon_id: 'WEAP-PST-00017',
    incident_id: 'WPN-002',
    weapon_type: 'Pistol',
    face_link: 'FACE-00921 / Ravi Sharma',
    severity: 'critical',
    status: 'active',
    confidence: 91,
    stops: [
      { camera: 'CAM-07', zone: 'Parking Area', time: '14:19:45', confidence: 91, action: 'Pistol detected near vehicle lane', x: 28, y: 58 },
      { camera: 'CAM-10', zone: 'Parking Exit', time: '14:20:11', confidence: 88, action: 'Face-linked carrier reacquired', x: 52, y: 44 },
      { camera: 'CAM-12', zone: 'Service Road', time: '14:20:48', confidence: 84, action: 'Weapon handoff risk flagged', x: 72, y: 62 },
    ],
  },
  {
    weapon_id: 'WEAP-KNF-00031',
    incident_id: 'WPN-003',
    weapon_type: 'Knife',
    face_link: 'Face Pending',
    severity: 'high',
    status: 'acknowledged',
    confidence: 88,
    stops: [
      { camera: 'CAM-01', zone: 'North Entry', time: '14:18:22', confidence: 88, action: 'Blade detected', x: 24, y: 52 },
      { camera: 'CAM-06', zone: 'Security Desk', time: '14:18:59', confidence: 82, action: 'Subject moved toward checkpoint', x: 48, y: 40 },
      { camera: 'CAM-09', zone: 'Food Court', time: '14:19:33', confidence: 76, action: 'Low visibility continuation', x: 70, y: 57 },
    ],
  },
];

function getTone(severity) {
  if (severity === 'critical') return { color: '#dc2626', bg: '#fef2f2' };
  if (severity === 'high') return { color: '#b45309', bg: '#fffbeb' };
  return { color: '#2563eb', bg: '#eff6ff' };
}

export default function WeaponJourneyMap() {
  const navigate = useNavigate();
  const { weaponId } = useParams();
  const [searchParams] = useSearchParams();
  const selected = useMemo(
    () => WEAPON_JOURNEYS.find(item => item.weapon_id === weaponId) || WEAPON_JOURNEYS[0],
    [weaponId],
  );
  const initialCamera = searchParams.get('camera');
  const initialIndex = Math.max(0, selected.stops.findIndex(stop => stop.camera === initialCamera));
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [playing, setPlaying] = useState(false);
  const activeStop = selected.stops[activeIndex] || selected.stops[0];
  const tone = getTone(selected.severity);

  useEffect(() => {
    setActiveIndex(initialIndex);
    setPlaying(false);
  }, [initialIndex, selected.weapon_id]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex(index => (index + 1) % selected.stops.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [playing, selected.stops.length]);

  return (
    <main className="weapon-journey-page">
      <div className="weapon-journey-header">
        <div>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/ai-analytics/weapon')}>
            <span className="material-symbols-outlined icon-sm">arrow_back</span>
            Overview
          </button>
          <h2>Weapon Journey Map</h2>
          <p>Camera-by-camera stitched path for {selected.weapon_type} evidence.</p>
        </div>
        <select className="select" value={selected.weapon_id} onChange={event => navigate(`/ai-analytics/weapon/journey/${event.target.value}`)}>
          {WEAPON_JOURNEYS.map(item => (
            <option key={item.weapon_id} value={item.weapon_id}>{item.weapon_id} - {item.weapon_type}</option>
          ))}
        </select>
      </div>

      <div className="weapon-journey-summary">
        {[
          ['Weapon ID', selected.weapon_id],
          ['Incident', selected.incident_id],
          ['Current Camera', activeStop.camera],
          ['Face Link', selected.face_link],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <section className="card weapon-card weapon-journey-shell">
        <div className="weapon-journey-title-row">
          <div>
            <div>
              <Route size={16} />
              <h3>Camera Journey Reconstruction</h3>
            </div>
            <p>{selected.incident_id} / {selected.weapon_type} / {selected.confidence}% confidence</p>
          </div>
          <div className="weapon-journey-controls">
            <button type="button" onClick={() => setActiveIndex(index => Math.max(0, index - 1))} title="Previous stop">
              <ChevronLeft size={16} />
            </button>
            <button type="button" className="primary" onClick={() => setPlaying(value => !value)} title={playing ? 'Pause sequence' : 'Play sequence'}>
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" onClick={() => setActiveIndex(index => Math.min(selected.stops.length - 1, index + 1))} title="Next stop">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <div className="weapon-journey-stops">
          {selected.stops.map((stop, index) => (
            <button
              type="button"
              key={`${stop.camera}-${stop.time}`}
              className={index === activeIndex ? 'active' : ''}
              onClick={() => setActiveIndex(index)}
            >
              <span>{index + 1}</span>
              <strong>{stop.camera}</strong>
              <em>{stop.zone}</em>
              <small>{stop.time} / {stop.confidence}%</small>
            </button>
          ))}
        </div>

        <div className="weapon-journey-grid">
          <div className="weapon-journey-map">
            <div className="weapon-journey-map-grid" />
            {selected.stops.map((stop, index) => (
              <button
                type="button"
                key={`${stop.camera}-node`}
                className={`weapon-journey-node ${index === activeIndex ? 'active' : ''}`}
                style={{ left: `${stop.x}%`, top: `${stop.y}%`, borderColor: index === activeIndex ? tone.color : '#94a3b8' }}
                onClick={() => setActiveIndex(index)}
              >
                <span>{stop.camera}</span>
              </button>
            ))}
            <div className="weapon-journey-target" style={{ left: `${activeStop.x}%`, top: `${activeStop.y}%`, borderColor: tone.color, background: tone.bg }}>
              <span style={{ background: tone.color }}>{selected.weapon_type.toUpperCase()} / {activeStop.confidence}%</span>
            </div>
            <div className="weapon-journey-rec">REC {activeStop.camera}</div>
            <div className="weapon-journey-hud">
              <strong>{activeStop.zone}</strong>
              <span>{activeStop.action}</span>
            </div>
          </div>

          <aside className="weapon-journey-detail">
            <div>
              <Video size={14} />
              <strong>Selected Segment</strong>
            </div>
            {[
              ['Zone', activeStop.zone],
              ['Camera', activeStop.camera],
              ['Time', activeStop.time],
              ['Confidence', `${activeStop.confidence}%`],
              ['Evidence Note', activeStop.action],
              ['Status', selected.status],
            ].map(([label, value]) => (
              <section key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </section>
            ))}
            <button className="btn btn-primary" type="button" onClick={() => navigate(`/ai-analytics/weapon/evidence?incident=${selected.incident_id}&weapon=${selected.weapon_id}`)}>
              <span className="material-symbols-outlined icon-sm">folder_special</span>
              Review Evidence
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => navigate('/ai-analytics/weapon/watchlist')}>
              <span className="material-symbols-outlined icon-sm">crisis_alert</span>
              Open Incident Center
            </button>
          </aside>
        </div>
      </section>
    </main>
  );
}
