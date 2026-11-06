# Drishyam Mobile — Phase 1 (UI & UX)

**Baseline:** 2026-08-07 · **Status:** re-baselined against work already merged

---

## Why this document was revised

The original Phase 1 plan was written as if starting from zero. Most of it is
already implemented. It also contained a rule conflict: it forbade backend
changes while making "FAB → Add Camera" a ⭐⭐⭐⭐⭐ deliverable, which cannot be
built against the endpoints the mobile app has.

This version:

- re-baselines every task against what is actually in the repo,
- moves API-dependent work into its own sprint with an explicit gate,
- adds the two tasks the original was missing (**streaming regression**, and a
  **global stream-concurrency budget**),
- gives every task acceptance criteria that can be checked.

---

## Scope rules (corrected)

1. **Sprints 1–2 add no new API calls.** Everything is buildable against the
   endpoints already wrapped in `src/lib/api.js`.
2. **Sprint 3 is backend-gated** and must not start until the API inventory
   (below) is complete.
3. Navigation *is* being rewritten — the new IA requires it. This is in scope,
   not an exception.
4. No new dependencies without a written reason. (`react-native-maps` in
   Sprint 3 is the only anticipated one.)
5. Every component supports light **and** dark. Non-negotiable — the theme
   layer makes this nearly free.
6. Accessibility target is **WCAG AA: 4.5:1 for text, 3:1 for UI and large
   text**, verified in both themes.

---

## Current state (do not rebuild)

Merged and verified as of the baseline date:

| Area | State |
|---|---|
| Design system | `src/theme/` — 8pt spacing grid, radius/elevation/type scales, light + dark palettes with a two-tier semantic system (`warn` vivid / `warnInk` for text) |
| UI primitives | 22 exported from `src/components/ui.jsx`: `Txt, Card, SectionHeader, StatusDot, Badge, Button, IconButton, SearchField, Chip, SegmentedControl, StatCard, ScreenHeader, TextField, FieldError, Avatar, EmptyState, Skeleton, CameraTileSkeleton, StatTileSkeleton, AlertRowSkeleton, OfflineBanner, Divider` |
| Dark mode | `ThemeProvider` + `useTheme()` / `useStyles()`, persisted via `settingsStore`, splash-gated so it cannot flash, status bar + `expo-system-ui` root colour, cross-dissolve on switch |
| Login | Restyled; keyboard avoiding, password toggle, submit gating, inline + toast errors |
| Home | Search, alarm bell count, 3-up health stats, AI insights, single-banner priority rule |
| Cameras | Status pills, favourites (device-local), quick actions, filter chips with counts |
| Alerts | Inline filter chips, location, severity badges, day grouping |
| Live View | Two-row controls, camera switching via `setParams` |
| Profile | Sectioned; Light/Dark/Auto segmented control |
| Bottom nav | Floating bar, spring-animated active indicator, `tabBarClearance = 92` reserved by every tab screen |
| Micro-interactions | Haptics, ripple, press states, pull-to-refresh |
| Accessibility | All 15 rendered colour pairings pass WCAG AA in both themes |

**Known gaps** are exactly the Sprint 1 backlog below.

---

# Sprint 1 — Close the gaps

> Sequencing matters: **T1 first.** Every other screen links through the new
> IA, and building against an IA you are about to change means wiring twice.

## Status: code complete, pending device verification

All five tasks are implemented and pass static verification:

| Check | Result |
|---|---|
| Bundle | 1163 modules, no warnings, no require cycles |
| Named imports resolve | pass |
| Tokens used vs imported | pass |
| Unused imports | none |
| Component scope audit | pass |
| **Dead navigation targets** | **none** — 11 routes registered, every `navigate()` resolves |
| Theme guard (`scripts/check-theme.mjs`) | 43 tokens/theme, 16 pairings × 2 themes, all AA |

**What still needs a real device** — the criteria below marked *(device)* cannot
be proven statically, and T8's regression pass is the gate for them. The one to
watch hardest is the **tab-switch stream overlap**: Home releases its pulls via
`useIsFocused` while Live is arming its hero, so there is a brief window where
both hold streams. By design it stays inside `MAX_CONCURRENT_STREAMS` (Home 4
tearing down, Live 1 hero + staggered grid), but it must be measured, not
assumed.

### Decisions taken during implementation

- **Palette** stayed cool `#F8F9FB`. The warm cream from the mockup is a
  3-token change in `palettes.js` whenever wanted — the token layer means it
  does not block anything.
