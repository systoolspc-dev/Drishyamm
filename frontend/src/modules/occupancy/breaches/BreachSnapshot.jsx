/**
 * Visual verification for one breach: the camera badge in the table (hover for
 * a quick look, click for the full view) and the detail dialog — the frame the
 * AI flagged with its detection box drawn around the person, the facts, the
 * actions, and the recorded video in Playback at that moment.
 *
 * The snapshot itself comes from useBreachSnapshot.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { HoverCard } from 'radix-ui';
import {
  Camera, Check, CheckCheck, Clapperboard, Download, ImageOff, Loader2, PlayCircle,
} from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/core/ui/dialog';
import { boxInImage, readBbox, readFrame } from './breach-model';
import { useBreachSnapshot as useSnapshot } from './useBreachSnapshot';

/**
 * The flagged frame with the detection box. A face crop IS the detection, so
 * it is framed whole rather than boxed; a full frame gets the box scaled from
 * the inference frame to the image.
 */
export function SnapshotFrame({ evt, snap, label, compact = false }) {
  const [img, setImg] = useState(null);
  const [broken, setBroken] = useState(false);
  const bbox = readBbox(evt);
  const box = !snap.cropped && img ? boxInImage(bbox, readFrame(evt), img) : null;
  const stroke = img ? Math.max(2, img.w / 320) : 2;
  const font = img ? Math.max(12, img.w / 40) : 12;

  if (snap.state === 'loading') {
    return <div className={`${compact ? 'h-32' : 'aspect-video'} w-full animate-pulse rounded-lg bg-surface-muted`} />;
  }
  if (snap.state === 'none' || broken) {
    return (
      <div className={`${compact ? 'h-32' : 'aspect-video'} flex w-full flex-col items-center justify-center gap-1.5 rounded-lg bg-surface-sunken text-fg-subtle`}>
        <ImageOff className="h-5 w-5" />
        <span className="text-micro">No snapshot stored for this breach</span>
      </div>
    );
  }
  return (
    <div className={`relative w-full overflow-hidden rounded-lg bg-black ${compact ? 'h-32' : ''}`}>
      <img
        alt={label}
        className={`block w-full ${compact ? 'h-32 object-cover' : 'max-h-[60vh] object-contain'}`}
        onError={() => setBroken(true)}
        onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        src={snap.src}
      />
      {img && (snap.cropped || box) && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio={compact ? 'xMidYMid slice' : 'xMidYMid meet'}
          viewBox={`0 0 ${img.w} ${img.h}`}
        >
          {(() => {
            const [x1, y1, x2, y2] = box || [stroke, stroke, img.w - stroke, img.h - stroke];
            const tagW = label.length * font * 0.6 + font;
            const ty = y1 - font * 1.5 > 0 ? y1 - font * 1.5 : y1;
            return (
              <g>
                <rect
                  fill="var(--danger)" fillOpacity={0.08} height={Math.max(1, y2 - y1)} rx={stroke * 2}
                  stroke="var(--danger)" strokeWidth={stroke} width={Math.max(1, x2 - x1)} x={x1} y={y1}
                />
                {!compact && (
                  <g>
                    <rect fill="var(--danger)" height={font * 1.5} rx={font * 0.25} width={tagW} x={x1} y={ty} />
                    <text fill="#fff" fontSize={font} fontWeight="700" x={x1 + font * 0.5} y={ty + font * 1.1}>{label}</text>
                  </g>
                )}
              </g>
            );
          })()}
        </svg>
      )}
      {!compact && img && !snap.cropped && !box && (
        <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-micro text-white">
          No detection box recorded for this frame
        </span>
      )}
    </div>
  );
}

