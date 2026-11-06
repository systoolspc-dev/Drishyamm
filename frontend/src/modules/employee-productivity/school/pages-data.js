// ─────────────────────────────────────────────────────────────────────────────
// School Activity Monitoring — SUBPAGE dummy data (K-12 vertical).
// FRONTEND-ONLY. Each block notes the future backend endpoint.
// ─────────────────────────────────────────────────────────────────────────────

// ── Attendance Intelligence ──────────────────────────────────────────────────
export const ATT_CARDS = [
  { key: 'present', label: 'Present', value: '1,486', sub: '91.7% of enrolled' },
  { key: 'absent', label: 'Absent', value: '134', sub: '8.3% of enrolled' },
  { key: 'late', label: 'Late', value: '42', sub: 'after 08:15' },
  { key: 'leave', label: 'On Leave', value: '18', sub: 'approved leave' },
  { key: 'pct', label: 'Attendance', value: '91.7%', sub: 'vs 90% target' },
  { key: 'notified', label: 'Parents Notified', value: '134', sub: 'auto SMS + app' },
];
export const ATT_TREND = [
  { d: 'Mon', pct: 92 }, { d: 'Tue', pct: 93 }, { d: 'Wed', pct: 90 }, { d: 'Thu', pct: 92 }, { d: 'Fri', pct: 91 }, { d: 'Sat', pct: 88 },
];
export const ATT_LATE = [
  { range: '0–5m', count: 20 }, { range: '5–15m', count: 14 }, { range: '15–30m', count: 6 }, { range: '30m+', count: 2 },
];
export const ATT_SECTIONS = [
  { section: 'Grade 6-A', present: 34, total: 36, pct: 94, teacher: 'Ms. Rao' },
  { section: 'Grade 7-C', present: 28, total: 36, pct: 78, teacher: 'Mr. Khan' },
  { section: 'Grade 9-B', present: 30, total: 33, pct: 91, teacher: 'Ms. Sen' },
  { section: 'Grade 2-A', present: 30, total: 32, pct: 94, teacher: 'Ms. Iyer' },
  { section: 'Grade 11-A', present: 26, total: 30, pct: 87, teacher: 'Mr. Gupta' },
];
export const ATT_ABSENTEES = [
  { name: 'Aarav Sharma', id: 'GRN-6042', grade: 'Grade 6-A', reason: 'Unreported', notified: true },
  { name: 'Isha Verma', id: 'GRN-7088', grade: 'Grade 7-C', reason: 'Sick (informed)', notified: true },
  { name: 'Kabir Singh', id: 'GRN-9190', grade: 'Grade 9-B', reason: 'Unreported', notified: true },
  { name: 'Sara Ali', id: 'GRN-2299', grade: 'Grade 2-A', reason: 'Family leave', notified: false },
];

// ── Safety & Security ────────────────────────────────────────────────────────
export const SAF_CARDS = [
  { key: 'alerts', label: 'Safety Alerts', value: '3', sub: '1 high · 2 low' },
  { key: 'restricted', label: 'Restricted-Zone Entries', value: '5', sub: 'today' },
  { key: 'unattended', label: 'Unattended-Child Alerts', value: '1', sub: 'resolved 0' },
  { key: 'perimeter', label: 'Perimeter Breaches', value: '0', sub: 'today' },
  { key: 'visitorsFlagged', label: 'Visitors Flagged', value: '1', sub: 'no appointment' },
  { key: 'drill', label: 'Drill Compliance', value: '100%', sub: 'last fire drill' },
];
export const SAF_BY_TYPE = [
  { type: 'Restricted zone', count: 5 }, { type: 'Unattended child', count: 1 }, { type: 'Loitering', count: 3 },
  { type: 'Visitor flag', count: 1 }, { type: 'Fight/scuffle', count: 0 },
];
export const SAF_HOURLY = [
  { h: '08', n: 2 }, { h: '09', n: 3 }, { h: '10', n: 4 }, { h: '11', n: 2 }, { h: '12', n: 5 }, { h: '13', n: 3 }, { h: '14', n: 1 },
];
export const SAF_ALERTS = [
  { severity: 'high', title: 'Child alone near restricted area', zone: 'Senior · Lab Store', since: '10:35', status: 'open' },
  { severity: 'low', title: 'Loitering near back gate', zone: 'Perimeter · Gate 3', since: '10:12', status: 'open' },
  { severity: 'low', title: 'Unregistered visitor near Primary', zone: 'Primary Wing', since: '09:48', status: 'ack' },
];
export const SAF_RESTRICTED_LOG = [
  { time: '10:35', person: 'Student (Grade 9)', zone: 'Lab Store', action: 'Alerted · escorted out' },
  { time: '09:20', person: 'Staff — Maintenance', zone: 'Rooftop', action: 'Authorized' },
  { time: '08:50', person: 'Unknown', zone: 'Pool deck', action: 'Alerted · false alarm' },
];

