import { useState } from 'react';
import { trafficViolations } from '../../data/ANPR';

const STATUS_STYLES = {
  pending: { color: '#b45309', bg: '#fffbeb', label: 'Pending' },
  issued:  { color: '#6366f1', bg: '#eef2ff', label: 'Issued'  },
  paid:    { color: '#16a34a', bg: '#f0fdf4', label: 'Paid'    },
};

export default function TrafficEnforcement({ onBack }) {
  const [filter, setFilter] = useState('all');

  const rows = trafficViolations.filter(v => filter === 'all' || v.status === filter);
  const totalFines = trafficViolations.reduce((s, v) => s + v.fine, 0);
  const pendingCount = trafficViolations.filter(v => v.status === 'pending').length;
  const issuedCount = trafficViolations.filter(v => v.status === 'issued').length;

  return (
    <div className="page">
      <div className="page-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost icon-btn" onClick={onBack}>
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, letterSpacing: '-0.025em', margin: 0 }}>Traffic Enforcement</h1>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>AI-detected violations & challan management</p>
          </div>
        </div>
        <button className="btn btn-primary" style={{ gap: 6 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
          Export Report
        </button>
      </div>

      <div className="page-inner">
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
          {[
            { label: 'Total Violations', value: trafficViolations.length, sub: 'Today',         color: 'inherit' },
            { label: 'Pending',          value: pendingCount,              sub: 'Awaiting issue', color: '#b45309' },
            { label: 'Issued',           value: issuedCount,               sub: 'Challans sent',  color: '#6366f1' },
            { label: 'Total Fines',      value: `â‚¹${totalFines.toLocaleString()}`, sub: 'Est. recovery', color: '#16a34a' },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <p className="section-label">{s.label.toUpperCase().replace(/ /g, '_')}</p>
              <strong style={{ fontSize: 28, fontWeight: 800, color: s.color }}>{s.value}</strong>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>{s.sub}</p>
            </div>
          ))}
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="weapon-panel-title-row" style={{ marginBottom: 16 }}>
            <h3>Violation Log</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {['all', 'pending', 'issued', 'paid'].map(f => (
                <button key={f} onClick={() => setFilter(f)} className={`btn ${filter === f ? 'btn-primary' : 'btn-ghost'}`} style={{ padding: '4px 12px', fontSize: 12, textTransform: 'capitalize' }}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Plate</th>
                <th>Violation</th>
                <th>Camera</th>
                <th>Time</th>
                <th>Fine</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(v => {
                const s = STATUS_STYLES[v.status] || STATUS_STYLES.pending;
                return (
                  <tr key={v.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{v.id}</td>
                    <td><strong className="mono">{v.plate}</strong></td>
                    <td style={{ fontSize: 13 }}>{v.type}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{v.camera}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{v.timestamp.split(' ')[1]}</td>
                    <td><strong className="mono" style={{ color: '#16a34a' }}>â‚¹{v.fine.toLocaleString()}</strong></td>
                    <td>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 99, color: s.color, background: s.bg }}>{s.label}</span>
                    </td>
                    <td>
                      <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>Issue</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
