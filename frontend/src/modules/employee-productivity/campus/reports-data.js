// ─────────────────────────────────────────────────────────────────────────────
// Reports — dummy-data layer (Campus / Education subpage).
//
// FRONTEND-ONLY reports centre. Report categories (Department / Faculty /
// Student / Library / Lab / Attendance / Movement) form a library of generable
// reports; period (Daily / Weekly / Monthly) scopes them; PDF / Excel / CSV are
// export formats. Plus a recent-reports history and scheduled (auto) reports.
// Future backend: GET /campus/reports/* · POST /campus/reports/generate.
// ─────────────────────────────────────────────────────────────────────────────

export const PERIODS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

// Report library — one card per category. `stat` is a headline preview number.
export const REPORT_TYPES = [
  { key: 'department', title: 'Department Report', desc: 'Attendance, productivity & activity per school', stat: '10 schools', updated: 'Today 09:00' },
  { key: 'faculty', title: 'Faculty Report', desc: 'Teaching hours, room use & student interaction', stat: '214 faculty', updated: 'Today 09:00' },
  { key: 'student', title: 'Student Report', desc: 'Attendance, movement & learning score', stat: '2,847 students', updated: 'Today 08:30' },
  { key: 'library', title: 'Library Report', desc: 'Occupancy, visits & borrow activity', stat: '1,180 visits', updated: 'Today 09:15' },
  { key: 'lab', title: 'Lab Report', desc: 'Lab utilization & session attendance', stat: '42 sessions', updated: 'Today 09:10' },
  { key: 'attendance', title: 'Attendance Report', desc: 'Present, absent, late & exceptions', stat: '88.6% avg', updated: 'Today 09:00' },
  { key: 'movement', title: 'Movement Report', desc: 'Footfall, zone dwell & transit patterns', stat: '12.4k moves', updated: 'Today 09:05' },
];

// Recent (already generated) reports — the download history.
export const RECENT_REPORTS = [
  { name: 'Daily Attendance — 22 Jul', type: 'Attendance', period: 'Daily', scope: 'All schools', generated: 'Today 09:00', size: '240 KB', format: 'PDF' },
  { name: 'Weekly Department Summary — W29', type: 'Department', period: 'Weekly', scope: 'All schools', generated: 'Yesterday', size: '1.2 MB', format: 'Excel' },
  { name: 'Student Movement — 21 Jul', type: 'Movement', period: 'Daily', scope: 'Computing S&E', generated: 'Yesterday', size: '880 KB', format: 'CSV' },
  { name: 'Faculty Teaching Hours — W29', type: 'Faculty', period: 'Weekly', scope: 'All schools', generated: '2 days ago', size: '640 KB', format: 'PDF' },
  { name: 'Library Usage — Jun', type: 'Library', period: 'Monthly', scope: 'Central Library', generated: '1 Jul 2026', size: '1.6 MB', format: 'Excel' },
  { name: 'Monthly Attendance — Jun', type: 'Attendance', period: 'Monthly', scope: 'All schools', generated: '1 Jul 2026', size: '2.1 MB', format: 'PDF' },
];

// Scheduled (auto-generated & emailed) reports — this is where Daily / Weekly /
// Monthly live as cadences.
export const SCHEDULED = [
  { id: 's1', report: 'Daily Attendance Digest', frequency: 'Daily', time: '09:00', recipients: 'Deans, Registrar', format: 'PDF', status: 'active' },
  { id: 's2', report: 'Weekly Department Summary', frequency: 'Weekly', time: 'Mon 08:00', recipients: 'HODs', format: 'Excel', status: 'active' },
  { id: 's3', report: 'Monthly Productivity Review', frequency: 'Monthly', time: '1st · 08:00', recipients: 'Management', format: 'PDF', status: 'active' },
  { id: 's4', report: 'Library Usage Export', frequency: 'Weekly', time: 'Fri 18:00', recipients: 'Librarian', format: 'CSV', status: 'paused' },
];

export const FORMAT_META = {
  PDF: { label: 'PDF', chip: 'bg-danger-soft text-danger-ink ring-danger-line' },
  Excel: { label: 'Excel', chip: 'bg-success-soft text-success-ink ring-success-line' },
  CSV: { label: 'CSV', chip: 'bg-info-soft text-info-ink ring-info-line' },
};
