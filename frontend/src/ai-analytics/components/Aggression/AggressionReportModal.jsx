import { motion } from 'framer-motion';
import { severityLabels } from './aggressionIncidentData';

function severityColor(severity) {
  if (severity === 'critical') return '#dc2626';
  if (severity === 'high') return '#b45309';
  if (severity === 'medium') return '#f59e0b';
  return '#2563eb';
}

function reportText(incident) {
  return [
    `AGGRESSION INCIDENT REPORT - ${incident.id}`,
    `${incident.title}`,
    '',
    `When: ${incident.date} ${incident.time} (${incident.duration})`,
    `Where: ${incident.zone} / ${incident.camera}`,
    `Severity: ${severityLabels[incident.severity]} (${incident.confidence}% confidence)`,
    `Activity: ${incident.activity}`,
    `Status: ${incident.status} / ${incident.reviewStage}`,
    '',
    `Summary: ${incident.detail}`,
    '',
    'Evidence included: live frame, aggression overlay, camera timestamp, incident timeline, camera trail, operator note.',
    'Not included: legal guilt, medical diagnosis, motive speculation, unrelated footage, identity attribution, role attribution.',
  ].join('\n');
}

function exportReport(incident, format) {
  const isJson = format === 'json';
  const content = isJson
    ? JSON.stringify({
        incidentId: incident.id,
        title: incident.title,
        type: incident.type,
        date: incident.date,
        time: incident.time,
        duration: incident.duration,
        camera: incident.camera,
        cameras: incident.cameras || incident.camera,
        zone: incident.zone,
        severity: severityLabels[incident.severity],
        confidence: incident.confidence,
        activity: incident.activity,
        status: incident.status,
        reviewStage: incident.reviewStage,
        reportStatus: incident.reportStatus,
        summary: incident.detail,
        evidenceIncluded: ['Live frame', 'Aggression overlay', 'Camera timestamp', 'Incident timeline', 'Camera trail', 'Operator note'],
        notIncluded: ['Legal guilt', 'Medical diagnosis', 'Motive speculation', 'Unrelated footage', 'Identity attribution', 'Role attribution'],
      }, null, 2)
    : reportText(incident);

  const blob = new Blob([content], { type: isJson ? 'application/json' : 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${incident.id}-aggression-report.${isJson ? 'json' : 'txt'}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function Fact({ label, value, accent }) {
  return (
    <span>
      <strong>{label}</strong>
      <em style={accent ? { color: accent } : undefined}>{value}</em>
    </span>
  );
}

export default function AggressionReportModal({ incident, onClose, onSubmit }) {
  if (!incident) return null;

  const color = severityColor(incident.severity);
  const evidence = [
    ['Live Frame', `${incident.camera} at ${incident.time}`],
    ['Aggression Overlay', 'Activity area highlighted'],
    ['Timeline', 'Incident chain linked'],
    ['Camera Trail', 'Camera sequence linked'],
  ];

  return (
    <div className="aggression-report-overlay" onClick={onClose}>
      <motion.div
        className="aggression-report-modal"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={event => event.stopPropagation()}
      >
        <div className="aggression-report-modal-header">
          <div>
            <span>Incident Report</span>
            <h3>{incident.id}</h3>
            <p>{incident.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close report">x</button>
        </div>

        <div className="aggression-report-summary">
          <Fact label="Severity" value={severityLabels[incident.severity]} accent={color} />
          <Fact label="Confidence" value={`${incident.confidence}%`} />
          <Fact label="Status" value={incident.status} />
          <Fact label="Report" value={incident.reportStatus} />
        </div>

        <section className="card" style={{ padding: 14, marginTop: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {[
              ['When', `${incident.date} ${incident.time}`],
              ['Duration', incident.duration],
              ['Camera', incident.camera],
              ['Zone', incident.zone],
              ['Activity', incident.activity],
              ['Review', incident.reviewStage],
            ].map(([label, value]) => (
              <div key={label} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 10px', background: '#fff' }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
                <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: '#0b1c30', lineHeight: 1.35 }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12, fontSize: 12, color: '#475569', lineHeight: 1.55 }}>
            <strong style={{ color: '#0b1c30' }}>Summary:</strong> {incident.detail}
          </div>
        </section>

        <section className="card" style={{ padding: 14, marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1c30', marginBottom: 10 }}>Evidence Package</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
            {evidence.map(([label, value]) => (
              <div key={label} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 10px', background: '#f8fafc' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#0b1c30' }}>{label}</div>
                <div style={{ marginTop: 2, fontSize: 11, color: '#64748b' }}>{value}</div>
              </div>
            ))}
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
            Excludes legal guilt, medical diagnosis, motive speculation, unrelated footage, identity attribution, and role attribution.
          </p>
        </section>

        <pre className="aggression-report-preview" style={{ marginTop: 12 }}>{reportText(incident)}</pre>

        <div className="aggression-report-modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          <button type="button" onClick={() => exportReport(incident, 'txt')}>
            <span className="material-symbols-outlined">download</span>
            TXT
          </button>
          <button type="button" onClick={() => exportReport(incident, 'json')}>
            <span className="material-symbols-outlined">data_object</span>
            JSON
          </button>
          <button type="button" className="primary" onClick={() => onSubmit?.(incident)} disabled={incident.reportStatus === 'Submitted'}>
            Submit Report
          </button>
        </div>
      </motion.div>
    </div>
  );
}
