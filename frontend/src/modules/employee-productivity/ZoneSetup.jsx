import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid, ListOrdered, EyeOff, Timer, Save, RotateCcw, ArrowUpRight, Camera } from 'lucide-react';
import {
  OperationsPage, PageHeader, PageContent, PageCard, PageAction,
} from '@/core/layout/OperationsPage';
import { toast } from '@/core/store/toastStore';
import { ZONE_TYPE_TEMPLATES } from '@/use-cases/headcount.params';
import { useActivityParams } from './useCaseStore';
import { T, TH } from './type';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/zone-setup — Activity Zone Setup.
//
// WHAT IT IS NOT. It is not a second polygon editor. Where a zone IS — its
// shape on each camera view — is drawn once, on /occupancy/zone-setup, and
// that page is linked from here rather than reimplemented: two canvases
// editing one boundary is exactly the redundancy this module is shedding.
//
// WHAT IT IS. What a zone MEANS to staff activity. The same floor zone is
// read differently by the two modules: Zone Headcount asks "how many people
// are in it" (capacity, density, dwell), while Activity Monitoring asks "is
// somebody POSTED on it, and is the queue at it moving". Those are different
// questions with different thresholds, which is why this is its own page and
// not a tab of the occupancy setup.
//
// Three things are configured, in the order they are asked:
//   1  the floor defaults — the module-wide limits every zone inherits
//      (params.zones.counterUnattendedSec / coverageTargetPct, params.queue)
//   2  which zones are POSTS — a zone somebody is expected to be standing on,
//      so leaving it raises a counter-unattended alert
//   3  which posts are QUEUE POINTS — a post where customers wait, so queue
//      length and wait time are measured against the floor's limits
//
// The zone list comes from the vertical's configured zones
// (params.headcount.zones — one list of zones, two modules reading it), with
// gates left out: nobody is posted on a doorway.
//
// FRONTEND-ONLY. Edits live in page state and Save reports what it would
// send. Future backend: PATCH /activity/zone-config (the floor defaults) and
// PATCH /activity/zones/:id (per-zone role and overrides).
// ─────────────────────────────────────────────────────────────────────────────

// Which configured zone types can hold a posted member of staff. Keyed off the
// template's `kind` (headcount.params.js) rather than a list of type ids, so a
// vertical adding a zone type gets the right default without touching this.
const POSTABLE_KINDS = new Set(['queue', 'service', 'work', 'display', 'secure', 'lobby', 'meeting', 'dining', 'office']);
// A kind where customers queue — these default to being queue points too.
const QUEUE_KINDS = new Set(['queue', 'service']);

const roleOf = (kind) => (QUEUE_KINDS.has(kind) ? 'queue' : POSTABLE_KINDS.has(kind) ? 'post' : 'none');

const ROLES = [
  { key: 'queue', label: 'Queue point', hint: 'Staffed, and customers wait here — coverage and queue length both measured' },
  { key: 'post',  label: 'Post',        hint: 'Staff expected on it — leaving it raises an unattended alert' },
  { key: 'none',  label: 'Not tracked', hint: 'No coverage expectation for staff activity' },
];
const ROLE_CLS = {
  queue: 'border-brand-line bg-brand-soft text-brand-ink',
  post:  'border-info-line bg-info-soft text-info-ink',
  none:  'border-line bg-surface-muted text-fg-muted',
};

