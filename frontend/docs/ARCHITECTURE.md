# smart-cam-app — Architecture

How the React frontend is put together. The frontend is a Vite + React 19 + Tailwind + shadcn/ui SPA served at `:5173`, talking to `smart-cam-backend` at `:5000/api/*`.

## Boot path

```
index.html
   ↓ <script src="src/main.jsx">
main.jsx
   ↓ <React.StrictMode> <App />
App.jsx
   ↓ <BrowserRouter> <QueryClientProvider> <AIToastHost>
   ↓ <Sidebar /> <Topbar /> <Routes>
   ↓ One <Route path="..." element={<ProtectedRoute>{wrap(<Page/>)}</ProtectedRoute>} /> per page
```

Pages are `lazy(() => import())`-loaded so the bundle ships ~250 KB initial; everything else streams on demand.

## Routing

[App.jsx](../src/App.jsx) is the single source of truth for routes. Adding a page:

1. `const Foo = lazy(() => import('@/pages/Foo'))`
2. `<Route path="/foo" element={<ProtectedRoute>{wrap(<Foo />)}</ProtectedRoute>} />`
3. Add the entry to [components/Sidebar.jsx](../src/components/Sidebar.jsx)'s `NAV_GROUPS`.

`ProtectedRoute` reads the JWT cookie via `useAuthStore`; absent → `<Navigate to="/login" replace />`.

## Data layer

```
Page  ──useQueries.useGroups()──▶  @tanstack/react-query cache  ──axios──▶  /api/groups
                                                                                   │
Page  ──aiService.footfallCameras()──▶  api.get('/ai/footfall/cameras')           │
                                                                                   ▼
                                                                            smart-cam-backend
```

[services/api.js](../src/services/api.js) is the axios instance. It carries:
- `baseURL: VITE_API_BASE_URL || 'http://localhost:5000/api'`
- `withCredentials: true` so the auth cookie travels
- Response interceptor that catches 401s, calls `/auth/refresh`, retries once, then redirects to `/login` if refresh fails

[services/ai.js](../src/services/ai.js) is the biggest service module — wraps every `/api/ai/*` route the AI proxy exposes. New AI endpoint? Add a method here, never call the URL directly from a page.

[services/socket.js](../src/services/socket.js) is the Socket.IO client. The `on('ai.event', handler)` helper auto-reconnects through tokens.

## React Query conventions

```jsx
// src/hooks/useQueries.js
export function useGroups(options = {}) {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => cameraGroupService.getGroups(),
    staleTime: 15_000,
    ...options,
  });
}
```

- `queryKeys` (in the same file) is a const tree so we never typo a key.
- `staleTime` is conservative (5-60 s) so the page doesn't flash on every navigation.
- Mutations live next to the queries; they call `queryClient.invalidateQueries({queryKey: queryKeys.groups})` to refresh.

## Global state

[store/](../src/store/) — zustand stores. Use them only for state that crosses pages and isn't server data:
- `authStore` — current user + JWT presence
- `cameraStore` — cross-page selected camera (so opening Live View from Personnel keeps the choice)
- `aiStore` — AI Feed/Alerts global filters

Server state belongs in react-query. Local state belongs in `useState`. Cross-page state goes in zustand.

## Live video

Three players, each for a different surface:

| Component | Where used | Transport |
|---|---|---|
| [DirectStreamPlayer](../src/components/DirectStreamPlayer.jsx) | Live View single / Live View grid, AI Feed thumbnails | WebRTC (WHEP) first → HLS via hls.js fallback; shared streamCache across mounts |
| [WebRTCStream](../src/components/WebRTCStream.jsx) | Footfall preview (inline tile + modal) | Pure WHEP, no fallback, focused on low latency |
| `<img>` MJPEG | Footfall fallback when WebRTC fails for >6 s | Pulls from `/api/cameras/<id>/mjpeg` |

[services/streamCache.js](../src/services/streamCache.js) shares HLS.js instances across mounts so flipping between cameras is instant (no re-buffer).

### Stream quality (Auto / Main / Sub)

Each camera has a backend stream variant: **main** (full-res), the camera's native **sub** (low-res, much lighter), and **auto** (ABR master). The frontend chooses per surface:

- **Grid tiles** default to the **sub** stream — a wall pulls many cameras at once and full-res would saturate the NVR/uplink. `GridTile` passes `quality={playerQuality(camera, 'low')}`.
- **Single / expanded view** defaults to **main** and shows a **quality gear** (top-right, `qualityControl` prop) so the operator can switch Auto/High/Low live; picking one re-acquires the stream (`activeQuality` is in the effect deps; `'low'` forces HLS since the sub is an HLS path).
- A **saved per-camera default** (`camera.streamQuality` = `auto`/`main`/`sub`, set in Camera Setup) overrides the surface default. `playerQuality(camera, dflt)` in [LiveView.jsx](../src/pages/LiveView.jsx) maps it to the player's `quality` prop (`sub→low`, `main→high`, `auto→auto`, null→`dflt`).

