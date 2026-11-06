// ─────────────────────────────────────────────────────────────────────────────
// Rules & Policies — data for the store/office module (retail + corporate).
//
// A vertical-agnostic rule engine: IF <conditions> THEN <actions>. The condition
// vocabulary (FIELDS) and outcomes (ACTIONS) differ per vertical; the UI is one
// shared, data-driven component set. FRONTEND-ONLY.
// Future backend: GET/POST /activity/rules, PATCH /activity/rules/:id.
// ─────────────────────────────────────────────────────────────────────────────

export const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

export const RULE_STATUS = {
  active: { label: 'Active', chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  disabled: { label: 'Disabled', chip: 'bg-surface-muted text-fg-muted ring-line', dot: 'bg-slate-400' },
  pending: { label: 'Pending', chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
};

export const SEVERITY_TEXT = {
  Low: 'text-fg-muted', Medium: 'text-warning-ink', High: 'text-brand-ink', Critical: 'text-danger-ink',
};

// Seed-rule shorthands: one condition, one action.
const c = (field, operator, value) => ({ field, operator, value });
const a = (action, severity) => ({ action, severity });

// ── Rule text, derived from structure ────────────────────────────────────────
// The builder's preview, the table's summary line and a saved rule all read
// through these, so a rule reads the same everywhere.
export function fieldDefOf(fields, id) {
  return fields.find((f) => f.id === id) || fields[0];
}
export function actionDefOf(actions, id) {
  return actions.find((x) => x.id === id) || actions[0];
}
export function valueLabel(def, value) {
  if (def.type === 'select') return (def.options.find((o) => o.id === value) || {}).label || value;
  if (def.type === 'number') return `${value} ${def.suffix}`.trim();
  return value;
}
export function conditionText(fields, cond) {
  const def = fieldDefOf(fields, cond.field);
  return `${def.label} ${cond.operator} ${valueLabel(def, cond.value)}`;
}
export function actionText(actions, act) {
  return `${actionDefOf(actions, act.action).label} (${act.severity})`;
}
// Table columns for a structured rule: summary line, primary action, severity.
export function describeRule(vocab, rule) {
  return {
    summary: rule.conditions.map((x) => conditionText(vocab.fields, x)).join(' · '),
    action: actionDefOf(vocab.actions, rule.actions[0].action).label,
    severity: rule.actions[0].severity,
  };
}
const withSummaries = (vocab) => ({
  ...vocab,
  rules: vocab.rules.map((r) => ({ ...r, ...describeRule(vocab, r) })),
});

// ── Retail (shop floor) ──────────────────────────────────────────────────────
const RETAIL = {
  cards: [
    { key: 'total', label: 'Total Rules', value: '32', sub: 'across all stores' },
    { key: 'active', label: 'Active Rules', value: '26', sub: 'currently enforced' },
    { key: 'disabled', label: 'Disabled Rules', value: '4', sub: 'switched off' },
    { key: 'pending', label: 'Pending Review', value: '2', sub: 'awaiting approval' },
  ],
  fields: [
    {
      id: 'zone', label: 'Zone', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'billing', label: 'Billing Counter' }, { id: 'apparel', label: 'Apparel' }, { id: 'electronics', label: 'Electronics' },
        { id: 'aisles', label: 'Grocery Aisles' }, { id: 'homekitchen', label: 'Home & Kitchen' }, { id: 'entrance', label: 'Entrance' }, { id: 'stockroom', label: 'Stockroom' },
      ],
    },
    {
      id: 'activity', label: 'Activity', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'counter-unattended', label: 'Counter Unattended' }, { id: 'queue-building', label: 'Queue Building' }, { id: 'phone', label: 'Phone Use' },
        { id: 'loitering', label: 'Loitering' }, { id: 'low-activity', label: 'Low Activity' }, { id: 'theft', label: 'Theft-suspicious' }, { id: 'running', label: 'Running' },
      ],
    },
    { id: 'duration', label: 'Duration', type: 'number', suffix: 'min', operators: ['>', '<', '≥', '≤', '='] },
    { id: 'queue', label: 'Queue length', type: 'number', suffix: 'people', operators: ['>', '<', '≥', '≤'] },
    { id: 'person', label: 'Person Type', type: 'select', operators: ['=', '≠'], options: [{ id: 'staff', label: 'Staff' }, { id: 'customer', label: 'Customer' }, { id: 'unknown', label: 'Unknown' }] },
    { id: 'time', label: 'Time', type: 'time', operators: ['after', 'before'] },
  ],
  actions: [
    { id: 'generate_alert', label: 'Generate Alert', hasSeverity: true },
    { id: 'notify_manager', label: 'Notify Store Manager' },
    { id: 'notify_security', label: 'Notify Security' },
    { id: 'announce', label: 'Trigger Announcement' },
    { id: 'log_event', label: 'Log Event' },
    { id: 'escalate', label: 'Escalate to Area Manager' },
  ],
  // Where a rule applies — the builder's Scope dropdown.
  scopes: ['All counters', 'Billing 1–3', 'Sales floor', 'Store perimeter', 'Entrance', 'Stockroom', 'All zones'],
  // Structured IF/THEN, so any rule can be reopened in the builder. `summary`
  // and `action` (the table's text) are derived from these by withSummaries().
  rules: [
    { id: 'r1', name: 'Counter left unattended', conditions: [c('zone', '=', 'billing'), c('activity', '=', 'counter-unattended'), c('duration', '>', '5')], actions: [a('generate_alert', 'High')], status: 'active', scope: 'All counters', triggers: 8, updated: 'Today 14:32' },
    { id: 'r2', name: 'Billing queue build-up', conditions: [c('activity', '=', 'queue-building'), c('queue', '>', '5')], actions: [a('notify_manager', 'Medium')], status: 'active', scope: 'Billing 1–3', triggers: 5, updated: 'Today 14:35' },
    { id: 'r3', name: 'Phone use on floor', conditions: [c('activity', '=', 'phone'), c('person', '=', 'staff')], actions: [a('generate_alert', 'Medium')], status: 'active', scope: 'Sales floor', triggers: 4, updated: 'Today 14:29' },
    { id: 'r4', name: 'After-hours loitering', conditions: [c('activity', '=', 'loitering'), c('time', 'after', '22:00')], actions: [a('notify_security', 'High')], status: 'active', scope: 'Store perimeter', triggers: 0, updated: 'Yesterday' },
    { id: 'r5', name: 'Low zone activity', conditions: [c('activity', '=', 'low-activity'), c('duration', '>', '30')], actions: [a('log_event', 'Low')], status: 'pending', scope: 'All zones', triggers: 2, updated: 'Today 13:58' },
  ],
};

