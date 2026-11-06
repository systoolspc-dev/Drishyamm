import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const SEED_EVENTS = [
  { id: 1,  type: 'WEAPON',   msg: 'Gun detected Â· Main Gate Â· CAM-01',          time: '14:20:31', color: '#ef4444' },
  { id: 2,  type: 'ESCALATE', msg: 'Threat escalated to Level-3 Â· Command notified', time: '14:20:34', color: '#dc2626' },
  { id: 3,  type: 'RESPONSE', msg: 'Response Unit-7 notified Â· ETA 2 min',         time: '14:20:36', color: '#b45309' },
  { id: 4,  type: 'REID',     msg: 'REID lock acquired Â· SUS-204 Â· CAM-04',         time: '14:20:38', color: '#3b82f6' },
  { id: 5,  type: 'WEAPON',   msg: 'Knife detected Â· Parking Area Â· CAM-02',        time: '14:20:45', color: '#ef4444' },
  { id: 6,  type: 'EVIDENCE', msg: 'Evidence frame captured Â· WPN-231',             time: '14:20:48', color: '#8b5cf6' },
  { id: 7,  type: 'CLEAR',    msg: 'Zone North Corridor cleared Â· All-clear issued', time: '14:20:52', color: '#22c55e' },
  { id: 8,  type: 'WEAPON',   msg: 'Firearm re-identified Â· CAM-04 Â· CONF 98%',     time: '14:21:01', color: '#ef4444' },
  { id: 9,  type: 'RESPONSE', msg: 'Unit-3 in position Â· Main Gate secured',         time: '14:21:05', color: '#b45309' },
  { id: 10, type: 'REID',     msg: 'Suspect movement Â· CAM-04 â†’ North Corridor',    time: '14:21:09', color: '#3b82f6' },
];

const TYPE_ICON = {
  WEAPON:   'emergency',
  ESCALATE: 'priority_high',
  RESPONSE: 'local_police',
  REID:     'person_pin_circle',
  EVIDENCE: 'photo_camera',
  CLEAR:    'check_circle',
};

export default function EventTicker() {
  const [events, setEvents] = useState(SEED_EVENTS);
  const nextId = useRef(11);

  useEffect(() => {
    const templates = [
      { type: 'WEAPON',   color: '#ef4444', msgs: ['Weapon detected Â· Bus Bay Â· CAM-05', 'Firearm flagged Â· Parking Â· CAM-02', 'Knife alert Â· North Entry Â· CAM-03'] },
      { type: 'RESPONSE', color: '#b45309', msgs: ['Unit-5 notified Â· ETA 3 min', 'Quick Response mobilised Â· Sector B', 'Command vehicle en-route'] },
      { type: 'REID',     color: '#3b82f6', msgs: ['REID handoff Â· CAM-04 â†’ CAM-07', 'Suspect re-acquired Â· South Gate', 'Track update Â· SUS-204 moving west'] },
      { type: 'EVIDENCE', color: '#8b5cf6', msgs: ['Frame archived Â· WPN-232', 'Video clip saved Â· 14:21:44', 'Biometric log updated Â· SUS-204'] },
      { type: 'CLEAR',    color: '#22c55e', msgs: ['Zone Cafeteria secured', 'All-clear Â· Admin Block', 'CAM-06 resumed normal ops'] },
    ];

    const id = setInterval(() => {
      const tpl = templates[Math.floor(Math.random() * templates.length)];
      const msg = tpl.msgs[Math.floor(Math.random() * tpl.msgs.length)];
      const now = new Date().toLocaleTimeString('en-US', { hour12: false });
      setEvents(prev => [{ id: nextId.current++, type: tpl.type, msg, time: now, color: tpl.color }, ...prev.slice(0, 14)]);
    }, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e5e5',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 20,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 14px',
        background: 'rgba(220,38,38,0.06)',
        borderBottom: '1px solid #e5e5e5',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <motion.div
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ repeat: Infinity, duration: 0.9 }}
            style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 6px #ef4444' }}
          />
          <span style={{ fontSize: 10, fontWeight: 900, color: '#dc2626', letterSpacing: '.1em' }}>LIVE EVENT FEED</span>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {['WEAPON', 'RESPONSE', 'REID'].map(t => (
            <span key={t} style={{ fontSize: 9, color: '#64748b', fontWeight: 700, letterSpacing: '.06em' }}>
              {t}
            </span>
          ))}
          <span style={{ fontSize: 9, color: '#16a34a', fontWeight: 700 }}>+LIVE</span>
        </div>
      </div>

      {/* Scrolling events */}
      <div style={{ maxHeight: 58, overflow: 'hidden', position: 'relative' }}>
        <AnimatePresence initial={false}>
          {events.slice(0, 2).map((ev, idx) => (
            <motion.div
              key={ev.id}
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: idx === 0 ? 1 : 0.45, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '5px 14px',
                borderBottom: '1px solid #e5e5e5',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 13, color: ev.color, flexShrink: 0 }}>
                {TYPE_ICON[ev.type] || 'info'}
              </span>
              <span style={{
                fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 3,
                background: `${ev.color}18`, color: ev.color, flexShrink: 0,
                letterSpacing: '.05em',
              }}>{ev.type}</span>
              <span style={{ fontSize: 10, color: '#0f172a', flex: 1, fontFamily: 'monospace' }}>{ev.msg}</span>
              <span style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace', flexShrink: 0 }}>{ev.time}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
