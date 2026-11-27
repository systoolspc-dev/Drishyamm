import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { aiService } from '@/core/services/ai';
import {
  buildDisablePayload,
  buildEnablePayload,
  cameraFeatures,
  featureSetupPath,
  lifecycleCopy,
  visibleFeatures,
} from '@/core/services/aiCamera';
import { Button } from '@/core/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';
// The producer rules live in ONE file. They used to live in
// modules/occupancy/zone-setup, and this import was a layering inversion --
// core reaching into a feature -- taken deliberately because the alternative
// was a fourth copy of "what feeds a zone", and a second reading of that
// question is exactly how the feeder and the engine came to disagree before.
// The file has since moved here, which is where a rule three screens share
// belongs; occupancy now imports it from core like everyone else.
import { zoneEntry } from '@/core/services/zoneDetector';
import { ZoneDetectorDialog } from './ZoneDetectorDialog';
import { planHeadcountChange } from './ai-setup-headcount.js';

/**
 * The "Set up AI" drawer: which features, where the camera is, start.
 *
 * Shared by Camera Setup → AI Detection and AI Feed, so a camera is set up
 * the same way wherever the operator is. It saves on its own through the
 * per-camera lifecycle route and reports back with onSaved(nextRow).
 *
 * `camera` is a GET /ai/cameras row (serializeAiCamera in the backend).
 * Pass null to close.
 */
export default function AiSetupDrawer({ camera, onClose, onSaved }) {
  return (
    <Sheet open={Boolean(camera)} onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <SheetContent side="right" className="w-[400px] max-w-[calc(var(--app-vw)*0.92)] gap-0 p-0">
        {camera ? <SetupDrawer key={camera.id} camera={camera} onClose={onClose} onSaved={onSaved} /> : null}
      </SheetContent>
    </Sheet>
  );
}

const PRIORITY = [
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' },
];

const INPUT_SIZES = [
  { value: 640, label: 'Fast' },
  { value: 960, label: 'Clear' },
  { value: 1280, label: 'Best' },
];

/** The drawer: pick features, say where the camera is, start. */
/**
 * "Draw a zone", but checked before it navigates.
 *
 * A zone applies its rules to boxes a PRODUCER publishes, so a camera with
 * neither face nor body detection on carries a zone that can never fire. This
 * link used to navigate anyway: the operator drew a shape, named it, set its
 * rules, pressed Save, and learned from a 409 that none of it could work.
 *
 * Only the ZONE row is gated. A gate line for counting needs no producer at
 * all -- head count runs its own model -- so gating that too would be an
 * obstacle in front of something that works.
 */
function SetupLink({ camera, feature, onBlocked }) {
  const href = featureSetupPath(feature, camera);
  const label = feature.setupLabel.replace(/^Draw a /, 'Draw ');
  // One camera, because that is all the drawer is open on. The zone editor
  // asks the same question about every camera a zone covers.
  const gate = feature.key === 'restricted_zone'
    ? zoneEntry([camera])
    : null;

  if (!gate) {
    return (
      <Link className="text-small font-medium text-brand-ink hover:underline" to={href}>
        {label}
      </Link>
    );
  }
  // A button, not a Link: it leads to a question rather than to a page, and a
  // link an operator middle-clicks into a new tab would skip the question.
  return (
    <button
      className="text-small font-medium text-brand-ink hover:underline"
      onClick={() => onBlocked({ ...gate, href })}
      type="button"
    >
      {label}
    </button>
  );
}

