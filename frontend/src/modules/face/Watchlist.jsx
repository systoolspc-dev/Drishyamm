import { useRef, useState, useEffect, useCallback } from 'react';
import {
  Users, UsersRound, Upload, Trash2, CheckCircle2, AlertCircle, UserRoundPlus,
  X, Archive, Database, Download, Clock, FileArchive, RefreshCw, Search,
  GraduationCap, Briefcase, Shield, UserCheck, Info, Zap,
} from 'lucide-react';
import { Card } from '@/core/ui/card';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { Badge } from '@/core/ui/badge';
import { Progress } from '@/core/ui/progress';
import { Separator } from '@/core/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/core/ui/dialog';
import { OperationsPage, PageHeader, PageContent, PageTabs } from '@/core/layout/OperationsPage';
import { aiService } from '@/core/services/ai';
import api from '@/core/services/api';

/* ─── helpers ─────────────────────────────────────────────────────────────── */
// Largest training archive we accept, end to end.
//
// A single request can never exceed the CDN's 100 MB body limit — it is rejected
// at the edge, before reaching our servers, so no server-side setting can lift
// it. Anything bigger is therefore sliced and sent as parts, which the API
// reassembles. That is why this ceiling is the API's own limit rather than the
// CDN's: chunking makes the edge limit a per-part concern, not a per-file one.
const MAX_ZIP_MB    = 500;
const MAX_ZIP_BYTES = MAX_ZIP_MB * 1024 * 1024;

// Above this we switch to the chunked path. Kept well under the 100 MB edge
// limit so a single request always has headroom for multipart overhead.
const SINGLE_SHOT_MAX_BYTES = 80 * 1024 * 1024;
const CHUNK_BYTES           = 20 * 1024 * 1024;

// Single face photo. Kept in step with the API's own limit (FACE_IMAGE_MAX_MB).
// The old 5 MB ceiling rejected ordinary phone photos, which are routinely
// 8-12 MB — and because the check runs in the browser, the upload never even
// left the machine, so nothing in the server logs explained the failure.
// Recognition does not need the pixels; the crop is downscaled to the
// detector's input size regardless.
const MAX_IMAGE_MB    = 20;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;

const ROSTER_KEY  = 'ai-watchlist-roster';
const loadRoster  = () => { try { return JSON.parse(localStorage.getItem(ROSTER_KEY) || '[]'); } catch { return []; } };
const saveRoster  = r => localStorage.setItem(ROSTER_KEY, JSON.stringify(r));
const fmtSize     = b => b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
const fmtDate     = d => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = d => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const PERSON_TYPES = [
  { value: 'student',  label: 'Students',  icon: GraduationCap },
  { value: 'staff',    label: 'Staff',     icon: Briefcase     },
  { value: 'security', label: 'Security',  icon: Shield        },
  { value: 'visitor',  label: 'Visitors',  icon: UserCheck     },
];

// The two ways a face gets onto the list. Rendered as the shared segmented
// control in the page header rather than a tab strip on its own row — that row
// was costing 56px of the height the form needs to stay above the fold.
const MODES = [
  { id: 'individual', label: 'Individual Upload', Icon: Upload   },
  { id: 'bulk',       label: 'Bulk Dataset',      Icon: Database },
];

const AVATAR_PALETTES = [
  ['bg-danger/20',    'text-danger',    'ring-danger/20'   ],
  ['bg-warning/20',   'text-warning',   'ring-warning/20'  ],
  ['bg-success/20', 'text-success', 'ring-success/20'],
  ['bg-info/20',     'text-info',     'ring-info/20'    ],
  ['bg-ai/20',  'text-ai',  'ring-ai/20' ],
  ['bg-brand/20',  'text-brand',  'ring-brand/20' ],
];
function paletteFor(name) {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(h) % AVATAR_PALETTES.length];
}

