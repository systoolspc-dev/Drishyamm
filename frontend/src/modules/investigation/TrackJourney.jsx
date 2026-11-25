// Click to track (investigation toolkit I-3): one person → where they went.
//
//   /investigate/track            pick someone (latest people seen, or how to click one in Recordings)
//   /investigate/track/:trackId   their journey: confirmed stops in time order, the route,
//                                 proposed sightings on other cameras to confirm or reject,
//                                 a stitched video of the confirmed stops, evidence export.
//
// Proposals come from how alike the photos are; they are leads. Only what a
// person confirms goes on the journey, and the confirmation is recorded with
// their name (docs/investigation rule 15).
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Check, Clapperboard, FolderPlus, Footprints, Users, Loader2, MousePointerClick, PlayCircle, RotateCcw, ShieldCheck, X,
} from 'lucide-react';

import { OperationsPage, PageCard, PageContent, PageHeader } from '@/core/layout/OperationsPage';
import investigateService, { cropUrl, journeyService } from '@/core/services/investigate';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { cn } from '@/core/lib/utils';
import { STATUS_LABEL, groupCandidates, loadRecentPeople, routeLabel, spanMinutes, togetherLabel } from './journey-model';
import { isImported, playbackLink, whenLabel } from './search-model';
import EvidenceExportDialog from './EvidenceExportDialog';
import { rangeAround } from './evidence-model';
import AddToCaseDialog from './AddToCaseDialog';
import { itemFrom } from './case-model';

const errText = (e) => e?.response?.data?.message || e?.message || 'Something went wrong';

export default function TrackJourney() {
  const { trackId } = useParams();
  return trackId ? <Journey key={trackId} trackId={trackId} /> : <PickSomeone />;
}

