// Tunable surface of the Zone Headcount page.
//
// ONE page (src/modules/employee-productivity/headcount/Headcount.jsx) serves
// every vertical. It renders nothing but this block — so the KEYS below are
// identical in all seven presets and only the VALUES change. Renaming a key per
// vertical would force a fork of the page, which is exactly what the golden rule
// forbids.
//
// A person-counting model emits four measurements and nothing else:
//   P1 occupancy    how many are inside a region right now      → zone.mode 'region'
//   P2 flow         how many crossed a line, in / out           → zone.mode 'line'
//   P3 dwell        how long they stayed / how tightly packed   → dwellAlertSec, densityPerM2
//   P4 reconcile    headcount − identified = unidentified       → reconcile
// Every industry use case is one of those four plus a threshold and a zone type.
// The vertical only supplies vocabulary (`label`) and its own list of zones.

export const headcountDefaults = {
  reconcile: true,       // show the headcount-vs-identified delta (needs the face pipeline)
  breachPct: 100,        // % of capacity that counts as a breach
  densityPerM2: 1.5,     // persons/m² over which a zone reads as a crush risk
  dwellAlertSec: 300,    // queue/lingering time before the dwell rule fires
  emptyAfterSec: 60,     // count must hold at 0 this long before a zone reads "empty"
                         // (stops a one-frame miss from marking a room clear)

  // ── peak occupancy ───────────────────────────────────────────────────────
  // "When was it busiest, and where" is two different questions and they have
  // two different answers. Both are computed; `peakBasis` only decides which one
  // the KPI card leads with.
  //   'site' → argmax over TIME of the summed count. The busiest MOMENT.
  //            Answers "when do I need more staff on shift".
  //   'zone' → argmax over TIME AND ZONE of utilization. The fullest ROOM.
  //            Answers "which space is undersized". Usually a different clock time.
  peakBasis: 'site',
  peakWindowSec: 60,     // a spike must hold this long to count as a peak. Without
                         // it one mis-detected frame becomes the day's headline
                         // number. Same idea as emptyAfterSec, opposite direction.

  // Vocabulary. The page substitutes these into headings and filter labels so a
  // bank operator reads "Branch / Area / Customer" and a school reads
  // "School / Wing / Student" — same component, same keys.
  label: { site: 'Site', area: 'Area', person: 'Person', people: 'people' },

  sites: [],             // { id, label } — branch / facility scope; selector hidden when empty
  areas: [],             // filter-bar options, first entry is the "all" option
  zoneTypes: [],         // this vertical's zone-type catalog (see ZONE_TYPE_TEMPLATES).
                         // Empty → every ZONE_KINDS key doubles as a type.
  zones: [],             // see the shape below
}

// Zone shape — the missing join table between "camera" (what the model counts on)
// and "room" (what the operator thinks in). Every vertical writes this list.
//
//   {
//     id: 'vault',                 stable key, used for drill-down + mock seeding
//     label: 'Vault',              operator-facing name
//     type: 'restricted',          an id from this vertical's `zoneTypes` (or a
//                                  ZONE_KINDS key when it has none). Drives the
//                                  label + type filter; its `kind` drives behaviour.
//     mode: 'region' | 'line',     region → count inside; line → in/out crossings
//     area: 'Restricted',          must match an entry in `areas`
//     capacity: 4,                 region zones only; omit on line zones
//     minOccupancy: 2,             optional floor — fires when a zone has TOO FEW
//                                  people (bank dual-control, lab supervision).
//                                  Identity systems cannot express this.
//     cameraIds: ['cam-14'],       cameras whose counts sum into this zone
//   }

// ── zone kinds vs zone types ──────────────────────────────────────────────
// A zone TYPE is vocabulary, configured per vertical at setup: a store says
// "Billing Counter", a hospital says "Triage". A zone KIND is behaviour, and is
// fixed: the icon, the dwell rule (queue), the density rule (corridor), how well
// faces are recognised (secure / office / meeting). Every type maps to exactly
// one kind, so occupancy, capacity thresholds, dwell and status are computed the
// same way whatever the operator calls the space. Add types freely; add a kind
// only when the page genuinely needs a new behaviour.
export const ZONE_KINDS = {
  gate:      'Gate / entrance',
  lobby:     'Lobby',
  hall:      'Hall',
  classroom: 'Classroom',
  lab:       'Lab',
  work:      'Workspace',
  office:    'Office',
  meeting:   'Meeting room',
  dining:    'Dining',
  queue:     'Queue',
  corridor:  'Corridor',
  library:   'Library / study',
  sports:    'Sports / open area',
  leisure:   'Leisure',
  lounge:    'Lounge',
  service:   'Service area',
  secure:    'Restricted',
  display:   'Display / merchandise',
}

// Zone-type catalogs offered at setup, one per use-case template. A vertical
// adopts one as `zoneTypes` (and may extend it); its zones reference these ids.
//   { id, label, kind }   kind ∈ ZONE_KINDS
export const ZONE_TYPE_TEMPLATES = {
  retail: [
    { id: 'entrance',    label: 'Entrance / Exit',          kind: 'gate' },
    { id: 'billing',     label: 'Billing Counter',          kind: 'queue' },
    { id: 'fitting',     label: 'Fitting Room',             kind: 'service' },
    { id: 'high-value',  label: 'High-Value Display Aisle', kind: 'display' },
    { id: 'queue',       label: 'Queue Zone',               kind: 'queue' },
    { id: 'stockroom',   label: 'Stockroom',                kind: 'secure' },
    { id: 'sales-floor', label: 'Sales Floor',              kind: 'work' },
  ],
  corporate: [
    { id: 'reception',   label: 'Reception / Lobby',        kind: 'lobby' },
    { id: 'conference',  label: 'Conference Room',          kind: 'meeting' },
    { id: 'cafeteria',   label: 'Cafeteria / Breakroom',    kind: 'dining' },
    { id: 'executive',   label: 'Executive Suite',          kind: 'office' },
    { id: 'workstation', label: 'Open Workstations',        kind: 'work' },
    { id: 'fire-exit',   label: 'Fire Exit Corridor',       kind: 'corridor' },
    { id: 'restricted',  label: 'Restricted / Server Room', kind: 'secure' },
  ],
  healthcare: [
    { id: 'emergency',          label: 'Emergency Bay',      kind: 'service' },
    { id: 'triage',             label: 'Triage',             kind: 'queue' },
    { id: 'restricted-storage', label: 'Restricted Storage', kind: 'secure' },
  ],
  warehouse: [
    { id: 'loading-dock',       label: 'Loading Dock',       kind: 'service' },
    { id: 'staging',            label: 'Staging Area',       kind: 'work' },
    { id: 'restricted-storage', label: 'Restricted Storage', kind: 'secure' },
  ],
}
