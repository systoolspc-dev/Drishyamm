/**
 * occupancy/quality.js — is this count trustworthy, and may it move an alert?
 *
 * THE RULE (docs/OCCUPANCY_LOGIC.md §2.2):
 *
 *     count IS NULL  ⟺  quality === 'unknown'
 *
 * `0` means the model looked at the scene and saw nobody. A camera that is
 * offline, reconnecting, or whose count is stale must yield NULL/'unknown' —
 * never 0 — or every report will claim the room was empty while the camera was
 * simply dead. Nothing downstream may COALESCE(count, 0).
 *
 * The head-count service already tells us everything needed to decide this:
 * `connected`, `count_reliable` (its own freshness deadline), `count_age_s`
 * (seconds since the model last VERIFIED the count) and `gate_saturated`
 * (camera so noisy its motion gate hit the ceiling → degraded, not blind).
 */

// A count older than this hasn't been verified recently enough to trust. The
// head-count service's own idle heartbeat is 10s, so 3 heartbeats + slack.
const STALE_AFTER_SEC = parseInt(process.env.OCCUPANCY_STALE_AFTER_SEC || '35', 10);

/** Per-camera quality: 'measured' | 'stale' | 'unknown'. */
function cameraQuality(sample = {}) {
  // Explicitly disconnected, or the service itself says "don't trust this".
  if (sample.connected === false) return 'unknown';
  if (sample.reliable === false) return 'unknown';
  // No number at all ⇒ nothing was measured.
  if (sample.heads === null || sample.heads === undefined) return 'unknown';
  const age = Number(sample.ageSec);
  if (Number.isFinite(age) && age > STALE_AFTER_SEC) return 'stale';
  return 'measured';
}

/** Only a freshly measured count may be counted or move an alert. */
const isUsable = (q) => q === 'measured';

/**
 * Fold one camera's quality into a space verdict.
 *   measured — every overlap group had a fresh camera
 *   partial  — some groups measured, some blind → the value is a LOWER BOUND
 *   stale    — nothing fresh, but we have older readings
 *   unknown  — nothing usable at all (count must be NULL)
 */
function spaceQuality({ groupsTotal = 0, groupsMeasured = 0, anyStale = false } = {}) {
  if (groupsTotal === 0) return 'unknown';
  if (groupsMeasured === 0) return anyStale ? 'stale' : 'unknown';
  if (groupsMeasured < groupsTotal) return 'partial';
  return 'measured';
}

/**
 * Alert permissions per doctrine. A lower bound (`partial`) is still PROOF the
 * room is over capacity — so it may RAISE a breach — but it can never prove the
 * room emptied, so it may not CLEAR one. Asymmetric on purpose: safety alerts
 * fail loud, not silent.
 */
const canBreach = (q) => q === 'measured' || q === 'partial';
const canClear = (q) => q === 'measured';

module.exports = {
  STALE_AFTER_SEC,
  cameraQuality,
  spaceQuality,
  isUsable,
  canBreach,
  canClear,
};
