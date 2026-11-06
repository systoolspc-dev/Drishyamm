
import { useEffect, useRef, useState } from 'react';

// In/out attendance from the EXISTING AI Feed pipeline: the live recognized
// detections (track_id + name) + a drawn 'line' detection-zone with a `side`.
// A person's feet point crossing onto the inside half-plane = IN, off it = OUT.
// This mirrors the pipeline's sign convention (side 'left' is cross >= 0) so the
// line the operator draws means the same thing here as in the detector.

function activeLine(zones) {
  return (Array.isArray(zones) ? zones : []).find(
    (z) => z && z.enabled !== false && z.shape === 'line'
      && Array.isArray(z.points) && z.points.length >= 2,
  ) || null;
}

function crossSign(px, py, a, b) {
  return (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
}

function lineKey(line) {
  if (!line) return 'none';
  const [a, b] = line.points;
  return `${a.x.toFixed(3)},${a.y.toFixed(3)}-${b.x.toFixed(3)},${b.y.toFixed(3)}:${line.side}`;
}

const STALE_SEC = 8; // a tracked person gone this long is treated as having left

export function useLineAttendance(detections, zones) {
  const line = activeLine(zones);
  const key = lineKey(line);
  const [inside, setInside] = useState([]);   // [{track_id,name,enteredAt,duration}]
  const [log, setLog] = useState([]);         // [{track_id,name,direction,ts,duration?}]
  const st = useRef({ side: new Map(), inside: new Map(), lastSeen: new Map() });

  // Reset tracking (not the log) when the line itself changes.
  useEffect(() => {
    st.current = { side: new Map(), inside: new Map(), lastSeen: new Map() };
    setInside([]);
  }, [key]);

  useEffect(() => {
    if (!line) return;
    const fw = Number(detections?.frame_w) || 1920;
    const fh = Number(detections?.frame_h) || 1080;
    const [a, b] = line.points;
    const now = Date.now() / 1000;
    const s = st.current;
    const events = [];

    for (const box of (detections?.boxes || [])) {
      const tid = box.track_id;
      if (tid === undefined || tid === null) continue;
      const name = box.name && box.name !== 'Unknown' ? box.name : null;
      const fx = ((Number(box.x1) + Number(box.x2)) / 2) / fw;
      const fy = Number(box.y2) / fh;                 // feet = bottom-centre
      const cross = crossSign(fx, fy, a, b);
      const isInside = line.side === 'left' ? cross >= 0 : cross <= 0;
      s.lastSeen.set(tid, now);
      const prev = s.side.get(tid);
      s.side.set(tid, isInside);
      if (prev === undefined) continue;
      if (!prev && isInside) {
        s.inside.set(tid, { track_id: tid, name, enteredAt: now });
        events.push({ track_id: tid, name, direction: 'in', ts: now });
      } else if (prev && !isInside) {
        const e = s.inside.get(tid);
        s.inside.delete(tid);
        events.push({ track_id: tid, name, direction: 'out', ts: now, duration: e ? now - e.enteredAt : null });
      } else if (name && s.inside.has(tid) && !s.inside.get(tid).name) {
        s.inside.get(tid).name = name;                // face recognised after entry
      }
    }

    // Prune people whose track vanished while inside — treat as departed.
    for (const [tid, e] of Array.from(s.inside.entries())) {
      if (now - (s.lastSeen.get(tid) || 0) > STALE_SEC) {
        s.inside.delete(tid);
        events.push({ track_id: tid, name: e.name, direction: 'out', ts: now, duration: now - e.enteredAt });
      }
    }

    if (events.length) setLog((prev) => [...events, ...prev].slice(0, 50));
    setInside(Array.from(s.inside.values()).map((e) => ({ ...e, duration: now - e.enteredAt })));
  }, [detections, line, key]);

  return { inside, log, hasLine: !!line };
}
