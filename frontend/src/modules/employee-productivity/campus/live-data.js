// ─────────────────────────────────────────────────────────────────────────────
// Live Activity Intelligence — dummy-data layer (Campus / Education subpage).
//
// FRONTEND-ONLY. This page shows what the AI currently *understands* to be
// happening on campus (classified activities, per-person tracking sessions, the
// reasoning behind each classification) — NOT raw CCTV. Every export documents
// the future backend endpoint + fields next to the dummy values.
// ─────────────────────────────────────────────────────────────────────────────

// People the AI is actively tracking. The right drawer, the timeline, active
// sessions and recent events all reference these by id so the page stays
// internally consistent.
// Future backend: GET /campus/activity/tracks?active=true
export const PEOPLE = {
  p1: {
    id: 'p1', name: 'Aarav Sharma', role: 'Student · CSE 3rd yr', category: 'student',
    activity: 'Attending Lecture', room: 'Eng · Room 101', prevRoom: 'Eng · Corridor F1',
    duration: '42m', confidence: 96,
    timeline: [
      { time: '11:00', room: 'Eng · Room 101', activity: 'Entered — lecture began' },
      { time: '10:52', room: 'Eng · Corridor F1', activity: 'In transit' },
      { time: '10:30', room: 'Eng · Lab G-02', activity: 'Networks lab ended' },
      { time: '09:00', room: 'Main Gate', activity: 'Campus entry' },
    ],
    alerts: [],
  },
  p2: {
    id: 'p2', name: 'Dr. Neha Rao', role: 'Faculty · Management', category: 'faculty',
    activity: 'Taking Class', room: 'Mgmt · Room 101', prevRoom: 'Mgmt · Faculty Room',
    duration: '27m', confidence: 98,
    timeline: [
      { time: '11:15', room: 'Mgmt · Room 101', activity: 'Case discussion started' },
      { time: '11:05', room: 'Mgmt · Faculty Room', activity: 'Preparing' },
      { time: '08:40', room: 'Main Gate', activity: 'Campus entry' },
    ],
    alerts: [],
  },
  p3: {
    id: 'p3', name: 'Isha Verma', role: 'Student · AI 2nd yr', category: 'student',
    activity: 'Lab Practical', room: 'Eng · Lab 102', prevRoom: 'Eng · Room 201',
    duration: '58m', confidence: 92,
    timeline: [
      { time: '10:30', room: 'Eng · Lab 102', activity: 'AI/ML practical started' },
      { time: '10:20', room: 'Eng · Room 201', activity: 'Lecture ended' },
      { time: '09:10', room: 'Main Gate', activity: 'Campus entry' },
    ],
    alerts: [],
  },
  p4: {
    id: 'p4', name: 'Kabir Singh', role: 'Student · IT 3rd yr', category: 'student',
    activity: 'Studying', room: 'Library · Ground', prevRoom: 'Cafeteria',
    duration: '1h 12m', confidence: 89,
    timeline: [
      { time: '10:18', room: 'Library · Ground', activity: 'Reading — self study' },
      { time: '10:05', room: 'Cafeteria', activity: 'Break' },
      { time: '08:55', room: 'Main Gate', activity: 'Campus entry' },
    ],
    alerts: [
      { severity: 'low', title: 'Long stay in Reading Hall', meta: '1h 12m · within policy' },
    ],
  },
  p5: {
    id: 'p5', name: 'Rahul Mehta', role: 'Staff · Security', category: 'staff',
    activity: 'Patrolling', room: 'Mgmt · Ground', prevRoom: 'Main Gate',
    duration: '15m', confidence: 90,
    timeline: [
      { time: '11:27', room: 'Mgmt · Ground', activity: 'Patrol round' },
      { time: '11:12', room: 'Main Gate', activity: 'Shift check-in' },
    ],
    alerts: [],
  },
  p6: {
    id: 'p6', name: 'Ananya Iyer', role: 'Student · ECE 2nd yr', category: 'student',
    activity: 'In Transit', room: 'Eng · Corridor F2', prevRoom: 'Eng · Room 201',
    duration: '3m', confidence: 84,
    timeline: [
      { time: '11:39', room: 'Eng · Corridor F2', activity: 'Moving between rooms' },
      { time: '11:36', room: 'Eng · Room 201', activity: 'Thermodynamics ended' },
      { time: '09:05', room: 'Main Gate', activity: 'Campus entry' },
    ],
    alerts: [{ severity: 'medium', title: 'Left class early', meta: 'Room 201 · 4m before end' }],
  },
};

