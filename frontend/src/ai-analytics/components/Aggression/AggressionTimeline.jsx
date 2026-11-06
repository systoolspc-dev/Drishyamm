import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { aggressionIncidents, severityLabels } from './aggressionIncidentData';
import AggressionReportModal from './AggressionReportModal';

const SEV_BG = {
  critical: '#fef2f2',
  high: '#EAF0F6',
  medium: '#fffbeb',
  low: '#eff6ff',
  info: '#eff6ff',
  resolved: '#f0fdf4',
};

const SEV_COLOR = {
  critical: '#dc2626',
  high: '#b45309',
  medium: '#f59e0b',
  low: '#2563eb',
  info: '#3b82f6',
  resolved: '#22c55e',
};

function addSeconds(time, seconds) {
  const [hh, mm, ss] = time.split(':').map(Number);
  const date = new Date(2026, 5, 10, hh, mm, ss + seconds);
  return date.toTimeString().slice(0, 8);
}

function cameraCount(incident) {
  return incident.cameras.split(',').map(item => item.trim()).filter(Boolean).length;
}

function buildIncidentEvents(incident) {
  const color = SEV_COLOR[incident.severity] || SEV_COLOR.info;
  return [
    {
      time: addSeconds(incident.time, -51),
      icon: 'visibility',
      label: 'Pre-incident motion flagged',
      detail: `${incident.camera} detected unusual movement near ${incident.zone}.`,
      severity: incident.severity === 'critical' ? 'high' : 'medium',
      color: incident.severity === 'critical' ? SEV_COLOR.high : SEV_COLOR.medium,
    },
    {
      time: incident.time,
      icon: 'crisis_alert',
      label: `${incident.type} detected`,
      detail: `${incident.title}. ${incident.detail}`,
      severity: incident.severity,
      color,
      highlight: true,
    },
    {
      time: addSeconds(incident.time, 19),
      icon: 'groups',
      label: 'Activity area confirmed',
      detail: `${incident.activity} counted in the active detection area.`,
      severity: 'info',
      color: SEV_COLOR.info,
    },
    {
      time: addSeconds(incident.time, 44),
      icon: 'videocam',
      label: 'Live feed locked',
      detail: `${incident.camera} promoted for operator review with ${incident.confidence}% confidence.`,
      severity: 'info',
      color: SEV_COLOR.info,
    },
    {
      time: addSeconds(incident.time, 86),
      icon: 'route',
      label: 'Camera trail available',
      detail: 'Camera-level evidence trail is available for this aggression event.',
      severity: 'medium',
      color: SEV_COLOR.medium,
    },
    {
      time: addSeconds(incident.time, 132),
      icon: incident.status === 'Resolved' ? 'verified' : 'assignment',
      label: incident.status === 'Resolved' ? 'Incident resolved' : incident.reviewStage,
      detail: `Report status: ${incident.reportStatus}. Current incident state: ${incident.status}.`,
      severity: incident.status === 'Resolved' ? 'resolved' : 'info',
      color: incident.status === 'Resolved' ? SEV_COLOR.resolved : SEV_COLOR.info,
    },
  ];
}

