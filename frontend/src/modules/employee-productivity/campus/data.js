// ─────────────────────────────────────────────────────────────────────────────
// Campus Activity Monitoring — dummy-data layer (Education vertical)
//
// FRONTEND-ONLY build. No API calls are made anywhere in this module; every
// widget renders the realistic dummy data below. Each export documents the
// future backend endpoint + field names next to the dummy values so the swap
// to `useQuery` is mechanical when the activity-monitor backend lands.
//
// Brand primary is #F7983A (matches the host VMS). The spec's #FF6B00 can be
// swapped in globally by find/replace if the exact accent is required.
// ─────────────────────────────────────────────────────────────────────────────

export const PRIMARY = '#F7983A';

// ── Filter hierarchy ─────────────────────────────────────────────────────────
// University → School (building) → Department/Course → Floor → Room. Modelled on
// Sharda University's real school & course structure. Filters cascade: choosing a
// school narrows departments, a department narrows floors, and so on.
// Future backend: GET /campus/hierarchy → nested {id,label,children[]}.

// Every school shares the same standard floor stack (kept DRY).
const FLOORS_STD = [
  { id: 'g', label: 'Ground Floor' },
  { id: 'f1', label: '1st Floor' },
  { id: 'f2', label: '2nd Floor' },
  { id: 'f3', label: '3rd Floor' },
];

const SCHOOL_IDS = ['sscse', 'sses', 'design', 'ssbs', 'law', 'smsr', 'dental', 'allied', 'nursing', 'pharmacy'];

export const HIERARCHY = {
  universities: [
    { id: 'sharda', label: 'Sharda University' },
  ],
  // buildings (schools) keyed by universityId
  buildings: {
    sharda: [
      { id: 'sscse', label: 'School of Computing Science & Engineering' },
      { id: 'sses', label: 'School of Engineering & Science' },
      { id: 'design', label: 'School of Design' },
      { id: 'ssbs', label: 'School of Business Studies' },
      { id: 'law', label: 'School of Law' },
      { id: 'smsr', label: 'School of Medical Sciences & Research' },
      { id: 'dental', label: 'School of Dental Sciences' },
      { id: 'allied', label: 'School of Allied Health Sciences' },
      { id: 'nursing', label: 'School of Nursing Science & Research' },
      { id: 'pharmacy', label: 'School of Pharmacy' },
    ],
  },
  // departments / courses keyed by schoolId
  departments: {
    sscse: [
      { id: 'cse-ai', label: 'B.Tech CSE (AI)' },
      { id: 'cse-ds', label: 'B.Tech CSE (Data Science)' },
      { id: 'cse-cs', label: 'B.Tech CSE (Cyber Security)' },
      { id: 'bca', label: 'BCA' },
      { id: 'mca', label: 'MCA' },
    ],
    sses: [
      { id: 'mech', label: 'B.Tech Mechanical' },
      { id: 'civil', label: 'B.Tech Civil' },
      { id: 'ece', label: 'B.Tech ECE' },
      { id: 'eee', label: 'B.Tech Electrical' },
      { id: 'phy', label: 'B.Sc / M.Sc Physics' },
      { id: 'chem', label: 'B.Sc / M.Sc Chemistry' },
      { id: 'math', label: 'B.Sc / M.Sc Mathematics' },
    ],
    design: [
      { id: 'fashion', label: 'B.Des Fashion Design' },
      { id: 'interior', label: 'B.Des Interior Design' },
      { id: 'comm', label: 'B.Des Communication Design' },
      { id: 'barch', label: 'B.Arch / M.Arch' },
    ],
    ssbs: [
      { id: 'bba', label: 'BBA' },
      { id: 'bcom', label: 'B.Com (Hons.)' },
      { id: 'mba', label: 'MBA' },
    ],
    law: [
      { id: 'ballb', label: 'BA LLB (5-yr)' },
      { id: 'bballb', label: 'BBA LLB (5-yr)' },
      { id: 'llb', label: 'LLB (3-yr)' },
      { id: 'llm', label: 'LLM' },
    ],
    smsr: [
      { id: 'mbbs', label: 'MBBS' },
      { id: 'md-ms', label: 'MD / MS (PG)' },
    ],
    dental: [
      { id: 'bds', label: 'BDS' },
      { id: 'mds', label: 'MDS' },
    ],
    allied: [
      { id: 'physio', label: 'Physiotherapy (BPT/MPT)' },
      { id: 'mlt', label: 'Medical Lab Technology' },
      { id: 'opto', label: 'Optometry' },
      { id: 'nutri', label: 'Nutrition' },
    ],
    nursing: [
      { id: 'bscn', label: 'B.Sc Nursing' },
      { id: 'mscn', label: 'M.Sc Nursing' },
      { id: 'gnm', label: 'GNM Diploma' },
    ],
    pharmacy: [
      { id: 'bpharm', label: 'B.Pharm' },
      { id: 'dpharm', label: 'D.Pharm' },
    ],
  },
  // floors keyed by schoolId — every school uses the standard stack
  floors: Object.fromEntries(SCHOOL_IDS.map((s) => [s, FLOORS_STD])),
  // rooms keyed by `${schoolId}:${floorId}` — representative sample
  rooms: {
    'sscse:g': [{ id: 'r-g01', label: 'Lecture Hall G-01' }, { id: 'r-g02', label: 'Programming Lab G-02' }],
    'sscse:f1': [{ id: 'r-101', label: 'Room 101' }, { id: 'r-102', label: 'AI/ML Lab 102' }, { id: 'r-103', label: 'Seminar 103' }],
    'sscse:f2': [{ id: 'r-201', label: 'Room 201' }, { id: 'r-202', label: 'Cyber Security Lab 202' }],
    'sses:g': [{ id: 'r-eg01', label: 'Mechanical Workshop' }, { id: 'r-eg02', label: 'Physics Lab' }],
    'sses:f1': [{ id: 'r-e101', label: 'Room 101' }, { id: 'r-e102', label: 'ECE Lab 102' }],
    'design:g': [{ id: 'r-dg01', label: 'Design Studio A' }, { id: 'r-dg02', label: 'Architecture Studio' }],
    'ssbs:g': [{ id: 'r-bg01', label: 'Auditorium' }, { id: 'r-bg02', label: 'Case Study Room 01' }],
    'ssbs:f1': [{ id: 'r-b101', label: 'MBA Room 101' }],
    'law:g': [{ id: 'r-lg01', label: 'Moot Court Hall' }],
    'smsr:g': [{ id: 'r-mg01', label: 'Anatomy Lecture Theatre' }, { id: 'r-mg02', label: 'Pathology Lab' }],
    'nursing:g': [{ id: 'r-ng01', label: 'Nursing Skills Lab' }],
    'pharmacy:g': [{ id: 'r-pg01', label: 'Pharmaceutics Lab' }],
  },
};

