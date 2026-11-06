/**
 * The live view of the zone, with every detected person judged against it.
 *
 * Green box + name tag  on the whitelist, and inside the boundary
 * Red box + tinted fill not permitted here — this is the breach, drawn where it
 *                       is happening rather than only in a table underneath
 * Dimmed thin box       outside the boundary: detected, deliberately ignored
 *
 * That third state is the one that stops the panel lying. A camera covering a
 * server-room door also sees the corridor; without showing those people as
 * present-but-ignored, an operator watching two people walk past outside an
 * empty locked room sees nothing at all and cannot tell whether the detector is
 * working.
 */
import { ShieldAlert, ShieldCheck, UserX, Video, VideoOff } from 'lucide-react';
import { pointsToSvg } from '@/modules/headcount/zone-geometry';
import CleanFeed from './CleanFeed';

export default function DetectionOverlay({ monitorId, polygon, frame, running, error, color = 'var(--brand)', others = [] }) {
  const boxes = frame?.boxes || [];
  const intruders = frame?.intruders || [];
  const authorised = frame?.authorised || [];

  return (
    <div>
      <div
        className="relative w-full select-none overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: '16 / 9' }}
      >
        {monitorId ? (
          // The clean camera feed, not the head-count detector's annotated
          // one: the boxes below are this page's own judgement, and the
          // detector's would be drawn on top of them.
          <div className="absolute inset-0"><CleanFeed monitorId={monitorId} /></div>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-body text-white/40">
            Pick a camera to watch this zone
          </div>
        )}

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          {/* The other zones on this view, for context only: the boxes below
              are judged against the active zone's rules, not theirs. */}
          {others.filter((o) => o.points?.length >= 3).map((o) => (
            <polygon
              fill="none"
              key={o.id}
              opacity="0.7"
              points={pointsToSvg(o.points)}
              stroke={o.color}
              strokeDasharray="1.2 1.2"
              strokeWidth="0.3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {polygon?.length >= 3 ? (
            <polygon
              fill={`color-mix(in srgb, ${color} 10%, transparent)`}
              points={pointsToSvg(polygon)}
              stroke={color}
              strokeDasharray="2 1.5"
              strokeWidth="0.4"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>

        {/* Boxes are DOM, not SVG: the label has to stay legible at a fixed size
            while the frame scales, which a viewBox would defeat. */}
        {boxes.map((b) => {
          const { x, y, w, h } = b.rect;
          const tone = !b.inside
            ? { ring: 'ring-white/25', fill: 'transparent', tag: 'bg-black/60 text-white/60' }
            : b.authorized
              ? { ring: 'ring-2 ring-success', fill: 'transparent', tag: 'bg-success text-white' }
              : { ring: 'ring-2 ring-danger', fill: 'color-mix(in srgb, var(--danger) 20%, transparent)', tag: 'bg-danger text-white' };
          return (
            <div
              className={`absolute rounded-sm ring-inset ${tone.ring}`}
              key={b.track_id}
              style={{
                left: `${x * 100}%`, top: `${y * 100}%`,
                width: `${w * 100}%`, height: `${h * 100}%`,
                background: tone.fill,
              }}
            >
              {b.inside ? (
                <span
                  // Deliberately allowed to overflow the box: a person is narrower than
                  // their name, and a clipped badge ("Unide...") is worse than one that
                  // sticks out past the shoulder it belongs to.
                  className={`absolute -top-[18px] left-0 inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-small font-bold ${tone.tag}`}
                >
                  {b.authorized
                    ? <ShieldCheck className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                    : <UserX className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />}
                  {b.unknown ? 'Unidentified' : b.name}
                </span>
              ) : null}
            </div>
          );
        })}

        {/* Status strip. Reads as a sentence rather than a count, because the
            question is "is anything wrong", not "how many rectangles". */}
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-small font-bold text-white/70">
            {running === false ? <VideoOff className="h-3 w-3" /> : <Video className="h-3 w-3" />}
            {running === false ? 'Detector idle' : 'Detecting'}
          </span>
          {authorised.length ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success px-2 py-0.5 text-small font-bold text-white">
              <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
              {authorised.length} authorised inside
            </span>
          ) : null}
          {intruders.length ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger px-2 py-0.5 text-small font-bold text-white">
              <ShieldAlert className="h-3 w-3" strokeWidth={2.5} />
              Unauthorized presence in restricted zone — {intruders.length}
            </span>
          ) : null}
          {frame?.tailgating ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning px-2 py-0.5 text-small font-bold text-black">
              <UserX className="h-3 w-3" strokeWidth={2.5} />
              Tailgating / escort violation
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg border border-warning-line bg-warning-soft px-2.5 py-2 text-body leading-relaxed text-warning-ink">
          {error} The boundary and rules still save; only the live overlay is unavailable.
        </p>
      ) : null}
    </div>
  );
}
