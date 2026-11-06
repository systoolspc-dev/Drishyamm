/**
 * Staff activity (Activity Monitoring) — every page of the module, in plain
 * words, for the sidebar AND the "All pages" strip on the module's overview.
 *
 * The module has 40+ pages across seven verticals. The sidebar used to list
 * every one of them for the active vertical (up to 13 rows), which is what made
 * the customer menu read like an engineering console. Now the sidebar shows the
 * overview plus at most four `primary` pages for the account's vertical; the
 * rest are one click away on the overview page (ActivitySectionsStrip). The
 * URLs are unchanged.
 *
 * Visibility per vertical is unchanged from the old sidebar:
 *   needsParam  the vertical's employee-productivity params must carry it
 *   hideFor     hidden for these verticals
 *   labelFor    a per-vertical label for the same page
 *   primary     true, or a list of verticals: shown in the sidebar
 */
import {
  LayoutDashboard, Users, Radar, GraduationCap, Presentation, UsersRound, DoorOpen,
  ClipboardCheck, Gauge, FileSpreadsheet, Scale, ShieldAlert, Bus, ShieldCheck,
  UserPlus, LayoutGrid, ArrowLeftRight, UtensilsCrossed, Sparkles, Wrench, BellRing,
  ConciergeBell, Coins, ScrollText, ChartColumn, Trophy, ClipboardList, SlidersHorizontal,
} from 'lucide-react';

// Verticals with their own equivalents of the store/office pages.
const NOT_STORE_OFFICE = ['campus', 'school', 'hostel', 'hospitality', 'bank'];
const STORE_OFFICE = ['retail', 'corporate'];

