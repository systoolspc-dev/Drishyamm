import { useSyncExternalStore } from 'react';

// Which navigation icon set is showing: 'lucide' (the stock glyphs), or
// Drishyam's own set in its 'line' or 'duotone' style. The source of truth is
// `data-icons` on <html>, which the Design test panel (core/layout/FontLab.jsx)
// writes and index.html restores before first paint. Watching the attribute
// rather than holding React state means any component can read it with no
// provider, and a change re-renders exactly the readers.
//
// Only the lucide-vs-Drishyam choice needs React; line vs duotone is pure CSS
// (see `--di-tint` / `--di-dot` in index.css).

export const ICON_SETS = ['duotone', 'line', 'lucide'];
export const DEFAULT_ICON_SET = 'lucide';

function subscribe(onChange) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-icons'] });
  return () => observer.disconnect();
}

function read() {
  const value = document.documentElement.dataset.icons;
  return ICON_SETS.includes(value) ? value : DEFAULT_ICON_SET;
}

export function useIconSet() {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_ICON_SET);
}