function SetupDrawer({ camera, onClose, onSaved }) {
  // Keyed on camera.id by the parent, so each camera starts a fresh draft.
  const [draft, setDraft] = useState(() => draftFromCamera(camera));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // What the server changed BEYOND what was asked for -- today only body
  // detection being forced on to stop a zone being armed with no producer.
  // Shown rather than discarded: a security control that was switched on for
  // the operator has to be something they are told about.
  const [notices, setNotices] = useState([]);
  // The zone the operator is trying to draw on a camera that cannot carry one.
  // Holds the pending navigation, so the answer resumes it.
  const [zoneGate, setZoneGate] = useState(null);
  const navigate = useNavigate();

  const submit = async (payload, headcountEnabled) => {
    setError('');
    setNotices([]);
    // Counting is a separate route (settings.headcount, not settings.ai), so
    // the toggle is a second call. What it should do is decided HERE, from the
    // payload about to be sent -- before anything is sent at all. Counting
    // cannot start on a camera whose master AI switch is off, and this drawer
    // will not send the `enableAi` consent flag on an operator's behalf, so
    // "AI off + counting on" is a submit that can only come back refused. It
    // is answered in the drawer instead, beside the two controls that
    // disagree, rather than saving the AI half and reporting the failure of a
    // request that never had a chance. See ai-setup-headcount.js.
    const headcount = planHeadcountChange({ camera, payload, headcountEnabled });
    if (headcount.refuse) {
      setError(headcount.refuse);
      return;
    }
    setSaving(true);
    try {
      const res = await aiService.updateCameraAiLifecycle(camera.id, payload);
      // Made AFTER the AI save, so a failure here cannot lose the main edit --
      // and so that a submit which turns the master ON has already turned it
      // on by the time counting is asked for. `zones` is deliberately not
      // sent: the backend keeps the counting area already drawn, so switching
      // counting off and on again never wipes it.
      if (headcount.send) {
        try {
          await aiService.setHeadcount(camera.id, {
            enabled: headcount.enabled,
            threshold: Number(camera.headcount?.threshold) || 0,
          });
        } catch (err) {
          setError(err?.response?.data?.message
            || 'The AI settings were saved, but head counting could not be changed.');
          return;
        }
      }
      onSaved?.(res.data);
      if (res.reconcile && res.reconcile.ok === false) {
        // Saved, but the AI service did not start it: keep the drawer open and say so.
        setError(res.reconcile.error || 'Saved, but the AI service did not start this camera. Try again shortly.');
        return;
      }
      if (Array.isArray(res.notices) && res.notices.length) {
        // Saved correctly, but not exactly as asked. The drawer stays open so
        // the sentence is read, not flashed past on the way out.
        setNotices(res.notices);
        return;
      }
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Could not update this camera.');
    } finally {
      setSaving(false);
    }
  };
  const updateDraft = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const on = camera.ai?.enabled === true;
  const status = lifecycleCopy(camera.lifecycle);
  // Both derived with AI forced on, so the list shows what this camera WOULD
  // do rather than a page of "off" while it is being set up for the first time.
  const asIfOn = { ...camera, ai: { ...camera.ai, enabled: true } };
  const drawn = Object.fromEntries(cameraFeatures(asIfOn).map((f) => [f.key, f.on]));
  // Rows whose feature has an effect on THIS camera. The zone-body child is
  // absent here until a zone is drawn.
  //
  // The face flag comes from the DRAFT, not the stored row: an operator who
  // has just switched face recognition off in this drawer should see the child
  // lock immediately, not after a save and a refetch.
  const rows = visibleFeatures({
    ...asIfOn,
    ai: { ...asIfOn.ai, faceRecognition: draft.faceRecognition !== false },
  });
  // Sent as true when the drawer is showing it as Required, so the server has
  // nothing left to force. Without this the server would force it on every
  // save of this camera and return the same notice each time, which trains an
  // operator to dismiss the one notice that mattered.
  const bodyForced = rows.some((f) => f.flag === 'zoneBodyDetection' && f.forced);

  return (
    <>
      <div className="shrink-0 border-b border-line px-5 py-4 pr-12">
        <SheetTitle className="truncate text-heading font-semibold text-fg">{camera.name}</SheetTitle>
        <SheetDescription className="mt-0.5 flex items-center gap-1.5 text-small text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${on ? status.dot : 'bg-line-strong'}`} />
          {on ? `AI ${status.label.toLowerCase()}` : 'AI is off'}
          <span className="text-fg-subtle">· {camera.groupName || 'Standalone'}{camera.channel ? ` · Ch ${camera.channel}` : ''}</span>
        </SheetDescription>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-2 text-small font-semibold text-fg">Turn on</p>
        <div className="divide-y divide-line rounded-lg border border-line">
          {rows.map((f) => {
            if (f.kind === 'core') {
              return (
                <FeatureLine key={f.key} feature={f}>
                  <span className="text-small text-fg-subtle">Always on</span>
                </FeatureLine>
              );
            }
            if (f.kind === 'flag') {
              // Forced on, with the reason shown. Not merely pre-ticked: an
              // anonymous camera with a zone and no detector is a zone that
              // watches nothing, so the server forces it too and a switch an
              // operator could flip back would be a lie.
              return (
                <FeatureLine child={Boolean(f.parent)} key={f.key} feature={f} note={f.forced ? f.forcedReason : null}>
                  {f.forced ? (
                    <span className="shrink-0 text-small font-medium text-fg-muted">Required</span>
                  ) : (
                    <Switch label={f.label} value={draft[f.flag] === true} onChange={(v) => updateDraft(f.flag, v)} />
                  )}
                </FeatureLine>
              );
            }
            // A setup row is READY only when something has been drawn. Head
            // count then gets a real on/off beside it: "a gate line exists" and
            // "count across it" are two questions, and reading the flag as the
            // answer to both is what made this row claim to be ready on a
            // camera with nothing drawn at all.
            return (
              <FeatureLine key={f.key} feature={f}>
                {drawn[f.key] ? (
                  <span className="flex shrink-0 items-center gap-3">
                    <Link to={featureSetupPath(f, camera)} className="inline-flex items-center gap-1 text-small font-medium text-success-ink hover:underline">
                      <Check className="h-3.5 w-3.5" /> Ready
                    </Link>
                    {/* Head count only. Footfall is configured through the
                        footfall service and has no per-camera switch here. */}
                    {f.key === 'head_count' ? (
                      <Switch
                        label="Count people inside this area"
                        onChange={(v) => updateDraft('headcountEnabled', v)}
                        value={draft.headcountEnabled === true}
                      />
                    ) : null}
                  </span>
                ) : (
                  <SetupLink
                    camera={camera}
                    feature={f}
                    onBlocked={setZoneGate}
                  />
                )}
              </FeatureLine>
            );
          })}
        </div>

        <button
          aria-expanded={advancedOpen}
          className="mt-5 inline-flex items-center gap-1 text-small font-medium text-fg-muted hover:text-fg"
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
        >
          Advanced
          <ChevronDown className={`h-4 w-4 transition ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>

        {advancedOpen ? (
          <div className="mt-3 grid gap-4">
            <Labeled label="Alert priority">
              <Segmented options={PRIORITY} value={draft.priority} onChange={(v) => updateDraft('priority', v)} />
            </Labeled>
            <Labeled label={`Checking speed · ${draft.fps} fps`} title="Frames per second the AI looks at. 4 is recommended.">
              <input
                aria-label="Checking speed"
                className="w-full accent-brand"
                max="12"
                min="1"
                onChange={(event) => updateDraft('fps', Number(event.target.value))}
                type="range"
                value={draft.fps}
              />
            </Labeled>
            <Labeled label="Face detail" title="Higher spots faces further away but is slower.">
              <Segmented options={INPUT_SIZES} value={draft.detectionInputSize} onChange={(v) => updateDraft('detectionInputSize', v)} />
            </Labeled>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line px-5 py-4">
        {error ? (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-small font-medium text-warning-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {notices.map((n) => (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-small font-medium text-info-ink" key={n}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {n}
          </p>
        ))}
        <Button
          className="w-full"
          disabled={saving}
          onClick={() => {
            const { headcountEnabled, ...ai } = draft;
            submit(buildEnablePayload(camera, {
              ...ai,
              ...(bodyForced ? { zoneBodyDetection: true } : null),
            }), headcountEnabled);
          }}
          type="button"
        >
          {saving ? <Loader2 className="animate-spin" /> : null}
          {on ? 'Save' : 'Start AI'}
        </Button>
        {on ? (
          <button
            className="mt-2 w-full rounded-lg py-2 text-small font-medium text-danger-ink hover:bg-danger-soft disabled:opacity-60"
            disabled={saving}
            onClick={() => submit(buildDisablePayload(camera))}
            type="button"
          >
            Turn AI off
          </button>
        ) : null}
      </div>

      {/* Asked instead of navigating, and the navigation resumes once a
          detector is on. A failure keeps the dialog open: a camera that did
          not change is a camera whose zone still cannot fire, so sending the
          operator to draw one would put them back where they started. */}
      <ZoneDetectorDialog
        entry={zoneGate}
        onChoose={async (option) => {
          const res = await aiService.updateCameraAiLifecycle(
            camera.id, buildEnablePayload(camera, option.overrides),
          );
          // The drawer's own row is re-read, so closing it does not leave the
          // panel claiming the detector is still off.
          if (res?.data) onSaved?.(res.data);
          // The AI service may have saved the flag and failed to START the
          // camera. That is not a reason to refuse the zone -- the setting is
          // right and it retries -- but it IS worth carrying forward.
          if (res?.reconcile && res.reconcile.ok === false) {
            setNotices([`Saved, but the AI service did not start this camera: ${
              res.reconcile.error || 'it did not respond.'} Nothing is detected until it does.`]);
          }
          navigate(zoneGate.href);
        }}
        onOpenChange={(open) => { if (!open) setZoneGate(null); }}
        open={Boolean(zoneGate)}
      />
    </>
  );
}

/**
 * A feature: its name (description on hover) and its control.
 *
 * `child` indents the row and lightens the label, so a sub-feature reads as
 * belonging to the row above rather than as a seventh independent thing.
 * `note` is a sentence shown under the label when the row needs to explain
 * itself -- a forced switch has to say why it cannot be turned off.
 */
function FeatureLine({ feature, children, child = false, note = null }) {
  return (
    <div className={`flex min-h-12 items-center justify-between gap-3 py-2.5 pr-3 ${child ? 'pl-7' : 'pl-3'}`}>
      <span className="min-w-0">
        <span className={`block ${child ? 'text-small text-fg-secondary' : 'text-body text-fg'}`} title={feature.note}>
          {feature.label}
        </span>
        {note ? <span className="mt-0.5 block text-small text-fg-muted">{note}</span> : null}
      </span>
      {children}
    </div>
  );
}

function Switch({ label, value, onChange }) {
  return (
    <button
      aria-label={label}
      aria-pressed={value}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${value ? 'bg-brand' : 'bg-line-strong'}`}
      onClick={() => onChange(!value)}
      type="button"
    >
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-surface shadow-sm transition-all ${value ? 'left-6' : 'left-1'}`} />
    </button>
  );
}

function Labeled({ label, title, children }) {
  return (
    <div title={title}>
      <p className="mb-1.5 text-small text-fg-muted">{label}</p>
      {children}
    </div>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1">
      {options.map((item) => (
        <button
          aria-pressed={value === item.value}
          className={`h-8 rounded-md text-small font-medium transition ${
            value === item.value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
          }`}
          key={item.value}
          onClick={() => onChange(item.value)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function draftFromCamera(camera) {
  // `purpose` is still set -- buildEnablePayload infers it from the camera's
  // name -- because the backend uses it as a fallback zone label. What is gone
  // is the PRESET: picking a place used to tick four flags at once, two of
  // which (unknownAlerts, watchlistAlerts) no service reads and one of which
  // (journeyMapping) is owned by Person Tracker. A shortcut for setting three
  // controls that do nothing is worse than no shortcut.
  //
  // `headcountEnabled` is NOT part of the AI payload -- counting lives in
  // settings.headcount and has its own route -- so it is stripped before save
  // and sent separately. It rides in the draft so the row has somewhere to put
  // the toggle's state.
  return {
    ...buildEnablePayload(camera, { faceRecognition: camera?.ai?.faceRecognition !== false }),
    headcountEnabled: camera?.headcount?.enabled === true,
  };
}
