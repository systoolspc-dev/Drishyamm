import { UserCheck, UserX, AlarmClock, LogOut, DoorOpen, ShieldCheck } from 'lucide-react';
import { CARDS } from '../../attendance-data';

const ICONS = {
  present: UserCheck, absent: UserX, late: AlarmClock,
  away: LogOut, early: DoorOpen, overrides: ShieldCheck,
};

// Six attendance cards — uniform accent tiles, same calm system as the rest of
// the module (meaning lives in the value + sub, not tile colour).
export default function AttendanceCards() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {CARDS.map((c) => {
        const Icon = ICONS[c.key] || UserCheck;
        return (
          <div key={c.key} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
            <p className="mt-1 text-metric-sm font-bold leading-none tracking-tight text-fg">{c.value}</p>
            <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
