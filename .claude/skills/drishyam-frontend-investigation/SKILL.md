---
name: drishyam-frontend-investigation
description: Build the React UI for the Drishyam investigation toolkit — frontend/src/modules/investigation pages (Search, Case, Evidence, Ask), routing in App.jsx, sidebar nav, feature gating via entitlements.js, API calls through the backend, and playback additions (click to track, activity density bar, smart skim, add-to-case). Use for any frontend change for investigation features in the Drishyamm repo.
---

# Frontend: modules/investigation + playback additions

Root: `frontend/src/` (`@/` alias → `src/`, `frontend/vite.config.js:103`). Rules: hub skill `drishyam-investigation`.

## Page wiring (no per-module router; all by hand)
1. Page in `modules/investigation/` (e.g. `InvestigateSearch.jsx`, `CaseView.jsx`, `EvidenceVerify.jsx`).
   Name clash: `core/store/investigationStore.js` already exists (dashboard recents) — use `modules/investigation/store/…` or another name.
2. Route: lazy import at the top of `App.jsx` (e.g. JourneyMap `:35`) and a
   `<Route path="/investigate/..." element={<ProtectedRoute>{wrap(<Page/>)}</ProtectedRoute>}/>` (`wrap` at `:256`; examples `:333`, `:348`).
3. Nav: entry in `NAV_SECTIONS` in `core/layout/Sidebar.jsx:65` (`{ to, label, icon, feature | featureAny, hint }`, see person entries `:99-101`).
4. Gating: add the keys to `core/nav/entitlements.js` (`AI_KEYS` `:86`, opt-in handling mirroring backend `featureCatalog.js`)
   and `ROUTE_FEATURES` (`:100`); in components `makeEntitlement(useAuthStore(s => s.user)).has('investigate_search')`
   (pattern `core/pages/Playback.jsx:49`). `ProtectedRoute.jsx:58` redirects disallowed routes.

## API
- Always via `core/services/api.js` (axios, `/api` base, Bearer token, refresh on 401) → backend `/api/investigate/*`.
  Put calls in `core/services/investigate.js` (pattern `core/services/personTracker.js`).
- **Don't copy** `modules/person-tracking/JourneyMap.jsx:177`, which fetches the AI `/journey/map` directly without auth.
- Signed thumbnail/clip URLs come from the backend; never build MinIO URLs in the browser.

## Features → UI touch points
- I-2 Search: filters + sentence box; parsed filters shown as **editable chips**; filters in the URL (shareable); photo search
  (existing `PersonTracker.jsx` flow) as a third input; results grouped by person; actions Play / Track / Add to case.
  Night tracks: show "colour not available (night)".
- I-3 Click to track: on playback video, map click (x,y normalised 0–1000) + ts → `/api/investigate/track-at` → journey view
  (reuse `modules/person-tracking/` journey components; confirm/reject per sighting).
- I-6: density bar + "play only activity" on `core/pages/NvrPlayback.jsx` / `CloudPlayback.jsx`; `Playback.jsx` is just tabs.
- I-4/I-5: "Add to case" next to `core/pages/playback/ClipExport.jsx` (presentational, props `id, range, onChange, playhead,
  canExport, onExport, …`); export requires a free-text reason.
- No i18n library exists; Hindi only matters for search input parsing (server side). Keep UI strings English unless asked.

## Tests and build
- `cd frontend && npm test` (Node built-in runner: `node --test "src/**/*.test.js"`, `node:test` + `node:assert/strict`; pure logic only,
  e.g. `modules/person-tracking/journey/journey-model.test.js`). Put URL-filter (de)serialisation, chip parsing, timeline bucketing in
  pure modules with tests.
- `npm run build` must pass. Dev server is the `drishyam-app` container on :5173 (Vite HMR).
- Check in the real app (skill `run` / browser) with the feature key both on and off for the account.
