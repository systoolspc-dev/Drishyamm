/**
 * One place that decides what "turn AI on/off for a camera" sends, and what a
 * camera's AI is actually doing.
 *
 * Camera Setup → AI Detection is the only screen that switches AI on by hand.
 * Two other places still have to switch it on for a reason of their own (AI
 * Feed saving a detection area, Occupancy saving a gate), and before this file
 * each of them built its own PATCH /ai/cameras/:id/lifecycle body with its own
 * defaults (4 fps in one, 8 in another). They all build it here now, so a
 * camera behaves the same whichever screen started it.
 *
 * The backend today runs ONE pipeline per camera (person + face). Everything
 * the operator thinks of as a "feature" is that pipeline plus either a flag on
 * it (unknown / watchlist alerts, journey mapping) or something drawn on the
 * camera (a counting line for head count, a zone for restricted areas).
 * `cameraFeatures` turns that into a list the UI can show.
 *
 * Pure, with no imports, so it runs under `node --test`.
 */

export const DEFAULT_FPS = 4;
export const DEFAULT_INPUT_SIZE = 960;


/**
 * The features shown to the operator, in display order.
 *   kind 'flag'  – a switch stored on camera.settings.ai (`flag` names it)
 *   kind 'setup' – on when something has been drawn for this camera; the
 *                  picker links to the screen where it is drawn
 */
export const AI_FEATURES = [
  // Face recognition is a FEATURE now, not the master switch. `ai.enabled`
  // means "use this camera for AI at all" and gates every row below; this flag
  // decides whether faces are matched. Switching it off while the camera stays
  // AI-on is the anonymous case: heads are still counted, no face is matched.
  //
  // The label used to read "Face & person detection", which over-promised:
  // body/person detection is a DEPLOYMENT-wide switch
  // (PIPELINE_PERSON_DETECTION_ENABLED), off by default and off here, not
  // something this toggle turns on.
  { key: 'face', kind: 'flag', flag: 'faceRecognition', label: 'Face recognition', short: 'Face', note: 'Detects faces and matches them against enrolled people. Counting and zones do not need this — switch it off to count people without identifying them.' },
  // The alert rows are deliberately NOT here either, for the same reason as
  // journey mapping below: this panel lists the MODELS a camera runs, and an
  // alert is not a model -- it is what a model can tell you. `unknownAlerts`
  // and `watchlistAlerts` were shown here, disabled, because no service reads
  // them; a disabled control for something that belongs on another screen is
  // clutter twice over. Both alerts work end to end (the AI service emits
  // them, alertEngine raises them); only the per-camera flags are unread, and
  // they are still carried through every payload so nothing is lost. Alert
  // categories and severity belong on the Alerts screen, chosen once rather
  // than per camera.
  // Journey mapping is deliberately NOT here. This panel lists the MODELS a
  // camera runs; journey mapping is a feature built on top of the face model's
  // output, and Person Tracker already sets `journeyMapping` per camera
  // (PersonTracker.jsx, backed by personTracker.controller.js). Two screens
  // writing one flag is how the two drift apart. The flag itself is untouched
  // and still carried through every payload.
  // TWO ROWS, because these are two features with two services, two shapes
  // and two different requirements. They were one row called
  // "Head count / footfall", whose note had to explain in a single sentence
  // that one half needs face recognition and the other does not -- and whose
  // single setup link could only serve one of them, so an operator who wanted
  // a counting area was sent to draw a line.
  //
  //   footfall    people CROSSING a line. A gate line. Lives in the footfall
  //               service (aiService.footfallPutConfig) and is part of the
  //               FACE pipeline, so it needs face recognition on.
  //   head count  how many people are INSIDE an area right now. A polygon.
  //               Lives in the head-count service (aiService.setHeadcount)
  //               and needs no face recognition at all.
  //
  // The page has always known they are different -- useOccupancy builds
  // `gates`/`lineZones` from footfall and `regionZones` from the head-count
  // streams -- so this row was the last place they were conflated.
  {
    key: 'head_count', kind: 'setup', label: 'Head count', short: 'Count',
    note: 'Counts how many people are inside an area you draw, right now. Does not need face recognition — a camera can count people without identifying them.',
    setupLabel: 'Draw a counting area', setupPath: '/occupancy/zone-setup', setupParam: 'zone',
  },
  {
    key: 'footfall', kind: 'setup', label: 'Footfall', short: 'Footfall',
    note: 'Counts people crossing a line, in and out. Part of the face pipeline, so it needs face recognition on.',
    setupLabel: 'Draw a gate line', setupPath: '/occupancy/zone-setup', setupParam: 'gate',
  },
  // Restricted zones are created on the counting-areas page, which is the only
  // writer of /restricted-zones. /ai-feed draws AI DETECTION areas — a
  // different thing on a near-identical canvas, which saves successfully and
  // arms nothing.
  { key: 'restricted_zone', kind: 'setup', label: 'Restricted zone', short: 'Zone', note: 'Alerts when someone enters an area you draw.', setupLabel: 'Draw a zone', setupPath: '/occupancy/zone-setup', setupParam: 'zone' },
  // A CHILD of the row above, and labelled for what it DOES rather than for
  // the service that implements it: an operator choosing this is deciding
  // whether a hooded or turned-away person sets the zone off, not whether to
  // run zone-guard.
  //
  // Absent means OFF, unlike every other flag here. A second detector per
  // camera costs GPU on every frame, so this is opted into rather than
  // inherited -- see the backend's zoneProducer.service.js, which is the
  // authority. `needsZone` hides it on a camera with nothing drawn: with no
  // zone it has no effect whatever, and a live toggle that saves and does
  // nothing is the kind of control that teaches operators not to trust the
  // screen.
  {
    key: 'zone_body',
    kind: 'flag',
    flag: 'zoneBodyDetection',
    parent: 'restricted_zone',
    needsZone: true,
    defaultOff: true,
    label: 'Catch people with no visible face',
    short: 'Bodies',
    note: 'Detects a person by their body, so the zone fires even when the face is turned away, covered or too far to read. Costs extra GPU per camera. Required when face recognition is off — without it an anonymous camera has nothing detecting people.',
  },
];


