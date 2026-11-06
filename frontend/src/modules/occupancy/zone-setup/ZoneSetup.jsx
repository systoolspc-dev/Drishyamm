/**
 * Zone Setup & Behavior Configuration — /occupancy/zone-setup
 *
 * Two halves, both live at once:
 *
 *   THE PAGE    where the zone IS   — the polygon on each camera that sees it
 *   THE DRAWER  what the zone DOES  — capacity, dwell, schedule, who may enter
 *
 * Both reachable at once rather than one step at a time, because the two are
 * read against each other. "Max 3 people" means nothing until you can see the
 * shape it applies to, and "restricted to IT" is unanswerable while the
 * boundary is off screen. A wizard made the operator hold one half in their
 * head while editing the other.
 *
 * The rules were a third COLUMN until they were measured against how often
 * each half is touched: the shape is drawn against the picture continuously,
 * the rules are set once. So they moved into a right-hand drawer
 * (RulesDrawer.jsx) that opens over the canvas without freezing it, and the
 * 320-380px they were holding went back to the picture. The drawer's trigger
 * in the page header carries the live capacity badge, so the one fact that
 * moves is readable with the drawer shut.
 *
 * Cameras and zones are many-to-many (see zone-model.js): one wide shot can
 * hold several zones, and one hall can need several cameras. Both sides of that
 * are edited where they are seen --
 *
 *   the RAIL      groups by camera (a tree, with per-camera "Add zone" and
 *                 "Add gate" chips inside each expanded camera) or by zone
 *                 (a flat list), behind one switch. Creating is a labelled
 *                 chip; removing is a ... menu on the row itself -- "Delete
 *                 zone" on a zone, "Stop counting" on a gate, because a gate
 *                 cannot be deleted, only switched off.
 *   the CANVAS    draws every zone on the current view at once, each in its
 *                 own colour; the bar above it picks the view and the zone
 *
 * -- which is what made the separate Camera Mapping card redundant: it asked
 * the same question in a list far from the picture, and the canvas could only
 * ever show one of its answers.
 *
 * The page asks in the order a zone becomes useful, and no further:
 *
 *   1  Draw & name   the shape on each view, and what to call it
 *   2  Capacity      the limit and the warning line, in the drawer -- then
 *      & rules       Save, which is on the page header and nowhere else.
 *                    Everything past capacity is closed by default: a zone
 *                    counts without any of it
 *
 * No wizard and no Next buttons. An existing zone opens on the same layout
 * with its values in place, because editing one number should not mean
 * stepping through five screens.
 *
 * The canvas flips between DRAW and LIVE on the same camera and the same
 * polygon, so a rule can be checked against the building while it is being
 * written. The record of what rules have caught lives on the Breaches page,
 * which is for watching; this page is for setting up.
 *
 * A camera can also be a GATE -- a line across its view, counting everyone who
 * crosses it IN or OUT. That is gate mode (GateEditor.jsx), opened from the
 * rail, and it shares this page's frame so switching between a zone and a gate
 * on the same camera does not change the page under the operator.
 *
 * Selection lives in the URL (`?zone=&cam=&group=`, or `?gate=` for gate
 * mode), so a link from the dashboard opens the right thing, and a reload
 * keeps it. `zone` and `gate` are never set together: one thing is edited at
 * a time, and moving between them goes through the unsaved-changes prompt.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight, CameraOff, CircleHelp, Loader2, MapPin, PenTool, Save, ScanEye, Trash2, Waypoints, Wrench,
} from 'lucide-react';
import { Button } from '@/core/ui/button';
import { EmptyState, LoadingState } from '@/core/ui/states';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import {
  OperationsPage, PageContent, PageAction,
} from '@/core/layout/OperationsPage';
import Panel from '@/core/ui/panel';
import ConfirmDialog from '@/core/ui/confirm-dialog';
import ZoneCanvas from '@/modules/headcount/ZoneCanvas';
import { aiService } from '@/core/services/ai';
import { useOccupancy } from '../useOccupancy';
import { defaultRoom, removeRoom, saveRoom } from '../room-settings';
import {
  boundaryOn, colorsOnCamera, hasShape, newZoneId, zoneProblems, zonesOnCamera,
} from '../zone-model';
import ZoneRail from './ZoneRail';
import CanvasBar from './CanvasBar';
import { ZoneIdentityFields } from './StepBehaviour';
import RulesDrawer from './RulesDrawer';
import DetectionOverlay from './DetectionOverlay';
import CleanFeed from './CleanFeed';
import GateEditor from './GateEditor';
import GateLineEditor from './GateLineEditor';
import {
  CanvasFrame, ResultNote, SetupGrid, SetupHeader, StepTitle,
} from './SetupChrome';
import { useZoneDetections } from './useZoneDetections';
import { defaultAccess } from './access-data';

// What the canvas shows. The zone's shape and the camera's entry line are
// drawn on the same picture, so they are two tools on one canvas, not two pages.
const CANVAS_MODES = [
  ['draw', 'Zone area', 'Draw the zone boundary'],
  ['line', 'Entry line', 'Place a line that counts people IN and OUT (footfall)'],
  ['live', 'Live', 'Watch live detections against this zone'],
];

const LEAVE_UNSAVED = 'This zone has unsaved changes. Leave it without saving?';

/**
 * Resolves which zone is being configured and mounts the editor on it.
 *
 * The split exists so the draft can be seeded by a lazy initialiser keyed on
 * the zone: copying a zone into state from an effect would render one frame of
 * the wrong zone's numbers under the right zone's name, and would quietly
 * overwrite unsaved edits the next time the list reloaded.
 */
