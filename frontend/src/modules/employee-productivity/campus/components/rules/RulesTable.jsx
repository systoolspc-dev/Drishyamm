import { ListChecks } from 'lucide-react';
import Panel from '../Panel';
import { RULE_STATUS, SEVERITY_TEXT } from '../../rules-data';

// Existing rules table with an inline enable/disable toggle (local state via the
// parent). Pending rules can be activated too.
export default function RulesTable({ rules, onToggle }) {
  return (
    <Panel icon={ListChecks} title="Rules" count={rules.length} bodyClass="p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-2 pb-2 font-semibold">Rule</th>
              <th className="px-2 pb-2 font-semibold">Action</th>
              <th className="px-2 pb-2 font-semibold">Severity</th>
              <th className="px-2 pb-2 font-semibold">Scope</th>
              <th className="px-2 pb-2 text-right font-semibold">Triggers</th>
              <th className="px-2 pb-2 font-semibold">Status</th>
              <th className="px-2 pb-2 text-right font-semibold">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {rules.map((r) => {
              const st = RULE_STATUS[r.status] || RULE_STATUS.pending;
              const on = r.status === 'active';
              return (
                <tr key={r.id} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2.5">
                    <p className="font-semibold text-fg">{r.name}</p>
                    <p className="text-micro text-fg-subtle">{r.summary}</p>
                  </td>
                  <td className="px-2 py-2.5 text-fg-secondary">{r.action}</td>
                  <td className={`px-2 py-2.5 font-semibold ${SEVERITY_TEXT[r.severity] || 'text-fg-muted'}`}>{r.severity}</td>
                  <td className="px-2 py-2.5 text-fg-muted">{r.scope}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-fg-secondary">{r.triggers}</td>
                  <td className="px-2 py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${st.chip}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <button
                      role="switch"
                      aria-checked={on}
                      onClick={() => onToggle(r.id)}
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
      </div>
    </Panel>
  );
}
