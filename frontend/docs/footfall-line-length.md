# Footfall service — what the UI cannot give the operator

**Status:** none of this is built. Each item below is blocked on a service
change, and the front-end work is small once the field exists.

**Audience:** whoever owns the footfall / customer-counter service.

**Scope:** a "gate" in the product is a camera counting people across a line.
The UI for it is `src/modules/occupancy/zone-setup/` (GateEditor,
GateLineEditor, GateCanvas) and the contract is `src/modules/occupancy/
gate-model.js`.

---

## The contract today

Everything the service exposes per camera:

| | Field | Range |
|---|---|---|
| read | `camera_id`, `camera_code`, `camera_name` | — |
| read | `footfall_enabled` | bool |
| read | `line_y_frac` | 0.05–0.95 |
| read | `direction` | `down_is_in` \| `up_is_in` |
| read | `today: { in, out }` | — |
| **write** | `enabled` | bool |
| **write** | `line_y_frac` | clamped 0.05–0.95 |
| **write** | `direction` | coerced to the two values |

Endpoints: `GET /ai/footfall/cameras`, `GET|PUT /ai/footfall/cameras/:id/config`,
`GET /ai/footfall/timeseries`, `GET /ai/footfall/export.csv`.

**Three writable fields.** Everything below follows from that.

---

## 1. The counting line is always the full width of the frame

**The problem.** A line is stored as a single number — how far down the frame
it sits. There is no x-coordinate, no endpoints, no length and no angle. The
line is therefore always horizontal and always spans the entire view.

**Why it matters.** This is the only item on this list that makes the numbers
*wrong* rather than merely inconvenient. The line is an infinite horizontal
band across the picture, so anyone crossing that height anywhere is counted —
someone walking down the corridor past the door, a queue shuffling forward,
staff stepping behind a counter. Each one is a false IN and later a false OUT.
That inflates every gate figure, and it propagates: the Usage Trends tab's
occupancy timeline is a running sum of these crossings, so a miscounting gate
skews the whole day's curve. The operator's only visible symptom is "net
inside" drifting away from the live zone headcount, which they are told to
read as a gate fault — this is one of its causes.

It also cannot be worked around. Most usable camera angles put the doorway
obliquely in frame, so the operator chooses between a line that clips the door
and one that runs out across unrelated floor, and slides it to an awkward
height to dodge the worst traffic — trading one counting error for another,
silently.

**What it does today.** `GateCanvas.jsx` draws the line at `x1="0" x2="100"`
because that is literally what the stored value means. The operator can move
it up and down and swap which side is IN. That is all.

**The solution.** Two options; the second is strictly more capable and is worth
doing if the crossing test can be touched at all.

*Option A — add an x-extent to the existing horizontal line.* Two optional
fields, normalised 0–1 of frame width:

```
line_x1_frac   default 0.0
line_x2_frac   default 1.0     require x1 < x2, and a minimum span
```

A crossing counts only if the person crosses `line_y_frac` **while their x is
between x1 and x2**. Backward compatible by construction: a row without them
behaves exactly as today. Fixes the over-counting; does nothing for oblique
doorways.

*Option B — store the line as a segment (recommended).*

```
line:      { a: [x1, y1], b: [x2, y2] }   normalised 0..1
direction: "left_is_in" | "right_is_in"   relative to travel a -> b
```

A crossing counts when the trajectory crosses that **segment** — not its
infinite extension — and the side it ends on decides IN or OUT.

*Migration is lossless.* Existing rows convert exactly: `a = [0, line_y_frac]`,
`b = [1, line_y_frac]`, and `down_is_in` becomes "IN on the +y side". Nothing
needs re-configuring by hand. Keep serving `line_y_frac` on read and accepting
it on write for one release so clients can catch up.

Going A then B later means doing the work twice.

---

## 2. A gate cannot be named

**The problem.** There is no name field. A gate is identified by its camera.

**Why it matters.** Gate names are read by people who have never seen the
camera list: the Gate Activity Matrix on the dashboard, the CSV export, and
any report built on the timeseries. "CAM-04" and "Office 12 Floor 3 Camera 02"
tell a store manager nothing, where "Main Entrance" and "Staff Door" tell them
everything. This is the difference between a footfall report someone acts on
and one they ask an engineer to translate.

**What it does today.** `GateEditor.jsx` shows the camera name as read-only
text and states the limitation in its own copy: *"A gate is named after its
camera: the footfall service stores no separate name."*

**The solution.** Add a nullable `name` to the read shape and the write body.
The UI falls back to the camera name when it is null, so nothing changes for
existing rows and no migration is needed.

