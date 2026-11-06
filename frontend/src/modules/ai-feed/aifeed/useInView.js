import { useEffect, useState } from 'react';

/**
 * True while the element is within `margin` of the viewport. The camera grid
 * uses it to mount a tile's player only when the tile can be seen: a page
 * of thirty cameras must not open thirty pulls on the NVR at once, and the
 * ones scrolled off-screen would be decoding for nobody.
 *
 * Sticky once true for `linger` ms after leaving, so a tile that scrolls out
 * and straight back in does not tear down and re-negotiate its stream.
 */
export function useInView(ref, { margin = '240px', linger = 8000 } = {}) {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      const id = setTimeout(() => setInView(true), 0);
      return () => clearTimeout(id);
    }
    let leaveTimer = null;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        clearTimeout(leaveTimer);
        setInView(true);
      } else {
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => setInView(false), linger);
      }
    }, { rootMargin: margin });
    io.observe(el);
    return () => {
      clearTimeout(leaveTimer);
      io.disconnect();
    };
  }, [ref, margin, linger]);

  return inView;
}
