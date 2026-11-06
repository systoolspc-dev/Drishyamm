// ─────────────────────────────────────────────────────────────────────────────
// Room Analytics — dummy-data layer (Campus / Education subpage, Prompt 6).
//
// "Every classroom has intelligence." A ROOMS directory (filterable by Building →
// Department → Room) drives the six cards; the selected room's deep analytics —
// occupancy / activity / lecture / teacher timelines and session tables — come
// from PROFILE. FRONTEND-ONLY; endpoint/field contracts noted inline.
// ─────────────────────────────────────────────────────────────────────────────

// Rooms directory. Card metrics live per-room.
// Future backend: GET /campus/rooms?building&department
export const ROOMS = [
  { id: 'r-101', label: 'Room 101', building: 'eng', buildingLabel: 'Engineering Block', dept: 'cse', deptLabel: 'CSE',
    capacity: 70, occupancy: 58, attendance: 88, utilization: 74, avgStay: '52m', idleTime: '2h 10m', status: 'in-session' },
  { id: 'r-102', label: 'Lab 102 (AI/ML)', building: 'eng', buildingLabel: 'Engineering Block', dept: 'ai', deptLabel: 'AI',
    capacity: 40, occupancy: 38, attendance: 95, utilization: 82, avgStay: '1h 05m', idleTime: '1h 20m', status: 'in-session' },
  { id: 'r-201', label: 'Room 201', building: 'eng', buildingLabel: 'Engineering Block', dept: 'ece', deptLabel: 'ECE',
    capacity: 65, occupancy: 0, attendance: 0, utilization: 41, avgStay: '—', idleTime: '3h 40m', status: 'free' },
  { id: 'r-m101', label: 'Case Study Room 101', building: 'mgmt', buildingLabel: 'Management Block', dept: 'mba', deptLabel: 'MBA',
    capacity: 50, occupancy: 44, attendance: 92, utilization: 70, avgStay: '48m', idleTime: '1h 55m', status: 'in-session' },
  { id: 'r-maud', label: 'Auditorium', building: 'mgmt', buildingLabel: 'Management Block', dept: 'mba', deptLabel: 'MBA',
    capacity: 240, occupancy: 96, attendance: 80, utilization: 38, avgStay: '1h 12m', idleTime: '4h 05m', status: 'in-session' },
];

// Representative deep analytics for the selected room.
// Future backend: GET /campus/rooms/:id/analytics
export const PROFILE = {
  // Occupancy Timeline — headcount through the day (capacity shown as context).
  occupancyTimeline: [
    { h: '08:00', occupancy: 2 }, { h: '09:00', occupancy: 48 }, { h: '10:00', occupancy: 58 },
    { h: '11:00', occupancy: 55 }, { h: '12:00', occupancy: 12 }, { h: '13:00', occupancy: 6 },
    { h: '14:00', occupancy: 60 }, { h: '15:00', occupancy: 44 }, { h: '16:00', occupancy: 10 },
  ],

  // Day window shared by all three band timelines.
  dayStart: '08:00', dayEnd: '17:00',

  // Activity Timeline — what the room was doing, block by block.
  activity: [
    { start: '08:00', end: '09:00', label: 'Idle', type: 'idle' },
    { start: '09:00', end: '10:30', label: 'Lecture', type: 'lecture' },
    { start: '10:30', end: '10:50', label: 'Break', type: 'break' },
    { start: '10:50', end: '12:00', label: 'Lecture', type: 'lecture' },
    { start: '12:00', end: '13:00', label: 'Idle', type: 'idle' },
    { start: '13:00', end: '14:30', label: 'Lab', type: 'lab' },
    { start: '14:30', end: '16:00', label: 'Lecture', type: 'lecture' },
    { start: '16:00', end: '17:00', label: 'Idle', type: 'idle' },
  ],

  // Lecture Timeline — scheduled sessions (gaps = free periods).
  lectures: [
    { start: '09:00', end: '10:00', label: 'DBMS · CSE-A', type: 'lecture' },
    { start: '10:00', end: '11:00', label: 'OS · CSE-A', type: 'lecture' },
    { start: '11:00', end: '12:00', label: 'DS · CSE-B', type: 'lecture' },
    { start: '14:00', end: '15:00', label: 'CN · CSE-A', type: 'lecture' },
    { start: '15:00', end: '16:00', label: 'SE · CSE-B', type: 'lecture' },
  ],

  // Teacher Timeline — who occupied the room across the day.
  teachers: [
    { start: '09:00', end: '11:00', label: 'Dr. Neha Rao', type: 't1' },
    { start: '11:00', end: '12:00', label: 'Dr. Menon', type: 't2' },
    { start: '14:00', end: '16:00', label: 'Prof. Gupta', type: 't3' },
  ],

  // Session tables
  currentSession: {
    subject: 'Data Structures', teacher: 'Dr. Neha Rao', batch: 'CSE-A · Sem 5',
    time: '14:30 – 16:00', occupancy: 58, capacity: 70, attendance: 88, status: 'ongoing',
  },
  previousSession: {
    subject: 'Operating Systems', teacher: 'Dr. Menon', batch: 'CSE-A · Sem 5',
    time: '10:50 – 12:00', occupancy: 61, capacity: 70, attendance: 91, status: 'ended',
  },
  history: [
    { time: '09:00', subject: 'DBMS', teacher: 'Dr. Neha Rao', batch: 'CSE-A', attendance: 93, occupancy: 65, duration: '1h' },
    { time: '10:00', subject: 'Operating Systems', teacher: 'Dr. Menon', batch: 'CSE-A', attendance: 91, occupancy: 61, duration: '1h' },
    { time: '11:00', subject: 'Data Structures', teacher: 'Dr. Neha Rao', batch: 'CSE-B', attendance: 86, occupancy: 58, duration: '1h' },
    { time: '13:00', subject: 'AI/ML Lab', teacher: 'Dr. Kavya Reddy', batch: 'AI', attendance: 95, occupancy: 38, duration: '1h 30m' },
    { time: '14:30', subject: 'Computer Networks', teacher: 'Prof. Gupta', batch: 'CSE-A', attendance: 88, occupancy: 58, duration: 'ongoing' },
  ],
};

// Band segment colours by type.
export const BAND_TYPE = {
  lecture: { bg: '#F7983A', text: '#fff' },
  lab: { bg: '#8b5cf6', text: '#fff' },
  break: { bg: '#f59e0b', text: '#fff' },
  idle: { bg: 'var(--surface-muted)', text: 'var(--text-subtle)' },
  t1: { bg: '#F7983A', text: '#fff' },
  t2: { bg: '#0ea5e9', text: '#fff' },
  t3: { bg: '#10b981', text: '#fff' },
};

export const ROOM_STATUS = {
  'in-session': { label: 'In Session', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  free: { label: 'Free', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
  idle: { label: 'Idle', chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
};