// ── Transport / Bus Monitoring ───────────────────────────────────────────────
export const TR_CARDS = [
  { key: 'onsite', label: 'Buses On-Site', value: '9', sub: 'of 12 fleet' },
  { key: 'enroute', label: 'En Route', value: '3', sub: 'inbound' },
  { key: 'students', label: 'Students on Buses', value: '128', sub: 'currently boarded' },
  { key: 'ontime', label: 'On-time', value: '92%', sub: 'arrivals today' },
  { key: 'delayed', label: 'Delayed', value: '1', sub: 'Route 4 · +12m' },
  { key: 'alerts', label: 'Boarding Alerts', value: '0', sub: 'missed boardings' },
];
export const TR_ARRIVALS = [
  { h: '07:00', arrivals: 1 }, { h: '07:15', arrivals: 3 }, { h: '07:30', arrivals: 4 }, { h: '07:45', arrivals: 5 }, { h: '08:00', arrivals: 6 }, { h: '08:15', arrivals: 2 },
];
export const TR_BUSES = [
  { id: 'Bus 01', route: 'R1 · Sector 12', driver: 'R. Kumar', status: 'on-site', eta: '—', onboard: 0, capacity: 45 },
  { id: 'Bus 04', route: 'R4 · Old Town', driver: 'S. Das', status: 'delayed', eta: '+12m', onboard: 38, capacity: 45 },
  { id: 'Bus 07', route: 'R7 · Riverside', driver: 'M. Ali', status: 'on-site', eta: '—', onboard: 0, capacity: 40 },
  { id: 'Bus 09', route: 'R9 · Hillview', driver: 'P. Nair', status: 'en-route', eta: '6m', onboard: 41, capacity: 45 },
  { id: 'Bus 11', route: 'R11 · Green Park', driver: 'V. Menon', status: 'en-route', eta: '9m', onboard: 49, capacity: 50 },
];

// ── Dismissal & Pickup ───────────────────────────────────────────────────────
export const DIS_CARDS = [
  { key: 'dismissed', label: 'Students Dismissed', value: '420', sub: 'of 1,486' },
  { key: 'awaiting', label: 'Awaiting Pickup', value: '86', sub: 'in holding area' },
  { key: 'verified', label: 'Guardians Verified', value: '402', sub: 'face / tag match' },
  { key: 'unauthorized', label: 'Unauthorized Attempts', value: '1', sub: 'blocked & flagged' },
  { key: 'wait', label: 'Avg Wait', value: '4m', sub: 'pickup queue' },
  { key: 'boarded', label: 'Buses Boarded', value: '6', sub: 'of 9' },
];
export const DIS_FLOW = [
  { t: '14:00', count: 40 }, { t: '14:10', count: 120 }, { t: '14:20', count: 160 }, { t: '14:30', count: 70 }, { t: '14:40', count: 30 },
];
export const DIS_MODES = [
  { mode: 'Bus', value: 210, color: '#F7983A' }, { mode: 'Parent pickup', value: 150, color: '#0ea5e9' },
  { mode: 'Walk', value: 42, color: '#10b981' }, { mode: 'Carpool', value: 18, color: '#8b5cf6' },
];
// `temporary-review` rows are temp-pass pickups awaiting operator review.
// `clean` = face + OTP + within-window all matched (auto-approvable); a false
// `clean` is a deviation (face-mismatch / outside-window / OTP fail / reused).
export const DIS_LOG = [
  { id: 'd1', student: 'Aarav Sharma (6-A)', guardian: 'Rajesh Sharma', mode: 'Parent pickup', status: 'verified', time: '14:12' },
  { id: 'd2', student: 'Isha Verma (7-C)', guardian: 'Route R4', mode: 'Bus', status: 'boarded', time: '14:18' },
  { id: 'd3', student: 'Rohan Mehta (5-B)', guardian: 'Sunita (temp pass)', mode: 'Parent pickup', status: 'temporary-review', time: '14:20', clean: true, reason: 'Clean match — face + OTP, in window' },
  { id: 'd4', student: 'Sara Ali (2-A)', guardian: 'Unknown adult', mode: 'Parent pickup', status: 'blocked', time: '14:22' },
  { id: 'd5', student: 'Nisha Rao (8-A)', guardian: 'Neighbour (temp pass)', mode: 'Parent pickup', status: 'temporary-review', time: '14:24', clean: false, reason: 'Outside pass window' },
  { id: 'd6', student: 'Kabir Singh (9-B)', guardian: 'Self (walk pass)', mode: 'Walk', status: 'verified', time: '14:25' },
];

