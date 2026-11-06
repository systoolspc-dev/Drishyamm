import { ClipboardCheck, Activity, ShieldAlert, Gauge, Clock, MapPin } from 'lucide-react';
import { STATUS_META, RISK_META } from '../../student-data';

function initials(name) {
  return (name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
}

// Identity header for the selected student.
export function StudentIdentity({ student }) {
  const st = STATUS_META[student.status] || STATUS_META.absent;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">
        {initials(student.name)}
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-fg sm:text-base">{student.name}</h2>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${st.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}
          </span>
        </div>
        <p className="truncate text-small text-fg-muted">
          {student.id} · {student.deptLabel} · Semester {student.sem}
        </p>
      </div>
    </div>
  );
}

// The five summary cards. Uniform accent tiles — colour signal lives only in the
// risk band and the status dot, matching the dashboard's calm KPI language.
export default function StudentCards({ student }) {
  const cards = [
    { icon: ClipboardCheck, label: 'Attendance', value: `${student.attendance}`, unit: '%', sub: 'this term' },
    { icon: Activity, label: 'Current Activity', value: student.activity, sub: student.room, small: true },
    { icon: ShieldAlert, label: 'Risk Score', value: `${student.risk}`, sub: student.riskBand, riskBand: student.riskBand },
    { icon: Gauge, label: 'Productivity', value: `${student.productivity}`, unit: '%', sub: 'engagement index' },
    { icon: Clock, label: 'Last Seen', value: student.lastSeen, sub: student.lastSeenRoom, small: true, pin: true },
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
            <p
              className={`mt-1 font-bold leading-tight tracking-tight text-fg ${c.small ? 'text-body' : 'text-metric-sm leading-none'}`}
              title={c.value}
            >
              <span className={c.small ? 'line-clamp-1' : ''}>{c.value}</span>
              {c.unit && <span className="ml-0.5 text-small font-semibold text-fg-subtle">{c.unit}</span>}
            </p>
            <p className={`mt-1.5 flex items-center gap-1 truncate text-micro ${c.riskBand ? `font-semibold ${RISK_META[c.riskBand]}` : 'text-fg-subtle'}`} title={c.sub}>
              {c.pin && <MapPin className="h-3 w-3 shrink-0" />}
              <span className="truncate">{c.sub}</span>
            </p>
          </div>
        );
      })}
    </div>
  );
}
