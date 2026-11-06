import { useRef, useState } from 'react';
import { Scale, CheckCircle2, X } from 'lucide-react';

import RuleCards from './components/rules/RuleCards';
import RuleBuilder from './components/rules/RuleBuilder';
import RulesTable from './components/rules/RulesTable';
import { RULES } from './rules-data';

// ─────────────────────────────────────────────────────────────────────────────
// Rules & Policies — campus subpage (enterprise rule engine).
//
// Cards (total / active / disabled / pending), an interactive IF … AND … THEN
// rule builder, and the rules table with inline enable/disable. Saving a rule in
// the builder prepends it (pending) to the table. FRONTEND-ONLY.
// ─────────────────────────────────────────────────────────────────────────────

export default function RulesPolicies() {
  const uid = useRef(100);
  const [rules, setRules] = useState(RULES);
  const [toast, setToast] = useState(null);

  const handleSave = (rule) => {
    const id = `r${++uid.current}`;
    setRules((prev) => [{ ...rule, id, status: 'pending', scope: 'Custom', triggers: 0, updated: 'Just now' }, ...prev]);
    setToast(`Rule "${rule.name}" saved — pending review.`);
  };

  // Cycle a rule enabled ⇄ disabled (pending activates on toggle).
  const handleToggle = (id) => setRules((prev) => prev.map((r) => (
    r.id === id ? { ...r, status: r.status === 'active' ? 'disabled' : 'active' } : r
  )));

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Scale className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Rules &amp; Policies</h1>
            <p className="mt-1 text-small text-fg-muted">Enterprise rule engine — define IF/THEN policies that drive campus alerts.</p>
          </div>
        </div>

        {toast && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3 py-2.5 text-small text-success-ink">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span className="flex-1">{toast}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <RuleCards />
          <RuleBuilder onSave={handleSave} />
          <RulesTable rules={rules} onToggle={handleToggle} />
        </div>
      </div>
    </div>
  );
}
