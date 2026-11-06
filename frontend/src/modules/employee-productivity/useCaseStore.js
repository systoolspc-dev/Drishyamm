import { create } from 'zustand';
import { moduleParams, hasModule, USE_CASES } from '@/use-cases';

// Which vertical the Activity Monitoring module is currently viewing.
// The module code is written once; switching use-case only swaps parameters
// (src/use-cases/<vertical>/index.js) — pages gate themselves on the params
// they need (e.g. Zone Coverage requires params.zones, which only retail has).
export const useUseCaseStore = create((set) => ({
  useCase: (() => {
    try { return localStorage.getItem('activity-use-case') || 'retail'; } catch { return 'retail'; }
  })(),
  setUseCase: (key) => {
    try { localStorage.setItem('activity-use-case', key); } catch { /* private mode */ }
    set({ useCase: key });
  },
}));

// Convenience: current vertical's employee-productivity params + module gate.
export function useActivityParams() {
  const useCase = useUseCaseStore((s) => s.useCase);
  return {
    useCase,
    label: USE_CASES[useCase]?.label || useCase,
    enabled: hasModule(useCase, 'employee-productivity'),
    params: moduleParams(useCase, 'employee-productivity'),
  };
}
