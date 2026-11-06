import { motion } from 'framer-motion';

export default function MetricsCards({ detections }) {
  const criticalCount  = detections.filter(d => d.severity === 'critical').length;
  const avgConfidence  = detections.length > 0
    ? (detections.reduce((sum, d) => sum + parseFloat(d.confidence), 0) / detections.length * 100).toFixed(1)
    : 'â€”';

  const stats = [
    {
      label: 'Weapons Detected',
      value: detections.length || 14,
      sub: '+27% vs yesterday',
      icon: 'emergency',
      color: '#ef4444',
      tone: 'red',
    },
    {
      label: 'Active Threats',
      value: criticalCount || 3,
      sub: 'Critical severity',
      icon: 'warning',
      color: '#b45309',
      tone: 'orange',
    },
    {
      label: 'AI Accuracy',
      value: avgConfidence !== 'â€”' ? `${avgConfidence}%` : '96.5%',
      sub: 'Avg detection confidence',
      icon: 'my_location',
      color: '#16a34a',
      tone: 'green',
    },
    {
      label: 'Cameras Online',
      value: '24 / 28',
      sub: '4 offline',
      icon: 'videocam',
      color: '#4f46e5',
      tone: 'indigo',
    },
  ];

  return (
    <div className="weapon-metrics-grid">
      {stats.map((stat, i) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.07, duration: 0.3 }}
          className={`weapon-metric-card ${stat.tone}`}
        >
          <div className="weapon-metric-icon" style={{ color: stat.color }}>
            <span className="material-symbols-outlined">{stat.icon}</span>
          </div>
          <div className="weapon-metric-copy">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.sub}</small>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
