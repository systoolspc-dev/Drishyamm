import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

const THREATS = [
  {
    incident_id: 'WPN-001',
    weapon_id: 'WEAP-RFL-00042',
    weapon_signature: 'long-barrel-black-rifle',
    type: 'Rifle',
    location: 'Main Gate',
    camera: 'CAM-04',
    confidence: 0.94,
    severity: 'critical',
    status: 'active',
    time: '14:20:31',
    face_match_status: 'unknown',
    face_id: null,
    person_name: 'Unknown Face',
    watchlist_status: 'not_listed',
    evidence_count: 4,
    linked_cameras: 3,
    response_action: 'Open journey and face intake',
  },
  {
    incident_id: 'WPN-002',
    weapon_id: 'WEAP-PST-00017',
    weapon_signature: 'compact-black-pistol',
    type: 'Pistol',
    location: 'Parking Area',
    camera: 'CAM-07',
    confidence: 0.91,
    severity: 'critical',
    status: 'active',
    time: '14:19:45',
    face_match_status: 'matched',
    face_id: 'FACE-00921',
    person_name: 'Ravi Sharma',
    watchlist_status: 'red_list',
    evidence_count: 6,
    linked_cameras: 5,
    response_action: 'Track suspect route',
  },
  {
    incident_id: 'WPN-003',
    weapon_id: 'WEAP-KNF-00031',
    weapon_signature: 'short-blade-silver',
    type: 'Knife',
    location: 'North Entry',
    camera: 'CAM-01',
    confidence: 0.88,
    severity: 'high',
    status: 'acknowledged',
    time: '14:18:22',
    face_match_status: 'pending',
    face_id: null,
    person_name: 'Face Pending',
    watchlist_status: 'pending',
    evidence_count: 3,
    linked_cameras: 2,
    response_action: 'Verify identity',
  },
  {
    incident_id: 'WPN-004',
    weapon_id: 'WEAP-RFL-00043',
    weapon_signature: 'long-barrel-brown-rifle',
    type: 'Rifle',
    location: 'Bus Bay',
    camera: 'CAM-03',
    confidence: 0.87,
    severity: 'high',
    status: 'acknowledged',
    time: '14:16:11',
    face_match_status: 'matched',
    face_id: 'FACE-01108',
    person_name: 'Imran Khan',
    watchlist_status: 'watchlisted',
    evidence_count: 5,
    linked_cameras: 4,
    response_action: 'Hold and monitor',
  },
  {
    incident_id: 'WPN-005',
    weapon_id: 'WEAP-PST-00018',
    weapon_signature: 'compact-metal-pistol',
    type: 'Pistol',
    location: 'Back Gate',
    camera: 'CAM-02',
    confidence: 0.72,
    severity: 'warning',
    status: 'acknowledged',
    time: '14:14:33',
    face_match_status: 'unknown',
    face_id: null,
    person_name: 'Unknown Face',
    watchlist_status: 'not_listed',
    evidence_count: 2,
    linked_cameras: 1,
    response_action: 'Add face to watchlist',
  },
  {
    incident_id: 'WPN-006',
    weapon_id: 'WEAP-KNF-00032',
    weapon_signature: 'folding-knife-dark-handle',
    type: 'Knife',
    location: 'Cafeteria',
    camera: 'CAM-09',
    confidence: 0.68,
    severity: 'warning',
    status: 'resolved',
    time: '14:10:05',
    face_match_status: 'matched',
    face_id: 'FACE-00872',
    person_name: 'Ajay Mehta',
    watchlist_status: 'not_listed',
    evidence_count: 3,
    linked_cameras: 2,
    response_action: 'Archive evidence',
  },
  {
    incident_id: 'WPN-007',
    weapon_id: 'WEAP-PST-00019',
    weapon_signature: 'black-pistol-right-hand',
    type: 'Pistol',
    location: 'South Gate',
    camera: 'CAM-05',
    confidence: 0.95,
    severity: 'critical',
    status: 'resolved',
    time: '13:55:18',
    face_match_status: 'matched',
    face_id: 'FACE-01044',
    person_name: 'Karan Joshi',
    watchlist_status: 'red_list',
    evidence_count: 8,
    linked_cameras: 6,
    response_action: 'Close incident',
  },
  {
    incident_id: 'WPN-008',
    weapon_id: 'WEAP-UNK-00009',
    weapon_signature: 'unknown-metal-object',
    type: 'Unknown',
    location: 'Control Room',
    camera: 'CAM-11',
    confidence: 0.62,
    severity: 'warning',
    status: 'active',
    time: '13:42:07',
    face_match_status: 'unknown',
    face_id: null,
    person_name: 'Unknown Face',
    watchlist_status: 'not_listed',
    evidence_count: 1,
    linked_cameras: 1,
    response_action: 'Manual verification',
  },
];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'acknowledged', label: 'Acknowledged' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'face_linked', label: 'Face Linked' },
  { id: 'unknown_face', label: 'Unknown Face' },
];

