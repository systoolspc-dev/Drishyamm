// ─────────────────────────────────────────────────────────────────────────────
// Student Activity — dummy-data layer (Campus / Education subpage, Prompt 3).
//
// FRONTEND-ONLY. A searchable student DIRECTORY drives the identity + the five
// summary cards; the deep per-tab analytics come from PROFILE (representative
// dummy data for whichever student is selected). Each export notes the future
// backend endpoint + fields.
// ─────────────────────────────────────────────────────────────────────────────

export const DEPARTMENTS = [
  { id: 'all', label: 'All Departments' },
  { id: 'cse', label: 'CSE' }, { id: 'it', label: 'IT' }, { id: 'ai', label: 'AI' },
  { id: 'ece', label: 'ECE' }, { id: 'mba', label: 'MBA' }, { id: 'law', label: 'LAW' },
];

export const SEMESTERS = [
  { id: 'all', label: 'All Semesters' },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: String(n), label: `Semester ${n}` })),
];

// Student directory — search / face-search resolves to one of these.
// Future backend: GET /campus/students?query&dept&sem  ·  POST /campus/students/face-search
export const DIRECTORY = [
  {
    id: 'STU-2043', name: 'Aarav Sharma', dept: 'cse', deptLabel: 'CSE', sem: 5,
    attendance: 91, activity: 'Attending Lecture', room: 'Eng · Room 101',
    risk: 18, riskBand: 'Low', productivity: 82, lastSeen: '2 min ago', lastSeenRoom: 'Eng · Room 101',
    status: 'in-class',
  },
  {
    id: 'STU-2088', name: 'Isha Verma', dept: 'ai', deptLabel: 'AI', sem: 3,
    attendance: 87, activity: 'Lab Practical', room: 'Eng · Lab 102',
    risk: 24, riskBand: 'Low', productivity: 88, lastSeen: '1 min ago', lastSeenRoom: 'Eng · Lab 102',
    status: 'in-lab',
  },
  {
    id: 'STU-1990', name: 'Kabir Singh', dept: 'it', deptLabel: 'IT', sem: 7,
    attendance: 72, activity: 'Studying', room: 'Library · Ground',
    risk: 58, riskBand: 'Medium', productivity: 69, lastSeen: '4 min ago', lastSeenRoom: 'Library · Ground',
    status: 'library',
  },
  {
    id: 'STU-2101', name: 'Ananya Iyer', dept: 'ece', deptLabel: 'ECE', sem: 3,
    attendance: 64, activity: 'In Transit', room: 'Eng · Corridor F2',
    risk: 71, riskBand: 'High', productivity: 58, lastSeen: 'just now', lastSeenRoom: 'Eng · Corridor F2',
    status: 'transit',
  },
  {
    id: 'STU-2205', name: 'Rohan Nair', dept: 'mba', deptLabel: 'MBA', sem: 2,
    attendance: 94, activity: 'Case Discussion', room: 'Mgmt · Room 101',
    risk: 12, riskBand: 'Low', productivity: 90, lastSeen: '3 min ago', lastSeenRoom: 'Mgmt · Room 101',
    status: 'in-class',
  },
  {
    id: 'STU-2150', name: 'Meera Joshi', dept: 'law', deptLabel: 'LAW', sem: 4,
    attendance: 55, activity: 'Not on campus', room: '—',
    risk: 82, riskBand: 'High', productivity: 44, lastSeen: 'yesterday 17:20', lastSeenRoom: 'Main Gate',
    status: 'absent',
  },
];

