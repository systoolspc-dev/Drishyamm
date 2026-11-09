// Keep the cameras this user is looking at warm while the app is open (see
// backend services/streamWarm.service.js). One heartbeat on load and every
// HEARTBEAT_MS while the tab is visible, carrying the monitorIds on screen
// plus the next page (setWarmHints); the backend's lease (3 min) lapses on its
// own when every tab is closed or hidden, and the streams idle out.
//
// The on-screen set is remembered, so the FIRST beat of the next visit warms
// the page the user will see again — before its tiles have even mounted.
//
// Module-level so the many ProtectedRoute mounts share ONE timer.
import { useEffect } from 'react';
import api from '@/core/services/api';
import { viewedIds } from '@/core/services/liveRelay';
import { canDecodeHevc } from '@/core/services/codecSupport';

const HEARTBEAT_MS = 60_000;
const LAST_KEY = 'streamWarm.lastViewed';
let timer = null;
let users = 0;
let hints = [];
let hintTimer = null;

function lastViewed() {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || '[]'); } catch { return []; }
}

function beat() {
  if (typeof document !== 'undefined' && document.hidden) return;
  const viewing = viewedIds();
  if (viewing.length) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(viewing.slice(0, 18))); } catch { /* storage off */ }
  }
  const ids = [...new Set([...(viewing.length ? viewing : lastViewed()), ...hints])].slice(0, 18);
  api.post('/stream/warm', { monitorIds: ids.length ? ids : undefined, hevc: canDecodeHevc() })
    .catch(() => { /* best effort: tiles still start on demand */ });
}

function onVisible() { if (!document.hidden) beat(); }

/**
 * Cameras the user is likely to open next (the next grid page). Sent with the
 * next heartbeat — debounced, so flipping through pages doesn't spam.
 */
export function setWarmHints(monitorIds) {
  hints = (monitorIds || []).slice(0, 9);
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(beat, 1500);
}

export function useStreamPrewarm(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    if (users++ === 0) {
      beat();
      timer = setInterval(beat, HEARTBEAT_MS);
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      if (--users === 0) {
        clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [enabled]);
}
