import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/core/ui/tooltip';
import { ThemeProvider } from '@/core/context/ThemeContext';
// Self-hosted type (Inter + JetBrains Mono), bundled so on-prem and air-gapped
// sites never fall back to Segoe UI. The stack itself lives in index.css @theme.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import App from './App.jsx';

// Reveal Material Symbols once the icon font is ready (the analytics scope keeps
// them visibility:hidden until then to avoid a flash of ligature text). A short
// fallback guarantees icons never stay hidden if fonts.ready is slow/unsupported.
(() => {
  const ready = () => document.documentElement.classList.add('icons-ready');
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(ready).catch(ready);
    setTimeout(ready, 1500);
  } else {
    ready();
  }
})();

// App scale (see "App scale" in index.css). The CSS assumes the standard zoom
// behaviour — viewport units shrink with the zoom — and compensates by 1/zoom.
// Measure what this engine actually does and correct the factor if it differs,
// so full-height layouts neither stop short nor overflow. Re-measured when the
// zoom changes, which only happens at the lg breakpoint.
(() => {
  const root = document.documentElement;
  const measure = () => {
    root.style.removeProperty('--app-vunit-fix');
    const zoom = parseFloat(getComputedStyle(root).getPropertyValue('--app-zoom')) || 1;
    if (zoom === 1) return;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const ratio = probe.getBoundingClientRect().height / window.innerHeight;
    probe.remove();
    if (ratio > 0 && Math.abs(ratio - zoom) > 0.02) root.style.setProperty('--app-vunit-fix', String(1 / ratio));
  };
  measure();
  window.matchMedia('(width >= 64rem)').addEventListener('change', measure);
})();

// Cache layer — tuned so navigating between pages feels instant.
//
// staleTime 60s → if you visit Cameras, then Playback, then back to Cameras
// within a minute, no refetch happens; React Query just hands you the cached
// data immediately. Per-query overrides (e.g. live data with shorter staleTime
// in useQueries.js / useDashboardStats.js) still win where freshness matters.
//
// gcTime 10m → cached data stays in memory for 10 minutes after no component
// is observing it, so deep navigations (Settings → Help → Settings) are also
// instant.
//
// refetchOnReconnect 'always' → if the laptop wakes from sleep or wifi flips,
// pull fresh data once (one-shot, not on every focus).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
      staleTime: 60_000,
      gcTime:    10 * 60_000,
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
);
