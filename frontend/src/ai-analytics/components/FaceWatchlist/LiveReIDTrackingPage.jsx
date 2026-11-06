import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pause, Play, Route, Video } from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';

const routeStops = [
  { zone: 'Cafeteria', camera: 'CAM-09', time: '14:02:18', confidence: 77, action: 'Face reacquired near service counter', x: 18, y: 72 },
  { zone: 'Bus Bay', camera: 'CAM-07', time: '14:11:05', confidence: 85, action: 'Subject paused near exit lane', x: 36, y: 58 },
  { zone: 'North Entry', camera: 'CAM-01', time: '14:16:10', confidence: 91, action: 'Direction change toward main concourse', x: 54, y: 36 },
  { zone: 'Parking Area', camera: 'CAM-12', time: '14:18:40', confidence: 89, action: 'Cross-camera match confirmed', x: 70, y: 52 },
  { zone: 'Main Gate', camera: 'CAM-04', time: '14:20:31', confidence: 93, action: 'Current watchlist match', x: 84, y: 28 },
];

const cameraSequence = ['CAM-09', 'CAM-07', 'CAM-01', 'CAM-12', 'CAM-04'];
const zoneSequence = ['Cafeteria', 'Bus Bay', 'North Entry', 'Parking Area', 'Main Gate'];
const actionSequence = [
  'Face reacquired near service counter',
  'Subject paused near exit lane',
  'Direction change toward main concourse',
  'Cross-camera match confirmed',
  'Current watchlist match',
];

function buildPersonStops(person, index) {
  if (!person || person.id === 'WL-001') return routeStops;
  const baseConfidence = [93, 89, 86, 85, 77, 82, 88][index % 7];
  return routeStops.map((stop, stopIndex) => ({
    ...stop,
    camera: cameraSequence[(index + stopIndex) % cameraSequence.length],
    zone: zoneSequence[(index + stopIndex) % zoneSequence.length],
    confidence: Math.max(72, baseConfidence - (routeStops.length - stopIndex - 1) * 2),
    action: stopIndex === routeStops.length - 1 ? `Current REID lock for ${person.name}` : actionSequence[stopIndex],
    x: Math.max(14, Math.min(86, stop.x + ((index % 3) - 1) * 7)),
    y: Math.max(18, Math.min(78, stop.y + ((index % 4) - 1) * 5)),
  }));
}

function buildUnknownPerson(personId) {
  const readableId = personId || 'UNK-CARRIER';
  const objectId = readableId.replace(/^UNK-/, '');
  return {
    id: readableId,
    name: 'Unknown carrier',
    category: 'Object interaction',
    risk: 'under review',
    linkedObject: objectId,
  };
}

function CameraTimelineItem({ stop, active, index, isLast, onClick }) {
  return (
    <button type="button" onClick={onClick} className="relative min-w-[220px] flex-1 text-left">
      <div className={`relative z-10 rounded-xl border p-3 transition ${active ? 'border-[var(--color-primary)] bg-[var(--color-primary-bg)] shadow-[0_0_0_1px_rgba(10,31,68,.22)]' : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'}`}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className={`grid h-8 w-8 place-items-center rounded-full text-[11px] font-bold ${active ? 'bg-[var(--action-primary)] text-[var(--action-primary-text)]' : 'bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]'}`}>{index + 1}</span>
          <span className="font-mono text-[11px] font-bold text-[var(--color-info-text)]">{stop.camera}</span>
        </div>
        <div className="text-sm font-bold text-[var(--color-on-bg)]">{stop.zone}</div>
        <div className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">{stop.action}</div>
        <div className="mt-3 flex items-center justify-between text-[11px]">
          <span className="font-mono text-[var(--color-text-secondary)]">{stop.time}</span>
          <span className={active ? 'font-bold text-[var(--color-info-text)]' : 'text-[var(--color-text-secondary)]'}>{stop.confidence}%</span>
        </div>
      </div>
    </button>
  );
}

