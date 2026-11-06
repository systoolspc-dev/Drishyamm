import { useMemo, useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown, Search, Video } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { StatusDot } from '@/core/ui/status-badge';
import { cameraPlace, cameraState } from './model';

/** Camera chooser for Playback: thumbnail, name, place and status, searchable. */
export default function CameraPicker({ cameras, value, onChange, thumbs, loading, className }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = cameras.find((c) => c.monitorId === value) || null;
  const state = cameraState(current?.status);
  const place = cameraPlace(current);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cameras;
    return cameras.filter((c) => `${c.name} ${cameraPlace(c)}`.toLowerCase().includes(needle));
  }, [cameras, query]);

  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Choose camera"
          className={cn(
            'flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface pl-1.5 pr-2.5 text-left transition hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 sm:w-60',
            className,
          )}
        >
          <Thumb src={current ? thumbs[current.monitorId] : null} compact />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-small font-semibold leading-tight text-fg">
              {current?.name || (loading ? 'Loading cameras…' : 'No cameras')}
            </span>
            {current ? (
              <span className="flex min-w-0 items-center gap-1.5 text-caption leading-tight text-fg-muted">
                {place ? <span className="truncate">{place}</span> : null}
                {place ? <span className="text-fg-disabled">•</span> : null}
                <StatusDot tone={state.tone} title={state.label} />
                <span className="shrink-0">{state.label}</span>
              </span>
            ) : null}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[min(22rem,calc(var(--app-vw)-2rem))] rounded-xl border border-line bg-surface p-2 shadow-lg"
        >
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface-sunken px-2.5 focus-within:border-brand">
            <Search className="h-4 w-4 shrink-0 text-fg-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cameras…"
              className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>

          <ul role="listbox" aria-label="Cameras" className="mt-2 max-h-80 overflow-y-auto">
            {matches.map((c) => {
              const selected = c.monitorId === value;
              const s = cameraState(c.status);
              const where = cameraPlace(c);
              return (
                <li key={c.monitorId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => { onChange(c.monitorId); setOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition',
                      selected ? 'bg-brand-soft' : 'hover:bg-surface-sunken',
                    )}
                  >
                    <Thumb src={thumbs[c.monitorId]} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-small font-semibold', selected ? 'text-brand-ink' : 'text-fg')}>
                        {c.name}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-caption text-fg-muted">
                        <StatusDot tone={s.tone} title={s.label} />
                        <span className="truncate">{where ? `${s.label} · ${where}` : s.label}</span>
                      </span>
                    </span>
                    {selected ? <Check className="h-4 w-4 shrink-0 text-brand" /> : null}
                  </button>
                </li>
              );
            })}
            {matches.length === 0 ? (
              <li className="px-2 py-6 text-center text-small text-fg-muted">
                {cameras.length ? `No camera matches "${query}".` : 'No cameras yet.'}
              </li>
            ) : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Thumb({ src, compact }) {
  const size = compact ? 'h-7 w-10 rounded' : 'h-8 w-12 rounded-md';
  if (src) return <img src={src} alt="" className={cn(size, 'shrink-0 object-cover')} />;
  return (
    <span className={cn(size, 'grid shrink-0 place-items-center bg-surface-muted text-fg-subtle')}>
      <Video className="h-4 w-4" />
    </span>
  );
}