const WEAPON_DIST = [
  { name: 'Rifle', value: 38, color: '#ef4444' },
  { name: 'Pistol', value: 35, color: '#b45309' },
  { name: 'Knife', value: 20, color: '#f59e0b' },
  { name: 'Unknown', value: 7, color: '#94a3b8' },
];

const SEV = {
  critical: { label: 'Critical', color: '#dc2626', bg: '#fef2f2', border: '#fecaca', rowBg: 'rgba(239,68,68,.03)', icon: 'emergency' },
  high: { label: 'High', color: '#06152F', bg: '#EAF0F6', border: '#CBD5E1', rowBg: 'rgba(249,115,22,.03)', icon: 'warning' },
  warning: { label: 'Warning', color: '#b45309', bg: '#fffbeb', border: '#fde68a', rowBg: 'transparent', icon: 'error' },
};

const STA = {
  active: { label: 'Active', color: '#dc2626', bg: '#fef2f2', dot: '#ef4444' },
  acknowledged: { label: 'Acknowledged', color: '#2563eb', bg: '#eff6ff', dot: '#3b82f6' },
  resolved: { label: 'Resolved', color: '#16a34a', bg: '#f0fdf4', dot: '#22c55e' },
};

const FACE = {
  matched: { label: 'Face Linked', color: '#16a34a', bg: '#f0fdf4', icon: 'face' },
  unknown: { label: 'Unknown Face', color: '#dc2626', bg: '#fef2f2', icon: 'person_add' },
  pending: { label: 'Face Pending', color: '#b45309', bg: '#fffbeb', icon: 'person_search' },
};

const WEAPON_ICONS = { Rifle: 'dangerous', Pistol: 'emergency', Knife: 'construction', Unknown: 'help' };

function formatRegistryStatus(value) {
  if (!value) return 'Not Listed';
  return String(value)
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function SeverityChip({ val }) {
  const s = SEV[val] || SEV.warning;
  return (
    <span className="weapon-registry-chip" style={{ color: s.color, background: s.bg, borderColor: s.border }}>
      <span className="material-symbols-outlined">{s.icon}</span>
      {s.label}
    </span>
  );
}

function StatusChip({ val }) {
  const s = STA[val] || STA.active;
  return (
    <span className="weapon-registry-chip" style={{ color: s.color, background: s.bg, borderColor: 'transparent' }}>
      <i style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

function FaceChip({ row }) {
  const f = FACE[row.face_match_status] || FACE.pending;
  return (
    <span className="weapon-face-chip" style={{ color: f.color, background: f.bg }}>
      <span className="material-symbols-outlined">{f.icon}</span>
      <strong>{row.person_name}</strong>
      {row.face_id && <em>{row.face_id}</em>}
    </span>
  );
}

function ConfidenceBar({ value }) {
  const pct = Math.round(value * 100);
  const color = pct >= 90 ? '#ef4444' : pct >= 75 ? '#b45309' : '#f59e0b';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 80 }}>
      <div style={{ flex: 1, height: 5, borderRadius: 99, background: '#f1f5f9', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: 99, width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 800, color, fontFamily: 'monospace', flexShrink: 0 }}>{pct}%</span>
    </div>
  );
}

