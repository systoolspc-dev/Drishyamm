import { useNavigate } from 'react-router-dom';
import { X, MapPin, ArrowLeftRight, Clock, Video, AlertTriangle, ShieldCheck } from 'lucide-react';

// Right drawer — the "Selected Person" panel. Slides in when a tracked person is
// picked anywhere on the page (timeline / sessions / events). Identity + current
// activity + AI confidence + room context + today's movement timeline + related
// alerts, and a jump into Live Monitoring.
export default function PersonDrawer({ person, onClose }) {
  const navigate = useNavigate();
  const open = !!person;
  const initials = person ? (person.name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase() : '';

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-[1px]" onClick={onClose} aria-hidden />}

      <aside
        className={`fixed right-0 top-0 z-50 flex h-[var(--app-vh)] w-[380px] max-w-[calc(var(--app-vw)*0.92)] transform flex-col bg-surface shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        aria-hidden={!open}
      >
        {person && (
          <>
            {/* Header */}
            <div className="flex items-start gap-3 border-b border-line-subtle p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15 text-body font-bold text-brand-ink">
                {initials}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-heading font-bold text-fg">{person.name}</p>
                <p className="truncate text-caption text-fg-muted">{person.role}</p>
              </div>
              <button onClick={onClose} className="rounded-md p-1 text-fg-subtle hover:bg-surface-muted hover:text-fg-secondary" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {/* Activity + confidence */}
              <div className="rounded-xl border border-line bg-surface-sunken/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">Current Activity</span>
                  <span className="font-mono text-caption font-semibold text-fg-muted">{person.duration}</span>
                </div>
                <p className="mt-1 text-body font-bold text-fg">{person.activity}</p>
                <div className="mt-2">
                  <div className="mb-1 flex items-center justify-between text-micro">
                    <span className="font-medium text-fg-muted">AI confidence</span>
                    <span className="font-bold tabular-nums text-fg-secondary">{person.confidence}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${person.confidence}%` }} />
                  </div>
                </div>
              </div>

              {/* Room context */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-line p-3">
                  <p className="flex items-center gap-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">
                    <MapPin className="h-3 w-3" /> Current Room
                  </p>
                  <p className="mt-1 text-small font-semibold text-fg">{person.room}</p>
                </div>
                <div className="rounded-xl border border-line p-3">
                  <p className="flex items-center gap-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">
                    <ArrowLeftRight className="h-3 w-3" /> Previous Room
                  </p>
                  <p className="mt-1 text-small font-semibold text-fg-secondary">{person.prevRoom}</p>
                </div>
              </div>

              {/* Timeline */}
              <div className="mt-4">
                <p className="mb-2 flex items-center gap-1.5 text-caption font-bold uppercase tracking-wide text-fg-subtle">
                  <Clock className="h-3.5 w-3.5" /> Today&apos;s Timeline
                </p>
                <ol className="relative ml-1 border-l border-line pl-4">
                  {person.timeline.map((t, i) => (
                    <li key={i} className="relative pb-3 last:pb-0">
                      <span className={`absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${i === 0 ? 'bg-brand' : 'bg-line-strong'}`} />
                      <p className="text-small font-semibold text-fg">{t.activity}</p>
                      <p className="text-micro text-fg-subtle">{t.time} · {t.room}</p>
                    </li>
                  ))}
                </ol>
              </div>

              {/* Related alerts */}
              <div className="mt-4">
                <p className="mb-2 flex items-center gap-1.5 text-caption font-bold uppercase tracking-wide text-fg-subtle">
                  <AlertTriangle className="h-3.5 w-3.5" /> Related Alerts
                </p>
                {person.alerts.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2 text-caption text-success-ink">
                    <ShieldCheck className="h-4 w-4 shrink-0" /> No related alerts — activity is normal.
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {person.alerts.map((a, i) => (
                      <li key={i} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5">
                        <span className={`absolute left-0 top-0 h-full w-1 ${a.severity === 'high' ? 'bg-danger' : a.severity === 'medium' ? 'bg-warning' : 'bg-line-strong'}`} />
                        <p className="text-small font-semibold text-fg">{a.title}</p>
                        <p className="text-micro text-fg-muted">{a.meta}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Footer CTA */}
            <div className="border-t border-line-subtle p-3">
              <button
                onClick={() => navigate('/live')}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-3 py-2.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover"
              >
                <Video className="h-4 w-4" /> Open in Live Monitoring
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
