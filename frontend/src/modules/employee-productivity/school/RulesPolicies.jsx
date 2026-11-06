import { useRef, useState } from 'react';
import { Scale, CheckCircle2, X } from 'lucide-react';

import { SEVERITIES, RULE_STATUS, SEVERITY_TEXT } from '../rules/rules-data';
import RuleCards from '../rules/RuleCards';
import RuleBuilder from '../rules/RuleBuilder';
import RulesTable from '../rules/RulesTable';
import { SCHOOL_RULES } from './rules-data';

// School Rules & Policies — the shared, data-driven rule engine with a
// safety-first vocabulary (unattended child, tailgating, perimeter, fight).
export default function SchoolRulesPolicies() {
  const uid = useRef(100);
  const [rules, setRules] = useState(SCHOOL_RULES.rules);
  const [toast, setToast] = useState(null);

  const handleSave = (rule) => {
    const id = `r${++uid.current}`;
    setRules((prev) => [{ ...rule, id, status: 'pending', scope: 'Custom', triggers: 0, updated: 'Just now' }, ...prev]);
    setToast(`Rule "${rule.name}" saved — pending review.`);
  };
  const handleToggle = (id) => setRules((prev) => prev.map((r) => (r.id === id ? { ...r, status: r.status === 'active' ? 'disabled' : 'active' } : r)));

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Scale className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Rules &amp; Policies</h1>
            <p className="mt-1 text-small text-fg-muted">Enterprise rule engine — IF/THEN safety policies driving school alerts.</p>
          </div>
        </div>

        {toast && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3 py-2.5 text-small text-success-ink">
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <RuleCards cards={SCHOOL_RULES.cards} />
          <RuleBuilder fields={SCHOOL_RULES.fields} actions={SCHOOL_RULES.actions} severities={SEVERITIES} onSave={handleSave} />
          <RulesTable rules={rules} onToggle={handleToggle} statusMeta={RULE_STATUS} severityText={SEVERITY_TEXT} />
        </div>
      </div>
    </div>
  );
}
