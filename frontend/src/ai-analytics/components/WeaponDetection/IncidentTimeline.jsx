import { motion } from 'framer-motion';

export default function IncidentTimeline() {
  const events = [
    { time: '14:20:31', title: 'Weapon Detected', detail: 'Rifle detected at Main Gate (CAM-04)', status: 'critical' },
    { time: '14:18:12', title: 'Armed Individual', detail: 'Person linked with weapon', status: 'warning' },
    { time: '14:18:05', title: 'Weapon Verified', detail: 'Weapon type confirmed', status: 'success' },
    { time: '14:18:02', title: 'Object Detected', detail: 'Suspicious object detected', status: 'success' },
  ];

  return (
    <div className="card weapon-card weapon-timeline-panel">
      <div className="weapon-panel-heading">
        <h3>Incident Timeline</h3>
      </div>

      <div className="weapon-timeline-list">
        {events.map((event, index) => (
          <motion.div
            key={`${event.time}-${event.title}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08 }}
            className={`weapon-timeline-item ${event.status}`}
          >
            <span className="mono">{event.time}</span>
            <i />
            <div>
              <strong>{event.title}</strong>
              <small>{event.detail}</small>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