export default function ZoneSetup() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  // Live polling off: this page writes rules. The zone list still loads once,
  // so the camera registry and the current counts are real.
  const {
    regionZones, cameras, camByMonitor, rooms: saved, setRooms, gates, refreshGates, ready, errors,
  } = useOccupancy({ live: false });
  // The footfall camera list could not be read. Every camera then looks
  // unknown to the service, so the gate editors must say the service is down
  // rather than blame the camera (2026-10-27: a clock drift 401'd the list and
  // the page told operators their cameras were not registered).
  const footfallDown = Boolean(errors?.footfall);

  // A zone created from "+ Add zone" exists only here until its first save.
  const [pending, setPending] = useState(null);
  const [flash, setFlash] = useState(null);
  // The editor reports unsaved edits here, so moving to another zone -- from
  // the rail or the canvas bar -- can ask before discarding them.
  const dirtyRef = useRef(false);

  const group = params.get('group') === 'zone' ? 'zone' : 'camera';
  const gateCam = params.get('gate');
  const gateCamera = gateCam ? cameras.find((c) => c.id === gateCam) : null;
  const editing = params.get('zone');
  const zone = regionZones.find((z) => z.id === editing)
    || (pending?.id === editing ? pending : null)
    // Saved, but none of its cameras is counting right now. Still editable,
    // so a link to it does not silently open some other zone.
    || (saved[editing] ? {
      id: editing, cameraIds: saved[editing].cameras, label: saved[editing].name, count: 0, capacity: 0,
    } : null)
    // A camera that is not counting yet has no live zone, but it can still be
    // opened: its whole view is where its first zone gets drawn.
    || cameraZone(cameras.find((c) => c.id === editing))
    || regionZones[0]
    || cameraZone(cameras[0])
    || null;

  const go = (patch) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) p.delete(k); else p.set(k, v);
    }
    return p;
  }, { replace: true });

  const guard = (fn) => (...args) => {
    if (dirtyRef.current && !window.confirm(LEAVE_UNSAVED)) return;
    dirtyRef.current = false;
    setFlash(null);
    fn(...args);
  };

  const switchZone = guard((id, cam) => go({ zone: id, cam: cam || null, gate: null }));
  // The same zone under another camera is only a change of view: nothing is
  // discarded, so nothing is asked.
  const pickZone = (id, cam) => (!gateCam && id === zone?.id ? go({ cam: cam || null }) : switchZone(id, cam));
  const pickGate = guard((m) => go({ gate: m, zone: null, cam: null }));

  const addZone = guard((cam) => {
    const id = newZoneId();
    setPending({
      id,
      cameraIds: [cam],
      label: '',
      count: 0,
      capacity: 0,
      floor: camByMonitor[cam]?.groupName || '',
    });
    go({ zone: id, cam, gate: null });
  });

  const cancel = () => navigate('/occupancy');
  const onGroup = (g) => go({ group: g === 'camera' ? null : g });

  // ── Deleting a zone ───────────────────────────────────────────────────────
  // One implementation behind both doors -- the row menu in the rail and the
  // button in the zone header -- because two deletes drift into two ideas of
  // what deleting leaves behind. `deleting` only holds the target while the
  // confirm is up; nothing is touched until it resolves.
  const [deleting, setDeleting] = useState(null);

  const nameOfCam = (m) => cameras.find((c) => c.id === m)?.label || camByMonitor[m]?.name || m;

  /**
   * What every delete ends with. Only the zone ON SCREEN loses the editor:
   * deleting some other zone from the rail must not move the operator off the
   * one they are working on, and leaving `?zone=` pointed at a dead id would
   * open the editor on nothing.
   */
  const onZoneDeleted = (rooms, message, deletedId) => {
    setRooms(rooms);
    setFlash(message);
    if (pending?.id === deletedId) setPending(null);
    if (!gateCam && deletedId === zone?.id) {
      dirtyRef.current = false;
      go({ zone: null, cam: null });
    }
  };

  /**
   * Ask first. The target is described rather than pointed at, because the row
   * that asked may be a draft the store has never seen -- and because the
   * camera names have to be read now, while the zone still lists them.
   */
  const askDelete = ({ id, name, cameras: cams }) => setDeleting({
    id,
    name: name || 'this zone',
    // Never saved: nothing is armed on a camera, and the server has no id for
    // it. Deleting it is discarding a draft, and the dialog says so.
    unsaved: !saved[id],
    cameraNames: [...new Set(cams?.length ? cams : (saved[id]?.cameras || []))].map(nameOfCam),
  });

  /** Remove it everywhere `removeRoom` reaches: here, the server, every camera. */
  const runDelete = async () => {
    const t = deleting;
    if (!t) return;
    if (t.unsaved) {
      // Calling the API here would ask the server to delete an id it was never
      // told about, and would rewrite cameras holding nothing of this zone.
      // Dropping the draft IS the delete.
      onZoneDeleted(saved, `${t.name} discarded. It was never saved.`, t.id);
      return;
    }
    const res = await removeRoom(t.id, { registry: camByMonitor });
    onZoneDeleted(res.rooms, res.error || `${t.name} deleted.`, t.id);
  };

  // ── Stopping a gate ───────────────────────────────────────────────────────
  // The footfall service has no delete: a gate IS a camera with counting
  // switched on, so switching it off is the whole operation. Everything that
  // lists gates -- both rail groupings, the rail's counter, the dashboard's
  // Gate Activity Matrix -- filters on `enabled`, so the gate leaves the
  // product; only the line position and today's history survive. The confirm
  // says both, because "Stop counting" should not have to be trusted blindly.
  const [stopping, setStopping] = useState(null);

  const askStopGate = (target) => setStopping(target);

  const runStopGate = async () => {
    const t = stopping;
    if (!t?.cameraId) return;
    await aiService.footfallPutConfig(t.cameraId, { enabled: false });
    refreshGates();
    setFlash(`${t.name} is no longer counting as a gate.`);
    // Standing in the editor of the gate just stopped would leave the operator
    // looking at a line that counts nothing.
    if (gateCam === t.monitorId) {
      dirtyRef.current = false;
      go({ gate: null });
    }
  };

  const stopGateDialog = (
    <StopGateDialog onCancel={() => setStopping(null)} onConfirm={runStopGate} target={stopping} />
  );

  const deleteDialog = (
    <DeleteZoneDialog onCancel={() => setDeleting(null)} onConfirm={runDelete} target={deleting} />
  );

  if (gateCamera) {
    const colors = colorsOnCamera(saved, gateCam);
    return (
      <>
        <GateEditor
          cameraName={gateCamera.label}
          dirtyRef={dirtyRef}
          flash={flash}
          footfallDown={footfallDown}
          gate={gates[gateCam]}
          key={`gate:${gateCam}`}
          monitorId={gateCam}
          onCancel={cancel}
          onSaved={refreshGates}
          others={zonesOnCamera(saved, gateCam).map((z) => ({
            id: z.id, name: z.name, color: colors[z.id], points: boundaryOn(z, gateCam),
          }))}
          rail={(
            <ZoneRail
              activeGate={gateCam}
              cameras={cameras}
              gates={gates}
              mode={group}
              onAddZone={addZone}
              onDeleteZone={askDelete}
              onMode={onGroup}
              onPick={pickZone}
              onPickGate={pickGate}
              onStopGate={askStopGate}
              pendingId={pending?.id || null}
              ready={ready}
              regionZones={regionZones}
              saved={saved}
              zones={saved}
            />
          )}
        />
        {deleteDialog}
        {stopGateDialog}
      </>
    );
  }

  // A gate link can arrive before the camera list has loaded.
  if (!zone || (gateCam && !ready)) {
    return (
      <OperationsPage>
        <SetupHeader onCancel={cancel} />
        <PageContent scroll>
          <Panel bodyClass="p-4" icon={MapPin} title="Zones">
            {ready ? (
              /* Same empty state as the rail, at full width: a panel on an
                 otherwise blank page can afford the sentence and the arrow. */
              <EmptyState
                action={(
                  <Button asChild>
                    <Link to="/camera-setup?tab=cameras">
                      <Wrench />
                      Go to Camera Setup
                      <ArrowRight />
                    </Link>
                  </Button>
                )}
                description="Zones and gates are drawn on a camera's view. Add a camera to this site to start drawing them."
                icon={CameraOff}
                title="No cameras on this site"
              />
            ) : (
              <LoadingState className="py-10" />
            )}
          </Panel>
        </PageContent>
      </OperationsPage>
    );
  }

  return (
    <>
      <ZoneEditorPage
        camByMonitor={camByMonitor}
        camParam={params.get('cam')}
        cameras={cameras}
        dirtyRef={dirtyRef}
        flash={flash}
        footfallDown={footfallDown}
        group={group}
        isNew={pending?.id === zone.id}
        key={zone.id}
        onAddZone={addZone}
        onAskDelete={askDelete}
        onCam={(cam) => go({ cam })}
        onStopGate={askStopGate}
        pendingId={pending?.id || null}
        onCancel={cancel}
        gates={gates}
        onRefreshGates={refreshGates}
        onGroup={onGroup}
        onPickGate={pickGate}
        onPickZone={pickZone}
        onSaved={(rooms) => {
          setRooms(rooms);
          if (pending?.id === zone.id) setPending(null);
        }}
        ready={ready}
        regionZones={regionZones}
        saved={saved}
        zone={zone}
      />
      {deleteDialog}
      {stopGateDialog}
    </>
  );
}

