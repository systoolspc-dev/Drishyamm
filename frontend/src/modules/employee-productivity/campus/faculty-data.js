// ─────────────────────────────────────────────────────────────────────────────
// Faculty Activity — dummy-data layer (Campus / Education subpage, Prompt 4).
//
// FRONTEND-ONLY. Mirrors the Student Activity page: a searchable DIRECTORY drives
// identity + summary cards; deep faculty analytics (lectures, teaching/office
// hours, room utilization, student interaction, attendance) come from PROFILE.
// ─────────────────────────────────────────────────────────────────────────────

export const DEPARTMENTS = [
  { id: 'all', label: 'All Departments' },
  { id: 'cse', label: 'CSE' }, { id: 'it', label: 'IT' }, { id: 'ai', label: 'AI' },
  { id: 'ece', label: 'ECE' }, { id: 'mba', label: 'MBA' }, { id: 'law', label: 'LAW' },
];

export const DESIGNATIONS = [
  { id: 'all', label: 'All Designations' },
  { id: 'prof', label: 'Professor' },
  { id: 'assoc', label: 'Associate Professor' },
  { id: 'asst', label: 'Assistant Professor' },
];

// Faculty directory — search / face-search resolves to one of these.
// Future backend: GET /campus/faculty?query&dept&designation
export const DIRECTORY = [
  {
    id: 'FAC-104', name: 'Dr. Neha Rao', dept: 'mba', deptLabel: 'Management', designation: 'prof', designationLabel: 'Professor',
    attendance: 96, activity: 'Taking Class', room: 'Mgmt · Room 101',
    teachingToday: '4h', teachingWeek: '18h', officeStatus: 'Next 15:00', officeRoom: 'Faculty Room F1',
    lastSeen: '3 min ago', lastSeenRoom: 'Mgmt · Room 101', status: 'in-class',
  },
  {
    id: 'FAC-087', name: 'Dr. Arjun Menon', dept: 'cse', deptLabel: 'CSE', designation: 'assoc', designationLabel: 'Associate Professor',
    attendance: 92, activity: 'Office Hours', room: 'Eng · Faculty Room F2',
    teachingToday: '2h', teachingWeek: '14h', officeStatus: 'In office', officeRoom: 'Faculty Room F2',
    lastSeen: '1 min ago', lastSeenRoom: 'Eng · Faculty Room F2', status: 'office',
  },
  {
    id: 'FAC-152', name: 'Dr. Kavya Reddy', dept: 'ai', deptLabel: 'AI', designation: 'asst', designationLabel: 'Assistant Professor',
    attendance: 89, activity: 'In Meeting', room: 'Eng · Seminar 103',
    teachingToday: '3h', teachingWeek: '16h', officeStatus: 'Next 16:00', officeRoom: 'Faculty Room F3',
    lastSeen: '6 min ago', lastSeenRoom: 'Eng · Seminar 103', status: 'meeting',
  },
  {
    id: 'FAC-063', name: 'Prof. Sanjay Gupta', dept: 'ece', deptLabel: 'ECE', designation: 'prof', designationLabel: 'Professor',
    attendance: 94, activity: 'Taking Class', room: 'Eng · Room 201',
    teachingToday: '5h', teachingWeek: '21h', officeStatus: 'Next 15:30', officeRoom: 'Faculty Room F2',
    lastSeen: 'just now', lastSeenRoom: 'Eng · Room 201', status: 'in-class',
  },
  {
    id: 'FAC-119', name: 'Dr. Fatima Khan', dept: 'law', deptLabel: 'LAW', designation: 'assoc', designationLabel: 'Associate Professor',
    attendance: 85, activity: 'Not on campus', room: '—',
    teachingToday: '0h', teachingWeek: '12h', officeStatus: 'On leave', officeRoom: '—',
    lastSeen: 'yesterday 16:40', lastSeenRoom: 'Main Gate', status: 'off',
  },
  {
    id: 'FAC-201', name: 'Dr. Rahul Desai', dept: 'it', deptLabel: 'IT', designation: 'asst', designationLabel: 'Assistant Professor',
    attendance: 91, activity: 'Lab Supervision', room: 'Eng · Lab 202',
    teachingToday: '3h', teachingWeek: '17h', officeStatus: 'Next 14:00', officeRoom: 'Faculty Room F2',
    lastSeen: '4 min ago', lastSeenRoom: 'Eng · Lab 202', status: 'in-class',
  },
];