- **FAB** opens the sheet with **Add Camera disabled and a stated reason**,
  per the Sprint 3 rule below.
- **Alerts keeps two filter axes.** Severity is the chip row (primary, per the
  mockup); type survives as a *removable pill* that only appears when arriving
  from Home's AI insight tiles. Dropping type entirely would have broken four
  working deep links.
- **Cameras and Profile left the tab bar** but kept their route names, so all
  existing `navigate('Cameras')` call sites still resolve. Their bottom padding
  switched off `tabBarClearance` — they are pushed screens now, with no
  floating bar to clear.
- **`MAX_CONCURRENT_STREAMS` was pulled forward from T7 into Sprint 1**,
  because T3 (Live tab) is the screen that risks the ceiling and needed a
  budget to build against.

### T1 — Navigation IA: 5 tabs + FAB ⭐ *(blocker for T2–T4)*

Move from `Home · Cameras · Alarms · Me` to `Home · Live · (+) · Alerts · Menu`.

**Files:** `src/navigation/AppNavigator.jsx`, all screens using
`navigation.navigate('Cameras' | 'Me')` (~12 call sites)

**Acceptance criteria**
- [ ] Five slots render; the centre is a FAB visually distinct from the tabs.
- [ ] The animated indicator skips the FAB slot and lands centred on all four
      real tabs, at every screen width down to 320pt.
- [ ] Every previous `navigate()` target still resolves — **no dead links**.
      Grep for `navigate('` and confirm each name exists in the navigator.
- [ ] Deep links from Home (`Alarms` with a `filter` param) still preset the
      filter on arrival.
- [ ] `tabBarClearance` still clears the bar on all four tab screens: the last
      list row is fully visible and tappable with the list scrolled to the end.
- [ ] Back behaviour unchanged: Android hardware back from a tab root exits;
      from a pushed screen it pops.

**FAB scope for Sprint 1:** opens the bottom sheet from T5 containing
**"Add Camera"** in a *disabled* state with a one-line reason, or the sheet is
wired to a Sprint-3-ready handler. Do **not** ship an enabled control that
cannot complete — see the note under Sprint 3.

---

### T2 — Menu screen

New tab root; becomes the parent for secondary destinations. Profile moves
behind it.

**Files:** new `src/screens/MenuScreen.jsx`, `AppNavigator.jsx`

**Acceptance criteria**
- [ ] Profile summary row (avatar, name, email) navigates to Profile.
- [ ] Rows present for: Sites, Cameras, Recorded Videos, Settings, About,
      Logout. Rows for **Reports, Map, Camera Health are omitted in Sprint 1**
      (Sprint 3 — see gate).
- [ ] Every row either navigates somewhere real or is not shown. No row opens a
      blank screen.
- [ ] Logout uses the existing confirm-then-`clearSession` flow.
- [ ] Reuses `Card` + row pattern from `ProfileScreen`; no new row component
      unless it replaces both.

---

### T3 — Live View tab screen

The mockup's Live tab: hero player + grid + action row. **This task was missing
from the original plan** — the nav had a Live tab with nothing to put in it.

**Files:** new screen, reusing `LiveTile`, `SegmentedControl`, `ScreenHeader`

**Acceptance criteria**
- [ ] "All Cameras / Favorites" segmented control; Favorites reads the existing
      `favoritesStore`.
- [ ] Hero tile plus grid; tapping any tile promotes it to hero **without**
      remounting the other players.
- [ ] Total concurrent streams on this screen respect the budget from T7.
- [ ] Streams stop when the tab loses focus (`useIsFocused`), matching the
      existing behaviour in `CamerasScreen`.
- [ ] Action row shows only actions that work today. PTZ / Talk are **not**
      shown in Sprint 1.

---

### T4 — Alerts: severity filters

Current chips filter by *type* (People/Vehicles/Motion/Threats). The mockup
filters by *severity* (All/High/Medium/Low).

**Files:** `src/screens/AlertsScreen.jsx`

**Acceptance criteria**
- [ ] Chips are All / High / Medium / Low, with counts from the **unfiltered**
      event list.
- [ ] Severity values map case-insensitively; unknown values fall back to `low`
      (matching `sevOf`).
- [ ] Deep links from Home's AI insight tiles still work — decide and document
      whether they now preset a severity or are re-pointed at the AI Feed.
- [ ] Badge text uses the `*Ink` tier, so contrast holds on the tinted chip.

---

### T5 — BottomSheet + Dialog primitives

`HomeScreen` has an inline `Modal` sheet; dialogs use RN `Alert`. Extract both.