// Activity Summary tiles (top strip).
// Future backend: GET /campus/activity/live/summary
export const LIVE_SUMMARY = [
  { key: 'sessions', label: 'Active Sessions', value: '68', sub: 'tracked right now' },
  { key: 'people', label: 'People Tracked', value: '2,847', sub: 'across 42 rooms' },
  { key: 'confidence', label: 'Avg Confidence', value: '94', unit: '%', sub: 'classification certainty' },
  { key: 'rooms', label: 'Rooms Active', value: '42', sub: 'of 96 monitored' },
  { key: 'alerts', label: 'Live Alerts', value: '4', sub: '1 medium · 3 low', tone: 'warn' },
];

// Live Activity Timeline — newest first. `personId` (when present) makes the row
// open the person drawer; group rows are anonymous crowd classifications.
// Future backend: GET /campus/activity/live/timeline (socket-updated)
export const LIVE_TIMELINE = [
  { id: 't1', time: '11:42:06', personId: 'p6', actor: 'Ananya Iyer', activity: 'Started transit', room: 'Eng · Corridor F2', conf: 84 },
  { id: 't2', time: '11:41:50', personId: null, actor: '415 people', activity: 'Reading (crowd)', room: 'Library · Ground', conf: 91 },
  { id: 't3', time: '11:41:12', personId: 'p2', actor: 'Dr. Neha Rao', activity: 'Taking class', room: 'Mgmt · Room 101', conf: 98 },
  { id: 't4', time: '11:39:44', personId: 'p1', actor: 'Aarav Sharma', activity: 'Attending lecture', room: 'Eng · Room 101', conf: 96 },
  { id: 't5', time: '11:38:20', personId: null, actor: '38 people', activity: 'Lab practical (group)', room: 'Eng · Lab 102', conf: 92 },
  { id: 't6', time: '11:36:01', personId: 'p3', actor: 'Isha Verma', activity: 'Lab practical', room: 'Eng · Lab 102', conf: 92 },
  { id: 't7', time: '11:35:10', personId: null, actor: '~70 people', activity: 'Unscheduled gathering', room: 'Mgmt · Auditorium foyer', conf: 77 },
  { id: 't8', time: '11:33:48', personId: 'p5', actor: 'Rahul Mehta', activity: 'Patrolling', room: 'Mgmt · Ground', conf: 90 },
];

// Active Sessions — per-person tracking sessions. Rows open the drawer.
// Future backend: GET /campus/activity/live/sessions
export const ACTIVE_SESSIONS = ['p2', 'p1', 'p3', 'p4', 'p5', 'p6'];

// Recent Events — discrete movement / state changes.
// Future backend: GET /campus/activity/live/events
export const RECENT_EVENTS = [
  { id: 'ev1', time: '11:42', personId: 'p6', text: 'Left Room 201 → Corridor F2', tone: 'info' },
  { id: 'ev2', time: '11:41', personId: null, text: 'Reading Hall crossed 410 occupancy', tone: 'warn' },
  { id: 'ev3', time: '11:39', personId: 'p1', text: 'Entered Room 101 — lecture', tone: 'ok' },
  { id: 'ev4', time: '11:36', personId: 'p3', text: 'Joined Lab 102 practical', tone: 'ok' },
  { id: 'ev5', time: '11:35', personId: null, text: 'Gathering detected at Auditorium foyer', tone: 'warn' },
  { id: 'ev6', time: '11:33', personId: 'p5', text: 'Security patrol started — Mgmt Ground', tone: 'ok' },
  { id: 'ev7', time: '11:30', personId: null, text: 'Visitor checked in at reception', tone: 'ok' },
];

// AI Decision Panel — the reasoning behind each live classification. This is
// what makes the page "AI intelligence" and not CCTV: signals in → decision out.
// Future backend: GET /campus/activity/live/decisions
export const AI_DECISIONS = [
  {
    id: 'd1', time: '11:41', decision: 'Lecture in progress', room: 'Eng · Room 101', conf: 96,
    signals: ['62 persons seated', 'facing front', 'projector on', 'matches CSE timetable'],
    action: 'Marked room occupied · attendance counting',
  },
  {
    id: 'd2', time: '11:41', decision: 'Overcrowding forming', room: 'Library · Ground', conf: 91,
    signals: ['415 in hall', 'capacity 600', 'threshold 380 crossed', 'inflow rising'],
    action: 'Raised low-severity crowd alert',
  },
  {
    id: 'd3', time: '11:35', decision: 'Unscheduled gathering', room: 'Mgmt · Auditorium foyer', conf: 77,
    signals: ['~70 clustered', 'no room booking', 'stationary 6m'],
    action: 'Flagged for operator review',
  },
  {
    id: 'd4', time: '11:20', decision: 'Low attendance', room: 'Eng · Room 201', conf: 88,
    signals: ['22 present', '41 enrolled', '54% < 85% target'],
    action: 'Logged against ECE 2nd-yr session',
  },
];