/**
 * The one confirm for deleting a zone, wherever it was asked for.
 *
 * It replaces a `window.confirm` whose text was one sentence, and it says the
 * three things that sentence could not. WHAT is lost -- the boundary, the
 * capacity and the rules, which are stored in three different places and all
 * go. WHERE from -- named cameras, counted, because a zone spanning four views
 * is four boundaries and the operator may only be picturing one. And what is
 * NOT lost: a zone is not a camera, and anyone who suspects this unregisters
 * the stream will not press it. Detaching a single camera from a zone is a
 * different control, on the canvas bar.
 */
/**
 * Stopping a gate, asked the same way deleting a zone is asked.
 *
 * The verb is deliberately not "delete". There is nothing to delete -- the
 * service stores a gate as `enabled` on a camera -- and the two things that
 * survive are exactly the two an operator worries about losing, so the copy
 * names them instead of leaving the word to imply something it cannot.
 */
function StopGateDialog({ target, onCancel, onConfirm }) {
  return (
    <ConfirmDialog
      confirmLabel="Stop counting"
      description={target ? (
        <>
          Stop counting at <b>{target.name}</b>? It disappears from the rail and from the
          Gate Activity Matrix, and nothing new is counted. Today&apos;s IN and OUT are kept in
          the history, and the line stays where you put it — setting this camera up as a gate
          again restores it.
        </>
      ) : null}
      onConfirm={onConfirm}
      onOpenChange={(v) => { if (!v) onCancel(); }}
      open={Boolean(target)}
      title="Stop counting at this gate"
    />
  );
}

