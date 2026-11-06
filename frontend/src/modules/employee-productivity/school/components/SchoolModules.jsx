import { Link } from 'react-router-dom';
import {
  ClipboardCheck, ShieldAlert, Bus, DoorOpen, UserPlus, GraduationCap, DoorClosed, FileSpreadsheet, Scale, LayoutGrid, ShieldCheck,
} from 'lucide-react';

// On-dashboard launcher for the school subpages — so they're reachable directly
// from the dashboard, not only via the sidebar group.
const MODULES = [
  { to: '/activity-monitoring/school/attendance', label: 'Attendance', icon: ClipboardCheck },
  { to: '/activity-monitoring/school/safety', label: 'Safety & Security', icon: ShieldAlert },
  { to: '/activity-monitoring/school/transport', label: 'Transport', icon: Bus },
  { to: '/activity-monitoring/school/dismissal', label: 'Dismissal & Pickup', icon: DoorOpen },
  { to: '/activity-monitoring/school/guardians', label: 'Guardian Registry', icon: ShieldCheck },
  { to: '/activity-monitoring/school/visitors', label: 'Visitors', icon: UserPlus },
  { to: '/activity-monitoring/school/student', label: 'Student Activity', icon: GraduationCap },
  { to: '/activity-monitoring/school/rooms', label: 'Room Analytics', icon: DoorClosed },
  { to: '/activity-monitoring/school/reports', label: 'Reports', icon: FileSpreadsheet },
  { to: '/activity-monitoring/school/rules', label: 'Rules & Policies', icon: Scale },
];

export default function SchoolModules() {
  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <LayoutGrid className="h-3.5 w-3.5 text-brand" />
        <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Explore modules</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {MODULES.map((m) => (
          <Link
            key={m.to}
            to={m.to}
            className="group flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-2 py-3 text-center transition hover:border-brand/40 hover:bg-brand/[0.04] hover:shadow-sm"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-white">
              <m.icon className="h-5 w-5" strokeWidth={2} />
            </span>
            <span className="text-caption font-semibold leading-tight text-fg-secondary group-hover:text-brand-ink">{m.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