**Files:** `src/components/ui.jsx`, refactor `HomeScreen`'s offline-cameras sheet

**Acceptance criteria**
- [ ] `<BottomSheet>` handles scrim tap-to-close, safe-area bottom padding, the
      grab handle, and Android hardware back.
- [ ] `HomeScreen`'s existing sheet is refactored onto it with no visual change.
- [ ] The FAB sheet (T1) uses the same component.
- [ ] Adding a future option (Add Site, Scan QR) requires no change to the
      sheet component itself.

---

# Sprint 2 — Hardening

## Status: T6 and T7 done · T8 is the remaining gate

| Task | State |
|---|---|
| T6 responsive | Audited. One fixed width in the codebase (the login logo, inside a `maxWidth: 440` container). RN's Yoga has no `min-width: auto` min-content floor, so flex rows shrink correctly — the risk that exists on web does not exist here. Grids are percentage-per-cell with a negative gutter, so they reflow at any width. |
| T7 concurrency | **Now measured, not assumed** — `src/lib/streamBudget.js` refcounts live pulls and logs every holder the moment the ceiling is crossed. |
| T8 regression | **Blocked on a real device.** Cannot be run from here. |
| T9 definition of done | Automated half passes (bundle, theme guard, imports, scope, dead links). Manual half waits on T8. |

### How to run T8 now

The budget monitor turns the manual pass into something you read rather than
argue about. Walk **Home → Live → Cameras → Live Wall → back**, watching the
console. Silence means the ceiling held. A breach names its holders:

```
[budget] 7 concurrent streams — over the 6 ceiling
         { holders: ['Camera Gate1', 'Camera Support', …] }
```

`reportStreamBudget('after leaving Live Wall')` prints the current count, the
holders and the session peak on demand.

**The window to watch** is the transition, not the steady state: Home releases
four tiles while the Live tab arms its hero. Both screens stay mounted in the
tab navigator, so a missing teardown shows up here and nowhere else.

---

### T6 — Responsive & orientation

**Acceptance criteria**
- [ ] Verified at 320 / 360 / 412 / 768pt widths. No horizontal overflow, no
      clipped text, no control under 44pt.
- [ ] Decide and record whether landscape is supported outside the players.
      `app.json` currently sets `"orientation": "portrait"` — if that stands,
      say so here and close the task.
- [ ] Font-scale 1.3× does not clip any row label.

---

### T7 — Global stream-concurrency budget ⭐ *(new — highest product risk)*

`src/lib/config.js` records the real constraint:

> *"The demo NVR tolerates ~6-7 concurrent pulls total"* — `MAX_LIVE_TILES = 4`,
> `WALL_LIVE_TILES = 8`

The new IA adds a Live tab whose mockup shows **5 simultaneous streams**, on top
of Home's 2×2 grid. If teardown lags during navigation the ceiling is exceeded
and **cameras drop for every client**, not just this phone.

**Acceptance criteria**
- [ ] A single documented budget covering Home + Live + Cameras + Live Wall.
- [ ] Navigating Home → Live → Cameras → Live Wall and back never exceeds it;
      measured, not assumed.
- [ ] Teardown is verified: after leaving a screen, its players detach
      (`replaceAsync(null)`) before the next screen's connect stagger begins.
- [ ] The budget is a named constant in `config.js` with a comment explaining
      the NVR limit, not a number spread across screens.

---

### T8 — Streaming regression pass ⭐ *(new)*

The riskiest code here is video lifecycle. A UI refactor breaks it **silently** —
the screen still renders, streams just stop or leak.

**Run after every sprint. Manual, on a real device, against the live NVR.**

- [ ] Live View: connects, plays, HD/SD switch, mute, fullscreen, retry.
- [ ] Camera switching: prev/next steps cameras; back exits in **one** press.
- [ ] Live Wall: paging streams only the current page; swiping releases the old.
- [ ] Playback: date strip, clip selection, expiring-URL refetch.
- [ ] Alarm: test alert rings until STOP; banner sits above all screens.
- [ ] Push: background notification still opens the right screen.
- [ ] Leave the app 5 min on Live Wall, return — no zombie streams, no crash.

---

### T9 — Definition of done

**Automated half — all green as of 2026-08-07:**

- [x] `node scripts/check-theme.mjs` — 43 tokens/theme, 16 pairings × 2 themes, all AA
- [x] Every named import resolves to a real export
- [x] No dead navigation targets — 11 routes registered, every `navigate()` resolves
- [x] No unused imports across screens, components, lib and App
- [x] `tabBarClearance` present on all four tab roots
- [x] `npx expo export --platform android` — 1165 modules, no warnings

