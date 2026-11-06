// ─────────────────────────────────────────────────────────────────────────────
// Report export — turns a report request into a REAL, presentable downloaded
// file (CSV, Excel or PDF) filled with the same dummy data the campus pages
// show, through the module's shared branded writer (report-document.js), so a
// campus report looks like every other Drishyam export. FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

import { SESSIONS, DEPARTMENT_COMPARISON } from './attendance-data';
import { DEPARTMENT_PRODUCTIVITY, LIBRARY_USAGE } from './productivity-data';
import { DIRECTORY as STUDENTS } from './student-data';
import { DIRECTORY as FACULTY } from './faculty-data';
import { exportReportDocument } from '../report-document';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
const cap = (s) => String(s).replace(/^\w/, (m) => m.toUpperCase());

const TYPE_TO_KEY = {
  attendance: 'attendance', department: 'department', movement: 'movement',
  faculty: 'faculty', library: 'library', student: 'student', lab: 'lab',
};

const LABS = [
  ['Networks Lab', 2, '3h', '100%', '82%'],
  ['AI/ML Lab', 1, '2h', '90%', '78%'],
  ['DBMS Lab', 1, '1.5h', '88%', '70%'],
  ['OS Lab', 1, '1.5h', '95%', '65%'],
  ['Cyber Security Lab', 2, '3h', '92%', '74%'],
];

const MOVEMENT = [
  ['Central Library', 415, '1h 40m', '12:00'],
  ['Cafeteria', 186, '22m', '13:00'],
  ['Eng Corridors', 132, '6m', '11:00'],
  ['Auditorium Foyer', 96, '18m', '12:00'],
  ['Sports Ground', 94, '55m', '16:00'],
  ['Labs', 268, '48m', '11:00'],
];

// {columns, rows} for a report key, reusing page data for consistency.
function getDataset(key) {
  switch (key) {
    case 'department': {
      const prod = Object.fromEntries(DEPARTMENT_PRODUCTIVITY.map((d) => [d.dept, d.pct]));
      return {
        columns: ['School', 'Attendance %', 'Productivity %'],
        rows: DEPARTMENT_COMPARISON.map((d) => [d.dept, `${d.pct}%`, prod[d.dept] != null ? `${prod[d.dept]}%` : '—']),
      };
    }
    case 'attendance':
      return {
        columns: ['Time', 'Session', 'Room', 'Present', 'Expected', 'Attendance %', 'Status'],
        rows: SESSIONS.map((s) => [s.time, s.subject, s.room, s.present, s.expected, `${s.pct}%`, cap(s.status)]),
      };
    case 'student':
      return {
        columns: ['Student', 'ID', 'Department', 'Attendance %', 'Productivity %', 'Risk'],
        rows: STUDENTS.map((s) => [s.name, s.id, s.deptLabel, `${s.attendance}%`, `${s.productivity}%`, s.riskBand]),
      };
    case 'faculty':
      return {
        columns: ['Faculty', 'Department', 'Designation', 'Teaching (wk)', 'Attendance %'],
        rows: FACULTY.map((f) => [f.name, f.deptLabel, f.designationLabel, f.teachingWeek, `${f.attendance}%`]),
      };
    case 'library':
      return { columns: ['Day', 'Visits'], rows: LIBRARY_USAGE.map((l) => [l.d, l.visits]) };
    case 'lab':
      return { columns: ['Lab', 'Sessions', 'Hours', 'Attendance %', 'Utilization %'], rows: LABS };
    case 'movement':
      return { columns: ['Zone', 'Footfall', 'Avg Dwell', 'Peak Hour'], rows: MOVEMENT };
    default:
      return {
        columns: ['Metric', 'Value'],
        rows: [['People Present', '2,847'], ['Average Attendance', '88.6%'], ['Active Activities', '68'], ['Faculty on Campus', '214'], ['Library Occupancy', '415 / 600'], ['Active Alerts', '4']],
      };
  }
}

// ── public API ───────────────────────────────────────────────────────────────
// report: { title, key?, type?, period?, scope? } · format: 'CSV' | 'Excel' | 'PDF'
// Rendered by the shared branded writer (report-document.js): logo and header
// on every page, report ID, details box, paginated table.
export function exportReport(report, format) {
  const key = report.key || TYPE_TO_KEY[String(report.type || '').toLowerCase()] || 'summary';
  const { columns, rows } = getDataset(key);
  exportReportDocument({
    title: report.title,
    code: `CMP-${key.slice(0, 3)}`,
    subtitle: 'Drishyam Activity Monitoring  -  Campus report',
    details: [
      ['Organisation', 'Sharda University'],
      ['Scope', report.scope || 'All schools'],
      ['Period', report.period ? cap(report.period) : 'Custom'],
    ],
    tables: [{ title: report.title, columns, rows }],
    filename: slug(report.title),
  }, format);
  return format;
}
