/**
 * Live detections for one zone, classified against its access rules.
 *
 * Source is the AI service's own per-camera detection feed —
 * `GET {AI_BASE}/api/detections/{monitorId}` — the same one the AI Feed page
 * draws its boxes from. Each box carries the name the recogniser put on it, so
 * "authorised" is a real lookup against the zone's whitelist rather than a
 * decoration.
 *
 * Polled at 1s, matching the rate the service produces frames at. Faster would
 * return the same frame twice; slower would let someone cross a small room
 * between samples.
 *
 * Only the current frame is kept. The record of breaches over time is the
 * Breaches page's job; this feeds the Live canvas, which judges what is in
 * view right now.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AI_BASE } from '@/core/config/endpoints';
import { classifyFrame } from './access-data';

const POLL_MS = 1_000;

export function useZoneDetections({ monitorId, polygon, access, enabled = true }) {
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(null);

  // The classifier inputs change as the operator edits the form, and the poll
  // closure must see the current ones without being torn down and rebuilt on
  // every keystroke.
  const cfg = useRef({ polygon, access });
  // Written after render, not during it: the poll closure only reads this on
  // its next tick, so an effect with no dependency list is both correct and
  // the only form that does not touch a ref mid-render.
  useEffect(() => {
    cfg.current = { polygon, access };
  });

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${AI_BASE}/api/detections/${encodeURIComponent(monitorId)}`);
      const raw = await r.json();
      const { polygon: poly, access: acc } = cfg.current;
      const next = classifyFrame({ detections: raw, polygon: poly, access: acc });
      setRunning(raw?.running === true);
      setFrame(next);
      setError(null);
    } catch {
      setError('The detection feed is not responding for this camera.');
      setFrame(null);
    }
  }, [monitorId]);

  useEffect(() => {
    // Guarded here rather than inside `poll`, so the hook never writes state
    // synchronously while an effect is running -- with no camera there is
    // simply nothing to poll, and the return below reports no frame.
    if (!enabled || !monitorId) return undefined;
    // A false positive: `poll` is async and its first statement is an await, so
    // every setState inside it lands in a later microtask, not in this effect.
    // Waiting for the first interval tick instead would leave the panel blank
    // for a second on every camera change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, monitorId, poll]);

  return {
    // Derived rather than cleared: with no camera selected the last frame is
    // stale by definition, and reporting null is cheaper and safer than a
    // second effect racing to blank it.
    frame: monitorId ? frame : null,
    error,
    running,
    refresh: poll,
  };
}