// Time-range presets for the header filter.
export const TIME_RANGES = [
  { id: 'live', label: 'Live (now)' },
  { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'term', label: 'This term' },
];

// ── SECTION 1 · Key Metrics ──────────────────────────────────────────────────
// Future backend: GET /campus/activity/summary?university&building&dept&floor&room&range
// → one object with the raw counters each formula below consumes.
export const KPIS = [
  {
    key: 'present', label: 'People Present', value: '2,847', unit: '', tone: 'primary',
    delta: '+124', sub: 'across all monitored zones',
    purpose: 'Total distinct people currently detected on campus (deduplicated across cameras).',
    formula: 'count(distinct person_id where last_seen ≤ presenceWindowSec)',
    fields: ['tracks[].person_id', 'tracks[].last_seen_ts', 'policy.presenceWindowSec'],
    interactive: true, // opens the People Present popover
  },
  {
    key: 'activities', label: 'Active Activities', value: '68', unit: '', tone: 'good',
    delta: '+6', sub: 'classes, labs, meetings, sports',
    purpose: 'Distinct activities detected as in-progress right now.',
    formula: 'count(activities where status = "ongoing")',
    fields: ['activities[].status', 'activities[].type'],
  },
  {
    key: 'students', label: 'Students in Class', value: '1,932', unit: '', tone: 'good',
    delta: '+58', sub: 'seated in scheduled sessions',
    purpose: 'Students detected inside a room during a scheduled class session.',
    formula: 'count(students in rooms where schedule.session = active)',
    fields: ['tracks[].role=student', 'rooms[].schedule', 'rooms[].occupancy'],
  },
  {
    key: 'faculty', label: 'Faculty on Campus', value: '214', unit: '', tone: 'neutral',
    delta: '+3', sub: '198 in session · 16 in offices',
    purpose: 'Faculty members present anywhere on campus.',
    formula: 'count(distinct person_id where role = "faculty")',
    fields: ['tracks[].person_id', 'tracks[].role', 'directory.faculty'],
  },
  {
    key: 'library', label: 'Library Occupancy', value: '415', unit: '/ 600', tone: 'warn',
    delta: '+41', sub: '69% of 600 capacity',
    purpose: 'People inside the Central Library against its seating capacity.',
    formula: 'count(inside library) / library.capacity × 100',
    fields: ['zones[library].headcount', 'zones[library].capacity'],
  },
  {
    key: 'attendance', label: 'Average Attendance', value: '88.6', unit: '%', tone: 'good',
    delta: '+1.4', sub: 'today vs 30-day mean 86.2%',
    purpose: 'Mean attendance across all scheduled sessions today.',
    formula: 'avg(present_in_session / enrolled_in_session) × 100',
    fields: ['sessions[].present', 'sessions[].enrolled'],
  },
];