function PickSomeone() {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const [indexOff, setIndexOff] = useState(false);
  useEffect(() => {
    // Same check as Smart Search: with the index off there is nobody to pick (journey-model).
    loadRecentPeople(investigateService)
      .then((r) => (r.indexOff ? setIndexOff(true) : setPeople(r.people)))
      .catch((e) => setError(errText(e)));
  }, []);
  return (
    <OperationsPage>
      <PageHeader icon={Footprints} title="Click to track"
        description="Pick a person and see where they went: the same person on your other cameras, confirmed by you, as a route and one stitched video." />
      <PageContent scroll className="gap-4 pb-6">
        <PageCard className="flex flex-wrap items-center gap-3 p-4 text-small text-fg-secondary">
          <MousePointerClick className="h-5 w-5 text-brand" />
          <span>Three ways to start: <b>Track this person</b> on a Smart Search result, <b>Click to track</b> on a video in Recordings, or pick someone below.</span>
          <Link to="/investigate" className="font-semibold text-brand hover:underline">Smart Search</Link>
          <Link to="/playback" className="font-semibold text-brand hover:underline">Recordings</Link>
        </PageCard>
        {indexOff ? (
          <PageCard className="p-4">
            <p className="text-small font-semibold text-fg">Click to track isn’t running on this server yet</p>
            <p className="mt-1 text-small text-fg-muted">The search index is switched off. Ask Drishyam support to turn it on; people are indexed from then on.</p>
          </PageCard>
        ) : null}
        {error ? <p className="text-small text-danger">{error}</p> : null}
        {!people && !error && !indexOff ? <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : null}
        {people?.length === 0 ? <p className="text-small text-fg-muted">Nobody has been indexed yet.</p> : null}
        {people?.length ? <h2 className="text-body font-bold text-fg">Seen most recently</h2> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
          {(people || []).map((r) => (
            <Link key={r.track_id} to={`/investigate/track/${r.track_id}`} className="group">
              <PageCard as="article" className="overflow-hidden">
                <img src={cropUrl(r.track_id)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-sunken object-cover" />
                <div className="p-2">
                  <p className="truncate text-[12px] font-semibold text-fg">{r.camera_name}</p>
                  <p className="truncate text-[11px] text-fg-muted">{whenLabel(r)}</p>
                </div>
              </PageCard>
            </Link>
          ))}
        </div>
      </PageContent>
    </OperationsPage>
  );
}

function Journey({ trackId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({});            // trackId → true while a review is saving
  const [windowH, setWindowH] = useState(4);
  const [exporting, setExporting] = useState(null);
  const ent = makeEntitlement(useAuthStore((s) => s.user));
  const canExport = ent.has('evidence_export');
  const canCase = ent.has('investigate_cases');
  const [casing, setCasing] = useState(false);

  const load = useCallback(() => {
    journeyService.journey(trackId, { windowS: windowH * 3600 }).then((d) => { setData(d); setError(null); })
      .catch((e) => setError(errText(e)));
  }, [trackId, windowH]);
  useEffect(() => { load(); }, [load]);

  const decide = async (c, verdict) => {
    setBusy((b) => ({ ...b, [c.track_id]: true }));
    try {
      await journeyService.review(trackId, c.track_id, verdict, c.score);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy((b) => ({ ...b, [c.track_id]: false }));
    }
  };

  const groups = groupCandidates(data?.candidates);
  const stops = data?.stops || [];
  return (
    <OperationsPage>
      <PageHeader
        icon={Footprints}
        title="Where they went"
        description="Confirmed sightings of this person, in time order. Proposed sightings are people who look alike: confirm the ones that are really them."
        actions={(
          <label className="flex items-center gap-2 text-small text-fg-muted">
            Look within
            <select value={windowH} onChange={(e) => setWindowH(Number(e.target.value))}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-small text-fg">
              {[1, 4, 12, 24].map((h) => <option key={h} value={h}>{h} h</option>)}
            </select>
            of them
          </label>
        )}
      />
      <PageContent scroll className="gap-4 pb-6">
        {error ? <PageCard className="p-4 text-small text-danger">{error}</PageCard> : null}
        {!data && !error ? <p className="flex items-center gap-2 text-small text-fg-muted"><Loader2 className="h-4 w-4 animate-spin" /> Finding them on your cameras…</p> : null}

        {data ? (
          <>
            <PageCard className="p-4">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-fg-muted">Route</p>
              <p className="mt-1 text-heading font-bold text-fg">{routeLabel(data.route) || data.seed.camera_name}</p>
              <p className="mt-1 text-small text-fg-muted">
                {stops.length} {stops.length === 1 ? 'sighting' : 'sightings'}
                {spanMinutes(stops) ? ` over ${spanMinutes(stops)} min` : ''}
                {groups.likely.length + groups.possible.length ? ` · ${groups.likely.length + groups.possible.length} more to review below` : ''}
              </p>
              <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                {stops.map((c, i) => (
                  <StopCard key={c.track_id} c={c} index={i + 1}
                    onUndo={c.status === 'confirmed' ? () => decide(c, 'clear') : null}
                    onExport={canExport && !isImported(c.camera_code) ? () => setExporting(c) : null}
                    busy={busy[c.track_id]} />
                ))}
              </div>
              {/* keyed by the stops: confirming or undoing one starts a fresh video */}
              {canCase ? (
                <button type="button" onClick={() => setCasing(true)}
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
                  <FolderPlus className="h-4 w-4" /> Add this journey to a case
                </button>
              ) : null}
              <StitchPanel key={(data.sightings || []).map((s) => s.sighting_id).join(',')} sightings={data.sightings} />
            </PageCard>

            <SeenWith trackId={trackId} stopsKey={stops.map((s) => s.track_id).join(',')} />

            {[['likely', 'Likely the same person'], ['possible', 'Possibly the same person']].map(([key, title]) => (
              groups[key].length ? (
                <PageCard key={key} className="p-4">
                  <h2 className="text-body font-bold text-fg">{title}</h2>
                  <p className="text-[12px] text-fg-muted">Look closely before confirming: these are suggestions from how alike the photos are, not identifications.</p>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-7">
                    {groups[key].map((c) => (
                      <ProposalCard key={c.track_id} c={c} busy={busy[c.track_id]}
                        onConfirm={() => decide(c, 'confirmed')} onReject={() => decide(c, 'rejected')} />
                    ))}
                  </div>
                </PageCard>
              ) : null
            ))}
            {!groups.likely.length && !groups.possible.length ? (
              <p className="text-small text-fg-muted">No one else on your cameras looks enough like this person within {windowH} h. Try a longer window above.</p>
            ) : null}
          </>
        ) : null}

        {casing && data ? (
          <AddToCaseDialog open onOpenChange={setCasing} item={itemFrom.journey(data.seed, data.stops, data.route || [])}
            what={`The journey ${routeLabel(data.route) || ''} (${data.stops.length} confirmed ${data.stops.length === 1 ? 'sighting' : 'sightings'}).`} />
        ) : null}
        {exporting ? (
          <EvidenceExportDialog open onOpenChange={(o) => { if (!o) setExporting(null); }}
            camera={{ monitorId: exporting.camera_code, name: exporting.camera_name }}
            {...rangeAround(exporting)} trackIds={[exporting.track_id]} scores={{ [exporting.track_id]: exporting.score }} />
        ) : null}
      </PageContent>
    </OperationsPage>
  );
}

function StopCard({ c, index, onUndo, onExport, busy }) {
  return (
    <article className="w-40 shrink-0 overflow-hidden rounded-xl border border-line bg-surface">
      <Link to={playbackLink(c)} title="Play this moment" className="relative block">
        <img src={cropUrl(c.track_id)} alt="" className="aspect-[3/4] w-full bg-surface-sunken object-cover" />
        <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-brand text-[12px] font-bold text-white">{index}</span>
        <PlayCircle className="absolute bottom-2 right-2 h-7 w-7 text-white drop-shadow" />
      </Link>
      <div className="space-y-0.5 p-2">
        <p className="truncate text-[12px] font-semibold text-fg">{c.camera_name}</p>
        <p className="truncate text-[11px] text-fg-muted">{whenLabel(c)}</p>
        <p className={cn('text-[11px] font-semibold', c.status === 'seed' ? 'text-brand' : 'text-success')}>{STATUS_LABEL[c.status]}</p>
        <div className="flex gap-2 pt-0.5">
          {onExport ? <button type="button" onClick={onExport} className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"><ShieldCheck className="h-3 w-3" /> Evidence</button> : null}
          {onUndo ? <button type="button" disabled={busy} onClick={onUndo} className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg"><RotateCcw className="h-3 w-3" /> Undo</button> : null}
        </div>
      </div>
    </article>
  );
}

function ProposalCard({ c, onConfirm, onReject, busy }) {
  return (
    <PageCard as="article" className="overflow-hidden">
      <Link to={playbackLink(c)} title="Play this moment" className="relative block">
        <img src={cropUrl(c.track_id)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-sunken object-cover" />
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white">{Math.round(c.score * 100)}% alike</span>
      </Link>
      <div className="space-y-1 p-2">
        <p className="truncate text-[12px] font-semibold text-fg">{c.camera_name}</p>
        <p className="truncate text-[11px] text-fg-muted">{whenLabel(c)}</p>
        {c.reasons?.length ? <p className="line-clamp-2 text-[11px] text-fg-muted">{c.reasons.join(' · ')}</p> : null}
        <div className="flex gap-1.5 pt-1">
          <button type="button" disabled={busy} onClick={onConfirm}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-brand text-[12px] font-semibold text-white disabled:opacity-50">
            <Check className="h-3.5 w-3.5" /> It’s them
          </button>
          <button type="button" disabled={busy} onClick={onReject} title="Not them"
            className="inline-flex h-7 items-center justify-center rounded-md border border-line px-2 text-fg-muted hover:text-fg disabled:opacity-50">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </PageCard>
  );
}

/** Associations (phase 4): who was close to this person for a few seconds or more. */
function SeenWith({ trackId, stopsKey }) {
  const [res, setRes] = useState({ key: null, data: null });
  const key = `${trackId}|${stopsKey}`;
  useEffect(() => {
    let live = true;
    journeyService.companions(trackId).then((d) => { if (live) setRes({ key, data: d }); })
      .catch(() => { if (live) setRes({ key, data: { companions: [] } }); });
    return () => { live = false; };
  }, [trackId, key]);
  const data = res.key === key ? res.data : null;
  if (!data?.companions?.length) return null;
  return (
    <PageCard className="p-4">
      <h2 className="flex items-center gap-2 text-body font-bold text-fg"><Users className="h-4 w-4 text-brand" /> Seen with</h2>
      <p className="text-[12px] text-fg-muted">
        People and vehicles that stayed close to them (within about {data.rule?.near_heights ?? 1.5} body heights) on the same camera. A lead to check on the footage, not a link between people.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
        {data.companions.map((c) => (
          <PageCard as="article" key={c.track_id} className="overflow-hidden">
            <Link to={playbackLink({ ...c, first_seen: c.first, last_seen: c.last })} title="Play this moment">
              <img src={cropUrl(c.track_id)} alt="" loading="lazy" className="aspect-[3/4] w-full bg-surface-sunken object-cover" />
            </Link>
            <div className="space-y-0.5 p-2">
              <p className="text-[12px] font-semibold text-fg">{togetherLabel(c.seconds, c.object_class)}</p>
              <p className="truncate text-[11px] text-fg-muted">{c.camera_name} · {whenLabel({ first_seen: c.first, last_seen: c.last })}</p>
              <Link to={`/investigate/track/${c.track_id}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
                <Footprints className="h-3 w-3" /> Follow them
              </Link>
            </div>
          </PageCard>
        ))}
      </div>
    </PageCard>
  );
}

function StitchPanel({ sightings }) {
  const [job, setJob] = useState(null);          // { id, status, message, progress, error }
  const navigate = useNavigate();
  useEffect(() => {
    if (!job?.id || ['done', 'failed'].includes(job.status)) return undefined;
    const t = setInterval(() => {
      journeyService.stitchStatus(job.id).then((d) => setJob((j) => ({ ...j, status: d.status, progress: d.progress,
        message: d.message, error: d.failed_reason }))).catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  const start = async () => {
    try {
      const d = await journeyService.stitch(sightings);
      setJob({ id: d.job_id, status: d.status });
    } catch (e) {
      setJob({ status: 'failed', error: errText(e) });
    }
  };
  if (!sightings?.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      {!job ? (
        <button type="button" onClick={start}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:bg-surface-sunken">
          <Clapperboard className="h-4 w-4" /> Make one video of the journey
        </button>
      ) : job.status === 'done' ? (
        <video src={journeyService.stitchVideoUrl(job.id)} controls className="w-full max-w-3xl rounded-lg bg-black" />
      ) : job.status === 'failed' ? (
        <p className="text-small text-danger">
          The video could not be made: {job.error || 'unknown error'}.
          {' '}It uses footage recorded on this server; for footage only on the recorder, open each stop in <button type="button" className="underline" onClick={() => navigate('/playback')}>Recordings</button>.
        </p>
      ) : (
        <p className="flex items-center gap-2 text-small text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {job.message || 'Making the video…'} {job.progress ? `${Math.round(job.progress * 100)}%` : ''}
        </p>
      )}
    </div>
  );
}
