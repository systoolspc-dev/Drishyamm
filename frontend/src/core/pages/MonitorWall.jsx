// Monitor Wall — the setup page. An operator picks cameras, arranges them on
// a grid across one or more pages, and launches the wall full screen on this
// screen or a second monitor (MonitorWallLive). Layouts are saved to the
// account, so everyone in a control room works from the same walls.
//
// What the editor shows is a DRAFT. It is written to localStorage on every
// change, so a reload keeps unsaved work and the wall can play it before it
// is saved. `baseline` is the saved layout the draft started from; the
// difference between the two is what "Unsaved changes" means.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, LayoutGrid, Play } from 'lucide-react';
import { PageIcon } from '@/core/layout/OperationsPage';
import { useGroups } from '@/core/hooks/useQueries';
import { siteService } from '@/core/services/site';
import { wallLayoutService } from '@/core/services/wallLayouts';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import CameraLibrary from './monitor-wall/CameraLibrary';
import WallEditor from './monitor-wall/WallEditor';
import WallSettings from './monitor-wall/WallSettings';
import SavedLayouts from './monitor-wall/SavedLayouts';
import * as M from './monitor-wall/model';

// Live View's "Add to Monitor Wall" leaves the cameras it had in its grid here.
const PICK_KEY = 'monitorWall.pick';
const NOTICE_MS = 8000;

