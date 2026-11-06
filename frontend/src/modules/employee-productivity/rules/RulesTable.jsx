import { ListChecks, Pencil } from 'lucide-react';
import RulePanel from './RulePanel';

// `border-separate` rather than `border-collapse`: collapsed borders stay put
// while a sticky header moves, so the header's bottom rule would scroll away.
// Row dividers therefore sit on the cells, not on <tr>.
const th = 'px-4 py-3 font-semibold';
const td = 'border-b border-line-subtle px-4 py-3';
const chip = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide ring-1 lg:text-caption';

// Existing rules table with an inline enable/disable toggle. The body scrolls
// under a pinned header; pass `className="lg:flex-1 lg:min-h-0"` to let it fill
// the remaining height of a viewport-contained page. With `onEdit`, a row (or
// its name, from the keyboard) opens that rule for editing.
export default function RulesTable({ rules, onToggle, onEdit, statusMeta, severityText, className = '' }) {
  return (
    <RulePanel
      icon={ListChecks}
      title="Rules"
      count={rules.length}
      className={`overflow-hidden ${className}`}
      bodyClassName="scrollbar-thin min-h-0 flex-1 overflow-auto"
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-surface shadow-sm">
          <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
            <th className={th}>Rule</th>
            <th className={th}>Action</th>
            <th className={th}>Severity</th>
            <th className={th}>Scope</th>
            <th className={`${th} text-right`}>Triggers</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => {
            const st = statusMeta[r.status] || statusMeta.pending;
            const on = r.status === 'active';
            return (
              <tr
                key={r.id}
                onClick={onEdit ? () => onEdit(r) : undefined}
                className={`group hover:bg-surface-sunken ${onEdit ? 'cursor-pointer' : ''}`}
              >
                <td className={`${td} min-w-[14rem]`}>
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onEdit(r); }}
                      className="inline-flex items-center gap-1.5 text-left font-semibold text-fg hover:text-brand-ink focus-visible:text-brand-ink focus-visible:outline-none focus-visible:underline"
                    >
                      {r.name}
                      <Pencil className="h-3 w-3 shrink-0 text-fg-subtle opacity-0 transition group-hover:opacity-100" aria-hidden />
                    </button>
                  ) : (
                    <p className="font-semibold text-fg">{r.name}</p>
                  )}
                  <p className="text-micro text-fg-subtle">{r.summary}</p>
                </td>
                <td className={`${td} text-fg-secondary`}>{r.action}</td>
                <td className={td}>
                  <span className={`${chip} bg-current/10 ring-current/20 ${severityText[r.severity] || 'text-fg-muted'}`}>{r.severity}</span>
                </td>
                <td className={td}>
                  <span className={`${chip} bg-surface-muted text-fg-muted ring-line`}>{r.scope}</span>
                </td>
                <td className={`${td} text-right tabular-nums text-fg-secondary`}>{r.triggers}</td>
                <td className={td}>
                  <span className={`${chip} ${st.chip}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}
                  </span>
                </td>
                <td className={`${td} text-right`}>
                  <button
                    role="switch"
                    aria-checked={on}
                    onClick={(e) => { e.stopPropagation(); onToggle(r.id); }}
                    title={on ? 'Disable rule' : 'Enable rule'}
                    className={`relative inline-block h-5 w-9 rounded-full align-middle transition-colors ${on ? 'bg-brand' : 'bg-line-strong'}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </RulePanel>
  );
}
