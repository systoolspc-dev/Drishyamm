import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useDigitalZoom — drop-in CSS-transform-based zoom + pan for any element.
 *
 * Returns a `bind` object the caller spreads onto the element they want
 * zoomable, plus the current `transform` string and helpers.
 *
 * Behaviour matches what operators expect from Verkada / Avigilon:
 *   - Mouse wheel zooms in/out (toward the cursor).
 *   - Click-drag pans when zoomed > 1.
 *   - Two-finger pinch zooms on touch devices.
 *   - One-finger drag pans on touch when zoomed.
 *   - Double-click / double-tap resets to 1×.
 *   - Pan is clamped so you can't drag past the original frame edges.
 *
 * Usage:
 *   const { bind, transform, zoom, reset } = useDigitalZoom();
 *   <div ref={bind.ref} {...bind.handlers} style={{ overflow: 'hidden' }}>
 *     <div style={{ transform, transformOrigin: 'center', willChange: 'transform' }}>
 *       <video ... />
 *     </div>
 *   </div>
 */
export function useDigitalZoom({ minZoom = 1, maxZoom = 8, wheelStep = 0.0025 } = {}) {
  const containerRef = useRef(null);

  const [zoom, setZoom] = useState(1);
  const [pan,  setPan]  = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Refs for in-flight gesture state (don't trigger re-renders on every move)
  const dragStart = useRef({ pointerId: null, x: 0, y: 0, panX: 0, panY: 0 });
  const pinchStart = useRef({ dist: 0, zoom: 1 });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const clampPan = useCallback((next, currentZoom) => {
    const el = containerRef.current;
    if (!el) return next;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const maxX = ((currentZoom - 1) * w) / 2;
    const maxY = ((currentZoom - 1) * h) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const setZoomLevel = useCallback((target, focus) => {
    const next = Math.max(minZoom, Math.min(maxZoom, target));
    if (next === 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    setZoom((prevZoom) => {
      // Optional zoom-toward-cursor: keep the cursor's content point fixed.
      // focus = { dx, dy } in pixels relative to container center
      if (!focus) return next;
      const scale = next / prevZoom;
      setPan((prev) => clampPan({
        x: prev.x * scale - focus.dx * (scale - 1),
        y: prev.y * scale - focus.dy * (scale - 1),
      }, next));
      return next;
    });
  }, [clampPan, minZoom, maxZoom]);

  // ── Mouse / wheel handlers ─────────────────────────────────────────────────

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const focus = {
      dx: e.clientX - rect.left - rect.width / 2,
      dy: e.clientY - rect.top  - rect.height / 2,
    };
    // delta > 0 = scroll down = zoom out
    const delta = -e.deltaY * wheelStep;
    setZoomLevel(Math.exp(Math.log(zoom) + delta), focus);
  }, [zoom, wheelStep, setZoomLevel]);

  const onMouseDown = useCallback((e) => {
    if (zoom <= 1) return;
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = {
      pointerId: 'mouse',
      x: e.clientX, y: e.clientY,
      panX: pan.x, panY: pan.y,
    };
    e.preventDefault();
  }, [zoom, pan]);

  const onMouseMove = useCallback((e) => {
    if (!dragging || dragStart.current.pointerId !== 'mouse') return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan(clampPan({
      x: dragStart.current.panX + dx,
      y: dragStart.current.panY + dy,
    }, zoom));
  }, [dragging, zoom, clampPan]);

  const onMouseUp = useCallback(() => setDragging(false), []);

  const onDoubleClick = useCallback(() => reset(), [reset]);

  // ── Touch handlers ─────────────────────────────────────────────────────────

  const dist = (t0, t1) => Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);

  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 2) {
      pinchStart.current = {
        dist: dist(e.touches[0], e.touches[1]),
        zoom,
      };
      e.preventDefault();
    } else if (e.touches.length === 1 && zoom > 1) {
      setDragging(true);
      dragStart.current = {
        pointerId: 'touch',
        x: e.touches[0].clientX, y: e.touches[0].clientY,
        panX: pan.x, panY: pan.y,
      };
      e.preventDefault();
    }
  }, [zoom, pan]);

  const onTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && pinchStart.current.dist > 0) {
      const d = dist(e.touches[0], e.touches[1]);
      setZoomLevel(pinchStart.current.zoom * (d / pinchStart.current.dist));
      e.preventDefault();
    } else if (e.touches.length === 1 && dragging && dragStart.current.pointerId === 'touch') {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      setPan(clampPan({
        x: dragStart.current.panX + dx,
        y: dragStart.current.panY + dy,
      }, zoom));
      e.preventDefault();
    }
  }, [dragging, zoom, clampPan, setZoomLevel]);

  const onTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) pinchStart.current.dist = 0;
    if (e.touches.length === 0) setDragging(false);
  }, []);

  // ── Wheel listener with non-passive event ──────────────────────────────────
  // React's onWheel is passive by default, which prevents preventDefault().
  // We attach manually so the browser doesn't scroll the page when zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opts = { passive: false };
    const handler = (e) => onWheel(e);
    el.addEventListener('wheel', handler, opts);
    return () => el.removeEventListener('wheel', handler, opts);
  }, [onWheel]);

  // ── Pan re-clamp when zoom changes (e.g. via reset) ────────────────────────
  useEffect(() => {
    setPan((p) => clampPan(p, zoom));
  }, [zoom, clampPan]);

  const transform =
    zoom === 1 && pan.x === 0 && pan.y === 0
      ? 'none'
      : `translate(${pan.x.toFixed(1)}px, ${pan.y.toFixed(1)}px) scale(${zoom.toFixed(3)})`;

  return {
    zoom,
    pan,
    transform,
    dragging,
    reset,
    setZoom: setZoomLevel,
    isZoomed: zoom > 1.001,
    bind: {
      ref: containerRef,
      handlers: {
        onMouseDown,
        onMouseMove,
        onMouseUp,
        onMouseLeave: onMouseUp,
        onDoubleClick,
        onTouchStart,
        onTouchMove,
        onTouchEnd,
      },
    },
  };
}
