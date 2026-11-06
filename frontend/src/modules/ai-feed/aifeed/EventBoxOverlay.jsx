import { TONE_VAR } from '@/core/ui/tone';

/**
 * One event's bounding box, drawn on top of a tile in the event's severity
 * colour. Used when the operator clicks an event in the stream: the tile
 * shows WHERE the detection was, labelled with what it was, for a few
 * seconds. Inference-frame coordinates through an SVG viewBox, the same fit
 * as the live overlay, so the box lands on the same pixels the detector saw.
 */
export function EventBoxOverlay({ event, frameW = 1920, frameH = 1080, className = '', labelMode = 'title' }) {
  if (!event?.bbox) return null;
  const w = event.frame?.w || frameW;
  const h = event.frame?.h || frameH;
  const [x1, y1, x2, y2] = event.bbox;
  // Only urgency is coloured. An informational box is a plain white outline
  // — the same neutral the rest of the page uses — so a frame full of
  // ordinary detections does not turn into a colour chart.
  const urgent = event.tone === 'danger' || event.tone === 'warning';
  const color = urgent ? TONE_VAR[event.tone] : 'rgba(255,255,255,0.85)';
  const stroke = Math.max(3, w / 640);
  // The SVG scales with the tile, so text set in frame pixels shrinks with
  // it: on a 270px-wide tile a 1920px frame is drawn at 14%. The label is
  // therefore large in frame terms and, on tiles, just the event type.
  const fontSize = Math.max(28, w / 34);
  const label = labelMode === 'full' && event.detail ? `${event.title} · ${event.detail}` : event.title;
  const tick = stroke * 1.6;
  const labelW = label.length * fontSize * 0.58 + fontSize + tick;
  const labelH = fontSize * 1.5;
  const lx = Math.min(Math.max(0, x1), Math.max(0, w - labelW));
  const ly = y1 - labelH - stroke > 0 ? y1 - labelH - stroke : y2 + stroke;
  return (
    <svg
      className={`pointer-events-none absolute inset-0 z-[22] h-full w-full ${className}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect
        x={x1} y={y1} width={Math.max(1, x2 - x1)} height={Math.max(1, y2 - y1)}
        fill={color} fillOpacity={urgent ? 0.07 : 0.03}
        stroke={color} strokeWidth={stroke} rx={Math.max(6, w / 240)}
        vectorEffect="non-scaling-stroke"
      />
      {/* Dark label plate with a severity tick on its left edge; the text is
          always white, so it reads the same on every scene. */}
      <rect x={lx} y={ly} width={labelW} height={labelH} rx={Math.max(4, w / 320)} fill="rgba(8,8,10,0.82)" />
      <rect x={lx} y={ly} width={tick} height={labelH} rx={Math.max(2, w / 640)} fill={color} />
      <text
        x={lx + tick + fontSize * 0.45} y={ly + labelH * 0.7}
        fill="rgba(255,255,255,0.95)" fontSize={fontSize} fontWeight="600"
        fontFamily="Inter, system-ui, sans-serif"
      >
        {label}
      </text>
    </svg>
  );
}

/**
 * A stand-in for video in sample mode: a dark scene with a faint floor grid
 * and a vignette, plus the camera's recent detections drawn where a live
 * overlay would put them. Deliberately quiet — it is a background for the
 * boxes, not a picture.
 */
export function DemoScene({ events = [], label = 'Sample feed', frameW = 1920, frameH = 1080, labelMode = 'title' }) {
  const boxes = events.filter((e) => e?.bbox).slice(0, 3);
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#0b0c10]">
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${frameW} ${frameH}`} preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <linearGradient id="demo-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#15171d" />
            <stop offset="0.55" stopColor="#101217" />
            <stop offset="1" stopColor="#0b0c10" />
          </linearGradient>
          <radialGradient id="demo-vignette" cx="0.5" cy="0.5" r="0.75">
            <stop offset="0.6" stopColor="#000" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.55" />
          </radialGradient>
        </defs>
        <rect width={frameW} height={frameH} fill="url(#demo-sky)" />
        {/* horizon + receding floor lines */}
        <line x1="0" y1={frameH * 0.52} x2={frameW} y2={frameH * 0.52} stroke="#ffffff" strokeOpacity="0.06" strokeWidth="2" />
        {Array.from({ length: 9 }).map((_, i) => {
          const x = (frameW / 8) * i;
          return <line key={`v${i}`} x1={x} y1={frameH} x2={frameW / 2 + (x - frameW / 2) * 0.18} y2={frameH * 0.52} stroke="#ffffff" strokeOpacity="0.045" strokeWidth="2" />;
        })}
        {Array.from({ length: 6 }).map((_, i) => {
          const y = frameH * 0.52 + ((frameH * 0.48) / 6) * (i + 1) ** 1.35 / 6 ** 0.35;
          return <line key={`h${i}`} x1="0" y1={y} x2={frameW} y2={y} stroke="#ffffff" strokeOpacity="0.04" strokeWidth="2" />;
        })}
        <rect width={frameW} height={frameH} fill="url(#demo-vignette)" />
      </svg>
      {boxes.map((e) => (
        <EventBoxOverlay key={e.id} event={e} frameW={frameW} frameH={frameH} labelMode={labelMode} />
      ))}
      {/* Same dark pill as every other label on a frame, one step quieter.
          Grid tiles pass no label — the page header already says SAMPLE DATA
          and the tile's own bottom edge belongs to the AI's read. */}
      {label ? (
        <span className="absolute bottom-2 right-2.5 inline-flex h-5 items-center rounded bg-black/55 px-1.5 text-micro font-bold uppercase tracking-[0.06em] text-white/50 backdrop-blur-sm">
          {label}
        </span>
      ) : null}
    </div>
  );
}
