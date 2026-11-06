/**
 * A camera's own live picture, with nothing drawn on it.
 *
 * Zone Setup used to show the head-count detector's `/video` stream. That
 * stream only exists for cameras already counting, and arrives with the
 * detector's boxes and totals burned in -- so the page could not show a camera
 * before counting was on, and drawing a zone meant drawing over someone
 * else's annotations. The platform's HLS feed has neither problem.
 *
 * Every player control is off: this sits under a drawing surface, and a
 * zoom, a menu or an overlay of its own would fight the pointer.
 */
import HLSPlayer from '@/core/players/HLSPlayer';

export default function CleanFeed({ monitorId }) {
  return (
    <HLSPlayer
      aiOverlay={false}
      className="h-full w-full"
      controls={false}
      digitalZoom={false}
      monitorId={monitorId}
      protocolBadge={false}
      qualityControl={false}
    />
  );
}
