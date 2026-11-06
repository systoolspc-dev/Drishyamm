import { useState } from 'react';
import { CalendarClock, Pause, Play, Mail } from 'lucide-react';
import Panel from '../Panel';
import { SCHEDULED, FORMAT_META } from '../../reports-data';

const FREQ_CHIP = {
  Daily: 'bg-brand/10 text-brand-ink ring-brand/25',
  Weekly: 'bg-info-soft text-info-ink ring-info-line',
  Monthly: 'bg-ai-soft text-ai-ink ring-ai-line',
};

// Scheduled Reports — auto-generated & emailed on a cadence. Pause/resume is
// local (cosmetic) until the scheduler backend lands.
export default function ScheduledReports() {
  const [paused, setPaused] = useState(() => new Set(SCHEDULED.filter((s) => s.status === 'paused').map((s) => s.id)));
  const toggle = (id) => setPaused((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Panel icon={CalendarClock} title="Scheduled Reports" count={SCHEDULED.length} bodyClass="p-3">
      <ul className="space-y-1.5">
        {SCHEDULED.map((s) => {
          const isPaused = paused.has(s.id);
          const fmt = FORMAT_META[s.format] || FORMAT_META.CSV;
          return (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-line p-2.5">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${FREQ_CHIP[s.frequency]}`}>{s.frequency}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-small font-semibold text-fg">{s.report}</p>
                <p className="flex items-center gap-1 truncate text-micro text-fg-subtle">
                  <Mail className="h-3 w-3" /> {s.recipients} · {s.time}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${fmt.chip}`}>{fmt.label}</span>
              <button
                onClick={() => toggle(s.id)}
                title={isPaused ? 'Resume schedule' : 'Pause schedule'}
                className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-micro font-semibold transition ${
                  isPaused
                    ? 'border-brand/40 bg-brand/10 text-brand-ink'
                    : 'border-line bg-surface text-fg-muted hover:text-fg-secondary'
                }`}
              >
                {isPaused ? <><Play className="h-3 w-3" /> Paused</> : <><Pause className="h-3 w-3" /> Active</>}
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