// ── Visitor Management ───────────────────────────────────────────────────────
export const VIS_CARDS = [
  { key: 'oncampus', label: 'On-Campus', value: '14', sub: '2 pending check-out' },
  { key: 'today', label: 'Checked-in Today', value: '38', sub: 'across gates' },
  { key: 'pending', label: 'Pending Check-out', value: '2', sub: 'over expected time' },
  { key: 'preapproved', label: 'Pre-approved', value: '22', sub: 'of 38' },
  { key: 'flagged', label: 'Flagged', value: '1', sub: 'no appointment' },
  { key: 'duration', label: 'Avg Duration', value: '38m', sub: 'per visit' },
];
export const VIS_PURPOSE = [
  { purpose: 'Parent meeting', value: 16, color: '#F7983A' }, { purpose: 'Vendor', value: 8, color: '#0ea5e9' },
  { purpose: 'Interview', value: 6, color: '#10b981' }, { purpose: 'Contractor', value: 5, color: '#f59e0b' }, { purpose: 'Other', value: 3, color: '#64748b' },
];
export const VIS_HOURLY = [
  { h: '08', n: 6 }, { h: '09', n: 10 }, { h: '10', n: 8 }, { h: '11', n: 6 }, { h: '12', n: 4 }, { h: '13', n: 4 },
];
export const VIS_LOG = [
  { name: 'Mr. Sharma', purpose: 'Parent meeting', host: 'Ms. Rao (6-A)', checkIn: '09:40', checkOut: '—', badge: 'V-102', status: 'in' },
  { name: 'BlueByte Supplies', purpose: 'Vendor', host: 'Admin Office', checkIn: '09:10', checkOut: '09:55', badge: 'V-098', status: 'out' },
  { name: 'A. Fernandes', purpose: 'Interview', host: 'HR', checkIn: '10:05', checkOut: '—', badge: 'V-104', status: 'in' },
  { name: 'Unknown', purpose: 'No appointment', host: '—', checkIn: '10:20', checkOut: '—', badge: '—', status: 'flagged' },
];

