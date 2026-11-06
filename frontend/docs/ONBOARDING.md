# smart-cam-app — Onboarding

Welcome. This document gets you from "I cloned the repo" to "I shipped my first PR" in an afternoon. Read it once top-to-bottom, then keep it open while you poke around.

## What this service is

`smart-cam-app` is the operator UI for the Drishyam VMS. Everything a security operator sees in a browser lives here: Live View, AI Feed, Alerts, Footfall, Personnel Search, Face Learning, Watchlist, Camera Setup, Map, Playback, Monitor Wall. The app sits behind a left sidebar nav (see [Sidebar.jsx](../src/components/Sidebar.jsx)) with a top bar; every operator page renders inside that shell. It is the only public-facing surface of the platform — there is no separate desktop or mobile app, just this React build served from the gateway.

This is a Vite + React 19 + Tailwind v4 + shadcn/ui frontend. It talks to `smart-cam-backend` (Node/Express) at `localhost:5000/api/*` via an axios instance, and consumes WebRTC/HLS streams from MediaMTX. Auth is a JWT stored in `localStorage` (`auth_token` + `refresh_token`); the same token is passed to the socket.io connection. `@tanstack/react-query` handles server-cache; `zustand` handles cross-page UI state.

## Repo layout

```
smart-cam-app/
├── src/
│   ├── App.jsx              # Top-level router. Adds every page to <Routes>.
│   ├── main.jsx             # Bootstraps QueryClient, BrowserRouter, ThemeProvider.
│   ├── pages/               # One file per top-level route. Lazy-loaded.
│   ├── components/          # Shared widgets: Sidebar, Topbar, video players, dialogs.
│   ├── components/ui/       # shadcn/ui primitives. Don't hand-edit these unless you
│   │                        # know what you're doing — re-run `npx shadcn add` instead.
│   ├── services/            # REST clients + socket + stream cache. One file per
│   │                        # logical backend area (ai.js, auth.js, recordings.js…).
│   ├── hooks/               # Reusable hooks. useQueries.js wraps react-query around
│   │                        # the service functions; useDashboardStats aggregates.
│   ├── store/               # zustand stores. Today there's only authStore.js.
│   ├── context/             # React context providers (ThemeContext for dark mode).
│   ├── admin/               # The admin-only console — separate router, separate auth.
│   │                        # Ignore this until you're shipping admin features.
│   ├── lib/                 # Tiny utilities (cn() for classnames merge).
│   ├── assets/              # Static images. logo.png + react.svg.
│   └── index.css            # Tailwind base + shadcn CSS variables. Brand tokens live
│                            # here.
├── public/                  # Files served verbatim by Vite at the root URL.
├── dist/                    # Build output (don't edit, don't commit hand-edits).
├── docs/                    # You are here.
├── index.html               # Vite entry HTML.
├── vite.config.js           # Path alias `@` → `src/`, react plugin, tailwind plugin.
├── components.json          # shadcn/ui config. "new-york" style, neutral base.
├── Dockerfile               # Dev container: node:20-bookworm-slim, runs `vite --host`.
├── package.json             # Dependencies — React 19, Vite 7, Tailwind 4, shadcn 3.
└── .env / .env.example      # VITE_API_BASE_URL etc.
```

