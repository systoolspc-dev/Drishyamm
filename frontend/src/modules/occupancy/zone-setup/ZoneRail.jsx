/**
 * The zone rail -- the left sidebar of Zone Setup, and the ONLY place cameras,
 * zones and gates are paired up.
 *
 * Two readings of one many-to-many relation, behind a switch:
 *
 *   By camera   a tree. Each camera expands to the zones drawn on its view,
 *               its gate, and a row offering both of those on THIS camera.
 *               Cameras start folded -- only the one being edited is open --
 *               so a site with twenty cameras is twenty rows, not a page of
 *               scrolling.
 *   By zone     a flat list of zones, then a list of gates. What each is
 *               called and whether it is done, regardless of camera.
 *
 * A camera can carry zones and a gate at once: a zone counts who is standing
 * in a space, a gate counts who walked through a line. They are different
 * questions about the same picture -- so creating either one is offered in the
 * same place, in the same words, on the camera row it will be drawn on. There
 * is no rail-level "Add zone" any more: it created on "the camera being worked
 * on, or the first one", which is a guess, and it gave zones a front door that
 * gates never had.
 *
 * Deleting a zone is on the zone's own row, in both groupings, behind a ...
 * menu so the row itself stays a plain click that selects. It used to require
 * selecting the zone first and then finding Delete in the page header, which
 * is three steps and a page state change to remove one thing from a list.
 *
 * CREATING and DELETING use different affordances on purpose, and each exists
 * exactly once:
 *
 *   create   labelled chips inside the expanded camera. Two safe, frequent
 *            actions that benefit from saying their own names.
 *   remove   a ... menu on the row itself -- every row that stands for a
 *            thing has one. Rare, destructive, and it should not sit under
 *            the pointer on every row of a list.
 *
 * The two remove menus say different words on purpose. A zone is deleted; a
 * gate is only STOPPED, because the footfall service stores a gate as
 * `enabled` on a camera and has no delete. Switching it off does remove it
 * from every list here and from the dashboard -- but the line position and
 * today's counts survive, so calling it "delete" would promise more than
 * happens.
 *
 * A ... on the CAMERA row used to offer create as well, duplicating the chips
 * with different wording ("Set up as gate" against "Add gate"). It is gone.
 *
 * The remaining ... does NOT hide until hover: an affordance that appears only
 * once the pointer is already on it cannot be found by someone looking for it.
 *
 * Names WRAP rather than truncate. Camera names on real sites are long and
 * differ only at the end ("Office 12 Floor 3 Camera 02" vs "... Camera 03"),
 * so an ellipsis hides exactly the part that tells them apart.
 *
 * The swatch beside each zone under a camera is the stroke it is drawn in on
 * that camera's canvas. Both come from `colorsOnCamera`, so they cannot drift.
 *
 * ── Type and colour, so a new row does not have to guess ──────────────────
 * Every size here is a scale token, never a px literal (see index.css: the
 * rail alone used to carry six of them, 9.5 through 12). Four roles, one step
 * apart, and the whole set moved up a step once the rail was judged to be
 * reading at the bottom of the app's 11-13px band rather than the middle:
 *
 *   text-heading  15  a TOP-LEVEL row -- a camera in the tree, a zone in the
 *                     flat list, a gate in the gate list
 *   text-body     13  a CHILD row -- a zone or gate nested under its camera
 *   text-small    12  the second line under either: capacity, counts, state
 *   text-micro    10  an uppercase eyebrow (carries its own tracking and
 *                     weight, so never pair it with `tracking-wide`)
 *
 * Camera names at 15px wrap onto more lines than they used to in a 220-260px
 * rail. That is the intended trade -- see the note on wrapping above.
 *
 * Brand orange marks WHAT IS SET UP and WHAT CREATES something -- the zone
 * count on a camera that has zones, and the Add zone / Add gate chips. The
 * status dot stays green / amber / grey: it answers a different question
 * (is this camera live) and painting it the accent colour would delete the
 * answer.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Camera, CameraOff, CheckCircle2, ChevronRight, Circle, DoorOpen, Ellipsis, Layers, Lock, MapPin, Plus, Search,
  Trash2, Video, Wrench,
} from 'lucide-react';
import { Button } from '@/core/ui/button';
import { EmptyState, LoadingState } from '@/core/ui/states';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import Panel from '@/core/ui/panel';
import { PROFILE_BY_ID, nfmt } from '../occupancy-data';
import { colorsOnCamera, zonesOnCamera } from '../zone-model';
import { ACCESS_MODE_BY_ID } from './access-data';

const MODES = [
  { id: 'camera', label: 'By camera', Icon: Video },
  { id: 'zone', label: 'By zone', Icon: Layers },
];

const ROW = 'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition';
const ROW_ON = 'border-brand bg-brand-soft';
const ROW_OFF = 'border-transparent hover:border-line hover:bg-surface-sunken';

// The ... trigger on a row. Always visible (see the note at the top of this
// file) and absolutely placed, so the row behind it stays one wide click that
// selects rather than being split into two hit areas.
const MENU_BTN = 'absolute rounded-md p-1 text-fg-muted transition hover:bg-surface hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand data-[state=open]:bg-surface data-[state=open]:text-brand-ink';

export default function ZoneRail({
  mode, onMode, cameras, zones, saved, regionZones, gates = {}, pendingId = null,
  activeZoneId, activeCam, activeGate, onPick, onAddZone, onDeleteZone, onPickGate, onStopGate, ready,
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const configured = Object.keys(saved).length;
  const gateCount = Object.values(gates).filter((g) => g.enabled).length;

  return (
    <div className="flex flex-col gap-2 xl:h-full xl:min-h-0">
      <Panel
        bodyClass="flex flex-col p-2 xl:min-h-0"
        className="xl:min-h-0 xl:flex-1"
        fill={false}
        icon={MapPin}
        right={
          <span className="text-right text-small font-semibold text-fg-subtle">
            {configured} zone{configured === 1 ? '' : 's'} · {gateCount} gate{gateCount === 1 ? '' : 's'} · {cameras.length} cam{cameras.length === 1 ? '' : 's'}
          </span>
        }
        title="Setup"
      >
        <div aria-label="Group by" className="mb-2 grid shrink-0 grid-cols-2 gap-0.5 rounded-lg bg-surface-sunken p-0.5" role="tablist">
          {MODES.map((m) => (
            <button
              aria-selected={mode === m.id}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-body font-semibold transition ${
                mode === m.id ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-muted hover:text-fg'
              }`}
              key={m.id}
              onClick={() => onMode(m.id)}
              role="tab"
              type="button"
            >
              <m.Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              {m.label}
            </button>
          ))}
        </div>

        {cameras.length ? (
          <label className="relative mb-2 flex shrink-0 items-center">
            <span className="sr-only">Search cameras and zones</span>
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" strokeWidth={2.25} />
            <input
              className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2 text-body text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cameras or zones…"
              type="search"
              value={query}
            />
          </label>
        ) : null}

        <div className="min-h-0 flex-1 xl:overflow-y-auto">
        {!cameras.length ? (
          ready ? (
            /* A dead end told the operator what was missing and left them to
               find the fix. The rail is 220-330px, so this is the compact
               EmptyState: short copy, `sm` button, no second action. */
            <EmptyState
              action={(
                <Button asChild size="sm">
                  <Link to="/camera-setup?tab=cameras">
                    <Wrench />
                    Go to Camera Setup
                  </Link>
                </Button>
              )}
              className="px-3 py-8"
              description="Zones and gates are drawn on a camera's view, so this site needs one first."
              icon={CameraOff}
              title="No cameras yet"
            />
          ) : (
            <LoadingState className="py-8" />
          )
        ) : mode === 'camera' ? (
          <CameraTree
            activeCam={activeCam}
            activeGate={activeGate}
            activeZoneId={activeZoneId}
            cameras={cameras}
            gates={gates}
            onAddZone={onAddZone}
            onDeleteZone={onDeleteZone}
            onPick={onPick}
            onPickGate={onPickGate}
            onStopGate={onStopGate}
            pendingId={pendingId}
            query={q}
            saved={saved}
            zones={zones}
          />
        ) : (
          <>
            <ZoneList
              activeZoneId={activeZoneId}
              onDeleteZone={onDeleteZone}
              onMode={onMode}
              onPick={onPick}
              pendingId={pendingId}
              query={q}
              regionZones={regionZones}
              saved={saved}
              zones={zones}
            />
            <GateList
              activeGate={activeGate}
              cameras={cameras}
              gates={gates}
              onMode={onMode}
              onPickGate={onPickGate}
              onStopGate={onStopGate}
              query={q}
            />
          </>
        )}
        </div>
      </Panel>

    </div>
  );
}

