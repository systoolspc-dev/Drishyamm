/**
 * Vehicle & ANPR Intelligence Hub — /ai-analytics/vehicle
 *
 * Five tabs over ONE list of plate reads. Find & Track asks "where did this
 * plate go", Live asks "what just came through", Outside asks "who is not from
 * here", Records asks "what happened", Check Reads asks "what did we probably
 * get wrong". Five feeds for five tabs would have let them disagree about the
 * same read, so there is one hook and five questions.
 *
 * The KPI header sits OUTSIDE the tabs: moving between them is a change of
 * question, not of subject, and losing the headline numbers on the way would
 * just make an operator tab back to re-read them.
 *
 * The tab lives in the URL (`?tab=`), so each view is linkable and survives a
 * reload.
 *
 * Built as a module rather than inside `ai-analytics`, deliberately: that
 * folder's global reset (`.ai-analytics-scope * { margin:0; padding:0 }`) beats
 * Tailwind utilities, which is why the pages in it carry hand-written scoped
 * stylesheets. On the normal app shell this hub gets the design tokens, the
 * standard header and dark mode for free.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Car, FileSearch, Globe2, Radio, RefreshCw, Route, ScanLine, ShieldAlert,
} from 'lucide-react';
import {
  OperationsPage, PageHeader, PageContent, PageTabs, PageAction,
} from '@/core/layout/OperationsPage';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { useVehicleReads } from './useVehicleReads';
import { buildKpis } from './vehicle-data';
import { FeedNote } from './components/bits';
import FindTrack from './tabs/FindTrack';
import LiveStream from './tabs/LiveStream';
import OutsideVehicles from './tabs/OutsideVehicles';
import VehicleRecords from './tabs/VehicleRecords';
import CheckReads from './tabs/CheckReads';

const PAGE_DESCRIPTION =
  'Every number plate the cameras have read, asked five ways: track one vehicle between cameras, watch the live lane, list the vehicles registered outside this state, search the full record, and correct the reads the model was unsure about. Reads come from the events feed — there is no separate ANPR endpoint — so a plate that appears on one tab appears on all of them.';

const TABS = [
  { id: 'track', label: 'Find & Track', Icon: Route },
  { id: 'live', label: 'Live ANPR', Icon: Radio },
  { id: 'outside', label: 'Outside Vehicles', Icon: Globe2 },
  { id: 'records', label: 'Vehicle Records', Icon: FileSearch },
  { id: 'review', label: 'Check Reads', Icon: ScanLine },
];

const TAB_IDS = TABS.map((t) => t.id);

export default function VehicleHub() {
  const [params, setParams] = useSearchParams();
  const [paused, setPaused] = useState(false);

  const raw = params.get('tab');
  const tab = TAB_IDS.includes(raw) ? raw : 'track';
  const setTab = useCallback((next) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('tab', next);
      return p;
    }, { replace: true });
  }, [setParams]);

  // Only the live tab needs a 5s heartbeat. The other four are looking at
  // history, and re-sorting a table under someone's cursor is hostile.
  const live = tab === 'live' && !paused;

  const {
    reads, cameraOptions, watchIndex, corrections, correct,
    localState, setLocalState, loading, error, updatedAt, refresh,
  } = useVehicleReads({ live });

  const kpis = useMemo(
    () => buildKpis({ reads, watchIndex, localState, streamOnline: !error }),
    [reads, watchIndex, localState, error],
  );

  const tiles = [
    {
      key: 'reads',
      Icon: Car,
      label: 'Total reads today',
      value: kpis.reads.toLocaleString('en-IN'),
      sub: `${kpis.withPlate} carried a readable plate`,
      tip: 'Every vehicle event recorded since midnight. A detection without OCR still counts as a read — the sub-line says how many produced a plate.',
    },
    {
      key: 'stream',
      Icon: Radio,
      label: 'Live ANPR stream',
      value: error ? 'Offline' : loading ? 'Connecting' : 'Online',
      sub: updatedAt ? `Last read ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Waiting for the first poll',
      tone: error ? 'crit' : 'ok',
      tip: 'Whether the events feed is answering. It is not a per-camera health check — a camera can be up and simply not reading plates.',
    },
    {
      key: 'hits',
      Icon: ShieldAlert,
      label: 'Watchlist hits',
      value: kpis.hits.toLocaleString('en-IN'),
      sub: kpis.hits ? 'Flagged plates seen today' : 'No flagged plate seen today',
      tone: kpis.hits ? 'crit' : 'ok',
      tip: 'Reads whose plate is on the vehicle watchlist. Matching happens on the corrected plate, so a read fixed in Check Reads can become a hit.',
    },
    {
      key: 'outside',
      Icon: Globe2,
      label: 'Outside jurisdiction',
      value: kpis.outside.toLocaleString('en-IN'),
      sub: `${kpis.outsidePct}% of today's plates · local is ${localState || '—'}`,
      tone: 'ok',
      tip: 'Plates whose registering state is not the local one. The local state is set on the Outside Vehicles tab.',
    },
  ];

  return (
    <OperationsPage>
      <PageHeader
        actions={
          <>
            {kpis.lowConfidence ? (
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-warning-line bg-warning-soft px-2.5 text-small font-semibold text-warning-ink transition hover:brightness-105"
                onClick={() => setTab('review')}
                type="button"
              >
                <ScanLine className="h-3.5 w-3.5" strokeWidth={2} />
                {kpis.lowConfidence} to check
              </button>
            ) : null}
            <PageAction as={Link} to="/ai-analytics/vehicle/watchlist">
              <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">Watchlist</span>
            </PageAction>
            <PageAction onClick={refresh} type="button">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
              <span className="hidden sm:inline">Refresh</span>
            </PageAction>
            <PageTabs active={tab} onChange={setTab} tabs={TABS} />
          </>
        }
        description={PAGE_DESCRIPTION}
        descriptionAs="tooltip"
        icon={Car}
        tagline="Plate reads, vehicle tracking and manual verification."
        title="Number plates"
      />

      <PageContent className="gap-4" scroll>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {tiles.map((t) => <Kpi key={t.key} {...t} />)}
        </div>

        <FeedNote error={error} />

        {tab === 'track' ? (
          <FindTrack cameraOptions={cameraOptions} reads={reads} watchIndex={watchIndex} />
        ) : tab === 'live' ? (
          <LiveStream
            cameraOptions={cameraOptions}
            onTogglePause={() => setPaused((p) => !p)}
            paused={paused}
            reads={reads}
            watchIndex={watchIndex}
          />
        ) : tab === 'outside' ? (
          <OutsideVehicles
            cameraOptions={cameraOptions}
            localState={localState}
            onLocalState={setLocalState}
            reads={reads}
          />
        ) : tab === 'records' ? (
          <VehicleRecords cameraOptions={cameraOptions} reads={reads} watchIndex={watchIndex} />
        ) : (
          <CheckReads
            corrections={corrections}
            onCorrect={correct}
            reads={reads}
            watchIndex={watchIndex}
          />
        )}
      </PageContent>
    </OperationsPage>
  );
}

/**
 * One macro number. `tone` recolours only the value, never the card: a wall of
 * red cards reads as a broken page, one red number reads as one thing wrong.
 */
function Kpi({ Icon, label, value, sub, tone = 'ok', tip }) {
  const ink = tone === 'crit' ? 'text-danger-ink' : tone === 'warn' ? 'text-warning-ink' : 'text-fg';
  const badge = tone === 'crit' ? 'bg-danger-soft text-danger-ink'
    : tone === 'warn' ? 'bg-warning-soft text-warning-ink'
      : 'bg-brand-soft text-brand';
  const card = (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${badge}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <p className="mt-3 truncate text-[11.5px] font-medium text-fg-muted">{label}</p>
      <p className={`mt-1 truncate text-[20px] font-extrabold leading-none tracking-tight tabular-nums ${ink}`}>{value}</p>
      {sub ? <p className="mt-1.5 truncate text-[10.5px] text-fg-subtle">{sub}</p> : null}
    </div>
  );
  if (!tip) return card;
  return (
    <Tooltip>
      <TooltipTrigger asChild><div>{card}</div></TooltipTrigger>
      <TooltipContent className="max-w-[20rem] text-[10.5px] leading-relaxed" side="top" variant="card">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