The path alias `@` resolves to `src/` (see [vite.config.js:9-11](../vite.config.js#L9)). Every import you write should look like `@/components/Foo` or `@/services/bar`, not `../../components/Foo`. The linter does not enforce this but every existing file follows it; reviewers will ask you to convert relative imports.

## How to start

You have two equally supported options. Pick whichever fits the rest of your day.

### Option A — Docker compose (recommended if you're also running the backend)

The repo root has a `docker-compose.yml` that brings up `smart-cam-app`, `smart-cam-backend`, MediaMTX, MySQL, MongoDB, and the AI service. The frontend container bind-mounts the repo so Vite HMR works without rebuilding:

```bash
cd c:\Users\systo\Desktop\anil\drisyam
docker compose up smart-cam-app
```

The container runs `npm run dev -- --host 0.0.0.0` ([Dockerfile:12](../Dockerfile#L12)). HMR over file watching needs polling on Windows bind mounts — make sure `CHOKIDAR_USEPOLLING=true` is set in the compose env block for the service. Without it, edits show up only after a full reload.

### Option B — Bare-metal Node

```bash
cd smart-cam-app
npm install
npm run dev
```

You'll need a running `smart-cam-backend` on `localhost:5000` for any non-trivial page to load data. The login screen still renders without it, you'll just get 502s when you try to log in.

### Environment variables

Both options read `.env`. The committed `.env.example` only lists two, but in practice the app also reads a third. Copy it and fill in:

```
VITE_API_BASE_URL=http://localhost:5000
VITE_MEDIAMTX_WEBRTC_BASE=http://localhost:8889
VITE_AI_BASE_URL=http://localhost:8001
```

- `VITE_API_BASE_URL` is the Node backend. The axios baseURL becomes `${VITE_API_BASE_URL}/api` ([api.js:3-7](../src/services/api.js#L3)).
- `VITE_MEDIAMTX_WEBRTC_BASE` is where [WebRTCStream.jsx](../src/components/WebRTCStream.jsx) posts WHEP offers ([WebRTCStream.jsx:37-38](../src/components/WebRTCStream.jsx#L37)). Default `localhost:8889`.
- `VITE_AI_BASE_URL` is read by a handful of pages that hit the AI service directly instead of going through the Node proxy — `Footfall`, `PersonnelSearch`, `JourneyMap`, `AiFeed`. Default `localhost:8001`. Most new code should go through the proxy via `services/ai.js`; the direct calls are tactical and we're not adding more of them.

Vite only exposes vars prefixed `VITE_` to the browser, so the prefix is mandatory.

## Where things live

A flowchart for your first month:

- **"I need a new page."** Drop a file in [src/pages/](../src/pages/). Wire it into [App.jsx](../src/App.jsx) with `lazy(() => import(...))` plus a `<Route>` inside `<ProtectedRoute>{wrap(<MyPage />)}</ProtectedRoute>`. Add a nav entry to [Sidebar.jsx](../src/components/Sidebar.jsx) inside the right `NAV_GROUPS` block (Overview / Operations / AI Intelligence).

- **"I need a reusable UI primitive (button, dialog, tabs)."** Check [src/components/ui/](../src/components/ui/) first. shadcn primitives we already have: Avatar, Badge, Button, Card, Dialog, Dropdown Menu, Input, Progress, Select, Separator, Table, Tabs, Tooltip. If you need a new one, install it: `npx shadcn add <name>` — that generates a file under `src/components/ui/`. Do not write a bespoke `<Modal>` from scratch when you could `add dialog`.

- **"I need to talk to the backend."** Look in [src/services/](../src/services/). There's already a module per area: `auth.js`, `ai.js`, `recordings.js`, `cameraGroup.js`, `cameraHealth.js`, `shinobi.js`, `site.js`, `payment.js`, `license.js`, `streamCache.js`, `socket.js`. Add your function to the right one rather than calling `axios` directly inside a component. Every service imports the configured `api` instance from [api.js](../src/services/api.js); that's where the JWT interceptor and 401 refresh logic lives.

- **"I need a hook that wraps a service call with caching."** Add it to [src/hooks/useQueries.js](../src/hooks/useQueries.js). Use the `queryKeys` map at the top of the file for the cache key. Keep `staleTime` snug (`30_000` for camera lists, `60_000` for recordings, `15_000` for groups) — the global default in [main.jsx:29](../src/main.jsx#L29) is 60 s but most things deserve tighter.

- **"I need shared state across multiple pages."** Add it to a store in [src/store/](../src/store/). Today the only store is `authStore.js`. Rule of thumb: server state goes in react-query, ephemeral UI state stays in `useState`, only put things in zustand when more than one page needs it and it doesn't come from a server endpoint.

- **"I need a global event from the server (push)."** Use [src/services/socket.js](../src/services/socket.js). Call `connectSocket()` once after login (already done by `authStore.login`), then `const off = on('ai.event', handler)` inside a `useEffect`, returning `off` from the cleanup. The socket is a singleton; calling `connectSocket()` multiple times is safe.

## Key files you'll touch every week

- [src/App.jsx](../src/App.jsx) — the router. Adds every page to the route table with `lazy()` + `<Suspense>` + `<ProtectedRoute>`. Monitor Wall (line 103) has its own full-screen layout because the sidebar doesn't render there. The `/admin/*` subtree (line 83) lives outside `AppLayout` entirely.
- [src/components/Sidebar.jsx](../src/components/Sidebar.jsx) — the nav. Edit `NAV_GROUPS` at lines 31-67 to add an item. The "AI Operations" group is a collapsible parent with children (line 51), the others are flat. Active-state styling is the orange glow at lines 198-200.
- [src/services/api.js](../src/services/api.js) — the axios instance. Interceptors attach the JWT (line 11-17) and silently refresh on 401 (line 39-90). Don't bypass this; every backend call goes through it.
- [src/services/ai.js](../src/services/ai.js) — the largest service module (~288 lines). Two halves: a REST surface (`aiService.listEvents`, `peopleCount`, `footfallCameras`, `enhanceFace`, `uploadFace`, watchlist CRUD, etc.) and a view-model layer (`describe(evt, cameras)` returns `{ title, subject, tone, theme, iconName, cameraLabel, … }` so every page that renders an event reads the same fields). Read this end-to-end before touching anything AI-related.

Bonus list:
- [src/components/DirectStreamPlayer.jsx](../src/components/DirectStreamPlayer.jsx) — the WebRTC+HLS player used by every "watch a camera" surface. Single source of truth for live video.
- [src/services/streamCache.js](../src/services/streamCache.js) — keeps HLS.js instances alive across mounts so switching cameras and coming back is instant.
- [src/hooks/useQueries.js](../src/hooks/useQueries.js) — `useGroups`, `useCameras`, recordings hooks. If you find yourself writing `useQuery({ queryKey: ['cameras'], … })` inline, stop and import from here instead.
- [src/store/authStore.js](../src/store/authStore.js) — `useAuthStore()`. `login`, `logout`, `user`, `isAuthenticated`. The socket gets connected/disconnected from inside this store.

## First task suggestions

Three real PRs we'd hand a new hire. Each one teaches a different layer.

**5-line PR — "Change the offline badge wording."** In [src/pages/LiveView.jsx](../src/pages/LiveView.jsx) the camera item shows "Offline" via `StatusDot`. The Sidebar item count, the Live View header, and the Camera tile each phrase offline cameras slightly differently ("OFF" vs "Offline" vs "off"). Pick one phrasing, search/replace across the three pages, open a PR. This teaches you the codebase by forcing you to grep, and it's the kind of polish reviewers will actually merge same-day.

**50-line PR — "Add a 'last seen' tooltip on the AI Alerts row."** In [src/pages/Alerts.jsx](../src/pages/Alerts.jsx) the event rows show a relative timestamp but no absolute. Add a `<Tooltip>` (from `@/components/ui/tooltip`) that shows the ISO date on hover. Use the `describe()` helper's `when` field, format with `date-fns` (already installed). You'll touch one page, one shadcn primitive, one util. Good practice for shadcn patterns and the view-model pattern.

**200-line PR — "Footfall: add per-camera 'last update' badge."** In [src/pages/Footfall.jsx](../src/pages/Footfall.jsx) each camera card shows IN/OUT counters but no indication of how stale the count is. Plumb `last_event_at` from the AI service through `aiService.footfallCameras()` ([ai.js:50-52](../src/services/ai.js#L50)), surface it on the row, and render a "Stale — no events for 5m" badge in amber when more than 5 minutes old. You'll touch a service, a page, and possibly the backend if `last_event_at` isn't already returned. Realistic full-stack feature work.

## House style

- All imports use the `@/` alias.
- Brand orange is `#F7983A`. Use it for primary actions and active nav, not for body text.
- shadcn primitives over hand-rolled components every time. If shadcn doesn't have it, `npx shadcn add` it.
- One server-state read per page goes through react-query; one cross-page UI state goes through zustand; the rest is `useState`.
- File names are PascalCase for components (`Sidebar.jsx`), camelCase for everything else (`useQueries.js`, `streamCache.js`).
- We don't write tests today. There is no Jest, Vitest, or Playwright in `package.json`. The team's strategy is "ship behind a feature flag, verify in staging, roll back fast." Don't add a test framework without team agreement.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) next to understand how the layers fit together, then [FEATURES.md](./FEATURES.md) for a page-by-page tour, and keep [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) bookmarked for when the video goes black at 5 pm on a Friday.
