// Camera library — every camera on the account, grouped by recorder (Cameras
// tab) or by site › recorder (Sites tab). A row says where the camera already
// is on the wall: an orange slot badge on this page, a grey P2 on another
// page. Click or drag a row onto the wall; hovering one for a moment plays it
// live beside the list.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Building2, Camera, Cctv, ChevronDown, ChevronRight, Grid2x2, Layers, Plus,
  RefreshCw, Replace, Search, X,
} from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { playerQuality } from '@/core/lib/utils';
import { DND_CAMERA, locate, pad2 } from './model';

const TAB_KEY = 'monitorWall.libraryTab';
// A hover has to settle before the preview opens: sweeping the pointer down
// the list must not start a stream per row (each one pulls from a recorder).
const PREVIEW_DWELL_MS = 700;

const readTab = () => {
  try { return localStorage.getItem(TAB_KEY) === 'sites' ? 'sites' : 'cameras'; } catch { return 'cameras'; }
};

export default function CameraLibrary({
  cameras, groups, sites, draft, page, selected, selectedCamera,
  onPick, onSelectSlot, onCancelFill, onRefresh, refreshing,
}) {
  const [tab, setTab] = useState(readTab);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const searchRef = useRef(null);
  const cardRef = useRef(null);
  const dwell = useRef(null);

  useEffect(() => { try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ } }, [tab]);

  // "/" jumps to the search box, as in most operator tools.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => clearTimeout(dwell.current), []);

  const online = useMemo(() => cameras.filter((c) => c.status === 'online').length, [cameras]);
  const counts = { all: cameras.length, online, offline: cameras.length - online };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cameras.filter((c) => {
      if (status === 'online' && c.status !== 'online') return false;
      if (status === 'offline' && c.status === 'online') return false;
      if (!q) return true;
      return [c.name, c.groupName, c.siteName, c.location].some((v) => v && v.toLowerCase().includes(q));
    });
  }, [cameras, query, status]);

  const tree = useMemo(() => {
    const byGroup = new Map();
    for (const c of visible) {
      if (!byGroup.has(c.groupId)) byGroup.set(c.groupId, []);
      byGroup.get(c.groupId).push(c);
    }
    const groupNodes = groups
      .filter((g) => byGroup.has(g.id))
      .map((g) => ({ kind: 'group', key: `g:${g.id}`, name: g.name, siteId: g.siteId || null, cameras: byGroup.get(g.id) }));
    if (tab === 'cameras') return groupNodes;

    const bySite = new Map();
    for (const g of groupNodes) {
      const k = g.siteId || '__none__';
      if (!bySite.has(k)) bySite.set(k, []);
      bySite.get(k).push(g);
    }
    const nodes = sites
      .filter((s) => bySite.has(s.id))
      .map((s) => ({ kind: 'site', key: `s:${s.id}`, name: s.name, groups: bySite.get(s.id) }));
    if (bySite.has('__none__')) nodes.push({ kind: 'site', key: 's:none', name: 'Unassigned', unassigned: true, groups: bySite.get('__none__') });
    return nodes;
  }, [visible, groups, sites, tab]);

  const searching = query.trim() !== '';
  const isOpen = (key) => searching || !collapsed.has(key);
  const toggle = (key) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const startPreview = (camera, rowEl) => {
    clearTimeout(dwell.current);
    if (camera.status !== 'online') { setPreview(null); return; }
    dwell.current = setTimeout(() => {
      const row = rowEl.getBoundingClientRect();
      const card = cardRef.current?.getBoundingClientRect();
      setPreview({ camera, top: row.top + row.height / 2, left: (card?.right ?? row.right) + 10 });
    }, PREVIEW_DWELL_MS);
  };
  const stopPreview = () => { clearTimeout(dwell.current); setPreview(null); };

  const rowProps = {
    draft, page, selected,
    fillSlot: selected && selected.page === page ? selected.slot : null,
    selectedId: selectedCamera?.monitorId,
    onPick: (c) => { stopPreview(); onPick(c); },
    onSelectSlot,
    onHover: startPreview,
    onLeave: stopPreview,
  };

  return (
    <section ref={cardRef} className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between px-0.5">
        <h2 className="text-heading text-fg">
          Camera library <span className="font-medium text-fg-muted">({cameras.length})</span>
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          title="Refresh cameras"
          className="grid h-7 w-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-brand-soft hover:text-brand"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="tablist" aria-label="Group cameras by">
        {[{ id: 'cameras', label: 'Cameras', Icon: Cctv }, { id: 'sites', label: 'Sites', Icon: Building2 }].map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md border text-small transition ${tab === id
              ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
              : 'border-transparent font-medium text-fg-muted hover:bg-surface/70 hover:text-fg'}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-muted/50 pl-2.5 pr-1.5 transition focus-within:border-brand/40 focus-within:ring-1 focus-within:ring-brand/40">
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }}
          placeholder="Search cameras…"
          className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-muted/60"
        />
        {query ? (
          <button type="button" onClick={() => setQuery('')} title="Clear search" className="grid h-5 w-5 place-items-center rounded text-fg-muted hover:text-fg">
            <X className="h-3 w-3" />
          </button>
        ) : (
          <kbd className="grid h-5 min-w-5 place-items-center rounded border border-line-strong px-1 text-caption text-fg-muted">/</kbd>
        )}
      </label>

      <div className="flex items-center gap-1">
        {[
          { id: 'all', label: 'All' },
          { id: 'online', label: 'Online', dot: 'bg-success' },
          { id: 'offline', label: 'Offline', dot: 'bg-danger' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={status === f.id}
            onClick={() => setStatus(f.id)}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-small font-semibold transition-colors ${status === f.id
              ? 'bg-brand/10 text-brand ring-1 ring-brand/25'
              : 'text-fg-muted hover:bg-surface-muted hover:text-fg'}`}
          >
            {f.dot && <span className={`h-1.5 w-1.5 rounded-full ${f.dot}`} />}
            {f.label}
            <span className="tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="flex items-start gap-2 rounded-lg border border-brand-line bg-brand-soft py-2 pl-2.5 pr-1.5">
          <Replace className="mt-px h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <p className="text-small font-bold text-brand-ink">
              Filling slot {pad2(selected.slot + 1)}{draft.pages.length > 1 ? ` on page ${selected.page + 1}` : ''}
            </p>
            <p className="truncate text-small text-fg-secondary">
              {selectedCamera
                ? <>Pick a camera to replace <span className="font-semibold text-fg">{selectedCamera.name}</span></>
                : draft.pages[selected.page]?.[selected.slot]
                  ? 'Pick a camera to replace the unavailable one'
                  : 'Pick a camera for this empty slot'}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelFill}
            title="Stop filling this slot (Esc)"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" onScroll={stopPreview}>
        {cameras.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <Camera className="mx-auto mb-2 h-8 w-8 text-fg-muted/30" />
            <p className="text-body font-medium text-fg-muted">No cameras yet</p>
            <Link to="/camera-setup" className="mt-1 inline-block text-small font-semibold text-brand hover:underline">Add cameras</Link>
          </div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <p className="text-body font-medium text-fg-muted">No cameras match</p>
            <button type="button" onClick={() => { setQuery(''); setStatus('all'); }} className="mt-1 text-small font-semibold text-brand hover:underline">
              Show all cameras
            </button>
          </div>
        ) : tree.map((node) => (node.kind === 'site' ? (
          <div key={node.key}>
            <BranchRow
              open={isOpen(node.key)}
              onToggle={() => toggle(node.key)}
              icon={node.unassigned ? Layers : Building2}
              muted={node.unassigned}
              name={node.name}
              count={node.groups.reduce((n, g) => n + g.cameras.length, 0)}
              strong
            />
            {isOpen(node.key) && node.groups.map((g) => (
              <GroupBranch key={g.key} group={g} indent open={isOpen(g.key)} onToggle={() => toggle(g.key)} rowProps={rowProps} />
            ))}
          </div>
        ) : (
          <GroupBranch key={node.key} group={node} open={isOpen(node.key)} onToggle={() => toggle(node.key)} rowProps={rowProps} />
        )))}
      </div>

      {preview && createPortal(<LivePreview {...preview} />, document.body)}
    </section>
  );
}

function BranchRow({ open, onToggle, icon: Icon, muted, name, count, strong, indent }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left transition-colors hover:bg-surface-muted/60 ${indent ? 'pl-5' : 'pl-1.5'}`}
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" />
      {Icon && (
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md ${muted ? 'bg-surface-muted text-fg-muted' : 'bg-brand/15 text-brand'}`}>
          <Icon className="h-3 w-3" />
        </span>
      )}
      <span className={`min-w-0 flex-1 truncate text-body ${strong ? 'font-bold text-fg' : 'font-semibold text-fg-secondary'}`}>{name}</span>
      <span className="shrink-0 text-small font-semibold tabular-nums text-fg-muted">{count}</span>
    </button>
  );
}

function GroupBranch({ group, indent, open, onToggle, rowProps }) {
  return (
    <div>
      <BranchRow open={open} onToggle={onToggle} name={group.name} count={group.cameras.length} indent={indent} strong={!indent} />
      {open && (
        <div className={`relative ${indent ? 'ml-5' : 'ml-1.5'}`}>
          <span aria-hidden className="absolute bottom-1 left-[13px] top-0 w-px bg-line" />
          {group.cameras.map((c) => <CameraRow key={c.monitorId} camera={c} {...rowProps} />)}
        </div>
      )}
    </div>
  );
}

function CameraRow({ camera, draft, page, fillSlot, selectedId, onPick, onSelectSlot, onHover, onLeave }) {
  const at = locate(draft, camera.monitorId);
  const isSelected = selectedId === camera.monitorId;
  const online = camera.status === 'online';

  let right;
  if (at && at.page === page) {
    right = (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelectSlot(at); }}
        title={`Slot ${pad2(at.slot + 1)} on this page. Click to select the tile.`}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-brand/10 px-1.5 text-caption font-bold tabular-nums text-brand transition-colors hover:bg-brand/20"
      >
        <Grid2x2 className="h-3 w-3" />
        {pad2(at.slot + 1)}
      </button>
    );
  } else if (at) {
    right = (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelectSlot(at); }}
        title={`On page ${at.page + 1}, slot ${pad2(at.slot + 1)}. Click to go there.`}
        className="inline-flex h-5 shrink-0 items-center rounded-md bg-surface-muted px-1.5 text-caption font-bold tabular-nums text-fg-muted transition-colors hover:text-fg"
      >
        P{at.page + 1}
      </button>
    );
  } else {
    right = (
      <span className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md bg-brand px-1.5 text-caption font-bold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <Plus className="h-3 w-3" strokeWidth={2.5} />
        {fillSlot != null ? `Put in ${pad2(fillSlot + 1)}` : 'Add'}
      </span>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        onLeave();
        e.dataTransfer.setData(DND_CAMERA, camera.monitorId);
        e.dataTransfer.setData('text/plain', camera.name);
        e.dataTransfer.effectAllowed = 'copyMove';
      }}
      onClick={() => onPick(camera)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(camera); } }}
      onMouseEnter={(e) => onHover(camera, e.currentTarget)}
      onMouseLeave={onLeave}
      title={online ? undefined : 'Offline — it will show as a red tile'}
      className={`group relative flex h-7 cursor-pointer items-center gap-2 rounded-lg pl-6 pr-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 ${isSelected
        ? 'bg-brand/10 ring-1 ring-inset ring-brand/25'
        : 'hover:bg-surface-muted/70'}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-success shadow-[0_0_0_2px] shadow-success/20' : 'bg-danger shadow-[0_0_0_2px] shadow-danger/20'}`} />
      <span className={`min-w-0 flex-1 truncate text-body ${isSelected ? 'font-semibold text-brand' : online ? 'font-medium text-fg' : 'font-medium text-fg-muted'}`}>
        {camera.name}
      </span>
      {right}
    </div>
  );
}

function LivePreview({ camera, top, left }) {
  const where = [camera.location || camera.siteName, camera.groupName, camera.channel ? `Ch ${camera.channel}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      role="tooltip"
      style={{ top, left }}
      className="pointer-events-none fixed z-50 w-60 -translate-y-1/2 rounded-xl border border-tooltip-line bg-tooltip p-1.5 shadow-[var(--tooltip-shadow)] backdrop-blur"
    >
      <span aria-hidden className="absolute -left-[6px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-b border-l border-tooltip-line bg-tooltip" />
      <div className="relative aspect-video overflow-hidden rounded-lg bg-neutral-950">
        <DirectStreamPlayer
          monitorId={camera.monitorId}
          mode="webrtc"
          quality={playerQuality(camera, 'low')}
          muted
          controls={false}
          qualityControl={false}
          protocolBadge={false}
          aiOverlay={false}
          digitalZoom={false}
          className="h-full w-full"
        />
        <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded bg-danger/90 px-1.5 py-0.5 text-micro text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
          LIVE PREVIEW
        </span>
      </div>
      <div className="px-1 pb-0.5 pt-1.5">
        <p className="truncate text-body font-semibold text-fg">{camera.name}</p>
        {where && <p className="truncate text-caption text-fg-muted">{where}</p>}
      </div>
    </div>
  );
}