---

## 3. A camera can only have one line

**The problem.** The config is one line per `camera_id`.

**Why it matters.** A lobby camera that sees a main entrance and a side exit
produces one merged number. There is no way to know which door the traffic
went through, which is usually the actual question — a spike at the staff door
at 09:00 and a spike at the customer door at 09:00 mean different things.
A wide concourse camera has the same problem.

**What it does today.** Placing a second line means pointing a second camera at
the same space.

**The solution.** Replace the single line with an array, counts reported per
line:

```
lines: [ { id, a, b, direction, enabled, name } ]
```

This subsumes item 1 and item 2, so if it is on the roadmap at all, do it
instead of Option B rather than after it. It is the largest of these changes —
the UI needs a way to pick which line is being edited — so scope it only once
1 or 2 has shipped and proven the shape.

---

## 4. A gate counts 24 hours a day

**The problem.** `enabled` is a global on/off. There is no schedule.

**Why it matters.** Zones already have operating hours and an off-hours lock,
so an operator reasonably expects the same of a gate — and the absence is
silent. Cleaning staff at 02:00, overnight deliveries and a security patrol all
land in the same daily total as customers, with nothing to separate them. On a
retail site that makes the headline footfall number unusable for conversion
rate without manual subtraction.

**What it does today.** The only lever is switching counting off entirely,
which also stops it during the hours you wanted.

**The solution.** Mirror the field the zone side already uses, so the two
concepts stay learnable as one:

```
active_hours: ["09:00", "18:00"]   null = always on
```

Crossings outside the window are not counted. Whether they should be recorded
and tagged instead of dropped is a product call worth making explicitly —
recording them is more useful and costs a column.

---

## 5. Today's count cannot be reset

**The problem.** No reset endpoint.

**Why it matters.** This is the recovery path for every other fault on this
list. An operator places a line badly, watches it count the corridor for twenty
minutes, fixes it — and the bad crossings stay in today's total until midnight.
There is nothing they can do, and the dashboard keeps showing a number they
know is wrong. That is corrosive: once an operator learns a figure can be
wrong with no way to correct it, they stop trusting the figure.

**What it does today.** Counts accumulate from midnight and are served as
`today: { in, out }`.

**The solution.** A small endpoint:

```
POST /ai/footfall/cameras/:id/reset
```

Zero today's counters for that camera. Keep the underlying per-minute rows —
the timeseries should stay truthful about what was observed — and record the
reset as an event so a report can say "counting restarted at 10:42".

This is the cheapest item here and the highest ratio of trust regained to work
done.

---

## 6. Someone standing on the line can be counted repeatedly

**The problem.** Every crossing counts. There is no minimum interval between
two crossings by the same track.

**Why it matters.** A doorway is exactly where people hesitate — holding a
door, stepping back for someone, standing and talking. Each wobble across the
line is another IN and another OUT. It does not bias the net figure much, since
the false pairs cancel, but it inflates gross IN and OUT, which is what the
Gate Activity Matrix shows and what a footfall report quotes.

**What it does today.** Nothing debounces it. The zone side has the equivalent
control — `alertAfterSec`, a delay before an intrusion fires so brushing past a
doorway does not alarm — so the concept already exists in the product; the gate
side just has no field for it.

**The solution.**

```
min_recross_sec   default 0 (today's behaviour), typical 2-3
```

The same track crossing again inside the window is ignored.

---

## Investigated and NOT needed: deleting a gate

Worth recording so nobody builds it.

There is no DELETE endpoint, and at first look that seems like a gap. It is
not. Setting `enabled: false` already removes the gate from every surface the
operator sees — the camera tree row, the door marker on the camera, the flat
Gates list, the rail's gate counter, and the dashboard's Gate Activity Matrix
all filter on `enabled`. The gate disappears from the product.

The only residue is that the line position stays stored, which is a feature:
set the gate up again and the line is where it was left.

**No service change needed.** The corresponding UI gap — that "stop counting"
is buried in the gate editor rather than offered on the gate's row in the rail
— is front-end work and is being handled there.

---

## Recommended order

1. **Line length** (item 1, Option B) — the only one that makes numbers wrong.
2. **Reset** (item 5) — cheapest, and the recovery path for everything else.
3. **Name** (item 2) — small, and the one non-engineers notice daily.
4. **Schedule** (item 4) — real, but a workaround exists (read the timeseries
   and subtract).
5. **Re-cross debounce** (item 6) — affects gross figures only.
6. **Multiple lines** (item 3) — largest change; do it only if it replaces 1.
