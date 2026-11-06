import { useEffect, useRef, useState } from 'react';
import {
  Gauge, Activity, Zap, AlertTriangle, RefreshCw, KeySquare, Eye, ShieldCheck,
  Sparkles,
} from 'lucide-react';
import api from '@/core/services/api';

/**
 * StreamHealthPanel â€” operator-facing live view of one camera's stream health.
 *
 * Polls /api/cameras/<monitorId>/quality every 2 s for:
 *   - supervisor state machine value (streaming / connecting / degraded / offline / quarantined)
 *   - bps_in           â€” ingress bitrate in bits/sec (we render kbps / Mbps)
 *   - jitterMs         â€” proxy for inter-frame arrival jitter
 *   - fieRate          â€” frames-in-error per second (corrupt RTP indicator)
 *   - readers          â€” count of WebRTC + HLS clients currently watching
 *   - healsToday       â€” heal attempts in the last 24 h (budget = 20)
 *
 * Two action buttons:
 *   Heal      â€” POST /api/cameras/<id>/heal     â€” force-reconnect path
 *   Keyframe  â€” POST /api/cameras/<id>/keyframe â€” request a fresh IDR via PLI
 *
 * Both share a 60 s server-side cooldown; we mirror that locally so the buttons
 * disable themselves immediately after a click and re-enable when the cooldown
 * elapses, even if the user navigates away and back.
 */

const STATE_STYLES = {
  streaming:   { color: '#10b981', bg: 'bg-success-soft',  border: 'border-success-line', text: 'text-success-ink', label: 'Streaming' },
  degraded:    { color: '#f59e0b', bg: 'bg-warning-soft',    border: 'border-warning-line',   text: 'text-warning-ink',   label: 'Degraded' },
  connecting:  { color: '#0ea5e9', bg: 'bg-info-soft',      border: 'border-info-line',     text: 'text-info-ink',     label: 'Connecting' },
  pending:     { color: '#6366f1', bg: 'bg-info-soft',   border: 'border-info-line',  text: 'text-info-ink',  label: 'Pending' },
  offline:     { color: '#94a3b8', bg: 'bg-surface-sunken',    border: 'border-line',   text: 'text-fg-secondary',   label: 'Offline' },
  quarantined: { color: '#ef4444', bg: 'bg-danger-soft',     border: 'border-danger-line',    text: 'text-danger-ink',    label: 'Quarantined' },
};

function fmtBps(bps) {
  const n = Number(bps) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mbps`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)} kbps`;
  return `${n} bps`;
}

function fmtJitter(ms) {
  const n = Number(ms) || 0;
  if (n < 100)  return `${n} ms`;
  if (n < 500)  return `${n} ms`;
  return `${n} ms`;
}

function jitterColor(ms) {
  const n = Number(ms) || 0;
  if (n < 80)  return 'text-success-ink';
  if (n < 200) return 'text-warning-ink';
  return 'text-danger-ink';
}

function fieColor(rate) {
  const n = Number(rate) || 0;
  if (n === 0) return 'text-success-ink';
  if (n < 5)   return 'text-warning-ink';
  return 'text-danger-ink';
}

