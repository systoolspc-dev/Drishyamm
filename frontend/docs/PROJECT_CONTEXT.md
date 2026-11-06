# Drishyam (`smart-cam-app`) — Project Context Pack

> Paste this whole file into another AI as context before asking it to generate code
> for this repo. It describes the stack, architecture, conventions, and the exact
> patterns to copy. Everything below reflects the real repo state on branch
> `ASTHA_activity_monitoring`.

---

## 1. What this product is

A **web console for an AI-powered video surveillance / VMS platform** ("Drishyam").
Operators log in and get: live camera streams, playback, a monitor wall, camera
health/setup — plus a layer of **AI analytics** (weapon detection, ANPR, face
watchlist, crowd, fire, aggression) and **Activity Monitoring** (workforce /
occupancy intelligence) packaged per industry vertical.

There is also a self-contained `/admin` sub-app (licenses, customers, tickets,
pricing) with its own layout and auth.

**Crucial:** all of the Activity Monitoring and AI Analytics screens are currently
**FRONTEND-ONLY**. They render realistic mock data from local `data.js` /
`pages-data.js` modules. No API calls. Backend endpoints are named in comments
(e.g. `// Backend later: GET /bank/overview`) so pages can be swapped to
`useQuery` later. **Any new page you generate should follow this — mock data in a
sibling data module, no fetch.**

---

## 2. Stack

| Thing | Choice |
|---|---|
| Framework | **React 19** + **Vite 7**, plain **JavaScript (JSX)** — *no TypeScript* |
| Routing | `react-router-dom` v7 (all routes declared centrally in `src/App.jsx`) |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`), utility classes inline |
| UI primitives | shadcn/ui (new-york style, neutral base) in `src/core/ui/`, Radix under the hood |
| Icons | **lucide-react** (only icon library used) |
| Charts | **recharts** |
| State | **zustand** (`src/core/store/`, `useCaseStore.js`) |
| Server state | `@tanstack/react-query` (used by `core/` VMS pages only) |
| HTTP | `axios` |
| Realtime | `socket.io-client`, `livekit-client`, `hls.js` |
| Maps | `leaflet` + `react-leaflet` |
| Animation | `framer-motion` |
| Lint | ESLint 9 flat config |

Scripts: `npm run dev` · `npm run build` · `npm run lint` · `npm run preview`

**Import alias:** `@/` → `src/` (configured in `vite.config.js` + `jsconfig.json`).
Always import with `@/...` for cross-layer imports; relative paths within a module folder.

Env: `VITE_API_BASE_URL`, `VITE_SHINOBI_URL` (see `.env.example`).
Prod build uses `base: '/d-app/'` and strips `console.log/debug/info`.

---

## 3. Three-layer architecture (the mental model)

```
src/
├── core/        Layer 1 — BASE VMS. What every customer gets.
├── modules/     Layer 2 — AI CAPABILITIES. Written ONCE.
├── use-cases/   Layer 3 — PRODUCT CATALOG. Which modules + what parameters.
├── ai-analytics/  ← separate, self-contained module system (own CSS scope)
└── admin/         ← separate admin sub-app (own layout + auth)
```

### THE GOLDEN RULE
> **Module code is written once. Verticals only change parameters.**

A corporate office and a retail floor run the *same* `employee-productivity`
module — only business hours, break tolerance, phone strictness differ. So never
fork module code per vertical; add a parameter block in `use-cases/<vertical>/index.js`.

*(In practice, verticals with very different domain shapes — school vs bank —
do get their own subfolder of pages under `modules/employee-productivity/<vertical>/`,
but they share the same shell components, chart tokens, and card language. The
parameter block is still what gates them.)*

### Layer 1 — `core/`
| Folder | Contents |
|---|---|
| `core/pages/` | Home, Dashboard, LiveView, MonitorWall, Playback, CameraSetup, CameraHealth, Map, Settings, Help, Login/Register/Reset, ComputeCost, FeatureDemos |
| `core/layout/` | `Sidebar`, `Topbar`, `ProtectedRoute`, `ErrorBoundary`, `AIToastHost`, `NotificationBell` |
| `core/ui/` | shadcn primitives: button, card, dialog, table, tabs, select, badge, input… |
| `core/players/` | `HLSPlayer`, `WebRTCPlayer`, `DirectStreamPlayer`, `ShinobiEmbedPlayer`, `AIOverlay`, `ZoomIndicator` |
| `core/services/` | `api.js`, `auth.js`, `ai.js`, `socket.js`, `livekit.js`, `recordings.js`, `shinobi.js`, `streamRegistry.js`, `license.js`, `payment.js`… |
| `core/hooks/` `store/` `lib/` `context/` `config/` | cross-cutting (`useQueries`, `authStore`, `notificationStore`, `endpoints.js`) |

### Layer 2 — `modules/`
| Module | Pages |
|---|---|
| `employee-productivity/` | **The big one** — Activity Monitoring across 7 verticals (see §5) |
| `face/` | FaceLearning, Watchlist, PersonnelSearch |
| `ai-feed/` | Live AI event feed + attendance panel |
| `footfall/` | Footfall counter |
| `person-tracking/` | PersonTracker, JourneyMap, CameraMapping |
| `alerts/` | AI alerts |

### Layer 3 — `use-cases/`
`src/use-cases/index.js` is the registry:

```js
import corporate from './corporate'; /* retail, campus, school, hostel, hospitality, bank */
export const USE_CASES = { corporate, retail, campus, school, hostel, hospitality, bank }
export const DEFAULT_USE_CASE = 'corporate'
export function getUseCase(key)                  // → preset (falls back to default)
export function moduleParams(useCaseKey, moduleKey)  // → params object ({} if absent)
export function hasModule(useCaseKey, moduleKey)     // → bool
```

A preset looks like this (`use-cases/bank/index.js`):

```js
import { productivityDefaults } from '../employee-productivity.params'

