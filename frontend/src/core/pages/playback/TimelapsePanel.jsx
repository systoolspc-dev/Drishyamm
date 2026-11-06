import { useId, useState } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, FileVideo, Info, Loader2, Video,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard, PageTabStrip } from '@/core/layout/OperationsPage';
import { StatusDot } from '@/core/ui/status-badge';
import { getDownloadUrl } from '@/core/services/recordings';
import { cameraState, fmtClock, fmtDate, fmtDuration, timeValue } from './model';
import { formatBytes, viewerTimeZone } from './timelapse';

const TABS = [
  { id: 'info', label: 'Camera Info' },
  { id: 'export', label: 'Export' },
];
// The collapsed rail shows the tabs as icons only.
const RAIL_ICONS = { info: Info, export: Download };

// The same forced-download anchor the recordings pages use.
async function downloadRecording(groupId, rec) {
  const { downloadUrl, filename } = await getDownloadUrl(groupId, rec.key, rec.filename);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename || rec.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Right-hand panel of the Timelapse workspace: what the camera is, and how to
 * take the footage away. Deliberately compact — the video is the page.
 */
export default function TimelapsePanel({
  tab, onTab, onCollapse, camera, thumbnail, plan, clips, currentKey, intervalLabel, className,
}) {
  return (
    <PageCard className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div className="flex shrink-0 items-center border-b border-line pr-2">
        <PageTabStrip tabs={TABS} active={tab} onChange={onTab} className="min-w-0 flex-1 px-3 shadow-none" />
        {/* Collapsing only means something beside the video, i.e. on desktop. */}
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse panel"
            title="Collapse panel"
            className="hidden h-8 w-8 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg lg:grid"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'export'
          ? <ExportTab plan={plan} clips={clips} currentKey={currentKey} intervalLabel={intervalLabel} />
          : <InfoTab camera={camera} thumbnail={thumbnail} />}
      </div>
    </PageCard>
  );
}

/**
 * The panel folded away to the right: a slim rail that gives the video the
 * width back. Either tab icon opens the panel on that tab.
 */
