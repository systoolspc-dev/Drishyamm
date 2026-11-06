/**
 * EnhanceFaceDialog — reusable "Enhance this face" modal.
 *
 * Wraps the face-reconstruct service (CodeFormer + Real-ESRGAN) behind
 * a single drop-in component. Anywhere the UI has a face crop URL —
 * AI Alerts modal, AI Feed event panel, Personnel Search detail,
 * Watchlist — this gives the operator a one-click way to ask the GAN
 * to clean it up and inspect the result before-and-after.
 *
 * Usage:
 *
 *   <EnhanceFaceDialog imageUrl={snapshotUrl}>
 *     <Button>Enhance face</Button>
 *   </EnhanceFaceDialog>
 *
 * Anything you pass as children renders inside <DialogTrigger>, so the
 * caller controls the trigger's appearance. No prop drilling for that.
 *
 * State machine:
 *
 *   idle      — dialog opened, no fetch yet (user hasn't clicked Enhance)
 *   running   — POST in flight to /ai/enhance; spinner + disabled button
 *   ready     — got the response; show before / after / triage
 *   error     — show the upstream error message + a Retry button
 *
 * Why we don't auto-run on open: CodeFormer takes 1-3 s per call and is
 * a real GPU cost. Operators sometimes pop the dialog just to look at
 * the snapshot at higher resolution. The explicit click keeps the cost
 * intentional.
 */
import { useState } from 'react';
import { Loader2, Sparkles, Download, RotateCw } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/core/ui/dialog';
import { Button } from '@/core/ui/button';
import { Badge } from '@/core/ui/badge';
import { aiService } from '@/core/services/ai';