/** "📷 Camera — Zone": hover previews the snapshot, click opens the detail. */
export function CameraBadge({ row, onOpen }) {
  const [hovered, setHovered] = useState(false);
  const snap = useSnapshot(row.raw, hovered);
  return (
    <HoverCard.Root closeDelay={80} onOpenChange={setHovered} openDelay={250}>
      <HoverCard.Trigger asChild>
        <button
          className="inline-flex max-w-[240px] items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2 py-1 text-left text-[11px] font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink focus:border-brand focus:outline-none"
          onClick={() => onOpen(row)}
          title={`Camera ID ${row.monitorId || 'unknown'} — view snapshot`}
          type="button"
        >
          <Camera className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="truncate">{row.cameraName}</span>
          <span className="shrink-0 text-fg-disabled">—</span>
          <span className="truncate font-medium text-fg-muted">{row.zoneName || 'No zone'}</span>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          align="start"
          className="z-50 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0"
          sideOffset={6}
        >
          <SnapshotFrame compact evt={row.raw} label={row.subject} snap={snap} />
          <p className="mt-1.5 truncate text-micro font-semibold text-fg">{row.subject}</p>
          <p className="text-micro text-fg-subtle">Click the badge for the full frame, clip and actions.</p>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

const STATUS_CHIP = {
  open: 'bg-danger-soft text-danger-ink ring-danger-line',
  acknowledged: 'bg-warning-soft text-warning-ink ring-warning-line',
  resolved: 'bg-success-soft text-success-ink ring-success-line',
};

/** The breach, full size, with its facts and the three actions. */
export function BreachDetailDialog({ row, busy, onClose, onAcknowledge, onResolve, onExportClip, fmtWhen }) {
  const snap = useSnapshot(row?.raw, Boolean(row));
  if (!row) return null;
  const playbackHref = row.monitorId
    ? `/playback?camera=${encodeURIComponent(row.monitorId)}&t=${encodeURIComponent(row.when.toISOString())}`
    : null;
  const facts = [
    ['When (IST)', fmtWhen(row.when)],
    ['Camera', `${row.cameraName}${row.monitorId ? ` (ID ${row.monitorId})` : ''}`],
    ['Zone', row.zoneName || '—'],
    ['Person', row.subject],
    ['Confidence', row.confidencePct != null ? `${row.confidencePct}%` : '—'],
    ['Severity', row.tone],
  ];

  return (
    <Dialog onOpenChange={(o) => { if (!o) onClose(); }} open>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-line bg-surface p-5 sm:max-w-3xl">
        <div className="pr-6">
          <DialogTitle className="flex items-center gap-2 text-heading font-bold text-fg">
            {row.nounWhen}
            <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[row.status]}`}>
              {row.status}
            </span>
          </DialogTitle>
          <DialogDescription className="text-small text-fg-muted">
            {row.subject} · {row.cameraName} — {row.zoneName || 'No zone'}
          </DialogDescription>
        </div>

        <SnapshotFrame evt={row.raw} label={row.subject} snap={snap} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {facts.map(([k, v]) => (
            <div className="min-w-0" key={k}>
              <dt className="text-micro font-bold uppercase tracking-wide text-fg-subtle">{k}</dt>
              <dd className="truncate text-small text-fg-secondary">{v}</dd>
            </div>
          ))}
        </dl>
        {row.resolution && (
          <p className="text-micro text-fg-subtle">
            Resolved by {row.resolution.by} · {fmtWhen(new Date(row.resolution.at))} (recorded in this browser)
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
          <BreachActions busy={busy} onAcknowledge={onAcknowledge} onExportClip={onExportClip} onResolve={onResolve} row={row} />
          {playbackHref && (
            <Link
              className="ml-auto inline-flex items-center gap-1.5 text-small font-semibold text-brand-ink underline-offset-2 hover:underline"
              to={playbackHref}
            >
              <PlayCircle className="h-4 w-4" /> Play video in Playback
            </Link>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const actionCls = 'inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-fg-secondary transition disabled:cursor-not-allowed disabled:opacity-50';

/** [Acknowledge] [Mark Resolved] [Export Clip] — shared by the row and the dialog. */
export function BreachActions({ row, busy, onAcknowledge, onResolve, onExportClip }) {
  const working = busy?.id === row.id ? busy.action : null;
  const spin = (a, Icon) => (working === a ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" strokeWidth={2.5} />);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {row.status === 'open' && (
        <button
          className={`${actionCls} hover:border-warning-line hover:bg-warning-soft hover:text-warning-ink`}
          disabled={Boolean(working)} onClick={() => onAcknowledge(row)} type="button"
        >
          {spin('ack', Check)} Acknowledge
        </button>
      )}
      {row.status !== 'resolved' ? (
        <button
          className={`${actionCls} hover:border-success-line hover:bg-success-soft hover:text-success-ink`}
          disabled={Boolean(working)} onClick={() => onResolve(row)} type="button"
        >
          {spin('resolve', CheckCheck)} Mark Resolved
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 px-1 text-[11px] font-semibold text-success-ink">
          <CheckCheck className="h-3.5 w-3.5" strokeWidth={2.5} /> Resolved
        </span>
      )}
      <button
        className={`${actionCls} hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink`}
        disabled={!row.monitorId || Boolean(working)}
        onClick={() => onExportClip(row)}
        title={row.monitorId ? 'Download the recording from 15 s before to 45 s after the breach (MP4)' : 'No camera recorded for this breach'}
        type="button"
      >
        {working === 'clip' ? <Clapperboard className="h-3 w-3 animate-pulse" /> : <Download className="h-3 w-3" strokeWidth={2.5} />} Export Clip
      </button>
    </div>
  );
}
