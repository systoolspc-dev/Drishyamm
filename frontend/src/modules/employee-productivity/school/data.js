// ─────────────────────────────────────────────────────────────────────────────
// School Activity Monitoring — dummy-data layer (K-12 vertical).
//
// FRONTEND-ONLY. Every widget renders the realistic dummy data below; each block
// notes the future backend endpoint + fields. Child-safety, attendance and
// transport are the focus (vs the university's faculty/library depth).
// Brand primary #F7983A. School: "Greenwood International School".
// ─────────────────────────────────────────────────────────────────────────────

export const PRIMARY = '#F7983A';

// ── Filter hierarchy: School → Wing → Grade → Section → Room ──────────────────
// Future backend: GET /school/hierarchy → nested {id,label,children[]}.
const SECTIONS_STD = [
  { id: 'a', label: 'Section A' },
  { id: 'b', label: 'Section B' },
  { id: 'c', label: 'Section C' },
];
const gradeList = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `g${from + i}`, label: `Grade ${from + i}` }));

export const HIERARCHY = {
  schools: [{ id: 'greenwood', label: 'Greenwood International School' }],
  // wings (buildings) keyed by schoolId
  wings: {
    greenwood: [
      { id: 'primary', label: 'Primary Wing' },
      { id: 'middle', label: 'Middle Wing' },
      { id: 'senior', label: 'Senior Wing' },
      { id: 'sports', label: 'Sports Complex' },
      { id: 'admin', label: 'Admin Block' },
    ],
  },
  // grades keyed by wingId
  grades: {
    primary: gradeList(1, 5),
    middle: gradeList(6, 8),
    senior: gradeList(9, 12),
    sports: [{ id: 'pe', label: 'PE / Sports' }],
    admin: [{ id: 'office', label: 'Administration' }],
  },
  // sections keyed by wingId (A/B/C for academic wings)
  sections: {
    primary: SECTIONS_STD, middle: SECTIONS_STD, senior: SECTIONS_STD,
    sports: [{ id: 'ground', label: 'Ground' }],
    admin: [{ id: 'office', label: 'Office' }],
  },
  // rooms keyed by `${wingId}:${sectionId}`
  rooms: {
    'primary:a': [{ id: 'p1a', label: 'Room P-1A' }, { id: 'p2a', label: 'Room P-2A' }],
    'primary:b': [{ id: 'p1b', label: 'Room P-1B' }],
    'middle:a': [{ id: 'm6a', label: 'Room M-6A' }, { id: 'm7a', label: 'Room M-7A' }],
    'senior:a': [{ id: 's9a', label: 'Room S-9A' }, { id: 's10a', label: 'Physics Lab' }],
    'senior:b': [{ id: 's9b', label: 'Room S-9B' }, { id: 's-lab', label: 'Computer Lab' }],
    'sports:ground': [{ id: 'field', label: 'Main Field' }, { id: 'court', label: 'Basketball Court' }],
  },
};

export const TIME_RANGES = [
  { id: 'live', label: 'Live (now)' },
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'term', label: 'This term' },
];

