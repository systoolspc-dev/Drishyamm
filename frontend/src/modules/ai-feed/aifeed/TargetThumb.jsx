import { useEffect, useState } from 'react';
import { aiService } from '@/core/services/ai';
import { cn } from '@/core/lib/utils';
import { EventIcon } from './icons';

// Signed-URL cache for backend snapshots (S3 key → presigned URL). Shared by
// every thumbnail on the page so scrolling the stream does not re-sign.
const signed = new Map();

function useSnapshotSrc(snapshot) {
  const direct = snapshot?.src || null;
  const eventId = !direct && snapshot?.eventId ? snapshot.eventId : null;
  // Only the asynchronous signing needs state; a direct URL or a cached
  // signed one is read straight from props / the cache during render.
  const [resolved, setResolved] = useState({ id: null, url: null });

  useEffect(() => {
    if (!eventId || signed.has(eventId)) return undefined;
    let cancelled = false;
    aiService.getSnapshotUrl(eventId)
      .then((res) => {
        const url = res?.url || res?.data?.url || null;
        signed.set(eventId, url);
        if (!cancelled) setResolved({ id: eventId, url });
      })
      .catch(() => { if (!cancelled) setResolved({ id: eventId, url: null }); });
    return () => { cancelled = true; };
  }, [eventId]);

  if (direct) return direct;
  if (!eventId) return null;
  if (signed.has(eventId)) return signed.get(eventId);
  return resolved.id === eventId ? resolved.url : null;
}

/**
 * The event's TARGET, not the whole frame: a face, a plate, the person at
 * the fence. When the snapshot is already a crop (the face worker stores
 * one) it is shown as-is; when it is the full inference frame, the event's
 * bounding box is used to pan and zoom the image inside the tile, padded a
 * little so the subject has context. Falls back to the category icon when
 * there is no image, so a row never shows a broken picture.
 */
export default function TargetThumb({ event, size = 44, rounded = 'rounded-md', className }) {
  const src = useSnapshotSrc(event.snapshot);
  // Both are remembered WITH the src they belong to, so a new image never
  // inherits the previous one's failure or dimensions.
  const [measured, setMeasured] = useState(null);   // { src, w, h }
  const [failedSrc, setFailedSrc] = useState(null);

  const failed = Boolean(src) && failedSrc === src;
  const natural = measured && measured.src === src ? measured : null;
  const showImage = src && !failed;

  let imgStyle = { width: '100%', height: '100%', objectFit: 'cover' };
  if (showImage && !event.snapshot?.cropped && event.bbox) {
    const frame = event.frame || natural;
    if (frame && frame.w && frame.h) {
      const [x1, y1, x2, y2] = event.bbox;
      const bw = Math.max(1, x2 - x1);
      const bh = Math.max(1, y2 - y1);
      // Square crop around the box, padded 30%, clamped to the frame.
      const side = Math.min(Math.max(bw, bh) * 1.3, Math.max(frame.w, frame.h));
      const cx = x1 + bw / 2;
      const cy = y1 + bh / 2;
      const left = Math.min(Math.max(0, cx - side / 2), Math.max(0, frame.w - side));
      const top = Math.min(Math.max(0, cy - side / 2), Math.max(0, frame.h - side));
      const scale = size / side;
      imgStyle = {
        position: 'absolute',
        width: frame.w * scale,
        height: frame.h * scale,
        left: -left * scale,
        top: -top * scale,
        maxWidth: 'none',
      };
    }
  }

  return (
    <span
      className={cn(
        'relative block shrink-0 overflow-hidden border border-line-subtle bg-surface-muted',
        rounded,
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          draggable={false}
          style={imgStyle}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth && el.naturalHeight) setMeasured({ src, w: el.naturalWidth, h: el.naturalHeight });
          }}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        // No picture → the category glyph on a neutral tile. Never tinted: the
        // severity badge beside it is the only thing that carries colour.
        <span className="grid h-full w-full place-items-center bg-surface-muted text-fg-muted">
          <EventIcon name={event.iconName} style={{ width: Math.round(size * 0.42), height: Math.round(size * 0.42) }} strokeWidth={1.8} />
        </span>
      )}
    </span>
  );
}
