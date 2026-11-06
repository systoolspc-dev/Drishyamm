// Report scope — the period / shift / site a report covers, shared by the
// Reports hub and Staff Performance. Period and shift are in-memory (zustand):
// a choice made for this session. The site is the module-wide site
// (siteStore.js), persisted, so the store picked on the dashboard is the store
// the scorecard opens on — always shown in the header picker, never implied.
//
// Site access: a user sees the sites in `user.siteIds` (future backend field
// on the login payload). No field means org-wide access — the owner demo
// account, and every account until the backend sends it.
//   one site   → bound automatically, shown as a fixed badge
//   many sites → a report covers ONE site: an "All sites" scope is not
//                preselected into a store; reports ask for a site first
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useAuthStore } from '@/core/store/authStore';
import { toast } from '@/core/store/toastStore';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { useActivitySite, useActivitySites } from './siteStore';
import { policySummary } from './policy-items';
import { toMinutes } from './shifts';
import { formatRange } from './scorecard-export';
import { ZONE_COVERAGE, ZONE_HOURS_LABELS, ZONE_INCIDENTS, ZONE_LIVE } from './pages-data';

export const PERIODS = [
  { id: 'w28', label: 'This week', from: '2026-07-13', to: '2026-07-16' },
  { id: 'w27', label: 'Last week', from: '2026-07-06', to: '2026-07-12' },
  { id: 'w26', label: null,        from: '2026-06-29', to: '2026-07-05' },
];

// "Please select a store site to generate a federated site report."
const siteRequiredMsg = (site, action) => `Please select a ${site.toLowerCase()} site to ${action}.`;

// "Jul 13 – 16" / "Jun 29 – Jul 5" — the compact form for the dropdown.
export function shortRange(from, to) {
  const full = formatRange(from, to).replace(/, \d{4}$/, '');
  const [a, b] = full.split(' – ');
  return a.split(' ')[0] === b.split(' ')[0] ? `${a} – ${b.split(' ')[1]}` : full;
}

// Shift choices for a report: the vertical's roster minus umbrella spans
// ("Full Day" is what "All shifts" already means).
function reportShifts(shifts = []) {
  const inside = (outer, inner) => outer !== inner
    && toMinutes(outer.start) <= toMinutes(inner.start) && toMinutes(inner.end) <= toMinutes(outer.end);
  return shifts.filter((s) => !shifts.some((t) => inside(s, t)));
}

const useScopeStore = create((set) => ({
  period: PERIODS[0].id,
  custom: { from: PERIODS[0].from, to: PERIODS[0].to },
  shift: 'all',
  setPeriod: (period) => set({ period }),
  setCustom: (fn) => set((s) => ({ custom: typeof fn === 'function' ? fn(s.custom) : fn })),
  setShift: (shift) => set({ shift }),
}));

/** The sites this user may report on — the module's site list. */
export function useSiteAccess() {
  const { STORES } = useModuleData();
  return useActivitySites(STORES);
}

/** Scope state + everything derived from it. `storeObj` is null until a site is chosen. */
export function useReportScope() {
  const { params } = useActivityParams();
  const state = useScopeStore();
  const sites = useSiteAccess();
  const shifts = useMemo(() => reportShifts(params.shifts), [params.shifts]);

  const multiSite = sites.length > 1;
  // One site: bound. Many: the module-wide pick, if it is still one of theirs
  // (the vertical, and with it the store list, can change under us).
  const { site: storeObj, setSiteId: setStore } = useActivitySite({ sites, allowAll: false });
  const range = state.period === 'custom'
    ? (state.custom.from <= state.custom.to ? state.custom : { from: state.custom.to, to: state.custom.from })
    : PERIODS.find((p) => p.id === state.period);
  const shiftObj = shifts.find((s) => s.id === state.shift);
  const shiftLabel = shiftObj ? `${shiftObj.label} ${shiftObj.start}–${shiftObj.end}` : 'All Shifts';

  return {
    ...state,
    setStore,
    site: params.headcount?.label?.site || 'Store',
    sites, multiSite, shifts, storeObj, range, shiftLabel,
  };
}

/**
 * The report context every export and summary reads (see report-sections.js),
 * or null while no site is chosen.
 */
export function useReportContext(scope) {
  const { WEEKLY_REPORT, REPORT_META, TODAY, events } = useModuleData();
  const { params } = useActivityParams();
  const user = useAuthStore((s) => s.user);

  const rows = useMemo(() => [...WEEKLY_REPORT].sort((a, b) => b.score - a.score), [WEEKLY_REPORT]);
  const alerts = useMemo(() => events(TODAY).filter((e) => e.kind === 'alert'), [events, TODAY]);
  // Zone datasets exist only where the vertical tracks zones (retail).
  const zones = useMemo(() => (params.zones
    ? { hours: ZONE_HOURS_LABELS, coverage: ZONE_COVERAGE, live: ZONE_LIVE, incidents: ZONE_INCIDENTS }
    : null), [params.zones]);

  if (!scope.storeObj) return null;
  return {
    site: scope.site,
    storeLabel: scope.storeObj.label,
    storeCode: REPORT_META.storeCodes[scope.storeObj.id] || '—',
    from: scope.range.from,
    to: scope.range.to,
    shiftLabel: scope.shiftLabel,
    generatedBy: user?.name || user?.email || 'Unknown user',
    policy: policySummary(params, scope.site),
    rows,
    showImpact: !!params.zones, // counters/queues only exist where zones do
    healthScore: REPORT_META.healthScore,
    zones,
    alerts,
    asOf: TODAY,
  };
}

/**
 * `requireSite(action)` for an action that needs a site: warns, and puts the
 * cursor on the site picker (the `siteRef` wrapper). The warning leaves as
 * soon as a site is chosen — it must not outlive the problem it names.
 */
export function useSiteRequired(scope, siteRef) {
  const toastId = useRef(null);
  const chosen = !!scope.storeObj;
  useEffect(() => {
    if (chosen && toastId.current) { toast.dismiss(toastId.current); toastId.current = null; }
  }, [chosen]);
  return useCallback((action) => {
    toastId.current = toast.warn('Site required', siteRequiredMsg(scope.site, action), { groupKey: 'report-site-required' });
    siteRef.current?.querySelector('select')?.focus();
  }, [scope.site, siteRef]);
}
