import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { aggressionIncidents, aggressionMetrics, severityLabels } from './aggressionIncidentData';
import AggressionReportModal from './AggressionReportModal';

const SEV = {
  critical: { bg: '#fef2f2', border: '#fecaca', color: '#dc2626', label: 'CRITICAL' },
  high:     { bg: '#EAF0F6', border: '#CBD5E1', color: 'var(--color-text)', label: 'HIGH' },
  medium:   { bg: '#fffbeb', border: '#fde68a', color: '#b45309', label: 'MEDIUM' },
  low:      { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d', label: 'LOW' },
};

const STATUS_COLOR = { Active: '#dc2626', Acknowledged: '#b45309', Resolved: '#22c55e' };

const DATE_OPTIONS = ['All Dates', ...Array.from(new Set(aggressionIncidents.map(item => item.date)))];
const TYPE_OPTIONS = ['All Types', ...Array.from(new Set(aggressionIncidents.map(item => item.type)))];

export default function AggressionIncidents() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialDate = searchParams.get('date') || 'All Dates';
  const initialStatus = searchParams.get('status') === 'active' ? 'Active' : 'All Status';

  const [expanded, setExpanded] = useState(null);
  const [showMetrics, setShowMetrics] = useState(true);
  const [severity, setSeverity] = useState('All Severities');
  const [date, setDate] = useState(initialDate);
  const [status, setStatus] = useState(initialStatus);
  const [type, setType] = useState('All Types');
  const [query, setQuery] = useState('');
  const [reportTarget, setReportTarget] = useState(null);
  const [reportUpdates, setReportUpdates] = useState({});

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return aggressionIncidents.map(inc => ({ ...inc, ...(reportUpdates[inc.id] || {}) })).filter(inc => {
      const matchesDate = date === 'All Dates' || inc.date === date;
      const matchesSeverity = severity === 'All Severities' || severity.toLowerCase() === inc.severity;
      const matchesStatus = status === 'All Status' || inc.status === status;
      const matchesType = type === 'All Types' || inc.type === type;
      const matchesQuery = !q || [inc.id, inc.title, inc.zone, inc.camera, inc.type].join(' ').toLowerCase().includes(q);
      return matchesDate && matchesSeverity && matchesStatus && matchesType && matchesQuery;
    });
  }, [date, severity, status, type, query, reportUpdates]);

  const go = (path, inc) => navigate(`${path}?incident=${encodeURIComponent(inc.id)}&camera=${encodeURIComponent(inc.camera)}`);
  const submitReport = incident => {
    setReportUpdates(prev => ({
      ...prev,
      [incident.id]: { reportStatus: 'Submitted', reviewStage: 'Acknowledged' },
    }));
    setReportTarget(current => current?.id === incident.id ? { ...current, reportStatus: 'Submitted', reviewStage: 'Acknowledged' } : current);
  };

  return (
    <main className="aggression-incidents-page">
      <header className="aggression-incidents-header">
        <div>
          <h2>Incidents</h2>
          <p>Filterable case register for active, acknowledged and resolved aggression alerts</p>
        </div>
        <div className="aggression-incidents-filters">
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search incident, camera, zone..." />
          <select className="select" value={date} onChange={event => setDate(event.target.value)}>
            {DATE_OPTIONS.map(item => <option key={item}>{item}</option>)}
          </select>
          <select className="select" value={severity} onChange={event => setSeverity(event.target.value)}>
            {['All Severities', 'Critical', 'High', 'Medium', 'Low'].map(item => <option key={item}>{item}</option>)}
          </select>
          <select className="select" value={status} onChange={event => setStatus(event.target.value)}>
            {['All Status', 'Active', 'Acknowledged', 'Resolved'].map(item => <option key={item}>{item}</option>)}
          </select>
          <select className="select" value={type} onChange={event => setType(event.target.value)}>
            {TYPE_OPTIONS.map(item => <option key={item}>{item}</option>)}
          </select>
        </div>
      </header>

      <section className={`aggression-live-metrics-shell ${showMetrics ? '' : 'collapsed'}`}>
        <div className="aggression-live-metrics-header">
          <div>
            <h3>Incident Metrics</h3>
            <span>Operational summary for filtered aggression incidents</span>
          </div>
          <label className="aggression-metrics-toggle">
            <input type="checkbox" checked={showMetrics} onChange={event => setShowMetrics(event.target.checked)} />
            <span aria-hidden="true" />
            <strong>{showMetrics ? 'Hide metrics' : 'Show metrics'}</strong>
          </label>
        </div>

        {showMetrics && (
          <div className="aggression-live-metrics-grid">
            {aggressionMetrics.map(metric => (
              <article key={metric.label} className={`aggression-live-metric-card ${metric.tone}`}>
                <span className="aggression-live-metric-icon">
                  <span className="material-symbols-outlined">{metric.icon}</span>
                </span>
                <span className="aggression-live-metric-copy">
                  <small>{metric.label}</small>
                  <strong>{metric.value}</strong>
                  <em>{metric.sub}</em>
                </span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card aggression-incidents-list">
        <div className="aggression-incidents-list-head">
          <div>
            <h3>Incident List</h3>
            <span>{rows.length} incident{rows.length === 1 ? '' : 's'} match current filters</span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/ai-analytics/aggression/live')}>
            <span className="material-symbols-outlined icon-sm">videocam</span>
            Live Feed
          </button>
        </div>

        <div className="aggression-incidents-scroll">
          {rows.map((inc, index) => {
            const s = SEV[inc.severity];
            const isOpen = expanded === inc.id;
            return (
              <motion.article
                key={inc.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className={`aggression-incident-row ${inc.severity}`}
              >
                <button type="button" className="aggression-incident-main" onClick={() => setExpanded(isOpen ? null : inc.id)}>
                  <span className="aggression-incident-sev" style={{ background: s.bg, color: s.color, borderColor: s.border }}>{s.label}</span>
                  <span className="aggression-incident-copy">
                    <span className="aggression-alert-titleline">
                      <strong>{inc.title}</strong>
                      <i>{inc.type}</i>
                    </span>
                    <small>{inc.detail}</small>
                    <em>{inc.id} - {inc.date} - {inc.time} - {inc.duration}</em>
                  </span>
                  <span className="aggression-alert-status">
                    <strong style={{ color: STATUS_COLOR[inc.status] || '#64748b' }}>{inc.status}</strong>
                    <small>{inc.reviewStage}</small>
                  </span>
                  <span className="material-symbols-outlined" style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }}>expand_more</span>
                </button>

                <div className="aggression-alert-params">
                  <span><strong>Camera</strong>{inc.cameras}</span>
                  <span><strong>Zone</strong>{inc.zone}</span>
                  <span><strong>Severity</strong>{severityLabels[inc.severity]}</span>
                  <span><strong>Confidence</strong>{inc.confidence}%</span>
                  <span><strong>Activity</strong>{inc.activity}</span>
                  <span><strong>Report</strong>{inc.reportStatus}</span>
                </div>

                {isOpen && (
                  <div className="aggression-incident-detail">
                    <div className="aggression-incident-facts" style={{ gridTemplateColumns: 'repeat(4, minmax(140px, 1fr))' }}>
                      {[
                        ['Primary Camera', inc.camera],
                        ['Review', inc.reviewStage],
                        ['Status', inc.status],
                        ['Report', inc.reportStatus],
                      ].map(([label, value]) => (
                        <span key={label}><strong>{label}</strong>{value}</span>
                      ))}
                    </div>
                    <p style={{ maxWidth: 760 }}>{inc.detail}</p>
                    <div className="aggression-incident-actions">
                      <button type="button" className="btn btn-primary" onClick={() => go('/ai-analytics/aggression/live', inc)}><span className="material-symbols-outlined icon-sm">videocam</span>View Live</button>
                      <button type="button" className="btn btn-ghost" onClick={() => go('/ai-analytics/aggression/timeline', inc)}><span className="material-symbols-outlined icon-sm">timeline</span>Timeline</button>
                      <button type="button" className="btn btn-ghost" onClick={() => go('/ai-analytics/aggression/reid', inc)}><span className="material-symbols-outlined icon-sm">route</span>Camera Trail</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setReportTarget(inc)}><span className="material-symbols-outlined icon-sm">summarize</span>Create Report</button>
                    </div>
                  </div>
                )}
              </motion.article>
            );
          })}

          {rows.length === 0 && (
            <div className="aggression-incidents-empty">
              <span className="material-symbols-outlined">search_off</span>
              No incidents match the selected filters
            </div>
          )}
        </div>
      </section>

      <AggressionReportModal
        incident={reportTarget}
        onClose={() => setReportTarget(null)}
        onSubmit={submitReport}
      />
    </main>
  );
}
