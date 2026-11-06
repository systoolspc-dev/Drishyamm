/**
 * Zone Breaches — /occupancy/breaches
 *
 * The durable half of the pair. Zone Setup's breach log is what is happening
 * in the zone you have open, derived from the live detection feed and gone on
 * reload. This is everything the platform has recorded, across every zone,
 * since before you opened the tab.
 *
 * Source is the events feed — `GET /ai/events?since&until` — filtered to the
 * types that describe someone being somewhere they should not be: a zone
 * intrusion, an unrecognised face, loitering, and a watchlist hit. That filter
 * is the whole page: the AI Alerts page already shows everything, and an
 * operator answering "who got into a restricted area this week" does not want
 * camera-offline notices in the same list.
 *
 * Controls: zone, camera (the zone-mapped cameras), a date range with an
 * optional shift, and Breach Trends — the peak hours and most-violated cameras
 * over the same rows. Each row carries its camera badge (hover for the
 * snapshot, click for the full frame with the detection box) and its actions:
 * Acknowledge (the server's ack), Mark Resolved, and Export Clip (the NVR
 * recording around the breach, as MP4).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3, BellRing, Filter, MapPin, RefreshCw, Search, ShieldCheck, ShieldX, TriangleAlert, X,
} from 'lucide-react';
import {
  OperationsPage, PageHeader, PageContent, PageAction,
} from '@/core/layout/OperationsPage';
import {
  Select as SelectRoot,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/core/ui/select';
import Panel from '@/core/ui/panel';
import { aiService, describe } from '@/core/services/ai';
import { playbackService } from '@/core/services/playback';
import { useGroups } from '@/core/hooks/useQueries';
import { useAuthStore } from '@/core/store/authStore';
import { loadRooms } from '../room-settings';
import {
  STATUSES, clipWindow, inShift, loadResolutions, rangeWindow, saveResolution, statusOf,
} from './breach-model';
import BreachRangePicker from './BreachRangePicker';
import BreachTrends from './BreachTrends';
import { BreachActions, BreachDetailDialog, CameraBadge } from './BreachSnapshot';

// The event types that mean "someone was somewhere they should not be".
// Everything else the feed carries — vehicles, camera health, plain entries —
// belongs on AI Alerts, not here.
const BREACH_TYPES = new Set([
  'zone.intrusion', 'person.unknown', 'loitering', 'person.alert', 'alert', 'unknown',
]);

const SEVERITIES = [
  { id: 'all', label: 'All severity' },
  { id: 'critical', label: 'Critical' },
  { id: 'warn', label: 'Warning' },
  { id: 'info', label: 'Info' },
];

const TONE = {
  critical: { chip: 'bg-danger-soft text-danger-ink ring-danger-line', Icon: ShieldX },
  warn: { chip: 'bg-warning-soft text-warning-ink ring-warning-line', Icon: TriangleAlert },
  info: { chip: 'bg-info-soft text-info-ink ring-info-line', Icon: BellRing },
  good: { chip: 'bg-success-soft text-success-ink ring-success-line', Icon: ShieldCheck },
  neutral: { chip: 'bg-surface-muted text-fg-muted ring-line', Icon: BellRing },
};

const STATUS_CHIP = {
  open: 'bg-danger-soft text-danger-ink ring-danger-line',
  acknowledged: 'bg-warning-soft text-warning-ink ring-warning-line',
  resolved: 'bg-success-soft text-success-ink ring-success-line',
};

const fmtWhen = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
  ? d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

const iso = (ms) => new Date(ms).toISOString();

export default function ZoneBreaches() {
  const { data: groups = [] } = useGroups({ refetchInterval: 60_000 });
  const user = useAuthStore((s) => s.user);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // { id, action: 'ack' | 'resolve' | 'clip' }
  const [acked, setAcked] = useState(() => new Set());
  const [resolved, setResolved] = useState(loadResolutions);
  const [openRowId, setOpenRowId] = useState(null);
  const [showTrends, setShowTrends] = useState(false);

  const [sev, setSev] = useState('all');
  const [status, setStatus] = useState('all');
  const [zone, setZone] = useState('all');
  const [cameraId, setCameraId] = useState('all');
  const [range, setRange] = useState({ preset: 'today', shift: 'all' });
  const [query, setQuery] = useState('');

  // The request window. Recomputed when the range changes, not every render,
  // so "Today" does not refetch on each keystroke in the search box.
  const window_ = useMemo(() => rangeWindow(range), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { since: iso(window_.since), limit: 500 };
      if (window_.until) params.until = iso(window_.until);
      const res = await aiService.listEvents(params);
      const list = Array.isArray(res) ? res
        : Array.isArray(res?.data) ? res.data
          : Array.isArray(res?.events) ? res.events
            : Array.isArray(res?.items) ? res.items : [];
      setEvents(list);
      setError(null);
    } catch (err) {
      setError(err?.response?.status === 401
        ? 'Session expired — log in again.'
        : 'Could not reach the events service.');
    } finally {
      setLoading(false);
    }
  }, [window_]);

  useEffect(() => { load(); }, [load]);

  // monitorId -> camera, so `describe` can name the camera rather than print a
  // hex id no operator can find on a floor plan.
  const cameras = useMemo(() => {
    const out = {};
    for (const g of groups) {
      for (const c of g.cameras || []) out[c.monitorId] = { name: c.name, groupName: g.name };
    }
    return out;
  }, [groups]);

  // The zones an operator configured in Zone Setup, and the cameras they sit
  // on. Breach events carry a camera and not always a zone, so a row without
  // one takes the zone(s) configured on its camera.
  const { zoneNames, zonesByCamera } = useMemo(() => {
    const byCamera = new Map();
    for (const r of Object.values(loadRooms())) {
      if (!r?.monitorId) continue;
      byCamera.set(r.monitorId, [...(byCamera.get(r.monitorId) || []), r.name || 'Unnamed zone']);
    }
    const names = [...new Set([...byCamera.values()].flat())].sort((a, b) => a.localeCompare(b));
    return { zoneNames: names, zonesByCamera: byCamera };
  }, []);

  const cameraName = useCallback((id) => cameras[id]?.name || (id ? 'Unnamed camera' : 'Unknown camera'), [cameras]);

  // Camera filter: the zone-mapped cameras — only those of the chosen zone
  // once a zone is picked.
  const cameraOptions = useMemo(() => [...zonesByCamera.entries()]
    .filter(([, names]) => zone === 'all' || names.includes(zone))
    .map(([id]) => ({ id, label: cameraName(id) }))
    .sort((a, b) => a.label.localeCompare(b.label)), [zonesByCamera, zone, cameraName]);

  useEffect(() => {
    if (cameraId !== 'all' && !cameraOptions.some((c) => c.id === cameraId)) setCameraId('all');
  }, [cameraOptions, cameraId]);

  // Every breach in the window, before the operator's filters: what the
  // status counts and the trends read.
  const breaches = useMemo(() => events
    .filter((e) => BREACH_TYPES.has(e.eventType || e.kind || e.action || ''))
    .map((e) => {
      const d = describe(e, cameras);
      const id = e.id || e._id || `${e.monitorId}-${e.ts || e.timestamp}`;
      const monitorId = e.monitorId || e.camera_code || e.camera_id || '';
      const explicitZone = e.payload?.zoneName || e.zoneName || null;
      const zones = explicitZone ? [explicitZone] : (zonesByCamera.get(monitorId) || []);
      const rowStatus = statusOf({ ...e, id }, { acked, resolved });
      return {
        id,
        raw: e,
        subject: d.subject,
        nounWhen: d.nounWhen,
        tone: d.tone,
        when: d.when,
        confidencePct: d.confidencePct,
        monitorId,
        cameraName: cameraName(monitorId),
        zones,
        zoneName: zones.length ? zones.join(' / ') : null,
        status: rowStatus,
        resolution: resolved[id] || null,
      };
    })
    .filter((r) => inShift(r.when.getTime(), range.shift)), [events, cameras, cameraName, zonesByCamera, acked, resolved, range.shift]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return breaches
      .filter((r) => (sev === 'all' || r.tone === sev))
      .filter((r) => (status === 'all' || r.status === status))
      .filter((r) => (zone === 'all' || r.zones.includes(zone)))
      .filter((r) => (cameraId === 'all' || r.monitorId === cameraId))
      .filter((r) => !q || `${r.subject} ${r.nounWhen} ${r.cameraName} ${r.zoneName || ''}`.toLowerCase().includes(q))
      .sort((a, b) => b.when - a.when);
  }, [breaches, sev, status, zone, cameraId, query]);

  const openCount = rows.filter((r) => r.status === 'open').length;
  const openRow = openRowId ? breaches.find((r) => r.id === openRowId) : null;

  // ── Actions ───────────────────────────────────────────────────────────────

  const serverAck = async (row) => {
    await aiService.acknowledge(row.raw.id || row.raw._id);
    setAcked((prev) => new Set(prev).add(row.id));
  };

  const acknowledge = async (row) => {
    setBusy({ id: row.id, action: 'ack' });
    try {
      await serverAck(row);
    } catch {
      // Left open on purpose: a row that says "acknowledged" when the server
      // never heard about it is the one failure mode this table cannot have.
      setError('That acknowledgement did not reach the server — try again.');
    } finally {
      setBusy(null);
    }
  };

  // Resolving acknowledges on the server first (if not already), then records
  // the resolution. The server has no resolve field yet, so the resolution —
  // who and when — is kept in this browser.
  const resolve = async (row) => {
    setBusy({ id: row.id, action: 'resolve' });
    try {
      if (row.status === 'open') await serverAck(row);
      setResolved(saveResolution(row.id, user?.name || user?.email || 'Operator'));
    } catch {
      setError('Could not mark that breach resolved — the acknowledgement did not reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const exportClip = (row) => {
    const { start, end } = clipWindow(row.when.getTime());
    if (end - start < 1000) { setNotice({ tone: 'danger', text: 'That breach has not been recorded yet — try again in a minute.' }); return; }
    const stamp = new Date(row.when.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = playbackService.exportUrl({
      monitorId: row.monitorId,
      start: iso(start),
      end: iso(end),
      name: `breach_${row.cameraName.replace(/[^\w-]+/g, '_')}_${stamp}`,
    });
    playbackService.download(url, end - start, (message) => setNotice({ tone: 'danger', text: `Clip export failed: ${message}` }));
    setNotice({
      tone: 'info',
      text: `Exporting the ${Math.round((end - start) / 1000)} s clip from ${row.cameraName} as MP4. Your browser saves it as it arrives; the NVR replays in real time, so it takes about as long as the clip.`,
    });
    setBusy({ id: row.id, action: 'clip' });
    setTimeout(() => setBusy((b) => (b?.id === row.id && b.action === 'clip' ? null : b)), 2000);
  };

  const filtersActive = sev !== 'all' || status !== 'all' || zone !== 'all' || cameraId !== 'all' || query;

  return (
    <OperationsPage>
      <PageHeader
        actions={
          <>
            <span className="rounded-full bg-surface-muted px-2.5 py-1 text-micro font-bold text-fg-muted">
              {openCount} open
            </span>
            <PageAction
              aria-pressed={showTrends}
              className={showTrends ? 'border-brand/50 bg-brand-soft text-brand-ink' : ''}
              onClick={() => setShowTrends((v) => !v)}
              type="button"
            >
              <BarChart3 className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">Breach Trends</span>
            </PageAction>
            <PageAction as={Link} to="/occupancy/zone-setup">
              <MapPin className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">Zone setup</span>
            </PageAction>
            <PageAction onClick={load} type="button">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
              <span className="hidden sm:inline">Refresh</span>
            </PageAction>
          </>
        }
        description="Every recorded intrusion, unrecognised face and loitering event across your configured zones, newest first. Filter by zone, camera, date range and shift; hover a camera badge to see the flagged frame, and close each breach out with Acknowledge, Mark Resolved or Export Clip."
        descriptionAs="tooltip"
        icon={ShieldX}
        tagline="Recorded zone intrusions — the history behind the live log."
        title="No-entry areas"
      />

      <PageContent className="gap-4" scroll>
        {error ? (
          <Banner onClose={() => setError(null)} tone="warning">{error}</Banner>
        ) : null}
        {notice ? (
          <Banner onClose={() => setNotice(null)} tone={notice.tone}>{notice.text}</Banner>
        ) : null}

        {showTrends && <BreachTrends rows={rows} />}

        <Panel
          bodyClass="p-0"
          count={rows.length}
          icon={Filter}
          right={
            <Link
              className="text-micro font-semibold text-brand-ink underline-offset-2 hover:underline"
              to="/occupancy/zone-setup"
            >
              Live now →
            </Link>
          }
          title="Recorded breaches"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2.5">
            <label className="relative inline-flex min-w-[180px] flex-1 items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
              <input
                className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search person, zone or camera…"
                value={query}
              />
            </label>
            <Select label="Severity" onChange={setSev} options={SEVERITIES} value={sev} />
            <Select label="Status" onChange={setStatus} options={STATUSES} value={status} />
            <Select
              label="Zone"
              onChange={setZone}
              options={[{ id: 'all', label: 'All zones' }, ...zoneNames.map((n) => ({ id: n, label: n }))]}
              value={zone}
            />
            <Select
              label="Camera"
              onChange={setCameraId}
              options={[{ id: 'all', label: 'Camera: All' }, ...cameraOptions]}
              value={cameraId}
            />
            <BreachRangePicker onChange={setRange} value={range} />
            {filtersActive ? (
              <button
                className="text-micro font-semibold text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                onClick={() => { setSev('all'); setStatus('all'); setZone('all'); setCameraId('all'); setQuery(''); }}
                type="button"
              >
                Clear filters
              </button>
            ) : null}
          </div>

          {loading && rows.length === 0 ? (
            <p className="px-6 py-12 text-center text-small text-fg-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
              <ShieldCheck className="h-5 w-5 text-success" strokeWidth={2} />
              <p className="text-small font-semibold text-fg-secondary">No breaches recorded</p>
              <p className="max-w-[48ch] text-[11px] leading-relaxed text-fg-subtle">
                Nothing in this date range matches these filters. A breach appears here when someone
                who is not on a zone&apos;s whitelist is recognised inside its boundary.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line-subtle text-micro font-bold uppercase tracking-wide text-fg-subtle">
                    <th className="px-3 py-2 font-bold">When (IST)</th>
                    <th className="px-3 py-2 font-bold">Violation</th>
                    <th className="px-3 py-2 font-bold">Camera — zone</th>
                    <th className="px-3 py-2 font-bold">Severity</th>
                    <th className="px-3 py-2 font-bold">Status</th>
                    <th className="px-3 py-2 font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const tone = TONE[r.tone] || TONE.neutral;
                    return (
                      <tr className={`border-b border-line-subtle last:border-0 ${r.status === 'open' ? 'bg-danger-soft/25' : ''}`} key={r.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-[11.5px] tabular-nums text-fg-secondary">
                          {fmtWhen(r.when)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-fg">
                            <tone.Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                            {r.nounWhen}
                          </span>
                          <span className="mt-0.5 block text-[10.5px] text-fg-subtle">{r.subject}</span>
                        </td>
                        <td className="px-3 py-2">
                          <CameraBadge onOpen={(row) => setOpenRowId(row.id)} row={r} />
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ${tone.chip}`}>
                            {r.tone}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-block rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[r.status]}`}
                            title={r.resolution ? `Resolved by ${r.resolution.by}, ${fmtWhen(new Date(r.resolution.at))}` : undefined}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <BreachActions busy={busy} onAcknowledge={acknowledge} onExportClip={exportClip} onResolve={resolve} row={r} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </PageContent>

      {openRow && (
        <BreachDetailDialog
          busy={busy}
          fmtWhen={fmtWhen}
          onAcknowledge={acknowledge}
          onClose={() => setOpenRowId(null)}
          onExportClip={exportClip}
          onResolve={resolve}
          row={openRow}
        />
      )}
    </OperationsPage>
  );
}

const BANNER = {
  warning: 'border-warning-line bg-warning-soft text-warning-ink',
  danger: 'border-danger-line bg-danger-soft text-danger-ink',
  info: 'border-info-line bg-info-soft text-info-ink',
};

function Banner({ tone, onClose, children }) {
  return (
    <p className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[11.5px] ${BANNER[tone] || BANNER.info}`}>
      <span className="flex-1">{children}</span>
      <button aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={onClose} type="button">
        <X className="h-3.5 w-3.5" />
      </button>
    </p>
  );
}

/**
 * One filter dropdown.
 *
 * Built on the product's Select, not a native `<select>`. A browser renders
 * `<option>` rows itself — that is why this row's menus opened with the
 * operating system's blue highlight while every other dropdown in the app
 * opened with the brand wash. An `<option>` cannot be styled; the only fix is
 * not to use one.
 *
 * The trigger's hover and open states and the brand gradient on the
 * highlighted row both come from core/ui/select.jsx, so this row now matches
 * the filter row on Camera Status without restating a single colour.
 */
function Select({ value, onChange, options, label }) {
  return (
    <SelectRoot onValueChange={onChange} value={value}>
      <SelectTrigger
        aria-label={label}
        className="h-8 max-w-[200px] shrink-0 rounded-lg bg-surface text-small font-semibold text-fg-secondary"
        size="sm"
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      {/* Beneath the trigger, left edges flush, 8px gap — the same anchor
          every other filter menu in the product uses. */}
      <SelectContent align="start" position="popper" side="bottom" sideOffset={8}>
        {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
      </SelectContent>
    </SelectRoot>
  );
}