// ── Corporate (office) ───────────────────────────────────────────────────────
const CORPORATE = {
  cards: [
    { key: 'total', label: 'Total Rules', value: '28', sub: 'across all sites' },
    { key: 'active', label: 'Active Rules', value: '22', sub: 'currently enforced' },
    { key: 'disabled', label: 'Disabled Rules', value: '4', sub: 'switched off' },
    { key: 'pending', label: 'Pending Review', value: '2', sub: 'awaiting approval' },
  ],
  fields: [
    {
      id: 'zone', label: 'Zone', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'engbay', label: 'Engineering Bay' }, { id: 'design', label: 'Design Studio' }, { id: 'meetingA', label: 'Meeting Room A' }, { id: 'meetingB', label: 'Meeting Room B' },
        { id: 'server', label: 'Server Room' }, { id: 'sales', label: 'Sales Floor' }, { id: 'finance', label: 'Finance' }, { id: 'reception', label: 'Reception' },
      ],
    },
    {
      id: 'activity', label: 'Activity', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'after-hours', label: 'After-hours Access' }, { id: 'meeting-overrun', label: 'Meeting Over-run' }, { id: 'desk-idle', label: 'Workstation Idle' },
        { id: 'phone', label: 'Phone Use' }, { id: 'tailgating', label: 'Tailgating' }, { id: 'loitering', label: 'Loitering' }, { id: 'unauthorized', label: 'Unauthorized Entry' },
      ],
    },
    { id: 'duration', label: 'Duration', type: 'number', suffix: 'min', operators: ['>', '<', '≥', '≤', '='] },
    { id: 'occupancy', label: 'Occupancy', type: 'number', suffix: 'people', operators: ['>', '<', '≥', '≤'] },
    { id: 'person', label: 'Person Type', type: 'select', operators: ['=', '≠'], options: [{ id: 'employee', label: 'Employee' }, { id: 'visitor', label: 'Visitor' }, { id: 'contractor', label: 'Contractor' }, { id: 'unknown', label: 'Unknown' }] },
    { id: 'time', label: 'Time', type: 'time', operators: ['after', 'before'] },
  ],
  actions: [
    { id: 'generate_alert', label: 'Generate Alert', hasSeverity: true },
    { id: 'notify_manager', label: 'Notify Manager' },
    { id: 'notify_security', label: 'Notify Security' },
    { id: 'notify_facilities', label: 'Notify Facilities' },
    { id: 'notify_it', label: 'Notify IT' },
    { id: 'send_email', label: 'Send Email' },
    { id: 'log_event', label: 'Log Event' },
    { id: 'lock_door', label: 'Lock Door' },
    { id: 'escalate', label: 'Escalate to Admin' },
  ],
  scopes: ['All sites', 'Server Room', 'All meeting rooms', 'Engineering Bay', 'Secure zones', 'Secure entries', 'Restricted areas'],
  rules: [
    { id: 'r1', name: 'After-hours server-room access', conditions: [c('zone', '=', 'server'), c('activity', '=', 'after-hours'), c('time', 'after', '20:00')], actions: [a('notify_security', 'Critical')], status: 'active', scope: 'Server Room', triggers: 3, updated: 'Today 08:10' },
    { id: 'r2', name: 'Meeting room over-run', conditions: [c('zone', '=', 'meetingA'), c('activity', '=', 'meeting-overrun'), c('duration', '>', '15')], actions: [a('notify_facilities', 'Medium')], status: 'active', scope: 'All meeting rooms', triggers: 6, updated: 'Today 14:12' },
    { id: 'r3', name: 'Workstation idle', conditions: [c('activity', '=', 'desk-idle'), c('duration', '>', '45')], actions: [a('log_event', 'Low')], status: 'active', scope: 'Engineering Bay', triggers: 4, updated: 'Today 13:48' },
    { id: 'r4', name: 'Phone use in secure zone', conditions: [c('zone', '=', 'server'), c('activity', '=', 'phone')], actions: [a('generate_alert', 'High')], status: 'active', scope: 'Secure zones', triggers: 1, updated: 'Today 10:48' },
    { id: 'r5', name: 'Tailgating at secure door', conditions: [c('activity', '=', 'tailgating'), c('person', '=', 'unknown')], actions: [a('notify_security', 'High')], status: 'pending', scope: 'Secure entries', triggers: 0, updated: 'Yesterday' },
    { id: 'r6', name: 'Visitor in restricted area', conditions: [c('zone', '=', 'server'), c('person', '=', 'visitor')], actions: [a('generate_alert', 'High')], status: 'active', scope: 'Restricted areas', triggers: 2, updated: 'Today 11:20' },
  ],
};

const RETAIL_RULES = withSummaries(RETAIL);
const CORPORATE_RULES = withSummaries(CORPORATE);

export function rulesFor(useCase) {
  return useCase === 'corporate' ? CORPORATE_RULES : RETAIL_RULES;
}