function FaceAvatar({ name }) {
  const [bg, fg, ring] = paletteFor(name);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  return (
    <div className={`w-10 h-10 shrink-0 rounded-full ring-1 ${ring} ${bg} ${fg} text-body font-bold flex items-center justify-center select-none`}>
      {initials}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
export default function Watchlist() {
  const [mode, setMode]               = useState('individual');

  /* individual */
  const [roster, setRoster]           = useState(loadRoster);
  const [name, setName]               = useState('');
  const [imgFile, setImgFile]         = useState(null);
  const [preview, setPreview]         = useState(null);
  const [imgDrag, setImgDrag]         = useState(false);
  const [indivStatus, setIndivStatus] = useState({ kind: 'idle', msg: '' });
  const [indivPct, setIndivPct]       = useState(0);
  const [filter, setFilter]           = useState('');
  const fileRef = useRef(null);

  /* bulk */
  const [personType, setPersonType]   = useState('student');
  const [batchName, setBatchName]     = useState('');
  const [zipFile, setZipFile]         = useState(null);
  const [zipDrag, setZipDrag]         = useState(false);
  const [bulkStatus, setBulkStatus]   = useState({ kind: 'idle', msg: '', pct: 0 });
  const [datasets, setDatasets]       = useState([]);
  const [dsLoading, setDsLoading]     = useState(false);
  const zipRef = useRef(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const fetchDatasets = useCallback(async () => {
    setDsLoading(true);
    try { const r = await api.get('/ai/watchlist/datasets'); setDatasets(r.data?.datasets || []); }
    catch { /* silent */ }
    finally { setDsLoading(false); }
  }, []);

  /* ── individual ── */
  const setImg = f => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setIndivStatus({ kind: 'error', msg: 'Please select a JPG, PNG, or WEBP image.' }); return; }
    if (f.size > MAX_IMAGE_BYTES) {
      const mb = Math.round(f.size / (1024 * 1024));
      setIndivStatus({ kind: 'error', msg: `This image is ${mb} MB. Maximum ${MAX_IMAGE_MB} MB — try a smaller or resized photo.` });
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setImgFile(f); setPreview(URL.createObjectURL(f)); setIndivStatus({ kind: 'idle', msg: '' });
  };
  // `keepStatus` exists for the post-submit call: clearing the fields must not
  // also wipe the "added successfully" confirmation the user just earned.
  const resetIndiv = ({ keepStatus = false } = {}) => {
    if (preview) URL.revokeObjectURL(preview);
    setName(''); setImgFile(null); setPreview(null);
    setIndivPct(0);
    if (!keepStatus) setIndivStatus({ kind: 'idle', msg: '' });
    if (fileRef.current) fileRef.current.value = '';
  };
  const submitIndiv = async e => {
    e.preventDefault();
    if (!name.trim()) { setIndivStatus({ kind: 'error', msg: 'Enter the person\'s full name.' }); return; }
    if (!imgFile)     { setIndivStatus({ kind: 'error', msg: 'Upload a clear face photo.' }); return; }
    setIndivStatus({ kind: 'loading', msg: '' });
    setIndivPct(0);
    try {
      await aiService.uploadFace(name.trim(), imgFile, {
        onUploadProgress: ev => {
          if (!ev?.total) return;
          setIndivPct(Math.max(0, Math.min(100, Math.round((ev.loaded * 100) / ev.total))));
        },
      });
      const updated = [
        { name: name.trim(), addedAt: new Date().toISOString() },
        ...roster.filter(r => r.name.toLowerCase() !== name.trim().toLowerCase()),
      ];
      saveRoster(updated); setRoster(updated);
      resetIndiv({ keepStatus: true });
      setIndivStatus({ kind: 'success', msg: `"${name.trim()}" added successfully.` });
    } catch (err) {
      setIndivStatus({ kind: 'error', msg: err?.response?.data?.message || 'Upload failed — AI service may be offline.' });
      setIndivPct(0);
    }
  };
  const deleteFace = async entry => {
    if (!confirm(`Remove "${entry.name}" from the watchlist?`)) return;
    try { await aiService.deleteFace(entry.name); } catch { /* removed locally */ }
    const updated = roster.filter(r => r.name !== entry.name);
    saveRoster(updated); setRoster(updated);
  };

  /* ── bulk ── */
  const setZip = f => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) { setBulkStatus({ kind: 'error', msg: 'Only .zip files are accepted.', pct: 0 }); return; }
    // Files above the API's own ceiling can't be rescued by chunking, so refuse
    // them here — while we can still explain what to do — rather than after a
    // long upload.
    if (f.size > MAX_ZIP_BYTES) {
      const mb = Math.round(f.size / (1024 * 1024));
      setBulkStatus({
        kind: 'error',
        msg: `This ZIP is ${mb} MB. Maximum ${MAX_ZIP_MB} MB — please split it into smaller batches and upload them one after another.`,
        pct: 0,
      });
      return;
    }
    setZipFile(f); setBulkStatus({ kind: 'idle', msg: '', pct: 0 });
  };
  const resetBulk = () => {
    setZipFile(null); setBatchName('');
    setBulkStatus({ kind: 'idle', msg: '', pct: 0 });
    if (zipRef.current) zipRef.current.value = '';
  };
  const submitBulk = async e => {
    e.preventDefault();
    if (!zipFile) return;
    setBulkStatus({ kind: 'loading', msg: '', pct: 0 });
    try {
      const category = personType;
      const label    = batchName.trim() || zipFile.name;

      if (zipFile.size <= SINGLE_SHOT_MAX_BYTES) {
        // Small enough to fit in one request — keep the simple path.
        const form = new FormData();
        form.append('dataset', zipFile);
        form.append('category', category);
        form.append('batchName', label);
        await api.post('/ai/watchlist/dataset', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: ev => setBulkStatus({ kind: 'loading', msg: '', pct: Math.round((ev.loaded * 100) / ev.total) }),
        });
      } else {
        // Too big for one request: slice it. Each part stays well under the
        // edge's body limit, and the API reassembles them.
        const totalChunks = Math.ceil(zipFile.size / CHUNK_BYTES);

        const { data: init } = await api.post('/ai/watchlist/dataset/chunk/init', {
          size: zipFile.size,
          filename: zipFile.name,
        });
        const uploadId = init?.uploadId;
        if (!uploadId) throw new Error('Could not start the upload.');

        for (let i = 0; i < totalChunks; i += 1) {
          const slice = zipFile.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
          const form  = new FormData();
          form.append('uploadId', uploadId);
          form.append('index', String(i));
          form.append('chunk', slice, `${zipFile.name}.part${i}`);

          // eslint-disable-next-line no-await-in-loop -- parts are sent in order
          await api.post('/ai/watchlist/dataset/chunk', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
            onUploadProgress: ev => {
              // Progress across the whole file, not just the current part —
              // a bar that resets on every chunk reads as though it is stuck.
              const done = i * CHUNK_BYTES + (ev.loaded || 0);
              const pct  = Math.min(99, Math.round((done * 100) / zipFile.size));
              setBulkStatus({ kind: 'loading', msg: `Uploading part ${i + 1} of ${totalChunks}…`, pct });
            },
          });
        }

        setBulkStatus({ kind: 'loading', msg: 'Assembling and processing…', pct: 99 });
        await api.post('/ai/watchlist/dataset/chunk/complete', {
          uploadId,
          filename: zipFile.name,
          totalChunks,
          category,
          batchName: label,
        });
      }
      setBulkStatus({ kind: 'success', msg: 'Dataset uploaded. Face recognition will be active within 12–24 hours.', pct: 100 });
      setZipFile(null); setBatchName('');
      if (zipRef.current) zipRef.current.value = '';
      fetchDatasets();
    } catch (err) {
      // A 413 should no longer be reachable for large files (they go out in
      // parts), so if one appears it means a single request was still too big —
      // most likely the edge limit tightened. Say so plainly rather than
      // repeating generic advice.
      const msg = err?.response?.status === 413
        ? `Upload rejected as too large (${MAX_ZIP_MB} MB maximum). If this ZIP is smaller than that, please report it — the size limit may have changed.`
        : err?.response?.data?.message || 'Upload failed. Please try again.';
      setBulkStatus({ kind: 'error', msg, pct: 0 });
    }
  };

  const visible = roster.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()));

  // Entering the bulk view is what pulls the upload history — the individual
  // view never needs it, so it is not fetched on mount.
  const switchMode = id => { setMode(id); if (id === 'bulk') fetchDatasets(); };

  /* ════════════════════════════════════════════════ RENDER ══ */
  // Frame, height, inset and header typography all come from OperationsPage —
  // the same shell Camera Setup, Health, Live View, Playback and Map use, so
  // this page inherits the viewport lock instead of re-deriving it. Inside it,
  // each form is header / scrolling body / pinned action row: the fields are
  // the only thing that can ever overflow, so Clear and Add to Watchlist stay
  // on screen at every window height.
  return (
    <OperationsPage>
      <PageHeader
        icon={UsersRound}
        title="Known people"
        description="Register known faces so cameras identify students, staff & security in real time."
        actions={
          <>
            {roster.length > 0 && (
              <Badge variant="secondary" className="gap-1.5 px-3 py-1.5 text-body">
                <CheckCircle2 size={13} className="text-success" />
                {roster.length} {roster.length === 1 ? 'face' : 'faces'} registered
              </Badge>
            )}
            {mode === 'bulk' && (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning-line bg-warning-soft px-3 py-1 text-small font-semibold text-warning-ink">
                <Zap size={13} className="shrink-0" />
                Processing Time: 12–24 hrs
              </span>
            )}
            <PageTabs tabs={MODES} active={mode} onChange={switchMode} />
          </>
        }
      />

      <PageContent>
        {/* Two panes side by side as soon as there is room for them. The
            sidebar eats 256px, so `lg` here is ~700px of usable content —
            still comfortable for the form. Narrower than that the panes
            stack, and a stacked pair genuinely cannot fit one viewport, so
            this column scrolls as a whole rather than making each card
            scroll its own middle. */}
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-1 min-[1284px]:grid min-[1284px]:grid-cols-12 min-[1284px]:items-stretch min-[1284px]:overflow-hidden">

        {mode === 'individual' ? (
          <>
            {/* ══════════════ INDIVIDUAL — add one face ══════════════ */}
            <Card className="flex w-full shrink-0 flex-col gap-0 overflow-hidden py-0 min-[1284px]:col-span-5 min-[1284px]:min-h-0">
              <form onSubmit={submitIndiv} className="flex flex-col min-[1284px]:min-h-0 min-[1284px]:flex-1">

                <div className="shrink-0 px-6 pb-4 pt-5">
                  <h2 className="text-sm font-semibold text-fg sm:text-base">Add a known face</h2>
                  <p className="mt-0.5 text-small text-fg-muted">
                    Provide the person&apos;s name and a clear front-facing photo.
                  </p>
                </div>
                <Separator />

                <div className="flex flex-col gap-5 px-6 py-5 min-[1284px]:min-h-0 min-[1284px]:flex-1 min-[1284px]:overflow-y-auto">

                  {/* Step 1 — Name */}
                  <div className="shrink-0 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-small font-semibold uppercase tracking-wider text-fg-muted">
                        Full name
                      </label>
                      <span className="text-micro font-medium text-danger-ink">Required</span>
                    </div>
                    <Input
                      value={name}
                      onChange={e => { setName(e.target.value); if (indivStatus.kind === 'error') setIndivStatus({ kind: 'idle', msg: '' }); }}
                      placeholder="e.g. Rahul Sharma"
                      autoComplete="off"
                      className="h-11"
                    />
                  </div>

                  {/* Step 2 — Photo. Absorbs whatever height is left over, and
                      gives it back on short windows rather than pushing the
                      action row out of view. */}
                  <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                    <div className="flex shrink-0 items-center justify-between">
                      <label className="text-small font-semibold uppercase tracking-wider text-fg-muted">
                        Face photo
                      </label>
                      <span className="text-micro font-medium text-danger-ink">Required</span>
                    </div>
                    <div
                      onClick={() => fileRef.current?.click()}
                      onDragOver={e => { e.preventDefault(); setImgDrag(true); }}
                      onDragLeave={() => setImgDrag(false)}
                      onDrop={e => { e.preventDefault(); setImgDrag(false); setImg(e.dataTransfer.files?.[0]); }}
                      className={`relative min-h-[140px] max-h-[15rem] flex-1 cursor-pointer overflow-hidden rounded-lg border-2 border-dashed transition-colors ${
                        preview   ? 'border-brand/40 bg-brand/5'
                        : imgDrag ? 'border-brand/60 bg-brand/10'
                        :           'border-line bg-surface-muted/20 hover:border-brand/40 hover:bg-brand/5'
                      }`}
                    >
                      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => setImg(e.target.files?.[0])} />
                      {preview ? (
                        <>
                          <img src={preview} alt="" className="h-full w-full object-cover" />
                          <div className="absolute inset-0 bg-linear-to-t from-black/70 via-transparent to-transparent" />
                          <div className="absolute bottom-0 left-0 right-0 px-4 py-3">
                            <p className="truncate text-body font-semibold text-white">{name || 'Preview'}</p>
                            <p className="text-caption text-white/60">Click or drop to replace</p>
                          </div>
                          <button
                            type="button"
                            onClick={ev => { ev.stopPropagation(); resetIndiv(); }}
                            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
                            title="Remove photo"
                          >
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-muted dark:border-line-strong dark:bg-surface-sunken">
                            <Upload size={20} className="text-fg-muted dark:text-brand-ink" />
                          </div>
                          <div>
                            <p className="text-body font-semibold">Drop photo or click to browse</p>
                            <p className="mt-0.5 text-small text-fg-muted">JPG · PNG · WEBP · max {MAX_IMAGE_MB} MB · front-facing</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {indivStatus.kind === 'error'   && <Alert kind="error"   icon={AlertCircle}>{indivStatus.msg}</Alert>}
                  {indivStatus.kind === 'success' && <Alert kind="success" icon={CheckCircle2}>{indivStatus.msg}</Alert>}
                  {indivStatus.kind === 'loading' && (
                    <div className="shrink-0 space-y-1.5">
                      <div className="flex justify-between text-small">
                        <span className="text-fg-muted">Uploading…</span>
                        <span className="font-semibold tabular-nums text-brand-ink">{indivPct}%</span>
                      </div>
                      <Progress value={indivPct} className="h-2" />
                    </div>
                  )}
                </div>

                {/* Action row — pinned, never scrolled past */}
                <Separator />
                <div className="flex shrink-0 flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => resetIndiv()}
                    disabled={indivStatus.kind === 'loading' || (!name && !imgFile)}
                    className="h-11 w-full px-6 sm:w-auto"
                  >
                    Clear
                  </Button>
                  <Button
                    type="submit"
                    disabled={!name.trim() || !imgFile || indivStatus.kind === 'loading'}
                    className="h-11 gap-2 px-6"
                  >
                    {indivStatus.kind === 'loading'
                      ? <><BtnSpinner /> Adding…</>
                      : <><UserRoundPlus size={15} /> Add to Watchlist</>}
                  </Button>
                </div>
              </form>
            </Card>

            {/* Known faces roster */}
            <Card className="flex w-full shrink-0 flex-col gap-0 overflow-hidden py-0 min-[1284px]:col-span-7 min-[1284px]:min-h-0">
              <div className="flex shrink-0 flex-col items-start justify-between gap-3 px-6 pb-4 pt-5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-fg sm:text-base">Known faces</h2>
                  <p className="mt-0.5 text-small text-fg-muted">
                    View, search or manage faces registered in this list in real time.
                  </p>
                </div>
                <div className="relative w-full shrink-0 sm:w-64">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
                  <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Search by name..."
                    disabled={roster.length === 0}
                    className="h-10 rounded-lg pl-9 text-small transition-all duration-200 hover:border-line-strong focus:border-brand focus:ring-2 focus:ring-brand/20 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20"
                  />
                </div>
              </div>
              <Separator />
              <div className="max-h-[600px] overflow-y-auto pr-1 min-[1284px]:min-h-0 min-[1284px]:flex-1">
                {roster.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No faces registered yet"
                    body={
                      <>
                        Use the form on the left, or switch to{' '}
                        <span className="font-medium text-brand-ink">Bulk Dataset</span>{' '}
                        to import an entire class or team.
                      </>
                    }
                  />
                ) : visible.length === 0 ? (
                  <div className="flex h-full items-center justify-center px-6 py-16">
                    <p className="text-body text-fg-muted">No results for &quot;<span className="text-fg">{filter}</span>&quot;</p>
                  </div>
                ) : (
                  <div className="divide-y divide-line">
                    {visible.map(entry => (
                      <div key={entry.name} className="group flex items-center gap-3 px-6 py-3.5 transition hover:bg-surface-muted/30">
                        <FaceAvatar name={entry.name} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-body font-semibold">{entry.name}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-caption text-fg-muted">
                            <CheckCircle2 size={10} className="text-success" />
                            Added {fmtDate(entry.addedAt)}
                          </p>
                        </div>
                        <button
                          onClick={() => deleteFace(entry)}
                          className="rounded-md p-1.5 text-fg-muted opacity-0 transition hover:bg-danger/10 hover:text-danger-ink group-hover:opacity-100"
                          title="Remove"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </>
        ) : (
          <>
            {/* ══════════════ BULK — import a dataset ══════════════ */}
            <Card className="flex w-full shrink-0 flex-col gap-0 overflow-hidden py-0 min-[1284px]:col-span-5 min-[1284px]:min-h-0">
              <form onSubmit={submitBulk} className="flex flex-col min-[1284px]:min-h-0 min-[1284px]:flex-1">

                <div className="shrink-0 px-6 pb-3 pt-4">
                  <h2 className="text-sm font-semibold text-fg sm:text-base">Upload face dataset</h2>
                  <p className="mt-0.5 text-small text-fg-muted">
                    Upload a labelled ZIP of photos — your cameras will recognise them within 12–24 hours.
                  </p>
                </div>
                <Separator />

                {/* Scrolls only in the height-locked 2-col mode, so a short viewport
                    never presses the drop zone flush against the action row below. */}
                <div className="flex flex-col gap-3 px-6 py-3 min-[1284px]:min-h-0 min-[1284px]:flex-1 min-[1284px]:overflow-y-auto">

                  {/* Person type */}
                  <div className="shrink-0 space-y-2">
                    <label className="text-small font-semibold uppercase tracking-wider text-fg-muted">
                      Person type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {PERSON_TYPES.map(pt => {
                        const Icon = pt.icon;
                        const active = personType === pt.value;
                        return (
                          <button
                            key={pt.value}
                            type="button"
                            onClick={() => setPersonType(pt.value)}
                            className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-1.5 text-body font-medium transition-all ${
                              active
                                ? 'border-brand bg-brand/10 text-brand-ink'
                                : 'border-line bg-surface-muted/20 text-fg-muted hover:bg-surface-muted/40 hover:text-fg'
                            }`}
                          >
                            <Icon size={14} />
                            {pt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Batch name */}
                  <div className="shrink-0 space-y-1.5">
                    <label className="text-small font-semibold uppercase tracking-wider text-fg-muted">
                      Batch name <span className="font-normal normal-case text-fg-muted/60">(optional)</span>
                    </label>
                    <Input
                      value={batchName}
                      onChange={e => setBatchName(e.target.value)}
                      placeholder="e.g. Grade 10 — Semester 2"
                      className="h-11"
                    />
                  </div>

                  {/* ZIP drop zone */}
                  <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
                    <div className="flex shrink-0 items-center justify-between">
                      <label className="text-small font-semibold uppercase tracking-wider text-fg-muted">ZIP file</label>
                      <span className="text-micro font-medium text-danger-ink">Required</span>
                    </div>
                    <div
                      onClick={() => zipRef.current?.click()}
                      onDragOver={e => { e.preventDefault(); setZipDrag(true); }}
                      onDragLeave={() => setZipDrag(false)}
                      onDrop={e => { e.preventDefault(); setZipDrag(false); setZip(e.dataTransfer.files?.[0]); }}
                      className={`flex min-h-[140px] max-h-[13rem] flex-1 min-[1284px]:min-h-[112px] cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed transition-colors ${
                        zipFile   ? 'border-brand/40 bg-brand/5'
                        : zipDrag ? 'border-brand/60 bg-brand/10'
                        :           'border-line bg-surface-muted/20 hover:border-brand/40 hover:bg-brand/5'
                      }`}
                    >
                      <input ref={zipRef} type="file" accept=".zip" className="hidden" onChange={e => setZip(e.target.files?.[0])} />
                      {zipFile ? (
                        <div className="flex w-full items-center gap-3 px-5">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand/10">
                            <FileArchive size={20} className="text-brand" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body font-semibold">{zipFile.name}</p>
                            <p className="text-small text-fg-muted">{fmtSize(zipFile.size)}</p>
                          </div>
                          <button
                            type="button"
                            onClick={ev => { ev.stopPropagation(); setZipFile(null); if (zipRef.current) zipRef.current.value = ''; }}
                            className="shrink-0 rounded-md p-1.5 text-fg-muted transition hover:bg-surface-muted hover:text-fg"
                            title="Remove file"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex w-full items-center gap-3 px-5">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-muted">
                            <FileArchive size={20} className="text-fg-muted" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-body font-semibold">Drop ZIP here or click to browse</p>
                            <p className="mt-0.5 text-small text-fg-muted">Max {MAX_ZIP_MB} MB · one folder per person · large archives upload in parts automatically</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {bulkStatus.kind === 'loading' && (
                    <div className="shrink-0 space-y-1.5">
                      <div className="flex justify-between text-small">
                        <span className="text-fg-muted">Uploading…</span>
                        <span className="font-semibold tabular-nums text-brand-ink">{bulkStatus.pct}%</span>
                      </div>
                      <Progress value={bulkStatus.pct} className="h-2" />
                    </div>
                  )}
                  {bulkStatus.kind === 'error'   && <Alert kind="error"   icon={AlertCircle}>{bulkStatus.msg}</Alert>}
                  {bulkStatus.kind === 'success' && <Alert kind="success" icon={CheckCircle2}>{bulkStatus.msg}</Alert>}
                </div>

                <Separator />
                <div className="flex shrink-0 flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetBulk}
                    disabled={bulkStatus.kind === 'loading' || (!zipFile && !batchName)}
                    className="h-11 px-6"
                  >
                    Clear
                  </Button>
                  <Button
                    type="submit"
                    disabled={!zipFile || bulkStatus.kind === 'loading'}
                    className="h-11 w-full gap-2 px-6 sm:w-auto"
                  >
                    {bulkStatus.kind === 'loading'
                      ? <><BtnSpinner /> Uploading…</>
                      : <><Upload size={15} /> Upload Dataset</>}
                  </Button>
                </div>
              </form>
            </Card>

            {/* Right side: notice + history + format guide. This column is the
                one region allowed to scroll, so the form opposite it keeps its
                action row anchored. */}
            <div className="flex w-full shrink-0 flex-col min-[1284px]:col-span-7 min-[1284px]:min-h-0">

              <Card className="flex flex-col gap-0 overflow-hidden py-0 min-[1284px]:min-h-0 min-[1284px]:flex-1">
                <div className="flex shrink-0 items-center gap-3 px-6 pb-4 pt-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-sm font-semibold text-fg sm:text-base">Upload history</h2>
                      <ZipStructureInfo />
                    </div>
                    <p className="mt-0.5 text-small text-fg-muted">Datasets you have submitted.</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={fetchDatasets} title="Refresh" className="h-8 w-8 shrink-0">
                    <RefreshCw size={14} className={dsLoading ? 'animate-spin' : ''} />
                  </Button>
                </div>
                <Separator />
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {dsLoading ? (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-fg-muted">
                      <span className="h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
                      <p className="text-body">Loading…</p>
                    </div>
                  ) : datasets.length === 0 ? (
                    <EmptyState icon={Archive} title="No uploads yet" body="Your uploaded datasets will appear here." />
                  ) : (
                    <div className="divide-y divide-line">
                      {datasets.map(ds => (
                        <div key={ds.key} className="group flex items-center gap-3 px-6 py-4 transition hover:bg-surface-muted/20">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand/10">
                            <FileArchive size={18} className="text-brand" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body font-semibold">{ds.originalName || ds.filename}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
                              <span className="flex items-center gap-1 text-caption text-fg-muted">
                                <Clock size={10} /> {fmtDateTime(ds.lastModified)}
                              </span>
                              <span className="text-caption text-fg-muted">{fmtSize(ds.sizeBytes)}</span>
                            </div>
                          </div>
                          <a
                            href={ds.downloadUrl}
                            download
                            className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-muted px-3 py-1.5 text-small font-medium opacity-0 transition hover:bg-surface-muted/80 group-hover:opacity-100"
                          >
                            <Download size={12} /> Download
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </>
        )}
        </div>
      </PageContent>
    </OperationsPage>
  );
}

/* ─── shared sub-components ─────────────────────────────────────────────── */

// One source for the layout, so the tooltip preview and the dialog can never
// drift apart. Indentation is data rather than markup because the box-drawing
// characters have to line up exactly to read as a tree.
const ZIP_TREE = [
  { depth: 0, text: 'faces.zip/',       tone: 'font-bold text-fg' },
  { depth: 1, text: '├── Rahul_Sharma/', tone: 'text-brand-ink'   },
  { depth: 2, text: '│   ├── photo1.jpg', tone: 'text-fg-muted'   },
  { depth: 2, text: '│   └── photo2.jpg', tone: 'text-fg-muted'   },
  { depth: 1, text: '└── Priya_Mehta/',  tone: 'text-brand-ink'   },
  { depth: 2, text: '    └── front.jpg', tone: 'text-fg-muted'    },
];

const ZIP_NOTE =
  "Each subfolder name becomes the person's identity label. Use clear, front-facing photos for best accuracy.";

function ZipTree({ muted = false }) {
  return (
    <div
      className={`space-y-0.5 rounded-lg border p-4 font-mono text-small ${
        muted ? 'border-white/15 bg-white/5' : 'border-line bg-surface-muted/30'
      }`}
    >
      {ZIP_TREE.map((row) => (
        <p className={muted ? '' : row.tone} key={row.text}>
          {row.text}
        </p>
      ))}
    </div>
  );
}

/**
 * The ZIP layout requirement, attached to the thing it describes.
 *
 * It used to be a standalone card at the bottom of the column — furthest from
 * the drop zone it explains, and taking permanent height from a pane that has
 * none to spare. As an affordance on the heading it costs 14px: hovering gives
 * the one-line rule, clicking gives the full tree.
 *
 * The trigger is a real <button> so it is keyboard reachable; Radix opens the
 * tooltip on focus as well as hover, so the preview is not mouse-only.
 */
function ZipStructureInfo() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Expected ZIP structure"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-soft text-brand transition hover:bg-brand/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            onClick={() => setOpen(true)}
            type="button"
          >
            <Info size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Expected ZIP structure</TooltipContent>
      </Tooltip>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Expected ZIP structure</DialogTitle>
            <DialogDescription>
              Your archive needs one folder per person at the top level.
            </DialogDescription>
          </DialogHeader>
          <ZipTree />
          <p className="text-small text-fg-muted">{ZIP_NOTE}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Alert({ kind, icon: Icon, children }) {
  return (
    <div className={`flex items-start gap-2.5 px-3.5 py-3 rounded-lg border text-body ${
      kind === 'success'
        ? 'bg-success/10 border-success/20 text-success'
        : 'bg-danger/10 border-danger/20 text-danger-ink'
    }`}>
      <Icon size={14} className="shrink-0 mt-0.5" />
      <p className="font-medium leading-snug">{children}</p>
    </div>
  );
}

function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-8">
      <div className="w-14 h-14 rounded-2xl bg-surface-muted border border-line flex items-center justify-center text-fg-muted mb-4">
        <Icon size={24} />
      </div>
      <p className="text-body font-semibold mb-1.5">{title}</p>
      <p className="text-small text-fg-muted max-w-xs leading-relaxed">{body}</p>
    </div>
  );
}

function BtnSpinner() {
  return <span className="w-4 h-4 rounded-full border-2 border-current border-r-transparent animate-spin" />;
}
