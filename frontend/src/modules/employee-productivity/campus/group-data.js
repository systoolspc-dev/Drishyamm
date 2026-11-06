// ─────────────────────────────────────────────────────────────────────────────
// Group Activity — dummy-data layer (Campus / Education subpage, Prompt 5).
//
// FRONTEND-ONLY. Detects collaboration: clusters of people the AI reads as a
// group (study groups, project huddles, club meets, crowds). Cards + charts +
// a live groups table. Each export notes the future backend endpoint + fields.
// ─────────────────────────────────────────────────────────────────────────────

// Summary cards.
// Future backend: GET /campus/groups/summary
export const CARDS = [
  { key: 'current', label: 'Current Groups', value: '24', unit: '', sub: '+3 in last hour' },
  { key: 'avg', label: 'Average Size', value: '4.6', unit: '', sub: 'people per group' },
  { key: 'longest', label: 'Longest Discussion', value: '1h 24m', unit: '', sub: 'Library · Study Pod 3' },
  { key: 'largest', label: 'Largest Crowd', value: '72', unit: '', sub: 'Auditorium foyer' },
];

// Group Duration distribution (how long groups last).
// Future backend: GET /campus/groups/duration-histogram
export const GROUP_DURATION = [
  { range: '<5m', count: 18 },
  { range: '5–15m', count: 26 },
  { range: '15–30m', count: 19 },
  { range: '30–60m', count: 11 },
  { range: '60m+', count: 6 },
];

// Group Size distribution (how many people per group).
// Future backend: GET /campus/groups/size-histogram
export const GROUP_SIZE = [
  { size: '2–3', count: 31 },
  { size: '4–5', count: 24 },
  { size: '6–8', count: 14 },
  { size: '9–12', count: 7 },
  { size: '12+', count: 4 },
];

// Formation Timeline — groups forming across the day.
// Future backend: GET /campus/groups/formation-timeline
export const FORMATION_TIMELINE = [
  { h: '08:00', groups: 4 }, { h: '09:00', groups: 9 }, { h: '10:00', groups: 16 },
  { h: '11:00', groups: 24 }, { h: '12:00', groups: 31 }, { h: '13:00', groups: 28 },
  { h: '14:00', groups: 22 }, { h: '15:00', groups: 18 }, { h: '16:00', groups: 12 },
];

// Heatmap — collaboration intensity by location × time.
// Future backend: GET /campus/groups/heatmap → { hours[], zones[]{ zone, values[] } }
export const HEATMAP = {
  hours: ['08:00', '10:00', '12:00', '14:00', '16:00'],
  zones: [
    { zone: 'Central Library', values: [3, 8, 11, 9, 6] },
    { zone: 'Cafeteria', values: [2, 5, 14, 7, 4] },
    { zone: 'Eng Corridors', values: [1, 6, 8, 6, 3] },
    { zone: 'Auditorium Foyer', values: [0, 3, 9, 4, 2] },
    { zone: 'Labs', values: [1, 5, 4, 7, 5] },
    { zone: 'Courtyard', values: [2, 4, 10, 5, 3] },
  ],
};

// Active groups table.
// Future backend: GET /campus/groups/active
export const GROUPS = [
  { id: 'g1', label: 'Study group', members: 5, deptMix: ['CSE', 'IT'], purpose: 'Exam prep — DBMS', location: 'Library · Study Pod 3', duration: '1h 24m' },
  { id: 'g2', label: 'Project huddle', members: 4, deptMix: ['AI'], purpose: 'Capstone review', location: 'Eng · Lab 102', duration: '48m' },
  { id: 'g3', label: 'Club meeting', members: 12, deptMix: ['CSE', 'ECE', 'MBA'], purpose: 'Robotics club', location: 'Eng · Seminar 103', duration: '35m' },
  { id: 'g4', label: 'Casual gathering', members: 8, deptMix: ['MBA', 'BBA'], purpose: 'Break / social', location: 'Cafeteria', duration: '22m' },
  { id: 'g5', label: 'Faculty–student', members: 3, deptMix: ['ECE'], purpose: 'Doubt clearing', location: 'Eng · Faculty Room F2', duration: '18m' },
  { id: 'g6', label: 'Crowd', members: 72, deptMix: ['Mixed'], purpose: 'Unscheduled gathering', location: 'Auditorium foyer', duration: '11m' },
  { id: 'g7', label: 'Study group', members: 6, deptMix: ['IT', 'AI'], purpose: 'Assignment', location: 'Library · Ground', duration: '52m' },
];

// Department chip colours (subtle, distinct — used in the table's Department Mix).
export const DEPT_CHIP = {
  CSE: 'bg-info-soft text-info-ink ring-info-line',
  IT: 'bg-ai-soft text-ai-ink ring-ai-line',
  AI: 'bg-brand/10 text-brand-ink ring-brand/25',
  ECE: 'bg-success-soft text-success-ink ring-success-line',
  MBA: 'bg-danger-soft text-danger-ink ring-danger-line',
  BBA: 'bg-warning-soft text-warning-ink ring-warning-line',
  LAW: 'bg-info-soft text-info-ink ring-info-line',
  Mixed: 'bg-surface-muted text-fg-muted ring-line',
};
