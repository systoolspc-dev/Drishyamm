import { Link } from 'react-router-dom';
import { ConciergeBell, Sparkles, ArrowLeftRight, ShieldCheck, Users, Gauge, FileSpreadsheet, LayoutGrid } from 'lucide-react';

const MODULES = [
  { to: '/activity-monitoring/hospitality/guest-service', label: 'Guest Service', icon: ConciergeBell },
  { to: '/activity-monitoring/hospitality/housekeeping', label: 'Housekeeping', icon: Sparkles },
  { to: '/activity-monitoring/hospitality/movement', label: 'Movement', icon: ArrowLeftRight },
  { to: '/activity-monitoring/hospitality/safety', label: 'Safety', icon: ShieldCheck },
  { to: '/activity-monitoring/hospitality/staff', label: 'Staff', icon: Users },
  { to: '/activity-monitoring/hospitality/productivity', label: 'Productivity', icon: Gauge },
  { to: '/activity-monitoring/hospitality/reports', label: 'Reports', icon: FileSpreadsheet },
];

export default function HospitalityModules() {
  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <LayoutGrid className="h-3.5 w-3.5 text-brand" />
        <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Explore modules</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {MODULES.map((m) => (
          <Link key={m.to} to={m.to} className="group flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-2 py-3 text-center transition hover:border-brand/40 hover:bg-brand/[0.04] hover:shadow-sm">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand transition group-hover:bg-brand group-hover:text-white"><m.icon className="h-5 w-5" strokeWidth={2} /></span>
            <span className="text-caption font-semibold leading-tight text-fg-secondary group-hover:text-brand-ink">{m.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
