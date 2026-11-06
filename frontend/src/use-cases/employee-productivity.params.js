// Tunable surface of the Employee Productivity module.
//
// The MODULE CODE lives in src/modules/employee-productivity/ and is written
// ONCE. What differs between verticals is only these parameters — a corporate
// office and a retail floor watch the same behaviour with different thresholds.
// Each use-case (see ./corporate, ./retail) spreads these defaults and overrides
// what it needs. These keys mirror the activity-monitor / alert-policy knobs on
// the backend (business hours, break gap, phone-hold, stranger dwell, gates).

export const productivityDefaults = {
  businessHours: '09:00-18:00', // presence outside → after-hours flag
  lateAfter: '09:30',           // clock-in past this = "late arrival"
  lateGraceSec: 900,            // staff profile: clock-in past shift start + this = late
  // Plan data-retention window. Activity history older than this many days is
  // purged, so the staff profile's date pickers stop at today − retentionDays.
  // Comes from the tenant's subscription once billing is wired.
  retentionDays: 30,
  // Roster shifts. THIS is where shifts are configured — they are an operator
  // setting, not something a viewer picks from a dropdown, so the dashboard
  // reads the shift that contains the current time and shows it read-only.
  // Override per vertical (see ./retail, ./corporate); when the roster API
  // lands these come from store.shifts[] and this array becomes the fallback.
  // `start`/`end` are IST 24h "HH:MM"; an end before its start means overnight.
  shifts: [
    { id: 'full',  label: 'Full Day', start: '09:00', end: '18:00' },
    { id: 'early', label: 'Early',    start: '08:00', end: '16:00' },
    { id: 'late',  label: 'Late',     start: '11:00', end: '20:00' },
  ],
  breakGapSec: 900,             // mid-visit silence ≥ this = away (excluded from on-site)
  // Per-event limits, checked by the staff profile's Break & Idle log. Each
  // break or idle stretch is compared to the limit for its type; up to
  // overstayGraceSec past it reads "Overstayed", beyond that an alert flag fires.
  breaks: {
    teaMaxSec: 900,             // tea / short break
    lunchMaxSec: 2700,          // lunch break
    overstayGraceSec: 300,      // grace past a limit before the alert flag
  },
  idleAlertSec: 600,            // max unplanned idle (off-post) per event
  sessionGapSec: 3600,          // off-camera < this = same visit (not a re-entry)
  minDetections: 3,             // sightings before a visit logs as an arrival
  minSimilarity: 0.5,           // face-match confidence gate
  phone: {
    holdSec: 1.5,               // on-phone must persist this long before it counts
    requireHand: true,          // phone must be near a hand — rejects desk phones
    violationSec: 30,           // continuous use past this → Policy Violation
    escalateAfter: 3,           // violations per shift before the supervisor is notified
  },
  strangerDwellSec: 180,        // unknown face lingering ≥ this → alert
}
