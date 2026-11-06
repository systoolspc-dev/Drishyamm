import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Route, Video } from 'lucide-react';
import { aggressionIncidents, severityLabels } from './aggressionIncidentData';

const CAMERA_TRAILS = {
  'AGG-1548': [
    { cam: 'CAM-07', loc: 'Main Road - East Gate', time: '14:22:11', event: 'Physical aggression detected', confidence: 98, signal: 'Impact motion + cluster compression', x: 46, y: 42 },
    { cam: 'CAM-07', loc: 'East Gate Road Lane', time: '14:23:06', event: 'Aggression remains active in same camera field', confidence: 94, signal: 'Repeated contact motion', x: 52, y: 46 },
    { cam: 'CAM-19', loc: 'East Entrance Link', time: '14:25:25', event: 'Related movement cluster appears near exit corridor', confidence: 82, signal: 'Fast dispersal pattern', x: 58, y: 44 },
  ],
  'AGG-1542': [
    { cam: 'CAM-03', loc: 'Main Concourse', time: '13:58:42', event: 'Pushing pattern detected', confidence: 91, signal: 'Repeated forceful-contact motion', x: 42, y: 47 },
    { cam: 'CAM-03', loc: 'Queue Lane', time: '14:00:04', event: 'Activity area shifts along queue lane', confidence: 86, signal: 'Abrupt body displacement', x: 50, y: 45 },
  ],
  'AGG-1537': [
    { cam: 'CAM-11', loc: 'Waiting Lounge', time: '13:41:09', event: 'Crowd escalation detected', confidence: 82, signal: 'Cluster compression', x: 48, y: 44 },
    { cam: 'CAM-11', loc: 'Platform Lobby', time: '13:42:20', event: 'Crowd density stabilizing', confidence: 74, signal: 'Reduced abrupt motion', x: 55, y: 47 },
  ],
};

function fallbackTrail(incident) {
  return [
    { cam: incident.camera, loc: incident.zone, time: incident.time, event: `${incident.type} detected`, confidence: incident.confidence, signal: incident.detail, x: 48, y: 44 },
    { cam: incident.camera, loc: incident.zone, time: incident.time, event: 'Operator review point', confidence: Math.max(60, incident.confidence - 8), signal: incident.reviewStage, x: 55, y: 45 },
  ];
}