// Representative deep-profile analytics for the selected faculty member.
// Future backend: GET /campus/faculty/:id/profile (per-tab sub-resources).
export const PROFILE = {
  // Lecture Timeline — today's scheduled/held lectures
  lectures: [
    { time: '09:00–10:00', subject: 'Marketing Management', room: 'Mgmt · Room 101', batch: 'MBA Sem 2', students: 44, status: 'done' },
    { time: '10:15–11:15', subject: 'Consumer Behavior', room: 'Mgmt · Room 101', batch: 'MBA Sem 2', students: 42, status: 'done' },
    { time: '11:15–12:15', subject: 'Case Discussion', room: 'Mgmt · Room 101', batch: 'MBA Sem 2', students: 44, status: 'ongoing' },
    { time: '14:00–15:00', subject: 'Strategic Management', room: 'Mgmt · Room 203', batch: 'MBA Sem 4', students: 38, status: 'upcoming' },
    { time: '16:00–17:00', subject: 'Elective Seminar', room: 'Mgmt · Seminar Hall', batch: 'MBA Sem 4', students: 26, status: 'upcoming' },
  ],

  // Teaching Hours
  teaching: {
    todayHours: 4, weekHours: 18, targetWeek: 20,
    weekly: [
      { d: 'Mon', hours: 4 }, { d: 'Tue', hours: 3 }, { d: 'Wed', hours: 5 },
      { d: 'Thu', hours: 2 }, { d: 'Fri', hours: 4 }, { d: 'Sat', hours: 0 }, { d: 'Sun', hours: 0 },
    ],
  },

  // Office Hours
  office: {
    studentsMetWeek: 14, hoursWeek: 5,
    slots: [
      { slot: 'Mon 15:00–16:00', status: 'booked', note: '3 students' },
      { slot: 'Tue 15:00–16:00', status: 'free', note: 'open' },
      { slot: 'Wed 15:00–16:00', status: 'held', note: 'today' },
      { slot: 'Thu 15:00–16:00', status: 'booked', note: '2 students' },
      { slot: 'Fri 15:00–16:00', status: 'free', note: 'open' },
    ],
  },

  // Room Utilization
  rooms: [
    { room: 'Mgmt · Room 101', hours: 12, utilizationPct: 78 },
    { room: 'Mgmt · Room 203', hours: 5, utilizationPct: 41 },
    { room: 'Mgmt · Seminar Hall', hours: 4, utilizationPct: 33 },
    { room: 'Mgmt · Auditorium', hours: 2, utilizationPct: 15 },
  ],

  // Student Interaction
  interaction: {
    studentsTaught: 168, queriesHandled: 37, mentees: 12,
    weekly: [
      { d: 'Mon', interactions: 22 }, { d: 'Tue', interactions: 18 }, { d: 'Wed', interactions: 26 },
      { d: 'Thu', interactions: 14 }, { d: 'Fri', interactions: 20 }, { d: 'Sat', interactions: 6 }, { d: 'Sun', interactions: 0 },
    ],
    topBatches: [
      { batch: 'MBA Sem 2', students: 44 },
      { batch: 'MBA Sem 4', students: 38 },
      { batch: 'BBA Sem 1', students: 52 },
    ],
  },

  // Faculty's own Attendance
  attendance: {
    punctuality: 94, leavesTaken: 2,
    weekly: [
      { w: 'W1', pct: 100 }, { w: 'W2', pct: 96 }, { w: 'W3', pct: 92 }, { w: 'W4', pct: 98 },
      { w: 'W5', pct: 94 }, { w: 'W6', pct: 90 }, { w: 'W7', pct: 96 }, { w: 'W8', pct: 96 },
    ],
  },

  alerts: [
    { severity: 'medium', title: 'Overlapping office-hour booking', meta: 'Thu 15:00 · double booked', since: '1 day ago' },
    { severity: 'low', title: 'Room 203 under-utilized', meta: '41% this week', since: 'today' },
  ],

  reports: [
    { period: 'This week', teachingHours: 18, utilization: 66, attendance: 96, generated: 'Today 09:00' },
    { period: 'Last week', teachingHours: 20, utilization: 70, attendance: 94, generated: '7 days ago' },
    { period: 'This month', teachingHours: 78, utilization: 68, attendance: 95, generated: '1 Jul 2026' },
    { period: 'This term', teachingHours: 310, utilization: 67, attendance: 95, generated: '1 Jul 2026' },
  ],
};

export const STATUS_META = {
  'in-class': { label: 'In Class', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  office:     { label: 'In Office', chip: 'bg-info-soft text-info-ink ring-info-line', dot: 'bg-info' },
  meeting:    { label: 'In Meeting', chip: 'bg-ai-soft text-ai-ink ring-ai-line', dot: 'bg-ai' },
  off:        { label: 'Off Campus', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
};

export const LECTURE_STATUS = {
  done:     { label: 'Done', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
  ongoing:  { label: 'Ongoing', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  upcoming: { label: 'Upcoming', chip: 'bg-info-soft text-info-ink ring-info-line', dot: 'bg-info' },
};
