// ─────────────────────────────────────────────────────────────────────────────
// Attendance Intelligence — dummy-data layer (Campus / Education subpage).
//
// FRONTEND-ONLY. Attendance analytics for the campus: headline counts, trend /
// lateness / department / semester comparisons, and the session + exception
// tables that back them. Department comparison uses the Sharda school set so it
// stays consistent with the filter hierarchy. Endpoint/field contracts inline.
// ─────────────────────────────────────────────────────────────────────────────

// Headline cards.
// Future backend: GET /campus/attendance/summary?school&dept&range
export const CARDS = [
  { key: 'present', label: 'Present', value: '2,286', sub: '88.6% of expected' },
  { key: 'absent', label: 'Absent', value: '294', sub: '11.4% of expected' },
  { key: 'late', label: 'Late', value: '138', sub: 'arrived after 09:15' },
  { key: 'away', label: 'Temporary Away', value: '46', sub: 'currently off-seat' },
  { key: 'early', label: 'Early Exit', value: '22', sub: 'left before session end' },
  { key: 'overrides', label: 'Teacher Overrides', value: '11', sub: 'manual corrections today' },
];

// Attendance Trend — present % across the week.
// Future backend: GET /campus/attendance/trend?range
export const ATTENDANCE_TREND = [
  { d: 'Mon', pct: 87 }, { d: 'Tue', pct: 89 }, { d: 'Wed', pct: 86 },
  { d: 'Thu', pct: 90 }, { d: 'Fri', pct: 88 }, { d: 'Sat', pct: 84 },
];

// Late Analysis — how late, bucketed.
// Future backend: GET /campus/attendance/late-histogram
export const LATE_ANALYSIS = [
  { range: '0–5m', count: 58 },
  { range: '5–15m', count: 44 },
  { range: '15–30m', count: 24 },
  { range: '30m+', count: 12 },
];

// Department (School) Comparison — attendance % per Sharda school.
// Future backend: GET /campus/attendance/by-school
export const DEPARTMENT_COMPARISON = [
  { dept: 'Medical Sciences', pct: 93 },
  { dept: 'Nursing', pct: 91 },
  { dept: 'Computing S&E', pct: 90 },
  { dept: 'Business Studies', pct: 89 },
  { dept: 'Dental Sciences', pct: 88 },
  { dept: 'Engineering & Science', pct: 87 },
  { dept: 'Allied Health', pct: 86 },
  { dept: 'Pharmacy', pct: 85 },
  { dept: 'Design', pct: 84 },
  { dept: 'Law', pct: 82 },
];

// Semester Comparison — attendance % by semester.
// Future backend: GET /campus/attendance/by-semester
export const SEMESTER_COMPARISON = [
  { sem: 'S1', pct: 92 }, { sem: 'S2', pct: 90 }, { sem: 'S3', pct: 88 }, { sem: 'S4', pct: 87 },
  { sem: 'S5', pct: 86 }, { sem: 'S6', pct: 88 }, { sem: 'S7', pct: 84 }, { sem: 'S8', pct: 83 },
];

// Attendance Sessions table.
// Future backend: GET /campus/attendance/sessions?range
export const SESSIONS = [
  { time: '09:00', subject: 'DBMS', room: 'SSCSE · Room 101', teacher: 'Dr. Neha Rao', present: 65, expected: 70, pct: 93, status: 'verified' },
  { time: '10:00', subject: 'Operating Systems', room: 'SSCSE · Room 101', teacher: 'Dr. Menon', present: 61, expected: 70, pct: 87, status: 'verified' },
  { time: '11:00', subject: 'Anatomy', room: 'SMSR · Lecture Theatre', teacher: 'Dr. Iyer', present: 110, expected: 120, pct: 92, status: 'ongoing' },
  { time: '11:00', subject: 'Constitutional Law', room: 'Law · Moot Court', teacher: 'Dr. Khan', present: 48, expected: 60, pct: 80, status: 'flagged' },
  { time: '14:00', subject: 'AI/ML Lab', room: 'SSCSE · Lab 102', teacher: 'Dr. Reddy', present: 36, expected: 40, pct: 90, status: 'ongoing' },
  { time: '14:00', subject: 'Pharmaceutics', room: 'Pharmacy · Lab', teacher: 'Dr. Desai', present: 41, expected: 48, pct: 85, status: 'ongoing' },
];

// Temporary Absence table — students currently (or recently) off-seat mid-session.
// Future backend: GET /campus/attendance/temporary-absence
export const TEMP_ABSENCE = [
  { name: 'Ananya Iyer', id: 'STU-2101', dept: 'B.Tech ECE', leftAt: '11:22', away: '12m', lastRoom: 'SSES · Room 101', status: 'away' },
  { name: 'Kabir Singh', id: 'STU-1990', dept: 'BCA', leftAt: '11:05', away: '28m', lastRoom: 'Central Library', status: 'away' },
  { name: 'Rahul Verma', id: 'STU-2260', dept: 'MBA', leftAt: '10:48', away: 'returned 11:10', lastRoom: 'SSBS · Room 101', status: 'returned' },
  { name: 'Sara Ali', id: 'STU-2299', dept: 'B.Tech CSE (AI)', leftAt: '11:30', away: '5m', lastRoom: 'SSCSE · Lab 102', status: 'away' },
];

// Teacher Verification table — AI auto-count vs teacher-verified count.
// Future backend: GET /campus/attendance/teacher-verification
export const TEACHER_VERIFICATION = [
  { session: 'DBMS · 09:00', teacher: 'Dr. Neha Rao', auto: 63, verified: 65, adjust: '+2', status: 'verified', time: '10:02' },
  { session: 'Operating Systems · 10:00', teacher: 'Dr. Menon', auto: 61, verified: 61, adjust: '0', status: 'verified', time: '11:03' },
  { session: 'Constitutional Law · 11:00', teacher: 'Dr. Khan', auto: 44, verified: 48, adjust: '+4', status: 'verified', time: '11:40' },
  { session: 'AI/ML Lab · 14:00', teacher: 'Dr. Reddy', auto: 36, verified: null, adjust: '—', status: 'pending', time: '—' },
];

export const SESSION_STATUS = {
  verified: { label: 'Verified', chip: 'bg-success-soft text-success-ink ring-success-line' },
  ongoing: { label: 'Ongoing', chip: 'bg-info-soft text-info-ink ring-info-line' },
  flagged: { label: 'Flagged', chip: 'bg-warning-soft text-warning-ink ring-warning-line' },
  away: { label: 'Away', chip: 'bg-warning-soft text-warning-ink ring-warning-line' },
  returned: { label: 'Returned', chip: 'bg-success-soft text-success-ink ring-success-line' },
  pending: { label: 'Pending', chip: 'bg-surface-muted text-fg-muted ring-line' },
};
