/**
 * Compute Cost Estimator — sizes the AI inference fleet across commercial GPUs.
 *
 * Why this exists: the platform has no explicit per-camera cost constant; cost
 * is implicit GPU consumption governed by the pipeline cadence knobs. This page
 * turns those knobs into a live calculator so sales/ops can answer "how many
 * GPUs / what cloud bill for N cameras?" on any commercial card.
 *
 * Calibration: the per-inference times are anchored on a LIVE measurement from
 * this deployment — SCRFD-10G face detection = 44 ms/frame at 960px on the
 * RTX A3000 12GB here (Prometheus vms_detect_latency_seconds: 83.0s / 1878
 * detections, 2026-05-29). The GPU catalog's `perf` factor is throughput
 * RELATIVE to that A3000 (=1.0); e.g. A100 ≈ 6.5× → ~6.8 ms/frame, which lines
 * up with the docs' "~6 ms on Blackwell". Everything here is an editable
 * planning estimate, not a vendor benchmark — TensorRT/DeepStream, model
 * choice and det-size all move the numbers, so the levers are exposed.
 */
import { useMemo, useState } from 'react';
import { Cpu, Server, DollarSign, Camera as CameraIcon, Gauge, Info, Zap } from 'lucide-react';

import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/core/ui/card';

// ── Per-inference cost on the REFERENCE GPU (RTX A3000 12GB, measured here).
// All in milliseconds of GPU time per single inference. Editable assumptions.
const REF = {
  detect960: 44,   // SCRFD-10G @ 960px — MEASURED on this A3000
  adaface:   35,   // AdaFace IR-101 embed — estimate, scaled from detect
  yolo640:   20,   // YOLOv8n person @ 640px — estimate
};

// Commercial GPU catalog. `perf` = inference throughput relative to the A3000
// (=1.0). `usd` = rough on-demand cloud $/hr (editable). `vram` in GB.
const GPUS = [
  { key: 'a3000',    label: 'RTX A3000 12GB (this box · measured)', perf: 1.0,  usd: 0.00, vram: 12 },
  { key: 't4',       label: 'NVIDIA T4 16GB',                       perf: 1.2,  usd: 0.35, vram: 16 },
  { key: 'l4',       label: 'NVIDIA L4 24GB',                       perf: 2.2,  usd: 0.70, vram: 24 },
  { key: 'a10g',     label: 'NVIDIA A10G 24GB',                     perf: 2.8,  usd: 1.00, vram: 24 },
  { key: 'rtx4090',  label: 'RTX 4090 24GB (bare-metal)',           perf: 4.5,  usd: 0.50, vram: 24 },
  { key: 'l40s',     label: 'NVIDIA L40S 48GB',                     perf: 5.5,  usd: 1.80, vram: 48 },
  { key: 'blackwell',label: 'RTX PRO 5000 Blackwell 48GB',          perf: 6.0,  usd: 2.00, vram: 48 },
  { key: 'a100_40',  label: 'NVIDIA A100 40GB',                     perf: 6.5,  usd: 2.50, vram: 40 },
  { key: 'a100_80',  label: 'NVIDIA A100 80GB',                     perf: 7.0,  usd: 3.20, vram: 80 },
  { key: 'h100',     label: 'NVIDIA H100 80GB',                     perf: 13.0, usd: 4.50, vram: 80 },
  { key: 'orin',     label: 'Jetson Orin AGX 64GB (edge · capex)',  perf: 0.5,  usd: 0.00, vram: 64 },
];

// Resident model weights (GB) + per-stream decode/working VRAM (GB). Used for
// the secondary VRAM constraint on cameras-per-GPU.
const VRAM_RESIDENT_GB = 1.6;     // buffalo_l + YOLO + ORT arenas
const VRAM_PER_STREAM_GB = 0.05;  // decode + frame buffers per camera

const DET_SIZES = [320, 640, 960, 1280];
const BAR_COLORS = ['#10b981', '#6366f1', '#F7983A', '#0ea5e9', '#64748b'];

const fmt = (n, d = 0) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '∞';

