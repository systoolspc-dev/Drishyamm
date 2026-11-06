import { useState } from 'react';

const TIMELINE_EVENTS = [
  { id: 'E1', time: '08:14:22', camera: 'CAM-01', location: 'Main Gate',    plate: 'MH12AB1234', type: 'entry',   severity: 'critical' },
  { id: 'E2', time: '08:16:05', camera: 'CAM-03', location: 'Parking Area', plate: 'MH12AB1234', type: 'parked',  severity: 'critical' },
  { id: 'E3', time: '09:30:11', camera: 'CAM-04', location: 'Bus Bay',      plate: 'GJ01EF7890', type: 'entry',   severity: 'critical' },
  { id: 'E4', time: '10:42:18', camera: 'CAM-02', location: 'North Gate',   plate: 'MH12AB1234', type: 'transit', severity: 'critical' },
  { id: 'E5', time: '11:05:44', camera: 'CAM-06', location: 'South Gate',   plate: 'RJ14GH2345', type: 'entry',   severity: 'warning'  },
  { id: 'E6', time: '12:18:30', camera: 'CAM-04', location: 'Bus Bay',      plate: 'GJ01EF7890', type: 'exit',    severity: 'critical' },
  { id: 'E7', time: '13:05:44', camera: 'CAM-07', location: 'Inner Road',   plate: 'MH12AB1234', type: 'transit', severity: 'critical' },
  { id: 'E8', time: '14:14:33', camera: 'CAM-02', location: 'Parking Area', plate: 'WB20KL1234', type: 'entry',   severity: 'warning'  },
  { id: 'E9', time: '14:22:10', camera: 'CAM-05', location: 'East Entry',   plate: 'MH12AB1234', type: 'exit',    severity: 'critical' },
];

const SEV_COLORS = {
  critical: { color: '#dc2626', label: 'CRIT' },
  warning:  { color: '#b45309', label: 'WARN' },
};

const TYPE_ICONS = {
  entry:   'login',
  exit:    'logout',
  parked:  'local_parking',
  transit: 'route',
};

export default function VehicleReplayTimeline({ onBack }) {
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);

  return (
    <div className="page">
      <div className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost icon-btn" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.025em', margin: 0 }}>Vehicle Replay Timeline</h1>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>Incident reconstruction from ANPR logs</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ gap: 6 }} onClick={() => setPlaying(p => !p)}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{playing ? 'pause' : 'play_arrow'}</span>
            {playing ? 'Pause' : 'Play Replay'}
          </button>
          <button className="btn btn-ghost" style={{ gap: 6 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
            Export
          </button>
        </div>
      </div>

      <div className="page-inner">
        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <button className="btn btn-ghost" onClick={() => setCursor(c => Math.max(0, c - 1))} style={{ padding: '6px 8px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>skip_previous</span>
            </button>
            <button className="btn btn-primary" onClick={() => setPlaying(p => !p)} style={{ padding: '6px 10px', gap: 4 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{playing ? 'pause' : 'play_arrow'}</span>
            </button>
            <button className="btn btn-ghost" onClick={() => setCursor(c => Math.min(TIMELINE_EVENTS.length - 1, c + 1))} style={{ padding: '6px 8px' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>skip_next</span>
            </button>
            <div style={{ flex: 1 }}>
              <input
                type="range" min={0} max={TIMELINE_EVENTS.length - 1} value={cursor}
                onChange={e => setCursor(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--color-primary)' }}
              />
            </div>
            <span className="mono" style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
              {TIMELINE_EVENTS[cursor]?.time} Â· Event {cursor + 1}/{TIMELINE_EVENTS.length}
            </span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', fontWeight: 700, fontSize: 14 }}>Camera Preview</div>
            <div style={{ height: 200, background: 'var(--color-surface-high, #f1f5f9)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(15,23,42,0.05) 0 1px, transparent 1px 20px), repeating-linear-gradient(0deg, rgba(15,23,42,0.05) 0 1px, transparent 1px 20px)' }} />
              <span className="material-symbols-outlined" style={{ color: 'rgba(15,23,42,0.12)', fontSize: 64 }}>videocam</span>
              <div style={{ position: 'absolute', top: 10, left: 12, color: 'var(--color-text-muted)', fontSize: 10, fontWeight: 700 }}>
                {TIMELINE_EVENTS[cursor]?.camera} Â· {TIMELINE_EVENTS[cursor]?.location}
              </div>
              <div style={{ position: 'absolute', bottom: 10, right: 12, color: '#ef4444', fontSize: 10, fontWeight: 800 }}>
                {TIMELINE_EVENTS[cursor]?.plate}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', fontWeight: 700, fontSize: 14 }}>All Events</div>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {TIMELINE_EVENTS.map((ev, i) => {
                const sev = SEV_COLORS[ev.severity] || SEV_COLORS.warning;
                const isActive = i === cursor;
                return (
                  <div
                    key={ev.id}
                    onClick={() => setCursor(i)}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'center',
                      padding: '9px 16px',
                      cursor: 'pointer',
                      background: isActive ? 'var(--color-primary-bg)' : 'transparent',
                      borderLeft: isActive ? '3px solid var(--color-primary)' : '3px solid transparent',
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16, color: isActive ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>
                      {TYPE_ICONS[ev.type] || 'radio_button_unchecked'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong className="mono" style={{ fontSize: 12 }}>{ev.plate}</strong>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{ev.time}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{ev.location} Â· {ev.camera}</div>
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4, color: sev.color, border: `1px solid ${sev.color}`, flexShrink: 0 }}>
                      {sev.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
