import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { releaseAllStreams } from '@/core/services/streamCache';
import { fullscreenQuality, playerQuality } from '@/core/lib/utils';
import { Badge } from '@/core/ui/badge';
import { useGroups } from '@/core/hooks/useQueries';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { siteService } from '@/core/services/site';
import { cameraGroupService } from '@/core/services/cameraGroup';
import {
  OperationsPage,
  PageCard,
  PageContent,
} from '@/core/layout/OperationsPage';
import { RequireCameras } from '@/core/components/RequireCameras';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { setWarmHints } from '@/core/hooks/useStreamPrewarm';
import TalkBackPanel from '@/core/components/TalkBackPanel';
import {
  Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle,
  Grid2X2, Grid3X3, LayoutGrid, Maximize2, Minimize2, Monitor, RefreshCw, Search,
  Cctv, Video, X, List, Volume2, VolumeX, Tv,
  Pause, Play, MoreVertical, Building2, ImageDown, MonitorPlay,
  MapPin, HardDrive, Radio, Clock, Move, ZoomIn, Focus, Activity,
  History, VideoOff, Info, Mic, PanelRight,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { NVR_PULL_LIMIT, SESSIONS_PER_CAMERA } from './monitor-wall/model';

// Layout configs. This picker is the ONLY thing that decides how many tiles are
// on screen - "Single" is just the one-tile layout. There used to be a second
// Single / Multi-View toggle in the top bar that could disagree with it (pick
// 2 x 3 in the sidebar, then Single up top, and the two controls both looked
// active), so the toggle is gone and this moved next to the video instead.
const LAYOUTS = [
  { id: 1, label: 'Single', icon: Monitor,    cols: 1, rows: 1 },
  { id: 4, label: '2 × 2',  icon: Grid2X2,    cols: 2, rows: 2 },
  { id: 6, label: '2 × 3',  icon: LayoutGrid, cols: 3, rows: 2 },
  { id: 9, label: '3 × 3',  icon: Grid3X3,    cols: 3, rows: 3 },
];

// How Multi View was left, per browser: open or not, at which density, on
// which page. A guard who reloads lands on the same page of cameras.
const GRID_KEY = 'liveView.grid';

function readSavedGrid() {
  try {
    const v = JSON.parse(localStorage.getItem(GRID_KEY) || 'null');
    const layoutId = LAYOUTS.some(l => l.id > 1 && l.id === v?.layoutId) ? v.layoutId : 4;
    const page = Number.isInteger(v?.page) && v.page >= 0 ? v.page : 0;
    return { multi: v?.multi === true, layoutId, page };
  } catch {
    return { multi: false, layoutId: 4, page: 0 };
  }
}

// Multi View is automatic: the cameras the list shows, in the order it shows
// them, cut into pages of `slots`. Nobody picks cameras here - with fifty of
// them that is a chore for someone in a hurry, and a wall worth keeping is
// Monitor Wall's job. No page pushes a recorder past its stream limit (see
// monitor-wall/model.js for the incident that set it): a camera that would
// waits for the next page, and the cameras after it that do fit still fill
// this one, so pages stay as full as the recorders allow and the order stays
// readable. Offline cameras cost nothing - an offline tile has no player.
function buildPages(cameras, slots) {
  if (slots < 1) return [[]];
  const pages = [];
  let remaining = cameras;
  while (remaining.length) {
    const page = [];
    const load = new Map();
    const deferred = [];
    for (const c of remaining) {
      if (page.length >= slots) { deferred.push(c); continue; }
      if (c.status === 'online') {
        const next = (load.get(c.groupId) || 0) + SESSIONS_PER_CAMERA;
        if (next > NVR_PULL_LIMIT) { deferred.push(c); continue; }
        load.set(c.groupId, next);
      }
      page.push(c);
    }
    // A camera always fits an empty page under the current limits; this only
    // guards the loop if the limits are ever set below one camera.
    if (!page.length) page.push(deferred.shift());
    pages.push(page);
    remaining = deferred;
  }
  return pages.length ? pages : [[]];
}

// Sidebar status filter. The chip is the count AND the filter - with a few
// hundred cameras "which ones are down" is the question the list gets asked
// most, and it used to take scrolling every group to answer.

const STATUS_FILTERS = [
  { id: 'all',     label: 'All' },
  { id: 'online',  label: 'Online' },
  { id: 'offline', label: 'Offline' },
];

// Status Dot
function StatusDot({ status }) {
  return status === 'online'
    ? <span className="w-2 h-2 rounded-full bg-success shadow-[0_0_6px_rgba(16,185,129,0.6)] shrink-0" />
    : <span className="w-2 h-2 rounded-full bg-neutral-500/40 shrink-0" />;
}

// playerQuality (maps a camera's saved auto/main/sub preference to the player's
// quality prop) now lives in core/lib/utils so the wall and the grid can't drift
// apart on what "the camera is set to Sub" means.

// Live timestamp for the video overlays. The single view used to call
// `new Date()` inline while rendering, so the stamp froze at whatever second
// the component last happened to re-render - it read like a live clock and
// wasn't one. Kept as its own leaf component so the 1s tick re-renders this
// text only, never the players underneath it.
function TileClock({ className = '' }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  // 24-hour, day-month-year: unambiguous when a frame is used as evidence.
  return (
    <span className={`tabular-nums ${className}`}>
      {now.toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })}
    </span>
  );
}

