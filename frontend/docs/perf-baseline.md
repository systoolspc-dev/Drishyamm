# Drishyam — Performance Baseline

> Measured baseline for the frontend optimisation work in `OPTIMIZATION_PROMPTS.md`.
> Every later prompt proves improvement against these numbers. **Re-measure and
> update this file if the branch moves materially.**
>
> All figures below are from a real production build. No estimates, no placeholders.

---

## How this was measured

| | |
|---|---|
| Date | 2026-08-13 |
| Branch | `ASTHA_activity_monitoring` |
| Commit at measurement | `c7e852c` + uncommitted Zone Headcount work |
| Node | v24.15.0 |
| Vite | 7.3.1 |
| Tooling added | `rollup-plugin-visualizer` 7.0.1 · `vite-plugin-compression2` 2.5.3 · `cross-env` 10.1.0 |

```bash
npm run build      # production build, emits .gz + .br siblings
npm run analyze    # ANALYZE=1 → also emits dist/stats.html treemap
```

`npm run analyze` is `cross-env ANALYZE=1 vite build`, so it works identically in
PowerShell, cmd and bash. The visualizer is gated behind `ANALYZE=1` so a normal
build never pays for walking the module graph twice.

**Compression covers text assets only** — 232 `.js`, 4 `.css`, 2 `.svg`, 2 `.html`.
Images are correctly skipped (a `.png.gz` would be pure waste). Original assets
are always kept; nothing is replaced.

---

## 1 · Totals

| Metric | Value |
|---|---|
| `dist/` total, raw | **18.20 MB** across **256** assets |
| `dist/` text assets, gzip | **1.20 MB** (240 files) |
| `dist/` text assets, brotli | **1.03 MB** (244 files) |
| Modules in the bundle graph | 3,338 |

Raw total is dominated by images, not code — see §3.

### First-paint budget — the number that actually matters

Everything else is lazy-loaded. What every user downloads before the app renders:

| Asset | Raw | Gzip | Brotli |
|---|---:|---:|---:|
| `index-*.js` (entry chunk) | 554,981 | 177,084 | 152,095 |
| `index-*.css` (global) | 566,571 | 78,704 | 60,398 |
| **First-paint total** | **1,121,552** | **249,782** (243.9 KB) | **207,493** (202.6 KB) |

**249.8 KB gzip / 207.5 KB brotli on first paint.** This is the primary regression
gate. Raw byte counts are noise — no client receives them uncompressed.

---

## 2 · JS / CSS chunks over 50 KB

Sorted by raw size. Gzip is the column to judge against.

| Chunk | Raw | Gzip | Brotli | Gzip ratio |
|---|---:|---:|---:|---:|
| `index-*.css` (global, every route) | 566,571 | 78,704 | 60,398 | 7.2× |
| `index-*.js` (entry) | 554,981 | 177,084 | 152,095 | 3.1× |
| `DirectStreamPlayer-*.js` | 541,416 | 167,929 | 138,376 | 3.2× |
| `CategoricalChart-*.js` (recharts) | 292,621 | 91,019 | 77,161 | 3.2× |
| `AdminApp-*.js` | 171,482 | 37,681 | 30,604 | 4.6× |
| `leaflet-*.js` | 153,344 | 44,486 | 38,789 | 3.4× |
| `ActivityDashboard-*.js` | 130,891 | 21,469 | 18,113 | 6.1× |
| `proxy-*.js` | 122,660 | 39,948 | 35,817 | 3.1× |
| `CameraSetup-*.js` | 111,004 | 24,881 | 21,011 | 4.5× |
| `FaceWatchListRouter-*.js` | 93,965 | 20,285 | 17,264 | 4.6× |
| `WeaponRouter-*.js` | 71,343 | 18,710 | 16,248 | 3.8× |
| `Playback-*.js` | 65,502 | 15,726 | 13,813 | 4.2× |
| `AiFeed-*.js` | 62,083 | 16,870 | 14,845 | 3.7× |
| `Map-*.js` | 56,671 | 15,310 | 13,708 | 3.7× |

