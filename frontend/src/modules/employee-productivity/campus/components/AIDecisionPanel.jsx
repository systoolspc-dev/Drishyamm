import { BrainCircuit, ArrowRight } from 'lucide-react';
import Panel from './Panel';
import ConfidenceBadge from './ConfidenceBadge';
import { AI_DECISIONS } from '../live-data';

// AI Decision Panel — the reasoning behind each live classification: signals in,
// decision out, action taken. This is what makes the page "intelligence" rather
// than a video wall.
export default function AIDecisionPanel() {
  return (
    <Panel icon={BrainCircuit} title="AI Decision Panel" bodyClass="p-3 max-h-[520px] overflow-y-auto">
      <ul className="space-y-2.5">
        {AI_DECISIONS.map((d) => (
          <li key={d.id} className="rounded-xl border border-line bg-surface-sunken/60 p-3">
            <div className="flex items-center gap-1.5">
              <p className="text-small font-bold text-fg">{d.decision}</p>
              <ConfidenceBadge value={d.conf} />
              <span className="ml-auto font-mono text-micro text-fg-subtle">{d.time}</span>
            </div>
            <p className="mt-0.5 text-caption text-fg-muted">{d.room}</p>

            {/* Signals the model weighed */}
            <div className="mt-2 flex flex-wrap gap-1">
              {d.signals.map((s) => (
                <span key={s} className="rounded-md bg-surface px-1.5 py-0.5 text-micro font-medium text-fg-secondary ring-1 ring-line">
                  {s}
                </span>
              ))}
            </div>

            {/* Action taken */}
            <p className="mt-2 flex items-center gap-1.5 text-caption font-medium text-brand-ink">
              <ArrowRight className="h-3 w-3 shrink-0" /> {d.action}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
