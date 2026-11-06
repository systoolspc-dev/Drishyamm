// Wall editor — the display, drawn at the shape of this screen, with one page
// of the layout on it. Tiles are STILLS (see useSnapshot), so building a wall
// doesn't hold a stream per tile open against the recorders; only the tile
// under the pointer plays live, and only once the pointer has settled on it.

import { useEffect, useRef, useState } from 'react';
import {
  Eraser, GripVertical, Pencil, Plus, RotateCw, Undo2, VideoOff, WandSparkles, X,
} from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { playerQuality } from '@/core/lib/utils';
import { useSnapshot } from '@/core/hooks/useSnapshot';
import { DND_CAMERA, DND_SLOT, lastSeen, pad2 } from './model';

const LIVE_DWELL_MS = 600;
const QUALITY_LABEL = { low: 'SUB', high: 'MAIN', auto: 'AUTO' };

export default function WallEditor({
  draft, page, onPage, selected, onSelect, byId, dirty, display, playCount, notice,
  onRename, onAutoFill, canAutoFill, onClearPage, onPlace, onSwap, onClearSlot, onAddPage, onRemovePage, canAddPage,
}) {
  const [editingName, setEditingName] = useState(false);
  const slots = draft.pages[page] || [];
  const emptyHere = slots.filter((id) => !id).length;

  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {editingName ? (
              <NameInput
                value={draft.name}
                onDone={(name) => { setEditingName(false); if (name) onRename(name); }}
              />
            ) : (
              <>
                <h2 className="truncate text-heading text-fg">{draft.name}</h2>
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  title="Rename layout"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {dirty && (
              <span className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border border-warning-line bg-warning-soft px-2 text-caption font-semibold text-warning-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                Unsaved changes
              </span>
            )}
          </div>
          {notice && (
            <p className="mt-1 flex items-center gap-2 text-small text-fg-muted">
              <span className="text-fg-secondary">{notice.text}</span>
              {notice.onUndo && (
                <button type="button" onClick={notice.onUndo} className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">
                  <Undo2 className="h-3.5 w-3.5" />
                  Undo
                </button>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToolButton icon={WandSparkles} onClick={onAutoFill} disabled={!canAutoFill} title="Fill the empty tiles with online cameras that aren't on the wall yet — this page first, then the pages after it, adding pages while cameras are left">
            Auto fill
          </ToolButton>
          <ToolButton icon={Eraser} onClick={onClearPage} disabled={emptyHere === slots.length} title="Empty every tile on this page">
            Clear page
          </ToolButton>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-micro uppercase text-fg-muted">
          Page {page + 1} of {draft.pages.length}
        </span>
      </div>

      <div
        className="mt-2.5 grid w-full gap-1 rounded-[10px] bg-black p-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.09),0_0_0_4px_rgba(255,255,255,0.025)]"
        style={{
          aspectRatio: `${display.w} / ${display.h}`,
          gridTemplateColumns: `repeat(${draft.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${draft.rows}, minmax(0, 1fr))`,
        }}
      >
        {slots.map((monitorId, slot) => (
          <EditorTile
            key={`${page}:${slot}`}
            page={page}
            slot={slot}
            monitorId={monitorId}
            camera={monitorId ? byId.get(monitorId) : null}
            selected={selected?.page === page && selected?.slot === slot}
            onSelect={onSelect}
            onPlace={onPlace}
            onSwap={onSwap}
            onClear={onClearSlot}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5">
          {draft.pages.map((ids, i) => (
            <PageCard
              key={i}
              index={i}
              ids={ids}
              cols={draft.cols}
              rows={draft.rows}
              byId={byId}
              active={i === page}
              selectedSlot={selected?.page === i ? selected.slot : null}
              onOpen={() => onPage(i)}
              onRemove={draft.pages.length > 1 ? () => onRemovePage(i) : null}
            />
          ))}
          {canAddPage && (
            <button
              type="button"
              onClick={onAddPage}
              className="inline-flex h-[52px] shrink-0 items-center gap-1.5 rounded-[10px] border border-dashed border-line-strong px-3.5 text-small font-semibold text-fg-muted transition-colors hover:border-brand-line hover:text-brand"
            >
              <Plus className="h-3.5 w-3.5" />
              Add page
            </button>
          )}
        </div>
        <RotationSummary draft={draft} playCount={playCount} />
      </div>
    </section>
  );
}

function NameInput({ value, onDone }) {
  const [text, setText] = useState(value);
  const ref = useRef(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      value={text}
      maxLength={120}
      aria-label="Layout name"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(text.trim());
        if (e.key === 'Escape') onDone('');
      }}
      className="h-7 w-64 rounded-md border border-brand/40 bg-surface-sunken px-2 text-heading text-fg outline-none ring-1 ring-brand/30"
    />
  );
}

function ToolButton({ icon: Icon, children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary transition hover:border-brand-line hover:bg-brand-soft hover:text-brand disabled:pointer-events-none disabled:opacity-45"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function readDrop(e) {
  const cam = e.dataTransfer.getData(DND_CAMERA);
  if (cam) return { kind: 'camera', monitorId: cam };
  const raw = e.dataTransfer.getData(DND_SLOT);
  if (raw) {
    try { return { kind: 'slot', from: JSON.parse(raw) }; } catch { return null; }
  }
  return null;
}

const acceptsDrop = (e) => e.dataTransfer.types.includes(DND_CAMERA) || e.dataTransfer.types.includes(DND_SLOT);

function EditorTile({ page, slot, monitorId, camera, selected, onSelect, onPlace, onSwap, onClear }) {
  const [hover, setHover] = useState(false);
  const [live, setLive] = useState(false);
  const [dropping, setDropping] = useState(false);
  const dwell = useRef(null);
  const online = camera?.status === 'online';
  const snap = useSnapshot(online ? monitorId : null);
  const at = { page, slot };
  const num = pad2(slot + 1);

  useEffect(() => () => clearTimeout(dwell.current), []);

  const enter = () => {
    setHover(true);
    if (!online) return;
    clearTimeout(dwell.current);
    dwell.current = setTimeout(() => setLive(true), LIVE_DWELL_MS);
  };
  const leave = () => {
    clearTimeout(dwell.current);
    setHover(false);
    setLive(false);
  };

  const dropProps = {
    onDragOver: (e) => { if (acceptsDrop(e)) { e.preventDefault(); setDropping(true); } },
    onDragLeave: () => setDropping(false),
    onDrop: (e) => {
      e.preventDefault();
      setDropping(false);
      const d = readDrop(e);
      if (d?.kind === 'camera') onPlace(page, slot, d.monitorId);
      if (d?.kind === 'slot' && (d.from.page !== page || d.from.slot !== slot)) onSwap(d.from, at);
    },
  };

  if (!monitorId) {
    return (
      <button
        type="button"
        onClick={() => onSelect(selected ? null : at)}
        {...dropProps}
        className={`relative flex min-h-0 items-center justify-center gap-1.5 rounded-[5px] border border-dashed text-caption font-semibold transition-colors ${selected
          ? 'border-brand bg-brand/10 text-brand shadow-[0_0_0_3px_rgba(247,152,58,0.25)]'
          : dropping
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-white/20 bg-white/[0.015] text-white/55 hover:border-white/35 hover:text-white/80'}`}
      >
        <span className="absolute left-1 top-1 text-micro text-white/30">{num}</span>
        <Plus className="h-3.5 w-3.5" />
        Add camera
      </button>
    );
  }

  const quality = QUALITY_LABEL[playerQuality(camera, 'low')] || 'SUB';
  const time = snap?.at ? snap.at.toLocaleTimeString('en-GB') : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Slot ${num}: ${camera?.name || 'camera not available'}${selected ? ', selected' : ''}`}
      draggable
      onDragStart={(e) => {
        leave();
        e.dataTransfer.setData(DND_SLOT, JSON.stringify(at));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onSelect(selected ? null : at)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected ? null : at); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onClear(page, slot); }
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      {...dropProps}
      className={`group relative min-h-0 cursor-pointer overflow-hidden rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-brand ${!camera
        ? 'bg-warning/10'
        : online ? 'bg-neutral-900' : 'bg-linear-to-br from-danger/45 to-neutral-950'} ${selected ? 'shadow-[0_0_0_3px_rgba(247,152,58,0.28)]' : ''}`}
    >
      {camera && online && (live ? (
        <DirectStreamPlayer
          monitorId={monitorId}
          mode="webrtc"
          quality={playerQuality(camera, 'low')}
          muted
          controls={false}
          qualityControl={false}
          protocolBadge={false}
          aiOverlay={false}
          digitalZoom={false}
          fit="cover"
          className="absolute inset-0 h-full w-full"
        />
      ) : snap?.url ? (
        <img src={snap.url} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-caption text-white/40">
          {snap?.error ? 'No still yet' : 'Loading still…'}
        </span>
      ))}

      {camera && !online && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 pb-3 text-center">
          <VideoOff className="mb-0.5 h-4 w-4 text-danger-ink" />
          <span className="text-micro text-danger-ink">OFFLINE</span>
          {lastSeen(camera.lastSeenAt) && (
            <span className="text-caption tabular-nums text-white/60">Last seen {lastSeen(camera.lastSeenAt)}</span>
          )}
        </div>
      )}

      {!camera && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-2 pb-3 text-center">
          <span className="text-caption font-semibold text-warning-ink">Camera not available</span>
          <span className="text-caption text-white/55">Removed, or no longer in your camera list</span>
        </div>
      )}

      {(dropping || (hover && !selected)) && (
        <span aria-hidden className={`pointer-events-none absolute inset-0 rounded-[5px] ${dropping ? 'shadow-[inset_0_0_0_2px] shadow-brand' : 'shadow-[inset_0_0_0_1.5px_rgba(255,255,255,0.6)]'}`} />
      )}
      {selected && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[5px] shadow-[inset_0_0_0_2px] shadow-brand" />}

      <div className="pointer-events-none absolute left-1 top-1 flex items-center gap-1">
        <span className="grid h-4 min-w-[21px] place-items-center rounded bg-black/60 px-1 text-caption font-bold tabular-nums text-white">{num}</span>
        {hover && (
          <span className="grid h-4 w-4 place-items-center rounded bg-black/65 text-white" title="Drag to move or swap">
            <GripVertical className="h-3 w-3" />
          </span>
        )}
      </div>

      <div className="absolute right-1 top-1 flex items-center gap-1">
        {selected ? (
          <span className="pointer-events-none grid h-4 place-items-center rounded bg-brand px-1.5 text-micro text-white">SELECTED</span>
        ) : live ? (
          <span className="pointer-events-none inline-flex h-4 items-center gap-1 rounded bg-danger px-1.5 text-micro text-white">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
            LIVE · {quality}
          </span>
        ) : time && !hover ? (
          <span
            className={`pointer-events-none grid h-4 place-items-center rounded bg-black/50 px-1 text-caption font-medium tabular-nums ${snap.stale ? 'text-warning-ink' : 'text-white/80'}`}
            title={snap.stale ? 'The latest still failed; this one is older' : 'When this still was taken'}
          >
            {time}
          </span>
        ) : null}
        {hover && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClear(page, slot); }}
            title="Remove from this slot"
            className="grid h-4 w-4 place-items-center rounded bg-black/65 text-white transition-colors hover:bg-danger"
          >
            <X className="h-3 w-3" strokeWidth={2.5} />
          </button>
        )}
      </div>

      {camera && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-linear-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
          <span className="truncate text-caption font-semibold text-white">{camera.name}</span>
        </div>
      )}
    </div>
  );
}

function PageCard({ index, ids, cols, rows, byId, active, selectedSlot, onOpen, onRemove }) {
  const count = ids.filter(Boolean).length;
  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={`flex h-[52px] items-center gap-2.5 rounded-[10px] border pl-2 pr-3.5 text-left transition-colors ${active
          ? 'border-brand-line bg-brand-soft'
          : 'border-line bg-surface-sunken/40 hover:border-line-strong'}`}
      >
        <span
          className="grid h-[30px] w-[52px] gap-px rounded bg-black p-0.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
          {ids.map((id, i) => {
            const cam = id ? byId.get(id) : null;
            const cls = i === selectedSlot ? 'bg-brand'
              : !id ? 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]'
                : !cam ? 'bg-warning/60'
                  : cam.status === 'online' ? 'bg-slate-300/40' : 'bg-danger/75';
            return <i key={i} className={`rounded-[1px] ${cls}`} />;
          })}
        </span>
        <span>
          <span className="block text-small font-semibold text-fg">Page {index + 1}</span>
          <span className="block text-caption tabular-nums text-fg-muted">{count} camera{count === 1 ? '' : 's'}</span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={`Remove page ${index + 1}`}
          className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 place-items-center rounded-full border border-line bg-surface text-fg-muted shadow-sm transition-colors hover:text-danger-ink group-hover:grid"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function duration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

function RotationSummary({ draft, playCount }) {
  const title = playCount < 2
    ? 'One page'
    : !draft.rotate ? 'Rotation off' : `Rotates every ${duration(draft.rotateSeconds)}`;
  return (
    <div className="shrink-0 text-right">
      <p className="flex items-center justify-end gap-1.5 text-small font-semibold text-fg-secondary">
        {draft.rotate && playCount > 1 && <RotateCw className="h-3.5 w-3.5 text-brand" />}
        {title}
      </p>
    </div>
  );
}
