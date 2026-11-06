import { motion } from 'framer-motion';

const MINI_CAMS = [
  { id: 'CAM-01', status: 'clear',    location: 'Main Gate',    threat: false, fps: 30 },
  { id: 'CAM-02', status: 'clear',    location: 'Parking',      threat: false, fps: 29 },
  { id: 'CAM-03', status: 'alert',    location: 'North Entry',  threat: false, fps: 28 },
  { id: 'CAM-04', status: 'critical', location: 'South Exit',   threat: true,  fps: 30 },
  { id: 'CAM-05', status: 'clear',    location: 'Bus Bay',      threat: false, fps: 30 },
  { id: 'CAM-06', status: 'offline',  location: 'Back Gate',    threat: false, fps: 0  },
];

const STATUS_COLOR = {
  critical: '#ef4444',
  alert:    '#b45309',
  clear:    '#22c55e',
  offline:  '#475569',
};

function MiniThumb({ cam, featured }) {
  const color = STATUS_COLOR[cam.status];
  return (
    <div style={{
      borderRadius: 8,
      overflow: 'hidden',
      border: `1.5px solid ${featured ? '#ef4444' : cam.status === 'offline' ? '#334155' : 'rgba(255,255,255,0.08)'}`,
      background: '#0a0f1e',
      position: 'relative',
      boxShadow: featured ? '0 0 12px rgba(239,68,68,0.35)' : undefined,
      aspectRatio: '4/3',
    }}>
      {/* Background texture */}
      <div style={{
        position: 'absolute', inset: 0,
        background: cam.status === 'offline'
          ? 'repeating-linear-gradient(45deg, #0f172a, #0f172a 4px, #0a0f1e 4px, #0a0f1e 8px)'
          : cam.threat
            ? 'radial-gradient(ellipse at 40% 60%, rgba(220,38,38,0.25) 0%, transparent 65%), linear-gradient(135deg, #0a0f1e, #0f1a0f)'
            : 'linear-gradient(135deg, #0a0f1e, #0d1117)',
      }} />

      {/* Scanlines */}
      {cam.status !== 'offline' && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.12) 2px, rgba(0,0,0,.12) 4px)',
        }} />
      )}

      {/* Threat silhouette */}
      {cam.threat && (
        <div style={{ position: 'absolute', bottom: 10, left: '35%', zIndex: 2 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: 'rgba(239,68,68,0.6)' }}>person</span>
          {/* Detection box */}
          <div style={{
            position: 'absolute', top: -4, left: -4, right: -4, bottom: -4,
            border: '1.5px solid #ef4444',
            borderRadius: 2,
          }}>
            <motion.div
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ repeat: Infinity, duration: 0.8 }}
              style={{
                position: 'absolute', top: -12, left: 0,
                fontSize: 7, fontWeight: 800, color: '#ef4444', fontFamily: 'monospace',
                background: '#ef4444', color: '#fff',
                padding: '1px 4px', borderRadius: 2, whiteSpace: 'nowrap',
              }}
            >GUN 98%</motion.div>
          </div>
        </div>
      )}

      {/* Top row: cam id + status */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
        padding: '3px 5px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}>
        <span style={{ fontSize: 8, fontWeight: 800, color: color, fontFamily: 'monospace' }}>{cam.id}</span>
        {cam.status === 'critical' ? (
          <motion.div
            animate={{ opacity: [1, 0.1, 1] }}
            transition={{ repeat: Infinity, duration: 0.7 }}
            style={{ width: 5, height: 5, borderRadius: '50%', background: '#ef4444' }}
          />
        ) : cam.status === 'offline' ? (
          <span style={{ fontSize: 7, color: '#475569', fontWeight: 700 }}>OFFLINE</span>
        ) : (
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
        )}
      </div>

      {/* Bottom: location + fps */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 5,
        padding: '2px 5px',
        display: 'flex', justifyContent: 'space-between',
        background: 'rgba(0,0,0,0.6)',
      }}>
        <span style={{ fontSize: 7, color: '#94a3b8', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cam.location}</span>
        {cam.status !== 'offline' && <span style={{ fontSize: 7, color: '#475569', fontFamily: 'monospace' }}>{cam.fps}fps</span>}
      </div>

      {/* Offline overlay */}
      {cam.status === 'offline' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 4,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 2,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#334155' }}>videocam_off</span>
          <span style={{ fontSize: 7, color: '#334155', fontWeight: 700, letterSpacing: '.06em' }}>NO SIGNAL</span>
        </div>
      )}
    </div>
  );
}

export default function MiniCameraGrid() {
  const activeCount  = MINI_CAMS.filter(c => c.status !== 'offline').length;
  const criticalCam  = MINI_CAMS.find(c => c.status === 'critical');

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e5e5',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #e5e5e5',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#F7983A' }}>grid_view</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>Multi-Camera Preview</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, color: '#64748b' }}>{activeCount}/{MINI_CAMS.length} online</span>
          {criticalCam && (
            <motion.span
              animate={{ opacity: [1, 0.2, 1] }}
              transition={{ repeat: Infinity, duration: 0.9 }}
              style={{ fontSize: 9, fontWeight: 800, color: '#ef4444', letterSpacing: '.06em' }}
            >â— THREAT</motion.span>
          )}
        </div>
      </div>

      {/* Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 8,
        padding: 10,
      }}>
        {MINI_CAMS.map(cam => (
          <MiniThumb key={cam.id} cam={cam} featured={cam.status === 'critical'} />
        ))}
      </div>
    </div>
  );
}
