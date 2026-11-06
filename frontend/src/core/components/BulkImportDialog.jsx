import { useEffect, useRef, useState } from 'react';
import {
  Upload, X, FileText, AlertCircle, CheckCircle2, Loader2,
  Download, ArrowRight, ArrowLeft, AlertTriangle, Sparkles,
} from 'lucide-react';
import { siteService } from '@/core/services/site';

/**
 * BulkImportDialog — guided 3-step onboarding for many cameras at once.
 *
 *  step 1: pick / drop a CSV (or paste text)
 *  step 2: server-side preview — show parsed rows, errors, decisions; user
 *          can deselect rows
 *  step 3: commit — server provisions in MediaMTX + writes DB rows; show
 *          per-row results
 *
 * Uses the app's theme tokens (bg-surface, bg-popover, border-line, etc.)
 * so the dialog blends with the rest of the UI in both dark and light modes.
 */
const STEPS = [
  { key: 'pick',    label: 'Upload CSV' },
  { key: 'preview', label: 'Review'     },
  { key: 'commit',  label: 'Import'     },
];

export default function BulkImportDialog({ site, onClose, onDone }) {
  const [step, setStep]       = useState('pick');
  const [csvText, setCsv]     = useState('');
  const [file, setFile]       = useState(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [preview, setPreview] = useState(null);
  const [picked, setPicked]   = useState(new Set());
  const [result, setResult]   = useState(null);
  const [visible, setVisible] = useState(false);   // slide-in
  const [closing, setClosing] = useState(false);   // slide-out

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Mount → slide in next tick. Escape → request close.
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    const onKey = (e) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setVisible(false);
    setTimeout(onClose, 220);
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* Click-catcher — invisible. No blur, no dim. Page stays visible. */}
      <div
        className="absolute inset-0 pointer-events-auto"
        onClick={requestClose}
        aria-hidden="true"
      />

      {/* Drawer — slides in from the right. Wider than the create-site
          drawer because the Review step needs room for the row table. */}
      <div
        className={`absolute top-0 right-0 h-full w-full sm:w-[560px] lg:w-[640px] bg-surface border-l border-line shadow-2xl shadow-black/40 pointer-events-auto flex flex-col transform transition-transform duration-200 ease-out ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-primary/15 ring-1 ring-primary/20 text-primary">
              <Upload size={16} />
            </div>
            <div className="min-w-0">
              <h2 className="text-heading font-semibold text-fg truncate">
                Import cameras to {site.name}
              </h2>
              <Stepper index={stepIndex} />
            </div>
          </div>
          <button
            onClick={requestClose}
            className="shrink-0 p-1.5 rounded-md hover:bg-surface-muted text-fg-muted hover:text-fg transition"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === 'pick' && (
            <PickStep
              file={file} setFile={setFile}
              csvText={csvText} setCsv={setCsv}
              error={error}
            />
          )}
          {step === 'preview' && preview && (
            <PreviewStep
              preview={preview}
              picked={picked} setPicked={setPicked}
            />
          )}
          {step === 'commit' && result && (
            <CommitStep result={result} />
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-t border-line bg-background/40 flex items-center justify-between gap-3">
          {step !== 'commit' ? (
            <button
              onClick={requestClose}
              className="px-3 py-2 rounded-lg text-body text-fg-muted hover:text-fg transition"
            >
              Cancel
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            {step === 'preview' && (
              <button
                onClick={() => { setStep('pick'); setError(null); }}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-surface hover:bg-surface-muted text-fg text-body border border-line transition"
              >
                <ArrowLeft size={14} /> Back
              </button>
            )}

            {step === 'pick' && (
              <button
                disabled={busy || (!csvText && !file)}
                onClick={async () => {
                  setBusy(true); setError(null);
                  try {
                    const res = await siteService.previewImport(site.id, file || csvText);
                    setPreview(res);
                    const auto = new Set(
                      (res.rows || [])
                        .filter((r) => r.decision === 'create')
                        .map((r) => r.lineNumber)
                    );
                    setPicked(auto);
                    setStep('preview');
                  } catch (e) {
                    setError(e?.response?.data?.message || e?.message || 'Preview failed.');
                  } finally {
                    setBusy(false);
                  }
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground text-body font-semibold transition"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Preview
              </button>
            )}

            {step === 'preview' && (
              <button
                disabled={busy || picked.size === 0}
                onClick={async () => {
                  setBusy(true); setError(null);
                  try {
                    const rows = (preview.rows || [])
                      .filter((r) => picked.has(r.lineNumber) && r.decision === 'create');
                    const res = await siteService.commitImport(site.id, rows);
                    setResult(res);
                    setStep('commit');
                  } catch (e) {
                    setError(e?.response?.data?.message || e?.message || 'Import failed.');
                  } finally {
                    setBusy(false);
                  }
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-primary-foreground text-body font-semibold transition"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                Import {picked.size} selected
              </button>
            )}

            {step === 'commit' && (
              <button
                onClick={() => {
                  // Slide out, THEN run the parent's onDone so the animation
                  // is visible before the parent unmounts us.
                  setClosing(true);
                  setVisible(false);
                  setTimeout(() => onDone?.(), 220);
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-body font-semibold transition"
              >
                <CheckCircle2 size={14} /> Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────── Step components ──────────────────── */

function Stepper({ index }) {
  return (
    <div className="flex items-center gap-2 text-caption text-fg-muted mt-0.5">
      {STEPS.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${i <= index ? 'bg-primary' : 'bg-border'}`} />
          <span className={i === index ? 'text-fg font-medium' : ''}>
            {s.label}
          </span>
          {i < STEPS.length - 1 && <span className="text-fg-muted/50">·</span>}
        </span>
      ))}
    </div>
  );
}