export default {
  key: 'bank',
  label: 'Bank',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: {
    'employee-productivity': {
      ...productivityDefaults,
      businessHours: '09:00-18:00',
      bank: {                        // ← presence of this block gates bank pages
        tellerSlaMin: 5,
        maxQueue: 10,
        vaultDualControl: true,
        cashDrawerLimit: 200000,
        restrictedZones: ['Vault', 'Server Room', 'Cash Room'],
      },
    },
  },
}
```

Shared defaults (`use-cases/employee-productivity.params.js`):

```js
export const productivityDefaults = {
  businessHours: '09:00-18:00', lateAfter: '09:30',
  breakGapSec: 900, sessionGapSec: 3600,
  minDetections: 3, minSimilarity: 0.5,
  phone: { holdSec: 1.5, requireHand: true },
  strangerDwellSec: 180,
}
```

**Vertical param blocks currently defined:** `corporate` (none extra) ·
`retail` → `zones`, `queue` · `campus` → `campus`, `library` · `school` →
`school`, `safety`, `transport` · `hostel` → `hostel` · `hospitality` →
`hospitality` · `bank` → `bank`.

---

## 4. Routing & navigation

- **All routes live in `src/App.jsx`.** Every page is `lazy()`-imported and
  wrapped: `<Route path="/x" element={<ProtectedRoute>{wrap(<Page />)}</ProtectedRoute>} />`
  where `wrap()` applies the `AppLayout` (Sidebar + Topbar + Suspense spinner).
- AI-analytics pages use `ai(<Page />)` instead — same shell plus a
  `.ai-analytics-scope` div that supplies that subsystem's scoped CSS tokens.
- `/admin/*` and `/monitor-wall` bypass the shell.
- Catch-all `*` → `/login`.

**Sidebar** (`src/core/layout/Sidebar.jsx`) holds `NAV_GROUPS`
(`Overview` / `Operations` / `AI Intelligence` / …). The **Activity Monitoring**
item has a `children` array; each child is filtered at render time by:

```js
(!c.needsParam || activityParams[c.needsParam])   // show only if param block exists
&& (!c.hideParam || !activityParams[c.hideParam])
&& (!c.hideFor  || !c.hideFor.includes(useCase))  // hide for listed verticals
```

So a bank-only page is declared as
`{ to: '/activity-monitoring/bank/teller', label: 'Teller', icon: Users, needsParam: 'bank' }`.

### Adding a page — the 3 touch points
1. Create the page component under the right module folder.
2. `lazy()` import + `<Route>` in `src/App.jsx`.
3. Child entry (with `needsParam`) in `NAV_GROUPS` in `src/core/layout/Sidebar.jsx`.

---

## 5. Activity Monitoring — the vertical system (most active area)

`src/modules/employee-productivity/`

```
├── dashboard/ActivityDashboard.jsx   ← ENTRY: switches layout by active vertical
├── useCaseStore.js                   ← zustand: which vertical is active
├── useModuleData.js                  ← vertical-aware mock data selector
├── UseCaseSwitcher.jsx               ← "Viewing as" pill row (top of every dashboard)
├── PolicyBar.jsx  RulesPolicies.jsx  rules/
├── corporate-data.js  pages-data.js  (retail/corporate shared pages at this level:
│                                      AttendanceReport, EventLog, PhoneUsage,
│                                      ActivityBreakdown, ZoneCoverage, Reports…)
├── campus/    (+ campus/components/, many *-data.js)
├── school/    (+ school/components/)
├── hostel/    (+ hostel/components/, useHostelStore.js)
├── hospitality/ (+ hospitality/components/)
└── bank/      (+ bank/components/)   ← NEWEST, cleanest reference implementation
```

### The vertical switch
`dashboard/ActivityDashboard.jsx`:
```js
const { useCase } = useActivityParams();
if (useCase === 'campus')      return <CampusDashboard />;
if (useCase === 'school')      return <SchoolDashboard />;
if (useCase === 'hostel')      return <HostelDashboard />;
if (useCase === 'hospitality') return <HospitalityDashboard />;
if (useCase === 'bank')        return <BankDashboard />;
return <RetailOfficeDashboard />;   // corporate + retail share this
```

`useCaseStore.js`:
```js
export const useUseCaseStore = create((set) => ({
  useCase: localStorage.getItem('activity-use-case') || 'retail',
  setUseCase: (key) => { localStorage.setItem('activity-use-case', key); set({ useCase: key }); },
}));
export function useActivityParams() {   // → { useCase, label, enabled, params }
  ...moduleParams(useCase, 'employee-productivity')
}
```

### Canonical vertical folder layout (copy `bank/`)
```
bank/
├── BankDashboard.jsx      landing page
├── Teller.jsx CashOps.jsx Movement.jsx Security.jsx Facility.jsx
│   Productivity.jsx StaffRoster.jsx StaffDetail.jsx Alerts.jsx Reports.jsx
├── data.js                dashboard mock data + STATUS_CHIP/LEVEL_CHIP + metricCard()
├── pages-data.js          per-subpage mock data (TELLER_DATA, CASHOPS_DATA, …)
└── components/
    ├── BankHeader.jsx     title + search + auto-refresh + last-updated
    ├── BankFilterBar.jsx  Area → Zone → Time-range cascade
    ├── BankModules.jsx    tiles linking to the subpages
    ├── KeyMetrics.jsx     StatCards fed from data.js
    ├── ActivityInsights.jsx / LiveOverview.jsx   section bodies
    └── bits.jsx           StatCards, Chip, LevelChip  (components only!)
```

### Shared building blocks (import from `campus/components/`, don't re-create)
```js
import Panel from '../campus/components/Panel';               // level-2 white card w/ icon header
import SectionCard from '../campus/components/SectionCard';   // collapsible section w/ eye toggle
import { AXIS, GRID, TIP } from '../campus/components/profileConstants'; // recharts tokens
```
`profileConstants.js` also exports `TONE_DOT` and `SEV_BAR`.

### Fast Refresh rule (repeatedly enforced in comments)
**`.jsx` files export components only.** Constants, chip maps, and helper
functions live in `.js` modules (`data.js`, `profileConstants.js`) — otherwise
Vite Fast Refresh breaks. Follow this.

---

## 6. Design system / visual conventions

**Brand accent: `#F7983A` (orange). Hover: `#e8882b`. Tint: `bg-[#F7983A]/10`.**
Everything else is neutral slate; **colour is the only strong signal on a card.**

Page shell (every Activity Monitoring page):
```jsx
<div className="min-h-[calc(100vh-4rem)] bg-slate-50/60">
  <div className="mx-auto max-w-[1500px] px-4 py-5">
    {/* header: 10x10 rounded-xl bg-[#F7983A]/10 icon tile + h1 + muted p */}
    <div className="space-y-4"> … </div>
  </div>