/** A sensible purpose for a camera that has never had one, from its name. */
export function inferPurpose(row) {
  const text = `${row?.name || ''} ${row?.groupName || ''}`.toLowerCase();
  if (text.includes('gate') || text.includes('entrance')) return 'Main gate';
  if (text.includes('server')) return 'Server room';
  if (text.includes('reception')) return 'Reception';
  if (text.includes('cash')) return 'Cash counter';
  if (text.includes('store')) return 'Store room';
  return 'Restricted area';
}

/**
 * The lifecycle body that switches AI ON, carrying every setting the camera
 * already has. `overrides` wins over both.
 *
 * `detectionZones` is only sent when the caller passes it: the backend keeps
 * the stored zones when the field is absent, so turning AI on can never wipe
 * an area drawn in AI Feed.
 */
export function buildEnablePayload(row, overrides = {}) {
  // `faceRecognition` MUST be stated. It used to default to
  // `ai.faceRecognition !== false` -- absent means ON -- so a caller that had
  // not thought about faces started the face pipeline on a camera nobody had
  // configured and spent a face licence. That is not hypothetical: it is how
  // the head-count repair button came to contradict the consent dialog beside
  // it, and how turning on body detection for a zone came to switch face
  // recognition on as well. Two instances, months apart, same default.
  //
  // A required argument is the only guard that survives the indirect call.
  // modules/headcount/one-way-in.test.js guarded this by reading source text
  // and said so about itself: blind to a re-export, a dynamic import, or a
  // helper in another module calling on its behalf. Both of those existed --
  // ZoneSetup hands this function to zone-detector as `buildPayload`, which
  // calls it later -- so the text scan could not have caught either.
  //
  // The key is the payload's own name rather than a shorter alias, because
  // two names for one flag is the defect this guard exists to prevent.
  if (overrides.faceRecognition !== true && overrides.faceRecognition !== false) {
    throw new Error(
      'buildEnablePayload: state `faceRecognition` explicitly. Absent used to mean ON, '
      + 'so a caller that did not decide about faces started the face pipeline and spent '
      + 'a licence. Pass true, false, or the camera\'s current value '
      + '(`row.ai.faceRecognition !== false`) if you mean to preserve it.',
    );
  }
  const ai = row?.ai || {};
  return {
    enabled: true,
    mode: 'continuous',
    fps: Number(ai.fps) || DEFAULT_FPS,
    detectionInputSize: Number(ai.detectionInputSize) || DEFAULT_INPUT_SIZE,
    purpose: ai.purpose || inferPurpose(row),
    priority: ai.priority || 'normal',
    // Always overwritten by `overrides` below, which is now required to carry
    // it. Kept as the documented shape of the payload rather than deleted, so
    // the object literal still reads as the whole body being sent.
    faceRecognition: overrides.faceRecognition,
    unknownAlerts: ai.unknownAlerts !== false,
    watchlistAlerts: ai.watchlistAlerts !== false,
    journeyMapping: ai.journeyMapping !== false,
    // ABSENT MEANS FALSE, the opposite of the flags above. They are features a
    // camera has always had and must keep; this is a second detector that
    // costs GPU, so a camera only runs it once somebody has said to.
    zoneBodyDetection: ai.zoneBodyDetection === true,
    ...overrides,
  };
}