export default function ComputeCost() {
  const [cameras, setCameras]       = useState(40);
  const [fps, setFps]               = useState(8);
  const [detSize, setDetSize]       = useState(960);
  const [avgPeople, setAvgPeople]   = useState(2);
  const [recognizer, setRecognizer] = useState('arcface'); // arcface | adaface
  const [person, setPerson]         = useState(true);   // matches this deployment
  const [footfall, setFootfall]     = useState(true);
  const [postProc, setPostProc]     = useState(true);   // watchlist + re-id workers
  const [tensorRT, setTensorRT]     = useState(false);
  const [gpuKey, setGpuKey]         = useState('a100_40');
  const [util, setUtil]             = useState(80);
  const [currency, setCurrency]     = useState('INR'); // primary demo audience is India
  const [fx, setFx]                 = useState(86);    // ₹ per US$ — editable; cloud GPUs bill in USD

  const gpu = GPUS.find((g) => g.key === gpuKey) || GPUS[0];

  // Money formatter. The model stays in USD internally (cloud GPUs are priced
  // in USD); we convert to ₹ at the editable rate only at the display layer.
  const fmtCur = (usd, maxFrac = 0) => {
    if (!Number.isFinite(usd)) return '—';
    const v = currency === 'INR' ? usd * fx : usd;
    return v.toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US',
      { style: 'currency', currency, maximumFractionDigits: maxFrac });
  };

  const model = useMemo(() => {
    const trt = tensorRT ? 2.5 : 1;          // TensorRT/DeepStream throughput gain
    const effPerf = gpu.perf * trt;          // effective throughput vs A3000 ref
    const detMs = REF.detect960 * Math.pow(detSize / 960, 2); // det cost ∝ pixels

    // Per-camera GPU time (ms of GPU work per wall-clock second).
    const feats = [];
    feats.push({ name: `Face detection · SCRFD @${detSize}`, ms: (fps * detMs) / effPerf, gpu: true });

    if (recognizer === 'adaface') {
      const embedsPerSec = avgPeople * (fps / 5); // embed_every_n_frames = 5, per track
      feats.push({ name: 'Face embedding · AdaFace', ms: (embedsPerSec * REF.adaface) / effPerf, gpu: true });
    } else {
      feats.push({ name: 'Face embedding · ArcFace (bundled)', ms: 0, gpu: true, note: 'free — returned by the detector' });
    }

    if (person) {
      feats.push({ name: 'Person detection · YOLOv8n @640', ms: ((fps / 2) * REF.yolo640) / effPerf, gpu: true });
    }
    if (footfall) {
      feats.push({ name: 'Footfall counting', ms: 0, gpu: false, note: 'CPU — rides on existing boxes' });
    }
    if (postProc) {
      feats.push({ name: 'Watchlist match + re-ID', ms: 0, gpu: false, note: 'CPU / Qdrant — async per detection' });
    }

    const perCamMs = feats.reduce((a, f) => a + (f.gpu ? f.ms : 0), 0);
    const fleetMs = perCamMs * cameras;
    const u = util / 100;
    const camsPerGpuCompute = perCamMs > 0 ? Math.floor((1000 * u) / perCamMs) : Infinity;
    const camsPerGpuVram = Math.floor((gpu.vram - VRAM_RESIDENT_GB) / VRAM_PER_STREAM_GB);
    const camsPerGpu = Math.min(camsPerGpuCompute, camsPerGpuVram);
    const bound = camsPerGpuVram < camsPerGpuCompute ? 'VRAM' : 'compute';
    const gpusNeeded = perCamMs > 0 ? Math.max(1, Math.ceil(cameras / Math.max(1, camsPerGpu))) : 1;
    const fleetUtilPct = (fleetMs / (1000 * gpusNeeded)) * 100;
    const costMonth = gpusNeeded * gpu.usd * 730;
    const costPerCamMonth = cameras > 0 ? costMonth / cameras : 0;

    return { feats, perCamMs, fleetMs, camsPerGpu, camsPerGpuCompute, camsPerGpuVram, bound, gpusNeeded, fleetUtilPct, costMonth, costPerCamMonth };
  }, [cameras, fps, detSize, avgPeople, recognizer, person, footfall, postProc, tensorRT, gpu, util]);

  const maxBar = Math.max(0.001, ...model.feats.map((f) => (f.gpu ? f.ms : 0)));

  return (
    <div className="mx-auto max-w-6xl page-inset">
      {/* Hero */}
      <div className="mb-5">
        <h1 className="text-title text-fg flex items-center gap-2">
          <Cpu className="text-brand" /> Compute Cost Estimator
        </h1>
        <p className="text-body text-fg-muted mt-1 max-w-3xl">
          Size the AI inference fleet across commercial GPUs. Anchored on a live measurement from this
          box (SCRFD&nbsp;= 44&nbsp;ms/frame on the RTX&nbsp;A3000); every figure is an editable planning
          estimate. Change the knobs to see GPUs needed and the monthly bill move.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
        {/* ── Inputs ────────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-heading">Workload</CardTitle>
            <CardDescription>What you're running, and on what.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <NumberRow label="Cameras" value={cameras} onChange={setCameras} min={1} max={5000} />
            <SliderRow label="Frames / sec per camera" value={fps} onChange={setFps} min={1} max={15} suffix="fps" />

            <div>
              <Label>Detector input size</Label>
              <div className="mt-1 flex gap-1 bg-surface-muted rounded-lg p-0.5">
                {DET_SIZES.map((s) => (
                  <button key={s} onClick={() => setDetSize(s)}
                    className={`flex-1 rounded-md py-1.5 text-small font-bold transition ${detSize === s ? 'bg-surface text-fg shadow-sm' : 'text-fg-secondary hover:text-fg'}`}>
                    {s}px
                  </button>
                ))}
              </div>
              <p className="text-caption text-fg-subtle mt-1">Detection GPU cost scales with pixels² — 640px is ~2.3× cheaper than 960px.</p>
            </div>

            <div>
              <Label>Face recognition backend</Label>
              <div className="mt-1 flex gap-1 bg-surface-muted rounded-lg p-0.5">
                {[['arcface', 'ArcFace (free)'], ['adaface', 'AdaFace (+pass)']].map(([k, lbl]) => (
                  <button key={k} onClick={() => setRecognizer(k)}
                    className={`flex-1 rounded-md py-1.5 text-small font-bold transition ${recognizer === k ? 'bg-surface text-fg shadow-sm' : 'text-fg-secondary hover:text-fg'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {recognizer === 'adaface' && (
              <SliderRow label="Avg people on screen / camera" value={avgPeople} onChange={setAvgPeople} min={0} max={20} suffix="ppl" />
            )}

            <div className="space-y-2 pt-1">
              <Label>Features</Label>
              <Check label="Person detection (YOLOv8n)" checked={person} onChange={setPerson} hint="+GPU per camera" />
              <Check label="Footfall counting" checked={footfall} onChange={setFootfall} hint="CPU only" />
              <Check label="Watchlist + re-ID workers" checked={postProc} onChange={setPostProc} hint="CPU / Qdrant" />
              <Check label="TensorRT / DeepStream" checked={tensorRT} onChange={setTensorRT} hint="~2.5× throughput" />
            </div>

            <div>
              <Label>Target GPU</Label>
              <select value={gpuKey} onChange={(e) => setGpuKey(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-body font-medium text-fg">
                {GPUS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
              <p className="text-caption text-fg-subtle mt-1">
                {gpu.perf}× the A3000 · {gpu.vram} GB · {gpu.usd > 0 ? `${fmtCur(gpu.usd, 2)}/hr` : 'owned / capex'}
              </p>
            </div>

            <SliderRow label="Target GPU utilization" value={util} onChange={setUtil} min={40} max={95} suffix="%" />

            <div>
              <Label>Currency</Label>
              <div className="mt-1 flex items-center gap-2">
                <div className="flex gap-1 bg-surface-muted rounded-lg p-0.5">
                  {['INR', 'USD'].map((c) => (
                    <button key={c} onClick={() => setCurrency(c)}
                      className={`rounded-md px-3 py-1.5 text-small font-bold transition ${currency === c ? 'bg-surface text-fg shadow-sm' : 'text-fg-secondary hover:text-fg'}`}>
                      {c}
                    </button>
                  ))}
                </div>
                {currency === 'INR' && (
                  <label className="flex items-center gap-1 text-small text-fg-muted">
                    ₹
                    <input type="number" value={fx} min={1} max={200}
                      onChange={(e) => setFx(Math.max(1, Number(e.target.value) || 0))}
                      className="w-16 rounded-md border border-line px-2 py-1 text-small font-bold tabular-nums text-fg" />
                    /$
                  </label>
                )}
              </div>
              <p className="text-caption text-fg-subtle mt-1">Cloud GPUs bill in USD; ₹ shown at the editable rate.</p>
            </div>
          </CardContent>
        </Card>

        {/* ── Results ───────────────────────────────────────────── */}
        <div className="space-y-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Tile Icon={Gauge}    color="#10b981" label="GPU load / camera" value={`${fmt(model.perCamMs)} ms/s`} sub={`${fmt(model.perCamMs / 10, 1)}% of 1 GPU-sec`} />
            <Tile Icon={CameraIcon} color="#6366f1" label="Cameras / GPU" value={fmt(model.camsPerGpu)} sub={`${model.bound}-bound`} />
            <Tile Icon={Server}   color="#F7983A" label={`GPUs for ${fmt(cameras)} cams`} value={fmt(model.gpusNeeded)} sub={`${fmt(model.fleetUtilPct)}% utilized`} />
            <Tile Icon={DollarSign} color="#0ea5e9" label="Est. cloud cost" value={gpu.usd > 0 ? `${fmtCur(model.costMonth)}/mo` : 'owned'} sub={gpu.usd > 0 ? `${fmtCur(model.costPerCamMonth)}/cam/mo` : 'capex GPU'} />
          </div>

          {/* Per-feature GPU breakdown */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-heading flex items-center gap-2"><Zap size={16} className="text-brand" /> Per-camera GPU breakdown</CardTitle>
              <CardDescription>Milliseconds of {gpu.label.split(' (')[0]} time per second, per camera{tensorRT ? ' (with TensorRT)' : ''}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {model.feats.map((f, i) => (
                <div key={f.name}>
                  <div className="flex items-baseline justify-between text-small mb-1">
                    <span className="font-medium text-fg-secondary">{f.name}{f.note ? <span className="text-fg-subtle font-normal"> · {f.note}</span> : null}</span>
                    <span className="font-bold tabular-nums text-fg">{f.gpu ? `${fmt(f.ms, 1)} ms/s` : '~0 GPU'}</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${f.gpu ? Math.max(2, (f.ms / maxBar) * 100) : 0}%`, background: BAR_COLORS[i % BAR_COLORS.length] }} />
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-line-subtle pt-3 mt-1">
                <span className="text-body font-bold text-fg">Total GPU / camera</span>
                <span className="text-body font-bold tabular-nums text-brand">{fmt(model.perCamMs)} ms/s</span>
              </div>
            </CardContent>
          </Card>

          {/* Constraints + assumptions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-heading flex items-center gap-2"><Info size={16} className="text-fg-subtle" /> Constraints &amp; assumptions</CardTitle>
            </CardHeader>
            <CardContent className="text-small text-fg-secondary space-y-2">
              <p>
                <b>Cameras per {gpu.label.split(' (')[0]}:</b> {fmt(model.camsPerGpuCompute)} by compute (at {util}% util),
                {' '}{fmt(model.camsPerGpuVram)} by VRAM ({gpu.vram} GB − {VRAM_RESIDENT_GB} GB resident, {VRAM_PER_STREAM_GB * 1000} MB/stream) →
                {' '}<b className="text-fg">{model.bound}-bound at {fmt(model.camsPerGpu)}</b>.
              </p>
              <p>
                <b>Anchor:</b> SCRFD @960 = {REF.detect960} ms/frame measured on the RTX A3000 here. GPU <i>perf</i> factors are
                throughput relative to that (A100 ≈ 6.5× → ~{fmt(REF.detect960 / 6.5, 1)} ms, matching the docs' Blackwell figure).
              </p>
              <p>
                <b>Not in GPU sizing:</b> watchlist match &amp; re-ID run on CPU/Qdrant (~65 ms/detection, async); footfall is CPU-only.
                Decode is CPU by default (PyAV) unless DeepStream HW-decode is on.
              </p>
              <p className="text-fg-subtle">
                All per-inference times, GPU perf factors and $/hr are editable planning estimates, not vendor benchmarks. Calibrate the
                non-detection numbers by reading Prometheus latency histograms once faces/persons are flowing.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Small presentational helpers ───────────────────────────────────────────
function Label({ children }) {
  return <span className="text-small font-bold uppercase tracking-wide text-fg-muted">{children}</span>;
}

function Tile({ Icon, color, label, value, sub }) {
  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="grid place-items-center h-7 w-7 rounded-lg" style={{ background: `${color}1a` }}>
            <Icon size={15} style={{ color }} />
          </span>
          <span className="text-caption font-semibold text-fg-muted leading-tight">{label}</span>
        </div>
        <div className="text-xl font-bold tabular-nums text-fg">{value}</div>
        {sub ? <div className="text-caption text-fg-subtle mt-0.5">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

function NumberRow({ label, value, onChange, min, max }) {
  return (
    <div>
      <Label>{label}</Label>
      <input type="number" value={value} min={min} max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-body font-bold tabular-nums text-fg" />
    </div>
  );
}

function SliderRow({ label, value, onChange, min, max, suffix }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-body font-bold tabular-nums text-fg">{value}{suffix ? ` ${suffix}` : ''}</span>
      </div>
      <input type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-brand" />
    </div>
  );
}

function Check({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="flex items-center gap-2 text-body text-fg-secondary">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-brand h-4 w-4" />
        {label}
      </span>
      {hint ? <span className="text-micro text-fg-subtle">{hint}</span> : null}
    </label>
  );
}