Note the CSS ratio: **7.2×** is the signature of a large amount of unused,
highly repetitive utility CSS. It compresses beautifully and still costs 78.7 KB
on every single route.

---

## 3 · Images over 100 KB

| Asset | Bytes | MB |
|---|---:|---:|
| `ANPR FOOTAGE PICTURE 1-*.png` | 3,021,159 | 2.88 |
| `ANPR FOOTAGE PICTURE 4-*.png` | 2,885,609 | 2.75 |
| `ANPR FOOTAGE PICTURE 2-*.png` | 2,744,560 | 2.62 |
| `ANPR FOOTAGE PICTURE 5-*.png` | 2,677,420 | 2.55 |
| `ANPR FOOTAGE PICTURE 3-*.png` | 2,667,305 | 2.54 |
| `fireimage3-*.png` | 288,683 | 0.28 |
| `fireimage1-*.png` | 114,849 | 0.11 |

**10 raster files total 13.89 MB — 76% of the entire `dist/`.** Five demo
screenshots account for 13.996 MB of that. These are PNGs of what is fundamentally
photographic content, shipped at full resolution to demonstrate a feature.

This is the single largest and cheapest win in the whole optimisation programme,
and it needs no code change — only re-encoding and responsive sizing.

---

## 4 · Heaviest `node_modules` packages

From `dist/stats.html`, aggregated across all chunks.

> **Read these as a ranking, not as transfer bytes.** The visualizer reports
> *rendered* size (post-tree-shake, **pre-minify**), so absolute numbers run
> higher than the emitted chunks in §2. The share column is the useful signal.

| # | Package | Rendered | Gzip | Modules | Share of gzip JS |
|---:|---|---:|---:|---:|---:|
| 1 | `hls.js` | 1,303,243 | 301,202 | 1 | 14.1% |
| 2 | `recharts` | 742,594 | 230,984 | 207 | 10.8% |
| 3 | `leaflet` | 474,319 | 112,542 | 4 | 5.3% |
| 4 | `react-dom` | 561,395 | 98,167 | 10 | 4.6% |
| 5 | `motion-dom` | 290,107 | 94,441 | 177 | 4.4% |
| 6 | `lucide-react` | 127,190 | 78,013 | 241 | 3.7% |
| 7 | `axios` | 103,547 | 37,247 | 50 | 1.7% |
| 8 | `framer-motion` | 100,704 | 33,971 | 61 | 1.6% |
| 9 | `es-toolkit` | 58,807 | 23,945 | 50 | 1.1% |
| 10 | `leaflet.markercluster` | 85,843 | 21,023 | 5 | 1.0% |
| 11 | `react-router` | 80,841 | 19,774 | 1 | 0.9% |
| 12 | `@tanstack/query-core` | 74,212 | 19,422 | 17 | 0.9% |
| 13 | `tailwind-merge` | 94,161 | 15,907 | 1 | 0.7% |
| 14 | `engine.io-client` | 52,600 | 15,538 | 12 | 0.7% |
| 15 | `@reduxjs/toolkit` | 54,575 | 13,941 | 2 | 0.7% |

| Split | Gzip | Share |
|---|---:|---:|
| Application code (`src/`) | 821,351 | 38.5% |
| Vendor (`node_modules`) | 1,311,627 | **61.5%** |
| Total JS | 2,132,978 | 100% |

---

## 5 · Findings worth acting on

Recorded here because they fell out of the measurement, not because Prompt 0
asked for them. Each needs its own prompt/PR.

**a. Three declared dependencies contribute zero modules to the bundle.**
`livekit-client`, `date-fns` and `shadcn` appear in `package.json` but have
**0 modules in the graph and 0 `import` statements under `src/`.**
Be precise about the value: they are already tree-shaken out, so removing them
**does not shrink `dist/` by a single byte.** The win is install time, lockfile
size, audit surface and reviewer confusion — hygiene, not performance.
`livekit-client` in particular is worth confirming with whoever owns
`DirectStreamPlayer` before removal, in case a runtime path is planned.

**b. `@reduxjs/toolkit` is in the bundle but is not a declared dependency.**
It appears at #15 with 13.9 KB gzip and is not in `package.json` — it arrives
transitively. Worth tracing which package pulls it in.

