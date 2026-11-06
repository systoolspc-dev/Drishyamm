// Saved layouts — the account's walls, shared with everyone on it. Click a
// card to open it in the editor; ▶ launches it straight onto this screen.

import { useMemo, useState } from 'react';
import { Play, Plus, Search, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@/core/ui/confirm-dialog';
import { ago, cameraIds } from './model';

export default function SavedLayouts({ layouts, loading, error, currentId, onOpen, onLaunch, onNew, onDelete }) {
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? layouts.filter((l) => l.name.toLowerCase().includes(q)) : layouts;
  }, [layouts, query]);

  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-heading text-fg">Saved layouts</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {finding ? (
            <label className="flex h-8 w-52 items-center gap-2 rounded-lg border border-brand/40 bg-surface-sunken px-2.5 ring-1 ring-brand/30">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setFinding(false); } }}
                placeholder="Layout name…"
                className="min-w-0 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-fg-muted/60"
              />
              <button type="button" onClick={() => { setQuery(''); setFinding(false); }} title="Close search" className="text-fg-muted hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            </label>
          ) : (
            <HeadButton icon={Search} onClick={() => setFinding(true)} disabled={!layouts.length}>Find layout</HeadButton>
          )}
          <HeadButton icon={Plus} onClick={onNew}>New layout</HeadButton>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-[124px] animate-pulse rounded-xl bg-surface-muted/50" />)}
        </div>
      ) : error ? (
        <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-small text-danger-ink">
          Couldn't load saved layouts. {error}
        </p>
      ) : !layouts.length ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-small text-fg-muted">
          No saved layouts yet. Save this wall to share it with everyone on your account.
        </p>
      ) : !shown.length ? (
        <p className="px-1 py-4 text-small text-fg-muted">No layout called “{query}”.</p>
      ) : (
        <div className="grid auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
          {shown.map((l) => (
            <LayoutCard
              key={l.id}
              layout={l}
              current={l.id === currentId}
              onOpen={() => onOpen(l)}
              onLaunch={() => onLaunch(l)}
              onDelete={() => setDeleting(l)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => { if (!v) setDeleting(null); }}
        title="Delete layout"
        description={deleting ? <>Delete <b>{deleting.name}</b> for everyone on your account? This cannot be undone.</> : null}
        confirmLabel="Delete"
        onConfirm={() => onDelete(deleting)}
      />
    </section>
  );
}

function HeadButton({ icon: Icon, children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-45"
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function LayoutCard({ layout, current, onOpen, onLaunch, onDelete }) {
  const cams = cameraIds(layout).length;
  const pages = layout.pages.length;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      className={`group relative flex cursor-pointer flex-col gap-2.5 rounded-xl border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40 ${current
        ? 'border-brand-line bg-brand-soft'
        : 'border-line bg-surface-sunken/40 hover:border-line-strong'}`}
    >
      <div className="flex items-start justify-between">
        <span
          aria-hidden
          className="grid h-10 w-10 gap-0.5 rounded-lg bg-black p-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
          style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: layout.cols * layout.rows }, (_, i) => (
            <i key={i} className={`rounded-[1.5px] ${current ? 'bg-brand/60' : 'bg-slate-300/35'}`} />
          ))}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete layout"
            className="hidden h-[30px] w-[30px] place-items-center rounded-lg text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger-ink group-hover:grid"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLaunch(); }}
            title={`Launch ${layout.name}`}
            className={`grid h-[30px] w-[30px] place-items-center rounded-lg border transition-colors ${current
              ? 'border-brand bg-brand text-white hover:bg-brand-hover'
              : 'border-line bg-surface text-fg-secondary hover:border-brand-line hover:text-brand'}`}
          >
            <Play className="ml-0.5 h-3 w-3 fill-current" />
          </button>
        </div>
      </div>
      <div className="min-w-0">
        <p className="truncate text-body font-semibold text-fg">{layout.name}</p>
        <p className="text-small tabular-nums text-fg-secondary">
          {layout.cols} × {layout.rows} · {cams} camera{cams === 1 ? '' : 's'}
        </p>
        <p className={`text-caption ${current ? 'font-semibold text-brand-ink' : 'text-fg-subtle'}`}>
          {current ? `${pages} page${pages === 1 ? '' : 's'} · editing now` : `Updated ${ago(layout.updatedAt)}`}
        </p>
      </div>
    </div>
  );
}