function PickStep({ file, setFile, csvText, setCsv, error }) {
  const fileRef = useRef(null);
  const [drag, setDrag] = useState(false);

  const handleFile = (f) => {
    if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      alert('Please pick a .csv file.');
      return;
    }
    setFile(f);
    setCsv('');
  };

  const downloadTemplate = async () => {
    const url = await siteService.downloadTemplate();
    const a = document.createElement('a');
    a.href = url;
    a.download = 'drishyam-cameras-template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="space-y-4">
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files?.[0]); }}
        className={`relative cursor-pointer rounded-xl border-2 border-dashed transition-all overflow-hidden ${
          file
            ? 'border-primary/40 bg-primary/[0.04]'
            : drag
              ? 'border-primary/60 bg-primary/[0.06]'
              : 'border-line hover:border-line/80 bg-background/60 hover:bg-background/80'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <div className="p-8 flex flex-col items-center gap-2 text-center">
          {file ? (
            <>
              <div className="w-12 h-12 rounded-xl bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center text-primary">
                <FileText size={20} />
              </div>
              <p className="text-body font-semibold text-fg">{file.name}</p>
              <p className="text-small text-fg-muted">
                {(file.size / 1024).toFixed(1)} KB · click to change
              </p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-xl bg-surface-muted ring-1 ring-border flex items-center justify-center text-fg-muted">
                <Upload size={20} />
              </div>
              <p className="text-body font-semibold text-fg">
                Drop CSV here or click to browse
              </p>
              <p className="text-small text-fg-muted">
                One row per device (NVR / IP camera). Up to 5 MB.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={downloadTemplate}
          type="button"
          className="flex items-center gap-1.5 text-small text-primary hover:underline"
        >
          <Download size={12} /> Download CSV template
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-micro uppercase tracking-wider text-fg-muted font-semibold">
            …or paste CSV text
          </label>
          {csvText && (
            <span className="text-caption text-fg-muted tabular-nums">
              {csvText.split('\n').filter(Boolean).length} lines
            </span>
          )}
        </div>
        <textarea
          value={csvText}
          onChange={(e) => { setCsv(e.target.value); setFile(null); }}
          placeholder={`name,host,port,username,password,device_type,total_channels\nOffice NVR,192.168.1.10,554,admin,admin,hikvision,16`}
          rows={6}
          className="w-full bg-background border border-line rounded-lg px-3 py-2 text-fg placeholder:text-fg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition font-mono text-small"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20 text-danger text-body">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <p className="leading-snug">{error}</p>
        </div>
      )}
    </div>
  );
}

function PreviewStep({ preview, picked, setPicked }) {
  const summary = preview.summary || {};
  const rows = preview.rows || [];

  const toggle = (lineNumber) => {
    const next = new Set(picked);
    next.has(lineNumber) ? next.delete(lineNumber) : next.add(lineNumber);
    setPicked(next);
  };

  const selectAllCreatable = () => {
    setPicked(new Set(rows.filter((r) => r.decision === 'create').map((r) => r.lineNumber)));
  };
  const clearAll = () => setPicked(new Set());

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-2 text-small">
        <Pill label="Will create"   value={summary.willCreate || 0}    accent="emerald" />
        <Pill label="Will skip"     value={summary.willSkip || 0}      accent="amber" />
        <Pill label="Total cameras" value={summary.totalCameras || 0}  accent="primary" />
      </div>

      {summary.headerErrors?.length > 0 && (
        <div className="bg-danger/10 border border-danger/20 text-danger rounded-lg px-3 py-2 text-body">
          <div className="font-semibold mb-1">Header errors</div>
          <ul className="list-disc list-inside text-small space-y-0.5">
            {summary.headerErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={selectAllCreatable}
          className="px-2.5 py-1 rounded-md bg-surface hover:bg-surface-muted text-fg text-small border border-line transition"
        >
          Select all creatable
        </button>
        <button
          onClick={clearAll}
          className="px-2.5 py-1 rounded-md bg-surface hover:bg-surface-muted text-fg text-small border border-line transition"
        >
          Clear
        </button>
        <span className="ml-auto text-small text-fg-muted tabular-nums">
          {picked.size} selected
        </span>
      </div>

      {/* Row list */}
      <div className="border border-line rounded-xl overflow-hidden">
        <div className="grid grid-cols-[28px_1fr_120px_70px_90px] gap-2 px-3 py-2 border-b border-line bg-popover text-micro uppercase tracking-wider text-fg-muted font-semibold">
          <span></span>
          <span>Name / Host</span>
          <span>Device</span>
          <span className="text-right">Channels</span>
          <span className="text-right">Status</span>
        </div>
        <div className="max-h-[calc(var(--app-vh)*0.4)] overflow-y-auto divide-y divide-line bg-background/40">
          {rows.map((r) => {
            const can = r.decision === 'create';
            const checked = picked.has(r.lineNumber);
            return (
              <label
                key={r.lineNumber}
                className={`grid grid-cols-[28px_1fr_120px_70px_90px] gap-2 px-3 py-2 items-center text-body transition ${
                  can ? 'hover:bg-surface-muted/40 cursor-pointer' : 'opacity-50'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={!can}
                  checked={checked}
                  onChange={() => toggle(r.lineNumber)}
                  className="accent-primary"
                />
                <div className="min-w-0">
                  <div className="font-medium text-fg truncate">{r.name || '—'}</div>
                  <div className="text-caption text-fg-muted truncate">{r.host}</div>
                </div>
                <div className="text-small text-fg-muted capitalize">{r.deviceType}</div>
                <div className="text-right text-fg tabular-nums">{r.totalChannels}</div>
                <div className="text-right">
                  <DecisionBadge row={r} />
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DecisionBadge({ row }) {
  if (row.decision === 'create') {
    return <span className="text-micro uppercase tracking-wider px-1.5 py-0.5 rounded bg-success/15 text-success ring-1 ring-success/20">Create</span>;
  }
  if (row.decision === 'skip-duplicate') {
    return <span className="text-micro uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/15 text-warning ring-1 ring-warning/20" title="Already configured">Dup</span>;
  }
  if (row.decision === 'error' || (row.errors && row.errors.length)) {
    return (
      <span
        title={(row.errors || []).join('; ')}
        className="text-micro uppercase tracking-wider px-1.5 py-0.5 rounded bg-danger/15 text-danger ring-1 ring-danger/20"
      >
        Error
      </span>
    );
  }
  return null;
}

function Pill({ label, value, accent }) {
  const cls = accent === 'emerald'
    ? 'bg-success/10 border-success/20 text-success'
    : accent === 'amber'
      ? 'bg-warning/10 border-warning/20 text-warning'
      : accent === 'primary'
        ? 'bg-primary/10 border-primary/20 text-primary'
        : 'bg-surface border-line text-fg';
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-micro uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-section font-bold tabular-nums leading-tight">{value.toLocaleString()}</div>
    </div>
  );
}

function CommitStep({ result }) {
  const summary = result.summary || {};
  const errors = (result.results || []).filter((r) => r.status === 'error');
  return (
    <div className="space-y-4">
      <div className="text-center py-6">
        <div className="inline-flex w-14 h-14 rounded-full bg-success/15 ring-1 ring-success/30 items-center justify-center mb-3">
          <CheckCircle2 className="text-success" size={26} />
        </div>
        <h3 className="text-section font-bold text-fg">Import complete</h3>
        <p className="text-body text-fg-muted mt-1">
          {summary.groupsCreated} groups · {summary.camerasCreated} cameras created
          {errors.length > 0 ? ` · ${errors.length} errors` : ''}
        </p>
      </div>

      {errors.length > 0 && (
        <div className="bg-danger/5 border border-danger/20 rounded-lg p-3">
          <div className="flex items-center gap-2 text-danger font-semibold text-body mb-2">
            <AlertTriangle size={14} /> Errors
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {errors.map((e, i) => (
              <div key={i} className="text-small flex items-baseline gap-2">
                <span className="text-danger font-mono">{e.host}</span>
                <span className="text-fg-muted truncate">{e.error}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-small text-fg-muted text-center">
        Cameras will appear online in the live view as soon as they connect.
        Up to 2 minutes for the first ones.
      </p>
    </div>
  );
}
