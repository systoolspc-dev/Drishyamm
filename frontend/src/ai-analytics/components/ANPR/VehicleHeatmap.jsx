const HEATMAP_ZONES = [
  { id: 'H1', label: 'Main Gate',     x: 10,  y: 10,  w: 22, h: 18, intensity: 0.95, count: 412 },
  { id: 'H2', label: 'North Entry',   x: 38,  y: 8,   w: 18, h: 15, intensity: 0.65, count: 230 },
  { id: 'H3', label: 'East Wing',     x: 62,  y: 15,  w: 20, h: 16, intensity: 0.42, count: 158 },
  { id: 'H4', label: 'Parking A',     x: 12,  y: 40,  w: 24, h: 20, intensity: 0.88, count: 345 },
  { id: 'H5', label: 'Parking B',     x: 42,  y: 38,  w: 18, h: 18, intensity: 0.55, count: 198 },
  { id: 'H6', label: 'South Gate',    x: 10,  y: 68,  w: 22, h: 16, intensity: 0.72, count: 276 },
  { id: 'H7', label: 'Bus Bay',       x: 38,  y: 65,  w: 20, h: 18, intensity: 0.48, count: 170 },
  { id: 'H8', label: 'Staff Zone',    x: 65,  y: 60,  w: 18, h: 16, intensity: 0.28, count: 88  },
];

function intensityColor(v) {
  if (v >= 0.8) return { bg: 'rgba(220,38,38,0.75)',  border: '#dc2626' };
  if (v >= 0.6) return { bg: 'rgba(217,119,6,0.65)',  border: '#b45309' };
  if (v >= 0.4) return { bg: 'rgba(99,102,241,0.55)', border: '#6366f1' };
  return               { bg: 'rgba(22,163,74,0.45)',  border: '#16a34a' };
}

export default function VehicleHeatmap({ onBack }) {
  const peak = HEATMAP_ZONES.reduce((a, b) => a.count > b.count ? a : b);

  return (
    <div className="page">
      <div className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost icon-btn" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.025em', margin: 0 }}>Vehicle Heatmap</h1>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>Traffic density by zone</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#dc2626', display: 'inline-block' }} /> High
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#b45309', display: 'inline-block', marginLeft: 8 }} /> Medium
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#6366f1', display: 'inline-block', marginLeft: 8 }} /> Low
          <span style={{ width: 10, height: 10, borderRadius: 2, background: '#16a34a', display: 'inline-block', marginLeft: 8 }} /> Sparse
        </div>
      </div>

      <div className="page-inner">
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <p className="section-label">PEAK_ZONE</p>
            <strong style={{ fontSize: 20, fontWeight: 800 }}>{peak.label}</strong>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>{peak.count} vehicles today</p>
          </div>
          <div className="stat-card">
            <p className="section-label">TOTAL_ZONES</p>
            <strong style={{ fontSize: 32, fontWeight: 800 }}>{HEATMAP_ZONES.length}</strong>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>Monitored areas</p>
          </div>
          <div className="stat-card">
            <p className="section-label">HIGH_DENSITY</p>
            <strong style={{ fontSize: 32, fontWeight: 800, color: '#dc2626' }}>{HEATMAP_ZONES.filter(z => z.intensity >= 0.8).length}</strong>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>Zones at high traffic</p>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', fontWeight: 700, fontSize: 14 }}>Campus Vehicle Traffic Map</div>
          <div style={{ background: 'var(--color-surface-high, #f1f5f9)', position: 'relative', width: '100%', paddingBottom: '56%', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(15,23,42,0.04) 0 1px, transparent 1px 40px), repeating-linear-gradient(0deg, rgba(15,23,42,0.04) 0 1px, transparent 1px 40px)' }} />
            {HEATMAP_ZONES.map(zone => {
              const c = intensityColor(zone.intensity);
              return (
                <div
                  key={zone.id}
                  style={{
                    position: 'absolute',
                    left: `${zone.x}%`, top: `${zone.y}%`,
                    width: `${zone.w}%`, height: `${zone.h}%`,
                    background: c.bg,
                    border: `1.5px solid ${c.border}`,
                    borderRadius: 8,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    cursor: 'default',
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', textAlign: 'center', lineHeight: 1.2 }}>{zone.label}</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>{zone.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