function TrailStop({ stop, active, index, onClick }) {
  return (
    <button type="button" onClick={onClick} className="relative min-w-[230px] flex-1 text-left">
      <div
        className="relative z-10 rounded-xl border p-3 transition"
        style={{
          borderColor: active ? '#F7983A' : 'var(--color-border)',
          background: active ? 'rgba(247,152,58,.08)' : 'var(--color-surface)',
          boxShadow: active ? '0 0 0 1px rgba(247,152,58,.16)' : 'none',
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold" style={{ background: active ? '#F7983A' : 'var(--color-surface-high)', color: active ? '#fff' : 'var(--color-text-secondary)' }}>
            {index + 1}
          </span>
          <span className="font-mono text-[11px] font-bold text-[#F7983A]">{stop.cam}</span>
        </div>
        <div className="text-sm font-bold text-[var(--color-on-bg)]">{stop.loc}</div>
        <div className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">{stop.event}</div>
        <div className="mt-3 flex items-center justify-between text-[11px]">
          <span className="font-mono text-[var(--color-text-secondary)]">{stop.time}</span>
          <span className={active ? 'font-bold text-[#F7983A]' : 'text-[var(--color-text-secondary)]'}>{stop.confidence}%</span>
        </div>
      </div>
    </button>
  );
}

export default function AggressionReID() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const incidentId = searchParams.get('incident') || aggressionIncidents[0].id;
  const incident = useMemo(
    () => aggressionIncidents.find(item => item.id === incidentId) || aggressionIncidents[0],
    [incidentId],
  );
  const trail = useMemo(() => CAMERA_TRAILS[incident.id] || fallbackTrail(incident), [incident]);
  const [activeIndex, setActiveIndex] = useState(trail.length - 1);
  const [playing, setPlaying] = useState(false);
  const activeStop = trail[activeIndex] || trail[trail.length - 1];

  useEffect(() => {
    setActiveIndex(trail.length - 1);
    setPlaying(false);
  }, [incident.id, trail.length]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex(current => (current + 1) % trail.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [playing, trail.length]);

  const summary = [
    { label: 'Incident', value: incident.id },
    { label: 'Detection', value: incident.type },
    { label: 'Zone', value: activeStop.loc },
    { label: 'Confidence', value: `${activeStop.confidence}%` },
  ];

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        {summary.map(item => (
          <div key={item.label} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">{item.label}</div>
            <div className="mt-1 text-lg font-extrabold text-[var(--color-on-bg)]">{item.value}</div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Route size={16} className="text-[#F7983A]" />
                <h2 className="text-base font-bold">Aggression Camera Trail</h2>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {incident.title} - {incident.zone} - camera continuity for the detected aggression event.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setActiveIndex(i => Math.max(0, i - 1))} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]" title="Previous stop">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setPlaying(value => !value)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F7983A] text-white" title={playing ? 'Pause auto-play' : 'Start auto-play'}>
                {playing ? <Pause size={15} /> : <Play size={15} />}
              </button>
              <button onClick={() => setActiveIndex(i => Math.min(trail.length - 1, i + 1))} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]" title="Next stop">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto border-b border-[var(--color-border)] p-4">
          <div className="flex min-w-max gap-3">
            {trail.map((stop, index) => (
              <TrailStop key={`${stop.cam}-${stop.time}`} stop={stop} active={index === activeIndex} index={index} onClick={() => setActiveIndex(index)} />
            ))}
          </div>
        </div>

        <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="relative min-h-[420px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(#cbd5e1 1px,transparent 1px),linear-gradient(90deg,#cbd5e1 1px,transparent 1px)', backgroundSize: '36px 36px' }} />
            <div className="absolute left-6 top-5 rounded-lg bg-[#F7983A] px-2 py-1 text-[10px] font-bold text-white">REC</div>
            <div className="absolute right-6 top-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-high)] px-2 py-1 font-mono text-[10px] text-[var(--color-on-bg)]">{activeStop.cam}</div>
            <div
              className="absolute rounded-xl border-2 shadow-[0_0_30px_rgba(247,152,58,.22)]"
              style={{ left: `${Math.max(8, activeStop.x - 18)}%`, top: `${Math.max(10, activeStop.y - 14)}%`, width: '36%', height: '30%', borderColor: '#F7983A', background: 'rgba(247,152,58,.10)' }}
            >
              <div className="absolute -top-8 left-0 whitespace-nowrap rounded bg-[#F7983A] px-2 py-1 text-[10px] font-bold text-white">
                AGGRESSION ACTIVITY / {activeStop.confidence}%
              </div>
            </div>
            <div className="absolute bottom-0 left-0 right-0 border-t border-[var(--color-border)] bg-[var(--color-surface-high)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-[var(--color-on-bg)]">{activeStop.event}</div>
                  <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">{activeStop.cam} / {activeStop.time} / {activeStop.loc}</div>
                </div>
                <button className="rounded-lg bg-[#F7983A] px-3 py-2 text-xs font-bold text-white">Play Segment</button>
              </div>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="mb-3 text-[10px] font-bold uppercase text-[var(--color-text-muted)]">Selected Segment</div>
              <div className="grid gap-3 text-xs">
                {[
                  ['Incident', incident.id],
                  ['Detection', incident.type],
                  ['Camera', activeStop.cam],
                  ['Zone', activeStop.loc],
                  ['Signal', activeStop.signal],
                  ['Severity', severityLabels[incident.severity]],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">{label}</div>
                    <div className="mt-1 font-semibold text-[var(--color-on-bg)]">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border p-4" style={{ borderColor: 'rgba(247,152,58,.30)', background: 'rgba(247,152,58,.08)' }}>
              <div className="text-[10px] font-bold uppercase text-[#F7983A]">System Boundary</div>
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                This view tracks camera evidence for an aggression event. It does not assign identity, blame, or role labels.
              </p>
              <button className="btn btn-ghost mt-3 w-full justify-center text-xs" onClick={() => navigate(`/ai-analytics/aggression/timeline?incident=${incident.id}`)}>
                <Video size={14} /> Open Timeline
              </button>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