// Representative deep-profile analytics for the selected student.
// Future backend: GET /campus/students/:id/profile (per-tab sub-resources).
export const PROFILE = {
  // Attendance tab
  attendanceWeekly: [
    { w: 'W1', pct: 96 }, { w: 'W2', pct: 92 }, { w: 'W3', pct: 88 }, { w: 'W4', pct: 94 },
    { w: 'W5', pct: 90 }, { w: 'W6', pct: 85 }, { w: 'W7', pct: 91 }, { w: 'W8', pct: 93 },
  ],
  subjects: [
    { name: 'Data Structures', present: 41, total: 44, pct: 93 },
    { name: 'Operating Systems', present: 38, total: 44, pct: 86 },
    { name: 'DBMS', present: 42, total: 44, pct: 95 },
    { name: 'Computer Networks', present: 35, total: 44, pct: 80 },
    { name: 'Software Engineering', present: 40, total: 44, pct: 91 },
  ],

  // Movement tab — today's room-to-room path + time spent per zone
  movementToday: [
    { time: '09:00', room: 'Main Gate', activity: 'Campus entry', dwell: '2m' },
    { time: '09:10', room: 'Eng · Room 101', activity: 'Morning lecture', dwell: '1h 30m' },
    { time: '10:45', room: 'Cafeteria', activity: 'Break', dwell: '20m' },
    { time: '11:05', room: 'Eng · Lab 102', activity: 'Networks lab', dwell: '40m' },
    { time: '11:50', room: 'Library · Ground', activity: 'Self study', dwell: '55m' },
    { time: '12:45', room: 'Eng · Room 101', activity: 'Afternoon lecture', dwell: 'ongoing' },
  ],
  zoneTime: [
    { zone: 'Classrooms', minutes: 210 },
    { zone: 'Library', minutes: 55 },
    { zone: 'Labs', minutes: 40 },
    { zone: 'Cafeteria', minutes: 20 },
    { zone: 'Transit', minutes: 15 },
  ],

  // Library tab
  library: {
    visitsWeek: 6, hoursWeek: 11.5, booksOut: 3,
    weekly: [
      { d: 'Mon', hours: 2.0 }, { d: 'Tue', hours: 1.5 }, { d: 'Wed', hours: 2.5 },
      { d: 'Thu', hours: 1.0 }, { d: 'Fri', hours: 2.0 }, { d: 'Sat', hours: 2.5 }, { d: 'Sun', hours: 0 },
    ],
    books: [
      { title: 'Introduction to Algorithms', due: 'in 4 days' },
      { title: 'Computer Networks — Tanenbaum', due: 'in 9 days' },
      { title: 'Operating System Concepts', due: 'overdue 1 day' },
    ],
  },

  // Labs tab
  labs: {
    sessionsWeek: 5, hoursWeek: 8.0,
    perLab: [
      { lab: 'Networks Lab', sessions: 2, hours: 3.0, attendance: 100 },
      { lab: 'AI/ML Lab', sessions: 1, hours: 2.0, attendance: 90 },
      { lab: 'DBMS Lab', sessions: 1, hours: 1.5, attendance: 88 },
      { lab: 'OS Lab', sessions: 1, hours: 1.5, attendance: 95 },
    ],
  },

  // Activity Timeline tab — full day
  timeline: [
    { time: '12:45', activity: 'Afternoon lecture — Data Structures', room: 'Eng · Room 101', tone: 'ok' },
    { time: '11:50', activity: 'Self study', room: 'Library · Ground', tone: 'info' },
    { time: '11:05', activity: 'Networks lab practical', room: 'Eng · Lab 102', tone: 'ok' },
    { time: '10:45', activity: 'Break', room: 'Cafeteria', tone: 'info' },
    { time: '10:40', activity: 'Phone use detected (48s)', room: 'Eng · Room 101', tone: 'warn' },
    { time: '09:10', activity: 'Morning lecture — DBMS', room: 'Eng · Room 101', tone: 'ok' },
    { time: '09:00', activity: 'Campus entry', room: 'Main Gate', tone: 'ok' },
  ],

  // Behavior tab — indices 0–100 + observations
  behavior: {
    indices: [
      { label: 'Focus / Attention', value: 82 },
      { label: 'Class Participation', value: 74 },
      { label: 'Punctuality', value: 88 },
      { label: 'Phone Discipline', value: 63 },
      { label: 'Peer Interaction', value: 70 },
    ],
    notes: [
      { tone: 'ok', text: 'Consistent front-row seating in core subjects.' },
      { tone: 'warn', text: 'Phone usage flagged 4× this week during lectures.' },
      { tone: 'info', text: 'Library engagement up 18% vs last month.' },
    ],
  },

  // Alerts tab
  alerts: [
    { severity: 'medium', title: 'Attendance dip — Computer Networks', meta: '80% · below 85% target', since: '2 days ago' },
    { severity: 'low', title: 'Repeated phone use in lectures', meta: '4 incidents this week', since: 'today' },
    { severity: 'low', title: 'Overdue library book', meta: 'Operating System Concepts', since: '1 day ago' },
  ],

  // Reports tab
  reports: [
    { period: 'This week', attendance: 91, productivity: 82, risk: 'Low', generated: 'Today 09:00' },
    { period: 'Last week', attendance: 88, productivity: 79, risk: 'Low', generated: '7 days ago' },
    { period: 'This month', attendance: 90, productivity: 81, risk: 'Low', generated: '1 Jul 2026' },
    { period: 'This term', attendance: 89, productivity: 80, risk: 'Low', generated: '1 Jul 2026' },
  ],
};

export const STATUS_META = {
  'in-class': { label: 'In Class', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  'in-lab':   { label: 'In Lab', chip: 'bg-ai-soft text-ai-ink ring-ai-line', dot: 'bg-ai' },
  library:    { label: 'In Library', chip: 'bg-info-soft text-info-ink ring-info-line', dot: 'bg-info' },
  transit:    { label: 'In Transit', chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
  absent:     { label: 'Off Campus', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
};

export const RISK_META = {
  Low: 'text-success-ink', Medium: 'text-warning-ink', High: 'text-danger-ink',
};
