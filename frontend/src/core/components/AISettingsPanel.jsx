import { useState } from 'react';
import { Brain, Save, Loader2, CheckCircle2 } from 'lucide-react';
import { aiService } from '@/core/services/ai';

/**
 * AISettingsPanel — drop-in card for editing per-camera AI behavior.
 *
 * Lives inside the camera/edit dialog. Backed by camera.settings.ai:
 *   { enabled: bool, tripwire_y: 0..1, fps: number }
 *
 * Saves via PUT /api/ai/cameras/:id/settings, which starts/stops the
 * vms_face worker immediately and keeps it reconciled in the backend.
 */
export default function AISettingsPanel({ camera, onSaved }) {
  const initial = camera?.settings?.ai || {};
  const [enabled,   setEnabled]    = useState(initial.enabled !== false);
  const [tripwireY, setTripwireY]  = useState(initial.tripwire_y ?? 0.35);
  const [fps,       setFps]        = useState(initial.fps ?? 4);
  const [saving,    setSaving]     = useState(false);
  const [savedAt,   setSavedAt]    = useState(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = { enabled, tripwire_y: Number(tripwireY), fps: Number(fps) };
      const res = await aiService.updateCameraSettings(camera.id, next);
      setSavedAt(Date.now());
      onSaved?.(res.data);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white/[0.04] border border-white/10 rounded-xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Brain size={16} className="text-brand" />
        <h3 className="text-body font-semibold text-white">AI Detection</h3>
        <span className="ml-auto text-micro text-white/40 uppercase tracking-wider">
          per camera
        </span>
      </div>

      {/* Enable toggle */}
      <label className="flex items-center justify-between cursor-pointer">
        <div>
          <div className="text-body font-medium text-white">Enable AI</div>
          <div className="text-small text-white/50">
            Run person detection and event alerts on this camera.
          </div>
        </div>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-5 w-9 appearance-none rounded-full bg-white/15 checked:bg-brand relative cursor-pointer transition
                     after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition
                     checked:after:translate-x-4"
        />
      </label>

      {/* Tripwire position */}
      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <div className="flex items-center justify-between mb-1">
          <label className="text-body text-white/80">Tripwire position</label>
          <span className="text-small text-white/50 font-mono">
            {Math.round(tripwireY * 100)}% from top
          </span>
        </div>
        <input
          type="range"
          min="0.1" max="0.9" step="0.05"
          value={tripwireY}
          onChange={(e) => setTripwireY(parseFloat(e.target.value))}
          className="w-full accent-brand"
        />
        <p className="text-small text-white/40 mt-1">
          Horizontal line where Entry/Exit events fire. Aim it at a doorway or threshold.
        </p>
      </div>

      {/* Inference FPS */}
      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>
        <div className="flex items-center justify-between mb-1">
          <label className="text-body text-white/80">Inference rate</label>
          <span className="text-small text-white/50 font-mono">{fps} FPS</span>
        </div>
        <input
          type="range"
          min="1" max="12" step="1"
          value={fps}
          onChange={(e) => setFps(parseInt(e.target.value, 10))}
          className="w-full accent-brand"
        />
        <p className="text-small text-white/40 mt-1">
          Higher FPS = faster reaction, more GPU. 4 is a good default for continuous coverage.
        </p>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        {savedAt ? (
          <span className="flex items-center gap-1.5 text-small text-success">
            <CheckCircle2 size={14} /> Saved
          </span>
        ) : (
          <span className="text-small text-white/40">Changes apply immediately and stay on 24/7</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand hover:bg-brand/90 disabled:opacity-50 text-white text-body font-semibold transition"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
      </div>
    </div>
  );
}
