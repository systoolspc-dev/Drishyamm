// Monitor Wall — the operator's screen. Opening it shows a wall straight
// away, inside the app chrome (sidebar and top bar stay): a 3 × 3 of every
// camera, or the saved wall this person picked last time. "Full screen"
// hands the same wall, on the same page, to MonitorWallLive.
//
// Each recorder serves at most NVR_PULL_LIMIT streams (model.js), so on a
// page the cameras past a recorder's budget show a refreshing still with a
// "Preview" badge instead of a player. Nothing on this page can jam an NVR;
// a saved wall still goes through the recorder check before full screen,
// because there every tile is live.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Maximize2, Pencil, Tv, VideoOff,
} from 'lucide-react';
import { OperationsPage, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { useGroups } from '@/core/hooks/useQueries';
import { useAuthStore } from '@/core/store/authStore';
import { canManageWalls } from '@/core/nav/entitlements';
import { siteService } from '@/core/services/site';
import { wallLayoutService } from '@/core/services/wallLayouts';
import { releaseAllStreams } from '@/core/services/streamCache';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import { RequireCameras } from '@/core/components/RequireCameras';
import { Dialog, DialogContent } from '@/core/ui/dialog';
import { OfflineBody, WallTile } from './monitor-wall/WallTile';
import * as M from './monitor-wall/model';

// The builder (drag-and-drop, pages, recorder load, saved layouts) opens in a
// dialog over the wall; it is heavy, so it loads when first asked for.
const WallBuilder = lazy(() => import('./MonitorWall'));

const AUTO = 'auto';

// Live View's "Add to Monitor Wall" leaves cameras for the builder to pick up.
const hasLiveViewPick = () => {
  try { return !!localStorage.getItem('monitorWall.pick'); } catch { return false; }
};

export default function MonitorWallHome() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const manage = canManageWalls(user);

  const { data: groups = [] } = useGroups({ refetchInterval: 30_000 });
  const { data: sitesRaw } = useQuery({ queryKey: ['sites'], queryFn: () => siteService.list(), staleTime: 60_000 });
  const sites = useMemo(() => (Array.isArray(sitesRaw) ? sitesRaw : (sitesRaw?.data ?? [])), [sitesRaw]);
  const layoutsQ = useQuery({ queryKey: ['wall-layouts'], queryFn: () => wallLayoutService.list(), staleTime: 15_000 });
  const layouts = useMemo(() => layoutsQ.data ?? [], [layoutsQ.data]);
  const { cameras, byId, groupsById } = useMemo(() => M.indexCameras(groups, sites), [groups, sites]);

  const onlineCount = cameras.filter((c) => c.status === 'online').length;
  const offlineCount = cameras.length - onlineCount;

  // ── Which wall ───────────────────────────────────────────────────────────
  // The 3 × 3 of everything, unless this person chose a saved wall before.
  const auto = useMemo(() => M.buildAutoWall(cameras), [cameras]);
  const [choice, setChoice] = useState(() => {
    const me = M.readMe(user?.id);
    return me.wallId || me.lastOpenedId || AUTO;
  });
  const saved = choice === AUTO ? null : layouts.find((l) => l.id === choice) || null;
  const layout = useMemo(() => (saved ? M.fromLayout(saved) : auto), [saved, auto]);
  const pages = useMemo(() => M.playablePages(layout, byId), [layout, byId]);
  const pageCount = pages.length;

  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, pageCount - 1));
  const slots = useMemo(() => pages[current] || [], [pages, current]);
  const live = useMemo(() => M.liveBudget(slots, byId), [slots, byId]);
  const [focusedId, setFocusedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const expanded = expandedId ? byId.get(expandedId) : null;

  const choose = (v) => {
    setChoice(v);
    setPage(0);
    setExpandedId(null);
    M.rememberMe(user?.id, { wallId: v });
  };
  const goTo = (i) => { if (pageCount) setPage(((i % pageCount) + pageCount) % pageCount); };

  // ── Edit wall (the builder, in a dialog) ─────────────────────────────────
  // { layoutId } edits a saved wall; { draft } shapes the 3 × 3 of everything
  // into a wall that can be saved; {} lets the builder pick up a Live View
  // selection. When it closes with a saved layout, the wall shows that one.
  const [editing, setEditing] = useState(() => (manage && hasLiveViewPick() ? {} : null));
  const openEditor = () => setEditing(saved ? { layoutId: saved.id } : { draft: layout });
  const closeEditor = (savedId) => {
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['wall-layouts'] });
    if (typeof savedId === 'string' && savedId) choose(savedId);
  };

  // Leaving the page drops every stream it opened.
  useEffect(() => () => releaseAllStreams(), []);

  // ── Full screen ──────────────────────────────────────────────────────────
  const [overLimit, setOverLimit] = useState(null);
  // Awaited before navigating: the request is asynchronous, and swapping the
  // route in the same tick tears down the page that asked for it.
  const enterFullscreen = async () => {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* refused */ }
  };
  // `fs=1` only on the full-screen route, not the pop-out window: a second
  // monitor's window is placed and sized by the operator, not by us.
  const go = async (url, newWindow) => {
    if (newWindow) window.open(url, 'drishyam-monitor-wall', 'popup,width=1280,height=720');
    else { await enterFullscreen(); navigate(url + '&fs=1'); }
  };
  const fullScreen = (newWindow = false) => {
    if (saved) {
      // The big screen budgets its pulls per page like this one does, so the
      // only thing left to warn about is a saved wall that rotates: the
      // outgoing page keeps pulling while the incoming page starts.
      const { peak } = M.recorderLoad(layout, byId);
      const over = [...peak.entries()]
        .filter(([, n]) => n > M.NVR_PULL_LIMIT)
        .map(([g, n]) => ({ name: groupsById.get(g)?.name || 'A recorder', count: n }));
      const run = () => go(`/monitor-wall/live?layout=${encodeURIComponent(saved.id)}&page=${current}`, newWindow);
      if (over.length) setOverLimit({ over, run });
      else run();
    } else {
      M.writeQuickDraft(layout);
      go(`/monitor-wall/live?quick=1&page=${current}`, newWindow);
    }
  };

  // F = full screen, ← → = page, Esc = back from a single camera.
  const keys = useRef({});
  useEffect(() => { keys.current = { fullScreen, goTo, current, expandedId }; });
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const k = keys.current;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); k.fullScreen(); }
      else if (e.key === 'ArrowRight') k.goTo(k.current + 1);
      else if (e.key === 'ArrowLeft') k.goTo(k.current - 1);
      else if (e.key === 'Escape' && k.expandedId) setExpandedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const liveCount = live.size;
  const previewCount = slots.filter((id) => id && byId.get(id)?.status === 'online' && !live.has(id)).length;
  const busy = previewCount
    ? [...new Set(slots.filter((id) => id && !live.has(id) && byId.get(id)?.status === 'online').map((id) => groupsById.get(byId.get(id).groupId)?.name || 'a recorder'))]
    : [];

  return (
    <OperationsPage>
      <PageHeader
        icon={Tv}
        title="Video wall"
        descriptionAs="tooltip"
        description="Your wall, on this screen. Pick another wall from the list, use ← → for pages, double-click a camera to see it big, and press F for full screen."
        tagline="Live camera feeds across your saved walls, page by page."
        actions={(
          <>
            <label className="relative" title="Which wall to show">
              <select
                value={saved ? saved.id : AUTO}
                onChange={(e) => choose(e.target.value)}
                className="h-9 cursor-pointer appearance-none rounded-lg border border-line bg-surface pl-3 pr-8 text-small font-semibold text-fg outline-none transition hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <option value={AUTO}>{M.AUTO_WALL_NAME} · 3 × 3</option>
                {layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            </label>
            {/* THE page control. The wall's own footer used to carry clickable
                page dots and a second "Page x of y", and the shortcut legend a
                third pair of arrows - three ways to change page on one screen.
                One control, in one place; the buttons name their keys. */}
            {pageCount > 1 && (
              <span className="inline-flex h-9 items-center rounded-lg border border-line bg-surface">
                <PagerButton onClick={() => goTo(current - 1)} label="Previous page (←)"><ChevronLeft className="h-4 w-4" /></PagerButton>
                <span className="px-1 text-small font-semibold tabular-nums text-fg-secondary">Page {current + 1} of {pageCount}</span>
                <PagerButton onClick={() => goTo(current + 1)} label="Next page (→)"><ChevronRight className="h-4 w-4" /></PagerButton>
              </span>
            )}
            <Chip tone="success">{onlineCount} online</Chip>
            {offlineCount > 0 && <Chip tone="danger">{offlineCount} offline</Chip>}
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            {manage && (
              <button
                type="button"
                onClick={openEditor}
                title="Edit this wall in the layout builder"
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
              >
                <Pencil className="h-4 w-4" />
                Edit wall
              </button>
            )}
            <button
              type="button"
              onClick={() => fullScreen(true)}
              disabled={!cameras.length}
              title="Open the wall in its own window, to drag onto a second monitor"
              className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => fullScreen(false)}
              disabled={!cameras.length}
              title="Full screen (F)"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand pl-3.5 pr-2 text-body font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-50"
            >
              <Maximize2 className="h-4 w-4" />
              Full screen
              <kbd className="grid h-5 min-w-5 place-items-center rounded border border-white/35 bg-white/15 px-1 text-caption font-semibold">F</kbd>
            </button>
          </>
        )}
      />

      <PageContent>
        <RequireCameras
          canSetup={manage}
          description="Add a recorder or camera in Camera Setup and the wall fills itself."
        >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-black shadow-sm ring-1 ring-line">
          {!cameras.length ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-white">
              <VideoOff className="h-10 w-10 text-white/40" />
              <p className="text-heading text-white">No cameras yet</p>
              <p className="max-w-md text-body text-white/60">
                {manage ? 'Add a recorder or camera in Camera Setup and the wall fills itself.' : 'Your admin has not added cameras to this account yet.'}
              </p>
              {manage && (
                <Link to="/camera-setup" className="mt-2 inline-flex h-9 items-center rounded-lg bg-brand px-4 text-body font-semibold text-white hover:bg-brand-hover">
                  Camera Setup
                </Link>
              )}
            </div>
          ) : expanded ? (
            <div className="relative flex-1 bg-black">
              {expanded.status === 'online' ? (
                <DirectStreamPlayer
                  monitorId={expanded.monitorId}
                  mode="webrtc"
                  quality="high"
                  muted={!layout.focusAudio}
                  controls={false}
                  qualityControl={false}
                  protocolBadge={false}
                  aiOverlay={false}
                  digitalZoom={false}
                  className="absolute inset-0 h-full w-full"
                />
              ) : (
                <OfflineBody camera={expanded} large />
              )}
              <div className="absolute left-3 top-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setExpandedId(null)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-black/60 px-2.5 text-body font-semibold text-white backdrop-blur hover:bg-black/80"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to wall
                  <Key>Esc</Key>
                </button>
                <span className="text-heading text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">{expanded.name}</span>
              </div>
            </div>
          ) : (
            <div
              className="grid min-h-0 flex-1 gap-1 bg-black p-1"
              style={{
                gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
              }}
            >
              {slots.map((id, i) => (
                <WallTile
                  key={id || `empty-${current}-${i}`}
                  slot={i}
                  monitorId={id}
                  camera={id ? byId.get(id) : null}
                  still={!!id && !live.has(id)}
                  focused={focusedId === id}
                  audible={!!layout.focusAudio && focusedId === id}
                  onFocus={() => setFocusedId((f) => (f === id ? null : id))}
                  onExpand={() => setExpandedId(id)}
                />
              ))}
            </div>
          )}

          {cameras.length > 0 && !expanded && (
            <div className="flex h-9 shrink-0 items-center gap-3 border-t border-white/10 bg-neutral-950 px-3.5 text-small text-white/60">
              <span className="truncate font-semibold text-white/85">{layout.name}</span>
              <span className="text-white/25">·</span>
              <span className="tabular-nums">{liveCount} live</span>
              {previewCount > 0 && (
                <span className="tabular-nums" title={`Each recorder serves at most ${M.NVR_PULL_LIMIT} streams; the rest of its cameras are shown as refreshing stills.`}>
                  · {previewCount} preview{previewCount === 1 ? '' : 's'} <span className="text-white/40">({busy.join(', ')} at its limit of {M.NVR_PULL_LIMIT} streams)</span>
                </span>
              )}
              <span className="flex-1" />
              <span className="hidden items-center gap-1 text-white/40 xl:flex">
                <Key>F</Key> full screen · double-click a camera
              </span>
            </div>
          )}
        </div>
        </RequireCameras>
      </PageContent>

      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) closeEditor(); }}>
        <DialogContent
          data-wall-builder=""
          showCloseButton={false}
          aria-describedby={undefined}
          className="flex h-[calc(var(--app-vh)*0.92)] w-[calc(var(--app-vw)*0.96)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {editing && (
            <Suspense fallback={(
              <div className="grid flex-1 place-items-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
              </div>
            )}>
              <WallBuilder initialLayoutId={editing.layoutId || null} initialDraft={editing.draft || null} onClose={closeEditor} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!overLimit}
        onOpenChange={(v) => { if (!v) setOverLimit(null); }}
        title="Rotation would push a recorder over its limit"
        description={overLimit ? (
          <>
            {overLimit.over.map((o) => (
              <span key={o.name} className="block">
                <b>{o.name}</b> would serve {o.count} streams for a moment each time the wall changes page — the
                outgoing page keeps pulling for {M.HANDOVER_SECONDS} seconds. It can handle {M.NVR_PULL_LIMIT}.
              </span>
            ))}
            <span className="mt-2 block">
              Opening it anyway may knock its cameras offline for everyone. Turning rotation off in the wall’s
              settings fixes it.
            </span>
          </>
        ) : null}
        confirmLabel="Open anyway"
        tone="warning"
        onConfirm={() => overLimit?.run()}
      />
    </OperationsPage>
  );
}

function PagerButton({ onClick, label, children }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="grid h-9 w-8 place-items-center text-fg-muted transition hover:text-fg">
      {children}
    </button>
  );
}

function Chip({ tone, children }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-small font-semibold border-${tone}-line bg-${tone}-soft text-${tone}-ink`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-${tone}`} />
      {children}
    </span>
  );
}

function Key({ children }) {
  return (
    <kbd className="inline-grid h-5 min-w-5 place-items-center rounded border border-white/20 px-1 text-caption font-semibold text-white/70">
      {children}
    </kbd>
  );
}