export function TimelapsePanelRail({ onExpand, className }) {
  return (
    <PageCard className={cn('flex flex-col items-center gap-1 py-2', className)}>
      <button
        type="button"
        onClick={() => onExpand()}
        aria-label="Expand panel"
        title="Expand panel"
        className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span aria-hidden className="my-1 h-px w-5 bg-line" />
      {TABS.map((t) => {
        const Icon = RAIL_ICONS[t.id];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onExpand(t.id)}
            aria-label={`Open ${t.label}`}
            title={t.label}
            className="grid h-8 w-8 place-items-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </PageCard>
  );
}

// ── Camera Info ─────────────────────────────────────────────────────────────

function InfoTab({ camera, thumbnail }) {
  const state = cameraState(camera?.status);
  const rows = [
    ['Site', camera?.siteName || camera?.groupName],
    ['Location', camera?.location],
    ['Camera Type', camera?.cameraType],
    ['Resolution', camera?.resolution],
    ['Timezone', viewerTimeZone()],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Thumbnail src={thumbnail} />
        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-fg">{camera?.name || 'No camera selected'}</p>
          {camera ? (
            <p className="mt-0.5 flex items-center gap-1.5 text-caption font-medium text-fg-muted">
              <StatusDot tone={state.tone} title={state.label} />
              {state.label}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Section title="Camera details" defaultOpen>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-small">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-fg-muted">{label}</dt>
                <dd className="truncate text-right font-medium text-fg" title={value || undefined}>{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="About Timelapse" icon={Info} tinted>
          <p className="text-caption leading-relaxed text-fg-secondary">
            Timelapse compresses long-duration footage into a shorter video by playing frames at set intervals.
          </p>
        </Section>
      </div>
    </div>
  );
}

/** One collapsible block of the Camera Info tab. */
function Section({ title, icon: Icon, tinted, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn('rounded-lg border', tinted ? 'border-brand-line/60 bg-brand-soft/50' : 'border-line-subtle')}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-small font-semibold text-fg transition hover:bg-surface-sunken/60"
      >
        {Icon ? <Icon className="h-3.5 w-3.5 text-brand" /> : null}
        <span className="flex-1">{title}</span>
        <ChevronDown className={cn('h-4 w-4 text-fg-subtle transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {/* grid-rows 0fr → 1fr animates to the content's own height. */}
      <div
        id={id}
        className={cn('grid transition-[grid-template-rows] duration-200 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3 pt-0.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Thumbnail({ src }) {
  const [failed, setFailed] = useState(null);
  if (src && failed !== src) {
    return <img src={src} alt="" onError={() => setFailed(src)} className="h-12 w-20 shrink-0 rounded-md bg-surface-muted object-cover" />;
  }
  return (
    <span className="grid h-12 w-20 shrink-0 place-items-center rounded-md bg-surface-muted text-fg-subtle">
      <Video className="h-5 w-5" />
    </span>
  );
}

// ── Export ──────────────────────────────────────────────────────────────────

function ExportTab({ plan, clips, currentKey, intervalLabel }) {
  const [busy, setBusy] = useState(null);       // null | { done, total } | { key }
  const [error, setError] = useState(null);

  if (!plan) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Download className="h-6 w-6 text-fg-subtle" />
        <p className="text-small font-semibold text-fg">Nothing to export yet</p>
        <p className="max-w-60 text-caption text-fg-muted">Generate a timelapse, then download its footage from here.</p>
      </div>
    );
  }

  const totalBytes = clips.reduce((n, c) => n + (c.rec.size || 0), 0);
  const current = clips.find((c) => c.key === currentKey) || null;
  const rows = [
    ['Format', 'MP4 · original recordings'],
    ['Time range', `${fmtDate(plan.start)} · ${timeValue(plan.start)} → ${timeValue(plan.end)}`],
    ['Interval', intervalLabel],
    ['Timelapse length', fmtDuration((plan.end - plan.start) / plan.ratio)],
    ['Footage', clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}` : 'No recordings'],
  ];

  const run = async (list, mark) => {
    setError(null);
    try {
      for (let i = 0; i < list.length; i += 1) {
        setBusy(mark(i));
        await downloadRecording(plan.groupId, list[i].rec);
        // Browsers drop anchor clicks that land too close together.
        if (i < list.length - 1) await pause(600);
      }
    } catch {
      setError('Failed to generate a download link. Please try again.');
    } finally {
      setBusy(null);
    }
  };
  const downloadAll = () => run(clips, (i) => ({ done: i, total: clips.length }));
  const downloadOne = (clip) => run([clip], () => ({ key: clip.key }));

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-small">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="truncate text-right font-medium tabular-nums text-fg" title={value}>{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-caption leading-relaxed text-fg-muted">
        Downloads are the recorded clips that make up this timelapse, at normal speed. The sped-up view plays here in the browser.
      </p>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={downloadAll}
          disabled={!clips.length || Boolean(busy)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy?.total
            ? <><Loader2 className="h-4 w-4 animate-spin" /> Downloading {busy.done + 1} of {busy.total}…</>
            : <><Download className="h-4 w-4" /> Download {clips.length > 1 ? `all ${clips.length} clips` : 'footage'}</>}
        </button>
        <button
          type="button"
          onClick={() => current && downloadOne(current)}
          disabled={!current || Boolean(busy)}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileVideo className="h-4 w-4" />
          Download current clip{current ? ` (${fmtClock(current.start)})` : ''}
        </button>
        {clips.length > 3 ? (
          <p className="text-caption text-fg-subtle">Your browser may ask to allow multiple downloads.</p>
        ) : null}
        {error ? <p className="text-caption font-medium text-danger-ink">{error}</p> : null}
      </div>

      {clips.length ? (
        <div className="border-t border-line-subtle pt-3">
          <p className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-fg-muted">Clips in range</p>
          <ul className="max-h-48 overflow-y-auto">
            {clips.map((c) => (
              <li key={c.key} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-small', c.key === currentKey && 'bg-brand-soft')}>
                <span className={cn('tabular-nums', c.key === currentKey ? 'font-semibold text-brand-ink' : 'text-fg')}>{fmtClock(c.start)}</span>
                <span className="min-w-0 flex-1 truncate text-caption text-fg-muted">{formatBytes(c.rec.size)}</span>
                <button
                  type="button"
                  onClick={() => downloadOne(c)}
                  disabled={Boolean(busy)}
                  aria-label={`Download clip from ${fmtClock(c.start)}`}
                  title="Download clip"
                  className="grid h-7 w-7 place-items-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-40"
                >
                  {busy?.key === c.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