/**
 * Is face recognition actually running on this camera? The master AND the face
 * flag. Anything asking "are faces being matched here" wants this; anything
 * asking "is this camera used by AI at all" wants `ai.enabled` on its own.
 */
export function faceRecognitionOn(row) {
  const ai = row?.ai || {};
  return ai.enabled === true && ai.mode !== 'off' && ai.faceRecognition !== false;
}

/** The lifecycle body that switches AI OFF, keeping the stored choices. */
export function buildDisablePayload(row) {
  // Supplies `faceRecognition` itself so that switching AI OFF never became
  // harder than switching it on. It is the camera's current setting, which is
  // what preserves every stored choice across an off/on cycle -- the
  // behaviour an operator expects, and the reason this function exists.
  return {
    ...buildEnablePayload(row, { faceRecognition: row?.ai?.faceRecognition !== false }),
    enabled: false,
    mode: 'off',
  };
}

const hasDrawn = (list) => Array.isArray(list) && list.some((z) => z && z.enabled !== false);

/**
 * Does this camera carry at least one ARMED restricted zone?
 *
 * `row.restrictedZones.armed` is the real answer, counted server-side from
 * `/restricted-zones`. It has to be, because a restricted zone is a row in
 * that table and NOT a shape on `ai.detectionZones`: the two are drawn on
 * near-identical canvases on different pages, and detectionZones is only where
 * the pipeline looks for faces -- it saves successfully and arms nothing.
 *
 * The shape fallback is for a payload that predates the count (an older
 * backend, or a response cached across a deploy). It is the best guess
 * available and is deliberately the second choice, not the first.
 */
export function hasRestrictedZone(row) {
  const counted = row?.restrictedZones?.armed;
  if (Number.isFinite(counted)) return counted > 0;
  const zones = Array.isArray(row?.ai?.detectionZones) ? row.ai.detectionZones : [];
  return zones.some((z) => z?.shape !== 'line' && z?.enabled !== false);
}

/**
 * Is body detection MANDATORY on this camera rather than a choice?
 *
 * True when AI is on, face recognition is off and a zone is drawn: an
 * anonymous camera has no face pipeline, so the zone has NO producer and would
 * sit armed watching nothing. Mirrors the backend's `bodyDetectionRequired`
 * (zoneProducer.service.js), which is the authority -- this exists so the UI
 * can say why the switch is locked instead of just refusing a save.
 *
 * AI being off entirely is NOT this case: nothing runs by the operator's own
 * instruction, which the list already reports as `needsSetup`.
 */
export function zoneBodyRequired(row) {
  const ai = row?.ai || {};
  return ai.enabled === true && ai.mode !== 'off'
    && ai.faceRecognition === false
    && hasRestrictedZone(row);
}

/** Said wherever the switch is forced on, or a zone refused for want of it. */
export const ZONE_BODY_REQUIRED_NOTE = 'Face recognition is off on this camera, so nothing else '
  + 'detects people. Without this, the zone would be armed and watching nothing.';

/**
 * What this camera's AI is set to do, as [{ ...feature, on, needsSetup }].
 * `row` is a GET /ai/cameras row (serializeAiCamera in the backend).
 *
 * A drawn feature is `on` when it is drawn; `needsSetup` when it is drawn but
 * AI is off (nothing will happen), so the UI can say so.
 *
 * Two extra fields, for the zone-body child row:
 *   hidden  this feature has no effect on this camera, so no control for it
 *           should be shown. A toggle that saves and changes nothing is worse
 *           than no toggle.
 *   forced  it is on and cannot be turned off, with `forcedReason` saying why.
 */
