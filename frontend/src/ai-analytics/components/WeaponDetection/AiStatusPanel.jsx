import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

function useLatency() {
  const [ms, setMs] = useState(34);
  useEffect(() => {
    const id = setInterval(() => setMs(prev => Math.max(22, Math.min(58, prev + Math.floor(Math.random() * 7) - 3))), 1800);
    return () => clearInterval(id);
  }, []);
  return ms;
}

function StatusRow({ label, value, color = '#22c55e', pulse = false, mono = false }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #e5e5e5' }}>
      <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {pulse && (
          <motion.div
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ repeat: Infinity, duration: 1 }}
            style={{ width: 5, height: 5, borderRadius: '50%', background: color }}
          />
        )}
        <span style={{
          fontSize: 10, fontWeight: 800, color,
          fontFamily: mono ? 'monospace' : undefined,
        }}>{value}</span>
      </div>
    </div>
  );
}

export default function AiStatusPanel() {
  const latency = useLatency();
  const latencyColor = latency < 40 ? '#22c55e' : latency < 55 ? '#f59e0b' : '#ef4444';

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e5e5',
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(15,23,42,0.06)',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        background: 'rgba(247,152,58,0.08)',
        borderBottom: '1px solid #e5e5e5',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'rgba(247,152,58,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#F7983A' }}>smart_toy</span>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>AI Engine Status</div>
          <div style={{ fontSize: 9, color: '#64748b', letterSpacing: '.04em' }}>DRISHYAM VMS Â· INFERENCE NODE</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <motion.div
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ repeat: Infinity, duration: 1.4 }}
            style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }}
          />
          <span style={{ fontSize: 9, fontWeight: 800, color: '#4ade80', letterSpacing: '.08em' }}>ACTIVE</span>
        </div>
      </div>

      {/* Status rows */}
      <div style={{ padding: '4px 14px 8px' }}>
        <StatusRow label="Model"        value="YOLOv8-Wpn v2.4.1"  color="#0f172a" mono />
        <StatusRow label="Inference"    value={`${latency} ms`}     color={latencyColor} mono pulse />
        <StatusRow label="Cameras Sync" value="24 / 28"             color="#0f172a" mono />
        <StatusRow label="Detections"   value="14 today"            color="#dc2626" />
        <StatusRow label="GPU Util"     value="61%"                 color="#7c3aed" mono />
        <StatusRow label="Uptime"       value="99.8%"               color="#16a34a" mono />
      </div>

      {/* GPU bar */}
      <div style={{ padding: '0 14px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#64748b', fontWeight: 600 }}>GPU UTILISATION</span>
          <span style={{ fontSize: 9, color: '#7c3aed', fontWeight: 700, fontFamily: 'monospace' }}>61%</span>
        </div>
        <div style={{ height: 4, background: '#f1f5f9', borderRadius: 99, overflow: 'hidden' }}>
          <motion.div
            animate={{ width: ['58%', '65%', '61%', '63%'] }}
            transition={{ repeat: Infinity, duration: 4, ease: 'easeInOut' }}
            style={{ height: '100%', borderRadius: 99, background: 'linear-gradient(90deg, #7c3aed, #a78bfa)' }}
          />
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 14px',
        borderTop: '1px solid #e5e5e5',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 9, color: '#64748b' }}>Last sync: <span style={{ color: '#16a34a', fontWeight: 700 }}>LIVE</span></span>
        <span style={{ fontSize: 9, color: '#64748b' }}>Node: <span style={{ color: '#0f172a', fontFamily: 'monospace' }}>GPU-01</span></span>
      </div>
    </div>
  );
}