// People Present popover — By Category tab.
// Future backend: GET /campus/activity/present?groupBy=category
export const PRESENT_BY_CATEGORY = [
  { label: 'Students', count: 2286, pct: 80.3, trend: +4.1 },
  { label: 'Faculty', count: 214, pct: 7.5, trend: +1.2 },
  { label: 'Staff', count: 168, pct: 5.9, trend: -0.6 },
  { label: 'Visitors', count: 121, pct: 4.3, trend: +2.8 },
  { label: 'Contractors', count: 58, pct: 2.0, trend: 0 },
];

// People Present popover — By School tab (Sharda schools).
// Future backend: GET /campus/activity/present?groupBy=school
export const PRESENT_BY_DEPARTMENT = [
  { label: 'Computing S&E', count: 640, pct: 22.5, trend: +3.4 },
  { label: 'Engineering & Science', count: 512, pct: 18.0, trend: +1.1 },
  { label: 'Medical Sciences', count: 430, pct: 15.1, trend: -0.9 },
  { label: 'Business Studies', count: 388, pct: 13.6, trend: +2.0 },
  { label: 'Law', count: 250, pct: 8.8, trend: +0.5 },
  { label: 'Allied Health', count: 210, pct: 7.4, trend: +1.2 },
  { label: 'Design', count: 180, pct: 6.3, trend: +2.8 },
  { label: 'Nursing & Pharmacy', count: 237, pct: 8.3, trend: +0.6 },
];

// ── SECTION 2 · Activity Insights ────────────────────────────────────────────
// Activity Distribution — share of people by what they're currently doing.
// Future backend: GET /campus/activity/distribution?range → [{type,value}]
export const ACTIVITY_DISTRIBUTION = [
  { type: 'In Class', value: 1932, color: '#F7983A' },
  { type: 'In Library', value: 415, color: '#0ea5e9' },
  { type: 'In Labs', value: 268, color: '#8b5cf6' },
  { type: 'Cafeteria', value: 186, color: '#10b981' },
  { type: 'Sports / Grounds', value: 94, color: '#f59e0b' },
  { type: 'Transit / Corridors', value: 132, color: '#64748b' },
];

// Activity Trend — people engaged in the three headline activity groups across
// the day. Future backend: GET /campus/activity/trend?range → per-hour buckets.
export const ACTIVITY_TREND = [
  { h: '08:00', classes: 210, library: 60, labs: 20 },
  { h: '09:00', classes: 1180, library: 140, labs: 90 },
  { h: '10:00', classes: 1720, library: 240, labs: 180 },
  { h: '11:00', classes: 1932, library: 310, labs: 268 },
  { h: '12:00', classes: 1610, library: 380, labs: 210 },
  { h: '13:00', classes: 720, library: 415, labs: 120 },
  { h: '14:00', classes: 1540, library: 360, labs: 240 },
  { h: '15:00', classes: 1380, library: 330, labs: 190 },
];

// ── SECTION 3 · Live Overview ────────────────────────────────────────────────
// Live Activity Feed — most recent detections (newest first).
// Future backend: GET /campus/activity/events?limit — same stream the Event Log consumes.
export const LIVE_FEED = [
  { id: 'e1', time: '11:42', type: 'class-start', text: 'Class started — Data Structures (CSE)', where: 'Eng · Room 101', tone: 'info' },
  { id: 'e2', time: '11:41', type: 'crowd', text: 'Occupancy rising in Reading Hall', where: 'Library · Ground', tone: 'warn' },
  { id: 'e3', time: '11:39', type: 'lab', text: 'Lab session started — AI/ML practical', where: 'Eng · Lab 102', tone: 'ok' },
  { id: 'e4', time: '11:37', type: 'faculty', text: 'Faculty entered — Dr. Rao', where: 'Mgmt · Case Study 101', tone: 'ok' },
  { id: 'e5', time: '11:35', type: 'gathering', text: 'Gathering detected near Auditorium', where: 'Mgmt · Ground', tone: 'warn' },
  { id: 'e6', time: '11:33', type: 'class-end', text: 'Class ended — Thermodynamics (ECE)', where: 'Eng · Room 201', tone: 'info' },
  { id: 'e7', time: '11:30', type: 'visitor', text: 'Visitor checked in at reception', where: 'Main Gate', tone: 'ok' },
];

