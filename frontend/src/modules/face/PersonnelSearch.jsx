import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock3,
  Filter,
  X,
  HelpCircle,
  Loader2,
  MapPin,
  Radio,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
  UserRound,
  UserSearch,
  Users,
  Video,
} from 'lucide-react';

import { AI_BASE } from '@/core/config/endpoints';
import { OperationsPage, PageHeader, PageContent } from '@/core/layout/OperationsPage';
import WebRTCStream from '@/core/players/WebRTCStream';
import { HeaderInfo } from '@/core/ui/header-info';
import { MetricCard } from '@/core/ui/metric-card';

// Dummy fallback people (Jordan Lee / Marcus Thorne / Dr. Simon Kovic) were
// removed on purpose: when the AI service is briefly unreachable we used to
// flash three fake "CAM 12 / CAM 09 / CAM 04" rows that don't exist in the
// deployment, and clicking Live on them landed the operator on whichever
// real camera happened to be first in their list. We now show an empty
// state + error banner instead — never fake data while live data is what
// the operator is asking for.

const ROLE_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Students', value: 'student' },
  { label: 'Staff', value: 'staff' },
  { label: 'Faculty', value: 'faculty' },
  { label: 'Visitors', value: 'visitor' },
];

const statusMeta = {
  live: {
    label: 'Tracking',
    tone: 'border-success-line bg-success-soft text-success-ink',
    dot: 'bg-success',
    Icon: Radio,
  },
  alert: {
    label: 'Needs Attention',
    tone: 'border-danger-line bg-danger-soft text-danger-ink',
    dot: 'bg-danger',
    Icon: ShieldAlert,
  },
  review: {
    label: 'Review',
    tone: 'border-warning-line bg-warning-soft text-warning-ink',
    dot: 'bg-warning',
    Icon: AlertTriangle,
  },
  offline: {
    label: 'Last Seen',
    tone: 'border-line bg-surface-sunken text-fg-secondary',
    dot: 'bg-neutral',
    Icon: Clock3,
  },
};