// ── By camera ───────────────────────────────────────────────────────────────

function CameraTree({
  cameras, zones, saved, gates, activeZoneId, activeCam, activeGate, pendingId,
  onPick, onAddZone, onDeleteZone, onPickGate, onStopGate, query,
}) {
  // Folded by default: the camera being edited is opened for the operator,
  // and whatever else they open stays open while they work.
  const current = activeGate || activeCam;
  const [expanded, setExpanded] = useState(() => new Set(current ? [current] : []));
  // Opened during render, not in an effect, so a newly picked camera never
  // paints one frame folded.
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    if (current && !expanded.has(current)) setExpanded(new Set(expanded).add(current));
  }
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // A search opens every camera it matches, and shows only the zones that
  // matched unless the camera's own name did.
  const rows = cameras.map((c) => {
    const all = zonesOnCamera(zones, c.id);
    if (!query) return { c, onCam: all };
    const camHit = c.label.toLowerCase().includes(query);
    const hits = all.filter((z) => (z.name || '').toLowerCase().includes(query));
    return camHit || hits.length ? { c, onCam: camHit ? all : hits } : null;
  }).filter(Boolean);

  if (!rows.length) {
    return <p className="px-2 py-6 text-center text-body text-fg-subtle">No camera or zone matches.</p>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map(({ c, onCam }) => {
        const colors = colorsOnCamera(zones, c.id);
        const open = Boolean(query) || expanded.has(c.id);
        const here = c.id === current;
        const gate = gates[c.id];
        const state = !c.counting ? 'counting off' : c.offline ? 'offline' : 'live';
        return (
          <li key={c.id}>
            <div className="group relative flex items-start">
              <button
                aria-expanded={open}
                className={`flex min-w-0 flex-1 items-start gap-1.5 rounded-lg py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-sunken ${
                  here ? 'text-fg' : 'text-fg-secondary'
                }`}
                onClick={() => toggle(c.id)}
                title={`${c.label} · ${state}`}
                type="button"
              >
                <ChevronRight
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-90' : ''}`}
                  strokeWidth={2.5}
                />
                <Camera className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${here ? 'text-brand' : 'text-fg-muted'}`} strokeWidth={2} />
                <span className="min-w-0 flex-1 break-words text-heading font-bold leading-snug">{c.label}</span>
                {gate?.enabled ? <DoorOpen className="mt-0.5 h-3 w-3 shrink-0 text-brand" strokeWidth={2.5} /> : null}
                {/* Brand, not grey, once the camera carries something. The
                    rail lost its one orange element when the full-width "Add
                    zone" button went; this puts the accent on the fact that
                    actually matters -- which cameras are set up. */}
                <span
                  aria-label={`${onCam.length} zone${onCam.length === 1 ? '' : 's'}`}
                  className={`mt-px shrink-0 rounded-full px-1.5 text-small font-bold tabular-nums ring-1 ${
                    onCam.length ? 'bg-brand-soft text-brand-ink ring-brand-line' : 'text-fg-disabled ring-transparent'
                  }`}
                >
                  {onCam.length}
                </span>
                {/* Live / offline / not counting. These three keep the app's
                    semantic hues rather than the brand orange: an orange "it
                    is live" dot beside an orange "it is offline" dot is not a
                    status light, it is decoration. Grown from 6px to 8px --
                    the thing it was hardest to read was its size, not its
                    colour. */}
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${!c.counting ? 'bg-line-strong' : c.offline ? 'bg-warning' : 'bg-success'}`}
                  title={`${c.label} · ${state}`}
                />
              </button>
            </div>

            {open ? (
              <ul className="ml-[13px] mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
                {onCam.map((z) => {
                  const on = !activeGate && z.id === activeZoneId && here;
                  const isSaved = Boolean(saved[z.id]);
                  const label = z.name || (isSaved ? 'Unnamed zone' : 'New zone');
                  // Only what exists can be deleted: a stored zone, or the one
                  // the operator just created and has not saved. A camera's
                  // implicit whole-view zone is derived from the camera, so a
                  // delete on it would appear to do nothing -- the row would
                  // still be there on the next render.
                  const removable = isSaved || z.id === pendingId;
                  return (
                    <li key={z.id}>
                      <div className="relative flex items-start">
                        <button
                          aria-current={on ? 'true' : undefined}
                          className={`${ROW} ${removable ? 'pr-8' : ''} ${on ? ROW_ON : ROW_OFF}`}
                          onClick={() => onPick(z.id, c.id)}
                          type="button"
                        >
                          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-black/20" style={{ background: colors[z.id] }} />
                          <span className="min-w-0 flex-1">
                            <span className={`block break-words text-body font-semibold leading-snug ${on ? 'text-brand-ink' : 'text-fg'}`}>
                              {label}
                            </span>
                            <span className="block text-small text-fg-subtle">
                              {isSaved ? (Number(z.maxCapacity) > 0 ? `cap ${nfmt(z.maxCapacity)}` : 'no limit') : 'not saved yet'}
                              {z.cameras.length > 1 ? ` · spans ${z.cameras.length} cams` : ''}
                            </span>
                          </span>
                        </button>
                        {removable ? (
                          <ZoneRowMenu
                            className="right-0.5 top-1"
                            name={label}
                            onDelete={() => onDeleteZone({ id: z.id, name: z.name, cameras: z.cameras })}
                            unsaved={!isSaved}
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}

                {!onCam.length ? (
                  // A camera with no zone still counts -- its whole view is an
                  // implicit zone under the camera's own id -- so it opens
                  // like any other, and saving it makes it a real one. No
                  // delete on this row: there is nothing stored to delete.
                  <li>
                    <button
                      aria-current={!activeGate && activeZoneId === c.id ? 'true' : undefined}
                      className={`${ROW} ${!activeGate && activeZoneId === c.id ? ROW_ON : ROW_OFF}`}
                      onClick={() => onPick(c.id, c.id)}
                      type="button"
                    >
                      <Circle className="mt-1 h-2.5 w-2.5 shrink-0 text-fg-disabled" strokeWidth={2.5} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-semibold text-fg-secondary">Whole camera view</span>
                        <span className="block text-small text-fg-subtle">{c.counting ? 'Not configured' : 'Not counting yet'}</span>
                      </span>
                    </button>
                  </li>
                ) : null}

                {gate?.enabled ? (
                  <li>
                    <div className="relative flex items-start">
                      <button
                        aria-current={activeGate === c.id ? 'true' : undefined}
                        className={`${ROW} pr-8 ${activeGate === c.id ? ROW_ON : ROW_OFF}`}
                        onClick={() => onPickGate(c.id)}
                        type="button"
                      >
                        <DoorOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-body font-semibold ${activeGate === c.id ? 'text-brand-ink' : 'text-fg'}`}>Gate</span>
                          <span className="block text-small tabular-nums text-fg-subtle">
                            {nfmt(gate.in)} in · {nfmt(gate.out)} out today
                          </span>
                        </span>
                      </button>
                      <GateRowMenu
                        className="right-0.5 top-1"
                        name={`the gate on ${c.label}`}
                        onStop={() => onStopGate({ monitorId: c.id, cameraId: gate.cameraId, name: c.label })}
                      />
                    </div>
                  </li>
                ) : null}

                {/* The ONLY way to create either thing, and both are offered
                    on the camera they will be drawn on, in the same words and
                    the same weight.

                    This replaced a rail-level "Add zone" button that created
                    on "the camera being worked on, or the first one" -- a
                    guess -- and that gave zones a front door gates never had.
                    A duplicate of these two also lived in a ... menu on the
                    camera row above; it was deleted rather than these because
                    a labelled chip says what it does and a glyph does not,
                    and the click cost is identical either way: (... -> item)
                    against (expand camera -> chip), since the camera row
                    toggles open on click. */}
                <li className="flex flex-wrap items-center gap-1 pb-0.5 pt-0.5">
                  <CreateAction icon={Plus} onClick={() => onAddZone(c.id)}>Add zone</CreateAction>
                  <CreateAction icon={DoorOpen} onClick={() => onPickGate(c.id)}>
                    {gate?.enabled ? 'Edit gate' : 'Add gate'}
                  </CreateAction>
                </li>
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The per-row ... menu. One destructive item today, but a menu rather than a
 * bare bin icon: a bin sitting on every row of a list is a mis-click waiting
 * to happen, and the menu is where "rename" and "duplicate" will go without
 * the row growing a second icon each time.
 *
 * `unsaved` changes the word, not the action -- discarding a draft and
 * deleting a stored zone go through the same call, and the confirm spells out
 * which one is happening.
 */
function ZoneRowMenu({ name, onDelete, unsaved, className }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Actions for ${name}`}
          className={`${MENU_BTN} ${className}`}
          title={`Actions for ${name}`}
          type="button"
        >
          <Ellipsis className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="max-w-[16rem] truncate text-body font-semibold text-fg-muted">
          {name}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" strokeWidth={2.25} />
          <span className="text-body">{unsaved ? 'Discard zone' : 'Delete zone'}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The gate row's ... menu, so a gate can be stopped from the rail the way a
 * zone can be deleted from it. Before this, the only way was to open the gate
 * and find "Stop counting at this gate" in the page header -- three steps, and
 * you had to leave whatever you were doing.
 *
 * It says STOP COUNTING, not Delete, and that is not softening. The footfall
 * service has no delete: a gate is a camera with counting switched on, and
 * switching it off is the whole of the operation. The wording matches what
 * actually happens, and the confirm spells out the two things that survive.
 */
function GateRowMenu({ name, onStop, className }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Actions for ${name}`}
          className={`${MENU_BTN} ${className}`}
          title={`Actions for ${name}`}
          type="button"
        >
          <Ellipsis className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="max-w-[16rem] truncate text-small font-semibold text-fg-muted">
          {name}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onStop} variant="destructive">
          <DoorOpen className="h-3.5 w-3.5" strokeWidth={2.25} />
          <span className="text-body">Stop counting</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Add zone" / "Add gate" on a camera row: quiet until wanted, never hidden. */
function CreateAction({ icon: Icon, onClick, children }) {
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md border border-brand-line bg-brand-soft px-2 py-1 text-small font-bold text-brand-ink transition hover:border-brand hover:bg-brand hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      onClick={onClick}
      type="button"
    >
      <Icon className="h-3 w-3 shrink-0" strokeWidth={2.5} />
      {children}
    </button>
  );
}

// ── By zone ─────────────────────────────────────────────────────────────────

function ZoneList({
  regionZones, zones, saved, activeZoneId, pendingId, onPick, onDeleteZone, onMode, query,
}) {
  // The live list, plus the zone being drafted if it has not been saved yet:
  // a zone that vanished from the rail the moment it was created would read
  // as a failed click.
  const rows = regionZones.map((z) => ({ id: z.id, label: z.label, locked: z.locked, capacity: z.capacity, cameras: z.cameraIds }));
  const draft = zones[activeZoneId];
  if (draft && !rows.some((r) => r.id === draft.id)) {
    rows.push({ id: draft.id, label: draft.name || 'New zone', capacity: Number(draft.maxCapacity) || 0, cameras: draft.cameras });
  }

  const ordered = rows.map((z) => {
    const room = saved[z.id];
    // A zone synced from the server carries no profile -- that field has no
    // column there -- so the subtitle degrades to the next most useful fact
    // rather than printing "Not configured" beside a green tick.
    const profile = PROFILE_BY_ID[room?.profile];
    const mode = ACCESS_MODE_BY_ID[room?.access?.mode];
    return {
      ...z,
      configured: Boolean(room),
      subtitle: profile?.label || (room ? (mode?.label || 'Configured') : 'Not configured'),
      capacity: Number(room?.maxCapacity) || z.capacity || 0,
    };
  }).filter((z) => !query || z.label.toLowerCase().includes(query))
    .sort((a, b) => Number(a.configured) - Number(b.configured) || a.label.localeCompare(b.label));

  if (!ordered.length) {
    // A zone is always drawn on a camera, so there is nothing to offer here
    // except the grouping that has cameras in it. Saying that beats an empty
    // list, which reads as "this feature is broken".
    return (
      <p className="px-2 py-6 text-center text-body leading-relaxed text-fg-subtle">
        {query ? 'No zone matches.' : (
          <>
            No zones yet.
            <button
              className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-line bg-brand-soft px-2 py-2 text-body font-bold text-brand-ink transition hover:border-brand hover:bg-brand hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => onMode('camera')}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
              Add a zone to a camera
            </button>
          </>
        )}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {ordered.map((z) => {
        const on = z.id === activeZoneId;
        // Only what exists can be deleted: a stored zone, or the one just
        // created and not yet saved. A zone the cameras report but nothing
        // here stores has no record to remove, and a delete that quietly does
        // nothing is worse than no delete at all.
        const removable = Boolean(saved[z.id]) || z.id === pendingId;
        return (
          <li key={z.id}>
            <div className="relative flex items-start">
              <button
                aria-current={on ? 'true' : undefined}
                className={`flex w-full items-start gap-2 rounded-lg border py-2 pl-2.5 text-left transition ${removable ? 'pr-8' : 'pr-2.5'} ${on ? ROW_ON : ROW_OFF}`}
                onClick={() => onPick(z.id, z.cameras?.[0])}
                type="button"
              >
                {z.configured
                  ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.25} />
                  : <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-fg-disabled" strokeWidth={2} />}
                <span className="min-w-0 flex-1">
                  <span className={`block break-words text-heading font-semibold leading-snug ${on ? 'text-brand-ink' : 'text-fg'}`}>
                    {z.label}
                  </span>
                  <span className="mt-0.5 block text-small text-fg-subtle">
                    {z.subtitle}
                    {z.capacity > 0 ? ` · cap ${nfmt(z.capacity)}` : ''}
                    {z.cameras?.length > 1 ? ` · ${z.cameras.length} cams` : ''}
                  </span>
                </span>
                {z.locked ? <Lock className="mt-px h-3 w-3 shrink-0 text-danger" strokeWidth={2.5} /> : null}
              </button>
              {removable ? (
                <ZoneRowMenu
                  className="right-1 top-1.5"
                  name={z.label || 'Unnamed zone'}
                  onDelete={() => onDeleteZone({ id: z.id, name: z.label, cameras: z.cameras })}
                  unsaved={!saved[z.id]}
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** "By zone" mode's second group: every counting gate, by its camera's name. */
function GateList({
  gates, cameras, activeGate, onPickGate, onStopGate, onMode, query,
}) {
  const rows = cameras.filter((c) => gates[c.id]?.enabled && (!query || c.label.toLowerCase().includes(query)));
  return (
    <div className="mt-3 border-t border-line-subtle pt-2">
      <p className="flex items-center gap-1.5 px-1 pb-1.5 text-micro font-bold uppercase text-fg-subtle">
        <DoorOpen className="h-3 w-3" strokeWidth={2.5} />
        Gates
      </p>
      {rows.length ? (
        <ul className="flex flex-col gap-1">
          {rows.map((c) => {
            const on = c.id === activeGate;
            const g = gates[c.id];
            return (
              <li key={c.id}>
                <div className="relative flex items-start">
                  <button
                    aria-current={on ? 'true' : undefined}
                    className={`flex w-full items-start gap-2 rounded-lg border py-2 pl-2.5 pr-8 text-left transition ${on ? ROW_ON : ROW_OFF}`}
                    onClick={() => onPickGate(c.id)}
                    type="button"
                  >
                    <DoorOpen className="mt-px h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
                    <span className="min-w-0 flex-1">
                      <span className={`block break-words text-heading font-semibold leading-snug ${on ? 'text-brand-ink' : 'text-fg'}`}>{c.label}</span>
                      <span className="mt-0.5 block text-small tabular-nums text-fg-subtle">{nfmt(g.in)} in · {nfmt(g.out)} out today</span>
                    </span>
                  </button>
                  <GateRowMenu
                    className="right-1 top-1.5"
                    name={`the gate on ${c.label}`}
                    onStop={() => onStopGate({ monitorId: c.id, cameraId: g.cameraId, name: c.label })}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        // It used to describe the route -- "switch to By camera and pick Set
        // up as gate from a camera's menu" -- which is an instruction for
        // something the page could just do. A gate needs a camera chosen, so
        // this hands the operator the grouping that has cameras in it.
        <div className="px-1 pb-1">
          <p className="text-small leading-relaxed text-fg-subtle">
            {query ? 'No gate matches.' : 'No gate is counting yet. A gate is a line across one camera\u2019s view, counting everyone who crosses it.'}
          </p>
          {query ? null : (
            <button
              className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-line bg-brand-soft px-2 py-2 text-body font-bold text-brand-ink transition hover:border-brand hover:bg-brand hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onClick={() => onMode('camera')}
              type="button"
            >
              <DoorOpen className="h-3.5 w-3.5" strokeWidth={2.25} />
              Add a gate to a camera
            </button>
          )}
        </div>
      )}
    </div>
  );
}
