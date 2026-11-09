import {
  useState, useEffect, useCallback, useRef, useMemo,
} from 'react';
import {
  Search, Download, Play, Video, ChevronLeft, ChevronRight,
  X, RefreshCw, Camera, AlertCircle, Loader2, WifiOff,
  Building2, ChevronDown, ImageOff, List, LayoutGrid, ChevronUp, MoreVertical,
} from 'lucide-react';
import { cameraGroupService } from '@/core/services/cameraGroup';
import { getThumbnailUrl, getStreamUrl } from '@/core/services/recordings';
import { useGroups } from '@/core/hooks/useQueries';
import { PageCard } from '@/core/layout/OperationsPage';
import { cn } from '@/core/lib/utils';
import api from '@/core/services/api';

// ─── Debounce hook ─────────────────────────────────────────────────────────────

function useDebounce(value, delayMs) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debouncedValue;
}

// ─── Presigned URL cache (sessionStorage, 5-min TTL) ──────────────────────────

const PRESIGNED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPresignedUrl(key) {
  try {
    const cached = sessionStorage.getItem(`presigned:${key}`);
    if (!cached) return null;
    const { url, expires } = JSON.parse(cached);
    if (Date.now() > expires) {
      sessionStorage.removeItem(`presigned:${key}`);
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function setCachedPresignedUrl(key, url) {
  try {
    sessionStorage.setItem(`presigned:${key}`, JSON.stringify({
      url,
      expires: Date.now() + PRESIGNED_CACHE_TTL,
    }));
  } catch {
    // Ignore — sessionStorage might be full or disabled
  }
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

const TODAY     = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const SEVEN_AGO = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  const gb = bytes / 1073741824;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1048576;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatCameraSlug(slug) {
  if (!slug) return 'Unknown Camera';
  return slug.replace(/---/g, ' - ').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Leading wall-clock start time from a clip filename. Handles the stitched
// clip "17-48-57_to_17-50-00_1m.mp4" and the raw segment "17-48-57-123456.mp4",
// plus the legacy date-prefixed form. The filename is already in device-local
// (IST) wall-clock, so we return it verbatim — no Date() parsing, no timezone
// conversion (that was the source of the mismatch: the old code fell through to
// the S3 upload time). Returns "HH:MM:SS" (24h) or null.
function parseHMSFromFilename(filename) {
  if (!filename) return null;
  const withDate = filename.match(/\d{4}-\d{2}-\d{2}[T_](\d{2})[-:](\d{2})[-:](\d{2})/);
  const m = withDate || filename.match(/^(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}:${m[2]}:${m[3]}`;
}

// "17:48:57" -> "5:48:57 PM"
function fmt12(hms) {
  const [h, mi, s] = String(hms).split(':').map(Number);
  if ([h, mi, s].some((n) => Number.isNaN(n))) return hms;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

// Size-based estimate — last resort only, for raw local segments whose name
// carries no end time. Cloud clips always have an exact span (see clipDurationSec).
function estimateDuration(sizeBytes) {
  if (!sizeBytes || sizeBytes < 100000) return null;
  const minutes = sizeBytes / (1024 * 1024 * 11.25);
  if (minutes < 0.25) return `~${Math.round(minutes * 60)}s`;
  if (minutes >= 9.5)  return '~10 min';
  return `~${Math.round(minutes)} min`;
}

// Exact clip length in seconds from the stitched filename
// "HH-MM-SS_to_HH-MM-SS_..", else the backend's durationSec if present.
function clipDurationSec(rec) {
  const m = (rec.filename || '').match(/(\d{2})-(\d{2})-(\d{2})_to_(\d{2})-(\d{2})-(\d{2})/);
  if (m) {
    const a = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    let b = (+m[4]) * 3600 + (+m[5]) * 60 + (+m[6]);
    if (b < a) b += 24 * 3600; // clip crossed midnight
    return b - a;
  }
  if (Number.isFinite(rec.durationSec) && rec.durationSec > 0) return rec.durationSec;
  return null;
}

function durationLabel(rec) {
  const sec = clipDurationSec(rec);
  if (sec == null) return estimateDuration(rec.size); // raw local segment fallback
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function getRecordingTime(filename, lastModified) {
  const fromFile = parseHMSFromFilename(filename);
  if (fromFile) return fmt12(fromFile);
  if (!lastModified) return '—';
  const d = new Date(lastModified);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDateLabel(dateStr) {
  if (!dateStr) return 'Unknown Date';
  if (dateStr === TODAY) return 'Today';
  if (dateStr === YESTERDAY) return 'Yesterday';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Clip Thumbnail (lazy-loaded JPEG from FFmpeg) ────────────────────────────

function ClipThumbnail({ groupId, recKey }) {
  const [state, setState] = useState('loading'); // loading → loaded → error
  const [imgSrc, setImgSrc] = useState(null);

  useEffect(() => {
    const url = getThumbnailUrl(groupId, recKey);
    const img = new Image();
    img.onload  = () => { setImgSrc(url); setState('loaded'); };
    img.onerror = () => setState('error');
    img.src = url;
  }, [groupId, recKey]);

  if (state === 'loading') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-neutral-900">
        <Loader2 className="w-5 h-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-neutral-900">
        <ImageOff className="w-6 h-6 text-fg-muted" />
        <span className="text-micro text-fg-muted font-medium">No preview</span>
      </div>
    );
  }

  return <img src={imgSrc} alt="Thumbnail" className="absolute inset-0 w-full h-full object-cover" />;
}

// ─── Recording metadata helpers ───────────────────────────────────────────────

// Only trigger values we recognise get a label — an unknown `type` (a MIME
// type, a storage class) must not surface as a made-up recording type.
const KIND_LABELS = {
  continuous: 'Continuous recording',
  motion:     'Motion recording',
  event:      'Event recording',
  manual:     'Manual recording',
  scheduled:  'Scheduled recording',
};

function recordingKind(rec) {
  const raw = rec.recordingType || rec.trigger || rec.type;
  if (typeof raw !== 'string') return null;
  return KIND_LABELS[raw.toLowerCase()] || null;
}

// The clip's real start time: parsed from the filename (device-local/IST
// wall-clock) first, then the backend's `time`, then the upload time as a last
// resort. Parsing the filename is what makes cloud clips show WHEN they were
// recorded instead of when they finished uploading.
function recordingTime(rec) {
  const fromFile = parseHMSFromFilename(rec.filename);
  if (fromFile) return fmt12(fromFile);
  if (rec.time && /^\d{2}:\d{2}(:\d{2})?$/.test(rec.time)) {
    return fmt12(rec.time.length === 5 ? `${rec.time}:00` : rec.time);
  }
  return getRecordingTime(rec.filename, rec.lastModified);
}

// Second meta line: recording type when the API reports one, otherwise the
// segment count (windows) or file size, so the line is never empty.
function recordingDetail(rec) {
  const kind = recordingKind(rec);
  if (kind) return kind;
  if (rec.isWindow && rec.windowClips?.length) {
    const n = rec.windowClips.length;
    return `${n} clip${n === 1 ? '' : 's'} · ${formatBytes(rec.size)}`;
  }
  return formatBytes(rec.size);
}

// ─── Row actions menu (⋮) ─────────────────────────────────────────────────────

function RecordingMenu({ rec, onPlay, onDownload }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const item = 'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-small font-medium text-fg-secondary transition hover:bg-surface-sunken hover:text-fg';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid h-9 w-9 place-items-center rounded-lg text-fg-subtle transition hover:bg-surface-sunken hover:text-fg"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button type="button" role="menuitem" className={item} onClick={(e) => { e.stopPropagation(); setOpen(false); onPlay(rec); }}>
            <Play className="h-3.5 w-3.5" /> Play
          </button>
          <button type="button" role="menuitem" className={item} onClick={(e) => { e.stopPropagation(); setOpen(false); onDownload(rec); }}>
            <Download className="h-3.5 w-3.5" /> Download
          </button>
        </div>
      )}
    </div>
  );
}

function PlayButton({ onClick, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:border-brand-line hover:bg-brand-soft hover:text-brand-ink',
        className,
      )}
    >
      <Play className="h-3.5 w-3.5 text-brand" fill="currentColor" />
      <span className="hidden sm:inline">Play</span>
    </button>
  );
}

function ThumbButton({ rec, groupId, onPlay, label, className }) {
  const duration = durationLabel(rec);
  return (
    <button
      type="button"
      onClick={() => onPlay(rec)}
      aria-label={`Play ${label}`}
      className={cn('group/thumb relative block aspect-video shrink-0 overflow-hidden rounded-md bg-neutral-900', className)}
    >
      <ClipThumbnail groupId={groupId} recKey={rec.key} />
      <span className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover/thumb:opacity-100">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand shadow">
          <Play className="ml-0.5 h-3.5 w-3.5 text-white" fill="white" />
        </span>
      </span>
      {duration && (
        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-micro font-semibold text-white">
          {duration}
        </span>
      )}
    </button>
  );
}

// ─── List row ─────────────────────────────────────────────────────────────────

function RecordingRow({ rec, groupId, onPlay, onDownload }) {
  const cameraLabel = formatCameraSlug(rec.cameraName || '');
  const duration = durationLabel(rec);

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-sunken sm:gap-4">
      <ThumbButton rec={rec} groupId={groupId} onPlay={onPlay} label={cameraLabel} className="w-28 sm:w-36" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-semibold text-fg">{cameraLabel}</p>
        <p className="mt-0.5 truncate text-small tabular-nums text-fg-muted">
          {formatDateLabel(rec.date)} · {recordingTime(rec)}
          {duration ? <span className="text-fg-subtle"> · {duration}</span> : null}
        </p>
        <p className="mt-0.5 truncate text-caption text-fg-subtle">{recordingDetail(rec)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <PlayButton onClick={() => onPlay(rec)} />
        <RecordingMenu rec={rec} onPlay={onPlay} onDownload={onDownload} />
      </div>
    </li>
  );
}

// ─── Grid card ────────────────────────────────────────────────────────────────

function RecordingGridCard({ rec, groupId, onPlay, onDownload, showCamera = true }) {
  const cameraLabel = formatCameraSlug(rec.cameraName || '');

  return (
    <article className="rounded-lg border border-line bg-surface transition hover:border-brand-line">
      <ThumbButton rec={rec} groupId={groupId} onPlay={onPlay} label={cameraLabel} className="w-full rounded-b-none" />
      <div className="flex items-start gap-1 p-2.5 pr-1.5">
        <div className="min-w-0 flex-1">
          {showCamera && <p className="truncate text-small font-semibold text-fg">{cameraLabel}</p>}
          <p className={cn('truncate text-caption tabular-nums', showCamera ? 'mt-0.5 text-fg-muted' : 'text-small font-semibold text-fg')}>
            {formatDateLabel(rec.date)} · {recordingTime(rec)}
          </p>
          <p className="mt-0.5 truncate text-caption text-fg-subtle">{recordingDetail(rec)}</p>
        </div>
        <RecordingMenu rec={rec} onPlay={onPlay} onDownload={onDownload} />
      </div>
    </article>
  );
}

// ─── Camera Group Section (for Camera View) ───────────────────────────────────

function CameraSection({ cameraName, recordings, groupId, onPlay, onDownload }) {
  const [expanded, setExpanded] = useState(true);
  const cameraLabel = formatCameraSlug(cameraName);
  const todayCount = recordings.filter(r => r.date === TODAY).length;

  return (
    <section className="overflow-visible rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex h-11 w-full items-center justify-between gap-3 rounded-lg px-3 text-left transition-colors hover:bg-surface-sunken"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Camera className="h-4 w-4 shrink-0 text-brand" />
          <span className="truncate text-small font-semibold text-fg">{cameraLabel}</span>
          <span className="shrink-0 text-caption text-fg-subtle">
            {recordings.length} recording{recordings.length !== 1 ? 's' : ''}
            {todayCount > 0 && ` · ${todayCount} today`}
          </span>
        </span>
        {expanded
          ? <ChevronUp className="h-4 w-4 shrink-0 text-fg-subtle" />
          : <ChevronDown className="h-4 w-4 shrink-0 text-fg-subtle" />}
      </button>

      {expanded && (
        <div className="grid grid-cols-2 gap-2 border-t border-line-subtle p-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
          {recordings.map((rec) => (
            <RecordingGridCard
              key={rec.key}
              rec={rec}
              groupId={groupId}
              onPlay={onPlay}
              onDownload={onDownload}
              showCamera={false}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Player modal ──────────────────────────────────────────────────────────────

function PlayerModal({ recording, groupId, onClose }) {
  const videoRef    = useRef(null);
  const [dlLoading, setDlLoading]     = useState(false);
  const [dlError, setDlError]         = useState(null);
  const [videoLoading, setVideoLoading] = useState(true);

  const [attempt, setAttempt]   = useState(0);
  const [videoSrc, setVideoSrc] = useState(null);
  const [winIdx, setWinIdx]     = useState(0); // segment index when playing a 3-min window

  // Reset to the first segment whenever a different window/clip is opened.
  useEffect(() => { setWinIdx(0); }, [recording.key]);
  const videoError = attempt >= 2;

  const time        = recordingTime(recording);
  const dateLabel   = formatDateLabel(recording.date);
  const cameraLabel = formatCameraSlug(recording.cameraName || '');

  useEffect(() => {
    let cancelled = false;

    // 3-minute window — play its segments back-to-back (winIdx advances on 'ended').
    if (recording.isWindow && Array.isArray(recording.windowClips) && recording.windowClips.length) {
      const clip = recording.windowClips[Math.min(winIdx, recording.windowClips.length - 1)];
      setVideoSrc(getStreamUrl(groupId, clip.key));
      return () => { cancelled = true; };
    }

    const cachedUrl = getCachedPresignedUrl(recording.key);
    if (cachedUrl) {
      setVideoSrc(cachedUrl);
      return;
    }

    api.get(`/groups/${groupId}/recordings/play`, { params: { key: recording.key } })
      .then(({ data }) => {
        if (cancelled) return;
        if (data.playbackUrl) {
          setCachedPresignedUrl(recording.key, data.playbackUrl);
          setVideoSrc(data.playbackUrl);
        } else {
          setVideoSrc(getStreamUrl(groupId, recording.key));
          setAttempt(1);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setVideoSrc(getStreamUrl(groupId, recording.key));
        setAttempt(1);
      });
    return () => { cancelled = true; };
  }, [groupId, recording.key, recording.isWindow, winIdx]);

  const handleVideoError = useCallback(() => {
    if (attempt === 0) {
      setVideoLoading(true);
      setVideoSrc(getStreamUrl(groupId, recording.key));
      setAttempt(1);
    } else {
      setAttempt(2);
      setVideoLoading(false);
    }
  }, [attempt, groupId, recording.key]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (videoRef.current && videoSrc) {
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [videoSrc]);

  const handleDownload = async () => {
    setDlLoading(true);
    setDlError(null);
    try {
      let href;
      const name = recording.filename || 'recording.mp4';
      if (String(recording.key).startsWith('cam_')) {
        // Local recording — download straight through the stream proxy (full
        // backend URL + auth token), which sets Content-Disposition: attachment.
        href = `${getStreamUrl(groupId, recording.key)}&download=1`;
      } else {
        const { data } = await api.get(`/groups/${groupId}/recordings/download`, {
          params: { key: recording.key, name },
        });
        if (!data.downloadUrl) throw new Error('No download URL');
        href = data.downloadUrl;
      }
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setDlError('Download failed. Please try again.');
    } finally {
      setDlLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-5xl max-h-[calc(var(--app-vh)*0.9)] overflow-y-auto">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 bg-black/60 hover:bg-black/80 text-white rounded-full transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Video player */}
        <div className="relative bg-black aspect-video">
          {videoLoading && !videoError && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            </div>
          )}

          {videoError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white p-6 text-center">
              <AlertCircle className="w-12 h-12 text-danger" />
              <h3 className="text-section font-semibold">Unable to play this recording</h3>
              <p className="text-body text-fg-disabled max-w-md">
                Both stream sources failed. Try downloading instead.
              </p>
            </div>
          ) : (
            videoSrc && (
              <video
                ref={videoRef}
                controls
                autoPlay
                className="w-full h-full"
                onLoadStart={() => setVideoLoading(true)}
                onCanPlay={() => setVideoLoading(false)}
                onError={handleVideoError}
                onEnded={() => {
                  if (recording.isWindow && Array.isArray(recording.windowClips) &&
                      winIdx < recording.windowClips.length - 1) {
                    setWinIdx((i) => i + 1);
                  }
                }}
              >
                <source src={videoSrc} type="video/mp4" />
              </video>
            )
          )}
        </div>

        {/* Info panel */}
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-xl font-bold text-fg">{cameraLabel}</h2>
            <p className="text-body text-fg-muted mt-1">{dateLabel} at {time}</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-small">
            {[
              { label: 'Duration', value: estimateDuration(recording.size) || '—' },
              { label: 'Size', value: formatBytes(recording.size) },
              { label: 'Date', value: dateLabel },
              { label: 'Time', value: time },
            ].map(({ label, value }) => (
              <div key={label} className="bg-surface-sunken rounded-lg px-3 py-2">
                <span className="text-fg-muted block mb-1">{label}</span>
                <span className="text-small sm:text-body font-semibold text-fg truncate">{value}</span>
              </div>
            ))}
          </div>

          {dlError && (
            <p className="text-small text-danger mb-2 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {dlError}
            </p>
          )}

          <button
            onClick={handleDownload}
            disabled={dlLoading}
            className="w-full flex items-center justify-center gap-2 bg-brand hover:bg-brand-hover active:bg-brand-hover disabled:opacity-60 text-white px-4 py-3 rounded-xl font-semibold text-body transition-colors shadow-sm"
          >
            {dlLoading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing…</>
              : <><Download className="w-4 h-4" /> Download Recording</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Pagination ────────────────────────────────────────────────────────────────

function Pagination({ page, totalPages, perPage, total, onPage, onPerPage }) {
  const pageList = useMemo(() => {
    const delta = 1;
    const list = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - delta && i <= page + delta)) list.push(i);
      else if (list[list.length - 1] !== '…') list.push('…');
    }
    return list;
  }, [page, totalPages]);

  const start = (page - 1) * perPage + 1;
  const end   = Math.min(page * perPage, total);

  return (
    <div className="flex shrink-0 flex-col items-center justify-between gap-2 border-t border-line-subtle px-4 py-2.5 sm:flex-row">
      <div className="flex items-center gap-2">
        <label className="text-micro text-fg-subtle font-medium">Show</label>
        <select
          value={perPage}
          onChange={(e) => onPerPage(Number(e.target.value))}
          className="border border-line rounded-lg px-2 py-1 text-small text-fg-secondary bg-surface focus:outline-none focus:ring-2 focus:ring-brand-line cursor-pointer"
        >
          {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="text-micro text-fg-subtle">
          {start}–{end} of <span className="font-semibold text-fg-secondary">{total}</span>
        </span>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPage(page - 1)}
            disabled={page === 1}
            className="p-1.5 hover:bg-surface-muted disabled:opacity-25 rounded-lg transition-colors"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4 text-fg-secondary" />
          </button>
          {pageList.map((p, i) =>
            p === '…' ? (
              <span key={`e-${i}`} className="w-8 h-8 flex items-center justify-center text-fg-subtle text-small select-none">…</span>
            ) : (
              <button
                key={p}
                onClick={() => onPage(p)}
                aria-current={p === page ? 'page' : undefined}
                className={`w-8 h-8 rounded-lg text-small font-medium transition-all ${
                  p === page ? 'bg-brand-soft font-semibold text-brand-ink ring-1 ring-brand/40' : 'text-fg-secondary hover:bg-surface-muted'
                }`}
              >
                {p}
              </button>
            )
          )}
          <button
            onClick={() => onPage(page + 1)}
            disabled={page === totalPages}
            className="p-1.5 hover:bg-surface-muted disabled:opacity-25 rounded-lg transition-colors"
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4 text-fg-secondary" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Quick date chip constants ─────────────────────────────────────────────────

const QUICK_CHIPS = [
  { key: 'today',     label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7days',     label: 'Last 7 days' },
  { key: 'all',       label: 'All time' },
];

// The 'timeline' id is kept for the date-grouped list; it is labelled List so it
// is not confused with Playback's own Timeline tab.
const VIEW_MODES = [
  { id: 'timeline', label: 'List',      Icon: List },
  { id: 'camera',   label: 'By camera', Icon: Camera },
  { id: 'grid',     label: 'Grid',      Icon: LayoutGrid },
];

// A date the chips don't name (opened from Cloud Playback on another day) is
// shown as its own pressed chip.
function quickDateFor(date) {
  if (!date || date === TODAY) return 'today';
  if (date === YESTERDAY) return 'yesterday';
  return 'day';
}

// ─── Main Gallery Page ─────────────────────────────────────────────────────────

/**
 * The recording library. Standalone it plays a clip in its own modal; with
 * `onPlay` (Cloud Playback's drawer) a clip is handed to the caller instead.
 * `initialGroupId`, `initialCamera` and `initialDate` seed the filters.
 */
export default function Gallery({ onPlay, initialGroupId, initialCamera = 'all', initialDate } = {}) {
  const abortRef = useRef(null);

  const { data: groupsData, isLoading: loadingGroups, error: groupsError } = useGroups();
  const groups = groupsData || [];

  const [selectedGroupId, setGroupId] = useState(initialGroupId || null);
  const [recordings, setRecordings]   = useState([]);
  const [loadingRecs, setLdRec]       = useState(false);
  const [recError, setRecError]       = useState(null);
  const [selectedRec, setSelectedRec] = useState(null);
  const playRec = onPlay || setSelectedRec;
  const [totalRecordings, setTotal]   = useState(0);
  const [totalPages, setTotalPages]   = useState(1);

  // View mode: 'timeline' (shown as List), 'camera', or 'grid'
  const [viewMode, setViewMode] = useState('timeline');
  const [sortOrder, setSortOrder] = useState('newest');

  // Filters
  const [quickDate, setQuickDate]     = useState(() => quickDateFor(initialDate));
  const [dateFrom, setDateFrom]       = useState(initialDate || TODAY);
  const [dateTo, setDateTo]           = useState(initialDate || TODAY);
  const [cameraFilter, setCamFilter]  = useState(initialCamera || 'all');
  const [searchQuery, setSearch]      = useState('');

  const debouncedSearch = useDebounce(searchQuery, 300);

  const [page, setPage]       = useState(1);
  const [perPage, setPerPage] = useState(50);

  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const online  = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, []);

  useEffect(() => {
    if (groups.length > 0 && !selectedGroupId) setGroupId(groups[0].id);
  }, [groups, selectedGroupId]);

  const loadRecordings = useCallback(() => {
    if (!selectedGroupId) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLdRec(true);
    setRecError(null);

    const params = {
      page,
      limit: perPage,
      // No window grouping: every clip gets its own card (stitched clips are
      // already 1–3 min each, not a flood of seconds-long segments).
    };

    if (dateFrom && dateTo && dateFrom === dateTo) {
      params.date = dateFrom;
    }

    if (cameraFilter !== 'all') {
      params.camera = cameraFilter;
    }

    cameraGroupService.getGroupRecordings(selectedGroupId, params)
      .then((response) => {
        if (ctrl.signal.aborted) return;
        const { data: recs, pagination } = response;

        // Each recording is rendered as its own card (one clip = one card).
        let filtered = recs || [];

        if (dateFrom && dateTo && dateFrom !== dateTo) {
          filtered = filtered.filter((r) => {
            const d = r.date || '';
            return d >= dateFrom && d <= dateTo;
          });
        }

        if (debouncedSearch) {
          const q = debouncedSearch.toLowerCase();
          filtered = filtered.filter((r) =>
            (r.cameraName || '').toLowerCase().includes(q) ||
            (r.filename || '').toLowerCase().includes(q)
          );
        }

        setRecordings(filtered);
        setTotal(pagination?.total || filtered.length);
        setTotalPages(pagination?.totalPages || 1);
        setRecError(null);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setRecError(err.response?.data?.message || 'Failed to load recordings.');
        setRecordings([]);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLdRec(false);
      });
  }, [selectedGroupId, page, perPage, dateFrom, dateTo, cameraFilter, debouncedSearch]);

  useEffect(() => {
    loadRecordings();
  }, [loadRecordings]);

  const handleDownload = async (rec) => {
    try {
      const { data } = await api.get(`/groups/${selectedGroupId}/recordings/download`, {
        params: { key: rec.key, name: rec.filename },
      });
      if (data.downloadUrl) {
        const a = document.createElement('a');
        a.href = data.downloadUrl;
        a.download = rec.filename || 'recording.mp4';
        a.click();
      }
    } catch {
      alert('Download failed. Please try again.');
    }
  };

  function applyQuick(q) {
    setQuickDate(q);
    setPage(1);
    if (q === 'today')     { setDateFrom(TODAY);     setDateTo(TODAY); }
    else if (q === 'yesterday') { setDateFrom(YESTERDAY); setDateTo(YESTERDAY); }
    else if (q === '7days')     { setDateFrom(SEVEN_AGO); setDateTo(TODAY); }
    else if (q === 'all')       { setDateFrom('');    setDateTo(''); }
  }

  function switchGroup(id) {
    setGroupId(id);
    setCamFilter('all');
    setSearch('');
    setQuickDate('today');
    setDateFrom(TODAY);
    setDateTo(TODAY);
    setPage(1);
  }

  function clearFilters() {
    setCamFilter('all');
    setSearch('');
    setQuickDate('today');
    setDateFrom(TODAY);
    setDateTo(TODAY);
    setPage(1);
  }

  // The selected camera stays in the list even when this day has no clips from it.
  const cameras = useMemo(() => {
    const names = new Set(recordings.map((r) => r.cameraName).filter(Boolean));
    if (cameraFilter !== 'all') names.add(cameraFilter);
    return [...names].sort();
  }, [recordings, cameraFilter]);

  // Sorting is client-side over the loaded page, like the date grouping below.
  const sorted = useMemo(() => {
    const newest = (a, b) => {
      const dc = (b.date || '').localeCompare(a.date || '');
      return dc !== 0 ? dc : (b.filename || '').localeCompare(a.filename || '');
    };
    const list = [...recordings];
    if (sortOrder === 'oldest') return list.sort((a, b) => newest(b, a));
    if (sortOrder === 'camera') {
      return list.sort((a, b) => (a.cameraName || '').localeCompare(b.cameraName || '') || newest(a, b));
    }
    return list.sort(newest);
  }, [recordings, sortOrder]);

  // List view: group by date (only while sorted by time — a camera sort
  // would scatter the same date across many headers)
  const timelineGroups = useMemo(() => {
    if (sortOrder === 'camera') return [{ date: null, recordings: sorted }];
    const groups = {};
    sorted.forEach((rec) => {
      const d = rec.date || 'Unknown';
      if (!groups[d]) groups[d] = [];
      groups[d].push(rec);
    });
    return Object.entries(groups).map(([date, recs]) => ({ date, recordings: recs }));
  }, [sorted, sortOrder]);

  // Camera view: group by camera
  const cameraGroups = useMemo(() => {
    const groups = {};
    sorted.forEach((rec) => {
      const cam = rec.cameraName || 'Unknown';
      if (!groups[cam]) groups[cam] = [];
      groups[cam].push(rec);
    });
    return Object.entries(groups).map(([camera, recs]) => ({ camera, recordings: recs }));
  }, [sorted]);

  // "Filtered" means different from the defaults clearFilters() restores —
  // otherwise Clear would be a no-op on the default Today view.
  const hasFilters = quickDate !== 'today' || cameraFilter !== 'all' || !!searchQuery;
  const nothingNarrowed = quickDate === 'all' && cameraFilter === 'all' && !searchQuery;
  const busy = loadingRecs || loadingGroups;
  const isEmpty = !busy && sorted.length === 0;
  // The server total ignores the client-side search, so while searching the
  // loaded matches are the honest count.
  const shownTotal = isEmpty ? 0 : (debouncedSearch ? sorted.length : totalRecordings);
  const rangeLabel = quickDate === 'day'
    ? formatDateLabel(dateFrom)
    : QUICK_CHIPS.find((c) => c.key === quickDate)?.label;

  let summary;
  if (busy) summary = 'Loading recordings…';
  else if (recError) summary = 'Recordings could not be loaded.';
  else if (groups.length === 0) summary = 'No office groups are set up yet.';
  else if (isEmpty) summary = nothingNarrowed ? 'No recordings in this office yet.' : 'No recordings match your current filters.';
  else summary = [rangeLabel, `${cameras.length} camera${cameras.length !== 1 ? 's' : ''}`, totalPages > 1 && `page ${page} of ${totalPages}`].filter(Boolean).join(' · ');

  const control = 'flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition hover:border-line-strong focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15';
  const selectInput = 'h-full min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-5 text-small font-medium text-fg outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const divider = <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-full min-h-0 w-full flex-col gap-3">

        {/* Offline banner */}
        {!isOnline && (
          <div className="flex items-center gap-2.5 rounded-lg border border-danger-line bg-danger-soft px-4 py-2.5">
            <WifiOff className="h-4 w-4 shrink-0 text-danger" />
            <span className="text-small font-medium text-danger-ink">You are offline — some features may not work.</span>
          </div>
        )}

        {/* Group/API error */}
        {groupsError && (
          <div className="flex items-center gap-3 rounded-lg border border-danger-line bg-danger-soft px-4 py-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
            <span className="flex-1 text-small text-danger-ink">Failed to load camera groups.</span>
            <button onClick={() => window.location.reload()} className="text-small text-danger-ink underline">Refresh</button>
          </div>
        )}

        {/* ── Toolbar: office | date range | camera, search, clear ── */}
        <div role="toolbar" aria-label="Recording filters" className="flex shrink-0 flex-wrap items-center gap-2">

          {/* Office selector */}
          {loadingGroups ? (
            <div className="h-11 w-56 animate-pulse rounded-lg bg-surface-muted" />
          ) : (
            <label className={cn(control, 'relative w-full sm:w-auto sm:min-w-56')}>
              <Building2 className="h-4 w-4 shrink-0 text-fg-muted" />
              <select
                value={selectedGroupId || ''}
                onChange={(e) => switchGroup(e.target.value)}
                disabled={groups.length === 0}
                aria-label="Office"
                className={selectInput}
              >
                {groups.length === 0
                  ? <option value="">No office groups</option>
                  : groups.map((g) => {
                      const n = g.cameras?.length || 0;
                      return (
                        <option key={g.id} value={g.id}>
                          {g.name}{n ? ` (${n} camera${n !== 1 ? 's' : ''})` : ''}
                        </option>
                      );
                    })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-subtle" />
            </label>
          )}

          {divider}

          {/* Quick date presets */}
          <div role="group" aria-label="Date range" className="inline-flex h-11 max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-line bg-surface-sunken p-1">
            {quickDate === 'day' && (
              <button
                type="button"
                aria-pressed
                className="h-full whitespace-nowrap rounded-md border border-brand/50 bg-brand-soft px-3 text-small font-semibold text-brand-ink"
              >
                {formatDateLabel(dateFrom)}
              </button>
            )}
            {QUICK_CHIPS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                aria-pressed={quickDate === key}
                onClick={() => applyQuick(key)}
                className={cn(
                  'h-full whitespace-nowrap rounded-md border px-3 text-small transition',
                  quickDate === key
                    ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
                    : 'border-transparent font-medium text-fg-muted hover:bg-surface/70 hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {divider}

          {/* Camera filter — the By camera view already splits by camera */}
          {viewMode !== 'camera' && (
            <label className={cn(control, 'relative min-w-44 flex-1 sm:flex-none')}>
              <Camera className="h-4 w-4 shrink-0 text-fg-muted" />
              <select
                value={cameraFilter}
                onChange={(e) => { setCamFilter(e.target.value); setPage(1); }}
                disabled={cameras.length === 0}
                aria-label="Camera"
                className={selectInput}
              >
                <option value="all">All Cameras</option>
                {cameras.map((c) => <option key={c} value={c}>{formatCameraSlug(c)}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-subtle" />
            </label>
          )}

          {/* Search */}
          <label className={cn(control, 'min-w-48 flex-1 sm:max-w-sm')}>
            <Search className="h-4 w-4 shrink-0 text-fg-muted" />
            <input
              type="text"
              placeholder="Search recordings..."
              value={searchQuery}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              aria-label="Search recordings"
              className="h-full min-w-0 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-fg-subtle"
            />
            {searchQuery && (
              <button type="button" onClick={() => { setSearch(''); setPage(1); }} aria-label="Clear search" className="text-fg-subtle transition hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>

          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasFilters}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-small font-medium text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </div>

        {/* Recording load error */}
        {recError && (
          <div className="flex items-center gap-3 rounded-lg border border-danger-line bg-danger-soft px-4 py-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
            <span className="flex-1 text-small text-danger-ink">{recError}</span>
            <button onClick={loadRecordings} className="shrink-0 text-small text-danger-ink underline">Retry</button>
          </div>
        )}

        {/* ── Results workspace ── */}
        <PageCard className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-subtle px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-heading font-semibold text-fg">
                Recordings <span className="font-medium tabular-nums text-fg-muted">({shownTotal})</span>
              </h2>
              <p className="mt-0.5 truncate text-small text-fg-muted">{summary}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="relative flex h-9 items-center gap-2 rounded-lg border border-line bg-surface pl-2.5 pr-7 text-small transition hover:border-line-strong focus-within:border-brand">
                <span className="text-fg-muted">Sort by</span>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  aria-label="Sort recordings"
                  className="h-full cursor-pointer appearance-none bg-transparent font-medium text-fg outline-none"
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="camera">Camera A–Z</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-subtle" />
              </label>

              <div role="group" aria-label="View" className="inline-flex h-9 items-center gap-0.5 rounded-lg border border-line bg-surface-sunken p-0.5">
                {VIEW_MODES.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setViewMode(id)}
                    aria-pressed={viewMode === id}
                    title={label}
                    className={cn(
                      'inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-small transition',
                      viewMode === id
                        ? 'bg-surface font-semibold text-fg shadow-sm'
                        : 'font-medium text-fg-muted hover:text-fg',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5', viewMode === id && 'text-brand')} />
                    <span className="hidden md:inline">{label}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={loadRecordings}
                disabled={busy}
                aria-label="Refresh recordings"
                title="Refresh"
                className="grid h-9 w-9 place-items-center rounded-lg border border-line text-fg-muted transition hover:border-line-strong hover:text-fg disabled:opacity-50"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loadingRecs && 'animate-spin')} />
              </button>
            </div>
          </div>

          {busy ? (
            <div className="flex min-h-[280px] flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-brand" />
            </div>

          ) : isEmpty ? (
            <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center px-4 py-10 text-center">
              <span className="mb-3 grid h-12 w-12 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
                <Video className="h-5 w-5" />
              </span>
              <h3 className="text-body font-semibold text-fg">
                {nothingNarrowed ? 'No recordings yet' : 'No recordings found'}
              </h3>
              <p className="mt-1 max-w-xs text-small text-fg-muted">
                {nothingNarrowed
                  ? 'Recordings will appear here once your cameras start saving to storage.'
                  : 'Try a different date range, camera or search term.'}
              </p>
              {!nothingNarrowed && (
                <button
                  type="button"
                  onClick={hasFilters ? clearFilters : () => applyQuick('all')}
                  className="mt-4 inline-flex h-9 items-center rounded-lg border border-line px-4 text-small font-semibold text-fg-secondary transition hover:border-brand-line hover:bg-brand-soft hover:text-brand-ink"
                >
                  {hasFilters ? 'Clear all filters' : 'Show all time'}
                </button>
              )}
            </div>

          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {viewMode === 'timeline' ? (
                  timelineGroups.map(({ date, recordings: recs }) => (
                    <section key={date || 'all'}>
                      {date && (
                        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line-subtle bg-surface-sunken/95 px-4 py-1.5 backdrop-blur">
                          <h3 className="text-caption font-semibold uppercase tracking-wider text-fg-muted">{formatDateLabel(date)}</h3>
                          <span className="ml-auto text-caption text-fg-subtle">{recs.length} recording{recs.length !== 1 ? 's' : ''}</span>
                        </div>
                      )}
                      <ul className="divide-y divide-line-subtle px-1">
                        {recs.map((rec) => (
                          <RecordingRow
                            key={rec.key}
                            rec={rec}
                            groupId={selectedGroupId}
                            onPlay={playRec}
                            onDownload={handleDownload}
                          />
                        ))}
                      </ul>
                    </section>
                  ))
                ) : viewMode === 'camera' ? (
                  <div className="space-y-2 p-3">
                    {cameraGroups.map(({ camera, recordings: recs }) => (
                      <CameraSection
                        key={camera}
                        cameraName={camera}
                        recordings={recs}
                        groupId={selectedGroupId}
                        onPlay={playRec}
                        onDownload={handleDownload}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
                    {sorted.map((rec) => (
                      <RecordingGridCard
                        key={rec.key}
                        rec={rec}
                        groupId={selectedGroupId}
                        onPlay={playRec}
                        onDownload={handleDownload}
                      />
                    ))}
                  </div>
                )}
              </div>

              {totalPages > 1 && (
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  perPage={perPage}
                  total={totalRecordings}
                  onPage={setPage}
                  onPerPage={(n) => { setPerPage(n); setPage(1); }}
                />
              )}
            </>
          )}
        </PageCard>
      </div>

      {/* Player modal */}
      {selectedRec && (
        <PlayerModal
          recording={selectedRec}
          groupId={selectedGroupId}
          onClose={() => setSelectedRec(null)}
        />
      )}
    </div>
  );
}