</div>
```

Page header block:
```jsx
<div className="mb-4 flex items-center gap-2.5">
  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F7983A]/10 text-[#F7983A]">
    <Icon className="h-5 w-5" strokeWidth={2} />
  </span>
  <div>
    <h1 className="text-lg font-extrabold tracking-tight text-slate-900">Title</h1>
    <p className="text-[12px] text-slate-500">One-line description. Times IST.</p>
  </div>
</div>
```

Stat card (`bits.jsx` → `StatCards`):
```jsx
<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F7983A]/10 text-[#F7983A]"><Icon className="h-4 w-4" /></span>
  <p className="mt-3 truncate text-[11.5px] font-medium text-slate-500">{label}</p>
  <p className="mt-1 text-[20px] font-extrabold leading-none tracking-tight text-slate-900">{value}</p>
  <p className="mt-1.5 truncate text-[10.5px] text-slate-400">{sub}</p>
</div>
```

Status chips (ring style, from `data.js`):
```js
export const STATUS_CHIP = {
  open|active|resolved|confirmed|good: 'bg-emerald-50 text-emerald-600 ring-emerald-200',
  break|in-progress|warn:              'bg-amber-50 text-amber-600 ring-amber-200',
  pending|closed|offline:              'bg-slate-100 text-slate-500 ring-slate-200',
  overdue|single:                      'bg-rose-50 text-rose-600 ring-rose-200',
};
export const LEVEL_CHIP = { high: rose, medium: amber, low: slate };
```

Buttons — primary: `bg-[#F7983A] text-white shadow-sm hover:bg-[#e8882b]`;
secondary: `border border-slate-200 bg-white text-slate-700 hover:border-[#F7983A]/40 hover:text-[#b96a15]`.
Both `rounded-lg px-3 py-2 text-[12.5px] font-semibold inline-flex items-center gap-1.5`.

Tables — `w-full border-collapse text-[12px]`, header row
`text-left text-[10px] uppercase tracking-wide text-slate-400`, body
`divide-y divide-slate-100`, rows `hover:bg-slate-50`, numbers `tabular-nums`,
times `font-mono text-[11px]`. Wrap in `<div className="overflow-x-auto">`.

Charts — recharts inside `<Panel>` with `<div className="h-56"><ResponsiveContainer>`;
always `<CartesianGrid {...GRID} />`, `tick={AXIS} axisLine={false} tickLine={false}`,
`<Tooltip {...TIP} />`; bars `fill="#F7983A" radius={[4,4,0,0]} maxBarSize={22}`;
areas use a `linearGradient` def with a unique id.

Type scale (deliberately small/dense): `text-[10px] · [10.5px] · [11px] · [11.5px] · [12px] · [12.5px] · [14px] · text-lg`.
Radii: cards `rounded-xl`, sections `rounded-2xl`, chips `rounded-full`, controls `rounded-lg`.
Locale: **IST**, `en-IN`, ₹ for currency.

Common page-level behaviours to replicate: `localStorage`-persisted section
visibility (`SectionCard` + eye toggle), simulated refresh
(`setLoading(true); setTimeout(..., 700)`), 30s auto-refresh timestamp, CSV export
built by hand with `Blob` + `URL.createObjectURL`, sticky bottom Quick Actions bar.
Every `localStorage` access is wrapped in `try/catch` (private mode).

---

## 7. `ai-analytics/` subsystem (separate conventions)

`src/ai-analytics/` is a self-contained system, **not** merged into the three
layers. It has its own CSS design system scoped to `.ai-analytics-scope`
(`analytics.css` + `ai-analytics-overrides.css`, both imported in `App.jsx`), its
own `components/ui.jsx`, `core/services/apiClient.js`, `core/hooks/useAlertStream.js`,
and its own mock data in `ai-analytics/data/`.

Sub-modules, each with a `*Router.jsx` owning its sub-routes under a splat route:
`ANPR` (vehicle), `WeaponDetection`, `Aggression`, `FireDetection`, `FaceWatchlist`,
`CrowdMonitoring`, `RestrictedZone`, `Productivity`, `GIS`, `VMS`.
Routes: `/ai-analytics`, `/ai-analytics/{weapon,aggression,fire,watchlist,vehicle}/*`,
`/ai-analytics/{restricted,crowd,productivity}`.

**If you generate an AI-analytics page, follow that folder's local conventions,
not the Activity Monitoring ones.**

---

## 8. Repo layout & docs

```
/                       Vite root — the main app
├── src/                (see above)
├── docs/               ARCHITECTURE.md, FEATURES.md, ONBOARDING.md,
│                       TROUBLESHOOTING.md, retail-activity-monitoring.md
│                       (retail-activity-monitoring.md = the widget/field/formula
│                        contract for the Activity Monitoring dashboard)
├── src/README.md       ← the authoritative architecture doc (read it)
├── whatidid.md, readmeactivitypal.md   ← working notes / changelog
├── Bank/  Hospitality/  Hostel/        ← standalone prototype Vite apps that were
│                                          transformed INTO the verticals above.
│                                          Reference material, not built or shipped.
├── Dockerfile, .dockerignore, check-env.mjs
└── README.md           ← still the stock Vite template, ignore it
```

Recent commit history (branch `ASTHA_activity_monitoring`) shows the working
rhythm: one vertical at a time —
`ADDED AND INTEGRATED HOSPITALITY AND BANK'S ACTIVITY MONITORING` ·
`GUARDIAN REGISTRY PAGE AND SOME ALERTS RULES ADDED` ·
`ADDED SCHOOL ACTIVITY MONITORING` ·
`made changes in corporate use case, added rules sub page`.

---

## 9. Rules for generated code (give these to the other AI verbatim)

1. **JavaScript + JSX only. No TypeScript.** No prop-types.
2. **Function components, default export**, named `export default function PageName()`.
3. **Tailwind utility classes inline.** No CSS modules, no styled-components, no
   new `.css` files (except within `ai-analytics/`, which has its own system).
4. **Icons from `lucide-react` only.** Charts from `recharts` only.
5. **Mock data only** — put it in a sibling `data.js` / `pages-data.js` with a
   comment naming the future endpoint (`// Backend later: GET /bank/overview`).
   No `fetch`, no `axios`, no `useQuery` in Activity Monitoring pages.
6. **`.jsx` files export components only**; constants/helpers go in `.js` (Fast Refresh).
7. Reuse `Panel`, `SectionCard`, `StatCards`, `Chip`, `LevelChip`, `AXIS/GRID/TIP`.
   Don't invent new card shells.
8. Accent is `#F7983A`; everything else slate. Match the dense type scale above.
9. Wrap `localStorage` in `try/catch`.
10. Cross-layer imports use `@/`; intra-module imports are relative.
11. When adding a page, also give the `App.jsx` route line and the `Sidebar.jsx`
    `NAV_GROUPS` child entry (with the correct `needsParam`).
12. When adding a vertical, add `use-cases/<key>/index.js`, register it in
    `use-cases/index.js`, add an icon in `UseCaseSwitcher.jsx`'s `ICONS` map, and
    a branch in `ActivityDashboard.jsx`.
13. Comments explain *why* (business rule, threshold meaning), not *what*. Match
    the existing density — section banners like
    `// ── SECTION 2 · KPI cards ──…` and header block comments are the house style.
14. Copy from `modules/employee-productivity/bank/` — it's the newest and
    cleanest reference implementation.

---

## 10. Reference files worth pasting alongside this pack

Depending on what you're asking for, include the actual source of:

| Asking for | Also paste |
|---|---|
| A new vertical | `use-cases/bank/index.js`, `bank/BankDashboard.jsx`, `bank/data.js`, `bank/components/bits.jsx`, `UseCaseSwitcher.jsx`, `ActivityDashboard.jsx` |
| A new subpage in an existing vertical | that vertical's `pages-data.js` + one existing page (e.g. `bank/Teller.jsx`) |
| A shared component | `campus/components/Panel.jsx`, `SectionCard.jsx`, `profileConstants.js` |
| Routing/nav changes | `src/App.jsx`, `src/core/layout/Sidebar.jsx` (lines 60–150, 222–245) |
| An AI-analytics page | the relevant `ai-analytics/components/<Module>Router.jsx` + a sibling page |
| Architecture questions | `src/README.md`, `docs/ARCHITECTURE.md` |
