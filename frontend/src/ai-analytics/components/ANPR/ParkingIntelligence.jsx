import { parkingZones } from '../../data/ANPR';

const STATUS_COLORS = {
  full:   { color: '#dc2626', bg: '#fef2f2', label: 'Full'   },
  high:   { color: '#b45309', bg: '#fffbeb', label: 'High'   },
  normal: { color: '#16a34a', bg: '#f0fdf4', label: 'Normal' },
};

export default function ParkingIntelligence({ onBack }) {
  const totalCapacity = parkingZones.reduce((s, z) => s + z.capacity, 0);
  const totalOccupied = parkingZones.reduce((s, z) => s + z.occupied, 0);
  const fullZones = parkingZones.filter(z => z.status === 'full').length;
  const availableSpots = totalCapacity - totalOccupied;

  return (
    <div className="page">
      <div className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost icon-btn" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.025em', margin: 0 }}>Parking Intelligence</h1>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>Real-time parking zone monitoring</p>
          </div>
        </div>
      </div>

      <div className="page-inner">
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
          {[
            { label: 'Total Capacity', value: totalCapacity,   sub: 'All zones',      color: 'inherit' },
            { label: 'Occupied',       value: totalOccupied,   sub: 'Vehicles parked', color: '#b45309' },
            { label: 'Available',      value: availableSpots,  sub: 'Free spots',     color: '#16a34a' },
            { label: 'Full Zones',     value: fullZones,       sub: 'At capacity',    color: '#dc2626' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <p className="section-label">{s.label.toUpperCase().replace(/ /g, '_')}</p>
              <strong style={{ fontSize: 32, fontWeight: 800, color: s.color }}>{s.value}</strong>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 18 }}>
          {parkingZones.map(zone => {
            const pct = Math.min(100, Math.round((zone.occupied / zone.capacity) * 100));
            const s = STATUS_COLORS[zone.status] || STATUS_COLORS.normal;
            const available = zone.capacity - zone.occupied;
            return (
              <div key={zone.id} className="card" style={{ overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{zone.name}</h3>
                    <p className="mono" style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '2px 0 0' }}>{zone.camera}</p>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 99, color: s.color, background: s.bg }}>{s.label}</span>
                </div>

                <div style={{ height: 80, background: 'var(--color-surface-high, #f1f5f9)', borderRadius: 8, position: 'relative', overflow: 'hidden', marginBottom: 14 }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(90deg, rgba(15,23,42,0.05) 0 1px, transparent 1px 30px), repeating-linear-gradient(0deg, rgba(15,23,42,0.05) 0 1px, transparent 1px 20px)' }} />
                  <div style={{ position: 'absolute', bottom: 8, left: 12, color: 'var(--color-text-secondary)', fontSize: 10, fontWeight: 700 }}>
                    {pct}% UTILIZED
                  </div>
                  <div style={{ position: 'absolute', bottom: 8, right: 12, color: 'var(--color-text-muted)', fontSize: 10 }}>
                    {zone.camera}
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  <span>Occupied <strong className="mono" style={{ color: s.color }}>{zone.occupied}</strong></span>
                  <span>Available <strong className="mono" style={{ color: '#16a34a' }}>{available}</strong></span>
                  <span>Capacity <strong className="mono">{zone.capacity}</strong></span>
                </div>

                <div style={{ height: 6, background: 'var(--color-border)', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: s.color, borderRadius: 99, transition: 'width 0.5s' }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