export default function REIDTrackingPage() {
  const { personId } = useParams();
  const people = faceWatchlistMockData.watchlistManagement.persons;
  const foundIndex = people.findIndex((person) => person.id === personId);
  const selectedIndex = foundIndex >= 0 ? foundIndex : 5;
  const selectedPerson = foundIndex >= 0 ? people[foundIndex] : buildUnknownPerson(personId);
  const personStops = useMemo(() => buildPersonStops(selectedPerson, selectedIndex), [selectedIndex, selectedPerson]);
  const [activeIndex, setActiveIndex] = useState(personStops.length - 1);
  const [playing, setPlaying] = useState(false);
  const activeStop = personStops[activeIndex] || personStops[personStops.length - 1];

  useEffect(() => {
    setActiveIndex(personStops.length - 1);
    setPlaying(false);
  }, [personId, personStops.length]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % personStops.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [personStops.length, playing]);

  const summary = useMemo(() => [
    { label: 'Current Zone', value: activeStop.zone },
    { label: 'Camera', value: activeStop.camera },
    { label: 'Time', value: activeStop.time },
    { label: 'Confidence', value: `${activeStop.confidence}%` },
  ], [activeStop]);

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        {summary.map((item) => (
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
                <Route size={16} className="text-[var(--color-info-text)]" />
                <h2 className="text-base font-bold">Camera-by-Camera Stitched Timeline</h2>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{selectedPerson.name} - {selectedPerson.id} - click a camera stop to review its recording</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setActiveIndex((i) => Math.max(0, i - 1))} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]" title="Previous stop">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => setPlaying((value) => !value)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--action-primary)] text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]" title={playing ? 'Pause auto-play' : 'Start auto-play'}>
                {playing ? <Pause size={15} /> : <Play size={15} />}
              </button>
              <button onClick={() => setActiveIndex((i) => Math.min(personStops.length - 1, i + 1))} className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-surface-high)] text-[var(--color-text-secondary)]" title="Next stop">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto border-b border-[var(--color-border)] p-4">
          <div className="flex min-w-max gap-3">
            {personStops.map((stop, index) => (
              <CameraTimelineItem
                key={`${stop.camera}-${stop.time}`}
                stop={stop}
                active={index === activeIndex}
                index={index}
                isLast={index === personStops.length - 1}
                onClick={() => setActiveIndex(index)}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="relative min-h-[420px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(148,163,184,.10),rgba(100,116,139,.06)),radial-gradient(circle_at_72%_65%,rgba(247,152,58,.10),transparent_18%)]" />
            <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'linear-gradient(#94a3b8 1px,transparent 1px),linear-gradient(90deg,#94a3b8 1px,transparent 1px)', backgroundSize: '36px 36px' }} />
            <div className="absolute left-6 top-5 rounded-lg bg-red-500 px-2 py-1 text-[10px] font-bold text-white">REC</div>
            <div className="absolute right-6 top-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-secondary)]">{activeStop.camera}</div>
            <div className="absolute left-[14%] top-[22%] h-[46%] w-[30%] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-high)]/70" />
            <div className="absolute left-[57%] top-[32%] h-[34%] w-[22%] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-high)]/70" />
            <div className="absolute left-[42%] top-[42%] h-20 w-12 rounded-full border-2 border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] shadow-[0_0_30px_rgba(10,31,68,.22)]">
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--action-primary)] px-2 py-1 text-[10px] font-bold text-[var(--action-primary-text)]">
                {selectedPerson.name} / {activeStop.confidence}%
              </div>
            </div>
            <div className="absolute bottom-0 left-0 right-0 border-t border-[var(--color-border)] bg-black/55 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-[var(--color-on-bg)]">{activeStop.zone}</div>
                  <div className="mt-1 font-mono text-xs text-[var(--color-info-text)]">{activeStop.camera} / {activeStop.time}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="rounded-lg bg-[var(--action-primary)] px-3 py-2 text-xs font-bold text-[var(--action-primary-text)] hover:bg-[var(--action-primary-hover)]">Play Segment</button>
                  <button className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-bold text-[var(--color-on-surface)]">Export Clip</button>
                </div>
              </div>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Selected Segment</div>
              <div className="grid gap-3 text-xs">
                {[
                  ['Zone', activeStop.zone],
                  ['Camera', activeStop.camera],
                  ['Time', activeStop.time],
                  ['Confidence', `${activeStop.confidence}%`],
                  ['Action', activeStop.action],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="text-[10px] font-bold uppercase text-[var(--color-text-muted)]">{label}</div>
                    <div className="mt-1 font-semibold text-[var(--color-on-bg)]">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-info-text)]">Navigation</div>
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                Use the timeline above or previous/next controls to move through stitched camera segments. The recording preview updates to the selected stop.
              </p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