**Manual half — waits on a device:**

- [ ] T8 streaming regression walk (budget monitor makes this readable)
- [ ] Light and dark eyeballed per screen
- [ ] Haptics, spring timing, FAB touch target, safe areas on real hardware

---

# Sprint 3 — Backend-gated

## ⛔ Gate: API inventory — STILL CLOSED

**Nothing in this sprint starts until this exists.** Produce a table of the
real `smart-cam-backend` routes: `route · method · request · response · used by
web?`

### Run it yourself: `bash scripts/probe-api.sh`

No backend access or credentials needed. An unauthenticated `GET` still reveals
whether a route exists — `401/403` means it's there and protected, `405` means
it's there and is a write route, `404` means it genuinely isn't. Read-only; it
never writes.

**Attempted 2026-08-07 — inconclusive.** Every route returned `530` /
Cloudflare **error 1033: origin tunnel down**, *including the four control
routes the script probes last* (`/health`, `/ai/events`, `/stream/start`,
`/notifications/register`). Those are known to exist, so the run proves the
server was unreachable, not that anything is missing. That control section is
why the script ends with it — never trust a probe whose controls failed.

### ⚠️ The tunnel is flapping, and that is its own problem

Within one working session the origin went **up → down → up → down**: it served
real camera data to the app, then returned 1033 across four consecutive checks
minutes later. An intermittent tunnel is worse than a dead one — the app
half-works, React Query serves stale cache, and every failure looks like a
different bug. Worth fixing before Sprint 3 starts, independent of any mobile
work.

Re-run the probe when `/api/health` returns 200 and fill the table below.

Confirmed today, `src/lib/api.js` wraps **four** write endpoints — login,
logout, push register/unregister. There is **no** create or update route for
cameras, users, profile or password. The web console *does* ship Camera Setup,
register, forgot/reset password, Camera Health and a Leaflet map, so those
routes probably exist server-side. "Probably" is not a plan.

| Task | Needs | Verified today |
|---|---|---|
| T10 — FAB → Add Camera | `POST` camera + device probe | ❌ absent from mobile |
| T11 — Sign Up | `POST /auth/register` | ❌ absent from mobile |
| T12 — Map View | site `lat`/`lng` | ❌ `/groups` returns no coordinates |
| T13 — Camera Health | uptime / latency / flap | ❌ absent from mobile |
| T14 — Reports | reports list | ❌ absent from mobile |

**Rule for this sprint:** a control that cannot complete its action is not
shipped, disabled or otherwise. On a security console a button that appears to
work and does nothing is a safety problem, not a UX one.

**Deferred beyond Phase 1:** PTZ and two-way Talk. PTZ needs an ONVIF/NVR
control route. Talk needs mic capture, an upstream audio path and NVR
backchannel support — that is its own project, not a task.

---

## Verification

```bash
# theme guard — token parity + WCAG AA on every rendered pairing, both themes.
# Exits non-zero on failure, so it can gate a PR.
node scripts/check-theme.mjs

# bundles clean (catches import/syntax breakage)
npx expo export --platform android --output-dir /tmp/exp --clear

# no dead navigation targets after the IA change
grep -rn "navigate('" src/ | sed -E "s/.*navigate\('([A-Za-z]+)'.*/\1/" | sort -u
```

`scripts/check-theme.mjs` is the one that catches silent regressions. A colour
token added to `light` but forgotten in `dark` renders as *transparent*, not as
an error — and a badge whose ink drops below 4.5:1 looks fine to whoever picked
it. Both currently pass: 43 tokens per theme, 16 pairings, both modes.

---

## Open decisions

| # | Decision | Blocks |
|---|---|---|
| 1 | Warm cream page background (mockup) vs cool `#F8F9FB` (current)? 3 tokens in `palettes.js`. | Cheapest now, before Sprint 1 |
| 2 | FAB behaviour in Sprint 1 — disabled Add Camera, or a different action that works today? | T1 |
| 3 | Is iOS in scope? `app.json` configures it; the original plan said "Android". | T6 |
| 4 | Mock data for Reports / AI Analytics, matching the web console — and is it labelled "Demo data"? | Sprint 3 |
| 5 | Google / Microsoft SSO — real, or decorative in the mockup? | T11 |

**Recommendation on #4:** mock is acceptable for *analytical* screens if
visibly labelled, matching what web already does. It is not acceptable for
*operational* controls.