// ── SECTION 1 · Key Metrics ──────────────────────────────────────────────────
// Future backend: GET /school/activity/summary?wing&grade&section&room&range
export const KPIS = [
  { key: 'students', label: 'Students Present', value: '1,486', unit: '', tone: 'primary', delta: '+38', sub: 'of 1,620 enrolled', interactive: true,
    purpose: 'Distinct students detected on-campus (deduplicated across cameras).',
    formula: 'count(distinct student where last_seen ≤ presenceWindowSec)', fields: ['tracks[].student_id', 'tracks[].last_seen_ts', 'policy.presenceWindowSec'] },
  { key: 'staff', label: 'Staff Present', value: '112', unit: '', tone: 'good', delta: '+2', sub: 'teachers & support',
    purpose: 'Teaching + support staff present anywhere on campus.', formula: 'count(distinct staff on-site)', fields: ['tracks[].staff_id'] },
  { key: 'attendance', label: 'Attendance', value: '91.7', unit: '%', tone: 'good', delta: '+0.8', sub: 'today vs 90% target',
    purpose: 'Mean attendance across sections in this period.', formula: 'avg(present / enrolled per section) × 100', fields: ['sections[].present', 'sections[].enrolled'] },
  { key: 'classes', label: 'Active Classes', value: '54', unit: '', tone: 'good', delta: '+3', sub: 'in session now',
    purpose: 'Classes detected in-session right now.', formula: 'count(rooms where schedule.session = active)', fields: ['rooms[].schedule', 'rooms[].occupancy'] },
  { key: 'safety', label: 'Safety Alerts', value: '3', unit: '', tone: 'warn', delta: '+1', sub: '1 high · 2 low',
    purpose: 'Open child-safety / security alerts needing action.', formula: 'count(safety_alerts where acknowledged = false)', fields: ['alerts[].category=safety', 'alerts[].acknowledged'] },
  { key: 'visitors', label: 'Visitors On-Campus', value: '14', unit: '', tone: 'neutral', delta: '+4', sub: '2 pending check-out',
    purpose: 'Checked-in visitors currently inside.', formula: 'count(visitors where checked_in and not checked_out)', fields: ['visitors[].check_in_ts', 'visitors[].check_out_ts'] },
  { key: 'buses', label: 'Buses', value: '9', unit: '/ 12', tone: 'neutral', delta: '', sub: '9 on-site · 3 en route',
    purpose: 'Fleet status — buses on-site vs en route.', formula: 'count(bus.status = on_site) / fleetSize', fields: ['buses[].status', 'transport.buses'] },
  { key: 'absentees', label: 'Absentees Flagged', value: '134', unit: '', tone: 'warn', delta: '−6', sub: 'parents auto-notified',
    purpose: 'Enrolled students not detected today — parents notified.', formula: 'count(enrolled) − count(present)', fields: ['roster[].student_id', 'attendance.present'] },
];

// Students Present popover breakdowns.
export const PRESENT_BY_CATEGORY = [
  { label: 'Students', count: 1486, pct: 92.1, trend: +2.6 },
  { label: 'Teachers', count: 78, pct: 4.8, trend: +0.4 },
  { label: 'Support Staff', count: 34, pct: 2.1, trend: -0.3 },
  { label: 'Visitors', count: 14, pct: 0.9, trend: +1.1 },
];
export const PRESENT_BY_GRADE = [
  { label: 'Primary (1–5)', count: 612, pct: 41.2, trend: +3.1 },
  { label: 'Middle (6–8)', count: 438, pct: 29.5, trend: +1.4 },
  { label: 'Senior (9–12)', count: 436, pct: 29.3, trend: -0.6 },
];

// ── SECTION 2 · Activity Insights ────────────────────────────────────────────
export const ACTIVITY_DISTRIBUTION = [
  { type: 'In Class', value: 1180, color: '#F7983A' },
  { type: 'Assembly', value: 90, color: '#0ea5e9' },
  { type: 'Labs', value: 96, color: '#8b5cf6' },
  { type: 'Playground / PE', value: 148, color: '#10b981' },
  { type: 'Cafeteria', value: 84, color: '#f59e0b' },
  { type: 'Transit / Corridors', value: 60, color: '#64748b' },
];
export const ACTIVITY_TREND = [
  { h: '08:00', classes: 260, playground: 40, labs: 10 },
  { h: '09:00', classes: 1180, playground: 60, labs: 40 },
  { h: '10:00', classes: 1240, playground: 120, labs: 96 },
  { h: '11:00', classes: 980, playground: 210, labs: 80 },
  { h: '12:00', classes: 620, playground: 140, labs: 40 },
  { h: '13:00', classes: 1080, playground: 90, labs: 70 },
  { h: '14:00', classes: 940, playground: 148, labs: 60 },
];

