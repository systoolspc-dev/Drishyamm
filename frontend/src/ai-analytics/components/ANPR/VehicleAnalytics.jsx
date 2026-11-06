import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';

const hourlyData = [
  { hour: '06', detections: 12, violations: 1 },
  { hour: '07', detections: 38, violations: 3 },
  { hour: '08', detections: 95, violations: 8 },
  { hour: '09', detections: 142, violations: 12 },
  { hour: '10', detections: 120, violations: 9 },
  { hour: '11', detections: 98, violations: 6 },
  { hour: '12', detections: 115, violations: 7 },
  { hour: '13', detections: 130, violations: 11 },
  { hour: '14', detections: 160, violations: 14 },
  { hour: '15', detections: 145, violations: 10 },
  { hour: '16', detections: 188, violations: 16 },
  { hour: '17', detections: 210, violations: 19 },
];

const typeData = [
  { type: 'Sedan',    count: 480 },
  { type: 'SUV',      count: 320 },
  { type: 'Bike',     count: 415 },
  { type: 'Truck',    count: 180 },
  { type: 'Van',      count: 145 },
  { type: 'Hatchback', count: 302 },
];

export default function VehicleAnalytics({ onBack }) {
  return (
    <div className="page">
      <div className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost icon-btn" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.025em', margin: 0 }}>Vehicle Analytics</h1>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>Traffic patterns & detection insights</p>
          </div>
        </div>
      </div>

      <div className="page-inner">
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
          {[
            { label: 'Today\'s Detections', value: '1,842', sub: '+12% vs yesterday', color: 'var(--color-text)' },
            { label: 'Peak Hour',           value: '17:00',  sub: '210 vehicles',      color: '#6366f1' },
            { label: 'Avg Speed',           value: '34 km/h', sub: 'All zones',        color: '#16a34a' },
            { label: 'Violations',          value: '116',    sub: 'Today total',       color: '#dc2626' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <p className="section-label">{s.label.toUpperCase().replace(/ |'/g, '_')}</p>
              <strong style={{ fontSize: 28, fontWeight: 800, color: s.color }}>{s.value}</strong>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 18, marginBottom: 18 }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Hourly Traffic Volume</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourlyData} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="detections" fill="#F7983A" radius={[3, 3, 0, 0]} name="Detections" />
                <Bar dataKey="violations" fill="#dc2626" radius={[3, 3, 0, 0]} name="Violations" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>By Vehicle Type</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {typeData.map(t => {
                const max = Math.max(...typeData.map(x => x.count));
                const pct = Math.round((t.count / max) * 100);
                return (
                  <div key={t.type}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ fontWeight: 600 }}>{t.type}</span>
                      <span className="mono" style={{ color: 'var(--color-text-secondary)' }}>{t.count}</span>
                    </div>
                    <div style={{ height: 5, background: 'var(--color-border)', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--color-primary)', borderRadius: 99 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Violation Trend (Today)</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={hourlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Line type="monotone" dataKey="violations" stroke="#dc2626" strokeWidth={2} dot={false} name="Violations" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
