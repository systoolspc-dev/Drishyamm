// Sites.
//
// A "site" IS the backend's GROUP — `GET /api/groups` returns
// { id, name, host, status, cameras[] } and the app has always called that a
// site in the UI (Home's Sites tile, Cameras' section headers). There is no
// /sites endpoint and this module does NOT add one; it only reads what
// listGroups() already returns.
//
// Everything here is DERIVED. Nothing is invented: if the backend doesn't send
// a field, the screens hide the row rather than showing a plausible-looking
// value, because on a security console a made-up number is worse than a gap.

// `tint` is a palette KEY, so callers stay theme-agnostic and both themes get
// the right ink/soft pair for free (see theme/palettes.js).
export const SITE_STATUS = {
  online:      { key: 'online',      label: 'Online',      tint: 'ok' },
  offline:     { key: 'offline',     label: 'Offline',     tint: 'critical' },
  maintenance: { key: 'maintenance', label: 'Maintenance', tint: 'warn' },
};

/** Camera tallies for one site. Total/online/offline only — the camera objects
 *  carry no maintenance state, so there is no maintenance count to report. */
export function siteStats(group) {
  const cameras = group?.cameras || [];
  const total = cameras.length;
  const online = cameras.filter((c) => c.status === 'online').length;
  return { total, online, offline: total - online };
}

/**
 * Site status, in priority order:
 *   1. The backend's own `group.status`, if it says anything we recognise. It
 *      is the only place MAINTENANCE can ever come from — cameras have no such
 *      state, so if the server never sends it this simply never appears, and
 *      that is the honest outcome rather than a fabricated one.
 *   2. Otherwise derived from cameras, matching the rule Home already uses:
 *      a site is active when at least one of its cameras is streaming. A
 *      recorder with every channel down is present, not active — and so is one
 *      with no cameras at all.
 */
export function siteStatus(group) {
  const raw = String(group?.status || '').toLowerCase();
  if (/maint/.test(raw)) return SITE_STATUS.maintenance;
  if (/offline|down|unreachable/.test(raw)) return SITE_STATUS.offline;
  return siteStats(group).online > 0 ? SITE_STATUS.online : SITE_STATUS.offline;
}

/** Counts for the summary cards. Online + Offline + Maintenance === Total by
 *  construction, so the four cards can never disagree with each other. */
export function siteTotals(groups = []) {
  const t = { total: groups.length, online: 0, offline: 0, maintenance: 0 };
  for (const g of groups) t[siteStatus(g).key] += 1;
  return t;
}

/** Case-insensitive match over the fields a site actually has: its name and
 *  its recorder host. Client-side, over data already in the query cache — the
 *  groups endpoint takes no search parameter. */
export function matchesSite(group, needle) {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return String(group?.name || '').toLowerCase().includes(n)
      || String(group?.host || '').toLowerCase().includes(n);
}
