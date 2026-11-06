// School (K-12) rule set for the shared rules engine — safety-first vocabulary.
export const SCHOOL_RULES = {
  cards: [
    { key: 'total', label: 'Total Rules', value: '18', sub: 'across the school' },
    { key: 'active', label: 'Active Rules', value: '15', sub: 'currently enforced' },
    { key: 'disabled', label: 'Disabled Rules', value: '2', sub: 'switched off' },
    { key: 'pending', label: 'Pending Review', value: '1', sub: 'awaiting approval' },
  ],
  fields: [
    {
      id: 'zone', label: 'Zone', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'gate', label: 'Gate' }, { id: 'classroom', label: 'Classroom' }, { id: 'corridor', label: 'Corridor' },
        { id: 'playground', label: 'Playground' }, { id: 'labstore', label: 'Lab Store' }, { id: 'rooftop', label: 'Rooftop' },
        { id: 'pool', label: 'Pool' }, { id: 'busbay', label: 'Bus Bay' }, { id: 'reception', label: 'Reception' },
      ],
    },
    {
      id: 'activity', label: 'Activity', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'unattended', label: 'Unattended Child' }, { id: 'restricted', label: 'Restricted-Zone Entry' }, { id: 'tailgating', label: 'Tailgating' },
        { id: 'fight', label: 'Fight / Scuffle' }, { id: 'perimeter', label: 'Perimeter Breach' }, { id: 'loitering', label: 'Loitering' },
        { id: 'phone', label: 'Phone Use' }, { id: 'late', label: 'Late Arrival' },
        { id: 'temp-pickup', label: 'Temporary Pickup' }, { id: 'unauthorized-pickup', label: 'Unauthorized Pickup' },
      ],
    },
    {
      id: 'verification', label: 'Verification', type: 'select', operators: ['=', '≠'],
      options: [
        { id: 'clean', label: 'Clean match' }, { id: 'face-mismatch', label: 'Face mismatch' },
        { id: 'outside-window', label: 'Outside window' }, { id: 'otp-fail', label: 'OTP fail' },
      ],
    },
    { id: 'duration', label: 'Duration', type: 'number', suffix: 'min', operators: ['>', '<', '≥', '≤', '='] },
    { id: 'person', label: 'Person Type', type: 'select', operators: ['=', '≠'], options: [{ id: 'student', label: 'Student' }, { id: 'teacher', label: 'Teacher' }, { id: 'staff', label: 'Staff' }, { id: 'visitor', label: 'Visitor' }, { id: 'unknown', label: 'Unknown' }] },
    { id: 'time', label: 'Time', type: 'time', operators: ['after', 'before'] },
  ],
  actions: [
    { id: 'generate_alert', label: 'Generate Alert', hasSeverity: true },
    { id: 'notify_security', label: 'Notify Security' },
    { id: 'notify_principal', label: 'Notify Principal' },
    { id: 'notify_teacher', label: 'Notify Class Teacher' },
    { id: 'notify_parent', label: 'Notify Parent' },
    { id: 'lock_gate', label: 'Lock Gate' },
    { id: 'announce', label: 'PA Announcement' },
    { id: 'log_event', label: 'Log Event' },
  ],
  rules: [
    { id: 'r1', name: 'Unattended child near restricted zone', summary: 'Zone = Lab Store · Activity = Unattended Child', action: 'Notify Security', severity: 'Critical', status: 'active', scope: 'All restricted zones', triggers: 1, updated: 'Today 10:35' },
    { id: 'r2', name: 'Fight / scuffle detected', summary: 'Activity = Fight / Scuffle', action: 'Notify Principal', severity: 'Critical', status: 'active', scope: 'School-wide', triggers: 0, updated: 'Yesterday' },
    { id: 'r3', name: 'Tailgating at main gate', summary: 'Zone = Gate · Activity = Tailgating · Person = Unknown', action: 'Notify Security', severity: 'High', status: 'active', scope: 'Gates', triggers: 2, updated: 'Today 08:40' },
    { id: 'r4', name: 'Student at perimeter during class', summary: 'Activity = Perimeter Breach · Person = Student · Time after 09:00', action: 'Generate Alert', severity: 'High', status: 'active', scope: 'Perimeter', triggers: 0, updated: 'Today 09:00' },
    { id: 'r5', name: 'Late arrival — notify parent', summary: 'Activity = Late Arrival · Person = Student', action: 'Notify Parent', severity: 'Low', status: 'active', scope: 'All grades', triggers: 42, updated: 'Today 08:15' },
    { id: 'r6', name: 'Loitering in corridor', summary: 'Activity = Loitering · Duration > 10 min', action: 'Log Event', severity: 'Low', status: 'pending', scope: 'Corridors', triggers: 3, updated: 'Today 10:12' },
    // Temporary-pickup policy — thresholds live here, not in code.
    { id: 'r7', name: 'Temporary pickup — deviation', summary: 'Activity = Temporary Pickup · Verification ≠ Clean match (face-mismatch / outside-window / OTP fail)', action: 'Notify Security', severity: 'High', status: 'active', scope: 'Gates', triggers: 1, updated: 'Today 14:24' },
    { id: 'r8', name: 'Temporary pickup — clean match', summary: 'Activity = Temporary Pickup · Verification = Clean match', action: 'Log Event', severity: 'Low', status: 'active', scope: 'Gates', triggers: 6, updated: 'Today 14:20' },
  ],
};
