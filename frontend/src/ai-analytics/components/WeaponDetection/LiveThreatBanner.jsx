import { motion } from 'framer-motion';

export default function LiveThreatBanner() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="live-alert-banner flashing-critical"
      style={{ marginBottom: 20, border: '2px solid #dc2626' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <motion.div
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ repeat: Infinity, duration: 1.5 }}
          style={{
            background: '#dc2626',
            color: '#fff',
            padding: '8px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="material-symbols-outlined">warning</span>
        </motion.div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="live-alert-kicker" style={{ color: 'var(--color-danger-text)', margin: 0 }}>ðŸš¨ ACTIVE THREAT DETECTED</span>
            <motion.span
              animate={{ opacity: [1, 0, 1] }}
              transition={{ repeat: Infinity, duration: 1 }}
              className="live-dot"
            />
          </div>
          <strong style={{ fontSize: '20px', letterSpacing: '-0.01em' }}>Handgun detected at Counter</strong>
          <p style={{ fontSize: '14px', fontWeight: 600, color: '#991b1b', marginTop: 4 }}>
            COMMAND UNIT DISPATCHED Â· CAM-04 Â· CONFIDENCE 98.0%
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12 }}>
        <button className="btn btn-danger" style={{ fontWeight: 800 }}>ESCALATE</button>
        <button className="btn btn-primary" style={{ fontWeight: 800 }}>RESPOND</button>
      </div>
    </motion.div>
  );
}
