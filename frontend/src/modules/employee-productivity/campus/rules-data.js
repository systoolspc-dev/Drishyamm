// ─────────────────────────────────────────────────────────────────────────────
// Rules & Policies — dummy-data layer (Campus / Education subpage).
//
// An enterprise rule engine: IF <conditions> THEN <actions>. FIELDS defines the
// condition vocabulary (field → operators → value type), ACTIONS the outcomes.
// FRONTEND-ONLY. Future backend: GET/POST /campus/rules, PATCH /campus/rules/:id.
// ─────────────────────────────────────────────────────────────────────────────

// Condition fields. `type` drives the value input (select / number / time);
// `operators` the comparators offered.
export const FIELDS = [
  {
    id: 'department', label: 'Department', type: 'select', operators: ['=', '≠'],
    options: [
      { id: 'cse', label: 'CSE' }, { id: 'ece', label: 'ECE' }, { id: 'mech', label: 'Mechanical' },
      { id: 'mba', label: 'MBA' }, { id: 'llb', label: 'Law' }, { id: 'mbbs', label: 'MBBS' },
      { id: 'bpharm', label: 'B.Pharm' }, { id: 'design', label: 'Design' },
    ],
  },
  {
    id: 'activity', label: 'Activity', type: 'select', operators: ['=', '≠'],
    options: [
      { id: 'loitering', label: 'Loitering' }, { id: 'lecture', label: 'Lecture' }, { id: 'lab', label: 'Lab Session' },
      { id: 'idle', label: 'Idle' }, { id: 'gathering', label: 'Gathering' }, { id: 'running', label: 'Running' },
      { id: 'fighting', label: 'Fighting' }, { id: 'unauthorized', label: 'Unauthorized Entry' }, { id: 'phone', label: 'Phone Use' },
    ],
  },
  { id: 'duration', label: 'Duration', type: 'number', suffix: 'min', operators: ['>', '<', '≥', '≤', '='] },
  { id: 'occupancy', label: 'Occupancy', type: 'number', suffix: 'people', operators: ['>', '<', '≥', '≤'] },
  {
    id: 'person', label: 'Person Type', type: 'select', operators: ['=', '≠'],
    options: [
      { id: 'student', label: 'Student' }, { id: 'faculty', label: 'Faculty' }, { id: 'staff', label: 'Staff' },
      { id: 'visitor', label: 'Visitor' }, { id: 'unknown', label: 'Unknown' },
    ],
  },
  {
    id: 'location', label: 'Location', type: 'select', operators: ['=', '≠'],
    options: [
      { id: 'classroom', label: 'Classroom' }, { id: 'lab', label: 'Lab' }, { id: 'library', label: 'Library' },
      { id: 'corridor', label: 'Corridor' }, { id: 'exam', label: 'Exam Hall' }, { id: 'gate', label: 'Main Gate' },
    ],
  },
  { id: 'time', label: 'Time', type: 'time', operators: ['after', 'before'] },
];

export const ACTIONS = [
  { id: 'generate_alert', label: 'Generate Alert', hasSeverity: true },
  { id: 'notify_security', label: 'Notify Security' },
  { id: 'notify_hod', label: 'Notify HOD' },
  { id: 'notify_faculty', label: 'Notify Faculty' },
  { id: 'send_email', label: 'Send Email' },
  { id: 'log_event', label: 'Log Event' },
  { id: 'escalate', label: 'Escalate to Admin' },
  { id: 'announce', label: 'Trigger Announcement' },
];

export const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

// Headline cards.
// Future backend: GET /campus/rules/summary
export const CARDS = [
  { key: 'total', label: 'Total Rules', value: '48', sub: 'across all schools' },
  { key: 'active', label: 'Active Rules', value: '39', sub: 'currently enforced' },
  { key: 'disabled', label: 'Disabled Rules', value: '6', sub: 'switched off' },
  { key: 'pending', label: 'Pending Review', value: '3', sub: 'awaiting approval' },
];

// Existing rules.
// Future backend: GET /campus/rules
export const RULES = [
  { id: 'r1', name: 'Loitering in CSE corridors', summary: 'Dept = CSE · Activity = Loitering · Duration > 20 min', action: 'Generate Alert', severity: 'High', status: 'active', scope: 'Computing S&E', triggers: 12, updated: 'Today 09:10' },
  { id: 'r2', name: 'After-hours lab access', summary: 'Activity = Unauthorized Entry · Time after 21:00', action: 'Notify Security', severity: 'Critical', status: 'active', scope: 'All labs', triggers: 3, updated: 'Yesterday' },
  { id: 'r3', name: 'Library overcrowding', summary: 'Occupancy > 380 · Location = Library', action: 'Trigger Announcement', severity: 'Medium', status: 'active', scope: 'Central Library', triggers: 5, updated: 'Today 08:40' },
  { id: 'r4', name: 'Phone use in exams', summary: 'Activity = Phone Use · Location = Exam Hall', action: 'Notify Faculty', severity: 'High', status: 'disabled', scope: 'Exam halls', triggers: 0, updated: '3 days ago' },
  { id: 'r5', name: 'Empty scheduled room', summary: 'Occupancy = 0 · during scheduled class', action: 'Notify HOD', severity: 'Low', status: 'pending', scope: 'All schools', triggers: 2, updated: 'Today 10:00' },
];

export const RULE_STATUS = {
  active: { label: 'Active', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  disabled: { label: 'Disabled', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
  pending: { label: 'Pending', chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
};

export const SEVERITY_TEXT = {
  Low: 'text-fg-muted', Medium: 'text-warning-ink', High: 'text-brand-ink', Critical: 'text-danger-ink',
};
