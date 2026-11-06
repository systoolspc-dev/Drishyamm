import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

/**
 * Small overlay shown when a video is digitally zoomed. Floats at the
 * bottom-left of the player so it doesn't fight with the quality
 * selector at top-right or the live badge.
 *
 *   [ −  1.7×  +  ↺ ]
 */
export default function ZoomIndicator({ zoom, onZoomIn, onZoomOut, onReset, visible = true }) {
  if (!visible || zoom <= 1.001) return null;

  return (
    <div className="absolute bottom-2 left-2 z-10 flex items-center gap-0.5 rounded-md bg-black/60 backdrop-blur-sm border border-white/10 px-1 py-1 select-none">
      <IconButton onClick={onZoomOut} title="Zoom out (mouse wheel)">
        <ZoomOut size={12} />
      </IconButton>
      <span className="px-2 text-caption font-semibold tabular-nums text-white">
        {zoom.toFixed(1)}×
      </span>
      <IconButton onClick={onZoomIn} title="Zoom in (mouse wheel)">
        <ZoomIn size={12} />
      </IconButton>
      <span className="w-px h-4 bg-white/15 mx-0.5" />
      <IconButton onClick={onReset} title="Reset zoom (double-click)">
        <RotateCcw size={12} />
      </IconButton>
    </div>
  );
}

function IconButton({ onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="p-1 rounded hover:bg-white/15 text-white/80 hover:text-white transition"
    >
      {children}
    </button>
  );
}