function relTime(ts) {
  if (!ts) return 'â€”';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60)    return `${Math.floor(d)} s ago`;
  if (d < 3600)  return `${Math.floor(d / 60)} m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

// â”€â”€ Single metric tile (small, dense) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function MetricTile({ icon: Icon, label, value, valueClass = 'text-fg', accent = '#F7983A', sub }) {
  return (
    <div className="bg-surface border border-line rounded-lg px-3 py-2.5 flex items-center gap-2.5 shadow-sm">
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${accent}1a`, color: accent }}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-heading font-bold tabular-nums leading-none ${valueClass}`}>{value}</p>
        <p className="text-micro uppercase tracking-wider font-semibold text-fg-muted mt-1">{label}</p>
        {sub ? <p className="text-micro text-fg-subtle mt-0.5 truncate">{sub}</p> : null}
      </div>
    </div>
  );
}

// â”€â”€ Main panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `groupId` is optional â€” needed only for the Quality Boost action which
// has to write to the camera's encoder via the camera-group routes.
export default function StreamHealthPanel({ monitorId, groupId, hideHeader = false, boostOnly = false }) {
  const [data, setData]     = useState(null);
  const [error, setError]   = useState(null);
  const [healing, setHeal]  = useState({ busy: false, kind: null });
  const [toast, setToast]   = useState(null);          // { ok, msg, kind }
  const [boosting, setBoosting] = useState(false);
  const cooldownUntilRef    = useRef(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);

  // Poll quality endpoint every 2 s (supervisor tick is 2 s on the server)
  useEffect(() => {
    if (!monitorId) return undefined;
    let alive = true;
    const fetchOne = async () => {
      try {
        const r = await api.get(`/cameras/${monitorId}/quality`);
        if (alive) { setData(r.data); setError(null); }
      } catch (err) {
        if (alive) setError(err.response?.data?.message || err.message || 'Failed to load quality');
      }
    };
    fetchOne();
    const t = setInterval(fetchOne, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [monitorId]);

  // Local cooldown ticker â€” drives button disabled state without re-poll
  useEffect(() => {
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((cooldownUntilRef.current - Date.now()) / 1000));
      setCooldownLeft(left);
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Push a sharper encoder profile to the camera. Targets 8 Mbps, 1s GOP, 25fps:
  // a stronger face-recognition profile for CCTV crops. The change is server-side at the camera, so
  // every viewer of this stream benefits, not just this tab.
  async function boostQuality() {
    // Fall back to groupId returned by /quality if the parent didn't pass one
    // (LiveView's selectedCamera object can lack groupId in some code paths).
    const effectiveGroupId = groupId || data?.groupId;
    if (!effectiveGroupId || !monitorId) {
      setToast({ ok: false, msg: 'Cannot boost: camera group not resolved yet', kind: 'boost' });
      return;
    }
    setBoosting(true);
    setToast(null);
    try {
      const r = await api.post(`/groups/${effectiveGroupId}/cameras/${monitorId}/encoder`, {
        bitrateKbps: 8192,
        gopSec: 1,
        fps: 25,
      });
      if (r.data?.success) {
        setToast({
          ok: true,
          msg: `Face-quality profile applied - ${r.data.edits || 0} fields written. Stream may briefly reconnect.`,
          kind: 'boost',
        });
      } else {
        // Surface the diagnostic hint when present so the operator can copy
        // it back to support â€” that's the fastest path to firmware-specific
        // schema fixes.
        const parts = [];
        if (r.data?.error) parts.push(r.data.error);
        if (r.data?.hint)  parts.push(r.data.hint);
        if (r.data?.deviceResponse) parts.push(`device said: ${r.data.deviceResponse}`);
        setToast({
          ok: false,
          msg: `Boost refused - ${parts.join(' - ') || 'unknown'}`,
          kind: 'boost',
        });
      }
    } catch (err) {
      // 502 from our backend often wraps a 4xx from the camera firmware
      // ("Invalid XML Content" on Hikvision, etc.). The raw axios message
      // ("Request failed with status code 502") tells the operator nothing —
      // surface the device's own reply so it's actionable. Mirror the
      // success=false branch above so both paths read consistently.
      const data = err.response?.data || {};
      const parts = [];
      if (data.error) parts.push(data.error);
      if (data.hint) parts.push(data.hint);
      if (data.deviceResponse) parts.push(`device said: ${data.deviceResponse}`);
      if (data.status && data.status !== 502) parts.push(`device HTTP ${data.status}`);
      if (parts.length === 0) parts.push(err.message);
      setToast({ ok: false, msg: `Boost failed - ${parts.join(' - ')}`, kind: 'boost' });
    } finally {
      setBoosting(false);
      // Keep the toast on screen longer when it's a failure with diagnostic
      // info â€” these messages are designed to be copy-pasted to support.
      setTimeout(() => setToast(null), 30_000);
    }
  }

  async function trigger(kind) {
    if (!monitorId) return;
    setHeal({ busy: true, kind });
    setToast(null);
    try {
      const path = kind === 'keyframe' ? 'keyframe' : 'heal';
      const r = await api.post(`/cameras/${monitorId}/${path}`);
      if (r.data?.success) {
        cooldownUntilRef.current = Date.now() + 60_000;          // mirror server cooldown
        setToast({ ok: true, msg: kind === 'keyframe' ? 'Keyframe requested' : 'Heal sent', kind });
      } else {
        setToast({ ok: false, msg: `Refused: ${r.data?.reason || 'unknown'}`, kind });
        if (r.data?.reason === 'cooldown') {
          // Server is still in cooldown from a prior heal; estimate ~60 s left
          cooldownUntilRef.current = Date.now() + 30_000;
        }
      }
    } catch (err) {
      const reason = err.response?.data?.reason || err.response?.data?.message || err.message;
      setToast({ ok: false, msg: `Failed: ${reason}`, kind });
    } finally {
      setHeal({ busy: false, kind: null });
      setTimeout(() => setToast(null), 4000);
    }
  }

  const sup = data?.supervisor;
  const q   = data?.quality;
  const stateKey = (sup?.state || 'pending').toLowerCase();
  const style    = STATE_STYLES[stateKey] || STATE_STYLES.pending;
  const cooldown = cooldownLeft > 0;

  // The actual ingress bps from the camera. < 1.5 Mbps for 1080p means the
  // camera's encoder is set too low â†’ blurry video regardless of network speed.
  const liveBps = sup?.bpsIn ?? q?.meanBps ?? 0;
  const lowBitrate = liveBps > 0 && liveBps < 1_500_000;
  const bitrateValueClass = lowBitrate ? 'text-danger-ink' : 'text-fg';
  const bitrateSub = lowBitrate
    ? 'Low â€” camera encoder is the bottleneck'
    : (q?.meanBps ? `60 s avg ${fmtBps(q.meanBps)}` : null);

  if (boostOnly) {
    return (
      <section className={hideHeader ? 'p-4' : 'bg-surface border border-line rounded-2xl p-4 shadow-sm'}>
        <div className="flex items-center gap-2 flex-wrap">
          {(groupId || data?.groupId) ? (
            <button
              type="button"
              onClick={boostQuality}
              disabled={!monitorId || boosting}
              className={`flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-body font-bold text-white transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${
                lowBitrate ? 'bg-brand hover:bg-brand-hover' : 'bg-slate-700 hover:bg-slate-800'
              }`}
              title="Push 8 Mbps / 1s GOP / 25fps to the camera encoder for clearer face crops."
            >
              <Sparkles className={`w-3.5 h-3.5 ${boosting ? 'animate-pulse' : ''}`} />
              {boosting ? 'Boosting...' : 'Face Quality'}
            </button>
          ) : (
            <button
              type="button"
              disabled
              className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-line-strong text-body font-bold text-white opacity-60 cursor-not-allowed"
              title="Camera group is required before quality can be boosted"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Face Quality
            </button>
          )}

          {toast ? (
            <div className={`basis-full mt-2 text-caption font-medium flex items-start gap-2 px-3 py-2 rounded-md select-text ${
              toast.ok
                ? 'bg-success-soft border border-success-line text-success-ink'
                : 'bg-danger-soft border border-danger-line text-danger-ink'
            }`}>
              <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="break-all whitespace-pre-wrap leading-relaxed">{toast.msg}</span>
            </div>
          ) : null}

          {error ? (
            <p className="basis-full text-caption text-danger-ink font-medium">{error}</p>
          ) : null}
        </div>
      </section>
    );
  }
  return (
    <section className={hideHeader ? 'p-4' : 'bg-surface border border-line rounded-2xl p-4 shadow-sm'}>
      {/* â”€â”€ Header â”€â”€ */}
      {!hideHeader ? (
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-brand/10">
            <ShieldCheck className="w-4 h-4" style={{ color: '#F7983A' }} />
          </div>
          <div>
            <p className="text-body font-bold text-fg leading-tight">Stream Health</p>
            <p className="text-caption text-fg-muted leading-tight mt-0.5">
              Live supervisor + transport telemetry - refreshes every 2 s
            </p>
          </div>
        </div>

        {/* State badge */}
        <div className={`flex items-center gap-2 h-9 px-3 rounded-lg border text-small font-semibold ${style.bg} ${style.border} ${style.text}`}>
          <span
            className={`w-1.5 h-1.5 rounded-full ${stateKey === 'streaming' ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: style.color }}
          />
          {style.label}
          {sup?.flapCount != null && sup.flapCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded text-micro font-mono bg-white/60 dark:bg-white/10 tabular-nums">
              flaps {sup.flapCount}
            </span>
          )}
        </div>
      </div>
      ) : null}

      {/* â”€â”€ Metrics row â”€â”€ */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <MetricTile
          icon={Gauge}
          label="Bitrate in"
          value={fmtBps(liveBps)}
          valueClass={bitrateValueClass}
          accent={lowBitrate ? '#ef4444' : '#F7983A'}
          sub={bitrateSub}
        />
        <MetricTile
          icon={Activity}
          label="Jitter"
          value={fmtJitter(q?.jitterMs)}
          valueClass={jitterColor(q?.jitterMs)}
          accent="#3b82f6"
          sub={q?.jitterMs >= 200 ? 'High â€” stalls likely' : null}
        />
        <MetricTile
          icon={AlertTriangle}
          label="Frames in error"
          value={`${q?.fieRate ?? 0}/s`}
          valueClass={fieColor(q?.fieRate)}
          accent="#ef4444"
          sub={q?.fieRate >= 50 ? 'Auto-heal threshold' : null}
        />
        <MetricTile
          icon={Eye}
          label="Live viewers"
          value={q?.readers ?? 0}
          accent="#10b981"
          sub={q?.healsToday ? `${q.healsToday}/20 heals today` : null}
        />
      </div>

      {/* â”€â”€ Action row â”€â”€ */}
      <div className="mt-3 pt-3 border-t border-line flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => trigger('heal')}
          disabled={!monitorId || healing.busy || cooldown}
          className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-surface border border-line hover:border-line-strong hover:bg-surface-sunken text-body font-semibold text-fg-secondary transition disabled:opacity-40 disabled:cursor-not-allowed"
          title="Force MediaMTX to drop and re-establish the upstream RTSP"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${healing.busy && healing.kind === 'heal' ? 'animate-spin' : ''}`} />
          {healing.busy && healing.kind === 'heal' ? 'Healingâ€¦' : 'Force Reconnect'}
        </button>

        <button
          type="button"
          onClick={() => trigger('keyframe')}
          disabled={!monitorId || healing.busy || cooldown}
          className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-surface border border-line hover:border-line-strong hover:bg-surface-sunken text-body font-semibold text-fg-secondary transition disabled:opacity-40 disabled:cursor-not-allowed"
          title="Request a fresh keyframe via PLI (clears frozen-frame artefacts)"
        >
          <KeySquare className={`w-3.5 h-3.5 ${healing.busy && healing.kind === 'keyframe' ? 'animate-spin' : ''}`} />
          {healing.busy && healing.kind === 'keyframe' ? 'Requestingâ€¦' : 'Request Keyframe'}
        </button>

        {(groupId || data?.groupId) ? (
          <button
            type="button"
            onClick={boostQuality}
            disabled={!monitorId || boosting}
            className={`flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-body font-bold text-white transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${
              lowBitrate ? 'bg-brand hover:bg-brand-hover' : 'bg-slate-700 hover:bg-slate-800'
            }`}
            title="Push 8 Mbps / 1s GOP / 25fps to the camera encoder for clearer face crops."
          >
            <Sparkles className={`w-3.5 h-3.5 ${boosting ? 'animate-pulse' : ''}`} />
            {boosting ? 'Boosting...' : 'Face Quality'}
          </button>
        ) : null}

        {cooldown ? (
          <span className="text-caption text-fg-muted font-mono ml-1 tabular-nums">
            cooldown {cooldownLeft}s
          </span>
        ) : null}

        {toast ? (
          <div className={`ml-auto basis-full mt-2 text-caption font-medium flex items-start gap-2 px-3 py-2 rounded-md select-text ${
            toast.ok
              ? 'bg-success-soft border border-success-line text-success-ink'
              : 'bg-danger-soft  border border-danger-line  text-danger-ink'
          }`}>
            <Zap className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-all whitespace-pre-wrap leading-relaxed">{toast.msg}</span>
          </div>
        ) : sup?.enteredStateAt ? (
          <span className="ml-auto text-caption text-fg-muted font-mono">
            in {style.label.toLowerCase()} since {relTime(sup.enteredStateAt)}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 text-caption text-danger-ink font-medium">{error}</p>
      ) : null}
    </section>
  );
}

