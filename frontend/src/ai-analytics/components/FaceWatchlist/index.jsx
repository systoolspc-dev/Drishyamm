import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TacticalActionsBar from '../common/TacticalActionsBar.jsx';

const CAMERAS = [
  { id: 'CAM-04', name: 'Rahul Sharma', loc: 'Main Gate', conf: 97.4, sev: 'critical', time: '14:20:35', queue: 1 },
  { id: 'CAM-07', name: 'Aman Verma', loc: 'North Entry', conf: 94.1, sev: 'high', time: '14:20:18', queue: 2 },
  { id: 'CAM-01', name: 'Vikram Singh', loc: 'East Wing', conf: 91.8, sev: 'medium', time: '14:19:55', queue: 3 },
  { id: 'CAM-02', name: 'Neha Patel', loc: 'Parking Area', conf: 88.3, sev: 'medium', time: '14:19:30', queue: 4 },
  { id: 'CAM-14', name: 'Unknown Female', loc: 'Retail Lane', conf: 80.2, sev: 'medium', time: '14:16:56', queue: 5 },
  { id: 'CAM-12', name: 'Unknown Male', loc: 'Food Court', conf: 84.5, sev: 'low', time: '14:18:42', queue: 6 },
  { id: 'CAM-09', name: 'Rohit Mehta', loc: 'Service Lift', conf: 82.9, sev: 'low', time: '14:18:10', queue: 7 },
  { id: 'CAM-05', name: 'No match', loc: 'Admin Block', conf: 78.1, sev: 'low', time: '14:17:45', queue: 8 },
  { id: 'CAM-11', name: 'No match', loc: 'South Exit', conf: 76.4, sev: 'low', time: '14:17:11', queue: 9 },
];

const ALERTS = [
  { id: 1, personId: 'WL-001', name: 'Rahul Sharma', cam: 'CAM-04', loc: 'Main Gate', conf: 97.4, sev: 'critical', time: '14:20:35' },
  { id: 2, personId: 'WL-002', name: 'Aman Verma', cam: 'CAM-07', loc: 'North Entry', conf: 94.1, sev: 'high', time: '14:20:18' },
  { id: 3, personId: 'WL-003', name: 'Vikram Singh', cam: 'CAM-01', loc: 'East Wing', conf: 91.8, sev: 'medium', time: '14:19:55' },
  { id: 4, personId: 'WL-004', name: 'Neha Patel', cam: 'CAM-02', loc: 'Parking Area', conf: 88.3, sev: 'medium', time: '14:19:30' },
];

const LAYOUTS = [
  { id: '2x2', label: '2x2', count: 4, columns: 2 },
  { id: '3x3', label: '3x3', count: 9, columns: 3 },
  { id: 'single', label: 'Single', count: 1, columns: 1 },
];

const SEV = {
  critical: { color: '#dc2626', bg: '#fef2f2', label: 'Critical' },
  high: { color: '#b45309', bg: '#fffbeb', label: 'High' },
  medium: { color: '#0A1F44', ink: 'var(--color-text)', bg: '#EAF0F6', label: 'Medium' },
  low: { color: '#16a34a', bg: '#f0fdf4', label: 'Low' },
};