function IncidentMetrics({ counts }) {
  const stats = [
    { label: 'Weapons Detected', value: THREATS.length, sub: 'Total weapon incidents', icon: 'emergency', color: '#ef4444', tone: 'red' },
    { label: 'Active Threats', value: counts.active, sub: 'Needs immediate review', icon: 'warning', color: '#b45309', tone: 'orange' },
    { label: 'Last Detection', value: THREATS[0].time, sub: `${THREATS[0].type} at ${THREATS[0].location}`, icon: 'schedule', color: 'var(--color-text)', tone: 'indigo' },
    { label: 'Unknown Faces', value: counts.unknown_face, sub: 'Face Watchlist intake pending', icon: 'person_add', color: '#dc2626', tone: 'critical' },
  ];

  return (
    <div className="weapon-metrics-grid weapon-watchlist-metrics">
      {stats.map((stat, index) => (
        <motion.div
          key={stat.label}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05, duration: 0.25 }}
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

function WeaponDistributionSummary() {
  return (
    <div className="card weapon-card weapon-watchlist-distribution">
      <div className="weapon-panel-title-row">
        <div>
          <h3>Weapon Distribution</h3>
          <p>All-time breakdown by type</p>
        </div>
        <span className="weapon-status-inline"><span />Summary</span>
      </div>
      <div className="weapon-watchlist-distribution-body">
        <div className="weapon-watchlist-donut">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={WEAPON_DIST} dataKey="value" cx="50%" cy="50%" innerRadius={44} outerRadius={66} paddingAngle={3} strokeWidth={0}>
                {WEAPON_DIST.map(item => <Cell key={item.name} fill={item.color} />)}
              </Pie>
              <Tooltip formatter={value => [`${value}%`, 'Share']} />
            </PieChart>
          </ResponsiveContainer>
          <div className="weapon-watchlist-donut-total">
            <strong>100%</strong>
            <span>Total</span>
          </div>
        </div>
        <div className="weapon-watchlist-dist-list">
          {WEAPON_DIST.map(item => (
            <div key={item.name}>
              <div>
                <span style={{ background: item.color }} />
                <strong>{item.name}</strong>
                <em>{item.value}%</em>
              </div>
              <i style={{ width: `${item.value}%`, background: item.color }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function matchesFilter(row, filter) {
  if (filter === 'all') return true;
  if (filter === 'face_linked') return row.face_match_status === 'matched';
  if (filter === 'unknown_face') return row.face_match_status === 'unknown';
  return row.status === filter;
}

export default function ThreatWatchlist() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [reportTarget, setReportTarget] = useState(null);
  const [showSummary, setShowSummary] = useState(true);

  const rows = THREATS
    .filter(t => matchesFilter(t, filter))
    .filter(t => {
      const q = search.toLowerCase();
      return !q || [
        t.incident_id,
        t.weapon_id,
        t.weapon_signature,
        t.type,
        t.location,
        t.camera,
        t.person_name,
        t.face_id || '',
      ].some(v => v.toLowerCase().includes(q));
    });

  const counts = {
    all: THREATS.length,
    active: THREATS.filter(t => t.status === 'active').length,
    acknowledged: THREATS.filter(t => t.status === 'acknowledged').length,
    resolved: THREATS.filter(t => t.status === 'resolved').length,
    face_linked: THREATS.filter(t => t.face_match_status === 'matched').length,
    unknown_face: THREATS.filter(t => t.face_match_status === 'unknown').length,
  };

  const goFace = (row) => {
    if (row.face_match_status === 'matched' && row.face_id) {
      navigate(`/ai-analytics/watchlist/suspect/${row.face_id}?source=weapon&incident=${row.incident_id}&weapon=${row.weapon_id}`);
      return;
    }
    const params = new URLSearchParams({
      source: 'weapon',
      mode: 'add',
      incident: row.incident_id,
      weapon: row.weapon_id,
      face: row.face_id || row.face_match_status,
      image: '/weapon-demo.jpg',
      notes: `${row.person_name} captured with ${row.type} at ${row.camera}, ${row.location}. Review and train Face Watchlist identity.`,
    });
    navigate(`/ai-analytics/watchlist/watchlist?${params.toString()}`);
  };

  return (
    <div style={{ padding: 20 }}>
      <div className="weapon-watchlist-header">
        <div>
          <h2>Weapon Incident Center</h2>
          <p>Evidence-linked incident queue for weapons, faces, cameras, journey maps and reports</p>
        </div>
        <button
          type="button"
          className={`weapon-summary-toggle ${showSummary ? 'active' : ''}`}
          onClick={() => setShowSummary(prev => !prev)}
        >
          <span className="material-symbols-outlined">{showSummary ? 'visibility' : 'visibility_off'}</span>
          {showSummary ? 'Hide Summary' : 'Show Summary'}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {showSummary && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden' }}
          >
            <IncidentMetrics counts={counts} />
            <div className="weapon-watchlist-summary-grid">
              <WeaponDistributionSummary />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e5e7eb', overflow: 'hidden', boxShadow: '0 4px 16px rgba(0,0,0,.05)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: '#fafbfc' }}>
          <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 10, padding: 4, flexWrap: 'wrap' }}>
            {FILTERS.map(f => {
              const isActive = filter === f.id;
              const dotColor = f.id === 'active' ? '#ef4444' : f.id === 'resolved' ? '#22c55e' : f.id === 'unknown_face' ? '#dc2626' : undefined;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 7,
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 700,
                    background: isActive ? '#fff' : 'transparent',
                    color: isActive ? '#0f172a' : '#64748b',
                    boxShadow: isActive ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    transition: 'all .15s',
                  }}
                >
                  {dotColor && <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor }} />}
                  {f.label}
                  <span style={{
                    padding: '1px 5px',
                    borderRadius: 99,
                    fontSize: 10,
                    background: isActive ? '#e0f2fe' : 'transparent',
                    color: isActive ? '#0284c7' : '#94a3b8',
                    fontWeight: 800,
                  }}>
                    {counts[f.id]}
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <span className="material-symbols-outlined" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: 16 }}>search</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search weapon, incident, camera, face..."
                style={{
                  height: 34,
                  padding: '0 12px 0 34px',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  fontSize: 12,
                  outline: 'none',
                  background: '#f8fafc',
                  width: 250,
                }}
              />
            </div>
            <button
              type="button"
              disabled={rows.length === 0}
              title={rows.length ? 'Open report for the first visible incident' : 'No visible incidents to report'}
              onClick={() => rows.length && setReportTarget(rows[0])}
              style={{ height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: rows.length ? '#fff' : '#f8fafc', fontSize: 12, fontWeight: 700, cursor: rows.length ? 'pointer' : 'not-allowed', color: rows.length ? '#475569' : '#94a3b8', display: 'flex', alignItems: 'center', gap: 5 }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>summarize</span>
              Open Report
            </button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1180, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {['Weapon ID', 'Weapon', 'Face Link', 'Location', 'Camera', 'Confidence', 'Severity', 'Status', 'Intel', 'Actions'].map(h => (
                  <th key={h} style={{
                    padding: '10px 16px',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '.04em',
                    borderBottom: '1px solid #e5e7eb',
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false}>
                {rows.map(row => {
                  const sev = SEV[row.severity] || SEV.warning;
                  const isActive = row.status === 'active';
                  return (
                    <motion.tr
                      key={row.incident_id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      style={{
                        cursor: 'pointer',
                        background: sev.rowBg,
                        borderLeft: isActive ? '3px solid #ef4444' : '3px solid transparent',
                      }}
                      onClick={() => setSelected(row)}
                    >
                      <td style={{ padding: '12px 16px', paddingLeft: isActive ? 13 : 16 }}>
                        <div className="weapon-id-cell">
                          {isActive && (
                            <motion.span
                              animate={{ opacity: [1, 0.3, 1] }}
                              transition={{ repeat: Infinity, duration: 1 }}
                            />
                          )}
                          <strong>{row.weapon_id}</strong>
                          <em>{row.incident_id}</em>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 16, color: sev.color }}>{WEAPON_ICONS[row.type] || 'dangerous'}</span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>{row.type}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>{row.weapon_signature}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}><FaceChip row={row} /></td>
                      <td style={{ padding: '12px 16px', fontSize: 13, color: '#475569' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#94a3b8' }}>location_on</span>
                          {row.location}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace', background: '#f1f5f9', padding: '2px 7px', borderRadius: 5 }}>{row.camera}</span>
                      </td>
                      <td style={{ padding: '12px 16px' }}><ConfidenceBar value={row.confidence} /></td>
                      <td style={{ padding: '12px 16px' }}><SeverityChip val={row.severity} /></td>
                      <td style={{ padding: '12px 16px' }}><StatusChip val={row.status} /></td>
                      <td style={{ padding: '12px 16px' }}>
                        <div className="weapon-intel-mini">
                          <span>{row.evidence_count} evidence</span>
                          <span>{row.linked_cameras} cams</span>
                          <strong>{formatRegistryStatus(row.watchlist_status)}</strong>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div className="weapon-registry-actions">
                          <button
                            type="button"
                            title="View evidence"
                            onClick={e => { e.stopPropagation(); navigate(`/ai-analytics/weapon/evidence?incident=${row.incident_id}&weapon=${row.weapon_id}`); }}
                          >
                            <span className="material-symbols-outlined">folder_special</span>
                          </button>
                          <button
                            type="button"
                            title="Open journey map"
                            onClick={e => { e.stopPropagation(); navigate(`/ai-analytics/weapon/journey/${row.weapon_id}`); }}
                          >
                            <span className="material-symbols-outlined">route</span>
                          </button>
                          <button type="button" title={row.face_match_status === 'matched' ? 'Open Face Watchlist profile' : 'Send face to Face Watchlist intake'} onClick={e => { e.stopPropagation(); goFace(row); }}>
                            <span className="material-symbols-outlined">{row.face_match_status === 'matched' ? 'face' : 'person_add'}</span>
                          </button>
                          <button type="button" title="Generate report" onClick={e => { e.stopPropagation(); setReportTarget(row); }}>
                            <span className="material-symbols-outlined">summarize</span>
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>search_off</span>
                    No weapon records match this view
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 200,
              background: 'rgba(15,23,42,.55)',
              backdropFilter: 'blur(6px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={() => setSelected(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ type: 'spring', damping: 28, stiffness: 320 }}
              onClick={e => e.stopPropagation()}
              style={{
                background: '#fff',
                borderRadius: 20,
                width: 620,
                maxWidth: 'calc(var(--app-vw) - 32px)',
                boxShadow: '0 32px 80px rgba(0,0,0,.22)',
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '20px 24px 16px',
                borderBottom: '1px solid #f1f5f9',
                background: `linear-gradient(135deg, ${(SEV[selected.severity] || SEV.warning).bg}, #fff)`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 10, color: (SEV[selected.severity] || SEV.warning).color, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>
                      Weapon Registry Detail
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 900, color: '#0f172a', fontFamily: 'monospace' }}>{selected.weapon_id}</div>
                    <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>{selected.incident_id} | {selected.type} | {selected.location}</div>
                  </div>
                  <button onClick={() => setSelected(null)} style={{ background: '#f1f5f9', border: 'none', borderRadius: 10, width: 34, height: 34, cursor: 'pointer', fontSize: 18, color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>x</button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <SeverityChip val={selected.severity} />
                  <StatusChip val={selected.status} />
                  <FaceChip row={selected} />
                </div>
              </div>

              <div style={{ padding: '20px 24px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                  {[
                    ['Weapon ID', selected.weapon_id],
                    ['Weapon Signature', selected.weapon_signature],
                    ['Face Link', selected.face_id || selected.person_name],
                    ['Face Registry Status', formatRegistryStatus(selected.watchlist_status)],
                    ['Evidence Count', selected.evidence_count],
                    ['Linked Cameras', selected.linked_cameras],
                    ['Primary Camera', selected.camera],
                    ['Investigation Action', selected.response_action],
                  ].map(([label, val]) => (
                    <div key={label} style={{ background: '#f8fafc', borderRadius: 10, padding: '11px 14px', border: '1px solid #f1f5f9' }}>
                      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
                  <button className="weapon-detail-action" type="button" onClick={() => navigate(`/ai-analytics/weapon/evidence?incident=${selected.incident_id}&weapon=${selected.weapon_id}`)}>Evidence</button>
                  <button className="weapon-detail-action" type="button" onClick={() => navigate(`/ai-analytics/weapon/journey/${selected.weapon_id}`)}>Journey</button>
                  <button className="weapon-detail-action" type="button" onClick={() => goFace(selected)}>{selected.face_match_status === 'matched' ? 'View Face' : 'Add Face'}</button>
                  <button className="weapon-detail-action primary" type="button" onClick={() => setReportTarget(selected)}>Report</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reportTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="weapon-report-overlay"
            onClick={() => setReportTarget(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 18, scale: .96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: .98 }}
              className="weapon-report-modal"
              onClick={e => e.stopPropagation()}
            >
              <div className="weapon-report-modal-header">
                <div>
                  <span>Incident Report</span>
                  <h3>{reportTarget.incident_id} | {reportTarget.weapon_id}</h3>
                  <p>Generated operational summary for evidence review and command handoff.</p>
                </div>
                <button type="button" onClick={() => setReportTarget(null)}>x</button>
              </div>
              <pre className="weapon-report-preview">
{[
  `WEAPON INCIDENT REPORT`,
  `Incident: ${reportTarget.incident_id}`,
  `Weapon ID: ${reportTarget.weapon_id}`,
  `Weapon: ${reportTarget.type} (${reportTarget.weapon_signature})`,
  `Face Link: ${reportTarget.face_id || reportTarget.person_name}`,
  `Face Registry: ${formatRegistryStatus(reportTarget.watchlist_status)}`,
  `Location: ${reportTarget.location}`,
  `Primary Camera: ${reportTarget.camera}`,
  `Journey Map: ${reportTarget.linked_cameras} linked camera${reportTarget.linked_cameras > 1 ? 's' : ''} available for weapon movement reconstruction`,
  `Severity: ${reportTarget.severity}`,
  `Status: ${reportTarget.status}`,
  `Evidence: ${reportTarget.evidence_count} items`,
  `Suspect Report: ${reportTarget.face_match_status === 'unknown' ? 'Unknown face requires Face Watchlist intake' : `${reportTarget.person_name} linked through ${reportTarget.face_id}`}`,
  `Recommended Next Step: Open evidence pack and journey map together for review`
].join('\n')}
              </pre>
              <div className="weapon-report-modal-actions">
                <button type="button" onClick={() => setReportTarget(null)}>Close</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => navigate(`/ai-analytics/weapon/evidence?incident=${reportTarget.incident_id}&weapon=${reportTarget.weapon_id}&report=1`)}
                >
                  Open Evidence Pack
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
