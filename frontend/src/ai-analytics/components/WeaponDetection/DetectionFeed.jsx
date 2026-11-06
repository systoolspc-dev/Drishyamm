import { motion, AnimatePresence } from 'framer-motion';

const SEVERITY_STYLES = {
  critical: { label: 'Critical', color: '#dc2626', bg: '#fef2f2' },
  warning:  { label: 'Warning',  color: '#b45309', bg: '#fffbeb' },
  medium:   { label: 'Medium',   color: '#6366f1', bg: '#eef2ff' },
};

function SeverityBadge({ severity }) {
  const s = SEVERITY_STYLES[severity] || SEVERITY_STYLES.medium;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px',
      borderRadius: 99,
      fontSize: 11,
      fontWeight: 700,
      color: s.color,
      background: s.bg,
    }}>
      {s.label}
    </span>
  );
}

const FALLBACK = [
  { id: 'demo-1', metadata: { weaponType: 'Rifle' },  confidence: 0.94, location: 'Main Gate',    camera_id: 'CAM-04', created_at: '2026-05-05 14:20:31', severity: 'critical' },
  { id: 'demo-2', metadata: { weaponType: 'Pistol' }, confidence: 0.91, location: 'Parking Area', camera_id: 'CAM-07', created_at: '2026-05-05 14:19:45', severity: 'critical' },
  { id: 'demo-3', metadata: { weaponType: 'Knife' },  confidence: 0.88, location: 'North Entry',  camera_id: 'CAM-01', created_at: '2026-05-05 14:18:22', severity: 'warning' },
  { id: 'demo-4', metadata: { weaponType: 'Rifle' },  confidence: 0.87, location: 'Bus Bay',      camera_id: 'CAM-03', created_at: '2026-05-05 14:16:11', severity: 'warning' },
  { id: 'demo-5', metadata: { weaponType: 'Pistol' }, confidence: 0.72, location: 'Back Gate',    camera_id: 'CAM-02', created_at: '2026-05-05 14:14:33', severity: 'medium' },
];

export default function DetectionFeed({ detections, newDetectionId, onSelect }) {
  const rows = detections.length ? detections.slice(0, 8) : FALLBACK;

  return (
    <div className="card weapon-card weapon-detections-panel">
      <div className="weapon-panel-title-row">
        <h3>Detection Log</h3>
        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          {rows.length} entries
        </span>
      </div>
      <div className="table-wrapper">
        <table className="data-table weapon-detection-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Camera</th>
              <th>Weapon</th>
              <th>Location</th>
              <th>Conf.</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {rows.map((item) => (
                <motion.tr
                  key={item.id}
                  initial={{ opacity: 0 }}
                  animate={{
                    opacity: 1,
                    backgroundColor: newDetectionId === item.id
                      ? 'rgba(220, 38, 38, 0.06)'
                      : 'transparent',
                  }}
                  transition={{ duration: 0.3 }}
                  onClick={() => onSelect(item)}
                  style={{ cursor: 'pointer' }}
                >
                  <td className="mono" style={{ fontSize: 12 }}>
                    {new Date(String(item.created_at).replace(' ', 'T')).toLocaleTimeString([], { hour12: false })}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{item.camera_id}</td>
                  <td style={{ fontWeight: 600 }}>{item.metadata?.weaponType || 'Unknown'}</td>
                  <td style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{item.location}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>
                    {(parseFloat(item.confidence) * 100).toFixed(0)}%
                  </td>
                  <td><SeverityBadge severity={item.severity} /></td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
    </div>
  );
}
