// ─────────────────────────────────────────────────────────────────────────────
// Productivity Analytics — dummy-data layer (Campus / Education subpage).
//
// FRONTEND-ONLY. How productively the campus is learning: engagement, study vs
// idle time, a composite learning score and collaboration, plus focus /
// discussion / library / department-productivity charts. Department comparison
// uses the Sharda school set for consistency. Endpoint/field contracts inline.
// ─────────────────────────────────────────────────────────────────────────────

// Headline cards.
// Future backend: GET /campus/productivity/summary?school&dept&range
export const CARDS = [
  { key: 'productivity', label: 'Productivity', value: '82', unit: '%', sub: 'campus engagement index' },
  { key: 'study', label: 'Study Time', value: '4h 20m', small: true, sub: 'avg per student today' },
  { key: 'idle', label: 'Idle Time', value: '1h 05m', small: true, sub: 'avg per student today' },
  { key: 'learning', label: 'Learning Score', value: '78', unit: '/100', sub: 'composite learning index' },
  { key: 'collab', label: 'Collaboration', value: '74', unit: '/100', sub: 'peer interaction index' },
];

// Focus — attention index across the day.
// Future backend: GET /campus/productivity/focus?range
export const FOCUS = [
  { h: '08:00', focus: 52 }, { h: '09:00', focus: 74 }, { h: '10:00', focus: 82 },
  { h: '11:00', focus: 86 }, { h: '12:00', focus: 63 }, { h: '13:00', focus: 48 },
  { h: '14:00', focus: 80 }, { h: '15:00', focus: 76 }, { h: '16:00', focus: 60 },
];

// Discussion — collaborative discussion sessions per hour.
// Future backend: GET /campus/productivity/discussion?range
export const DISCUSSION = [
  { h: '08:00', sessions: 2 }, { h: '09:00', sessions: 6 }, { h: '10:00', sessions: 12 },
  { h: '11:00', sessions: 18 }, { h: '12:00', sessions: 9 }, { h: '13:00', sessions: 5 },
  { h: '14:00', sessions: 15 }, { h: '15:00', sessions: 11 }, { h: '16:00', sessions: 7 },
];

// Library Usage — visits per day this week.
// Future backend: GET /campus/productivity/library-usage?range
export const LIBRARY_USAGE = [
  { d: 'Mon', visits: 1240 }, { d: 'Tue', visits: 1120 }, { d: 'Wed', visits: 1360 },
  { d: 'Thu', visits: 980 }, { d: 'Fri', visits: 1180 }, { d: 'Sat', visits: 720 }, { d: 'Sun', visits: 260 },
];

// Department (School) Productivity — productivity % per Sharda school.
// Future backend: GET /campus/productivity/by-school
export const DEPARTMENT_PRODUCTIVITY = [
  { dept: 'Medical Sciences', pct: 88 },
  { dept: 'Computing S&E', pct: 85 },
  { dept: 'Nursing', pct: 83 },
  { dept: 'Dental Sciences', pct: 82 },
  { dept: 'Business Studies', pct: 81 },
  { dept: 'Engineering & Science', pct: 80 },
  { dept: 'Design', pct: 79 },
  { dept: 'Allied Health', pct: 78 },
  { dept: 'Pharmacy', pct: 77 },
  { dept: 'Law', pct: 74 },
];
