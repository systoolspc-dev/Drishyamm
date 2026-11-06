// Runtime accounting for concurrent live pulls.
//
// docs/phase-1-plan.md T7 asks that the stream budget be "measured, not
// assumed". Reasoning about it per screen is not enough: the dangerous moment
// is the TRANSITION — Home releasing four tiles while the Live tab arms its
// hero, or a tab left mounted that never tore down. Those windows are invisible
// in code review and only show up as cameras dropping for every client.
//
// So each tile registers its pull here. The moment the ceiling is crossed the
// log names every holder, which turns "did we exceed it?" into something you
// read off the console instead of arguing about.
//
// WHAT IS COUNTED: distinct camera paths, not players. MediaMTX pulls a path
// from the recorder ONCE and fans it out to readers, so two tiles showing the
// same camera are one pull as far as the NVR is concerned — and the NVR is what
// MAX_CONCURRENT_STREAMS protects. Hence the refcount.
import { MAX_CONCURRENT_STREAMS } from './config';
import { warn, log } from './log';

/** monitorId -> { label, refs } */
const active = new Map();
let peak = 0;

export function acquireStream(id, label) {
  if (id == null) return;
  const key = String(id);
  const entry = active.get(key);
  if (entry) { entry.refs += 1; return; }

  active.set(key, { label: label || key, refs: 1 });

  if (active.size > peak) peak = active.size;
  if (active.size > MAX_CONCURRENT_STREAMS) {
    warn('budget', `${active.size} concurrent streams — over the ${MAX_CONCURRENT_STREAMS} ceiling`, {
      holders: [...active.values()].map((e) => e.label),
    });
  }
}

export function releaseStream(id) {
  if (id == null) return;
  const key = String(id);
  const entry = active.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) active.delete(key);
}

export const activeStreamCount = () => active.size;
export const activeStreams = () => [...active.values()].map((e) => e.label);

/** For a manual regression pass — call from a screen or the debugger. */
export function reportStreamBudget(where = 'now') {
  log('budget', `${where}: ${active.size}/${MAX_CONCURRENT_STREAMS} active (peak ${peak})`, {
    holders: activeStreams(),
  });
}
