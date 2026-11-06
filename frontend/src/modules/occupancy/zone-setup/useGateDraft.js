/**
 * The draft of one camera's gate line, and how it is written back.
 *
 * Shared by gate mode (GateEditor) and the "Entry line" tool inside zone mode
 * (GateLineEditor), so the two places a line can be placed save it the same
 * way. The footfall service is the only store: nothing is cached on this
 * browser, so a gate counts identically whichever screen set it up.
 */
import { useState } from 'react';
import { aiService } from '@/core/services/ai';
import { DEFAULT_DIRECTION, DEFAULT_LINE, gatePatch } from '../gate-model';

export function useGateDraft({ gate, cameraName, onSaved }) {
  // What the service holds now. A camera it has never counted on reads as
  // off, on the default line.
  const stored = {
    enabled: Boolean(gate?.enabled),
    line: gate?.line ?? DEFAULT_LINE,
    direction: gate?.direction || DEFAULT_DIRECTION,
  };
  const [baseline, setBaseline] = useState(stored);
  // Opening a line on a camera that is not a gate yet is asking to make it
  // one, so the draft starts switched on; Save is then the one step left.
  const [draft, setDraft] = useState(() => ({ ...stored, enabled: true }));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  // Without the service's own id for this camera there is nowhere to write --
  // and so nothing that could count as unsaved.
  const known = Boolean(gate?.cameraId);
  const patch = gatePatch(baseline, draft);
  const dirty = known && Object.keys(patch).length > 0;
  const set = (p) => setDraft((d) => ({ ...d, ...p }));

  // `after` is what the service holds once `body` lands -- only what was sent
  // moves, so an unsaved line position is not mistaken for a saved one.
  const write = async (body, after, message) => {
    setSaving(true);
    setResult(null);
    try {
      await aiService.footfallPutConfig(gate.cameraId, body);
      setBaseline(after);
      setDraft((d) => ({ ...d, ...(body.enabled === false ? { enabled: false } : null) }));
      setResult({ message });
      onSaved?.();
    } catch (err) {
      setResult({ error: `Not saved: ${err?.response?.data?.message || err?.message || 'the footfall service did not accept the change'}. Nothing was changed on the camera.` });
    } finally {
      setSaving(false);
    }
  };

  const save = () => write(patch, draft, draft.enabled
    ? `Gate saved. ${cameraName} counts everyone crossing the line; it appears in the Gate Activity Matrix on the dashboard.`
    : `Saved. ${cameraName} is not counting as a gate.`);

  // No confirm here. This used to raise a `window.confirm`, which was the last
  // one left in Zone Setup after the zone deletes moved to ConfirmDialog, and
  // it also meant the hook could only be driven from a place willing to be
  // interrupted by a browser modal. Asking is the caller's job now, so the
  // rail can offer the same action from a row menu.
  const stop = () => write(
    { enabled: false },
    { ...baseline, enabled: false },
    `${cameraName} is no longer counting as a gate.`,
  );

  return {
    draft, set, baseline, known, dirty, saving, result, save, stop,
  };
}
