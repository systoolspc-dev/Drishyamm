import { motion } from 'framer-motion';

export default function ThreatEscalation() {
  const stages = [
    { label: 'Suspected',       detail: 'Object detected',  time: '14:18:02', status: 'done'     },
    { label: 'Verified',        detail: 'Weapon confirmed', time: '14:18:05', status: 'done'     },
    { label: 'Armed Individual',detail: 'Person linked',    time: '14:18:12', status: 'active'   },
    { label: 'Active Threat',   detail: 'Imminent danger',  time: '--:--:--', status: 'critical' },
  ];

  return (
    <div className="card weapon-card weapon-escalation-panel">
      <div className="weapon-panel-heading" style={{ minHeight: 44, padding: '10px 16px' }}>
        <h3>Threat Escalation Engine</h3>
      </div>

      <div className="weapon-escalation-list" style={{ gap: 10, padding: '8px 18px 10px 20px' }}>
        {stages.map((stage, index) => (
          <motion.div
            key={stage.label}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.08 }}
            className={`weapon-escalation-step ${stage.status}`}
          >
            <div className="weapon-step-number" style={{ width: 26, height: 26, fontSize: 11 }}>{index + 1}</div>
            <div>
              <strong>{stage.label}</strong>
              <span>{stage.detail}</span>
            </div>
            <small className="mono">{stage.time}</small>
          </motion.div>
        ))}
      </div>

      <div className="weapon-current-stage" style={{ margin: '0 12px 12px', padding: '10px 12px' }}>
        <span>Current Stage</span>
        <strong>Active Threat</strong>
        <small>Immediate response required</small>
        <span className="material-symbols-outlined" style={{ width: 38, height: 38, borderRadius: 10 }}>shield</span>
      </div>
    </div>
  );
}
