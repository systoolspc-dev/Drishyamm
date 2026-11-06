import { useEffect, useRef, useState } from 'react';
import {
  Camera, FlipHorizontal2, Hexagon, MapPinned, Minus, MousePointer2, Plus,
  Save, ScanFace, Square, Trash2, Undo2, Users, X,
} from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import {
  Select, SelectContent, SelectGroup, SelectItem,
  SelectLabel, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import {
  ORANGE, SHAPE_MIN_POINTS, boxCorners, clamp01, draftDetectionZones,
  lineInsideNormal, normalizeDetectionZones, zoneShape,
} from './detection-utils';
import { ZoneOverlay } from './overlays';

function SectionEyebrow({ children, className = '' }) {
  return (
    <p className={`text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle ${className}`}>
      {children}
    </p>
  );
}

function ShortcutKey({ children }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-white/20 bg-white/10 px-1.5 text-micro font-bold tracking-[0.02em] text-white">
      {children}
    </kbd>
  );
}

// Camera dropdown row, shared with the page so the picker looks the same in
// the editor and in the header.
export function CameraOption({ cam }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        cam.status === 'online'
          ? 'bg-success shadow-[0_0_6px_rgba(16,185,129,0.7)]'
          : 'bg-neutral'
      }`} />
      <span className="flex-1 truncate text-body font-semibold tracking-[-0.005em] text-fg">
        {cam.name}
      </span>
      {cam.channel != null ? (
        <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 text-micro font-bold tabular-nums text-fg-muted">
          CH {cam.channel}
        </span>
      ) : null}
    </div>
  );
}

export default function ZoneEditorModal({ open, camera, zones, groups = [], onClose, onSave, onSelectCamera, saving }) {
  const stageRef = useRef(null);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const initialRef = useRef('');
  const [draftZones, setDraftZones] = useState(() => draftDetectionZones(zones));
  const [activeId, setActiveId] = useState('');
  const [hoverPoint, setHoverPoint] = useState(null); // { x, y } in 0..1 — cursor for previews
  const [dragStart, setDragStart] = useState(null);   // anchor while dragging a box/line

  // Re-seed the draft only when the modal opens or the camera changes — NOT on
  // every background poll of `zones`, which would otherwise wipe a drawing in
  // progress. We read the freshest zones from a ref so switching the camera
  // loads the newly-selected camera's saved areas.
  const monitorId = camera?.monitorId;
  useEffect(() => {
    if (!open) return;
    const next = draftDetectionZones(zonesRef.current);
    setDraftZones(next);
    setActiveId(next[0]?.id || '');
    setHoverPoint(null);
    setDragStart(null);
    initialRef.current = JSON.stringify(next);
  }, [open, monitorId]);

  const activeZone = draftZones.find((zone) => zone.id === activeId) || draftZones[0];
  const shape = activeZone?.shape || 'polygon';
  const dirty = JSON.stringify(draftZones) !== initialRef.current;

  const mapPointer = (event, clampToFrame = false) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const aspect = 16 / 9;
    let width = rect.width;
    let height = width / aspect;
    if (height > rect.height) {
      height = rect.height;
      width = height * aspect;
    }
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    const x = (event.clientX - left) / width;
    const y = (event.clientY - top) / height;
    if (!clampToFrame && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: clamp01(x), y: clamp01(y) };
  };

  const updateActive = (fn) => {
    setDraftZones((prev) => prev.map((zone) => (
      zone.id === activeZone?.id ? fn(zone) : zone
    )));
  };

  // ── Polygon: click to drop a corner ──
  const handleStageClick = (event) => {
    if (shape !== 'polygon') return;
    const point = mapPointer(event);
    if (!point || !activeZone) return;
    updateActive((zone) => ({
      ...zone,
      enabled: true,
      points: [...zone.points, point].slice(0, 24),
    }));
  };

  // ── Box / Line: press → drag → release ──
  const handleStageDown = (event) => {
    if (shape === 'polygon' || !activeZone) return;
    const point = mapPointer(event, true);
    if (point) setDragStart(point);
  };

  const handleStageMove = (event) => {
    setHoverPoint(mapPointer(event, dragStart != null));
  };

  const handleStageUp = (event) => {
    if (shape === 'polygon' || !dragStart || !activeZone) { setDragStart(null); return; }
    const end = mapPointer(event, true) || hoverPoint;
    const anchor = dragStart;
    setDragStart(null);
    if (!end) return;
    const dist = Math.hypot(end.x - anchor.x, end.y - anchor.y);
    if (dist < 0.02) return; // ignore an accidental click without a real drag
    const points = shape === 'line' ? [anchor, end] : boxCorners(anchor, end);
    updateActive((zone) => ({ ...zone, enabled: true, points }));
  };

  const handleStageLeave = () => { setHoverPoint(null); setDragStart(null); };

  // Undo: polygon drops the last corner; line/box clear the single gesture.
  const undoPoint = () => updateActive((zone) => ({
    ...zone,
    points: zone.shape === 'polygon' ? zone.points.slice(0, -1) : [],
  }));
  const clearPoints = () => updateActive((zone) => ({ ...zone, points: [] }));

  const setShape = (nextShape) => {
    if (nextShape === shape) return;
    updateActive((zone) => ({ ...zone, shape: nextShape, points: [] }));
    setDragStart(null);
  };

  const flipSide = () => updateActive((zone) => ({ ...zone, side: zone.side === 'right' ? 'left' : 'right' }));

  const toggleApply = (key) => {
    updateActive((zone) => {
      const has = zone.applyTo.includes(key);
      const next = has ? zone.applyTo.filter((item) => item !== key) : [...zone.applyTo, key];
      return { ...zone, applyTo: next.length ? next : [key] };
    });
  };

  const requestCameraSwitch = (nextMonitorId) => {
    if (!nextMonitorId || nextMonitorId === monitorId) return;
    if (dirty && !window.confirm('Discard unsaved changes to this camera’s detection areas?')) return;
    onSelectCamera?.(nextMonitorId);
  };

  // Keyboard: Esc to close, Ctrl+Z (or just Z) to undo
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key === 'z' || event.key === 'Z') {
        if (!event.target?.closest?.('input, textarea')) undoPoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, draftZones]);

  const addZone = () => {
    const next = {
      id: `zone-${Date.now()}`,
      name: `Detection Zone ${draftZones.length + 1}`,
      enabled: true,
      shape: 'line',
      side: 'left',
      applyTo: ['face', 'person'],
      points: [],
    };
    setDraftZones((prev) => [...prev, next].slice(0, 8));
    setActiveId(next.id);
  };

  const deleteActive = () => {
    setDraftZones((prev) => {
      const next = prev.filter((zone) => zone.id !== activeZone.id);
      setActiveId(next[0]?.id || '');
      return next.length ? next : draftDetectionZones([]);
    });
  };

  const handleSave = () => {
    onSave(normalizeDetectionZones(draftZones));
  };

  if (!open || !camera) return null;

  // Stats for the active zone
  const pointCount = activeZone?.points?.length || 0;
  const isReady = pointCount >= SHAPE_MIN_POINTS[shape];
  const lastPoint = pointCount ? activeZone.points[pointCount - 1] : null;
  const firstPoint = pointCount ? activeZone.points[0] : null;
  // Polygon-only: distance from cursor to first point for the "close" hint
  const closeDist = firstPoint && hoverPoint
    ? Math.hypot((firstPoint.x - hoverPoint.x), (firstPoint.y - hoverPoint.y))
    : 1;
  const nearStart = shape === 'polygon' && isReady && closeDist < 0.025;

  const SHAPE_TOOLS = [
    { key: 'line',    label: 'Line',    Icon: Minus },
    { key: 'box',     label: 'Box',     Icon: Square },
    { key: 'polygon', label: 'Polygon', Icon: Hexagon },
  ];

  const hint = pointCount === 0
    ? (shape === 'line' ? 'Drag a straight line across the area to watch'
      : shape === 'box' ? 'Drag a box around the area to watch'
        : 'Click to drop the first corner')
    : shape === 'line' ? 'Line set — drag again to redraw'
      : shape === 'box' ? 'Box set — drag again to redraw'
        : nearStart ? 'Click first point to close'
          : `${pointCount} ${pointCount === 1 ? 'point' : 'points'} — keep clicking to outline`;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm">
      <div className="flex max-h-[calc(var(--app-vh)*0.94)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-slate-900/10">
        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-950 text-white dark:bg-surface-muted dark:text-fg">
              <MapPinned className="h-4 w-4" strokeWidth={2} />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-heading font-semibold tracking-[-0.012em] text-fg">
                Detection Area
              </p>
              <p className="mt-0.5 truncate text-caption font-medium text-fg-muted">
                {draftZones.length} zone{draftZones.length === 1 ? '' : 's'}
                <span className="mx-1.5 text-fg-disabled">·</span>
                pick a camera, then draw
              </p>
            </div>
            {/* Camera picker — switch which camera you're marking without leaving the editor */}
            <div className="ml-2 hidden min-w-[210px] sm:block">
              <Select value={monitorId || ''} onValueChange={requestCameraSwitch}>
                <SelectTrigger className="h-9 border-line bg-surface text-small">
                  {camera ? <CameraOption cam={camera} /> : <SelectValue placeholder="Select camera" />}
                </SelectTrigger>
                <SelectContent position="popper" className="z-[260] max-h-72">
                  {groups.map((g) => {
                    const cams = (g.cameras || []).slice().sort((a, b) => (a.channel || 0) - (b.channel || 0));
                    if (cams.length === 0) return null;
                    return (
                      <SelectGroup key={g.id}>
                        <SelectLabel className="pl-2 text-micro font-bold uppercase tracking-[0.12em] text-fg-muted">
                          {g.name}
                        </SelectLabel>
                        {cams.map((cam) => (
                          <SelectItem key={cam.monitorId} value={cam.monitorId} className="py-2">
                            <CameraOption cam={cam} />
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold tracking-[-0.005em] text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" strokeWidth={2.25} />
              {saving ? 'Saving…' : 'Save zones'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 grid h-9 w-9 place-items-center rounded-lg text-fg-subtle transition hover:bg-surface-muted hover:text-fg-secondary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* Canvas */}
          <div className="relative min-h-[420px] bg-[#0a0a0c] p-4">
            <div
              ref={stageRef}
              role="button"
              tabIndex={0}
              onClick={handleStageClick}
              onMouseDown={handleStageDown}
              onMouseUp={handleStageUp}
              onMouseMove={handleStageMove}
              onMouseLeave={handleStageLeave}
              className="relative h-full min-h-[360px] overflow-hidden rounded-xl bg-black ring-1 ring-white/10 select-none"
              style={{ cursor: nearStart ? 'pointer' : 'crosshair' }}
            >
              <DirectStreamPlayer
                key={`${camera.monitorId}-zone-editor`}
                monitorId={camera.monitorId}
                mode="webrtc"
                quality="high"
                muted
                controls={false}
                aiOverlay={false}
                digitalZoom={false}
                className="h-full w-full"
              />
              {/* Translucent overlay so the painted zones read clearly over the video */}
              <div className="pointer-events-none absolute inset-0 bg-black/15" />

              <ZoneOverlay zones={draftZones.filter((zone) => zone.id !== activeZone?.id && zone.points.length >= SHAPE_MIN_POINTS[zoneShape(zone.shape)])} frameW={1920} frameH={1080} subtle />

              {/* Active zone overlay (drawing layer) */}
              <svg
                className="pointer-events-none absolute inset-0 z-30 h-full w-full"
                viewBox="0 0 1920 1080"
                preserveAspectRatio="xMidYMid meet"
              >
                {/* ── LINE: straight boundary + arrow toward the watched side ── */}
                {shape === 'line' ? (() => {
                  const pts = pointCount >= 2
                    ? activeZone.points
                    : (dragStart && hoverPoint ? [dragStart, hoverPoint] : null);
                  if (!pts) return null;
                  const [a, b] = pts;
                  const mx = ((a.x + b.x) / 2) * 1920;
                  const my = ((a.y + b.y) / 2) * 1080;
                  const n = lineInsideNormal(a, b, activeZone.side);
                  const tipX = mx + n.x * 130;
                  const tipY = my + n.y * 130;
                  const bx = tipX - n.x * 26;
                  const by = tipY - n.y * 26;
                  const px = -n.y; const py = n.x; // perpendicular for arrowhead
                  return (
                    <g>
                      <line x1={a.x * 1920} y1={a.y * 1080} x2={b.x * 1920} y2={b.y * 1080} stroke={ORANGE} strokeWidth="5" strokeLinecap="round" />
                      <line x1={mx} y1={my} x2={tipX} y2={tipY} stroke={ORANGE} strokeWidth="4" />
                      <polygon points={`${tipX},${tipY} ${bx + px * 16},${by + py * 16} ${bx - px * 16},${by - py * 16}`} fill={ORANGE} />
                      <text x={tipX + n.x * 28} y={tipY + n.y * 28 + 6} fill="white" fontSize="20" fontWeight="800" textAnchor="middle" paintOrder="stroke" stroke="rgba(15,23,42,0.85)" strokeWidth="5">inside</text>
                      {[a, b].map((p, i) => (
                        <circle key={i} cx={p.x * 1920} cy={p.y * 1080} r="12" fill="white" stroke={ORANGE} strokeWidth="5" />
                      ))}
                    </g>
                  );
                })() : null}

                {/* ── BOX: axis-aligned rectangle ── */}
                {shape === 'box' ? (() => {
                  const corners = pointCount >= 4
                    ? activeZone.points
                    : (dragStart && hoverPoint ? boxCorners(dragStart, hoverPoint) : null);
                  if (!corners) return null;
                  return (
                    <g>
                      <polygon
                        points={corners.map((p) => `${p.x * 1920},${p.y * 1080}`).join(' ')}
                        fill={`${ORANGE}26`}
                        stroke={ORANGE}
                        strokeWidth="4"
                        strokeLinejoin="round"
                      />
                      {corners.map((p, i) => (
                        <circle key={i} cx={p.x * 1920} cy={p.y * 1080} r="9" fill="white" stroke={ORANGE} strokeWidth="4" />
                      ))}
                    </g>
                  );
                })() : null}

                {/* ── POLYGON: freeform outline ── */}
                {shape === 'polygon' ? (
                  <>
                    {isReady ? (
                      <polygon
                        points={activeZone.points.map((p) => `${p.x * 1920},${p.y * 1080}`).join(' ')}
                        fill={`${ORANGE}26`}
                        stroke={ORANGE}
                        strokeWidth="4"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {!isReady && activeZone?.points.length >= 2 ? (
                      <polyline
                        points={activeZone.points.map((p) => `${p.x * 1920},${p.y * 1080}`).join(' ')}
                        fill="none"
                        stroke={ORANGE}
                        strokeWidth="4"
                        strokeLinejoin="round"
                      />
                    ) : null}
                    {lastPoint && hoverPoint ? (
                      <line
                        x1={lastPoint.x * 1920}
                        y1={lastPoint.y * 1080}
                        x2={hoverPoint.x * 1920}
                        y2={hoverPoint.y * 1080}
                        stroke={ORANGE}
                        strokeWidth="3"
                        strokeDasharray="12 10"
                        opacity="0.7"
                      />
                    ) : null}
                    {nearStart && firstPoint ? (
                      <line
                        x1={hoverPoint.x * 1920}
                        y1={hoverPoint.y * 1080}
                        x2={firstPoint.x * 1920}
                        y2={firstPoint.y * 1080}
                        stroke={ORANGE}
                        strokeWidth="3"
                        strokeDasharray="6 6"
                        opacity="0.9"
                      />
                    ) : null}
                    {activeZone?.points.map((point, index) => {
                      const isFirst = index === 0;
                      const radius = isFirst && nearStart ? 18 : 12;
                      return (
                        <g key={`${activeZone.id}-${index}`}>
                          {isFirst && nearStart ? (
                            <circle cx={point.x * 1920} cy={point.y * 1080} r="28" fill={`${ORANGE}30`} />
                          ) : null}
                          <circle
                            cx={point.x * 1920}
                            cy={point.y * 1080}
                            r={radius}
                            fill="white"
                            stroke={ORANGE}
                            strokeWidth="5"
                          />
                          <text
                            x={point.x * 1920}
                            y={point.y * 1080 + 9}
                            fill={ORANGE}
                            fontSize="22"
                            fontWeight="800"
                            textAnchor="middle"
                          >
                            {index + 1}
                          </text>
                        </g>
                      );
                    })}
                  </>
                ) : null}

                {/* Cursor crosshair (only while hovering) */}
                {hoverPoint ? (
                  <g pointerEvents="none">
                    <line x1={hoverPoint.x * 1920 - 18} y1={hoverPoint.y * 1080} x2={hoverPoint.x * 1920 + 18} y2={hoverPoint.y * 1080} stroke="white" strokeWidth="2" opacity="0.7" />
                    <line x1={hoverPoint.x * 1920} y1={hoverPoint.y * 1080 - 18} x2={hoverPoint.x * 1920} y2={hoverPoint.y * 1080 + 18} stroke="white" strokeWidth="2" opacity="0.7" />
                  </g>
                ) : null}
              </svg>

              {/* Top-left status pill */}
              <div className="pointer-events-none absolute left-4 top-4 z-40 inline-flex items-center gap-2 rounded-lg bg-black/65 px-3 py-1.5 text-small font-semibold tracking-[-0.005em] text-white shadow-lg backdrop-blur">
                <MousePointer2 className="h-3.5 w-3.5 text-brand" strokeWidth={2.25} />
                {hint}
              </div>

              {/* Top-right zone-name chip */}
              {activeZone ? (
                <div className="pointer-events-none absolute right-4 top-4 z-40 inline-flex items-center gap-2 rounded-lg bg-black/65 px-3 py-1.5 text-small font-semibold tracking-[-0.005em] text-white shadow-lg backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-brand" />
                  {activeZone.name}
                </div>
              ) : null}

              {/* Bottom shortcut bar */}
              <div className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 inline-flex items-center gap-3 rounded-lg bg-black/65 px-3 py-1.5 text-caption font-medium text-white shadow-lg backdrop-blur">
                <ShortcutKey>{shape === 'polygon' ? 'Click' : 'Drag'}</ShortcutKey>
                <span>{shape === 'polygon' ? 'add point' : 'draw'}</span>
                <span className="h-3 w-px bg-white/20" />
                <ShortcutKey>Z</ShortcutKey>
                <span>undo</span>
                <span className="h-3 w-px bg-white/20" />
                <ShortcutKey>Esc</ShortcutKey>
                <span>close</span>
              </div>

              {/* Empty-state hint when nothing drawn yet */}
              {pointCount === 0 ? (
                <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
                  <div className="rounded-2xl border border-white/15 bg-black/40 px-5 py-4 text-center backdrop-blur-sm">
                    <MousePointer2 className="mx-auto h-6 w-6 text-brand" strokeWidth={2} />
                    <p className="mt-2 text-body font-semibold tracking-[-0.005em] text-white">
                      Mark the area you want AI to watch
                    </p>
                    <p className="mt-1 text-caption font-medium text-white/70">
                      {shape === 'line' ? 'Drag a single straight line — AI watches the marked side'
                        : shape === 'box' ? 'Drag a box around the area to watch'
                          : 'Click 3 or more corners — close by clicking the first point'}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Side panel */}
          <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
            {/* Zones list */}
            <div className="shrink-0 border-b border-line-subtle px-4 pt-4 pb-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                  Zones <span className="ml-1 text-fg-disabled">({draftZones.length} / 8)</span>
                </p>
                <button
                  type="button"
                  onClick={addZone}
                  disabled={draftZones.length >= 8}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-caption font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" strokeWidth={2.5} />
                  Add zone
                </button>
              </div>
              <div className="space-y-1 max-h-[180px] overflow-y-auto pr-1">
                {draftZones.map((zone, index) => {
                  const ready = (zone.points?.length || 0) >= SHAPE_MIN_POINTS[zoneShape(zone.shape)];
                  const on = zone.id === activeZone?.id;
                  return (
                    <button
                      key={zone.id}
                      type="button"
                      onClick={() => setActiveId(zone.id)}
                      className={`relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition ${
                        on ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-surface-sunken'
                      }`}
                    >
                      {on ? (
                        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-brand" aria-hidden />
                      ) : null}
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md text-caption font-bold tabular-nums ${
                        on ? 'bg-brand text-white' : 'bg-surface-muted text-fg-muted'
                      }`}>
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1 leading-tight">
                        <p className={`truncate text-small font-semibold tracking-[-0.005em] ${on ? 'text-brand-ink' : 'text-fg'}`}>
                          {zone.name || `Detection Zone ${index + 1}`}
                        </p>
                        <p className="mt-0.5 truncate text-micro font-medium text-fg-muted">
                          <span className="capitalize">{zoneShape(zone.shape)}</span>
                          <span className="mx-1 text-fg-disabled">·</span>
                          {(zone.applyTo || []).join(' + ')}
                        </p>
                      </div>
                      <span className={`shrink-0 text-micro font-bold uppercase tracking-[0.08em] ${
                        ready ? 'text-success-ink' : 'text-warning-ink'
                      }`}>
                        {ready ? 'Ready' : 'Drawing'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Active-zone editor */}
            {activeZone ? (
              <div className="flex-1 overflow-y-auto px-4 py-4">
                <SectionEyebrow>Zone name</SectionEyebrow>
                <input
                  value={activeZone.name}
                  onChange={(event) => updateActive((zone) => ({ ...zone, name: event.target.value }))}
                  placeholder="e.g. Reception desk"
                  className="mt-2 h-10 w-full rounded-lg border border-line bg-surface px-3 text-body tracking-[-0.005em] outline-none transition focus:border-line-strong"
                />

                <SectionEyebrow className="mt-4">Shape</SectionEyebrow>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {SHAPE_TOOLS.map(({ key, label, Icon }) => {
                    const on = shape === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setShape(key)}
                        className={`inline-flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg border text-micro font-semibold tracking-[-0.005em] transition ${
                          on
                            ? 'border-brand bg-brand-soft text-brand-ink'
                            : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken'
                        }`}
                      >
                        <Icon className="h-4 w-4" strokeWidth={on ? 2.5 : 1.85} />
                        {label}
                      </button>
                    );
                  })}
                </div>
                {shape === 'line' ? (
                  <button
                    type="button"
                    onClick={flipSide}
                    className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken"
                  >
                    <FlipHorizontal2 className="h-3.5 w-3.5" strokeWidth={2} />
                    Flip watched side
                    <span className="ml-1 rounded bg-surface-muted px-1.5 py-0.5 text-micro font-bold uppercase tracking-[0.06em] text-fg-muted">
                      {activeZone.side}
                    </span>
                  </button>
                ) : null}

                <SectionEyebrow className="mt-4">Detect</SectionEyebrow>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  {[
                    { key: 'face',   label: 'Face',   Icon: ScanFace },
                    { key: 'person', label: 'Person', Icon: Users },
                  ].map(({ key, label, Icon }) => {
                    const on = activeZone.applyTo.includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleApply(key)}
                        className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border text-small font-semibold tracking-[-0.005em] transition ${
                          on
                            ? 'border-slate-950 bg-slate-950 text-white dark:border-fg dark:bg-fg dark:text-fg-inverse'
                            : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" strokeWidth={on ? 2.25 : 1.85} />
                        {label}
                      </button>
                    );
                  })}
                </div>

                <SectionEyebrow className="mt-4">Drawing</SectionEyebrow>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={undoPoint}
                    disabled={pointCount === 0}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-surface text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                  >
                    <Undo2 className="h-3.5 w-3.5" strokeWidth={2} />
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={clearPoints}
                    disabled={pointCount === 0}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-surface text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                    Clear
                  </button>
                </div>

                {/* Point counter card */}
                <div className={`mt-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                  isReady ? 'border-success-line bg-success-soft' : pointCount === 0 ? 'border-line bg-surface-sunken' : 'border-warning-line bg-warning-soft'
                }`}>
                  <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md text-caption font-bold tabular-nums ${
                    isReady ? 'bg-success text-white' : pointCount === 0 ? 'bg-line-strong text-white' : 'bg-warning text-white'
                  }`}>
                    {pointCount}
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className={`text-small font-semibold tracking-[-0.005em] ${
                      isReady ? 'text-success-ink' : pointCount === 0 ? 'text-fg-secondary' : 'text-warning-ink'
                    }`}>
                      {isReady
                        ? `${shape === 'line' ? 'Line' : shape === 'box' ? 'Box' : 'Polygon'} ready`
                        : shape === 'line' ? 'No line yet'
                          : shape === 'box' ? 'No box yet'
                            : pointCount === 0 ? 'No points yet' : `${3 - pointCount} more to go`}
                    </p>
                    <p className={`mt-0.5 text-caption leading-[1.5] ${
                      isReady ? 'text-success-ink' : pointCount === 0 ? 'text-fg-muted' : 'text-warning-ink'
                    }`}>
                      {isReady
                        ? 'Click "Save zones" to apply this area, or redraw.'
                        : shape === 'line' ? 'Drag once across the frame to set the boundary.'
                          : shape === 'box' ? 'Drag from one corner to the opposite corner.'
                            : 'Detection zones need at least 3 points to define an area.'}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={deleteActive}
                  className="mt-4 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-danger-line bg-surface text-small font-semibold tracking-[-0.005em] text-danger-ink transition hover:bg-danger-soft"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                  Delete this zone
                </button>
              </div>
            ) : (
              <div className="flex-1 grid place-items-center px-6 text-center text-small font-medium text-fg-muted">
                Add a zone to start drawing.
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