**c. The global CSS is the best raw-byte target after images.** 566 KB raw for
78.7 KB gzip on every route. `src/ai-analytics/analytics.css` alone is 444,556 B
across 13,931 lines and is scoped to `.ai-analytics-scope`, yet loads globally.

**d. `hls.js` at 14.1% is the largest single vendor cost** and lives in
`DirectStreamPlayer` (541 KB raw / 167.9 KB gzip). It is already route-split, so
the question is whether it can be deferred to actual playback rather than route
entry.

---

## 6 · Lint status at baseline

`npm run lint` **does not pass on this branch and did not before this change.**
Recorded honestly so later prompts are not blamed for it.

| State | Problems | Errors | Warnings |
|---|---:|---:|---:|
| Before this change | 217 | 193 | 24 |
| After this change | **216** | **192** | 24 |

Net **−1**. The measurement tooling introduced no new lint problems and fixed one
pre-existing error: `vite.config.js` used `__dirname` (and now `process.env`)
under browser-only globals. `eslint.config.js` gained a Node-globals override
scoped to config files only, so a stray `process.env` inside a component still
errors as it should.

The remaining 192 errors span **91 files**, concentrated in `src/admin/` and
`src/ai-analytics/`. Cleaning them is its own prompt and out of scope here.

---

## 7 · Acceptance evidence for Prompt 0

| Criterion | Result |
|---|---|
| `npm run build` output byte-identical for all application chunks | ✅ **256/256 files, identical md5.** Verified by hashing every `dist/` file before and after wiring the plugins and diffing; only new `.gz`/`.br` siblings were added. |
| `npm run analyze` produces `dist/stats.html` | ✅ 1,557,438 bytes, treemap with gzip + brotli enabled |
| `perf-baseline.md` contains real numbers | ✅ this file |
| `npm run lint` passes | ⚠️ **Cannot pass — 216 pre-existing problems across 91 files, unrelated to this change.** Net effect of this change is −1 problem. See §6. |
| Existing `base`, `esbuild.pure`, alias, `server.watch.ignored` preserved | ✅ untouched, including the deployment and WSL2 comments explaining them |
| `dist/` stays out of git | ✅ already in `.gitignore:11` |

---

## 8 · Change log against this baseline

Every entry must state whether the §1–§4 numbers above are still valid.

| Prompt | Change | Effect on baseline |
|---|---|---|
| **P1 · Dead asset removal** | Deleted 12 unreferenced binaries from `src/` (10 × `FACE WATCHLIST *.png`, `hero.png`, `assets/logo.png`) — 27,020,085 bytes. `src/` 45 MB → 19 MB. | **Baseline unchanged and still valid.** `dist/` remained byte-identical (256/256 files, same md5, 18.20 MB) — which is the proof the files were dead. Lint unchanged at 216. Repo/clone/CI cost only. |
| **P2 · Image conversion** | 9 live PNGs → WebP q82 (5 ANPR stills capped at the stage box, 4 fire stills at intrinsic size), kebab-case filenames, `loading`/`decoding`/`width`/`height` on the 5 consuming `<img>` tags. | **§1 and §3 are now SUPERSEDED.** `dist/` **18.20 MB → 5.05 MB** (−72.3%), still 256 assets. Largest image 3,021,159 B → **152,680 B**. §3's image table no longer describes the build. §2 (JS/CSS chunks) and §4 (packages) are **unaffected** — no JS changed. Lint unchanged at 216. |
| **P3 · Analytics CSS route-split** | Both AI-analytics stylesheets moved out of the `App.jsx` entry into a lazy `AnalyticsScope.jsx` boundary. | **§2's CSS row and the first-paint table are SUPERSEDED.** `index-*.css` **565,790 → 194,669 B** raw (−65.6%), gzip **78,704 → 27,127 B** (−65.5%). New `AnalyticsScope-*.css` chunk (371,903 B) loads only on `/ai-analytics/*`. **First paint 249,782 → 204,246 B gzip** (−18.2%). JS chunks and §4 packages unaffected. Lint unchanged at 216. |
