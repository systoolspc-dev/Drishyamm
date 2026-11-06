import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Coins,
  Cpu,
  Gauge,
  IndianRupee,
  Radio,
  RefreshCw,
  Server,
  Sparkles,
  Video,
  WalletCards,
} from 'lucide-react';
import { useGroups } from '@/core/hooks/useQueries';

import { AI_BASE } from '@/core/config/endpoints';
const POLL_MS = 2000;

// Commercial defaults for Indian SMB/institution pricing.
const VMS_CAMERA_MONTH_INR = 75;
const STORAGE_SOFTWARE_MONTH_INR = 15;
const AI_CAMERA_BASE_MONTH_INR = 150;
const AI_TOKEN_INR = 0.000075;
const GPU_NODE_MONTH_INR = 50000;
const GPU_TOKEN_CAPACITY_PER_SEC = 300; // RTX PRO 5000 72GB target: ~100 cams at 3 FPS.
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmtNumber(value, digits = 0) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function fmtMoney(value) {
  const n = Math.round(Number(value) || 0);
  return `INR ${n.toLocaleString('en-IN')}`;
}

function fmtTokens(value) {
  const n = Number(value) || 0;
  if (n >= 10_000_000) return `${fmtNumber(n / 10_000_000, 2)} Cr`;
  if (n >= 100_000) return `${fmtNumber(n / 100_000, 2)} L`;
  return fmtNumber(n);
}

function cameraTokenRate(camera) {
  return camera.running ? Number(camera.fps || 0) : 0;
}

function cameraMonthlyTokens(camera) {
  return cameraTokenRate(camera) * SECONDS_PER_MONTH;
}

function cameraAiPrice(camera) {
  if (!camera.running) return 0;
  return AI_CAMERA_BASE_MONTH_INR + cameraMonthlyTokens(camera) * AI_TOKEN_INR;
}

function cameraLoad(camera) {
  const fpsLoad = clamp((cameraTokenRate(camera) / 5) * 55, 0, 55);
  const faceLoad = clamp(Number(camera.persons || 0) * 3, 0, 30);
  const activeLoad = camera.running ? 10 : 0;
  return Math.round(clamp(fpsLoad + faceLoad + activeLoad, 0, 100));
}

function loadColor(load) {
  if (load >= 75) return '#ef4444';
  if (load >= 45) return '#f59e0b';
  return '#10b981';
}

function statusText(camera) {
  if (camera.error) return 'Needs attention';
  if (camera.running) return 'AI active';
  if (camera.source) return 'AI paused';
  return 'VMS only';
}