export default function PersonnelSearch() {
  // Seeded from ?q= so the dashboard omnibox ("Find a Person") lands here with
  // the operator's query already in the box instead of an empty search.
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q') || '');
  const [role, setRole] = useState('');
  const [people, setPeople] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Which row the operator has actually clicked. Drives the right-hand
  // "Selected Person" panel and the Live button there. Without this, the
  // panel was hard-coded to people[0] — clicking Live on anyone always
  // opened the topmost person's camera, which is why every Live click
  // ended up on the same camera regardless of who was clicked.
  const [selectedId, setSelectedId] = useState(null);
  // Below lg the detail column is hidden, so picking a row has to open the
  // same panel as a slide-over instead of silently doing nothing.
  const [detailOpen, setDetailOpen] = useState(false);

  // Shared fetch — used by both the debounced search effect and the
  // real-time polling effect below. `silent=true` suppresses the spinner
  // so the grid doesn't flash on every poll tick.
  const runSearch = useCallback(async ({ silent = false, signal } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const url = new URL('/personnel/search', AI_BASE);
      if (query.trim()) url.searchParams.set('q', query.trim());
      if (role) url.searchParams.set('role', role);
      url.searchParams.set('limit', '50');

      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Search failed (${response.status})`);
      const payload = await response.json();
      const nextPeople = Array.isArray(payload.items) ? payload.items.map(mapApiPerson) : [];
      setPeople(nextPeople);
      setStats(payload.stats || null);
      setTotal(Number(payload.total || nextPeople.length));
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (silent) {
        // Polling failures are transient — keep the previous data on screen
        // instead of dropping the user back to fallback samples mid-session.
        return;
      }
      // No fake fallback rows here — see the comment near the top of this
      // file. Operators reading "Server Room - CAM 12" while the AI is down
      // is worse than reading "AI search service is not reachable" and
      // seeing the empty state.
      setError('AI search service is not reachable right now. Retrying every 5s.');
      setPeople([]);
      setStats(null);
      setTotal(0);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [query, role]);

  // Debounced search — fires 280 ms after the user stops typing.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      runSearch({ silent: false, signal: controller.signal });
    }, 280);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [runSearch]);

  // Real-time polling — re-runs the current search every 5 s so newly-seen
  // people, fresh sightings, and updated "last seen at" labels show up
  // without the operator needing to refresh or re-type. Silent so the
  // results grid doesn't flicker on each tick.
  useEffect(() => {
    const controller = new AbortController();
    const tick = () => runSearch({ silent: true, signal: controller.signal });
    const t = window.setInterval(tick, 5000);
    return () => {
      window.clearInterval(t);
      controller.abort();
    };
  }, [runSearch]);

  // Default to the top row until the operator picks someone; once they
  // click a row, keep showing THAT person — even after the 5-second poll
  // refreshes the list — so the side panel doesn't snap back to row 0.
  // If a poll returns a list that no longer contains the selected person,
  // fall back to the top row instead of going blank.
  const selected =
    (selectedId && people.find((p) => p.id === selectedId)) || people[0] || null;
  const quickStats = useMemo(() => {
    const fallback = {
      total_people: total,
      live_tracking: people.filter((p) => p.status === 'live').length,
      needs_review: people.filter((p) => p.status === 'alert' || p.status === 'review').length,
      enrolled_people: people.reduce((sum, p) => sum + (p.enrollmentCount > 0 ? 1 : 0), 0),
      search_ms: 0,
    };
    const s = stats || fallback;
    return [
      { label: 'People on file', value: fmtNumber(s.total_people), sub: `${fmtNumber(s.enrolled_people)} have a face photo enrolled`, Icon: Users, tone: 'info' },
      { label: 'On camera now', value: fmtNumber(s.live_tracking), sub: 'Seen in the last few minutes', Icon: Radio, tone: 'success' },
      // `alert` colours the number itself: a non-zero review queue is the one
      // metric here that is itself the problem.
      { label: 'Needs your review', value: fmtNumber(s.needs_review), sub: 'Restricted area or watchlist hits', Icon: ShieldAlert, tone: 'danger', alert: true },
      { label: 'Last result in', value: s.search_ms ? `${fmtNumber(s.search_ms, 0)} ms` : 'Ready', sub: 'How fast we found these people', Icon: CheckCircle2, tone: 'brand' },
    ];
  }, [people, stats, total]);

  return (
    <OperationsPage>
      <PageHeader
        icon={UserSearch}
        title="Find a person"
        description="Search by name, ID, or department to see where someone was last seen and on which camera. Live opens that camera; Journey replays their whole route."
        descriptionAs="tooltip"
        tagline="Search enrolled profiles, track live camera sightings, or view journey maps."
      />

      {/* Back to a clipped frame: nothing below may exceed the viewport, so
          the results list is the single place anything scrolls. The detail
          column no longer needs `sticky` — at full height it is already
          always in view. */}
      <PageContent className="gap-0">
        <div className="mb-3 grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
          {quickStats.map(({ label, value, sub, Icon, tone, alert }) => (
            <MetricCard
              alert={alert}
              className="px-3 py-2"
              icon={Icon}
              key={label}
              label={label}
              size="sm"
              sub={sub}
              tone={tone}
              value={value}
            />
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-12">

          {/* ── Left: query, filters, results — one card, header pinned ─── */}
          <div className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface p-3 shadow-sm lg:col-span-5">

            <div className="shrink-0 space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
                <input
                  className="h-11 w-full rounded-xl border border-line bg-surface-sunken pl-10 pr-3 text-body outline-none transition focus:border-line-focus focus:bg-surface focus:ring-2 focus:ring-brand/25"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by name, ID, department, or location"
                  value={query}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {ROLE_FILTERS.map((filter) => (
                  <button
                    className={`rounded-full border px-3 py-1.5 text-small font-semibold transition ${
                      role === filter.value
                        ? 'border-brand bg-brand text-white shadow-sm'
                        : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken'
                    }`}
                    key={filter.label}
                    onClick={() => setRole(filter.value)}
                    type="button"
                  >
                    {filter.label}
                  </button>
                ))}

                {/* The tip was a permanent two-line banner restating advice you
                    need once. On hover (and on focus, so it is not mouse-only)
                    it costs nothing but the icon. */}
                <HeaderInfo
                  ariaLabel="Search tips"
                  className="ml-auto"
                  icon={HelpCircle}
                  text="An employee or student ID finds one exact person; a name may return several. A green dot means that person is on a camera right now."
                />
              </div>

              {error ? (
                <div className="flex items-center gap-2 rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-small font-semibold text-warning-ink" role="alert">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              ) : null}

              {/* Results header bar, with the cross-page actions */}
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2">
                <span
                  aria-live="polite"
                  className="inline-flex min-w-0 items-center gap-2 text-body font-semibold text-fg"
                >
                  {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-fg-muted" /> : <Filter className="h-4 w-4 shrink-0 text-fg-muted" />}
                  {loading ? 'Searching' : `${fmtNumber(total)} result${total === 1 ? '' : 's'}`}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Link
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover"
                    to="/ai-event/journeymap"
                  >
                    <Route className="h-4 w-4" />
                    Journey Map
                  </Link>
                </div>
              </div>

            </div>

            <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
              {people.length ? (
                <div className="grid gap-3">
                    {people.map((person) => (
                      <PersonRow
                        person={person}
                        key={person.id}
                        isSelected={selected?.id === person.id}
                        onSelect={() => { setSelectedId(person.id); setDetailOpen(true); }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex min-h-[250px] items-center justify-center rounded-2xl border border-dashed border-line bg-surface-sunken p-6 text-center">
                    <div>
                      <Search className="mx-auto h-8 w-8 text-fg-subtle" />
                      <h3 className="mt-3 text-sm font-semibold text-fg sm:text-base">
                        {error ? 'Live data unavailable' : 'No matching person found'}
                      </h3>
                      <p className="mt-1 max-w-sm text-body text-fg-muted">
                        {error
                          ? 'The AI search service is offline. We will not show sample data here while real data is what you are asking for.'
                          : 'Try a shorter name, employee ID, roll number, or another role filter.'}
                      </p>
                    </div>
                  </div>
                )}
            </div>
          </div>

          {/* ── Right: the selected person, full height ──────────────────── */}
          <div className="hidden min-h-0 flex-col lg:col-span-7 lg:flex">
            <SelectedPersonPanel selected={selected} />
          </div>
        </div>

        {/* Same panel as a slide-over below lg, so the results list keeps the
            full width on a narrow screen instead of splitting it in two. */}
        {detailOpen && selected ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              aria-label="Close details"
              className="absolute inset-0 bg-slate-950/40"
              onClick={() => setDetailOpen(false)}
              type="button"
            />
            <div className="absolute inset-y-0 right-0 flex w-[min(30rem,calc(var(--app-vw)*0.94))] flex-col bg-surface shadow-2xl">
              <SelectedPersonPanel onClose={() => setDetailOpen(false)} selected={selected} />
            </div>
          </div>
        ) : null}
      </PageContent>
    </OperationsPage>
  );
}

function SelectedPersonPanel({ selected, onClose }) {
  if (!selected) {
    return (
      <aside className="grid h-full min-h-[250px] place-items-center rounded-2xl border border-line bg-surface p-6 text-center shadow-sm">
        <div>
          <Users className="mx-auto h-9 w-9 text-fg-subtle" />
          <h2 className="mt-3 text-base font-semibold text-fg">Search for a person</h2>
          <p className="mt-1 text-sm font-normal text-fg-muted">The selected person details will appear here.</p>
        </div>
      </aside>
    );
  }

  const canOpenLive = Boolean(selected.monitorId);
  const recommendation = recommendationFor(selected);
  const recentPath = buildRecentPath(selected);
  const isLive = selected.status === 'live';

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">

      {/* ── Profile & real-time status ─────────────────────────────────── */}
      <div className="shrink-0 border-b border-line p-4">
        <div className="flex items-start gap-3">
          <Avatar person={selected} size="large" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold leading-tight text-fg sm:text-base">{selected.name}</h2>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-normal ${
                  isLive
                    ? 'border-success-line bg-success-soft text-success-ink'
                    : 'border-line bg-surface-muted text-fg-secondary'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-success' : 'bg-fg-subtle'}`} />
                {isLive ? 'On camera now' : `Last seen ${selected.lastSeen}`}
              </span>
            </div>
            <p className="mt-1 truncate text-xs font-normal text-fg-muted">
              {selected.externalId || 'No ID on file'}
              <span className="text-fg-subtle"> · </span>
              {selected.group ? `${selected.role} · ${selected.group}` : selected.role}
            </p>
          </div>
          {/* Only rendered in the drawer, where there is no other way out. */}
          {onClose ? (
            <button
              aria-label="Close"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-muted hover:text-fg lg:hidden"
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {canOpenLive ? (
            <Link
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-white shadow-sm transition hover:bg-brand-hover"
              title={`Open ${selected.lastCamera || 'this camera'} in Live View`}
              to={`/live?monitor=${encodeURIComponent(selected.monitorId)}`}
            >
              <Video className="h-4 w-4" />
              Live View
            </Link>
          ) : (
            <button
              className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg bg-brand-line px-3 text-sm font-medium text-white"
              disabled
              title="This person has no recent camera sighting on file"
              type="button"
            >
              <Video className="h-4 w-4" />
              Live View
            </button>
          )}
          <Link
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-brand/30 bg-surface px-3 text-sm font-medium text-brand-ink transition hover:bg-brand-soft"
            to={`/ai-event/journeymap?person_id=${encodeURIComponent(selected.id)}&q=${encodeURIComponent(selected.name)}`}
          >
            <Route className="h-4 w-4" />
            Journey Map
          </Link>
        </div>
      </div>

      {/* ── Everything below scrolls as one column ─────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">

        {/* Live camera feed. The same WebRTC player Live View uses, keyed by
            the monitor this person was last seen on — so it is the real
            stream, not a placeholder. */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
            <Video className="h-4 w-4 text-fg-muted" />
            {isLive ? 'Live camera feed' : 'Last camera'}
          </h3>
          <div className="relative overflow-hidden rounded-xl border border-line bg-slate-950">
            <div className="aspect-video w-full">
              {canOpenLive ? (
                <WebRTCStream className="h-full w-full object-cover" monitorId={selected.monitorId} />
              ) : (
                <div className="grid h-full place-items-center px-6 text-center">
                  <p className="text-sm font-normal text-white/60">
                    No camera sighting on file for this person yet.
                  </p>
                </div>
              )}
            </div>

            {/* Detection metadata over the feed: which camera, when, and how
                confident the match was. */}
            {canOpenLive ? (
              <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950/70 px-2.5 py-1.5 backdrop-blur">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-white">
                  <MapPin className="h-3.5 w-3.5 text-brand" />
                  {selected.location}
                </span>
                <span className="inline-flex items-center gap-2 text-xs font-medium text-white/70">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3.5 w-3.5" />
                    {selected.lastSeen}
                  </span>
                  <span className="rounded bg-brand px-1.5 py-0.5 text-xs font-semibold text-white">
                    {selected.confidence}
                  </span>
                </span>
              </div>
            ) : null}
          </div>
        </section>

        {/* Facts */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <InfoTile
            Icon={MapPin}
            label={isLive ? 'Currently on' : 'Last seen at'}
            value={selected.location}
          />
          <InfoTile Icon={Clock3} label="When" value={selected.lastSeen} />
          <InfoTile Icon={Video} label="Cameras in trail" value={`${selected.cameras} camera${selected.cameras === 1 ? '' : 's'}`} />
          <InfoTile
            Icon={Building2}
            label="Type"
            value={selected.group ? `${selected.role} · ${selected.group}` : selected.role}
          />
        </div>

        <div className={`mt-4 rounded-2xl border p-4 ${recommendation.tone}`}>
          <div className="flex items-start gap-3">
            <ShieldAlert className={`mt-0.5 h-5 w-5 shrink-0 ${recommendation.iconColor}`} />
            <div>
              <p className="text-sm font-semibold text-fg">{recommendation.title}</p>
              <p className="mt-1 text-sm font-normal leading-6 text-fg-secondary">{recommendation.body}</p>
            </div>
          </div>
        </div>

        {/* Movement log. Built from the last camera, its zone and the trail
            count the personnel API returns — this endpoint does not carry a
            per-detection history, so the full ordered route lives on Journey
            Map and is linked rather than invented here. */}
        {recentPath.length > 0 && (
          <section className="mt-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
              <Route className="h-4 w-4 text-fg-muted" />
              Recent movement
            </h3>
            <div className="relative space-y-3 rounded-2xl border border-line bg-surface-sunken p-4 pl-8">
              <span aria-hidden="true" className="absolute bottom-5 left-[21px] top-5 w-px bg-line-strong" />
              {recentPath.map((step, index) => (
                <div className="relative flex gap-3" key={`${step.label}-${index}`}>
                  <span className="absolute -left-[18px] top-1 h-2.5 w-2.5 rounded-full bg-brand ring-4 ring-surface-sunken" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-fg">{step.label}</p>
                    <p className="text-xs font-normal text-fg-muted">{step.sub}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function recommendationFor(person) {
  if (person.status === 'alert') {
    return {
      title: 'Needs your attention',
      body: 'This person was just seen in a sensitive area. Open the journey map to see how they got there before raising an alert.',
      tone: 'border-danger-line bg-danger-soft',
      iconColor: 'text-danger-ink',
    };
  }
  if (person.status === 'live') {
    return {
      title: 'Currently visible',
      body: 'They are on a live camera right now. Click Live to open the camera, or Journey to see the full route they took today.',
      tone: 'border-success-line bg-success-soft',
      iconColor: 'text-success-ink',
    };
  }
  if (person.enrollmentCount === 0) {
    return {
      title: 'Face data not enrolled',
      body: 'This person is in your records but has no face photo enrolled. Add a clear photo from Face Learning so the system can recognise them on cameras.',
      tone: 'border-warning-line bg-warning-soft',
      iconColor: 'text-warning-ink',
    };
  }
  return {
    title: 'No recent sighting',
    body: 'They have not been seen by any camera recently. Use the journey map to check their last known route, or wait for a fresh detection.',
    tone: 'border-line bg-surface-sunken',
    iconColor: 'text-fg-muted',
  };
}

function buildRecentPath(person) {
  const path = [];
  if (person.location && person.location !== 'No camera yet') {
    path.push({ label: person.location, sub: person.lastSeen || 'Most recent' });
  }
  if (person.lastCamera && person.lastCamera !== person.location) {
    path.push({ label: person.lastCamera, sub: 'Earlier on this camera' });
  }
  if (person.cameras > 1) {
    path.push({ label: 'Open Journey for the full route', sub: `${person.cameras} cameras in total` });
  }
  return path;
}

function PersonRow({ person, isSelected, onSelect }) {
  const meta = statusMeta[person.status] || statusMeta.offline;

  return (
    <article
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={`cursor-pointer rounded-xl border bg-surface p-3 transition hover:border-brand-line hover:shadow-sm ${
        isSelected ? 'border-brand bg-brand-soft/40 ring-2 ring-brand/30' : 'border-line'
      }`}
    >
      {/* Always stacked. This card lives in a one-third column at every
          breakpoint, so a `lg:flex-row` here reacted to the viewport rather
          than the space it actually has and crushed its own contents. */}
      <div className="flex items-start gap-3">
        <Avatar person={person} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-sm font-semibold leading-tight text-fg sm:text-base">{person.name}</h3>
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-normal ${meta.tone}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>
          </div>

          <p className="mt-0.5 truncate text-xs font-normal text-fg-muted">
            {person.externalId || 'No ID on file'}
            <span className="text-fg-subtle"> · </span>
            {person.group ? `${person.role} · ${person.group}` : person.role}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-line bg-surface-muted px-1.5 py-0.5 text-xs font-medium text-fg-secondary">
              <MapPin className="h-3 w-3 shrink-0 text-fg-subtle" />
              <span className="truncate">{person.location}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-fg-secondary">
              <Clock3 className="h-3 w-3 text-fg-subtle" />
              {person.lastSeen}
            </span>
            <span className="shrink-0 rounded-md bg-brand-soft px-1.5 py-0.5 text-xs font-semibold text-brand-ink">
              {person.confidence}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

function Avatar({ person, size = 'normal' }) {
  const large = size === 'large';
  return (
    <div className={`${large ? 'h-14 w-14 text-section' : 'h-11 w-11 text-body'} grid shrink-0 place-items-center rounded-2xl bg-slate-900 font-bold text-white dark:bg-surface-muted dark:text-fg`}>
      {person.avatar}
    </div>
  );
}

function InfoTile({ Icon, label, value }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-muted text-fg-secondary">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-small font-semibold uppercase tracking-wide text-fg-subtle">{label}</p>
        <p className="truncate text-body font-bold text-fg">{value}</p>
      </div>
    </div>
  );
}

function mapApiPerson(person) {
  const name = person.full_name || 'Unknown Person';
  // Friendly role: "unknown" → "Employee" by default, watchlist → "Watchlist",
  // staff/faculty → "Employee", student → "Student". Avoids the "Unknown -
  // Not assigned" string the UI used to show for every un-tagged person.
  const role = friendlyRole(person.role_label || person.role);
  const group = friendlyText(person.department || person.group) || '';
  const status = normalizeStatus(person.status);
  const similarity = Number(person.similarity);
  // friendlyCameraLabel falls back to "Camera <last-6-chars>" when both
  // name and code are raw monitor_ids — so the operator sees something
  // human-readable instead of a 24-char hex blob.
  const cameraLabel = friendlyCameraLabel(person.last_camera_name, person.last_camera_code);
  const zone = friendlyText(person.zone) || friendlyText(person.location);
  const locationParts = [cameraLabel, zone].filter(Boolean);
  const location = locationParts.join(' · ') || 'No camera yet';

  return {
    id: person.id,
    externalId: person.external_id,
    name,
    role,
    // If the backend didn't assign a department, blank it out so the UI
    // can show role alone instead of "Employee - Not assigned".
    group,
    status,
    location,
    locationZone: zone || '',
    lastSeen: person.last_seen_label || 'No recent sighting',
    confidence: Number.isFinite(similarity) ? `${Math.round(similarity * 100)}% match` : person.enrollment_count > 0 ? 'Enrolled' : 'Not enrolled',
    avatar: initials(name),
    note: status === 'alert'
      ? 'Needs security review'
      : status === 'live'
        ? 'Currently on camera'
        : person.enrollment_count > 0
          ? 'No recent sighting'
          : 'Face not enrolled yet',
    cameras: Number(person.cameras_seen || 0),
    enrollmentCount: Number(person.enrollment_count || 0),
    lastCamera: cameraLabel,
    // Live button passes this as ?monitor= to LiveView, which auto-selects
    // the camera whose monitorId matches. The personnel API returns the
    // Camera.code column here, which IS the monitor_id in our deployment.
    monitorId: person.last_camera_code || '',
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 24-char hex (Mongo ObjectId-style) is the monitor_id format the smart-cam
// stack auto-generates for Stream Service camera paths (rtsp://stream-service:8554/cam_<id>).
// When a camera is auto-created via /set-camera with no friendly name, both
// the Camera.name and Camera.code columns default to this raw id. Stripping
// it keeps the UI clean — `mapApiPerson` then falls back to "Camera <shortid>".
const MONITOR_ID_HEX_PATTERN = /^[0-9a-f]{24}$/i;

function friendlyText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (UUID_PATTERN.test(text)) return '';
  if (MONITOR_ID_HEX_PATTERN.test(text)) return '';
  return text;
}

// Map backend role enum to user-facing labels. "unknown" is the
// catch-all the AI service emits when the operator hasn't assigned
// a role yet; for the typical office VMS that's an Employee.
const ROLE_LABELS = {
  student:   'Student',
  staff:     'Employee',
  faculty:   'Employee',
  employee:  'Employee',
  visitor:   'Visitor',
  guest:     'Visitor',
  contractor: 'Contractor',
  blacklist: 'Watchlist',
  unknown:   'Employee',   // sensible default for office deployments
};
function friendlyRole(value) {
  const key = String(value || '').trim().toLowerCase();
  if (ROLE_LABELS[key]) return ROLE_LABELS[key];
  if (!key) return 'Employee';
  // Title-case anything we don't know about (so a custom role like "vendor"
  // shows as "Vendor", not blank).
  return key[0].toUpperCase() + key.slice(1);
}

// Friendly camera label: prefer the backend's name → code, and ONLY fall
// through to "Unnamed camera" when both are raw monitor_ids. Don't fabricate
// a fake name from a slice of the hex id — that misleads operators into
// thinking there's a real camera with that label. The right fix when this
// shows up is to set a real Camera.name in the backend (POST /cameras).
function friendlyCameraLabel(name, code) {
  const cleanName = friendlyText(name);
  if (cleanName) return cleanName;
  const cleanCode = friendlyText(code);
  if (cleanCode) return cleanCode;
  if (!name && !code) return '';
  return 'Unnamed camera';
}

function normalizeStatus(value) {
  if (value === 'alert' || value === 'live' || value === 'review' || value === 'offline') return value;
  return 'offline';
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'P';
}

function fmtNumber(value, digits = 0) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}