// ── SECTION 3 · Live Overview ────────────────────────────────────────────────
export const LIVE_FEED = [
  { id: 'e1', time: '10:42', type: 'class-start', text: 'Class started — Maths (Grade 6-A)', where: 'Middle · Room M-6A', tone: 'info' },
  { id: 'e2', time: '10:41', type: 'gate', text: 'Late entry — 2 students at Gate 1', where: 'Main Gate', tone: 'warn' },
  { id: 'e3', time: '10:39', type: 'playground', text: 'PE session active — Grade 4', where: 'Sports · Main Field', tone: 'ok' },
  { id: 'e4', time: '10:37', type: 'visitor', text: 'Visitor checked in — parent (Grade 2)', where: 'Reception', tone: 'ok' },
  { id: 'e5', time: '10:35', type: 'safety', text: 'Child detected alone near Lab Store', where: 'Senior Wing', tone: 'warn' },
  { id: 'e6', time: '10:31', type: 'assembly', text: 'Assembly ended — Senior Wing', where: 'Auditorium', tone: 'info' },
  { id: 'e7', time: '10:28', type: 'bus', text: 'Bus 07 arrived & unloaded (42 students)', where: 'Bus Bay', tone: 'ok' },
];

export const ACTIVE_CLASSES = [
  { id: 'a1', activity: 'Mathematics', location: 'Middle · Room M-6A', grade: 'Grade 6-A', students: 34, status: 'ongoing', started: '10:40' },
  { id: 'a2', activity: 'Physics', location: 'Senior · Physics Lab', grade: 'Grade 11-A', students: 28, status: 'ongoing', started: '10:00' },
  { id: 'a3', activity: 'English', location: 'Primary · Room P-2A', grade: 'Grade 2-A', students: 30, status: 'ongoing', started: '10:30' },
  { id: 'a4', activity: 'PE / Sports', location: 'Sports · Main Field', grade: 'Grade 4', students: 52, status: 'ongoing', started: '10:15' },
  { id: 'a5', activity: 'Computer Lab', location: 'Senior · Computer Lab', grade: 'Grade 9-B', students: 26, status: 'ongoing', started: '10:45' },
  { id: 'a6', activity: 'Library Period', location: 'Middle · Library', grade: 'Grade 7-C', students: 31, status: 'scheduled', started: '11:15' },
];

export const SAFETY_ALERTS = [
  { id: 'al1', severity: 'high', title: 'Child alone near restricted area', where: 'Senior · Lab Store', meta: 'unattended 2m 10s', since: '10:35' },
  { id: 'al2', severity: 'low', title: 'Late arrivals at gate', where: 'Main Gate', meta: '2 students · 10:41', since: '10:41' },
  { id: 'al3', severity: 'low', title: 'Low attendance — Grade 8-C', where: 'Middle Wing', meta: '78% present', since: '09:30' },
];

// ── SECTION 4 · Safety & Attendance Analytics ────────────────────────────────
export const HOURLY_ACTIVITY = [
  { h: '08', activities: 22 }, { h: '09', activities: 48 }, { h: '10', activities: 54 },
  { h: '11', activities: 44 }, { h: '12', activities: 28 }, { h: '13', activities: 46 },
  { h: '14', activities: 38 }, { h: '15', activities: 16 },
];
export const ATTENDANCE_BY_GRADE = [
  { grade: 'G1', pct: 95 }, { grade: 'G2', pct: 94 }, { grade: 'G3', pct: 92 }, { grade: 'G4', pct: 93 },
  { grade: 'G5', pct: 91 }, { grade: 'G6', pct: 90 }, { grade: 'G7', pct: 92 }, { grade: 'G8', pct: 86 },
  { grade: 'G9', pct: 90 }, { grade: 'G10', pct: 89 }, { grade: 'G11', pct: 91 }, { grade: 'G12', pct: 88 },
];
export const GATE_FLOW = [
  { h: '07:30', in: 120, out: 0 }, { h: '08:00', in: 640, out: 4 }, { h: '08:30', in: 520, out: 6 },
  { h: '09:00', in: 180, out: 8 }, { h: '10:00', in: 24, out: 12 }, { h: '11:00', in: 18, out: 20 },
  { h: '12:00', in: 30, out: 46 }, { h: '13:00', in: 22, out: 28 }, { h: '14:00', in: 14, out: 90 },
];