function takeLiveViewPick() {
  try {
    const pick = JSON.parse(localStorage.getItem(PICK_KEY) || 'null');
    localStorage.removeItem(PICK_KEY);
    return Array.isArray(pick) ? pick.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// Rendered inside the Monitor Wall page's "Edit wall" dialog, never as a page
// of its own. `initialLayoutId` opens a saved layout; `initialDraft` opens an
// unsaved wall (the 3 × 3 of everything) so it can be shaped and saved under
// a name. `onClose(savedId)` hands back which layout to show on the wall.
export default function MonitorWall({ initialLayoutId = null, initialDraft = null, onClose }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wantId = initialLayoutId;

  const { data: groups = [], isFetching: groupsFetching } = useGroups({ refetchInterval: 30_000 });
  const { data: sitesRaw } = useQuery({ queryKey: ['sites'], queryFn: () => siteService.list(), staleTime: 60_000 });
  const sites = useMemo(() => (Array.isArray(sitesRaw) ? sitesRaw : (sitesRaw?.data ?? [])), [sitesRaw]);
  const layoutsQ = useQuery({ queryKey: ['wall-layouts'], queryFn: () => wallLayoutService.list(), staleTime: 15_000 });
  const layouts = useMemo(() => layoutsQ.data ?? [], [layoutsQ.data]);

  const { cameras, byId, groupsById } = useMemo(() => M.indexCameras(groups, sites), [groups, sites]);

  const [draft, setDraft] = useState(() => M.readLocalDraft() || M.newDraft());
  const [baseline, setBaseline] = useState(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(null);
  const [discard, setDiscard] = useState(null);
  const [overLimit, setOverLimit] = useState(null);
  const display = useMemo(() => M.displayInfo(), []);
  const noticeTimer = useRef(null);

  const flash = useCallback((text, onUndo) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, onUndo: onUndo ? () => { onUndo(); setNotice(null); } : null });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // First load, once the saved layouts are known: a pick sent from Live View
  // wins, then the local draft (re-attached to its saved layout), then the
  // most recently edited saved layout.
  useEffect(() => {
    if (ready || !layoutsQ.isFetched) return;
    const local = M.readLocalDraft();
    const savedFor = (d) => (d?.id ? layouts.find((l) => l.id === d.id) : null);
    const restore = (d) => {
      const saved = savedFor(d);
      setDraft(saved || !d.id ? d : { ...d, id: null });
      setBaseline(saved ? M.fromLayout(saved) : null);
    };

    const pick = takeLiveViewPick();
    const wanted = wantId ? layouts.find((l) => l.id === wantId) : null;
    if (initialDraft) {
      setDraft(M.newDraft({ ...initialDraft, id: null }));
      setBaseline(null);
    } else if (wanted) {
      const d = M.fromLayout(wanted);
      setDraft(d);
      setBaseline(d);
    } else if (pick.length) {
      const side = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(pick.length))));
      let d = M.newDraft({ name: 'From Live View', cols: side, rows: side });
      for (const id of pick) d = M.addCamera(d, id, 0).draft;
      setDraft(d);
      setBaseline(null);
      flash(`Loaded ${pick.length} camera${pick.length === 1 ? '' : 's'} from Live View`, local ? () => restore(local) : null);
    } else if (local) {
      restore(local);
    } else if (layouts.length) {
      const d = M.fromLayout(layouts[0]);
      setDraft(d);
      setBaseline(d);
    }
    setReady(true);
  }, [ready, layoutsQ.isFetched, layouts, flash, wantId, initialDraft]);

  useEffect(() => { if (ready) M.writeLocalDraft(draft); }, [draft, ready]);

  const pageCount = draft.pages.length;
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [page, pageCount]);
  useEffect(() => { if (selected && selected.page > pageCount - 1) setSelected(null); }, [selected, pageCount]);

  const dirty = baseline ? !M.sameLayout(draft, baseline) : M.cameraIds(draft).length > 0;

  // A change that can be undone from the notice line.
  const change = (next, text) => {
    const prev = draft;
    setDraft(next);
    if (text) flash(text, () => setDraft(prev));
  };

  // ── Recorder load ────────────────────────────────────────────────────────
  // What each recorder will serve: the streams the wall pulls on its busiest
  // page, the cameras it shows as stills instead, and the peak across a
  // rotation handover - the one thing that can still take it over the limit.
  const load = useMemo(() => M.recorderLoad(draft, byId), [draft, byId]);
  const recorders = useMemo(() => [...new Set([...load.live.keys(), ...load.preview.keys()])]
    .map((groupId) => {
      const g = groupsById.get(groupId);
      const siteName = g?.siteId ? sites.find((s) => s.id === g.siteId)?.name : null;
      return {
        groupId,
        live: load.live.get(groupId) || 0,
        preview: load.preview.get(groupId) || 0,
        peak: load.peak.get(groupId) || 0,
        name: g?.name || 'Recorder',
        detail: g?.location || siteName || g?.host || '',
      };
    })
    .sort((a, b) => (b.live + b.preview) - (a.live + a.preview)), [load, groupsById, sites]);

  const onWall = M.cameraIds(draft).map((id) => byId.get(id)).filter(Boolean);
  const canAutoFill = M.autoFillable(draft, cameras);
  const onlineCount = onWall.filter((c) => c.status === 'online').length;
  const offlineCount = onWall.length - onlineCount;
  const playCount = M.playablePages(draft, byId).length;

  // ── Launch ───────────────────────────────────────────────────────────────
  // A page can no longer flood a recorder - the wall budgets its pulls. What
  // is left to check is the rotation handover: the outgoing page keeps
  // pulling for HANDOVER_SECONDS while the incoming one starts, so two pages
  // off one recorder can still meet over its limit.
  const guardLimit = (layout, run) => {
    const { peak } = M.recorderLoad(layout, byId);
    const over = [...peak.entries()]
      .filter(([, n]) => n > M.NVR_PULL_LIMIT)
      .map(([g, n]) => ({ name: groupsById.get(g)?.name || 'A recorder', count: n }));
    if (over.length) setOverLimit({ over, run });
    else run();
  };
  // Called straight from a click or key press: the browser only allows
  // fullscreen inside a user gesture. The wall is a route in this same
  // document, so fullscreen carries over when it opens. AWAITED, because the
  // request is asynchronous and navigating in the same tick tears down the
  // page that asked. If the browser refuses, carry on anyway - the wall URL
  // carries fs=1 and offers the way back.
  const enterFullscreen = async () => {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* refused */ }
  };

  const launchCurrent = () => guardLimit(draft, async () => {
    M.writeLocalDraft(draft);
    await enterFullscreen();
    navigate(M.wallUrl(draft, dirty, true));
  });
  const openWindow = () => guardLimit(draft, () => {
    M.writeLocalDraft(draft);
    window.open(M.wallUrl(draft, dirty), 'drishyam-monitor-wall', 'popup,width=1280,height=720');
  });
  const launchSaved = (l) => {
    if (l.id === draft.id) { launchCurrent(); return; }
    guardLimit(M.fromLayout(l), async () => {
      await enterFullscreen();
      navigate(`/monitor-wall/live?layout=${encodeURIComponent(l.id)}&fs=1`);
    });
  };

  // F launches, Esc stops filling a slot — except while typing or in a dialog.
  const keys = useRef({});
  useEffect(() => {
    keys.current = { launchCurrent, selected };
  });
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // The builder itself lives in a dialog; only a dialog on top of it
      // (name, confirm) takes the keys away.
      if (document.querySelector('[role="dialog"]:not([data-wall-builder])')) return;
      if (e.key === 'Escape' && keys.current.selected) setSelected(null);
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); keys.current.launchCurrent(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Save ─────────────────────────────────────────────────────────────────
  const persist = async (mode, name) => {
    setSaving(true);
    try {
      const body = M.toPayload({ ...draft, name: name ?? draft.name });
      const saved = mode === 'update'
        ? await wallLayoutService.update(draft.id, body)
        : await wallLayoutService.create(body);
      const d = M.fromLayout(saved);
      setDraft(d);
      setBaseline(d);
      qc.invalidateQueries({ queryKey: ['wall-layouts'] });
      flash(mode === 'update' ? `Saved “${saved.name}”` : `Saved as “${saved.name}”`);
    } catch (err) {
      throw new Error(err?.response?.data?.message || 'Could not save the layout. Try again.');
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    if (draft.id) persist('update').catch((e) => flash(e.message));
    else setNaming({ mode: 'create', title: 'Save layout', value: draft.name === 'Untitled wall' ? '' : draft.name });
  };
  const saveAsNew = () => setNaming({ mode: 'create', title: 'Save as a new layout', value: draft.id ? `${draft.name} (copy)` : draft.name });

  // ── Open / new / delete ──────────────────────────────────────────────────
  const guardDirty = (title, run) => (dirty ? setDiscard({ title, run }) : run());
  const openLayout = (l) => {
    if (l.id === draft.id && !dirty) return;
    guardDirty(`Open “${l.name}”?`, () => {
      const d = M.fromLayout(l);
      setDraft(d);
      setBaseline(d);
      setPage(0);
      setSelected(null);
    });
  };
  const newLayout = () => guardDirty('Start a new layout?', () => {
    setDraft(M.newDraft());
    setBaseline(null);
    setPage(0);
    setSelected(null);
  });
  const deleteLayout = async (l) => {
    await wallLayoutService.remove(l.id);
    await qc.invalidateQueries({ queryKey: ['wall-layouts'] });
    if (l.id === draft.id) {
      setDraft((d) => ({ ...d, id: null }));
      setBaseline(null);
    }
    flash(`Deleted “${l.name}”`);
  };

  // ── Editing ──────────────────────────────────────────────────────────────
  const pick = (camera) => {
    const id = camera.monitorId;
    if (selected) {
      change(M.place(draft, selected.page, selected.slot, id));
      setPage(selected.page);
      setSelected(null);
      return;
    }
    const existing = M.locate(draft, id);
    if (existing) {
      setPage(existing.page);
      flash(`${camera.name} is already in slot ${M.pad2(existing.slot + 1)}${existing.page !== page ? ` on page ${existing.page + 1}` : ''}`);
      return;
    }
    const { draft: next, at } = M.addCamera(draft, id, page);
    if (!at) { flash(`The wall is full: ${M.MAX_PAGES} pages of ${draft.cols * draft.rows} tiles.`); return; }
    change(next);
    if (at.page !== page) setPage(at.page);
  };
  const selectSlot = (at) => {
    setSelected(at);
    if (at && at.page !== page) setPage(at.page);
  };
  // Fills the whole wall, not just this page: every empty tile takes a camera,
  // and with more cameras than one page holds the rest go on the pages after
  // it and on new pages, so a site of a hundred cameras is one click.
  const autoFill = () => {
    const { draft: next, filled, pagesUsed, left } = M.autoFill(draft, page, cameras);
    if (!filled) {
      flash(left
        ? `The wall is full: ${M.MAX_PAGES} pages of ${draft.cols * draft.rows} tiles.`
        : 'Every online camera is already on the wall.');
      return;
    }
    const where = pagesUsed > 1 ? `across ${pagesUsed} pages` : `to page ${page + 1}`;
    const rest = left ? ` ${left} more did not fit — the wall holds ${M.MAX_PAGES} pages.` : '';
    change(next, `Added ${filled} camera${filled === 1 ? '' : 's'} ${where}.${rest}`);
  };
  const resize = (cols, rows) => {
    if (cols === draft.cols && rows === draft.rows) return;
    change(M.resize(draft, cols, rows), `Changed the grid to ${cols} × ${rows}`);
    setPage(0);
    setSelected(null);
  };
  const removePage = (i) => {
    change(M.removePage(draft, i), `Removed page ${i + 1}`);
    if (page >= i && page > 0) setPage(page - 1);
    setSelected(null);
  };

  const selectedCamera = selected ? byId.get(draft.pages[selected.page]?.[selected.slot]) || null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-3">
          <PageIcon icon={LayoutGrid} />
          <div>
            <DialogTitle className="text-heading font-bold">Wall layouts</DialogTitle>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-success-line bg-success-soft px-2.5 text-small font-semibold text-success-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {onlineCount} online
            </span>
            {offlineCount > 0 && (
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-danger-line bg-danger-soft px-2.5 text-small font-semibold text-danger-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                {offlineCount} offline
              </span>
            )}
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            <button
              type="button"
              onClick={openWindow}
              disabled={!onWall.length}
              title="Open the wall in its own window, to drag onto a second monitor"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-50"
            >
              <ExternalLink className="h-4 w-4" />
              Open in new window
            </button>
            <button
              type="button"
              onClick={launchCurrent}
              disabled={!onWall.length}
              title="Launch the wall full screen (F)"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand pl-3.5 pr-2 text-body font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Launch wall
              <kbd className="grid h-5 min-w-5 place-items-center rounded border border-white/35 bg-white/15 px-1 text-caption font-semibold">F</kbd>
            </button>
            <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            <button
              type="button"
              onClick={() => onClose?.(draft.id)}
              title="Close the builder and show this wall"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg transition hover:bg-surface-sunken"
            >
              <Check className="h-4 w-4" />
              Done
            </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {/* shrink-0: this grid sits in a flex column; left shrinkable it was
            squeezed to the viewport and the editor spilled over Saved layouts.
            At its natural height the page scrolls instead. */}
        <div className="grid min-h-full shrink-0 gap-4 xl:grid-cols-[272px_minmax(0,1fr)_256px] xl:grid-rows-[auto_auto]">
          {/* h-0 + min-h-full: the list takes the height the editor, settings
              and saved layouts set, and scrolls inside it rather than
              stretching the page to the length of every camera. */}
          <div className="flex min-h-0 flex-col max-xl:h-[480px] xl:row-span-2 xl:h-0 xl:min-h-full">
            <CameraLibrary
              cameras={cameras}
              groups={groups}
              sites={sites}
              draft={draft}
              page={page}
              selected={selected}
              selectedCamera={selectedCamera}
              onPick={pick}
              onSelectSlot={selectSlot}
              onCancelFill={() => setSelected(null)}
              onRefresh={() => qc.invalidateQueries({ queryKey: ['groups'] })}
              refreshing={groupsFetching}
            />
          </div>

          <WallEditor
            draft={draft}
            page={Math.min(page, pageCount - 1)}
            onPage={(i) => { setPage(i); }}
            selected={selected}
            onSelect={selectSlot}
            byId={byId}
            dirty={dirty}
            display={display}
            playCount={playCount}
            notice={notice}
            onRename={(name) => setDraft((d) => ({ ...d, name }))}
            onAutoFill={autoFill}
            canAutoFill={canAutoFill}
            onClearPage={() => change(M.clearPage(draft, page), `Cleared page ${page + 1}`)}
            onPlace={(p, s, id) => change(M.place(draft, p, s, id))}
            onSwap={(a, b) => change(M.swapSlots(draft, a, b))}
            onClearSlot={(p, s) => change(M.clearSlot(draft, p, s))}
            onAddPage={() => { change(M.addPage(draft)); setPage(pageCount); }}
            onRemovePage={removePage}
            canAddPage={pageCount < M.MAX_PAGES}
          />

          <WallSettings
            draft={draft}
            cameraCount={M.cameraIds(draft).length}
            pageCount={playCount}
            recorders={recorders}
            handover={load.handover}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            onResize={resize}
            onSave={save}
            onSaveAsNew={saveAsNew}
            saving={saving}
            dirty={dirty}
          />

          <div className="xl:col-span-2 xl:col-start-2">
            <SavedLayouts
              layouts={layouts}
              loading={layoutsQ.isLoading}
              error={layoutsQ.error ? (layoutsQ.error.response?.data?.message || layoutsQ.error.message) : null}
              currentId={draft.id}
              onOpen={openLayout}
              onLaunch={launchSaved}
              onNew={newLayout}
              onDelete={deleteLayout}
            />
          </div>
        </div>
      </div>

      <NameDialog state={naming} onClose={() => setNaming(null)} onSubmit={(name) => persist('create', name)} />

      <ConfirmDialog
        open={!!discard}
        onOpenChange={(v) => { if (!v) setDiscard(null); }}
        title={discard?.title}
        description={<>Your unsaved changes to <b>{draft.name}</b> will be lost.</>}
        confirmLabel="Discard changes"
        tone="warning"
        onConfirm={() => discard?.run()}
      />

      <ConfirmDialog
        open={!!overLimit}
        onOpenChange={(v) => { if (!v) setOverLimit(null); }}
        title="Rotation would push a recorder over its limit"
        description={overLimit ? (
          <>
            When the wall changes page the outgoing page keeps pulling for {M.HANDOVER_SECONDS} seconds, so{' '}
            {overLimit.over.map((r) => `${r.name} would serve ${r.count} streams`).join(', ')} for that moment, and a
            recorder can serve {M.NVR_PULL_LIMIT} at once. Past that it can drop every camera until it is rebooted.
            Turn rotation off, put its cameras on fewer pages, or launch anyway.
          </>
        ) : null}
        confirmLabel="Launch anyway"
        tone="warning"
        onConfirm={() => overLimit?.run()}
      />
    </div>
  );
}

function NameDialog({ state, onClose, onSubmit }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setValue(state?.value ?? '');
    setError(null);
  }, [state]);

  const submit = async (e) => {
    e.preventDefault();
    const name = value.trim();
    if (!name) { setError('Give the layout a name.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!state} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{state?.title}</DialogTitle>
            <DialogDescription>Everyone on your account will see it under Saved layouts.</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={value}
            maxLength={120}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Night shift"
            aria-label="Layout name"
            className="h-10 w-full rounded-lg border border-line bg-surface-sunken px-3 text-body text-fg outline-none transition focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
          />
          {error && (
            <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">{error}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
