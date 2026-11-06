import { motion } from 'framer-motion';

const THREAT_SCORE = 92;

function ThreatScoreBar({ score }) {
  const color = score >= 80 ? '#ef4444' : score >= 60 ? '#b45309' : '#f59e0b';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600 }}>THREAT SCORE</span>
        <span style={{ fontSize: 11, fontWeight: 900, color, fontFamily: 'monospace' }}>{score}/100</span>
      </div>
      <div style={{ height: 5, background: 'rgba(0,0,0,0.06)', borderRadius: 99, overflow: 'hidden' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{
            height: '100%', borderRadius: 99,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
            boxShadow: `0 0 6px ${color}66`,
          }}
        />
      </div>
    </div>
  );
}

export default function SuspectIntelligence() {
  return (
    <div className="card weapon-card weapon-suspect-panel">
      {/* Header */}
      <div className="weapon-panel-heading" style={{ minHeight: 44, padding: '10px 16px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Suspect Intelligence
          <span style={{
            fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 99,
            background: 'rgba(239,68,68,0.12)', color: '#ef4444',
            border: '1px solid rgba(239,68,68,0.25)', letterSpacing: '.06em',
          }}>LINKED</span>
        </h3>
      </div>

      {/* Portrait â€” CCTV image, reduced height */}
      <div className="weapon-suspect-portrait" style={{ padding: '0 12px' }}>
        <div
          className="weapon-suspect-photo"
          style={{
            position: 'relative', overflow: 'hidden', borderRadius: 8,
            minHeight: 0, aspectRatio: '16/9',
          }}
        >
          {/* CCTV image */}
          <img
            src="/weapon-demo.jpg"
            alt="Suspect capture"
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              objectFit: 'cover',
              objectPosition: 'center top',
              display: 'block',
            }}
          />

          {/* Scanlines */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
            background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.07) 2px, rgba(0,0,0,.07) 4px)',
          }} />

          {/* Vignette */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
            boxShadow: 'inset 0 0 30px rgba(0,0,0,0.4)',
          }} />

          {/* Detection bounding box */}
          <div style={{
            position: 'absolute',
            top: '10%', left: '30%',
            width: '38%', height: '75%',
            zIndex: 4, pointerEvents: 'none',
          }}>
            <motion.div
              animate={{ opacity: [1, 0.55, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              style={{
                width: '100%', height: '100%',
                border: '2px solid #ef4444',
                borderRadius: 2,
                background: 'rgba(239,68,68,0.07)',
                boxShadow: '0 0 8px rgba(239,68,68,0.25)',
              }}
            >
              {/* Confidence label */}
              <div style={{
                position: 'absolute', top: -18, left: 0,
                background: '#ef4444',
                padding: '2px 6px', borderRadius: '3px 3px 0 0',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <motion.div
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ repeat: Infinity, duration: 0.9 }}
                  style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff' }}
                />
                <span style={{ fontSize: 8, fontWeight: 900, color: '#fff', fontFamily: 'monospace' }}>ARMED Â· 98%</span>
              </div>
            </motion.div>
          </div>

          {/* Face scan sweep */}
          <motion.div
            animate={{ top: ['12%', '85%'] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'linear', repeatDelay: 2 }}
            style={{
              position: 'absolute', left: '26%', right: '28%', height: 1.5, zIndex: 5,
              background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.9), transparent)',
              boxShadow: '0 0 8px rgba(59,130,246,0.5)',
              pointerEvents: 'none',
            }}
          />

          {/* Top bar: REC | CAM-04 | SUS-204 */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 7,
            background: 'rgba(0,0,0,0.6)', padding: '3px 8px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <motion.div
                animate={{ opacity: [1, 0.1, 1] }}
                transition={{ repeat: Infinity, duration: 1.2 }}
                style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444' }}
              />
              <span style={{ fontSize: 8, fontWeight: 900, color: '#ef4444', fontFamily: 'monospace' }}>REC</span>
            </div>
            <span style={{ fontSize: 8, color: '#94a3b8', fontFamily: 'monospace' }}>CAM-04</span>
            <span style={{ fontSize: 8, fontWeight: 800, color: '#fbbf24', fontFamily: 'monospace' }}>SUS-204</span>
          </div>

          {/* Bottom alert bar */}
          <motion.div
            animate={{ opacity: [1, 0.7, 1] }}
            transition={{ repeat: Infinity, duration: 1.4 }}
            style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 7,
              background: 'rgba(220,38,38,0.88)', padding: '3px 8px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 8, fontWeight: 900, color: '#fff', letterSpacing: '.05em' }}>âš  ARMED THREAT</span>
            <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.8)', fontFamily: 'monospace' }}>14:20:31</span>
          </motion.div>
        </div>
      </div>

      {/* Threat score */}
      <div style={{ padding: '8px 16px 0' }}>
        <ThreatScoreBar score={THREAT_SCORE} />
      </div>

      {/* Facts grid */}
      <div className="weapon-suspect-facts" style={{ gap: '8px 16px', padding: '10px 16px 0' }}>
        {[
          ['REID Status',  'Active',          true,  false],
          ['Last Camera',  'CAM-04',          false, false],
          ['Direction',    'North Corridor',  false, false],
          ['Speed',        '1.4 m/s',         false, false],
          ['Incidents',    '3 Linked',        false, true ],
          ['Watchlist',    'Confirmed',       false, true ],
        ].map(([label, value, isActive, isDanger]) => (
          <div key={label}>
            <span>{label}</span>
            <strong className={isActive ? 'is-active' : isDanger ? 'is-danger' : ''}>
              {isActive && (
                <motion.span
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#22c55e', marginRight: 4, verticalAlign: 'middle' }}
                />
              )}
              {value}
            </strong>
          </div>
        ))}
      </div>

      <button className="weapon-outline-action" style={{ marginTop: 10 }}>
        <span className="material-symbols-outlined">person_search</span>
        View Full Profile
      </button>
    </div>
  );
}
