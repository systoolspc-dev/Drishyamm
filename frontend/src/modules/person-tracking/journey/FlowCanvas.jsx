/**
 * FlowCanvas — the swap seam.
 *
 * Owns pan and zoom, and nothing else. Every other concern lives outside it:
 * the nodes come in already clustered, selection and the time cursor are the
 * page's state, and the cards know how to draw themselves. That boundary is
 * deliberate — if multi-hypothesis re-identification ever ships and a journey
 * forks, this is the one file that gets replaced by a graph library, and
 * nothing above or below it has to change.
 *
 * Why no graph library today: a journey is a CHAIN. Out-degree one, ordered by
 * time, no branches, no layout to solve. Pan is `overflow-x`, zoom is one
 * `transform: scale()`, and the visible slice is `Array.prototype.slice`.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronsLeftRight, FoldHorizontal, Layers, Maximize2, Minus, Plus,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import { describeClustering, nodeStateAt } from './journey-model';
import { CONNECTOR_W, Connector, JourneyNode, PITCH } from './nodes';

const ZOOM_MIN = 0.55;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.15;
// How many cards either side of the viewport stay mounted. Enough that a fast
// drag never shows a hole, few enough that a 400-card worst case still mounts
// a couple of dozen nodes.
const OVERSCAN = 4;

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(2))));

export default function FlowCanvas({
  nodes,
  cursorMs,
  selectedNodeId,
  onSelect,
  floors,
  floor,
  onFloor,
  sightings,
}) {
  const [zoom, setZoom] = useState(1);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportW, setViewportW] = useState(1200);
  const scrollRef = useRef(null);

  // Measured rather than assumed: the window arithmetic needs the real width,
  // and the canvas sits in a flexible column that changes with the sidebar.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setViewportW(entry.contentRect.width));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const toggle = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => setExpandedIds(new Set()), []);

  /**
   * The window.
   *
   * Pitch is constant, so the first and last visible index are arithmetic, and
   * the two spacers keep the scroll width honest without mounting the cards in
   * between. An expanded cluster grows DOWNWARD, not sideways, so expansion
   * never invalidates this.
   */
  const pitch = PITCH * zoom;
  const total = nodes.length;
  const from = Math.max(0, Math.floor(scrollLeft / pitch) - OVERSCAN);
  const to = Math.min(total, Math.ceil((scrollLeft + viewportW) / pitch) + OVERSCAN);
  const visible = useMemo(() => nodes.slice(from, to), [nodes, from, to]);

  const clustering = useMemo(() => describeClustering(sightings, nodes), [sightings, nodes]);

  // Keep the selected card on screen when selection arrives from the history
  // panel or the URL rather than from a click on the canvas.
  useLayoutEffect(() => {
    if (!selectedNodeId || !scrollRef.current) return;
    const i = nodes.findIndex((n) => n.id === selectedNodeId);
    if (i < 0) return;
    const el = scrollRef.current;
    const left = i * pitch;
    if (left < el.scrollLeft || left + pitch > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.max(0, left - el.clientWidth / 2 + pitch / 2), behavior: 'smooth' });
    }
  }, [selectedNodeId, nodes, pitch]);

  const fit = () => {
    const want = viewportW / Math.max(1, total * PITCH);
    setZoom(clampZoom(want));
    scrollRef.current?.scrollTo({ left: 0 });
  };

  return (
    <Panel
      bodyClass="p-0"
      icon={ChevronsLeftRight}
      right={
        <span className="flex items-center gap-1.5">
          {clustering ? (
            <span className="hidden whitespace-nowrap text-micro font-semibold text-fg-subtle sm:inline">
              {clustering.sightings} sightings → {clustering.cards} cards
            </span>
          ) : null}
        </span>
      }
      title="Route flow"
    >
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-line">
          <button
            aria-label="Zoom out"
            className="px-2 py-1.5 text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-40"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
            type="button"
          >
            <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
          <span className="grid w-12 place-items-center border-x border-line text-[11px] font-bold tabular-nums text-fg-secondary">
            {Math.round(zoom * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            className="px-2 py-1.5 text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-40"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>

        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-secondary transition hover:bg-surface-sunken"
          onClick={fit}
          type="button"
        >
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={2} />
          Fit
        </button>

        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
          disabled={expandedIds.size === 0}
          onClick={collapseAll}
          type="button"
        >
          <FoldHorizontal className="h-3.5 w-3.5" strokeWidth={2} />
          Collapse all
        </button>

        {/* Only when the feed actually describes more than one level.
            Inventing floors for a single-storey site would be tabs that all
            show the same route. */}
        {floors.length > 1 ? (
          <label className="inline-flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
            <select
              aria-label="Filter by floor"
              className="h-8 rounded-lg border border-line bg-surface px-2 text-[11.5px] font-semibold text-fg-secondary focus:border-brand focus:outline-none"
              onChange={(e) => onFloor(e.target.value)}
              value={floor}
            >
              <option value="all">All floors</option>
              {floors.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        ) : null}

        <span className="flex-1" />
        <span className="hidden text-[10.5px] text-fg-subtle md:inline">
          Drag sideways to pan · hover a card for detail
        </span>
      </div>

      {/* ── The chain ─────────────────────────────────────────────────────── */}
      <div
        className="min-h-[248px] overflow-x-auto overflow-y-hidden overscroll-x-contain"
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        ref={scrollRef}
      >
        {total ? (
          <ol
            className="flex items-start px-3 py-4"
            style={{
              // The unscaled width. The wrapper is what gets scaled, so the
              // browser multiplies this by `zoom` to get the scroll extent --
              // writing the scaled figure here would double it at 2x.
              width: total * PITCH + 24,
              transform: `scale(${zoom})`,
              transformOrigin: 'left top',
            }}
          >
            {/* Leading spacer stands in for the cards left of the window. */}
            {from > 0 ? <li aria-hidden style={{ width: from * PITCH, flexShrink: 0 }} /> : null}

            {visible.map((node, i) => {
              const index = from + i;
              const state = nodeStateAt(node, cursorMs);
              return (
                <li className="flex shrink-0 items-start" key={node.id}>
                  {index > 0 ? (
                    <Connector dimmed={state === 'future'} gapBeforeMs={node.gapBeforeMs} />
                  ) : (
                    <span aria-hidden style={{ width: CONNECTOR_W / 2, flexShrink: 0 }} />
                  )}
                  <JourneyNode
                    expanded={expandedIds.has(node.id)}
                    node={node}
                    onSelect={onSelect}
                    onToggle={toggle}
                    selected={node.id === selectedNodeId}
                    state={state}
                  />
                </li>
              );
            })}

            {to < total ? <li aria-hidden style={{ width: (total - to) * PITCH, flexShrink: 0 }} /> : null}
          </ol>
        ) : (
          <p className="px-6 py-14 text-center text-small text-fg-muted">
            No sightings in this journey yet.
          </p>
        )}
      </div>

      {/* A legend, because five card treatments is more than a first-time
          viewer can infer from the cards alone. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-subtle px-3 py-2 text-[10px] text-fg-muted">
        <Key className="border-t-2 border-solid border-line-strong">transition</Key>
        <Key className="border-t-2 border-dashed border-info">unmonitored gap</Key>
        <Swatch className="bg-success">entry / exit</Swatch>
        <Swatch className="bg-brand">zone run</Swatch>
        <Swatch className="bg-danger">violation</Swatch>
      </div>
    </Panel>
  );
}

const Key = ({ className, children }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`h-0 w-5 ${className}`} />
    {children}
  </span>
);

const Swatch = ({ className, children }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={`h-2.5 w-2.5 rounded-sm ${className}`} />
    {children}
  </span>
);