export function cameraFeatures(row) {
  const ai = row?.ai || {};
  const aiOn = ai.enabled === true;
  const zones = Array.isArray(ai.detectionZones) ? ai.detectionZones : [];
  const drawn = {
    // DRAWN, not enabled. `headcount.enabled` means "counting is switched on
    // for this camera" -- a different question from "is there an area to count
    // inside", and reading it here made the row say "Ready" on a camera with
    // nothing drawn at all. The flag is the row's TOGGLE; this is its setup
    // state.
    //
    // The two halves of the old single row, now asked separately: a counting
    // AREA for head count, a LINE for footfall. A camera can have either,
    // both, or neither, which the one combined answer could not express.
    head_count: hasDrawn(row?.headcount?.zones),
    footfall: zones.some((z) => z?.shape === 'line' && z.enabled !== false),
    restricted_zone: hasRestrictedZone(row),
  };
  // Computed once: every flag row consults the same answer, so the row cannot
  // be shown by one rule and forced by another.
  const forced = zoneBodyRequired(row);
  return AI_FEATURES.map((f) => {
    // A flag whose parent feature is not set up on this camera does nothing at
    // all. `needsZone` is the only such rule today and it is explicit rather
    // than derived from `parent`, so adding a child row cannot accidentally
    // hide itself.
    // A child row whose parent is not set up on this camera does nothing at
    // all. `needsZone` is the only such rule today and it is explicit rather
    // than derived from `parent`, so adding a child row cannot accidentally
    // hide itself.
    const hidden = f.needsZone === true && !drawn.restricted_zone;
    if (f.kind === 'core') return { ...f, on: aiOn, needsSetup: false, hidden: false };
    if (f.kind === 'flag') {
      // `defaultOff` inverts the absent-means-on reading every other flag
      // uses. Both are correct for their own flag; see AI_FEATURES.
      const stored = f.defaultOff ? ai[f.flag] === true : ai[f.flag] !== false;
      const isForced = f.flag === 'zoneBodyDetection' && forced;
      return {
        ...f,
        on: aiOn && (stored || isForced),
        needsSetup: false,
        hidden,
        ...(isForced ? { forced: true, forcedReason: ZONE_BODY_REQUIRED_NOTE } : null),
      };
    }
    return { ...f, on: aiOn && drawn[f.key], needsSetup: !aiOn && drawn[f.key], hidden: false };
  });
}

/** The features worth showing a control for on this camera, in display order. */
/**
 * Where a setup row sends the operator, ON THE CAMERA THEY CAME FROM.
 *
 * Both rows used to link to a bare `/occupancy/zone-setup`, which opens on
 * whichever camera that page picks by itself -- so an operator who clicked
 * "Draw a gate line" from a camera's panel arrived somewhere else and had to
 * find their camera again. The page has understood deep links all along
 * (ZoneSetup.jsx reads `gate`, `cam`, `zone` and `group`); the panel simply
 * never used them.
 *
 * `gate` opens the gate-line editor on that camera directly.
 *
 * `zone` is the one for drawing a zone, and the choice is not obvious. It
 * normally carries a ZONE id, but ZoneSetup's lookup chain falls through to
 * `cameraZone(cameras.find((c) => c.id === editing))` -- a camera with no zone
 * yet is opened on its own whole view, "where its first zone gets drawn". That
 * is exactly the intent here, and it is why HeadCount.jsx links the same way.
 *
 * NOT `cam`, which was the first answer here and was wrong. `cam` selects
 * which camera WITHIN an already-chosen zone is shown
 * (ZoneSetup.jsx: `draft.cameras.includes(camParam) ? camParam : ...`); it has
 * no say in which zone the page opens, so the link silently landed on
 * whichever zone the page picked for itself. A parameter that is ignored when
 * it does not fit is the worst kind to guess at.
 *
 * All three take the monitorId, which is what ZoneSetup matches on.
 */
export function featureSetupPath(feature, row) {
  const base = feature?.setupPath || '';
  const monitorId = row?.monitorId;
  if (!base || !feature?.setupParam || !monitorId) return base;
  return `${base}?${feature.setupParam}=${encodeURIComponent(monitorId)}`;
}

export function visibleFeatures(row) {
  return cameraFeatures(row).filter((f) => !f.hidden);
}

/**
 * Short labels of the features that are on, for chips on rows and cards.
 * A hidden feature is never chipped: it is doing nothing on this camera.
 */
export function activeFeatureLabels(row) {
  return cameraFeatures(row).filter((f) => f.on && !f.hidden).map((f) => f.short);
}

/** Where Camera Setup's AI Detection tab opens with one camera selected. */
export function aiSetupPath(cameraId) {
  const params = new URLSearchParams({ tab: 'ai-detection' });
  if (cameraId) params.set('camera', String(cameraId));
  return `/camera-setup?${params.toString()}`;
}

/** Label and dot colour for a camera's AI lifecycle state (GET /ai/cameras `lifecycle`). */
export function lifecycleCopy(status) {
  switch (status) {
    case 'detecting':
      return { label: 'Detecting', dot: 'bg-success' };
    case 'starting':
      return { label: 'Starting', dot: 'bg-info animate-pulse' };
    case 'pending':
      return { label: 'Needs retry', dot: 'bg-warning' };
    case 'attention':
      return { label: 'Attention', dot: 'bg-danger' };
    default:
      return { label: 'On', dot: 'bg-success' };
  }
}