// Grid Tile
// mode='webrtc': grid cameras play over WebRTC (low latency, and it sidesteps
// the HLS muxer that black-screens on some cameras' frame reordering). WebRTC
// falls back to HLS on its own if a tile can't establish.
//
// The tile carries `data-cam-id` so the selection bar at the bottom of the page
// can find each tile's <video> element for snapshot and clip capture, without
// every player in the app having to start forwarding a ref upward.
function GridTile({
  camera, onExpand, muted, onToggleMute, paused, onTogglePause,
  onSnapshot, onOpenPlayback, onSelect, recording,
}) {
  const boxRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const online = camera?.status === 'online';

  // This tile is the fullscreen element → play main instead of the grid sub.
  const [tileFs, setTileFs] = useState(false);
  useEffect(() => {
    const onFs = () => setTileFs(!!boxRef.current && document.fullscreenElement === boxRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Pause/play is applied straight to the media element. There is no `paused`
  // prop on the player, and adding one would touch a component six other pages
  // render, so the tile drives its own <video> instead.
  useEffect(() => {
    const v = boxRef.current?.querySelector('video');
    if (!v) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen]);

  const fullscreenTile = () => {
    const el = boxRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  return (
    <div
      ref={boxRef}
      data-cam-id={camera?.id}
      onClick={() => onSelect?.(camera)}
      onDoubleClick={() => onExpand(camera)}
      className="group relative h-full cursor-pointer overflow-hidden rounded-xl bg-neutral-950 ring-1 ring-white/6"
    >
      {online ? (
        <DirectStreamPlayer
          monitorId={camera?.monitorId}
          mode="webrtc"
          quality={tileFs ? fullscreenQuality(camera) : playerQuality(camera, 'low')}
          muted={muted}
          controls={false}
          qualityControl={false}   /* grid uses the saved quality; gear is on single view */
          aiOverlay={false}
          digitalZoom={false}
          protocolBadge={false}    /* the clock owns the top-right corner here */
          className="w-full h-full"
        />
      ) : (
        /* An offline camera keeps its slot - a tile that vanished would read
           as "someone removed it" - and says when it was last seen. Details
           open the single view, where the camera panel lives. */
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-linear-to-br from-danger/15 to-neutral-950 px-4 text-center">
          <VideoOff className="h-6 w-6 text-danger" />
          <p className="text-small font-semibold text-white">Camera is offline</p>
          <p className="text-caption text-white/55">
            {relativeTime(camera?.lastSeenAt) ? `Last seen ${relativeTime(camera.lastSeenAt)}` : 'Not seen recently'}
          </p>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onExpand(camera); }}
            className="mt-1.5 rounded-lg border border-white/20 px-3 py-1.5 text-caption font-semibold text-white transition-colors hover:bg-white/10"
          >
            View details
          </button>
        </div>
      )}

      {/* Identity strip. Name, live state and clock are ALWAYS on screen - a
          wall you have to hover to identify is a wall you can't scan. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-linear-to-b from-black/70 to-transparent px-2.5 py-2">
        <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/45 px-2 py-1">
          <span className="truncate text-small font-semibold text-white">{camera?.name}</span>
          {online ? (
            <span className="ml-0.5 flex shrink-0 items-center gap-1 text-caption font-bold tracking-widest text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />LIVE
            </span>
          ) : (
            <span className="ml-0.5 flex shrink-0 items-center gap-1 text-caption font-bold tracking-widest text-danger">
              <span className="h-1.5 w-1.5 rounded-full bg-danger" />OFFLINE
            </span>
          )}
          {recording && (
            <span className="ml-0.5 flex shrink-0 items-center gap-1 text-caption font-bold tracking-widest text-danger">
              <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />REC
            </span>
          )}
          {/* Grid tiles start muted, so the one tile you can hear is worth
              marking where the eye already is. */}
          {online && !muted && <Volume2 className="h-3.5 w-3.5 shrink-0 text-brand" aria-label="Sound on" />}
        </span>
        {online && (
          <TileClock className="hidden shrink-0 rounded-md bg-black/45 px-2 py-1 text-caption font-medium text-white/75 sm:inline-block" />
        )}
      </div>

      {/* Hover control bar. Clicks here belong to the buttons, not the tile -
          a quick double-tap on mute must not open the single view. */}
      <div
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 bottom-0 flex cursor-default items-center justify-between gap-2 bg-linear-to-t from-black/80 to-transparent px-2.5 py-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
      >
        <div className="flex items-center gap-1">
          {online && (
            <>
              <TileBtn onClick={onTogglePause} title={paused ? 'Play' : 'Pause'}>
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </TileBtn>
              <TileBtn onClick={onToggleMute} title={muted ? 'Unmute' : 'Mute'}>
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </TileBtn>
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          {online && (
            <>
              <TileBtn onClick={() => onSnapshot(camera)} title="Save a still">
                <ImageDown className="h-3.5 w-3.5" />
              </TileBtn>
              <TileBtn onClick={fullscreenTile} title="Fullscreen this tile">
                <Maximize2 className="h-3.5 w-3.5" />
              </TileBtn>
            </>
          )}
          <div className="relative">
            <TileBtn onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }} title="More">
              <MoreVertical className="h-3.5 w-3.5" />
            </TileBtn>
            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-9 right-0 z-20 w-52 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg"
              >
                <TileMenuItem icon={MonitorPlay} label="Expand to single view" onClick={() => { setMenuOpen(false); onExpand(camera); }} />
                <TileMenuItem icon={History} label="Open in Playback" onClick={() => { setMenuOpen(false); onOpenPlayback(camera); }} />
                {online && (
                  <TileMenuItem icon={ImageDown} label="Save snapshot" onClick={() => { setMenuOpen(false); onSnapshot(camera); }} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TileBtn({ onClick, title, active = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active || undefined}
      className={`rounded-md p-1.5 text-white transition-colors hover:bg-brand ${active ? 'bg-brand' : 'bg-black/50'}`}
    >
      {children}
    </button>
  );
}

function TileMenuItem({ icon: Icon, label, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-small font-medium transition-colors hover:bg-surface-muted ${danger ? 'text-danger-ink' : 'text-fg'}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

// Camera List Item. The status dot leads the row so a column of dots lines up
// and can be scanned in one pass. In Multi View the trailing badge says which
// tile the camera is on right now, if it is on this page - so the list
// answers "is Lobby up?" without looking over.
//
// Nothing on the row adds or removes a camera. Multi View fills itself from
// this list, so a click means "show me that one": the grid turns to its page
// and its tile lights up. The "+ Add" button that used to sit on every row
// (and the click-to-add that briefly replaced it) are gone: with fifty
// cameras, picking is a chore for someone in a hurry, and a wall worth
// keeping is built in Monitor Wall.
function CameraItem({ camera, selected, onSelect, slot = 0, collapsed, gridMode }) {
  if (collapsed) {
    return (
      <button
        onClick={() => onSelect(camera)}
        title={camera.name}
        className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all ${selected ? 'bg-brand/15' : 'hover:bg-white/[0.04]'
          }`}
      >
        <StatusDot status={camera.status} />
      </button>
    );
  }

  return (
    <div
      onClick={() => onSelect(camera)}
      title={gridMode ? 'Show this camera' : undefined}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 transition-all ${selected
        ? 'bg-brand/10 ring-1 ring-brand/25'
        : 'hover:bg-surface-muted/60'
        }`}
    >
      <StatusDot status={camera.status} />
      <p className={`min-w-0 flex-1 truncate text-body font-semibold leading-tight ${selected ? 'text-brand' : 'text-fg'}`}>
        {camera.name}
      </p>
      {gridMode && slot > 0 && (
        <span
          title={`On screen now - tile ${slot}`}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md bg-surface-muted px-1.5 text-caption font-bold tabular-nums text-fg-muted"
        >
          <Grid2X2 className="h-3 w-3" />
          {slot}
        </span>
      )}
    </div>
  );
}

// Group Accordion
function GroupAccordion({ group, selectedCamera, onSelectCamera, gridCameras, collapsed, gridMode, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const cameras = (group.cameras || []).slice().sort((a, b) => (a.channel || 0) - (b.channel || 0));
  const onlineCount = cameras.filter(c => c.status === 'online').length;

  if (collapsed) {
    return (
      <div className="mb-2">
        <div className="flex justify-center py-1.5" title={group.name}>
          <div className="w-7 h-7 rounded-lg bg-brand/15 flex items-center justify-center">
            <Cctv className="w-3.5 h-3.5 text-brand" />
          </div>
        </div>
        <div className="space-y-0.5 px-1">
          {cameras.map(cam => (
            <CameraItem key={cam.id} camera={cam} selected={selectedCamera?.id === cam.id}
              onSelect={onSelectCamera} gridMode={gridMode} collapsed />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-1">
      {/* Group header */}
      <button
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-muted/60"
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" />
        }
        <span className="flex-1 truncate text-left text-body font-bold text-fg">{group.name}</span>
        {/* Total, with the online split as the tooltip - the design shows one
            number here, and the status chips above already answer "how many
            are down" for the whole list. */}
        <span
          className="shrink-0 tabular-nums text-small font-semibold text-fg-muted"
          title={`${onlineCount} of ${cameras.length} online`}
        >
          {cameras.length}
        </span>
      </button>

      {open && cameras.length > 0 && (
        <div className="ml-2 mt-0.5 space-y-0.5">
          {cameras.map(cam => {
            const idx = gridCameras.findIndex(g => g.id === cam.id);
            return (
              <CameraItem key={cam.id} camera={cam} selected={selectedCamera?.id === cam.id}
                onSelect={onSelectCamera} slot={idx + 1} gridMode={gridMode} />
            );
          })}
        </div>
      )}
    </div>
  );
}

// Sites tree. Sites are a real level above groups (Camera -> Group -> Site),
// but a group only appears under a site once someone sets its site on Camera
// Setup. Groups with no site land in "Unassigned" rather than vanishing, and a
// site with nothing under it says so instead of rendering an empty shell.
function SiteTree({ sites, groups, selectedCamera, onSelectCamera, gridCameras, gridMode }) {
  const bySite = useMemo(() => {
    const m = new Map();
    for (const g of groups) {
      const key = g.siteId || '__none__';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(g);
    }
    return m;
  }, [groups]);

  const rows = [
    ...sites.map(site => ({ id: site.id, name: site.name, groups: bySite.get(site.id) || [] })),
    ...(bySite.has('__none__')
      ? [{ id: '__none__', name: 'Unassigned', groups: bySite.get('__none__') }]
      : []),
  ];

  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <Building2 className="mx-auto mb-2 h-8 w-8 text-fg-muted/20" />
        <p className="text-body font-medium text-fg-muted">No sites yet</p>
        <p className="mt-1 text-small text-fg-muted/70">Create sites under Setup › Add cameras.</p>
      </div>
    );
  }

  return (
    <>
      {rows.map(site => (
        <SiteBranch
          key={site.id}
          site={site}
          selectedCamera={selectedCamera}
          onSelectCamera={onSelectCamera}
          gridCameras={gridCameras}
          gridMode={gridMode}
        />
      ))}
    </>
  );
}

function SiteBranch({ site, selectedCamera, onSelectCamera, gridCameras, gridMode }) {
  const [open, setOpen] = useState(true);
  const camCount = site.groups.reduce((n, g) => n + (g.cameras?.length || 0), 0);

  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-muted/60"
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" />
        }
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand/15">
          <Building2 className="h-3 w-3 text-brand" />
        </div>
        <span className="flex-1 truncate text-left text-body font-bold text-fg">{site.name}</span>
        <span className="shrink-0 tabular-nums text-small font-semibold text-fg-muted">{camCount}</span>
      </button>

      {open && (
        <div className="ml-3 mt-0.5">
          {site.groups.length === 0 ? (
            <p className="px-3 py-2 text-small text-fg-muted/70">No locations assigned yet</p>
          ) : (
            site.groups.map(g => (
              <GroupAccordion
                key={g.id}
                group={g}
                selectedCamera={selectedCamera}
                onSelectCamera={onSelectCamera}
                gridCameras={gridCameras}
                gridMode={gridMode}
                collapsed={false}
                defaultOpen={false}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Hand a Blob to the browser as a download.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const fileSafe = (name) => String(name || 'camera').replace(/[^\w.-]+/g, '_').slice(0, 60);

// Toolbar controls. Single / Multi says what kind of view this is; the layout
// picker next to it only offers grid densities, because "one camera" is what
// Single View already means - two controls that could both claim the one-tile
// layout is how the old top-bar toggle and this picker came to disagree.
function ModeToggle({ gridMode, onSingle, onMulti }) {
  const modes = [
    { id: 'single', label: 'Single View', on: !gridMode, go: onSingle },
    { id: 'multi', label: 'Multi View', on: gridMode, go: onMulti },
  ];
  return (
    <div className="flex shrink-0 items-center rounded-lg bg-surface-muted/60 p-0.5">
      {modes.map(m => (
        <button
          key={m.id}
          type="button"
          onClick={m.go}
          aria-pressed={m.on}
          className={`rounded-md px-3 py-1.5 text-small font-semibold transition-all ${m.on ? 'bg-brand text-white shadow-sm' : 'text-fg-muted hover:text-fg'}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function LayoutPicker({ layoutId, onPick }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-muted/60 p-0.5">
      {LAYOUTS.filter(l => l.id > 1).map(l => {
        const Icon = l.icon;
        const active = layoutId === l.id;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onPick(l)}
            title={`${l.label} grid`}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-small font-semibold tabular-nums transition-all ${active
              ? 'bg-brand text-white shadow-sm'
              : 'text-fg-muted hover:text-fg'
              }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

// Page through the grid. ← / → do the same in Multi View. Hidden when
// everything fits on one page.
function GridPager({ index, count, onPrev, onNext }) {
  if (count < 2) return null;
  const btn = 'grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
      <button type="button" onClick={onPrev} disabled={index <= 0} title="Previous page (←)" aria-label="Previous page" className={btn}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="px-1.5 text-small font-semibold tabular-nums text-fg">Page {index + 1} of {count}</span>
      <button type="button" onClick={onNext} disabled={index >= count - 1} title="Next page (→)" aria-label="Next page" className={btn}>
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// Previous / next camera in Single View - the order the camera list shows,
// wrapping at the ends. The arrow keys do the same thing.
function CameraStepper({ camera, index, total, onPrev, onNext }) {
  const btn = 'grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg disabled:pointer-events-none disabled:opacity-40';
  return (
    <div className="flex min-w-0 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
      <button type="button" onClick={onPrev} disabled={total < 2} title="Previous camera (←)" aria-label="Previous camera" className={btn}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-0 truncate px-1 text-small font-semibold text-fg">{camera?.name || 'No camera'}</span>
      {index >= 0 && total > 0 && (
        <span className="shrink-0 pr-1 text-caption tabular-nums text-fg-muted">{index + 1} of {total}</span>
      )}
      <button type="button" onClick={onNext} disabled={total < 2} title="Next camera (→)" aria-label="Next camera" className={btn}>
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// Info Strip (single-view metadata bar)
function InfoStrip({ camera }) {
  const pills = [
    { label: 'Codec', value: (camera.type || 'H.264').toUpperCase() },
    { label: 'Channel', value: `Ch ${camera.channel}` },
  ];

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 bg-surface rounded-xl border border-line">
      {/* Status */}
      <div className="flex items-center gap-2">
        <StatusDot status={camera.status} />
        <span className={`text-body font-bold ${camera.status === 'online' ? 'text-success' : 'text-fg-muted'}`}>
          {camera.status === 'online' ? 'Live' : 'Offline'}
        </span>
      </div>

      <div className="w-px h-5 bg-border shrink-0" />

      {/* Stream pills */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {pills.map(p => (
          <div key={p.label} className="flex flex-col">
            {/* Label - small caption */}
            <span className="text-small font-semibold text-fg-muted/60 uppercase tracking-wider leading-none">{p.label}</span>
            {/* Value - subline */}
            <span className="text-body font-semibold text-fg mt-0.5">{p.value}</span>
          </div>
        ))}
      </div>

      {/* REC badge - only when actually online */}
      {camera.status === 'online' && (
        <div className="ml-auto flex items-center gap-2 bg-danger/10 px-3 py-1.5 rounded-full">
          <Circle className="w-2.5 h-2.5 fill-danger text-danger animate-pulse" />
          <span className="text-small font-bold text-danger tracking-widest">REC</span>
        </div>
      )}
    </div>
  );
}

// Mobile Camera Sheet
function MobileCameraSheet({ open, onClose, groups, selectedCamera, onSelectCamera, gridCameras, gridMode, onRefresh, searchQuery, setSearchQuery }) {
  const allCount = groups.flatMap(g => g.cameras || []).length;
  const onlineCount = groups.flatMap(g => g.cameras || []).filter(c => c.status === 'online').length;

  const filteredGroups = searchQuery
    ? groups.map(g => ({
      ...g,
      cameras: (g.cameras || []).filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    })).filter(g => g.cameras.length > 0)
    : groups;

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 md:hidden"
        onClick={onClose}
      />
      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-surface border-t border-line rounded-t-2xl flex flex-col"
        style={{ maxHeight: 'calc(var(--app-vh)*0.8)' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        {/* Sheet header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
          <div>
            {/* Headline */}
            <p className="text-body font-bold text-fg">Cameras</p>
            {/* Subline */}
            <p className="text-small text-fg-muted mt-0.5">{onlineCount} of {allCount} online</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              className="p-2 rounded-lg text-fg-muted hover:text-brand hover:bg-brand/10 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-line shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-muted/50" />
            <input
              type="text"
              placeholder="Search cameras..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 text-body bg-surface-muted/50 border border-line rounded-xl placeholder:text-fg-muted/50 focus:outline-none focus:ring-1 focus:ring-brand/40 focus:border-brand/40 transition-all"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-2 px-2">
          {filteredGroups.map(g => (
            <GroupAccordion key={g.id} group={g} selectedCamera={selectedCamera}
              onSelectCamera={(cam) => { onSelectCamera(cam); onClose(); }}
              gridCameras={gridCameras} gridMode={gridMode} collapsed={false} />
          ))}
          {filteredGroups.length === 0 && (
            <div className="text-center py-10">
              <Camera className="w-8 h-8 text-fg-muted/20 mx-auto mb-2" />
              <p className="text-body text-fg-muted">
                {searchQuery ? `No cameras match "${searchQuery}"` : 'No cameras added'}
              </p>
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-small text-brand mt-1 hover:underline">
                  Clear search
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Button in the selection bar.
function ActionBtn({ onClick, icon: Icon, children, danger, active, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-small font-semibold transition-colors ${danger
        ? 'border-danger/25 text-danger-ink hover:bg-danger/10'
        : active
          ? 'border-danger/40 bg-danger/10 text-danger-ink'
          : 'border-line text-fg-secondary hover:bg-surface-muted hover:text-fg'
        }`}
    >
      <Icon className={`h-3.5 w-3.5 ${active ? 'fill-current animate-pulse' : ''}`} />
      {children}
    </button>
  );
}

// ── Single-view side panel ──────────────────────────────────────────────────

// The strip under the grid for the tile the operator clicked: what does not
// fit on a tile, and the next step for that one camera.
function SelectedCameraStrip({ camera, place, soundOn, onSingle, onPlayback, onSnapshot, onClose }) {
  const online = camera.status === 'online';
  const lastSeen = relativeTime(camera.lastSeenAt);
  const detail = [
    place,
    camera.channel ? `Ch ${camera.channel}` : null,
    !online && lastSeen ? `last seen ${lastSeen}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface-sunken px-4 py-2">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${online ? 'bg-brand/10 text-brand' : 'bg-danger/10 text-danger'}`}>
        {online ? <Cctv className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-body font-bold text-fg">{camera.name}</p>
          <span className={`flex shrink-0 items-center gap-1 text-caption font-bold tracking-widest ${online ? 'text-success' : 'text-danger'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
            {online ? 'LIVE' : 'OFFLINE'}
          </span>
          {online && soundOn && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-caption font-semibold text-brand">
              <Volume2 className="h-3 w-3" />
              Sound on
            </span>
          )}
        </div>
        {detail && <p className="truncate text-small text-fg-muted">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ActionBtn onClick={onSingle} icon={MonitorPlay}>Single view</ActionBtn>
        <ActionBtn onClick={onPlayback} icon={History} title="Open the last five minutes in Recordings">Recordings</ActionBtn>
        {online && <ActionBtn onClick={onSnapshot} icon={ImageDown}>Snapshot</ActionBtn>}
        <button
          type="button"
          onClick={onClose}
          title="Deselect (Esc)"
          aria-label="Deselect camera"
          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// PTZ. Every driver in smart-cam-backend/src/services/vendors/index.js currently
// declares `ptz: false`, and no route exposes pan/tilt/zoom at all - so this
// panel renders in a disabled state that says why, rather than as a D-pad that
// silently does nothing. When a driver starts reporting the capability (and the
// backend grows the endpoint) this list is the only thing to change.
const PTZ_CAPABLE_DEVICES = new Set();

function PtzControl({ deviceType }) {
  const supported = PTZ_CAPABLE_DEVICES.has(deviceType);

  return (
    <section className="rounded-xl border border-line bg-surface p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-body font-bold text-fg">
          <Move className="h-3.5 w-3.5 text-brand" />
          PTZ Control
        </h3>
        {supported ? (
          <select className="rounded-md border border-line bg-surface px-2 py-1 text-caption font-semibold text-fg-secondary">
            <option>Presets</option>
          </select>
        ) : (
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-caption font-semibold text-fg-muted">
            Not supported
          </span>
        )}
      </div>

      <fieldset disabled={!supported} className={supported ? '' : 'pointer-events-none opacity-40'}>
        <div className="flex items-start gap-3">
          {/* D-pad */}
          <div className="grid shrink-0 grid-cols-3 grid-rows-3 gap-1">
            <span />
            <PtzBtn label="Tilt up"><ChevronUpGlyph /></PtzBtn>
            <span />
            <PtzBtn label="Pan left"><ChevronLeft className="h-3.5 w-3.5" /></PtzBtn>
            <span className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface-muted">
              <span className="h-2 w-2 rounded-full bg-fg-muted/50" />
            </span>
            <PtzBtn label="Pan right"><ChevronRight className="h-3.5 w-3.5" /></PtzBtn>
            <span />
            <PtzBtn label="Tilt down"><ChevronDown className="h-3.5 w-3.5" /></PtzBtn>
            <span />
          </div>

          <div className="flex flex-1 gap-2">
            <PtzStepper icon={ZoomIn} label="Zoom" />
            <PtzStepper icon={Focus} label="Focus" />
          </div>
        </div>
      </fieldset>

      {!supported && (
        <p className="mt-3 text-caption leading-relaxed text-fg-muted">
          The driver for {deviceType ? <span className="font-semibold">{deviceType}</span> : 'this device'} does
          not report pan/tilt/zoom, and no PTZ endpoint exists yet. Controls stay disabled rather than
          pretending to move the camera.
        </p>
      )}
    </section>
  );
}

function ChevronUpGlyph() {
  return <ChevronDown className="h-3.5 w-3.5 rotate-180" />;
}

function PtzBtn({ label, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line text-fg-secondary transition-colors hover:border-brand-line hover:bg-brand-soft hover:text-brand"
    >
      {children}
    </button>
  );
}

function PtzStepper({ icon: Icon, label }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <button type="button" className="w-full rounded-lg border border-line py-1 text-fg-secondary transition-colors hover:bg-surface-muted">+</button>
      <span className="flex items-center gap-1 text-caption font-semibold text-fg-muted">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <button type="button" className="w-full rounded-lg border border-line py-1 text-fg-secondary transition-colors hover:bg-surface-muted">-</button>
    </div>
  );
}

// A single "label : value" line in the Camera Details list.
function DetailRow({ icon: Icon, label, valueIcon: ValueIcon, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex shrink-0 items-center gap-2 text-small text-fg-muted">
        <Icon className="h-3.5 w-3.5 text-brand/70" />
        {label}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-small font-semibold text-fg">
        {ValueIcon ? <ValueIcon className="h-3.5 w-3.5 shrink-0 text-fg-muted/60" /> : null}
        <span className="truncate">{children}</span>
      </span>
    </div>
  );
}

// "2 min ago" for the Last Online row. Falls back to an em dash rather than
// printing "Invalid Date" when a camera has never reported in.
function relativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

// Which stream the operator is watching. This is the existing saved
// per-camera quality preference (auto / main / sub), not a view-local toggle -
// picking Sub here is the same setting Camera Setup writes, so the wall and
// this page agree about what "Sub" means.
function StreamPicker({ camera }) {
  const qc = useQueryClient();
  const value = camera.streamQuality || 'auto';
  const [busy, setBusy] = useState(false);

  const change = async (next) => {
    setBusy(true);
    try {
      await cameraGroupService.setCameraQuality(camera.groupId, camera.monitorId, next === 'auto' ? null : next);
      await qc.invalidateQueries({ queryKey: ['groups'] });
    } catch {
      window.alert('Could not change the stream for this camera.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <select
      value={value}
      disabled={busy}
      onChange={(e) => change(e.target.value)}
      title="Which stream to watch"
      className="rounded-md border border-white/15 bg-black/55 px-2 py-1 text-caption font-semibold text-white/90 focus:outline-none disabled:opacity-50"
    >
      <option value="auto">Auto</option>
      <option value="main">Main Stream</option>
      <option value="sub">Sub Stream</option>
    </select>
  );
}

// Main LiveView
export default function LiveView() {
  // The Video wall is an account switch; without it there is no "send to wall".
  const wallOn = makeEntitlement(useAuthStore((s) => s.user)).has('monitor_wall');
  // Live view always plays over WebRTC (grid + single) with a silent HLS
  // fallback inside the player — the protocol is an internal detail, not a
  // user choice. The /live and /live-hls routes both render this same view.
  const { data: groups = [], isLoading: loading } = useGroups({ refetchInterval: 15_000 });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Deep links arrive under two spellings: ?monitor= (Personnel Search, Journey
  // Map, Quick actions) and ?camera= (Dashboard camera cards, Alerts "View
  // live"). Accept both — reading only one is why clicking a camera card
  // landed on Live View showing the first online camera instead of the one
  // that was clicked.
  const requestedMonitor = searchParams.get('monitor') || searchParams.get('camera') || '';

  const [selectedCamera, setSelectedCamera] = useState(null);
  // Multi View comes back the way it was left (see GRID_KEY). A deep link to
  // one camera still opens Single View: that is what the link asked for.
  const [savedGrid] = useState(readSavedGrid);
  const resumeMulti = savedGrid.multi && !requestedMonitor;
  const [page, setPage] = useState(savedGrid.page);
  const [layoutId, setLayoutId] = useState(resumeMulti ? savedGrid.layoutId : 1);
  const [gridMode, setGridMode] = useState(resumeMulti);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');   // all | online | offline
  const [panelTab, setPanelTab] = useState('cameras');       // cameras | sites
  // The grid tile the operator clicked. It drives the strip under the grid;
  // the bar below that still acts on the whole grid.
  const [focusedId, setFocusedId] = useState(null);
  // Grid tiles start muted (autoplay policy, and N unmuted tiles is just noise).
  // These hold the cameras the operator has explicitly changed.
  const [unmutedIds, setUnmutedIds] = useState(() => new Set());
  const [pausedIds, setPausedIds] = useState(() => new Set());
  const [recordingIds, setRecordingIds] = useState(() => new Set());
  // Single view has its own transport state (the grid's sets are keyed per tile).
  const [singlePaused, setSinglePaused] = useState(false);
  const [singleMuted, setSingleMuted] = useState(true);
  const [singleVolume, setSingleVolume] = useState(1);
  const [detailTab, setDetailTab] = useState('details');   // details | talk | ptz
  // Folding the camera panel hands its width to the player. Remembered per
  // browser: an operator who wants the bigger picture wants it every time.
  const [detailsOpen, setDetailsOpen] = useState(() => {
    try { return localStorage.getItem('liveView.detailsOpen') !== '0'; } catch { return true; }
  });
  const setDetailsPanel = useCallback((open) => {
    setDetailsOpen(open);
    try { localStorage.setItem('liveView.detailsOpen', open ? '1' : '0'); } catch { /* private mode */ }
  }, []);
  const [lastMultiLayout, setLastMultiLayout] = useState(savedGrid.layoutId);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const appliedMonitorRef = useRef('');
  const allCameras = groups.flatMap(g => g.cameras || []);

  // Fullscreen the video pane only - the camera list, top bar and app chrome
  // are dead weight once someone is watching. Monitor Wall (header link) is the
  // persistent control-room view; this is the momentary one, and it keeps the
  // same streams rather than starting a second set.
  const stageRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // In fullscreen the camera panel is a card floating over the top-right of
  // the video instead of a column beside it. It starts closed every time, so
  // going fullscreen gives the whole screen to the picture.
  const [fsPanelOpen, setFsPanelOpen] = useState(false);
  // Fullscreen chrome (bar, name, card) fades after 3 s without the mouse
  // moving, like any video player. It never fades out from under the
  // operator: not while the pointer is on the card (holding Hold to Talk) or
  // focus is inside it (typing a quick message).
  const [fsIdle, setFsIdle] = useState(false);
  const idleTimerRef = useRef(null);
  const fsPanelRef = useRef(null);
  const wakeControls = useCallback(() => {
    setFsIdle(false);
    clearTimeout(idleTimerRef.current);
    const tick = () => {
      const card = fsPanelRef.current;
      if (card && (card.matches(':hover') || card.contains(document.activeElement))) {
        idleTimerRef.current = setTimeout(tick, 3000);
        return;
      }
      setFsIdle(true);
    };
    idleTimerRef.current = setTimeout(tick, 3000);
  }, []);
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      if (document.fullscreenElement) {
        wakeControls();
      } else {
        clearTimeout(idleTimerRef.current);
        setFsIdle(false);
        setFsPanelOpen(false);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      clearTimeout(idleTimerRef.current);
    };
  }, [wakeControls]);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else stageRef.current?.requestFullscreen?.();
  };
  const fsSingle = isFullscreen && !gridMode;
  const fsHide = fsSingle && fsIdle;   // fullscreen chrome faded out
  const fadeCls = `transition-opacity duration-300 ${fsHide ? 'pointer-events-none opacity-0' : 'opacity-100'}`;

  // Sites for the "Sites" tab. Only fetched when that tab is opened - most
  // sessions never leave the camera list.
  const { data: sitesRaw } = useQuery({
    queryKey: ['sites'],
    queryFn: () => siteService.list(),
    // Needed by the Sites tab AND the single-view details panel, so it is not
    // gated on the tab being open.
    staleTime: 60_000,
  });
  const sites = Array.isArray(sitesRaw) ? sitesRaw : (sitesRaw?.data ?? []);

  // ── Capture ──────────────────────────────────────────────────────────────
  // Snapshot and clip both read the tile's own <video>, which is why tiles
  // carry data-cam-id. Nothing server-side is involved: there is no API to
  // grab a still from a live camera, and recording on the backend is the
  // continuous per-camera setting, not something a button here should flip.
  const videoFor = (camId) =>
    stageRef.current?.querySelector(`[data-cam-id="${CSS.escape(String(camId))}"] video`) || null;

  // Returns 'ok' | 'no-frame' | 'tainted'.
  //
  // 'tainted' is the one that surprises people: when the player is on its HLS
  // path the <video> is fed from the stream service on another origin, which
  // has no CORS headers, so the browser marks any canvas we draw it into as
  // tainted and refuses to export it. A WebRTC MediaStream does not taint the
  // canvas - so this starts working the moment WHEP connects instead of
  // falling back. Nothing here can work around it from the page.
  const snapshotCamera = useCallback((camera) => {
    const v = videoFor(camera.id);
    if (!v || !v.videoWidth) return 'no-frame';
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    try {
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (b) => b && downloadBlob(b, `${fileSafe(camera.name)}_${fileStamp()}.png`),
        'image/png',
      );
      return 'ok';
    } catch {
      return 'tainted';
    }
  }, []);

  const recordersRef = useRef(new Map());

  const stopRecording = useCallback((camId) => {
    const rec = recordersRef.current.get(camId);
    if (rec && rec.state !== 'inactive') rec.stop();
    recordersRef.current.delete(camId);
    setRecordingIds(prev => {
      const next = new Set(prev);
      next.delete(camId);
      return next;
    });
  }, []);

  // Same cross-origin story as the snapshot: captureStream() on a video the
  // browser considers cross-origin throws rather than handing over tracks.
  const startRecording = useCallback((camera) => {
    const v = videoFor(camera.id);
    if (!v || !v.videoWidth) return 'no-frame';
    let stream;
    try {
      stream = v.captureStream?.() || v.mozCaptureStream?.();
    } catch {
      return 'tainted';
    }
    if (!stream || !stream.getTracks().length) return 'tainted';
    if (typeof MediaRecorder === 'undefined') return 'unsupported';
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported?.(t));
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch { return 'unsupported'; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      if (chunks.length) {
        downloadBlob(
          new Blob(chunks, { type: rec.mimeType || 'video/webm' }),
          `${fileSafe(camera.name)}_${fileStamp()}.webm`,
        );
      }
    };
    rec.start();
    recordersRef.current.set(camera.id, rec);
    setRecordingIds(prev => new Set(prev).add(camera.id));
    return 'ok';
  }, []);

  // Apply single-view transport to the element the player owns.
  useEffect(() => {
    if (gridMode || !selectedCamera) return;
    const v = videoFor(selectedCamera.id);
    if (!v) return;
    if (singlePaused) v.pause();
    else v.play().catch(() => {});
  }, [singlePaused, gridMode, selectedCamera]);

  useEffect(() => {
    if (gridMode || !selectedCamera) return;
    const v = videoFor(selectedCamera.id);
    if (v) v.volume = singleVolume;
  }, [singleVolume, gridMode, selectedCamera]);

  // Never leave a recorder running when the page goes away.
  useEffect(() => () => {
    for (const rec of recordersRef.current.values()) {
      if (rec.state !== 'inactive') rec.stop();
    }
    recordersRef.current.clear();
  }, []);

  // Stop all backend streams when leaving LiveView
  useEffect(() => {
    return () => releaseAllStreams();
  }, []);

  // Lookup-failure state for the deep-link path. When a user clicks "Live"
  // on PersonnelSearch (or any other deep link) and the requested monitor
  // isn't in the cameras list, we'd previously fall back silently to the
  // first online camera — exactly the "default camera, not the one I asked
  // for" complaint. Now we surface it via this state so the UI can show a
  // banner explaining what happened.
  const [missingMonitor, setMissingMonitor] = useState('');

  // ── Auto-select via ?monitor=... deep link OR first online camera ──────────
  useEffect(() => {
    if (loading || groups.length === 0) return;
    const all = groups.flatMap(g => g.cameras || []);

    // Apply ?monitor=<id> once per distinct value — lets users still click around
    // freely afterwards without us yanking them back to the deep-linked camera.
    if (requestedMonitor && appliedMonitorRef.current !== requestedMonitor) {
      const target = all.find(c => c.monitorId === requestedMonitor || c.id === requestedMonitor);
      appliedMonitorRef.current = requestedMonitor;
      if (target) {
        setSelectedCamera(target);
        setGridMode(false);
        setMissingMonitor('');
        return;
      }
      // Deep-link asked for a camera that isn't in this user's accessible
      // list. Previously we fell through to "first online camera" — which
      // is how Personnel Search → Live always opened "Camera 05" regardless
      // of who the operator clicked: the personnel API returned a
      // last_camera_code that didn't match any Camera.monitorId in this
      // user's groups, so we silently substituted the first online camera.
      // Stop doing that. Surface the missing id, clear any prior selection,
      // and let the UI render a banner explaining the situation.
      console.warn(
        '[LiveView] requested monitor not found in cameras list',
        { requestedMonitor, available: all.length },
      );
      setMissingMonitor(requestedMonitor);
      setSelectedCamera(null);
      return;
    }

    // No deep link AND nothing selected yet — pick the first online camera
    // as the initial view. This branch only ever fires when the user
    // navigated to /live directly, not from a Personnel/Alerts deep link.
    if (!selectedCamera && !requestedMonitor) {
      const first = all.find(c => c.status === 'online') || all[0];
      if (first) setSelectedCamera(first);
    }
  }, [loading, groups, requestedMonitor, selectedCamera]);

  const handleRefresh = async () => qc.invalidateQueries({ queryKey: ['groups'] });

  const handleExpandFromGrid = (cam) => { setSelectedCamera(cam); setGridMode(false); };

  // The group (recorder/location) the selected camera belongs to, and the site
  // above it. Both drive the single-view details panel.
  const selectedGroup = selectedCamera
    ? groups.find(g => g.id === selectedCamera.groupId) || null
    : null;
  const siteNameFor = (group) => (group?.siteId ? (sites.find(x => x.id === group.siteId)?.name ?? null) : null);

  // The single-view camera panel's tabs. The folded rail draws the same list
  // as icons, so the two can never offer different tabs.
  const detailTabs = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'talk', label: 'Two-Way Audio', icon: Mic },
    ...(PTZ_CAPABLE_DEVICES.has(selectedGroup?.deviceType) ? [{ id: 'ptz', label: 'PTZ', icon: Move }] : []),
  ];



  // The camera list is narrowed by the search box and the status chips. The
  // location / device / status dropdowns that used to sit over the grid are
  // gone: the list already groups by location and the chips are the status
  // filter, so they were a second set of controls for the same thing.
  const query = searchQuery.trim().toLowerCase();
  const matchesCamera = (cam) => (
    (!query || cam.name.toLowerCase().includes(query)) &&
    (statusFilter === 'all' || (statusFilter === 'online' ? cam.status === 'online' : cam.status !== 'online'))
  );
  const anyFilter = Boolean(query) || statusFilter !== 'all';
  const filteredGroups = anyFilter
    ? groups
      .map(g => ({ ...g, cameras: (g.cameras || []).filter(matchesCamera) }))
      .filter(g => g.cameras.length > 0)
    : groups;

  // Single View's previous / next: the cameras in the order the list shows
  // them (groups as listed, channels ascending), wrapping at the ends.
  const stepList = filteredGroups.flatMap(g => (g.cameras || []).slice().sort((a, b) => (a.channel || 0) - (b.channel || 0)));
  const stepIndex = selectedCamera ? stepList.findIndex(c => c.id === selectedCamera.id) : -1;
  const stepCamera = (dir) => {
    if (!stepList.length) return;
    const i = stepIndex < 0 ? 0 : (stepIndex + dir + stepList.length) % stepList.length;
    setSelectedCamera(stepList[i]);
  };

  // The grid: the list, paged (see buildPages). Only built in Multi View.
  const pages = gridMode ? buildPages(stepList, layoutId) : [[]];
  // The saved page can be past the end after a filter or a smaller list, so
  // the index is clamped on the way out rather than corrected in an effect.
  const pageIndex = Math.min(Math.max(0, page), pages.length - 1);
  const gridCameras = pages[pageIndex];
  // Only the cameras on the page get a tile. Padding the grid to the picked
  // density used to draw dashed "Empty slot" tiles, which read as a place to
  // add a camera - and nobody adds cameras here. The grid shrinks to what it
  // holds instead (see gridFit), so a short last page is not a hole.
  const turnPage = (dir) => setPage(Math.min(Math.max(0, pageIndex + dir), pages.length - 1));

  // Warm the next page's cameras so turning the page plays at once.
  const nextPageIds = gridMode && pages.length > 1
    ? (pages[(pageIndex + 1) % pages.length] || [])
      .filter((c) => c?.status === 'online' && c.monitorId).map((c) => c.monitorId).join(',')
    : '';
  useEffect(() => { setWarmHints(nextPageIds ? nextPageIds.split(',') : []); }, [nextPageIds]);

  // Clicking a camera in the list means "watch this one" in Single View and
  // "show me that one" in Multi View: the grid turns to the page it is on and
  // its tile lights up. (Two earlier versions made the click build the grid;
  // see CameraItem for why that went.)
  const handleSelectCamera = (cam) => {
    if (!gridMode) { setSelectedCamera(cam); return; }
    const i = pages.findIndex(p => p.some(c => c.id === cam.id));
    if (i >= 0) setPage(i);
    setFocusedId(cam.id);
  };

  const handlePickLayout = (l) => {
    setLayoutId(l.id);
    setGridMode(l.id > 1);
    if (l.id > 1) {
      // A new density re-cuts the pages, so start from the first. Coming back
      // from Single View keeps both the density last used and the page.
      if (l.id !== lastMultiLayout) setPage(0);
      setLastMultiLayout(l.id);
    }
  };

  // Remember how Multi View was left (see GRID_KEY).
  useEffect(() => {
    try {
      localStorage.setItem(GRID_KEY, JSON.stringify({ multi: gridMode, layoutId: lastMultiLayout, page: pageIndex }));
    } catch { /* private mode */ }
  }, [gridMode, lastMultiLayout, pageIndex]);

  // ←/→ step through cameras in Single View and pages in Multi View; Esc
  // clears the grid selection.
  // A field that is being typed in (search, talk-back) keeps its keys.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (gridMode) turnPage(dir);
        else stepCamera(dir);
      } else if (gridMode && e.key === 'Escape') {
        setFocusedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const focusedCamera = gridMode ? (gridCameras.find(c => c.id === focusedId) || null) : null;
  // The list highlights the camera that matters right now: the focused tile
  // in Multi View, the one being watched in Single View.
  const listSelection = gridMode ? focusedCamera : selectedCamera;
  // A page with fewer tiles than the density that is not the last page was
  // cut short by a recorder's stream limit. The count in the top bar says so.
  const limitHit = gridMode && gridCameras.length < layoutId && pageIndex < pages.length - 1;
  // Shown in place of the grid when there is nothing to put on it.
  const emptyNote = query || statusFilter !== 'all' ? 'No camera matches the filter' : 'No cameras yet';

  // ── Selection-bar actions ────────────────────────────────────────────────
  const anyUnmuted = gridCameras.some(c => unmutedIds.has(c.id));
  const anyRecording = gridCameras.some(c => recordingIds.has(c.id));

  const toggleMuteAll = () => {
    setUnmutedIds(() => (anyUnmuted ? new Set() : new Set(gridCameras.map(c => c.id))));
  };
  const toggleTileMute = (cam) => {
    setUnmutedIds(prev => {
      const next = new Set(prev);
      if (next.has(cam.id)) next.delete(cam.id);
      else next.add(cam.id);
      return next;
    });
  };
  const toggleTilePause = (cam) => {
    setPausedIds(prev => {
      const next = new Set(prev);
      if (next.has(cam.id)) next.delete(cam.id);
      else next.add(cam.id);
      return next;
    });
  };

  // One message for the whole batch, naming the actual blocker.
  const explain = (results, verb) => {
    if (results.includes('ok')) return null;
    if (results.includes('tainted')) {
      return `Cannot ${verb} while the stream is on its HLS fallback: the video is served from another origin without CORS headers, so the browser blocks reading its pixels. This works once the camera connects over WebRTC.`;
    }
    if (results.includes('unsupported')) return `This browser cannot ${verb} from a live video element.`;
    return `Nothing to ${verb} yet - wait for a tile to start playing.`;
  };

  const snapshotSelected = () => {
    const msg = explain(gridCameras.map(c => snapshotCamera(c)), 'save a snapshot');
    if (msg) window.alert(msg);
  };

  const toggleRecordSelected = () => {
    if (anyRecording) {
      gridCameras.forEach(c => stopRecording(c.id));
      return;
    }
    const msg = explain(gridCameras.map(c => startRecording(c)), 'record');
    if (msg) window.alert(msg);
  };

  // Hand the picked cameras to Monitor Wall. It reads this the same way it
  // reads its other preferences, and shows a "showing N picked cameras" chip
  // with a way back out.
  const sendToMonitorWall = () => {
    try {
      localStorage.setItem('monitorWall.pick', JSON.stringify(gridCameras.map(c => c.monitorId)));
    } catch { /* private mode - the wall just shows everything */ }
    navigate('/monitor-wall');
  };

  // Playback opens on the NVR tab with this camera and window already chosen
  // (NvrPlayback reads ?monitor=&from=&to=). With no window given it is the
  // last five minutes, so "what just happened here?" is one click.
  const openPlayback = (camera, { from, to } = {}) => {
    if (!camera) return;
    const end = to || new Date();
    const start = from || new Date(end.getTime() - 5 * 60_000);
    const qs = new URLSearchParams({ monitor: camera.monitorId, from: start.toISOString(), to: end.toISOString() });
    navigate(`/playback?${qs}`);
  };

  const singleSnapshot = () => {
    if (!selectedCamera) return;
    const msg = explain([snapshotCamera(selectedCamera)], 'save a snapshot');
    if (msg) window.alert(msg);
  };

  const singleRecord = () => {
    if (!selectedCamera) return;
    if (recordingIds.has(selectedCamera.id)) { stopRecording(selectedCamera.id); return; }
    const msg = explain([startRecording(selectedCamera)], 'record');
    if (msg) window.alert(msg);
  };

  // On mobile the grid never goes past 2 columns whatever layout is picked, so
  // the row count is pinned from md up only and mobile shares the height evenly
  // across however many rows the 2-column wrap actually needs. (Before this, a
  // 2 x 3 layout on a phone squeezed 6 tiles into 2 declared rows.)
  // The picked density caps how many cameras a page holds; the grid itself is
  // cut to the cameras on the page, so two cameras in a 3 x 3 get two big tiles
  // rather than two small ones and seven dark holes.
  const gridFit = (() => {
    const n = gridCameras.length;
    if (n <= 1) return { cols: 1, rows: 1 };
    if (n === 2) return { cols: 2, rows: 1 };
    if (n <= 4) return { cols: 2, rows: 2 };
    if (n <= 6) return { cols: 3, rows: 2 };
    return { cols: 3, rows: 3 };
  })();
  const gridColClass = gridFit.cols === 1 ? 'grid-cols-1' : gridFit.cols === 2 ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3';
  const gridRowClass = gridFit.rows === 3 ? 'md:grid-rows-3' : gridFit.rows === 2 ? 'md:grid-rows-2' : 'grid-rows-1';

  return (
    /* No page header: the camera name, status and place are already in the
       player overlay and the side panel, and every row above the video is
       height taken from it. Edge to edge for the same reason. */
    <OperationsPage bleed>
      <PageContent>
        <RequireCameras description="Add your cameras to watch their feeds live, side by side.">
        {/*  Desktop layout  */}
        <PageCard className="flex min-h-0 flex-1 overflow-hidden rounded-none border-0 bg-surface shadow-none">

        {/*  Sidebar (desktop only)  */}
        <aside className={`shrink-0 hidden md:flex flex-col bg-surface border-r border-line h-full overflow-hidden transition-[width] duration-250 ease-in-out ${sidebarOpen ? 'w-65' : 'w-13'
          }`}>
          {/* Sidebar header */}
          {/* Fixed 64px (border included) - the main toolbar uses the same
              height so the two bottom borders sit on one line. */}
          <div className={`h-16 shrink-0 flex items-center border-b border-line ${sidebarOpen ? 'px-4 justify-between' : 'justify-center'}`}>
            {/* Cameras / Sites. Groups are the physical recorder; sites are
                the level above them. Both browse the same cameras. */}
            {sidebarOpen && (
              <div className="flex items-center gap-1">
                {[{ id: 'cameras', label: 'Cameras' }, { id: 'sites', label: 'Sites' }].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setPanelTab(t.id)}
                    className={`rounded-lg px-2.5 py-1 text-small font-bold transition-colors ${panelTab === t.id
                      ? 'bg-brand/10 text-brand'
                      : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                      }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <div className={`flex items-center ${sidebarOpen ? 'gap-0.5' : 'flex-col gap-1.5'}`}>
              {sidebarOpen && (
                <button
                  onClick={handleRefresh}
                  title="Refresh"
                  className="p-1.5 rounded-lg text-fg-muted hover:text-brand hover:bg-brand/10 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setSidebarOpen(v => !v)}
                title={sidebarOpen ? 'Collapse panel' : 'Expand panel'}
                className="p-1.5 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors"
              >
                {sidebarOpen ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Search */}
          {sidebarOpen && (
            <div className="px-4 py-2.5 border-b border-line">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-muted/50" />
                <input
                  type="text"
                  placeholder="Search cameras..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-body bg-surface-muted/50 border border-line rounded-lg placeholder:text-fg-muted/40 focus:outline-none focus:ring-1 focus:ring-brand/40 focus:border-brand/40 transition-all"
                />
              </div>
            </div>
          )}

          {/* Status chips. These replace a row that only printed the total -
              the count is now also the filter, so "show me the 22 that are
              down" is one click instead of scrolling every group. */}
          {sidebarOpen && (
            <div className="flex items-center gap-1.5 border-b border-line px-4 py-2">
              {STATUS_FILTERS.map(f => {
                const count = f.id === 'all'
                  ? allCameras.length
                  : allCameras.filter(c => (f.id === 'online' ? c.status === 'online' : c.status !== 'online')).length;
                const active = statusFilter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setStatusFilter(f.id)}
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-small font-semibold transition-all ${active
                      ? 'bg-brand/10 text-brand ring-1 ring-brand/25'
                      : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
                      }`}
                  >
                    {f.id !== 'all' && (
                      <span className={`h-1.5 w-1.5 rounded-full ${f.id === 'online' ? 'bg-success' : 'bg-neutral-400'}`} />
                    )}
                    {f.label}
                    <span className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Camera list */}
          <div className="flex-1 overflow-y-auto py-2 px-1.5">
            {loading ? (
              <div className="space-y-2 px-1.5 py-2">
                {[1, 2, 3, 4, 5].map(i => (
                  <div key={i} className={`bg-surface-muted/50 rounded-xl animate-pulse ${sidebarOpen ? 'h-12 w-full' : 'h-8 w-8 mx-auto rounded-full'}`} />
                ))}
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="text-center py-10">
                <Camera className="w-10 h-10 text-fg-muted/20 mx-auto mb-3" />
                {sidebarOpen && (
                  <div>
                    <p className="text-body text-fg-muted font-medium">
                      {searchQuery ? 'No cameras found' : 'No cameras added'}
                    </p>
                    {searchQuery && (
                      <button onClick={() => setSearchQuery('')} className="text-small text-brand mt-1 hover:underline">
                        Clear search
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : panelTab === 'sites' && sidebarOpen ? (
              <SiteTree
                sites={sites}
                groups={filteredGroups}
                selectedCamera={listSelection}
                onSelectCamera={handleSelectCamera}
                gridCameras={gridCameras}
                gridMode={gridMode}
              />
            ) : (
              filteredGroups.map(g => (
                <GroupAccordion key={g.id} group={g} selectedCamera={listSelection}
                  onSelectCamera={handleSelectCamera} gridCameras={gridCameras}
                  gridMode={gridMode} collapsed={!sidebarOpen} />
              ))
            )}
          </div>

          {/* The layout picker used to sit here as well as in the top bar as a
              Single / Multi-View toggle. One control now, above the video it
              controls; the grid's fill state is reported in the same top bar. */}
        </aside>

        {/*  Main content area  */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Toolbar: which kind of view, how dense (grid) or which camera
              (single), and fullscreen for the video underneath. */}
          {/* 64px on desktop to match the sidebar header; on a phone it may wrap
              to two rows, so it only sets a minimum there. */}
          <div className="flex min-h-16 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/50 px-4 py-2 backdrop-blur-sm md:h-16 md:px-6 md:py-0">
            {/* Wraps on a phone, so the camera stepper takes a second row
                instead of sliding under the Cameras button. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
              <ModeToggle
                gridMode={gridMode}
                onSingle={() => handlePickLayout(LAYOUTS[0])}
                onMulti={() => handlePickLayout(LAYOUTS.find(l => l.id === lastMultiLayout) || LAYOUTS[1])}
              />
              {gridMode ? (
                <div className="hidden sm:block">
                  <LayoutPicker layoutId={layoutId} onPick={handlePickLayout} />
                </div>
              ) : selectedCamera ? (
                <CameraStepper
                  camera={selectedCamera}
                  index={stepIndex}
                  total={stepList.length}
                  onPrev={() => stepCamera(-1)}
                  onNext={() => stepCamera(1)}
                />
              ) : (
                <span className="truncate text-body font-medium text-fg-muted">Select a camera to start</span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {gridMode ? (
                <>
                  <span
                    className="hidden text-small font-semibold tabular-nums text-fg-muted lg:inline"
                    title={limitHit
                      ? `This page stops short because the next camera would put its recorder past ${NVR_PULL_LIMIT} streams. It is on the next page.`
                      : undefined}
                  >
                    {stepList.length} camera{stepList.length === 1 ? '' : 's'}
                    {limitHit && ' · recorder at its limit'}
                  </span>
                  <GridPager index={pageIndex} count={pages.length} onPrev={() => turnPage(-1)} onNext={() => turnPage(1)} />
                </>
              ) : null}
              {/* Multi View only: in Single View the player's own bar has
                  the fullscreen button, and two of them read as a mistake. */}
              {gridMode && (
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  className="hidden rounded-lg border border-line bg-surface p-2 text-fg-muted transition hover:border-brand-line hover:bg-brand-soft hover:text-brand md:block"
                >
                  {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
              )}

              {/* Mobile: Camera list button */}
              <button
                onClick={() => setMobileSheetOpen(true)}
                className="flex md:hidden items-center gap-1.5 px-3 py-2 rounded-xl bg-brand/10 text-brand text-small font-semibold hover:bg-brand/20 transition-colors"
              >
                <List className="w-4 h-4" />
                Cameras
              </button>
            </div>
          </div>

          {/* Video area - also the fullscreen target, so it needs a background
              of its own rather than inheriting the page's. */}
          <div ref={stageRef} className={`flex-1 overflow-hidden ${fsSingle ? 'bg-black' : 'bg-surface p-3'}`}>
            {gridMode ? (
              /* Grid view - one tile per camera on the page, nothing else. */
              gridCameras.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3">
                  <div className="w-12 h-12 rounded-2xl border border-line flex items-center justify-center">
                    <Camera className="w-5 h-5 text-fg-muted" />
                  </div>
                  <p className="text-body font-semibold text-fg-muted">{emptyNote}</p>
                </div>
              ) : (
                <div className={`h-full grid auto-rows-fr gap-2 ${gridColClass} ${gridRowClass}`}>
                  {gridCameras.map((cam) => (
                    <div
                      key={cam.id}
                      className={`relative rounded-xl overflow-hidden bg-neutral-950 transition-shadow ${cam.id === focusedId
                        ? 'ring-2 ring-brand shadow-[0_0_0_4px_rgba(247,152,58,0.18)]'
                        : 'ring-1 ring-white/6'
                        }`}
                    >
                      <GridTile
                        camera={cam}
                        onExpand={handleExpandFromGrid}
                        onSelect={(c) => setFocusedId(c.id)}
                        onOpenPlayback={(c) => openPlayback(c)}
                        muted={!unmutedIds.has(cam.id)}
                        onToggleMute={() => toggleTileMute(cam)}
                        paused={pausedIds.has(cam.id)}
                        onTogglePause={() => toggleTilePause(cam)}
                        onSnapshot={(c) => {
                          const msg = explain([snapshotCamera(c)], 'save a snapshot');
                          if (msg) window.alert(msg);
                        }}
                        recording={recordingIds.has(cam.id)}
                      />
                    </div>
                  ))}
                </div>
              )

            ) : selectedCamera ? (
              /* Single view - player on the left, camera panel on the right. */
              <div
                className={`h-full min-h-0 ${fsSingle ? `relative flex ${fsHide ? 'cursor-none' : ''}` : 'flex flex-col gap-3 xl:flex-row'}`}
                onMouseMove={fsSingle ? wakeControls : undefined}
              >
                {/* Left column: player */}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                  {/* Player. data-cam-id is what the capture helpers look for. */}
                  <div
                    data-cam-id={selectedCamera.id}
                    className={`group relative min-h-0 flex-1 overflow-hidden ${fsSingle ? '' : 'rounded-2xl shadow-2xl ring-1 ring-white/6'}`}
                  >
                    <DirectStreamPlayer
                      monitorId={selectedCamera.monitorId}
                      mode="webrtc"           /* auto: WebRTC → silent HLS fallback */
                      quality={fullscreenQuality(selectedCamera)}
                      /* Starts muted so autoplay isn't blocked (Chrome throws
                         NotAllowedError on autoplay-with-sound → black frame).
                         The control bar below turns sound on. */
                      muted={singleMuted}
                      controls={false}
                      qualityControl={false}  /* StreamPicker owns stream choice */
                      aiOverlay={false}       /* player defaults it ON - keep the picture clean */
                      protocolBadge={false}   /* the overlay owns the corners */
                      className="w-full h-full"
                    />

                    {/* Top overlay. Normally just the stream picker, top
                        right. In fullscreen the camera card owns that corner,
                        so the picker moves into the bar and the top says
                        which camera this is - with the page hidden, nothing
                        else on screen does. */}
                    {fsSingle ? (
                      <div className={`absolute inset-x-0 top-0 flex items-baseline gap-2 bg-linear-to-b from-black/60 to-transparent px-4 pt-3 pb-8 text-white ${fadeCls}`}>
                        <span className="truncate text-small font-semibold">{selectedCamera.name}</span>
                        {(selectedGroup?.location || selectedGroup?.name) && (
                          <span className="truncate text-caption text-white/70">
                            {selectedGroup?.location || selectedGroup?.name}
                            {selectedCamera.channel ? ` · Ch ${selectedCamera.channel}` : ''}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="absolute right-3 top-3">
                        <StreamPicker camera={selectedCamera} />
                      </div>
                    )}

                    {/* Transport bar */}
                    <div className={`absolute inset-x-0 bottom-0 flex items-center gap-2 bg-linear-to-t from-black/80 to-transparent px-3 py-2.5 ${fadeCls}`}>
                      <TileBtn onClick={() => setSinglePaused(v => !v)} title={singlePaused ? 'Play' : 'Pause'}>
                        {singlePaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                      </TileBtn>
                      <TileBtn onClick={() => setSingleMuted(v => !v)} title={singleMuted ? 'Unmute' : 'Mute'}>
                        {singleMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                      </TileBtn>
                      <input
                        type="range"
                        min="0" max="1" step="0.05"
                        value={singleVolume}
                        onChange={(e) => { setSingleVolume(Number(e.target.value)); setSingleMuted(false); }}
                        aria-label="Volume"
                        className="h-1 w-24 cursor-pointer accent-brand"
                      />

                      {/* Live state and clock sit here rather than over the
                          picture: the player draws its own buffering pill in
                          the top-left corner and the two overlapped. */}
                      <span className="mx-auto flex items-center gap-2">
                        {selectedCamera.status === 'online' && (
                          <span className="flex shrink-0 items-center gap-1.5 text-caption font-bold tracking-widest text-danger">
                            <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />LIVE
                          </span>
                        )}
                        <TileClock className="text-caption font-medium text-white/75" />
                      </span>

                      <span className="flex items-center gap-2">
                        {fsSingle && <StreamPicker camera={selectedCamera} />}
                        <TileBtn onClick={singleSnapshot} title="Save a still">
                          <ImageDown className="h-3.5 w-3.5" />
                        </TileBtn>
                        <TileBtn onClick={singleRecord} title={recordingIds.has(selectedCamera.id) ? 'Stop and save the clip' : 'Record a clip (saved to this computer)'}>
                          <Circle className={`h-3.5 w-3.5 ${recordingIds.has(selectedCamera.id) ? 'fill-danger text-danger animate-pulse' : ''}`} />
                        </TileBtn>
                        {fsSingle && (
                          <TileBtn
                            onClick={() => setFsPanelOpen(v => !v)}
                            title={fsPanelOpen ? 'Hide camera panel' : 'Show camera panel'}
                            active={fsPanelOpen}
                          >
                            <PanelRight className="h-3.5 w-3.5" />
                          </TileBtn>
                        )}
                        <TileBtn onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </TileBtn>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right column: camera panel. Collapsible, mirroring the
                    camera list on the left: beside the player (xl) it folds
                    to an icon rail and the video takes the width; stacked
                    under the player it folds to a single bar. */}
                <aside
                  ref={fsPanelRef}
                  className={fsSingle
                    /* Fullscreen: a dark glass card over the top-right of the
                       video, clear of the bar. Faded out rather than
                       unmounted, so an audio session survives closing it. */
                    ? `dark absolute right-3 top-3 z-20 max-h-[calc(100%-5rem)] w-75 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-white/12 bg-black/70 text-fg shadow-2xl backdrop-blur-md transition-[opacity,translate] duration-200 ${fsPanelOpen && !fsHide ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-3 opacity-0'}`
                    : `flex w-full shrink-0 flex-col gap-3 overflow-y-auto transition-[width] duration-250 ease-in-out ${detailsOpen ? 'xl:w-80' : 'xl:w-12'}`}
                  aria-hidden={fsSingle && !fsPanelOpen ? true : undefined}
                >
                  {!detailsOpen && !fsSingle && (
                    <nav
                      aria-label="Camera panel"
                      className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1.5 xl:flex-col"
                    >
                      <button
                        type="button"
                        onClick={() => setDetailsPanel(true)}
                        title="Show camera panel"
                        aria-label="Show camera panel"
                        aria-expanded={false}
                        className="order-last ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg xl:order-first xl:ml-0"
                      >
                        <ChevronLeft className="hidden h-4 w-4 xl:block" />
                        <ChevronDown className="h-4 w-4 xl:hidden" />
                      </button>
                      {/* A tab icon reopens the panel straight onto that tab. */}
                      {detailTabs.map(t => (
                        <Tooltip key={t.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => { setDetailTab(t.id); setDetailsPanel(true); }}
                              aria-label={t.label}
                              className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-small font-bold text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg xl:w-8 xl:justify-center xl:px-0"
                            >
                              <t.icon className="h-4 w-4 shrink-0" />
                              <span className="xl:hidden">{t.label}</span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="left" sideOffset={8}>{t.label}</TooltipContent>
                        </Tooltip>
                      ))}
                    </nav>
                  )}

                  {/* Details / Two-Way Audio. PTZ joins the tabs
                      only for a camera whose driver reports it - today none
                      do, and a disabled D-pad explaining itself was a whole
                      panel of nothing. Snapshot, clip and mute are on the
                      player's own bar, so they are not repeated here.
                      Folding HIDES rather than unmounts it, so a two-way audio
                      session keeps running while the panel is out of the way. */}
                  <section className={fsSingle ? '' : `rounded-xl border border-line bg-surface ${detailsOpen ? '' : 'hidden'}`}>
                    <div className="flex border-b border-line">
                      {detailTabs.map(t => (
                        <button
                          key={t.id}
                          onClick={() => setDetailTab(t.id)}
                          className={`flex-1 whitespace-nowrap px-2 py-2.5 text-small font-bold transition-colors ${detailTab === t.id
                            ? 'border-b-2 border-brand text-brand'
                            : 'text-fg-muted hover:text-fg'
                            }`}
                        >
                          {t.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => (fsSingle ? setFsPanelOpen(false) : setDetailsPanel(false))}
                        title="Hide camera panel"
                        aria-label="Hide camera panel"
                        aria-expanded
                        className="my-1.5 mr-1.5 grid w-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg"
                      >
                        {fsSingle ? <X className="h-4 w-4" /> : (
                          <>
                            <ChevronRight className="hidden h-4 w-4 xl:block" />
                            <ChevronUp className="h-4 w-4 xl:hidden" />
                          </>
                        )}
                      </button>
                    </div>

                    {detailTab === 'talk' ? (
                      <TalkBackPanel key={selectedCamera.monitorId} monitorId={selectedCamera.monitorId} />
                    ) : detailTab === 'ptz' && PTZ_CAPABLE_DEVICES.has(selectedGroup?.deviceType) ? (
                      <div className="p-3">
                        <PtzControl deviceType={selectedGroup?.deviceType} />
                      </div>
                    ) : (
                      <div className="divide-y divide-line/60 px-3 py-1">
                        <DetailRow icon={Radio} label="Status">
                          <span className={selectedCamera.status === 'online' ? 'text-success' : 'text-fg-muted'}>
                            {selectedCamera.status === 'online' ? 'Live' : 'Offline'}
                          </span>
                        </DetailRow>
                        <DetailRow icon={Building2} label="Site" valueIcon={Building2}>{siteNameFor(selectedGroup) || '--'}</DetailRow>
                        <DetailRow icon={MapPin} label="Location" valueIcon={MapPin}>{selectedGroup?.location || selectedGroup?.name || '--'}</DetailRow>
                        <DetailRow icon={HardDrive} label="Device" valueIcon={HardDrive}>
                          {selectedGroup
                            ? `${selectedGroup.name}${selectedCamera.channel ? ` · Ch ${selectedCamera.channel}` : ''}`
                            : '--'}
                        </DetailRow>
                        <DetailRow icon={Cctv} label="Camera Type" valueIcon={Cctv}>
                          {selectedGroup?.deviceType
                            ? `IP Camera (${selectedGroup.deviceType.charAt(0).toUpperCase()}${selectedGroup.deviceType.slice(1)})`
                            : 'IP Camera'}
                        </DetailRow>
                        <DetailRow icon={Monitor} label="Resolution" valueIcon={Monitor}>
                          {selectedCamera.width && selectedCamera.height
                            ? `${selectedCamera.width} x ${selectedCamera.height}`
                            : 'Not reported yet'}
                        </DetailRow>
                        <DetailRow icon={Activity} label="Stream" valueIcon={Activity}>
                          {(selectedCamera.streamQuality || selectedGroup?.streamQuality || 'auto') === 'sub'
                            ? 'Sub stream (RTSP)'
                            : 'Main stream (RTSP)'}
                        </DetailRow>
                        <DetailRow icon={Clock} label="Last Online" valueIcon={Clock}>
                          {selectedCamera.status === 'online'
                            ? 'Now'
                            : (relativeTime(selectedCamera.lastSeenAt) || '--')}
                        </DetailRow>
                      </div>
                    )}
                  </section>
                </aside>
              </div>

            ) : (
              /* No camera selected */
              <div className="h-full flex flex-col items-center justify-center gap-5 text-center px-6">
                <div className={`w-20 h-20 rounded-3xl flex items-center justify-center ${missingMonitor ? 'bg-warning-soft' : 'bg-brand/10'}`}>
                  <Video className={`w-10 h-10 ${missingMonitor ? 'text-warning-ink' : 'text-brand/40'}`} />
                </div>
                <div className="max-w-md">
                  {missingMonitor ? (
                    <>
                      {/* Deep-link target not in the accessible camera list.
                          Spell out WHY the camera isn't shown instead of
                          silently picking a different one — that was the
                          "always lands on camera 05" complaint. */}
                      <p className="text-heading font-bold text-fg">That camera isn't available to you</p>
                      <p className="text-body text-fg-muted mt-2 leading-relaxed">
                        We couldn't find the camera linked from the previous page in your camera list. It may have been removed, renamed, or it's in a group you don't have access to.
                      </p>
                      <p className="mt-3 inline-block rounded-lg bg-surface-muted px-2 py-1 font-mono text-small text-fg-secondary">
                        requested: {missingMonitor}
                      </p>
                      <p className="text-body text-fg-muted mt-3 leading-relaxed">
                        Pick a different camera from the left panel to start watching.
                      </p>
                    </>
                  ) : (
                    <>
                      {/* Headline */}
                      <p className="text-heading font-bold text-fg">No camera selected</p>
                      {/* Paragraph */}
                      <p className="text-body text-fg-muted mt-2 max-w-xs leading-relaxed">
                        {loading
                          ? 'Loading cameras…'
                          : 'Choose a camera from the left panel to start watching the live feed.'
                        }
                      </p>
                    </>
                  )}
                </div>
                {/* Mobile: open camera list */}
                {!loading && groups.length > 0 && (
                  <button
                    onClick={() => setMobileSheetOpen(true)}
                    className="flex md:hidden items-center gap-2 px-4 py-2.5 rounded-xl bg-brand text-white text-body font-semibold hover:bg-brand-hover transition-colors"
                  >
                    <Camera className="w-4 h-4" />
                    Choose Camera
                  </button>
                )}
              </div>
            )}
          </div>

          {/* The tile the operator clicked: who it is, where, and the next
              step for that one camera. Esc or the X lets go of it. */}
          {focusedCamera && (() => {
            const g = groups.find(x => x.id === focusedCamera.groupId);
            return (
              <SelectedCameraStrip
                camera={focusedCamera}
                place={[siteNameFor(g), g?.location || g?.name].filter(Boolean).join(' › ')}
                soundOn={unmutedIds.has(focusedCamera.id)}
                onSingle={() => handleExpandFromGrid(focusedCamera)}
                onPlayback={() => openPlayback(focusedCamera)}
                onSnapshot={() => {
                  const msg = explain([snapshotCamera(focusedCamera)], 'save a snapshot');
                  if (msg) window.alert(msg);
                }}
                onClose={() => setFocusedId(null)}
              />
            );
          })()}

          {/* Selection bar. Everything here acts on every camera in the grid.
              Snapshot and clip are captured in the browser from the tiles
              themselves - there is no server-side still API, and backend
              recording is the continuous per-camera setting, which is not
              something a button on this page should be flipping. */}
          {gridMode && gridCameras.length > 0 && (
            <div className="shrink-0 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-2.5">
              <span className="mr-auto text-small font-semibold text-fg-muted">
                On screen · {gridCameras.length} camera{gridCameras.length === 1 ? '' : 's'}
              </span>

              {/* Icon and label both describe the ACTION, not the current
                  state - a crossed-out speaker next to the word Unmute reads
                  as a contradiction. */}
              <ActionBtn onClick={toggleMuteAll} icon={anyUnmuted ? VolumeX : Volume2}>
                {anyUnmuted ? 'Mute all' : 'Unmute all'}
              </ActionBtn>

              <ActionBtn onClick={snapshotSelected} icon={ImageDown}>
                Snapshot all
              </ActionBtn>

              {/* "Record" alone read as "turn on recording for these cameras";
                  what it does is save a clip of each tile to this computer. */}
              <ActionBtn
                onClick={toggleRecordSelected}
                icon={Circle}
                active={anyRecording}
                title={anyRecording ? 'Stop and download the clips' : 'Record a clip of every tile - saved to this computer, not the server'}
              >
                {anyRecording
                  ? `Stop & save (${gridCameras.filter(c => recordingIds.has(c.id)).length})`
                  : 'Record clips'}
              </ActionBtn>

              {wallOn ? (
                <ActionBtn onClick={sendToMonitorWall} icon={Tv}>
                  Add to video wall
                </ActionBtn>
              ) : null}
            </div>
          )}
        </div>
        </PageCard>
        </RequireCameras>
      </PageContent>

      {/*  Mobile camera bottom sheet  */}
      <MobileCameraSheet
        open={mobileSheetOpen}
        onClose={() => setMobileSheetOpen(false)}
        groups={filteredGroups}
        selectedCamera={listSelection}
        onSelectCamera={handleSelectCamera}
        gridCameras={gridCameras}
        gridMode={gridMode}
        onRefresh={handleRefresh}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />
    </OperationsPage>
  );
}

