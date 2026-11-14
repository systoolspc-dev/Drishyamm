import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { visualizer } from 'rollup-plugin-visualizer'
import { compression } from 'vite-plugin-compression2'
import path from 'path'

export default defineConfig(({ mode }) => ({
  // In production we deploy alongside a static marketing site at the same host.
  // The marketing site already owns `/` and `/assets/*`, so we scope the SPA's
  // built JS/CSS under `/d-app/` to avoid colliding. React Router routes are
  // unaffected — that's controlled by `basename`, which we leave at `/` so
  // operator routes like `/login` stay root-relative.
  base: mode === 'production' ? '/d-app/' : '/',
  // Strip debug logging from PRODUCTION bundles only. `pure` marks these calls
  // side-effect-free so minification drops them; console.error/console.warn are
  // deliberately kept (operators/support need them). Dev builds are untouched.
  esbuild: mode === 'production'
    ? { pure: ['console.log', 'console.debug', 'console.info'], drop: ['debugger'] }
    : {},
  plugins: [
    react(),
    tailwindcss(),
    // ── Measurement tooling ──────────────────────────────────────────────
    // Neither plugin touches application code: compression only WRITES extra
    // .gz/.br siblings next to the emitted assets, and visualizer only READS
    // the bundle graph. Build output for app chunks stays byte-identical.

    // Transfer-size reporting. Raw bytes lie — every real client gets these
    // over gzip or brotli, so budgets are set against the compressed size.
    // Production only; dev builds are untouched.
    ...(mode === 'production'
      ? [
          compression({ algorithms: ['gzip'], deleteOriginalAssets: false }),
          compression({ algorithms: ['brotliCompress'], deleteOriginalAssets: false }),
        ]
      : []),

    // Treemap of what is actually in each chunk. Gated behind ANALYZE=1 so a
    // normal `npm run build` never pays the cost of walking the module graph
    // twice — run `npm run analyze` when you need the report.
    ...(process.env.ANALYZE === '1'
      ? [
          visualizer({
            filename: 'dist/stats.html',
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
            emitFile: false,
          }),
        ]
      : []),
  ],
  build: {
    rollupOptions: {
      output: {
        // ── Vendor splitting ────────────────────────────────────────────────
        // Without this every shared dependency lands in the entry chunk, so a
        // one-line page edit invalidates React for every operator on next
        // deploy. Grouping by library gives each group a stable content hash
        // that survives application changes.
        //
        // React and everything that reaches into its internals MUST stay in one
        // chunk. Two copies of React means two dispatcher instances and hooks
        // throw at runtime — scheduler and react-router are grouped here for
        // exactly that reason, not for size.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          const p = id.replace(/\\/g, '/').split('node_modules/').pop();

          if (/^(react|react-dom|scheduler|react-router|react-router-dom)\//.test(p)) return 'react-vendor';

          // A GROUP IS ONLY AS LAZY AS ITS MOST EAGER MEMBER. Rollup must load a
          // whole chunk if any single module in it is statically reachable from
          // the entry, so one eager utility drags megabytes of lazy library into
          // first paint. Two traps hit here and both are deliberately avoided:
          //
          //  - socket.io-client is NOT in `media`. AIToastHost is a static import
          //    in App.jsx and reaches socket.io, so grouping it with hls.js and
          //    livekit-client made the browser eagerly preload 173 KB gzip of
          //    video machinery on /login. socket.io stays ungrouped.
          //  - eventemitter3 and fast-equals are NOT in `charts`. They are shared
          //    utilities, not recharts-only, and pulled the chart group eager the
          //    same way.
          // Verify after any edit here: dist/index.html must contain modulepreload
          // links for react-vendor and ui-vendor ONLY.
          if (/^(recharts)\//.test(p)) return 'charts';
          if (/^(hls\.js|livekit-client)\//.test(p)) return 'media';
          if (/^(leaflet|react-leaflet|leaflet\.markercluster|@react-leaflet)\//.test(p)) return 'maps';
          // lucide-react is tree-shaken per icon, so grouping it looks wrong at
          // first glance. Measured both ways: grouped is smaller on every axis
          // (entry −8.8 KB gzip, total JS −28.3 KB gzip, 140 chunks vs 228).
          // Ungrouped, the same icons get re-emitted into many route chunks;
          // one shared chunk deduplicates them and is cached once.
          if (/^(radix-ui|@radix-ui|framer-motion|motion-dom|motion-utils|lucide-react)\//.test(p)) return 'ui-vendor';

          return undefined; // everything else stays in its route chunk
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Vite 7 answers only localhost by default. Hosts that reach the dev server
    // through a proxy (the testing server's Tailscale name) are listed in
    // VITE_ALLOWED_HOSTS, comma separated. See deploy/testing/.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
      : [],
    watch: {
      // Polling is enabled via CHOKIDAR_USEPOLLING in Docker on Windows so Vite
      // sees host edits. Without an ignore list the watcher stat()s every file
      // under the project root on every interval — including the 475 MB of demo
      // MP4s in public/demos/ and the multi-GB mediamtx-recordings tree. That
      // sustained I/O over WSL2's 9P bind mount destabilises the VM. Excluding
      // heavy paths keeps reload fast and the WSL kernel happy.
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/public/demos/**',
      ],
    },
  },
}))
