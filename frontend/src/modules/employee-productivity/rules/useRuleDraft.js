import { useState } from 'react';
import { fieldDefOf, conditionText, actionText } from './rules-data';

// The editable state of one IF … AND … THEN rule, shared by the inline Rule
// Builder card (school) and the Rule Builder drawer (retail / corporate), so
// both edit, preview and save a rule the same way.
//
// `initial` (optional) is a structured rule to edit: { name, conditions,
// actions, scope }. Without it the draft starts from a sensible default built
// from the vocabulary. reset() returns to whichever of the two it started from.

export const defaultValue = (def) =>
  def.type === 'select' ? def.options[0].id : def.type === 'time' ? '20:00' : '15';

// Row ids only need to be unique keys, so one module-wide counter serves every
// draft (a ref would be read during render by the lazy initial state).
let seq = 0;
const next = () => ++seq;

export function useRuleDraft({ fields, actions, severities, scopes = [], initial = null }) {
  // Sensible starting rule from the vocabulary (2nd field is usually "Activity").
  const seedField = fields[1] || fields[0];
  const seedSeverity = severities[severities.length - 2] || severities[0];
  const blankCondition = () => ({ id: next(), field: seedField.id, operator: seedField.operators[0], value: defaultValue(seedField) });
  const start = () => ({
    name: initial?.name || '',
    conditions: initial?.conditions?.length
      ? initial.conditions.map((x) => ({ ...x, id: next() }))
      : [blankCondition()],
    actions: initial?.actions?.length
      ? initial.actions.map((x) => ({ ...x, id: next() }))
      : [{ id: next(), action: actions[0].id, severity: seedSeverity }],
    scope: initial?.scope || scopes[0] || '',
  });

  const [draft, setDraft] = useState(start);
  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

  const setName = (name) => patch({ name });
  const setScope = (scope) => patch({ scope });

  const addCondition = () => setDraft((d) => ({ ...d, conditions: [...d.conditions, blankCondition()] }));
  const removeCondition = (id) => setDraft((d) => (d.conditions.length > 1 ? { ...d, conditions: d.conditions.filter((x) => x.id !== id) } : d));
  // Changing the field resets operator and value to that field's defaults.
  const setField = (id, fieldId) => {
    const def = fieldDefOf(fields, fieldId);
    setDraft((d) => ({ ...d, conditions: d.conditions.map((x) => (x.id === id ? { ...x, field: fieldId, operator: def.operators[0], value: defaultValue(def) } : x)) }));
  };
  const patchCondition = (id, p) => setDraft((d) => ({ ...d, conditions: d.conditions.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

  const addAction = () => setDraft((d) => ({ ...d, actions: [...d.actions, { id: next(), action: actions[1]?.id || actions[0].id, severity: 'Medium' }] }));
  const removeAction = (id) => setDraft((d) => (d.actions.length > 1 ? { ...d, actions: d.actions.filter((x) => x.id !== id) } : d));
  const patchAction = (id, p) => setDraft((d) => ({ ...d, actions: d.actions.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

  const reset = () => setDraft(start());

  const condText = draft.conditions.map((x) => conditionText(fields, x));
  const actText = draft.actions.map((x) => actionText(actions, x));

  // The structured rule, ids stripped — what onSave receives.
  const toRule = () => ({
    name: draft.name.trim() || 'Untitled rule',
    conditions: draft.conditions.map(({ field, operator, value }) => ({ field, operator, value })),
    actions: draft.actions.map(({ action, severity }) => ({ action, severity })),
    scope: draft.scope,
  });

  return {
    ...draft,
    setName, setScope,
    addCondition, removeCondition, setField, patchCondition,
    addAction, removeAction, patchAction,
    reset, condText, actText, toRule,
  };
}
