/**
 * scope-cameras.js — how many cameras the scope on the generate row covers.
 *
 * A report over a scope with no cameras is not an empty report, it is a
 * misleading one: every card renders, every number is a real zero, and nothing
 * on the page says the site simply has no cameras wired up yet. A new site made
 * minutes ago in Camera Setup is exactly that scope, so the row has to be able
 * to tell the difference between "nothing happened" and "nothing is watching".
 *
 * The count comes from whatever the two catalogue calls the hub already makes
 * happen to carry:
 *   · a SITE row from /sites brings `camerasTotal` (the server's own tally)
 *   · a GROUP row from /groups brings its `cameras` array, each with a siteId
 *
 * Both are counts of CONFIGURED cameras — a camera that is offline is still a
 * camera the report should cover, so status is deliberately not consulted.
 * Where both signals exist we take the LARGER: disagreement means one of them
 * is stale, and the cost of under-counting (an operator locked out of a report
 * they could have run) is higher than the cost of over-counting (the server
 * rejects it, which it does anyway).
 *
 * `null` means "no idea" — the record is not in the lists yet, or the request
 * for them failed. Callers must treat null as permission to proceed; a failed
 * GET /groups must never disable the page's primary action.
 *
 * The number is a GUARD RAIL, not a figure to display. Because it takes the
 * larger of two tallies it can exceed the true count by whatever they disagree
 * by; all anyone should ask it is whether it is zero. The camera count shown on
 * a report comes from the server, in `payload.scope.cameraCount`.
 */

/** The copy the hub shows, and the reason the preview refuses to fetch. */
export const NO_CAMERAS_MESSAGE =
  'No cameras have been connected or configured for this site yet. '
  + 'Please select a site with active cameras to generate reports.';

/** Ids arrive as numbers from one endpoint and strings from another. */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The larger of the signals we have, or null when we have none. */
function best(...counts) {
  const known = counts.filter((n) => Number.isFinite(n));
  return known.length ? Math.max(...known) : null;
}

/**
 * Cameras configured on one group row, or null if the row says nothing.
 *
 * `totalChannels` is not merely a fallback for a missing `cameras` array: a
 * group is created with N channels provisioned up front, and until Shinobi has
 * synced them the array can be empty on a recorder with sixteen cameras on it.
 * An empty array next to a channel count is a group mid-setup, not an empty
 * one, so — as everywhere in this file — the larger number wins.
 */
function groupCameras(group) {
  return best(
    Array.isArray(group?.cameras) ? group.cameras.length : null,
    Number.isFinite(group?.totalChannels) ? group.totalChannels : null,
  );
}

/**
 * Cameras covered by a generate-row scope.
 *
 * @param {object}   scope
 * @param {Array}    scope.sites         rows from siteService.list()
 * @param {Array}    scope.groups        rows from cameraGroupService.getGroups()
 * @param {string}   scope.siteId        a site id, or 'all'
 * @param {string}   scope.groupId       a group id, or 'all'
 * @param {boolean}  scope.groupsLoaded  did GET /groups actually answer? An
 *   empty `groups` means "this site has none" only if it did; if the request
 *   failed we know nothing, and must not claim a zero. It defaults to FALSE on
 *   purpose: a caller that has not said the catalogue arrived gets "unknown",
 *   which blocks nobody, rather than a zero that locks the page.
 * @returns {number|null} count, or null when it cannot be known
 */
export function scopeCameraCount({ sites, groups, siteId, groupId, groupsLoaded = false } = {}) {
  const siteRows = Array.isArray(sites) ? sites : [];
  const groupRows = Array.isArray(groups) ? groups : [];

  // Narrowest scope first: one camera group answers for itself.
  if (groupId && groupId !== 'all') {
    const group = groupRows.find((g) => sameId(g.id, groupId));
    return group ? best(groupCameras(group)) : null;
  }

  if (siteId && siteId !== 'all') {
    const site = siteRows.find((s) => sameId(s.id, siteId));
    const here = groupRows.filter((g) => sameId(g.siteId, siteId));
    // A site with no groups at all has no cameras — but only say so if the
    // site itself is in the list, which means /sites answered.
    const fromGroups = here.length
      ? here.reduce((n, g) => n + (groupCameras(g) || 0), 0)
      : (groupsLoaded && site ? 0 : null);
    const fromSite = Number.isFinite(site?.camerasTotal) ? site.camerasTotal : null;
    return best(fromSite, fromGroups);
  }

  // "All sites" / "All cameras": the whole account. Zero here means a brand new
  // tenant with nothing connected anywhere, which is worth catching too.
  const fromGroups = groupRows.length
    ? groupRows.reduce((n, g) => n + (groupCameras(g) || 0), 0)
    : (groupsLoaded ? 0 : null);
  const fromSites = siteRows.length
    ? siteRows.reduce((n, s) => n + (Number.isFinite(s.camerasTotal) ? s.camerasTotal : 0), 0)
    : null;
  return best(fromSites, fromGroups);
}

/**
 * The warning for a scope that covers nothing, or '' when the scope is fine.
 *
 * The site wording is the one the spec names; the other two scopes get the same
 * sentence pointed at the thing actually selected, because "this site" is a lie
 * when the operator picked a camera group or All sites.
 */
export function scopeCameraWarning({ count, siteId, groupId } = {}) {
  if (count !== 0) return '';
  if (groupId && groupId !== 'all') {
    return 'No cameras have been connected or configured for this camera group yet. '
      + 'Please select a scope with active cameras to generate reports.';
  }
  if (siteId && siteId !== 'all') return NO_CAMERAS_MESSAGE;
  return 'No cameras have been connected or configured on this account yet. '
    + 'Add cameras under Camera Setup to generate reports.';
}
