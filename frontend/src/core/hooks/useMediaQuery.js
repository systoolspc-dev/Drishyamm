import { useSyncExternalStore } from 'react';

// Subscribes to a CSS media query from JS. `useSyncExternalStore` is the right
// primitive here: it reads the current match during render (no first-paint
// flash at the wrong breakpoint) and keeps SSR/hydration honest via the third
// argument, which a useState+useEffect version cannot do.
//
// Prefer plain Tailwind breakpoints for anything CSS can express on its own.
// Reach for this only when layout STATE depends on width — e.g. the shell has
// to decide whether the nav is a fixed rail or an overlay drawer, which
// changes behaviour and markup, not just styling.
export function useMediaQuery(query) {
  const subscribe = (onChange) => {
    if (typeof window === 'undefined' || !window.matchMedia) return () => {};
    const mql = window.matchMedia(query);
    // Safari < 14 only has the deprecated addListener.
    if (mql.addEventListener) {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  };

  const getSnapshot = () =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false;

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// Shared breakpoints, named once so the components that branch on them cannot
// drift apart. They mirror Tailwind's `sm`, `md`, `lg` and `xl`.
export const BELOW_SM = '(max-width: 639.98px)';
export const BELOW_MD = '(max-width: 767.98px)';
export const BELOW_LG = '(max-width: 1023.98px)';
export const BELOW_XL = '(max-width: 1279.98px)';

export default useMediaQuery;
