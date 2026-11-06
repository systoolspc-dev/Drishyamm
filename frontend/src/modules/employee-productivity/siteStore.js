import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { create } from 'zustand';
import { useGroups } from '@/core/hooks/useQueries';
import { useAuthStore } from '@/core/store/authStore';
import { useActivityParams } from './useCaseStore';

// Which site the Activity Monitoring module is scoped to — ONE value for every
// page under /activity-monitoring (and Event Logs), so a store picked on the
// dashboard is still the store on Retail Analytics, the scorecard and the log.
//
// A zustand store rather than a layout-level context: App.jsx renders a fresh
// AppLayout per route, so state held in a layout would reset on every
// navigation. The module-level store outlives route changes, and localStorage
// carries it across reloads (same pattern as useCaseStore.js).
//
// Stored value: 'all' | a site id | null (never chosen). It is a PREFERENCE,
// resolved against each page's site list during render and never overwritten
// by a fallback — so a retail store id survives a trip through the corporate
// vertical, and a camera-group id survives the moment before groups load.
const KEY = 'activity-site';
export const ALL_SITES = 'all';

export const useSiteStore = create((set) => ({
  selectedSiteId: (() => {
    try { return localStorage.getItem(KEY) || null; } catch { return null; }
  })(),
  setSelectedSiteId: (id) => {
    const v = id ? String(id) : ALL_SITES;
    try { localStorage.setItem(KEY, v); } catch { /* private mode */ }
    set({ selectedSiteId: v });
  },
}));

/**
 * The sites this module can scope to, as [{ id, label }] with string ids.
 * Real sites (camera groups) whenever the workspace has any — their ids are
 * what Event Logs filters on — else the vertical's demo list (`demo`,
 * defaulting to params.headcount.sites). Narrowed to `user.siteIds` when the
 * login payload carries it; no field means org-wide access.
 */
export function useActivitySites(demo) {
  const { params } = useActivityParams();
  const { data: groups = [] } = useGroups();
  const siteIds = useAuthStore((s) => s.user?.siteIds);
  const fallback = demo || params.headcount?.sites;
  return useMemo(() => {
    const all = groups.length
      ? groups.map((g) => ({ id: String(g.id), label: g.name }))
      : (fallback || []).map((s) => ({ ...s, id: String(s.id) }));
    if (!Array.isArray(siteIds)) return all;
    const mine = new Set(siteIds.map(String));
    return all.filter((s) => mine.has(s.id));
  }, [groups, fallback, siteIds]);
}

/**
 * The module's site scope, resolved for one page.
 *
 *   sites           the page's options (see useActivitySites)
 *   allowAll        the page can show every site at once. When false, an
 *                   "All" preference resolves to…
 *   fallbackToFirst …the first site (a per-site view that always has one), or
 *                   to '' — nothing chosen — for pages that must make the
 *                   viewer pick (reports: never export a store by default).
 *   urlParam        a query key (?store=) that deep links carry. A link that
 *                   names a site wins over the remembered one and is adopted
 *                   as the new preference; picks are written back to it so
 *                   the address bar stays shareable.
 *
 * A user with exactly one site is bound to it. With none remembered, the
 * default is All Sites.
 */
export function useActivitySite({ sites, allowAll = true, fallbackToFirst = false, urlParam } = {}) {
  const stored = useSiteStore((s) => s.selectedSiteId);
  const setStored = useSiteStore((s) => s.setSelectedSiteId);
  const [search, setSearch] = useSearchParams();
  const fromUrl = urlParam ? search.get(urlParam) : null;
  const known = (id) => !!id && sites.some((s) => s.id === String(id));

  // Adopt a deep-linked site, once it is one of ours.
  useEffect(() => {
    if (known(fromUrl) && fromUrl !== stored) setStored(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl, sites]);

  const wanted = known(fromUrl) ? fromUrl : stored;
  let siteId;
  if (sites.length === 1) siteId = sites[0].id;
  else if (known(wanted)) siteId = String(wanted);
  else if (allowAll) siteId = ALL_SITES;
  else siteId = fallbackToFirst ? sites[0]?.id || '' : '';

  const setSiteId = useCallback((id) => {
    setStored(id);
    if (!urlParam) return;
    const next = new URLSearchParams(search);
    if (id && id !== ALL_SITES) next.set(urlParam, id); else next.delete(urlParam);
    setSearch(next, { replace: true });
  }, [setStored, urlParam, search, setSearch]);

  return {
    siteId,
    site: sites.find((s) => s.id === siteId) || null,
    isAll: siteId === ALL_SITES,
    bound: sites.length === 1,
    setSiteId,
  };
}