function SummaryCard({ icon: Icon, label, value, note, accent = '#F7983A' }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption font-bold uppercase tracking-wider text-fg-muted">{label}</p>
          <p className="mt-2 truncate text-2xl font-bold tabular-nums text-fg">{value}</p>
          {note ? <p className="mt-1 truncate text-small font-medium text-fg-muted">{note}</p> : null}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}18`, color: accent }}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function PriceLine({ label, value, note }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line-subtle py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-body font-bold text-fg">{label}</p>
        {note ? <p className="mt-0.5 text-small leading-relaxed text-fg-muted">{note}</p> : null}
      </div>
      <p className="shrink-0 text-body font-bold tabular-nums text-fg">{value}</p>
    </div>
  );
}

function CameraTokenRow({ item }) {
  const load = cameraLoad(item);
  const color = loadColor(load);
  const tokensPerMinute = cameraTokenRate(item) * 60;
  const monthlyTokens = cameraMonthlyTokens(item);
  const aiPrice = cameraAiPrice(item);
  const totalPrice = VMS_CAMERA_MONTH_INR + STORAGE_SOFTWARE_MONTH_INR + aiPrice;

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(190px,1.2fr)_110px_150px_150px_150px] xl:items-center">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${item.running ? 'bg-success' : item.error ? 'bg-danger' : 'bg-line-strong'}`} />
            <p className="truncate text-body font-bold text-fg">{item.name}</p>
          </div>
          <p className="mt-1 truncate text-caption font-medium text-fg-muted">
            {item.groupName || 'Camera'}{item.channel != null ? ` / CH ${item.channel}` : ''}
          </p>
        </div>

        <div>
          <p className="text-micro font-bold uppercase tracking-wider text-fg-muted">Status</p>
          <p className={`mt-1 text-body font-bold ${item.running ? 'text-success-ink' : item.error ? 'text-danger-ink' : 'text-fg-muted'}`}>
            {statusText(item)}
          </p>
        </div>

        <div>
          <p className="text-micro font-bold uppercase tracking-wider text-fg-muted">Tokens / min</p>
          <p className="mt-1 text-body font-bold tabular-nums text-fg">{fmtTokens(tokensPerMinute)}</p>
        </div>

        <div>
          <p className="text-micro font-bold uppercase tracking-wider text-fg-muted">Monthly AI tokens</p>
          <p className="mt-1 text-body font-bold tabular-nums text-fg">{fmtTokens(monthlyTokens)}</p>
        </div>

        <div>
          <p className="text-micro font-bold uppercase tracking-wider text-fg-muted">Monthly price</p>
          <p className="mt-1 text-body font-bold tabular-nums text-fg">{fmtMoney(totalPrice)}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 border-t border-line-subtle pt-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${load}%`, backgroundColor: color }} />
        </div>
        <p className="w-14 text-right text-small font-bold tabular-nums" style={{ color }}>{load}%</p>
      </div>
    </div>
  );
}

export default function ComputeMonitor() {
  const { data: groups = [] } = useGroups({ refetchInterval: 30000 });
  const [aiStatus, setAiStatus] = useState(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStatus = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${AI_BASE}/status`);
      if (!res.ok) throw new Error(`AI status ${res.status}`);
      const data = await res.json();
      setAiStatus(data);
      setError('');
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || 'AI service unavailable');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const cameras = groups.flatMap((group) =>
      (group.cameras || []).map((camera) => ({
        ...camera,
        groupName: group.name,
      })),
    );
    const aiCameras = aiStatus?.cameras || {};
    const seen = new Set();

    const merged = cameras.map((camera) => {
      const monitorId = camera.monitorId;
      const runtime = aiCameras[monitorId] || {};
      if (monitorId) seen.add(monitorId);
      return {
        name: camera.name || monitorId || 'Camera',
        monitorId,
        channel: camera.channel,
        groupName: camera.groupName,
        running: runtime.running === true,
        source: runtime.source || '',
        fps: runtime.fps || 0,
        persons: runtime.persons || 0,
        frames: runtime.frames || 0,
        error: runtime.error || '',
      };
    });

    Object.entries(aiCameras).forEach(([cameraId, runtime]) => {
      if (seen.has(cameraId)) return;
      merged.push({
        name: cameraId,
        monitorId: cameraId,
        running: runtime.running === true,
        source: runtime.source || '',
        fps: runtime.fps || 0,
        persons: runtime.persons || 0,
        frames: runtime.frames || 0,
        error: runtime.error || '',
      });
    });

    return merged.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return cameraMonthlyTokens(b) - cameraMonthlyTokens(a);
    });
  }, [groups, aiStatus]);

  const totals = useMemo(() => {
    const totalCameras = rows.length;
    const activeAi = rows.filter((row) => row.running).length;
    const tokenPerSec = rows.reduce((sum, row) => sum + cameraTokenRate(row), 0);
    const tokensThisSession = rows.reduce((sum, row) => sum + Number(row.frames || 0), 0);
    const monthlyAiTokens = rows.reduce((sum, row) => sum + cameraMonthlyTokens(row), 0);
    const platformMonthly = totalCameras * (VMS_CAMERA_MONTH_INR + STORAGE_SOFTWARE_MONTH_INR);
    const aiMonthly = rows.reduce((sum, row) => sum + cameraAiPrice(row), 0);
    const gpuNodes = tokenPerSec > 0 ? Math.max(1, Math.ceil(tokenPerSec / GPU_TOKEN_CAPACITY_PER_SEC)) : 0;
    const gpuCost = gpuNodes * GPU_NODE_MONTH_INR;
    const customerMonthly = platformMonthly + aiMonthly;
    const internalMonthly = gpuCost;
    const capacityUsed = tokenPerSec > 0 ? clamp(Math.round((tokenPerSec / (gpuNodes * GPU_TOKEN_CAPACITY_PER_SEC)) * 100), 0, 100) : 0;

    return {
      totalCameras,
      activeAi,
      tokenPerSec,
      tokensThisSession,
      monthlyAiTokens,
      platformMonthly,
      aiMonthly,
      gpuNodes,
      gpuCost,
      customerMonthly,
      internalMonthly,
      capacityUsed,
    };
  }, [rows]);

  const detecting = aiStatus?.detecting === true || totals.activeAi > 0;
  const activeRows = rows.filter((row) => row.running || row.error);
  const inactiveRows = rows.filter((row) => !row.running && !row.error);
  const displayRows = [...activeRows, ...inactiveRows];

  return (
    <div className="h-[calc(var(--app-vh)-4rem)] overflow-hidden bg-surface-app px-6 py-6 text-fg">
      <main className="flex h-full min-h-0 flex-col gap-5">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-brand/30 bg-brand/10 text-brand">
              <Cpu className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-title text-fg">Compute & Pricing</h1>
              <p className="mt-1 text-body text-fg-muted">
                Simple token view: 1 AI token = 1 video frame checked by AI.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className={`flex h-10 items-center gap-2 rounded-lg border px-3 text-small font-bold ${
              detecting ? 'border-success-line bg-success-soft text-success-ink' : 'border-line bg-surface text-fg-muted'
            }`}>
              <Radio className="h-3.5 w-3.5" />
              {detecting ? 'AI billing active' : 'No AI billing'}
            </div>
            <button
              type="button"
              onClick={fetchStatus}
              className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-bold text-fg-secondary transition hover:bg-surface-sunken"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </header>

        {error ? (
          <div className="shrink-0 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 text-body font-semibold text-danger-ink">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          </div>
        ) : null}

        <section className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-5">
          <SummaryCard icon={Video} label="Total cameras" value={totals.totalCameras} note="VMS software billing" accent="#3b82f6" />
          <SummaryCard icon={Sparkles} label="AI cameras now" value={totals.activeAi} note="Only active AI cameras use tokens" accent="#10b981" />
          <SummaryCard icon={Coins} label="Tokens used" value={fmtTokens(totals.tokensThisSession)} note="Current AI session" accent="#F7983A" />
          <SummaryCard icon={Gauge} label="Token speed" value={`${fmtNumber(totals.tokenPerSec, 1)}/sec`} note={`${fmtTokens(totals.monthlyAiTokens)} monthly projection`} accent="#8b5cf6" />
          <SummaryCard icon={Server} label="GPU capacity" value={`${totals.capacityUsed}%`} note={`${totals.gpuNodes || 0} RTX PRO 5000 node(s)`} accent={loadColor(totals.capacityUsed)} />
        </section>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden xl:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-4 overflow-hidden">
            <div className="shrink-0 rounded-xl border border-line bg-surface p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <WalletCards className="h-4 w-4 text-brand" />
                <h2 className="text-body font-bold text-fg">Customer monthly quote</h2>
              </div>
              <PriceLine
                label="VMS software"
                value={fmtMoney(totals.platformMonthly)}
                note={`${totals.totalCameras} cameras x INR ${VMS_CAMERA_MONTH_INR + STORAGE_SOFTWARE_MONTH_INR}/month`}
              />
              <PriceLine
                label="AI token add-on"
                value={fmtMoney(totals.aiMonthly)}
                note={`INR ${AI_CAMERA_BASE_MONTH_INR}/AI camera + INR ${AI_TOKEN_INR}/token`}
              />
              <PriceLine
                label="Suggested software bill"
                value={fmtMoney(totals.customerMonthly)}
                note="This excludes camera hardware and raw storage disks."
              />
            </div>

            <div className="shrink-0 rounded-xl border border-line bg-surface p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Calculator className="h-4 w-4 text-brand" />
                <h2 className="text-body font-bold text-fg">Your compute cost view</h2>
              </div>
              <PriceLine
                label="Local GPU node budget"
                value={fmtMoney(totals.gpuCost)}
                note={`${totals.gpuNodes || 0} node(s) x INR ${fmtNumber(GPU_NODE_MONTH_INR)}/month internal cost`}
              />
              <PriceLine
                label="Estimated gross margin"
                value={fmtMoney(totals.customerMonthly - totals.internalMonthly)}
                note="Before support team, sales, tax, and data center storage."
              />
            </div>

            <div className="min-h-0 flex-1 rounded-xl border border-line bg-surface p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <IndianRupee className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-body font-bold text-fg">How to explain it</h2>
                  <p className="mt-2 text-body leading-relaxed text-fg-secondary">
                    Every time AI checks one video frame, it spends one token. Normal live view does not spend AI tokens.
                    More AI cameras or higher FPS means more tokens and a higher bill.
                  </p>
                  <p className="mt-3 text-small font-semibold text-fg-muted">
                    Updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '--'}
                  </p>
                </div>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            <div className="shrink-0 border-b border-line px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-body font-bold text-fg">Camera token bill</h2>
                  <p className="mt-0.5 text-small text-fg-muted">Per-camera token usage and monthly estimate.</p>
                </div>
                <div className="rounded-lg bg-surface-sunken px-3 py-1.5 text-small font-bold text-fg-secondary">
                  {totals.activeAi} active AI
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {displayRows.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-line p-8 text-center">
                  <CheckCircle2 className="h-8 w-8 text-fg-disabled" />
                  <p className="mt-3 text-body font-bold text-fg-secondary">No cameras available</p>
                  <p className="mt-1 text-small text-fg-muted">Create a camera group before monitoring compute pricing.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {displayRows.map((item) => (
                    <CameraTokenRow key={item.monitorId || item.name} item={item} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