export default function AggressionTimeline() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [reportTarget, setReportTarget] = useState(null);
  const [reportUpdates, setReportUpdates] = useState({});
  const incidentId = searchParams.get('incident');
  const incident = useMemo(() => {
    const found = aggressionIncidents.find(item => item.id === incidentId) || aggressionIncidents[0];
    return { ...found, ...(reportUpdates[found.id] || {}) };
  }, [incidentId, reportUpdates]);
  const events = useMemo(() => buildIncidentEvents(incident), [incident]);

  const summary = [
    { label: 'Incident ID', value: incident.id },
    { label: 'Duration', value: incident.duration },
    { label: 'Total Events', value: String(events.length) },
    { label: 'Cameras Used', value: String(cameraCount(incident)) },
    { label: 'Area Activity', value: incident.activity },
    { label: 'Status', value: incident.status, accent: incident.status === 'Resolved' ? '#22c55e' : SEV_COLOR[incident.severity] },
  ];

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: '#0b1c30' }}>Incident Timeline</h2>
          <p style={{ fontSize: 12, color: '#64748b' }}>
            Chronological event chain for {incident.id} detected on {incident.camera} at {incident.time}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => navigate('/ai-analytics/aggression/live')}>
            <span className="material-symbols-outlined icon-sm">videocam</span>
            Live Alerts
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}>
            <span className="material-symbols-outlined icon-sm">download</span>
            Export
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 18, alignItems: 'start' }}>
        <div className="card" style={{ padding: '20px 24px' }}>
          <div style={{ position: 'relative', paddingLeft: 32 }}>
            <div style={{ position: 'absolute', left: 11, top: 8, bottom: 8, width: 2, background: '#e2e8f0', borderRadius: 1 }} />
            {events.map((ev, i) => (
              <motion.div
                key={`${incident.id}-${ev.time}-${ev.label}`}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.06 }}
                style={{
                  position: 'relative',
                  marginBottom: 20,
                  background: ev.highlight ? SEV_BG[incident.severity] : SEV_BG[ev.severity],
                  border: ev.highlight ? `1px solid ${ev.color}44` : '1px solid #f1f5f9',
                  borderRadius: 10,
                  padding: '12px 14px',
                  borderLeft: `3px solid ${ev.color}`,
                }}
              >
                <div style={{
                  position: 'absolute',
                  left: -36,
                  top: 14,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: ev.color,
                  border: '2px solid #fff',
                  boxShadow: '0 0 0 2px #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 9, color: '#fff' }}>{ev.icon}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: ev.color, fontWeight: 700 }}>{ev.time}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#0b1c30' }}>{ev.label}</span>
                </div>
                <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>{ev.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0b1c30', marginBottom: 12 }}>Incident Summary</div>
            {summary.map(item => (
              <div key={item.label} style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                padding: '7px 0',
                borderBottom: '1px solid #f1f5f9',
                fontSize: 12,
              }}>
                <span style={{ color: '#64748b' }}>{item.label}</span>
                <strong style={{ color: item.accent || '#0b1c30', textAlign: 'right' }}>{item.value}</strong>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0b1c30', marginBottom: 10 }}>Incident Context</div>
            <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
              <div><strong style={{ color: '#0b1c30' }}>Type:</strong> <span style={{ color: '#64748b' }}>{incident.type}</span></div>
              <div><strong style={{ color: '#0b1c30' }}>Zone:</strong> <span style={{ color: '#64748b' }}>{incident.zone}</span></div>
              <div><strong style={{ color: '#0b1c30' }}>Severity:</strong> <span style={{ color: SEV_COLOR[incident.severity], fontWeight: 700 }}>{severityLabels[incident.severity]}</span></div>
              <div><strong style={{ color: '#0b1c30' }}>Confidence:</strong> <span style={{ color: '#64748b' }}>{incident.confidence}%</span></div>
            </div>
          </div>

          <div className="card" style={{ padding: '16px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0b1c30', marginBottom: 10 }}>Quick Actions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 12, justifyContent: 'flex-start' }} onClick={() => navigate(`/ai-analytics/aggression/reid?incident=${incident.id}`)}>
                <span className="material-symbols-outlined icon-sm">route</span>
                Camera Trail
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, justifyContent: 'flex-start' }} onClick={() => setReportTarget(incident)}>
                <span className="material-symbols-outlined icon-sm">summarize</span>
                Create Report
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, justifyContent: 'flex-start' }} onClick={() => navigate('/ai-analytics/aggression/incidents')}>
                <span className="material-symbols-outlined icon-sm">list_alt</span>
                All Incidents
              </button>
            </div>
          </div>
        </div>
      </div>

      <AggressionReportModal
        incident={reportTarget}
        onClose={() => setReportTarget(null)}
        onSubmit={(target) => {
          setReportUpdates(prev => ({
            ...prev,
            [target.id]: { reportStatus: 'Submitted', reviewStage: 'Acknowledged' },
          }));
          setReportTarget(current => current?.id === target.id ? { ...current, reportStatus: 'Submitted', reviewStage: 'Acknowledged' } : current);
        }}
      />
    </div>
  );
}