function DeleteZoneDialog({ target, onCancel, onConfirm }) {
  const cams = target?.cameraNames || [];
  const many = cams.length > 1;
  const where = many
    ? `its ${cams.length} cameras (${cams.join(', ')})`
    : cams.length === 1 ? cams[0] : 'its camera';

  return (
    <ConfirmDialog
      confirmLabel={target?.unsaved ? 'Discard zone' : 'Delete zone'}
      description={!target ? null : target.unsaved ? (
        <>
          Discard <b>{target.name}</b>? It has never been saved, so nothing is armed on any camera —
          but the boundary drawn on {where} is lost, and so is anything typed against it.
        </>
      ) : (
        <>
          Delete <b>{target.name}</b>? Its boundary, capacity and rules are removed from {where}.
          {many ? ' The cameras keep counting and are not removed' : ' The camera keeps counting and is not removed'} — only this zone is.
        </>
      )}
      onConfirm={onConfirm}
      onOpenChange={(v) => { if (!v) onCancel(); }}
      open={Boolean(target)}
      title={target?.unsaved ? 'Discard unsaved zone' : 'Delete zone'}
    />
  );
}

/** The implicit whole-view zone of a camera nobody has drawn on yet. */
function cameraZone(cam) {
  return cam ? { id: cam.id, cameraIds: [cam.id], label: '', floor: cam.floor, count: cam.count, capacity: 0 } : null;
}