export default function EnhanceFaceDialog({ imageUrl, children, triggerLabel = 'Enhance face' }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('idle');         // 'idle' | 'running' | 'ready' | 'error'
  const [fidelity, setFidelity] = useState(0.5);
  const [result, setResult] = useState(null);          // { triage, before, after, mode }
  const [errMsg, setErrMsg] = useState('');

  // Reset state every time the dialog re-opens so the next click on a
  // different face doesn't show stale results.
  const onOpenChange = (next) => {
    setOpen(next);
    if (!next) {
      setPhase('idle');
      setResult(null);
      setErrMsg('');
    }
  };

  const run = async () => {
    if (!imageUrl) {
      setErrMsg('No image to enhance.');
      setPhase('error');
      return;
    }
    setPhase('running');
    setErrMsg('');
    try {
      // Pull the original bytes — works for both presigned-S3 URLs and
      // same-origin paths. We could pass the URL upstream and let the
      // Python side fetch, but doing it here means the AI service never
      // needs S3 credentials.
      const r = await fetch(imageUrl, { credentials: 'omit' });
      if (!r.ok) throw new Error(`source fetch failed: HTTP ${r.status}`);
      const blob = await r.blob();
      const data = await aiService.enhanceFace(blob, { fidelityWeight: fidelity });
      if (!data) throw new Error('no enhance result returned');
      setResult(data);
      setPhase('ready');
    } catch (err) {
      setErrMsg(err?.response?.data?.message || err.message || 'Enhance failed');
      setPhase('error');
    }
  };

  // Triage badge tone — pipeline.DegradationReport emits `overall_level`
  // as 'mild' | 'moderate' | 'severe' (verified against a real CCTV
  // frame response). Map to traffic-light colours.
  const triageTone = (lvl) =>
    lvl === 'severe'    ? 'border-danger-line bg-danger-soft text-danger-ink'
    : lvl === 'moderate'? 'border-warning-line bg-warning-soft text-warning-ink'
    : 'border-success-line bg-success-soft text-success-ink';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {children ?? <Button variant="outline" size="sm" className="gap-1.5">
          <Sparkles size={14} /> {triggerLabel}
        </Button>}
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-brand" />
            Face enhancement
          </DialogTitle>
          <DialogDescription>
            CodeFormer + Real-ESRGAN clean up blur, noise, and compression. Higher fidelity
            preserves identity better; lower fidelity does more aggressive restoration.
          </DialogDescription>
        </DialogHeader>

        {/* Image pair. Always render BOTH columns even before enhance so
            the modal doesn't pop in size when the result lands. */}
        <div className="grid grid-cols-2 gap-3">
          <Pane label="Original" src={imageUrl} />
          <Pane
            label={phase === 'ready' ? 'Enhanced' : 'Click Enhance to start'}
            // `reconstruction_image` is the real CodeFormer + Real-ESRGAN
            // output. `final_enhanced_image` is just stage-3 of the
            // classical CV pre-pass (bilateral + CLAHE + Laplacian) inside
            // pipeline.py — barely different from the input, which is why
            // the modal used to look broken. Fall back to it only if the
            // GAN output is somehow missing.
            src={toImgSrc(result?.reconstruction_image || result?.final_enhanced_image)}
            placeholder
          />
        </div>

        {/* Triage report — only meaningful once we have a result. */}
        {phase === 'ready' && result?.triage ? (
          <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-caption font-bold uppercase tracking-wider text-fg-muted">
                  Triage
                </span>
                <Badge variant="outline" className={triageTone(result.triage.overall_level)}>
                  {result.triage.overall_level} degradation
                </Badge>
                {result.device ? (
                  <Badge variant="outline" className="border-line bg-surface text-fg-secondary font-mono">
                    {result.device}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-3 text-caption text-fg-muted tabular-nums">
                <span>blur <span className="font-mono font-bold text-fg">{result.triage.blur_level}</span></span>
                <span>noise <span className="font-mono font-bold text-fg">{result.triage.noise_level}</span></span>
                <span>compression <span className="font-mono font-bold text-fg">{result.triage.compression_level}</span></span>
              </div>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-small font-semibold text-danger-ink">
            {errMsg}
          </div>
        ) : null}

        {/* Fidelity slider. Editable in idle/ready states; greyed during run. */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="ff-fidelity" className="text-small font-bold uppercase tracking-wider text-fg-muted">
              Fidelity weight
            </label>
            <span className="text-small font-mono tabular-nums font-semibold text-fg">
              {fidelity.toFixed(2)}
            </span>
          </div>
          <input
            id="ff-fidelity"
            type="range"
            min="0" max="1" step="0.05"
            value={fidelity}
            disabled={phase === 'running'}
            onChange={(e) => setFidelity(Number(e.target.value))}
            className="w-full accent-brand"
          />
          <div className="flex justify-between text-micro text-fg-subtle mt-0.5">
            <span>0 · max restoration</span>
            <span>1 · max identity preservation</span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          {phase === 'ready' && (result?.reconstruction_image || result?.final_enhanced_image) ? (
            <Button asChild variant="outline" className="gap-1.5">
              <a
                href={toImgSrc(result.reconstruction_image || result.final_enhanced_image)}
                download="face-enhanced.png"
              >
                <Download size={14} />
                Download enhanced
              </a>
            </Button>
          ) : null}
          <Button
            onClick={run}
            disabled={phase === 'running' || !imageUrl}
            className="gap-1.5 bg-brand hover:bg-brand-hover"
          >
            {phase === 'running' ? <Loader2 size={14} className="animate-spin" />
              : phase === 'ready' ? <RotateCw size={14} />
              : <Sparkles size={14} />}
            {phase === 'running' ? 'Enhancing…'
              : phase === 'ready' ? 'Re-run with new fidelity'
              : 'Enhance'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Image pane — locked aspect, dark background, label chip at the top.
 * Used for both the original and the enhanced side so they line up
 * pixel-for-pixel regardless of content aspect ratio.
 */
function Pane({ label, src, placeholder }) {
  return (
    <div className="relative aspect-square rounded-xl overflow-hidden bg-slate-900 ring-1 ring-line">
      {src ? (
        <img src={src} alt="" className="w-full h-full object-contain" />
      ) : (
        <div className="w-full h-full grid place-items-center text-small text-fg-muted">
          {placeholder ? <Sparkles size={20} className="opacity-40" /> : '—'}
        </div>
      )}
      <span className="absolute top-2 left-2 inline-flex items-center rounded-md bg-black/60 px-2 py-0.5 text-micro font-bold text-white">
        {label}
      </span>
    </div>
  );
}

/**
 * Convert a base64 payload from /ai/enhance into a valid <img src=...>.
 * The upstream pipeline returns a bare base64 string (no data: prefix);
 * we prepend the data URL header. PNG is the upstream's default mime.
 */
function toImgSrc(b64) {
  if (!b64) return null;
  if (b64.startsWith('data:')) return b64;
  return `data:image/png;base64,${b64}`;
}