function CameraTile({ cam, active, layout, onSelect }) {
  const sev = SEV[cam.sev] || SEV.medium;
  const large = layout === 'single';
  const isClear = cam.name === 'No match';
  const boxLeft = 24 + (cam.queue % 4) * 10;
  const boxTop = 24 + (cam.queue % 3) * 8;

  return (
    <button
      type="button"
      onClick={() => onSelect(cam.id)}
      style={{
        position: 'relative',
        minHeight: large ? 540 : layout === '2x2' ? 255 : 168,
        background: '#07100c',
        border: `2px solid ${active ? sev.color : '#263a32'}`,
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: active ? `0 0 0 3px ${sev.color}26` : 'none',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg,rgba(255,255,255,.025) 0 1px,transparent 1px 34px),repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 34px)' }} />
      <span style={{ position: 'absolute', top: 10, left: 10, background: isClear ? '#0A1F44' : '#ef4444', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 4, letterSpacing: '.04em' }}>
        {isClear ? 'CLEAR' : 'LIVE'}
      </span>
      <span className="mono" style={{ position: 'absolute', top: 10, right: 10, color: 'rgba(255,255,255,.65)', fontSize: 10 }}>{cam.time}</span>

      {!isClear && (
        <div style={{
          position: 'absolute',
          left: `${boxLeft}%`,
          top: `${boxTop}%`,
          width: large ? '15%' : '18%',
          height: large ? '42%' : '38%',
          border: `2px solid ${sev.color}`,
          borderRadius: 4,
          boxShadow: `0 0 16px ${sev.color}66, inset 0 0 18px ${sev.color}14`,
        }}>
          <div style={{ position: 'absolute', top: large ? -28 : -22, left: -2, background: sev.color, color: '#fff', fontSize: large ? 11 : 9, fontWeight: 800, padding: large ? '3px 9px' : '2px 7px', borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap' }}>
            {cam.name} {cam.conf}%
          </div>
        </div>
      )}

      <div style={{ position: 'absolute', left: 12, right: 12, bottom: 10, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: large ? 15 : 12, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cam.id} | {cam.loc}</div>
          <div style={{ color: 'rgba(255,255,255,.55)', fontSize: large ? 12 : 10, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cam.name}</div>
        </div>
        <span style={{ flexShrink: 0, fontSize: large ? 11 : 9, fontWeight: 800, color: sev.ink || sev.color, background: sev.bg, padding: '2px 7px', borderRadius: 99 }}>{sev.label}</span>
      </div>
    </button>
  );
}

function CameraFeed({ activeCam, onCamSelect }) {
  const [sortMode, setSortMode] = useState('urgency');
  const [layout, setLayout] = useState('2x2');
  const severityRank = { critical: 4, high: 3, medium: 2, low: 1 };
  const active = CAMERAS.find((cam) => cam.id === activeCam) || CAMERAS[0];
  const activeSeverity = SEV[active.sev] || SEV.medium;
  const activeLayout = LAYOUTS.find((item) => item.id === layout) || LAYOUTS[0];
  const cameras = [...CAMERAS].sort((a, b) => {
    if (sortMode === 'urgency') return severityRank[b.sev] - severityRank[a.sev] || b.conf - a.conf;
    if (sortMode === 'confidence') return b.conf - a.conf;
    return a.queue - b.queue;
  });
  const visibleCameras = layout === 'single' ? [active] : cameras.slice(0, activeLayout.count);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-bg)', margin: 0 }}>Live Face Recognition Feed</h3>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{active.id} selected - {activeSeverity.label} priority - {active.conf}% confidence</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {LAYOUTS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLayout(item.id)}
                style={{
                  height: 32,
                  padding: '0 12px',
                  border: `1px solid ${layout === item.id ? '#0A1F44' : 'var(--color-border)'}`,
                  background: layout === item.id ? '#EAF0F6' : 'var(--color-surface)',
                  color: layout === item.id ? 'var(--color-text)' : 'var(--color-text-secondary)',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '6px 8px', fontSize: 11, background: 'var(--color-surface)', color: 'var(--color-on-bg)', outline: 'none' }}>
            <option value="urgency">Urgency</option>
            <option value="confidence">Confidence</option>
            <option value="queue">Queue</option>
          </select>
        </div>
      </div>

      <div style={{ padding: 14, background: '#000000' }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${activeLayout.columns}, minmax(0, 1fr))`, gap: 12 }}>
          {visibleCameras.map((cam) => (
            <CameraTile key={cam.id} cam={cam} active={cam.id === activeCam} layout={layout} onSelect={onCamSelect} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FaceWatchlist() {
  const [activeCam, setActiveCam] = useState('CAM-04');
  const navigate = useNavigate();

  return (
    <div style={{ padding: 24, background: 'var(--color-bg)', minHeight: '100%' }}>
      <div style={{ marginBottom: 18 }}>
        <CameraFeed activeCam={activeCam} onCamSelect={setActiveCam} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-bg)', margin: 0 }}>Live Match Alerts</h3>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', background: '#fff1f1', border: '1px solid rgba(220,38,38,.18)', padding: '2px 9px', borderRadius: 99 }}>
            {ALERTS.length} Active
          </span>
        </div>
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {ALERTS.map((alert) => {
            const sev = SEV[alert.sev] || SEV.medium;
            return (
              <div
                key={alert.id}
                onClick={() => setActiveCam(alert.cam)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setActiveCam(alert.cam);
                }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
              >
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'linear-gradient(135deg,#000000,#0A1F44)', border: `2px solid ${sev.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: sev.ink || sev.color }}>person</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <strong style={{ fontSize: 13, color: 'var(--color-on-bg)' }}>{alert.name}</strong>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{alert.time}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 1 }}>{alert.cam} - {alert.loc}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/ai-analytics/watchlist/suspect/${alert.personId}`);
                      }}
                      style={{ border: '1px solid var(--action-primary-border)', background: 'var(--action-primary-soft)', color: 'var(--action-primary)', borderRadius: 999, padding: '3px 9px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}
                    >
                      Profile
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        navigate(`/ai-analytics/watchlist/behavior/${alert.personId}`);
                      }}
                      style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', borderRadius: 999, padding: '3px 9px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}
                    >
                      Behaviour Analysis
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 99, color: sev.ink || sev.color, background: sev.bg }}>{sev.label}</span>
                  <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: sev.ink || sev.color }}>{alert.conf}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TacticalActionsBar
        label="FACE INTEL ACTIONS"
        icon="face"
        actions={[
          { label: 'Add to Watchlist', icon: 'manage_accounts', tone: '' },
          { label: 'Alert on Match', icon: 'notifications_active', tone: 'danger' },
          { label: 'Run Search', icon: 'person_search', tone: '' },
          { label: 'Open Live Feed', icon: 'monitor', tone: '' },
          { label: 'Export Report', icon: 'summarize', tone: '' },
          { label: 'Save Evidence', icon: 'folder_special', tone: '' },
        ]}
      />
    </div>
  );
}
