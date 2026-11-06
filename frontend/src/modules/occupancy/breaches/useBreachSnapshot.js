/**
 * The snapshot for one breach event.
 *
 * Source, in order: an s3:// crop streamed through the backend relay
 * (synchronous — no request), a direct snapshotUrl on the event, else the
 * presigned URL from /ai/events/:id/snapshot. That last one is fetched once
 * per event and cached for the session, so hovering a row twice asks once.
 */
import { useEffect, useState } from 'react';
import { aiService } from '@/core/services/ai';

const cache = new Map(); // eventId -> { src, cropped } | null

function directSnapshot(evt) {
  const src = aiService.snapshotSrc(evt?.snapshot_uri || evt?.snapshotUri || evt?.payload?.snapshotUri);
  if (src) return { src, cropped: true };
  if (evt?.snapshotUrl) return { src: evt.snapshotUrl, cropped: false };
  return null;
}

/** { state: 'loading' | 'ready' | 'none', src?, cropped? } — fetches only when `enabled`. */
export function useBreachSnapshot(evt, enabled = true) {
  const id = evt?.id ?? evt?._id;
  const direct = directSnapshot(evt);
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!enabled || direct || !id || cache.has(id)) return undefined;
    let cancelled = false;
    aiService.getSnapshotUrl(id)
      .then((r) => cache.set(id, r?.url ? { src: r.url, cropped: false } : null))
      .catch(() => cache.set(id, null))
      .finally(() => { if (!cancelled) rerender((n) => n + 1); });
    return () => { cancelled = true; };
  }, [id, enabled, direct?.src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (direct) return { state: 'ready', ...direct };
  if (!id || !cache.has(id)) return { state: id ? 'loading' : 'none' };
  const v = cache.get(id);
  return v ? { state: 'ready', ...v } : { state: 'none' };
}