/**
 * Everything saved on a zone, read once when the editor mounts on it.
 *
 * A camera with no stored shape for this zone takes the one Head Count already
 * has on it -- matched by id, by name, or as the camera's only area when no
 * other zone claims it -- so a zone drawn before this page existed opens with
 * its polygon rather than a blank canvas.
 */
function seedFrom(zone, saved, camByMonitor) {
  const stored = saved[zone.id];
  const base = { ...defaultRoom(zone), ...(stored || {}) };
  const boundaries = { ...(base.boundaries || {}) };
  for (const m of base.cameras) {
    if (hasShape(boundaries[m])) continue;
    const onCamera = camByMonitor[m]?.headcount?.zones || [];
    const othersHere = zonesOnCamera(saved, m).filter((z) => z.id !== zone.id).length;
    const match = onCamera.find((r) => r.id === zone.id || (base.name && r.name === base.name))
      || (onCamera.length === 1 && !othersHere ? onCamera[0] : null);
    boundaries[m] = match?.points || boundaries[m] || [];
  }
  return {
    ...base,
    id: zone.id,
    name: base.name || zone.label || '',
    boundaries,
    access: { ...defaultAccess(), ...(stored?.access || {}) },
  };
}

function ZoneEditorPage({
  zone, saved, regionZones, cameras, camByMonitor, camParam, group, onGroup, gates, onRefreshGates, isNew,
  pendingId, onPickZone, onPickGate, onStopGate, onAddZone, onAskDelete, onCam, onSaved, onCancel,
  ready, dirtyRef, flash, footfallDown,
}) {
  const [draft, setDraft] = useState(() => seedFrom(zone, saved, camByMonitor));
  const [baseline, setBaseline] = useState(() => JSON.stringify(draft));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [canvasMode, setCanvasMode] = useState('draw');
  // Whether the operator touched a shape. An empty boundary only clears a
  // camera's area when they did: the same empty array also means "the camera's
  // shape had not loaded when this opened", and that must not wipe it.
  const [boundaryEdited, setBoundaryEdited] = useState(false);

  const dirty = JSON.stringify(draft) !== baseline;
  // An entry line moved but not saved is unsaved work too.
  const [lineDirty, setLineDirty] = useState(false);
  useEffect(() => { dirtyRef.current = dirty || lineDirty; }, [dirty, lineDirty, dirtyRef]);

  const activeCam = draft.cameras.includes(camParam) ? camParam : draft.cameras[0];
  const nameOf = (m) => cameras.find((c) => c.id === m)?.label || camByMonitor[m]?.name || m;
  const notCounting = cameras.find((c) => c.id === activeCam)?.counting === false;

  // The zones as they would be if this draft were saved: every other saved
  // zone, plus this one as it stands. The rail, the bar and the canvas all read
  // this one set, so an unsaved zone already shows up everywhere it will be.
  const working = useMemo(() => ({ ...saved, [draft.id]: draft }), [saved, draft]);
  const colors = colorsOnCamera(working, activeCam);
  const zonesHere = zonesOnCamera(working, activeCam).map((z) => ({ id: z.id, name: z.name, color: colors[z.id] }));
  const others = zonesHere
    .filter((z) => z.id !== draft.id)
    .map((z) => ({ ...z, points: boundaryOn(working[z.id], activeCam) }));
  const activeColor = colors[draft.id];
  const points = boundaryOn(draft, activeCam);
  // A zone just made with "Add zone" and not drawn anywhere yet: the canvas is
  // the only thing that matters until it has a shape, so it is highlighted and
  // the secondary rules wait.
  const awaitingShape = isNew && !draft.cameras.some((m) => hasShape(draft.boundaries?.[m]));

  // Strict lockout is not a separate switch on the capacity side — it IS a
  // capacity of zero, and letting the two disagree is how a locked room ends up
  // quietly admitting three people.
  const access = draft.access || defaultAccess();
  const lockedOut = access.mode === 'lockout';

  // Still polled here: the Live canvas draws each detection against the rules.
  const { frame, error, running } = useZoneDetections({
    monitorId: activeCam,
    polygon: points,
    access,
    enabled: Boolean(activeCam),
  });

  // The live headcount: people inside this zone's boundary on the camera on
  // screen, re-counted every second -- and against the shape as drawn now, so
  // moving a corner shows what the zone would count before it is saved.
  const liveCount = frame && running !== false ? frame.insideBoxes.length : null;

  // Floors come from the camera groups the site is already organised by, plus
  // whatever this zone was saved with — so opening an old zone never silently
  // changes its floor to one of today's options.
  const floors = useMemo(() => {
    const out = new Set(regionZones.map((z) => z.floor).filter(Boolean));
    if (draft.floor) out.add(draft.floor);
    return [...out].sort();
  }, [regionZones, draft.floor]);

  // Names the whitelist can offer: whoever the cameras have recognised in this
  // frame, plus anyone enrolled on this browser. Both are real; neither is a
  // directory, and the access panel says so.
  const suggestions = useMemo(() => {
    const out = new Map();
    for (const b of frame?.boxes || []) {
      if (!b.unknown && !out.has(b.name)) out.set(b.name, { name: b.name, id: '', source: 'seen now' });
    }
    try {
      const roster = JSON.parse(localStorage.getItem('ai-watchlist-roster') || '[]');
      for (const r of roster) {
        if (r?.name && !out.has(r.name)) out.set(r.name, { name: r.name, id: r.id || '', source: 'enrolled' });
      }
    } catch { /* no roster on this browser */ }
    return [...out.values()];
  }, [frame]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const setBoundary = (pts) => {
    setDraft((d) => ({ ...d, boundaries: { ...d.boundaries, [activeCam]: pts } }));
    setBoundaryEdited(true);
  };

  const addCamera = (m) => {
    setDraft((d) => ({ ...d, cameras: [...d.cameras, m], boundaries: { ...d.boundaries, [m]: d.boundaries[m] || [] } }));
    // Straight to the new view: the next thing to do is draw this zone's
    // slice of it.
    onCam(m);
  };

  const removeCamera = (m) => {
    if (draft.cameras.length === 1) return;
    if (hasShape(draft.boundaries[m]) && !window.confirm(`Remove ${nameOf(m)} from this zone? The boundary drawn on it is discarded.`)) return;
    const rest = draft.cameras.filter((c) => c !== m);
    setDraft((d) => {
      const boundaries = { ...d.boundaries };
      delete boundaries[m];
      return { ...d, cameras: d.cameras.filter((c) => c !== m), boundaries };
    });
    if (m === activeCam) onCam(rest[0]);
  };

  // Shapes are per camera now, so changing the primary moves nothing -- it
  // only changes which view the intrusion rules run on.
  const makePrimary = (m) => setDraft((d) => ({ ...d, cameras: [m, ...d.cameras.filter((c) => c !== m)] }));

  const save = async () => {
    const problems = zoneProblems(draft, saved, nameOf);
    if (problems.length) {
      setResult({ blocked: problems });
      return;
    }
    setSaving(true);
    setResult(null);
    const res = await saveRoom({
      ...draft,
      maxCapacity: lockedOut ? 0 : draft.maxCapacity,
      cameraId: camByMonitor[draft.cameras[0]]?.id || null,
    }, {
      registry: camByMonitor,
      clearBoundary: boundaryEdited,
    });
    setSaving(false);
    setResult(res);
    setBoundaryEdited(false);
    // The server id comes back on the first save. Without it in the draft the
    // next save would create a second copy of this zone instead of updating it.
    const next = { ...draft, zoneId: res.rooms?.[draft.id]?.zoneId ?? draft.zoneId };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    if (res.rooms) onSaved(res.rooms);
  };

  const isSaved = Boolean(saved[draft.id]);

  // The header's delete goes through the page's one delete, same as the rail's
  // row menu. It passes the DRAFT's name and cameras rather than the stored
  // ones, so the confirm names the zone the operator is looking at even when
  // they have just renamed it or added a view.
  const remove = () => onAskDelete({ id: draft.id, name: draft.name || zone.label, cameras: draft.cameras });

  return (
    <OperationsPage>
      <SetupHeader
        onCancel={onCancel}
        right={
          <>
            {/* Step 2 lives behind this, and reports itself through it: the
                live capacity badge and a line of every rule in force, so the
                drawer does not have to be opened to know what it holds. */}
            <RulesDrawer
              access={access}
              cameraName={nameOf(activeCam)}
              count={liveCount ?? zone.count ?? 0}
              dirty={dirty}
              draft={draft}
              isNew={isNew}
              live={liveCount != null}
              locked={awaitingShape}
              lockedOut={lockedOut}
              onPickZone={(id) => onPickZone(id, activeCam)}
              set={set}
              suggestions={suggestions}
              zonesHere={zonesHere}
            />
            {isSaved ? (
              <PageAction aria-label="Delete zone" className="disabled:opacity-60" disabled={saving} onClick={remove} type="button">
                <Trash2 className="h-3.5 w-3.5 text-danger" strokeWidth={2} />
                <span className="hidden sm:inline">Delete zone</span>
              </PageAction>
            ) : null}
            {/* The dot is not decoration. Capacity and the rules are behind a
                drawer now, so an edit made in there and left unsaved has no
                other trace on the page once it closes -- and the guard that
                catches it only fires on the way OUT, which is late. */}
            <button
              className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60 ${
                dirty ? 'ring-2 ring-brand/35 ring-offset-1 ring-offset-surface' : ''
              }`}
              disabled={saving}
              onClick={save}
              title={dirty ? 'This zone has unsaved changes' : 'Everything on this zone is saved'}
              type="button"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" strokeWidth={2} />}
              <span className="hidden sm:inline">Save Zone Configuration</span>
              <span className="sm:hidden">Save</span>
              {dirty && !saving ? (
                <span aria-label="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/90" role="status" />
              ) : null}
            </button>
          </>
        }
      />

      <PageContent className="gap-3" scroll>
        <ResultNote
          flash={flash}
          result={result}
          savedText="Zone saved. Its boundaries and capacity are armed on its cameras; behaviour, access mode and whitelist are held on this browser."
        />

        <SetupGrid
          rail={(
            <ZoneRail
              activeCam={activeCam}
              activeZoneId={draft.id}
              cameras={cameras}
              gates={gates}
              mode={group}
              onAddZone={onAddZone}
              onDeleteZone={onAskDelete}
              onMode={onGroup}
              onPick={onPickZone}
              onPickGate={onPickGate}
              onStopGate={onStopGate}
              pendingId={pendingId}
              ready={ready}
              regionZones={regionZones}
              saved={saved}
              zones={working}
            />
          )}
          center={(
            <Panel
              bodyClass="p-3 xl:overflow-y-auto"
              className={awaitingShape ? 'ring-2 ring-brand/50' : ''}
              icon={canvasMode === 'live' ? ScanEye : canvasMode === 'line' ? Waypoints : PenTool}
              right={
                <div className="inline-flex overflow-hidden rounded-lg border border-line">
                  {CANVAS_MODES.map(([id, label, tip]) => (
                    <button
                      aria-pressed={canvasMode === id}
                      className={`px-3 py-1.5 text-body font-semibold transition ${
                        canvasMode === id ? 'bg-brand-soft text-brand-ink' : 'text-fg-muted hover:bg-surface-sunken'
                      }`}
                      key={id}
                      onClick={() => setCanvasMode(id)}
                      title={tip}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              }
              title={<StepTitle n={1} text="Draw" />}
            >
                <CanvasBar
                  activeCam={activeCam}
                  cameras={cameras}
                  color={activeColor}
                  name={draft.name}
                  onAddCamera={addCamera}
                  onCam={onCam}
                  onMakePrimary={makePrimary}
                  onName={(v) => set({ name: v })}
                  onRemoveCamera={removeCamera}
                  zoneCameras={draft.cameras}
                >
                  <ZoneIdentityFields draft={draft} floors={floors} set={set} />
                </CanvasBar>

                <CanvasFrame>
                  {canvasMode === 'draw' ? (
                    <ZoneCanvas
                      color={activeColor}
                      footer={false}
                      // Remounted per view: the canvas picks its starting tool from
                      // whether a shape exists, and each view has its own.
                      key={activeCam}
                      media={activeCam ? <CleanFeed monitorId={activeCam} /> : null}
                      onChange={setBoundary}
                      others={others}
                      points={points}
                    />
                  ) : canvasMode === 'live' ? (
                    <DetectionOverlay
                      color={activeColor}
                      error={error}
                      frame={frame}
                      monitorId={activeCam}
                      others={others}
                      polygon={points}
                      running={running}
                    />
                  ) : null}

                  <GateLineEditor
                    cameraName={nameOf(activeCam)}
                    footfallDown={footfallDown}
                    gate={gates[activeCam]}
                    key={`line:${activeCam}`}
                    monitorId={activeCam}
                    onDirty={setLineDirty}
                    onSaved={onRefreshGates}
                    others={[...others, { id: draft.id, color: activeColor, points }]}
                    visible={canvasMode === 'line'}
                  />
                </CanvasFrame>

                <CanvasCaption
                  help={canvasMode === 'draw' ? (
                    <>
                      Drag a rectangle or click corner by corner. Only people inside the solid shape belong
                      to {draft.name || 'this zone'}; dashed outlines are the other zones on this view.
                      {draft.cameras.length > 1
                        ? ' This zone spans several cameras: draw its own slice on each, without overlapping, so nobody is counted twice.'
                        : ' With no shape drawn, the whole view counts.'}
                      {notCounting ? ` Head counting is not on for ${nameOf(activeCam)} yet: saving this zone turns it on.` : ''}
                    </>
                  ) : canvasMode === 'line' ? (
                    <>
                      Draw the line across the doorway, end to end, at whatever angle it has on the picture:
                      only people crossing between its ends are counted. Drag an end to turn it, drag the line
                      to move it, or focus an end and use the arrow keys. Crossing toward the arrowed side
                      counts IN, the other way OUT. The line is saved to the footfall service on its own
                      button, separately from the zone.
                    </>
                  ) : (
                    <>
                      Live detections judged against this zone&apos;s access rules (under More rules), including
                      edits you have not saved.
                    </>
                  )}
                >
                  {canvasMode === 'draw' && liveCount != null ? (
                    <span className="inline-flex items-center gap-1.5 font-semibold text-fg-secondary">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
                      {liveCount} inside now
                    </span>
                  ) : null}
                  {canvasMode === 'draw' ? (
                    <>
                      <span>
                        {draft.cameras.length > 1
                          ? `Spans ${draft.cameras.length} cameras`
                          : hasShape(points) ? `Boundary · ${points.length} corners` : 'No boundary — whole view counts'}
                      </span>
                      {notCounting ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-info" />
                          Counting starts on save
                        </span>
                      ) : null}
                    </>
                  ) : canvasMode === 'line' ? (
                    <span>Drag an end to turn the line · arrowed side is IN</span>
                  ) : (
                    <>
                      <LegendDot className="bg-success" label="Permitted" />
                      <LegendDot className="bg-danger" label="Breach" />
                      <LegendDot className="bg-line-strong" label="Outside" />
                    </>
                  )}
                </CanvasCaption>
            </Panel>
          )}
        />
      </PageContent>
    </OperationsPage>
  );
}

/**
 * One quiet line under the canvas: what is on it now, on the left, and the
 * longer explanation behind "How it works" on the right. Plain text rather
 * than chips, because it is information, not an alert.
 */
function CanvasCaption({ children, help }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg-subtle">
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="ml-auto inline-flex items-center gap-1 rounded px-1 font-semibold text-fg-muted transition hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            type="button"
          >
            <CircleHelp className="h-3.5 w-3.5" strokeWidth={2} />
            How it works
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[20rem] text-small leading-relaxed" side="bottom" variant="card">
          {help}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function LegendDot({ className, label }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

