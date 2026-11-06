import { ClipboardCheck, Presentation, Clock3, DoorOpen, MapPin } from 'lucide-react';
import { STATUS_META } from '../../faculty-data';

function initials(name) {
  return (name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
}

// Identity header for the selected faculty member.
export function FacultyIdentity({ faculty }) {
  const st = STATUS_META[faculty.status] || STATUS_META.off;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">
        {initials(faculty.name)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-fg sm:text-base">{faculty.name}</h2>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${st.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}
          </span>
        </div>
        <p className="truncate text-small text-fg-muted">
          {faculty.id} · {faculty.deptLabel} · {faculty.designationLabel}
        </p>
      </div>
    </div>
  );
}

// Five summary cards — same calm uniform-accent style as the student page.
export default function FacultyCards({ faculty }) {
  const cards = [
    { icon: ClipboardCheck, label: 'Attendance', value: `${faculty.attendance}`, unit: '%', sub: 'this term' },
    { icon: Presentation, label: 'Current Activity', value: faculty.activity, sub: faculty.room, small: true },
    { icon: Clock3, label: 'Teaching Hours', value: faculty.teachingToday, sub: `${faculty.teachingWeek} this week` },
    { icon: DoorOpen, label: 'Office Hours', value: faculty.officeStatus, sub: faculty.officeRoom, small: true },
    { icon: MapPin, label: 'Last Seen', value: faculty.lastSeen, sub: faculty.lastSeenRoom, small: true, pin: true },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
            <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-body leading-tight' : 'text-metric-sm leading-none'}`} title={c.value}>
              <span className={c.small ? 'line-clamp-1' : ''}>{c.value}</span>
              {c.unit && <span className="ml-0.5 text-small font-semibold text-fg-subtle">{c.unit}</span>}
            </p>
            <p className="mt-1.5 flex items-center gap-1 truncate text-micro text-fg-subtle" title={c.sub}>
              {c.pin && <MapPin className="h-3 w-3 shrink-0" />}
              <span className="truncate">{c.sub}</span>
            </p>
          </div>
        );
      })}
    </div>
  );
}