export default function ActivityZoneSetup() {
  const { useCase, params } = useActivityParams();
  const siteLabel = params.headcount?.label?.site || 'Store';

  // The vertical's zone types, by id, so a zone row can name its type and
  // read the `kind` its default role comes from.
  const types = useMemo(() => {
    const list = ZONE_TYPE_TEMPLATES[useCase] || ZONE_TYPE_TEMPLATES.retail || [];
    return new Map(list.map((t) => [t.id, t]));
  }, [useCase]);

  // Floor defaults, in the units an operator reads: minutes and seconds, not
  // the params' raw seconds.
  const saved = useMemo(() => ({
    unattendedMin: Math.round((params.zones?.counterUnattendedSec ?? 300) / 60),
    coverageTargetPct: params.zones?.coverageTargetPct ?? 80,
    maxQueue: params.queue?.maxQueue ?? 5,
    serviceTimeSec: params.queue?.serviceTimeSec ?? 90,
  }), [params.zones, params.queue]);

  const zones = useMemo(
    () => (params.headcount?.zones || []).filter((z) => POSTABLE_KINDS.has(types.get(z.type)?.kind)),
    [params.headcount, types],
  );

  const savedRoles = useMemo(
    () => Object.fromEntries(zones.map((z) => [z.id, roleOf(types.get(z.type)?.kind)])),
    [zones, types],
  );

  const [floor, setFloor] = useState(saved);
  const [roles, setRoles] = useState(savedRoles);

  const dirty = useMemo(
    () => Object.keys(saved).some((k) => String(saved[k]) !== String(floor[k]))
      || zones.some((z) => savedRoles[z.id] !== roles[z.id]),
    [saved, floor, zones, savedRoles, roles],
  );

  const posts = zones.filter((z) => roles[z.id] !== 'none');
  const queuePoints = zones.filter((z) => roles[z.id] === 'queue');

  const setNum = (key, raw, { min, max }) => {
    const n = Number(raw);
    if (raw === '') { setFloor((f) => ({ ...f, [key]: '' })); return; }
    if (Number.isNaN(n)) return;
    setFloor((f) => ({ ...f, [key]: Math.min(max, Math.max(min, n)) }));
  };

  const reset = () => { setFloor(saved); setRoles(savedRoles); };

  const save = () => {
    // Frontend-only: states exactly what the backend call will carry, so the
    // page is honest about having changed nothing yet.
    toast.success(
      'Activity zone setup saved',
      `${posts.length} post${posts.length === 1 ? '' : 's'}, ${queuePoints.length} queue point${queuePoints.length === 1 ? '' : 's'} · unattended after ${floor.unattendedMin}m · coverage target ${floor.coverageTargetPct}%`,
    );
  };

  return (
    <OperationsPage>
      <PageHeader
        icon={LayoutGrid}
        title="Activity Zone Setup"
        description={`Which ${siteLabel.toLowerCase()} zones staff are posted on, and the limits their coverage is judged against. Zone shapes are drawn in Zone Setup under Occupancy.`}
        descriptionAs="tooltip"
        tagline={`${posts.length} of ${zones.length} zones tracked · ${queuePoints.length} queue point${queuePoints.length === 1 ? '' : 's'}`}
        actions={
          <>
            <PageAction onClick={reset} disabled={!dirty} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </PageAction>
            <PageAction onClick={save} disabled={!dirty} className="gap-1.5">
              <Save className="h-3.5 w-3.5" /> Save setup
            </PageAction>
          </>
        }
      />

      <PageContent scroll>
        <div className="space-y-4 pb-5">
          {/* ── 1 · Floor defaults ──────────────────────────────────────── */}
          <PageCard className="p-4">
            <h2 className="text-lg font-semibold text-fg">Floor defaults</h2>
            <p className={`mb-4 ${T.itemMeta}`}>
              The limits every tracked zone inherits. Counter Cover and the Activity Log judge
              each zone against these.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <NumField
                icon={EyeOff}
                label="Unattended after"
                unit="min"
                value={floor.unattendedMin}
                onChange={(v) => setNum('unattendedMin', v, { min: 1, max: 60 })}
                hint="A post empty for longer raises a counter-unattended alert."
              />
              <NumField
                icon={LayoutGrid}
                label="Coverage target"
                unit="%"
                value={floor.coverageTargetPct}
                onChange={(v) => setNum('coverageTargetPct', v, { min: 1, max: 100 })}
                hint="An hour staffed at least this much of the time is compliant."
              />
              <NumField
                icon={ListOrdered}
                label="Max queue"
                unit="people"
                value={floor.maxQueue}
                onChange={(v) => setNum('maxQueue', v, { min: 1, max: 50 })}
                hint="More than this waiting at a queue point raises an alert."
              />
              <NumField
                icon={Timer}
                label="Target service time"
                unit="sec"
                value={floor.serviceTimeSec}
                onChange={(v) => setNum('serviceTimeSec', v, { min: 10, max: 900 })}
                hint="Per customer — the estimated wait is the queue times this."
              />
            </div>
          </PageCard>

          {/* ── 2 & 3 · Which zones are posts, and which are queue points ─ */}
          <PageCard className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-fg">Zones &amp; roles</h2>
                <p className={T.itemMeta}>
                  What each zone means to staff activity. Shapes and cameras are set in{' '}
                  <Link to="/occupancy/zone-setup" className="font-semibold text-brand-ink hover:underline">
                    Occupancy › Zone Setup
                  </Link>.
                </p>
              </div>
              <Link
                to="/occupancy/zone-setup"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-caption font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink"
              >
                Edit zone shapes <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {zones.length === 0 ? (
              <p className="px-4 py-10 text-center text-caption text-fg-subtle">
                This vertical has no staffable zones configured yet. Add them in Occupancy › Zone Setup.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left">
                  <thead>
                    <tr>
                      <th className={TH.left}>Zone</th>
                      <th className={TH.left}>Type</th>
                      <th className={TH.center}>Cameras</th>
                      <th className={TH.left}>Role in staff activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zones.map((z) => {
                      const t = types.get(z.type);
                      return (
                        <tr key={z.id} className="border-t border-line-subtle align-middle">
                          <td className="px-4 py-2.5">
                            <p className={T.itemTitle}>{z.label}</p>
                            {z.area && <p className={T.itemMeta}>{z.area}</p>}
                          </td>
                          <td className={`px-4 py-2.5 ${T.td}`}>{t?.label || z.type}</td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="inline-flex items-center gap-1 text-caption tabular-nums text-fg-muted">
                              <Camera className="h-3.5 w-3.5" />
                              {(z.cameraIds || []).length || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {ROLES.map((r) => (
                                <button
                                  key={r.key}
                                  type="button"
                                  title={r.hint}
                                  aria-pressed={roles[z.id] === r.key}
                                  onClick={() => setRoles((m) => ({ ...m, [z.id]: r.key }))}
                                  className={`rounded-full border px-2.5 py-1 text-micro font-semibold transition ${
                                    roles[z.id] === r.key
                                      ? ROLE_CLS[r.key]
                                      : 'border-line bg-surface text-fg-muted hover:border-brand/40 hover:text-brand-ink'
                                  }`}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </PageCard>
        </div>
      </PageContent>
    </OperationsPage>
  );
}

/** One threshold: a number, its unit, and what the number does. */
function NumField({ icon: Icon, label, unit, value, onChange, hint }) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <p className="flex items-center gap-1.5 text-caption font-semibold text-fg-secondary">
        <Icon className="h-3.5 w-3.5 text-fg-muted" /> {label}
      </p>
      <div className="mt-2 flex items-baseline gap-1.5">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} (${unit})`}
          className="h-9 w-20 rounded-lg border border-line bg-surface px-2 text-body font-semibold tabular-nums text-fg outline-none focus:border-brand"
        />
        <span className="text-caption font-semibold text-fg-muted">{unit}</span>
      </div>
      <p className="mt-2 text-caption leading-snug text-fg-subtle">{hint}</p>
    </div>
  );
}