// ── Student Activity (directory + profile) ───────────────────────────────────
export const STUDENT_STATUS = {
  'in-class': { label: 'In Class', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  playground: { label: 'Playground', chip: 'bg-info-soft text-info-ink ring-info-line', dot: 'bg-info' },
  transit: { label: 'In Transit', chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
  absent: { label: 'Absent', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
};
export const STUDENTS = [
  { id: 'GRN-6042', name: 'Aarav Sharma', grade: 'Grade 6', section: 'A', attendance: 94, activity: 'Attending Maths', room: 'Middle · Room M-6A', punctuality: 96, lastSeen: '2 min ago', lastRoom: 'Middle · Room M-6A', status: 'in-class' },
  { id: 'GRN-7088', name: 'Isha Verma', grade: 'Grade 7', section: 'C', attendance: 88, activity: 'Library period', room: 'Middle · Library', punctuality: 90, lastSeen: '1 min ago', lastRoom: 'Middle · Library', status: 'in-class' },
  { id: 'GRN-9190', name: 'Kabir Singh', grade: 'Grade 9', section: 'B', attendance: 76, activity: 'PE / Sports', room: 'Sports · Main Field', punctuality: 72, lastSeen: 'just now', lastRoom: 'Sports · Main Field', status: 'playground' },
  { id: 'GRN-2299', name: 'Sara Ali', grade: 'Grade 2', section: 'A', attendance: 95, activity: 'In transit', room: 'Primary · Corridor', punctuality: 94, lastSeen: 'just now', lastRoom: 'Primary · Corridor', status: 'transit' },
  { id: 'GRN-1140', name: 'Meera Joshi', grade: 'Grade 11', section: 'A', attendance: 55, activity: 'Not on campus', room: '—', punctuality: 60, lastSeen: 'yesterday', lastRoom: 'Main Gate', status: 'absent' },
];
export const STUDENT_PROFILE = {
  attendanceWeekly: [{ w: 'W1', pct: 96 }, { w: 'W2', pct: 92 }, { w: 'W3', pct: 90 }, { w: 'W4', pct: 94 }, { w: 'W5', pct: 91 }, { w: 'W6', pct: 93 }],
  movementToday: [
    { time: '08:05', room: 'Main Gate', activity: 'Campus entry', dwell: '2m' },
    { time: '08:15', room: 'Assembly Ground', activity: 'Morning assembly', dwell: '20m' },
    { time: '08:40', room: 'Middle · Room M-6A', activity: 'Class', dwell: '2h' },
    { time: '10:45', room: 'Cafeteria', activity: 'Break', dwell: '20m' },
    { time: '11:05', room: 'Middle · Room M-6A', activity: 'Class', dwell: 'ongoing' },
  ],
  timeline: [
    { time: '10:45', activity: 'Break — Cafeteria', room: 'Cafeteria', tone: 'info' },
    { time: '08:40', activity: 'Class — Maths', room: 'Room M-6A', tone: 'ok' },
    { time: '08:15', activity: 'Morning assembly', room: 'Assembly Ground', tone: 'ok' },
    { time: '08:05', activity: 'Campus entry', room: 'Main Gate', tone: 'ok' },
  ],
  alerts: [
    { severity: 'low', title: 'Left assembly early', meta: '3 min before end', since: 'today' },
  ],
};

// ── Class / Room Analytics ───────────────────────────────────────────────────
export const CLASS_ROOMS = [
  { id: 'm6a', label: 'Room M-6A', wing: 'middle', wingLabel: 'Middle Wing', grade: 'Grade 6-A', capacity: 40, occupancy: 34, attendance: 94, utilization: 78, status: 'in-session' },
  { id: 's-lab', label: 'Computer Lab', wing: 'senior', wingLabel: 'Senior Wing', grade: 'Grade 9-B', capacity: 36, occupancy: 26, attendance: 90, utilization: 71, status: 'in-session' },
  { id: 'p2a', label: 'Room P-2A', wing: 'primary', wingLabel: 'Primary Wing', grade: 'Grade 2-A', capacity: 32, occupancy: 30, attendance: 94, utilization: 82, status: 'in-session' },
  { id: 's9a', label: 'Room S-9A', wing: 'senior', wingLabel: 'Senior Wing', grade: 'Grade 9-A', capacity: 34, occupancy: 0, attendance: 0, utilization: 44, status: 'free' },
];
export const CLASS_OCCUPANCY = [
  { h: '08:00', occupancy: 4 }, { h: '09:00', occupancy: 34 }, { h: '10:00', occupancy: 34 }, { h: '11:00', occupancy: 32 }, { h: '12:00', occupancy: 10 }, { h: '13:00', occupancy: 33 }, { h: '14:00', occupancy: 28 },
];
export const CLASS_SCHEDULE = [
  { time: '08:40', subject: 'Mathematics', teacher: 'Ms. Rao', present: 34, status: 'ongoing' },
  { time: '09:40', subject: 'Science', teacher: 'Mr. Khan', present: 33, status: 'upcoming' },
  { time: '10:40', subject: 'English', teacher: 'Ms. Sen', present: 0, status: 'upcoming' },
];

// ── Reports ──────────────────────────────────────────────────────────────────
export const SCH_REPORT_TYPES = [
  { key: 'attendance', title: 'Attendance Report', desc: 'Present / absent / late by grade & section', stat: '91.7% avg' },
  { key: 'safety', title: 'Safety Report', desc: 'Alerts, restricted-zone & drill compliance', stat: '3 open' },
  { key: 'transport', title: 'Transport Report', desc: 'Bus arrivals, boarding & on-time %', stat: '12 buses' },
  { key: 'visitor', title: 'Visitor Report', desc: 'Check-in/out log & flagged visits', stat: '38 today' },
  { key: 'dismissal', title: 'Dismissal Report', desc: 'Pickup verification & unauthorized attempts', stat: '420 out' },
  { key: 'student', title: 'Student Report', desc: 'Per-student attendance, movement & flags', stat: '1,620' },
];
export const SCH_RECENT_REPORTS = [
  { name: 'Daily Attendance — Today', type: 'Attendance', period: 'Daily', generated: 'Today 08:30', size: '210 KB', format: 'PDF' },
  { name: 'Weekly Safety Summary — W29', type: 'Safety', period: 'Weekly', generated: 'Yesterday', size: '540 KB', format: 'Excel' },
  { name: 'Transport On-time — Today', type: 'Transport', period: 'Daily', generated: 'Today 08:20', size: '180 KB', format: 'CSV' },
  { name: 'Visitor Log — This week', type: 'Visitor', period: 'Weekly', generated: '2 days ago', size: '320 KB', format: 'PDF' },
];

// ── Guardian Registry ────────────────────────────────────────────────────────
// The source-of-truth pickup-verification checks against.
// Future backend: GET/POST /school/guardians · PATCH /school/guardians/:id/status
export const GUARDIAN_RELATIONSHIPS = ['Parent', 'Grandparent', 'Guardian', 'Authorized Driver', 'Relative'];
export const GUARDIANS = [
  { id: 'g1', name: 'Rajesh Sharma', relationship: 'Parent', students: ['Aarav Sharma'], phone: '+91 98xxx 12001', faceEnrolled: true, status: 'verified' },
  { id: 'g2', name: 'Sunita Sharma', relationship: 'Parent', students: ['Aarav Sharma'], phone: '+91 98xxx 12002', faceEnrolled: true, status: 'verified' },
  { id: 'g3', name: 'Vikram Verma', relationship: 'Parent', students: ['Isha Verma'], phone: '+91 98xxx 12003', faceEnrolled: true, status: 'verified' },
  { id: 'g4', name: 'Mohan Das', relationship: 'Authorized Driver', students: ['Isha Verma', 'Kabir Singh'], phone: '+91 98xxx 12004', faceEnrolled: false, status: 'pending' },
  { id: 'g5', name: 'Anita Singh', relationship: 'Grandparent', students: ['Kabir Singh'], phone: '+91 98xxx 12005', faceEnrolled: true, status: 'verified' },
  { id: 'g6', name: 'Imran Ali', relationship: 'Parent', students: ['Sara Ali'], phone: '+91 98xxx 12006', faceEnrolled: true, status: 'verified' },
  { id: 'g7', name: 'Faisal Rehman', relationship: 'Relative', students: ['Sara Ali'], phone: '+91 98xxx 12007', faceEnrolled: false, status: 'blocked' },
];

// Temporary pickup passes — the "middle tier": pre-authorized so they never
// hard-block, but surfaced for operator review.
// Future backend: GET/POST /school/passes · PATCH /school/passes/:id/revoke
export const TEMP_PASSES = [
  { id: 'tp1', person: 'Sunita (aunt)', phone: '+91 98xxx 34001', students: ['Rohan Mehta'], reason: 'Parent travelling', window: 'Today 13:00–15:00 (one-time)', otp: '482913', status: 'active' },
  { id: 'tp2', person: 'Mr. Roy (neighbour)', phone: '+91 98xxx 34002', students: ['Nisha Rao'], reason: 'Emergency pickup', window: 'Today 14:00–14:30 (one-time)', otp: '170582', status: 'active' },
  { id: 'tp3', person: 'Anil (driver)', phone: '+91 98xxx 34003', students: ['Isha Verma'], reason: 'Regular driver on leave', window: '22–24 Jul', otp: '935471', status: 'used' },
  { id: 'tp4', person: 'Grandfather', phone: '+91 98xxx 34004', students: ['Aarav Sharma'], reason: 'One-off', window: 'Yesterday', otp: '—', status: 'expired' },
];

// Audit trail — issue / use / ack / escalate / block (who · when · why).
// Future backend: GET /school/pickup/audit
export const PASS_AUDIT = [
  { id: 'au1', ts: '14:24', actor: 'Gate AI', action: 'Flagged', detail: 'Neighbour pickup outside pass window — Nisha Rao' },
  { id: 'au2', ts: '14:20', actor: 'Gate AI', action: 'Matched', detail: 'Temp pass verified (face + OTP) — Rohan Mehta' },
  { id: 'au3', ts: '13:02', actor: 'Parent — R. Mehta', action: 'Issued', detail: 'Temporary pass for Sunita (Rohan Mehta)' },
  { id: 'au4', ts: '09:10', actor: 'Admin', action: 'Blocked', detail: 'Faisal Rehman blocked from Sara Ali pickup' },
];

// AI-flagged pickup attempts that failed verification.
// Future backend: GET /school/pickup/unauthorized
export const UNKNOWN_PICKUPS = [
  { id: 'u1', student: 'Sara Ali (2-A)', attemptedBy: 'Blocked guardian', gate: 'Gate 1', time: '14:22', action: 'Blocked & flagged' },
  { id: 'u2', student: 'Kabir Singh (9-B)', attemptedBy: 'Face mismatch', gate: 'Gate 2', time: '14:18', action: 'Escalated to security' },
  { id: 'u3', student: 'Aarav Sharma (6-A)', attemptedBy: 'Unknown', gate: 'Gate 1', time: '14:05', action: 'Blocked & flagged' },
];

// shared status chips
export const STATUS_CHIP = {
  pending: 'bg-warning-soft text-warning-ink ring-warning-line', unknown: 'bg-surface-muted text-fg-muted ring-line',
  'temporary-review': 'bg-warning-soft text-warning-ink ring-warning-line', approved: 'bg-success-soft text-success-ink ring-success-line',
  escalated: 'bg-danger-soft text-danger-ink ring-danger-line', active: 'bg-info-soft text-info-ink ring-info-line',
  used: 'bg-surface-muted text-fg-muted ring-line', expired: 'bg-surface-muted text-fg-muted ring-line', revoked: 'bg-danger-soft text-danger-ink ring-danger-line',
  open: 'bg-danger-soft text-danger-ink ring-danger-line', ack: 'bg-warning-soft text-warning-ink ring-warning-line',
  verified: 'bg-success-soft text-success-ink ring-success-line', boarded: 'bg-info-soft text-info-ink ring-info-line',
  blocked: 'bg-danger-soft text-danger-ink ring-danger-line', flagged: 'bg-danger-soft text-danger-ink ring-danger-line',
  in: 'bg-success-soft text-success-ink ring-success-line', out: 'bg-surface-muted text-fg-muted ring-line',
  'on-site': 'bg-success-soft text-success-ink ring-success-line', 'en-route': 'bg-info-soft text-info-ink ring-info-line',
  delayed: 'bg-warning-soft text-warning-ink ring-warning-line', 'in-session': 'bg-success-soft text-success-ink ring-success-line',
  free: 'bg-surface-muted text-fg-muted ring-line', ongoing: 'bg-success-soft text-success-ink ring-success-line',
  upcoming: 'bg-info-soft text-info-ink ring-info-line',
};