export const ACTIVITY_PAGES = [
  { to: '/activity-monitoring', label: 'Overview', icon: LayoutDashboard, end: true, primary: true },

  // Store / office
  // ONE log for the module's staff events — breaks, idle, phone detections and
  // clock-ins. Breaks & Idle and Phone Use used to be a sidebar row each,
  // rendering the same table with a different event type filtered in; the
  // sidebar was carrying a row per event type. Those URLs redirect into this
  // page pre-filtered (App.jsx), so the old rows' views are a chip away.
  { to: '/activity-monitoring/activity-log', label: 'Activity log', icon: ScrollText, hideFor: NOT_STORE_OFFICE, primary: true },
  // Every vertical has it; the five with their own attendance page call this
  // one by what it is, so the strip never shows two rows named "Attendance".
  {
    to: '/attendance-report', label: 'Attendance', icon: ClipboardList, primary: STORE_OFFICE,
    labelFor: Object.fromEntries(NOT_STORE_OFFICE.map((v) => [v, 'Attendance sheet'])),
  },
  // Staff Performance stays a sidebar page: it is the way into a person's
  // profile, where the parameters their score is built from are read.
  { to: '/activity-monitoring/performance', label: 'Staff performance', icon: Trophy, hideFor: NOT_STORE_OFFICE, primary: true },
  { to: '/activity-monitoring/zones',   label: 'Counter cover', icon: LayoutGrid, needsParam: 'zones' },
  // The module's own zone configuration: which zones staff are posted on and
  // the coverage limits. Zone SHAPES stay in Occupancy › Zone Setup — this
  // page links there rather than drawing a second canvas.
  { to: '/activity-monitoring/zone-setup', label: 'Zone setup', icon: SlidersHorizontal, needsParam: 'zones' },
  {
    to: '/activity-monitoring/analytics', label: 'Trends', icon: ChartColumn,
    matchPrefix: true, hideFor: NOT_STORE_OFFICE,
  },
  { to: '/activity-monitoring/reports',  label: 'Activity reports', icon: FileSpreadsheet, hideFor: NOT_STORE_OFFICE },
  { to: '/activity-monitoring/policies', label: 'Rules',            icon: Scale,           hideFor: NOT_STORE_OFFICE },

  // Every vertical
  { to: '/activity-monitoring/headcount', label: 'People in zones', icon: Users, needsParam: 'headcount' },

  // Campus
  { to: '/activity-monitoring/live-activity',    label: 'Live activity', icon: Radar,          needsParam: 'campus', primary: true },
  { to: '/activity-monitoring/attendance-intel', label: 'Attendance',    icon: ClipboardCheck, needsParam: 'campus', primary: true },
  { to: '/activity-monitoring/rooms',            label: 'Rooms',         icon: DoorOpen,       needsParam: 'campus', primary: true },
  { to: '/activity-monitoring/student',          label: 'Students',      icon: GraduationCap,  needsParam: 'campus' },
  { to: '/activity-monitoring/faculty',          label: 'Teachers',      icon: Presentation,   needsParam: 'campus' },
  { to: '/activity-monitoring/groups',           label: 'Group work',    icon: UsersRound,     needsParam: 'campus' },
  { to: '/activity-monitoring/productivity',     label: 'Productivity',  icon: Gauge,          needsParam: 'campus' },
  { to: '/activity-monitoring/campus-reports',   label: 'Activity reports', icon: FileSpreadsheet, needsParam: 'campus', primary: true },
  { to: '/activity-monitoring/rules',            label: 'Rules',         icon: Scale,          needsParam: 'campus' },

  // School
  { to: '/activity-monitoring/school/attendance', label: 'Attendance',  icon: ClipboardCheck, needsParam: 'school', primary: true },
  { to: '/activity-monitoring/school/safety',     label: 'Safety',      icon: ShieldAlert,    needsParam: 'school', primary: true },
  { to: '/activity-monitoring/school/visitors',   label: 'Visitors',    icon: UserPlus,       needsParam: 'school', primary: true },
  { to: '/activity-monitoring/school/dismissal',  label: 'Pickup',      icon: DoorOpen,       needsParam: 'school', primary: true },
  { to: '/activity-monitoring/school/transport',  label: 'Transport',   icon: Bus,            needsParam: 'school' },
  { to: '/activity-monitoring/school/guardians',  label: 'Guardians',   icon: ShieldCheck,    needsParam: 'school' },
  { to: '/activity-monitoring/school/student',    label: 'Students',    icon: GraduationCap,  needsParam: 'school' },
  { to: '/activity-monitoring/school/rooms',      label: 'Classrooms',  icon: LayoutGrid,     needsParam: 'school' },
  { to: '/activity-monitoring/school/reports',    label: 'Activity reports', icon: FileSpreadsheet, needsParam: 'school' },
  { to: '/activity-monitoring/school/rules',      label: 'Rules',       icon: Scale,          needsParam: 'school' },

  // Hostel
  { to: '/activity-monitoring/hostel/movement',     label: 'In & out',      icon: ArrowLeftRight,  needsParam: 'hostel', primary: true },
  { to: '/activity-monitoring/hostel/security',     label: 'Security',      icon: ShieldAlert,     needsParam: 'hostel', primary: true },
  { to: '/activity-monitoring/hostel/staff',        label: 'Staff',         icon: UsersRound,      needsParam: 'hostel', primary: true },
  { to: '/activity-monitoring/hostel/dining',       label: 'Dining',        icon: UtensilsCrossed, needsParam: 'hostel', primary: true },
  { to: '/activity-monitoring/hostel/housekeeping', label: 'Housekeeping',  icon: Sparkles,        needsParam: 'hostel' },
  { to: '/activity-monitoring/hostel/maintenance',  label: 'Maintenance',   icon: Wrench,          needsParam: 'hostel' },
  { to: '/activity-monitoring/hostel/safety',       label: 'Safety',        icon: ShieldCheck,     needsParam: 'hostel' },
  { to: '/activity-monitoring/hostel/productivity', label: 'Productivity',  icon: Gauge,           needsParam: 'hostel' },
  { to: '/activity-monitoring/hostel/alerts',       label: 'Hostel alerts', icon: BellRing,        needsParam: 'hostel' },
  { to: '/activity-monitoring/hostel/reports',      label: 'Activity reports', icon: FileSpreadsheet, needsParam: 'hostel' },

  // Hospitality
  { to: '/activity-monitoring/hospitality/guest-service', label: 'Guest service', icon: ConciergeBell,  needsParam: 'hospitality', primary: true },
  { to: '/activity-monitoring/hospitality/housekeeping',  label: 'Housekeeping',  icon: Sparkles,       needsParam: 'hospitality', primary: true },
  { to: '/activity-monitoring/hospitality/staff',         label: 'Staff',         icon: UsersRound,     needsParam: 'hospitality', primary: true },
  { to: '/activity-monitoring/hospitality/safety',        label: 'Safety',        icon: ShieldCheck,    needsParam: 'hospitality', primary: true },
  { to: '/activity-monitoring/hospitality/movement',      label: 'In & out',      icon: ArrowLeftRight, needsParam: 'hospitality' },
  { to: '/activity-monitoring/hospitality/productivity',  label: 'Productivity',  icon: Gauge,          needsParam: 'hospitality' },
  { to: '/activity-monitoring/hospitality/reports',       label: 'Activity reports', icon: FileSpreadsheet, needsParam: 'hospitality' },

  // Bank
  { to: '/activity-monitoring/bank/teller',       label: 'Counters',      icon: Users,          needsParam: 'bank', primary: true },
  { to: '/activity-monitoring/bank/cash-ops',     label: 'Cash handling', icon: Coins,          needsParam: 'bank', primary: true },
  { to: '/activity-monitoring/bank/security',     label: 'Security',      icon: ShieldAlert,    needsParam: 'bank', primary: true },
  { to: '/activity-monitoring/bank/staff-roster', label: 'Staff',         icon: UsersRound,     needsParam: 'bank', primary: true },
  { to: '/activity-monitoring/bank/movement',     label: 'In & out',      icon: ArrowLeftRight, needsParam: 'bank' },
  { to: '/activity-monitoring/bank/facility',     label: 'Building',      icon: Wrench,         needsParam: 'bank' },
  { to: '/activity-monitoring/bank/productivity', label: 'Productivity',  icon: Gauge,          needsParam: 'bank' },
  { to: '/activity-monitoring/bank/alerts',       label: 'Branch alerts', icon: BellRing,       needsParam: 'bank' },
  { to: '/activity-monitoring/bank/reports',      label: 'Activity reports', icon: FileSpreadsheet, needsParam: 'bank' },
];

/** Pages of the module this vertical shows (params = its employee-productivity params). */
export function activityPagesFor(useCase, params = {}) {
  return ACTIVITY_PAGES
    .filter((p) => (!p.needsParam || params[p.needsParam])
      && (!p.hideFor || !p.hideFor.includes(useCase)))
    .map((p) => (p.labelFor?.[useCase] ? { ...p, label: p.labelFor[useCase] } : p));
}

/** Is this page one of the few the sidebar lists for `useCase`? */
export function isPrimaryActivityPage(page, useCase) {
  return Array.isArray(page.primary) ? page.primary.includes(useCase) : page.primary === true;
}