`DirectStreamPlayer`'s `quality` prop is `'auto' | 'high' (main) | 'low' (sub)`. The backend `GET /api/stream/start/:id?quality=` returns `hlsUrl` (main), `hlsSubUrl` (native sub), and `webrtcUrl`; `pickHlsUrl` selects per quality, falling back to main if the sub manifest fails to warm.

## Camera Setup: per-camera / group / bulk settings

[CameraGroups.jsx](../src/pages/CameraGroups.jsx) (Camera Setup → Devices) edits two inheritable per-camera settings — **recording retention** (days) and **stream quality** (auto/main/sub). Both share one UI pattern worth reusing for future per-camera config:

- **Inheritance**: `Camera → Group → (Site) → global default`. A camera value of `null` inherits the group; a group `null` inherits the site/global.
- **Three scopes**, all `POST /api/groups/:groupId/...`:
  - per-group default — in the device's expanded "defaults" box,
  - per-camera override — a pill on each `CameraRow`,
  - **bulk** — checkbox-select cameras (state is a `Set` of monitorIds in `GroupCard`) → an action bar applies to all selected in one request.
- **Controls**: a shadcn `<Select>` pill (`RetentionEditor` / `QualitySelect`) showing the effective value, colour-coded (accent when overridden, muted when inherited). Picking a value **auto-saves** via a mutation hook (no separate Save button).
- **Hooks** ([useQueries.js](../src/hooks/useQueries.js)): `useSet{Group,Camera}Retention` + `useSetCamerasRetentionBulk`, and `useSet{Group,Camera}Quality` + `useSetCamerasQualityBulk` — each invalidates `queryKeys.groups`.

Retention is enforced server-side (MediaMTX `recordDeleteAfter` + a backend reconcile loop); quality is read by the players (see *Stream quality* above).

## Real-time data

[services/socket.js](../src/services/socket.js) exposes:
- `connectSocket()` — idempotent boot
- `on(event, handler)` — returns an unsubscribe function (for `useEffect` cleanup)
- `disconnectSocket()` on logout

Pages that need a live ticker (Alerts, AI Feed, Dashboard) subscribe via the `on()` helper.

## shadcn/ui usage

Components live in [components/ui/](../src/components/ui/). All copy-paste from the registry, so we own the source. Available now:
`avatar`, `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `progress`, `select`, `separator`, `table`, `tabs`, `tooltip`.

**Adding a new one**:
```sh
docker exec -it smart-cam-app sh -lc "npx shadcn@latest add <name>"
```
or run from the host inside `smart-cam-app/`.

Conventions:
- Don't deep-import — use named imports from `'@/components/ui/<name>'`.
- Don't fork the source unless you must; if you must, leave a `// FORK: <reason>` comment.
- Composition over prop-drilling. `<Card><CardHeader><CardTitle>…` always.

## Tailwind tokens

Brand orange: `#F7983A`. Used for primary CTAs, accents, the AI Intelligence sidebar group.

Status colour conventions:
- Emerald — counting, live, ok
- Slate — neutral, "out" direction, idle camera
- Amber — warning, reconnecting, missing config
- Rose — critical, watchlist alert, offline
- Sky — info, snapshot/MJPEG fallback mode

Typography:
- Headlines `font-bold text-slate-950`
- Sub-text `text-slate-500`
- Tabular numbers `tabular-nums` for any counter (avoids 1 ≠ 0 column jitter)

## Tabs / Dialog patterns

When you have one Trigger and one panel, prefer state-controlled:
```jsx
<Tabs value={tab} onValueChange={setTab}>
  <TabsList>…</TabsList>
  <TabsContent value="…">…</TabsContent>
</Tabs>
```

Don't reach into the DOM with `document.querySelector('[value="x"]').click()` — it works until shadcn changes the data attributes. Use the state-controlled form.

## Performance rules

- **Lazy-load every page** — `lazy(() => import(...))` in App.jsx
- **Memoize derived data** that depends on large arrays — `useMemo(() => list.filter(...), [list, q])`
- **Don't poll faster than 1 s** — server bandwidth + GC pressure. Live overlays poll at 1 s, KPIs at 2 s, charts at 60 s
- **Keys must be unique within `.map()`** — composite (`${id}-${i}`) when raw `id` can collide. The TrendChart had a real bug because `[0,1,1]` ticks collided on `1`

## Where things connect

```
Auth
  Login.jsx → authStore.login(email, pw) → POST /api/auth/login → cookie + access JWT in memory
                                                                       ↓
                                                              useAuthStore (zustand)
                                                                       ↓
                                                  ProtectedRoute reads, redirects on absence

Camera state
  Camera Setup creates a Camera → POST /api/groups/:id/cameras → emits camera.created via WS
                                                                          ↓
                                                              useGroups() invalidated
                                                                          ↓
                                                      Sidebar + LiveView re-render

AI events
  smart-cam-ai detects a face → POST /api/internal/ai/events → AIEvent.create → WS ai.event
                                                                                       ↓
                                                            Alerts.jsx listens, prepends to its list
```
