import { Building2, Presentation, GraduationCap, BookOpen, FlaskConical, ClipboardCheck, Route, Clock } from 'lucide-react';
import { REPORT_TYPES } from '../../reports-data';
import ExportButtons from './ExportButtons';

const ICONS = {
  department: Building2, faculty: Presentation, student: GraduationCap,
  library: BookOpen, lab: FlaskConical, attendance: ClipboardCheck, movement: Route,
};

// Report Library — one card per report category. The active period (Daily /
// Weekly / Monthly) scopes what each export generates.
export default function ReportLibrary({ period, onExport }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {REPORT_TYPES.map((r) => {
        const Icon = ICONS[r.key] || Building2;
        return (
          <div key={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:shadow-md">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                <Icon className="h-5 w-5" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-bold text-fg">{r.title}</p>
                <p className="mt-0.5 text-caption leading-snug text-fg-muted">{r.desc}</p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span className="rounded-md bg-surface-sunken px-2 py-0.5 text-caption font-semibold text-fg-secondary ring-1 ring-line">{r.stat}</span>
              <span className="inline-flex items-center gap-1 text-micro text-fg-subtle"><Clock className="h-3 w-3" /> {r.updated}</span>
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-line-subtle pt-3">
              <span className="text-micro font-medium capitalize text-fg-subtle">{period} report</span>
              <ExportButtons onExport={(fmt) => onExport({ title: r.title, key: r.key, period, scope: 'All schools' }, fmt)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
