import { Link } from 'react-router-dom';
import { Users, Coins, ArrowLeftRight, ShieldAlert, Wrench, UsersRound, Gauge, BellRing, FileSpreadsheet, LayoutGrid } from 'lucide-react';

const MODULES = [
  { to: '/activity-monitoring/bank/teller', label: 'Teller', icon: Users },
  { to: '/activity-monitoring/bank/cash-ops', label: 'Cash Ops', icon: Coins },
  { to: '/activity-monitoring/bank/movement', label: 'Movement', icon: ArrowLeftRight },
  { to: '/activity-monitoring/bank/security', label: 'Security', icon: ShieldAlert },
  { to: '/activity-monitoring/bank/facility', label: 'Facility', icon: Wrench },
  { to: '/activity-monitoring/bank/staff-roster', label: 'Staff', icon: UsersRound },
  { to: '/activity-monitoring/bank/productivity', label: 'Productivity', icon: Gauge },
  { to: '/activity-monitoring/bank/alerts', label: 'Alerts', icon: BellRing },
  { to: '/activity-monitoring/bank/reports', label: 'Reports', icon: FileSpreadsheet },
];

export default function BankModules() {
  return (
    <div className="mb-4 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <LayoutGrid className="h-3.5 w-3.5 text-brand" />
        <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Explore modules</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
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