// Active Activities table — the current-state inventory of what's happening now.
// (Contrast with LIVE_FEED, which is the time-ordered stream of events.)
// Future backend: GET /campus/activity/active → in-progress activities.
export const ACTIVE_ACTIVITIES = [
  { id: 'a1', activity: 'Data Structures — Lecture', type: 'Lecture', location: 'SSCSE · Room 101', people: 62, status: 'ongoing', started: '11:00', date: '2026-07-22' },
  { id: 'a2', activity: 'AI/ML Practical — Lab', type: 'Lab', location: 'SSCSE · Lab 102', people: 38, status: 'ongoing', started: '10:30', date: '2026-07-22' },
  { id: 'a3', activity: 'Reading / Self-study', type: 'Study', location: 'Central Library · Ground', people: 415, status: 'ongoing', started: '09:10', date: '2026-07-22' },
  { id: 'a4', activity: 'MBA Case Discussion', type: 'Meeting', location: 'SSBS · Room 101', people: 44, status: 'ongoing', started: '11:15', date: '2026-07-22' },
  { id: 'a5', activity: 'Anatomy Lecture', type: 'Lecture', location: 'SMSR · Lecture Theatre', people: 110, status: 'ongoing', started: '11:00', date: '2026-07-22' },
  { id: 'a6', activity: 'Cyber Security Lab', type: 'Lab', location: 'SSCSE · Lab 202', people: 34, status: 'ongoing', started: '11:10', date: '2026-07-22' },
  { id: 'a7', activity: 'Constitutional Law', type: 'Lecture', location: 'School of Law · Room 101', people: 48, status: 'ongoing', started: '11:00', date: '2026-07-22' },
  { id: 'a8', activity: 'Design Studio Review', type: 'Seminar', location: 'School of Design · Studio A', people: 28, status: 'ongoing', started: '09:30', date: '2026-07-22' },
  { id: 'a9', activity: 'Pharmaceutics Lab', type: 'Lab', location: 'School of Pharmacy · Lab', people: 41, status: 'ongoing', started: '11:20', date: '2026-07-22' },
  { id: 'a10', activity: 'Cricket Practice', type: 'Sports', location: 'Sports Ground', people: 26, status: 'ongoing', started: '10:45', date: '2026-07-22' },
  { id: 'a11', activity: 'Moot Court Prep', type: 'Seminar', location: 'School of Law · Moot Court', people: 21, status: 'scheduled', started: '12:00', date: '2026-07-22' },
  { id: 'a12', activity: 'Nursing Skills Session', type: 'Lab', location: 'SNSR · Skills Lab', people: 32, status: 'scheduled', started: '14:00', date: '2026-07-22' },
  { id: 'a13', activity: 'Robotics Club Meet', type: 'Meeting', location: 'SSCSE · Seminar 103', people: 19, status: 'scheduled', started: '15:00', date: '2026-07-22' },
  { id: 'a14', activity: 'Thermodynamics — Lecture', type: 'Lecture', location: 'SSES · Room 201', people: 0, status: 'completed', started: '10:00', date: '2026-07-22' },
  { id: 'a15', activity: 'DBMS — Lecture', type: 'Lecture', location: 'SSCSE · Room 101', people: 0, status: 'completed', started: '09:00', date: '2026-07-22' },
];

// Recent Alerts — activity-related, action-worthy.
// Future backend: GET /campus/activity/alerts?acknowledged=false
export const RECENT_ALERTS = [
  { id: 'al1', severity: 'high', title: 'Overcrowding — Reading Hall', where: 'Library · Ground', meta: '415 / 380 threshold', since: '11:41' },
  { id: 'al2', severity: 'medium', title: 'Unscheduled gathering', where: 'Mgmt · Auditorium foyer', meta: '~70 people, no booking', since: '11:35' },
  { id: 'al3', severity: 'medium', title: 'Low attendance — ECE 2nd yr', where: 'Eng · Room 201', meta: '54% present', since: '11:20' },
  { id: 'al4', severity: 'low', title: 'Empty scheduled room', where: 'Pharma · Ground', meta: 'B.Pharm session, 0 detected', since: '11:05' },
];

// ── SECTION 4 · Activity Analytics ───────────────────────────────────────────
// Hourly Activity — total detected activities per hour across the day.
// Future backend: GET /campus/activity/hourly?range
export const HOURLY_ACTIVITY = [
  { h: '08', activities: 12 }, { h: '09', activities: 34 }, { h: '10', activities: 58 },
  { h: '11', activities: 68 }, { h: '12', activities: 41 }, { h: '13', activities: 22 },
  { h: '14', activities: 61 }, { h: '15', activities: 54 }, { h: '16', activities: 38 },
  { h: '17', activities: 19 },
];

// Activity Status — breakdown of activities by lifecycle state.
// Future backend: GET /campus/activity/status-breakdown
export const ACTIVITY_STATUS = [
  { status: 'Ongoing', value: 68, color: '#F7983A' },
  { status: 'Scheduled', value: 24, color: '#0ea5e9' },
  { status: 'Completed', value: 112, color: '#10b981' },
  { status: 'Idle / Empty', value: 9, color: '#94a3b8' },
];
