/**
 * occupancy/fuse.js — per-camera counts → ONE room number.
 *
 *     space_count = Σ over overlap groups g ( max(count × weight over cameras in g) )
 *
 * Cameras in the same overlap group SEE THE SAME PEOPLE, so they MAX (a hall
 * covered by two cameras reading 12 and 14 holds 14 people, not 26). Cameras
 * with no group cover disjoint areas, so each is its own group and they SUM.
 *
 * Reliability propagates with the count, because a room is only as knowable as
 * its blindest corner:
 *   measured — every group had a fresh, verified camera
 *   partial  — at least one group is blind → the number is a LOWER BOUND
 *   stale    — nothing fresh, only old readings
 *   unknown  — nothing usable at all → count is NULL (NEVER 0)
 *
 * A `partial` lower bound may still RAISE a capacity breach (a floor of ≥N is
 * proof there are at least N people) but may never CLEAR one — asymmetric on
 * purpose so safety alerts fail loud, not silent.
 */
const { cameraQuality, spaceQuality, isUsable } = require('./quality');

/**
 * @param {Array} members  [{ monitorId, overlapGroup, weight, enabled }]
 * @param {Object} samples { [monitorId]: { heads, connected, reliable, ageSec, degraded } }
 * @returns {{count:number|null, quality:string, coveragePct:number, groups:Array, degraded:boolean}}
 */
function fuseSpace(members = [], samples = {}) {
  const active = members.filter((m) => m && m.enabled !== false);
  if (active.length === 0) {
    return { count: null, quality: 'unknown', coveragePct: 0, groups: [], degraded: false };
  }

  // Group by overlapGroup; NULL/'' means "its own group" (so it sums).
  const groups = new Map();
  active.forEach((m, i) => {
    const key = m.overlapGroup ? `g:${m.overlapGroup}` : `solo:${m.monitorId || i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  let total = 0;
  let groupsMeasured = 0;
  let anyStale = false;
  let degraded = false;
  let camsFresh = 0;
  const detail = [];

  for (const [key, mem] of groups) {
    let best = null;              // max within the group
    let groupMeasured = false;
    let groupStale = false;

    for (const m of mem) {
      const s = samples[m.monitorId];
      const q = s ? cameraQuality(s) : 'unknown';
      if (s && s.degraded) degraded = true;
      if (q === 'stale') groupStale = true;
      if (!isUsable(q)) continue;
      camsFresh += 1;
      const weighted = Number(s.heads) * (Number(m.weight) || 1);
      if (best === null || weighted > best) best = weighted;
      groupMeasured = true;
    }

    if (groupMeasured) {
      groupsMeasured += 1;
      total += best;
    } else if (groupStale) {
      anyStale = true;
    }
    detail.push({ group: key, cameras: mem.length, measured: groupMeasured, value: best });
  }

  const quality = spaceQuality({ groupsTotal: groups.size, groupsMeasured, anyStale });
  // The invariant: no usable reading ⇒ NULL, never 0.
  const count = quality === 'unknown' || quality === 'stale' ? null : Math.round(total);

  return {
    count,
    quality,
    coveragePct: Math.round((100 * camsFresh) / active.length),
    groups: detail,
    degraded,
  };
}

module.exports = { fuseSpace };
