import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Brain, Camera, LayoutGrid } from 'lucide-react';
import faceWatchlistMockData from '../../data/faceWatchlistMockData';

const data = faceWatchlistMockData.behaviorIntelligence;

const levelClass = {
  High: { card: 'border-red-200 bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  Medium: { card: 'border-[var(--color-border-accent)] bg-[var(--color-primary-bg)]', text: 'text-[var(--color-info-text)]', dot: 'bg-[var(--action-primary)]' },
  Low: { card: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
};

const snapshotLayouts = {
  single: { label: 'Single', grid: 'grid-cols-1', limit: 1 },
  '2x2': { label: '2 x 2', grid: 'grid-cols-1 sm:grid-cols-2', limit: 4 },
  '3x3': { label: '3 x 3', grid: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3', limit: 9 },
};

const behaviorColor = {
  Running: '#b7791f',
  Loitering: '#ef4444',
  'Looking Around': '#eab308',
  'Phone Usage': 'var(--color-text)',
};

function buildPersonBehavior(person, index) {
  const cameraShift = ['CAM-04', 'CAM-07', 'CAM-01', 'CAM-12', 'CAM-09', 'CAM-05'];
  const behaviorShift = ['Running', 'Loitering', 'Looking Around', 'Phone Usage'];
  const riskScore = person?.riskLevel === 'Critical' ? 88 : person?.riskLevel === 'High' ? 78 : person?.riskLevel === 'Medium' ? 58 : 32;

  return {
    subject: person?.name || data.subject,
    id: person?.id || 'WL-001',
    category: person?.category || 'Watchlist',
    riskScore,
    riskLabel: riskScore >= 70 ? 'High Attention' : riskScore >= 45 ? 'Review' : 'Normal',
    summary: data.summary.map((item, itemIndex) => ({
      ...item,
      level: itemIndex === 0 && person?.riskLevel === 'Low' ? 'Low' : item.level,
    })),
    activitySnapshots: data.activitySnapshots.map((snapshot, snapshotIndex) => ({
      ...snapshot,
      camera: cameraShift[(index + snapshotIndex) % cameraShift.length],
      behavior: behaviorShift[(index + snapshotIndex) % behaviorShift.length],
      confidence: Math.max(72, snapshot.confidence - (index % 4) * 2),
    })),
  };
}

export default function BehaviorIntelligencePage() {
  const { personId } = useParams();
  const navigate = useNavigate();
  const [layout, setLayout] = useState('2x2');
  const people = faceWatchlistMockData.watchlistManagement.persons;
  const selectedIndex = Math.max(0, people.findIndex((person) => person.id === personId));
  const selectedPerson = people[selectedIndex] || people[0];
  const behavior = useMemo(() => buildPersonBehavior(selectedPerson, selectedIndex), [selectedIndex, selectedPerson]);
  const selectedLayout = snapshotLayouts[layout] || snapshotLayouts['2x2'];
  const snapshots = behavior.activitySnapshots.slice(0, selectedLayout.limit);

  return (
    <main className="face-watchlist-page min-h-full bg-[var(--color-bg)] p-4 text-[var(--color-on-bg)]">
      <section className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-bg)] text-[var(--color-info-text)]">
              <Brain size={22} />
            </div>
            <div>
              <h2 className="text-base font-bold">Behaviour Review: <span className="text-[var(--color-info-text)]">{behavior.subject}</span></h2>
              <p className="text-xs text-[var(--color-text-secondary)]">{behavior.id} - {behavior.category} - camera activity window 14:12 to 14:22</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/ai-analytics/watchlist/suspect/${behavior.id}`)}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-high)]"
          >
            <ArrowLeft size={14} /> Back to Profile
          </button>
        </div>
      </section>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_260px]">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 text-sm font-bold">Behaviour Summary</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {behavior.summary.map((item) => {
              const level = levelClass[item.level] || levelClass.Low;
              return (
                <div key={`${item.label}-${item.time}`} className={`flex items-start gap-3 rounded-lg border p-3 ${level.card}`}>
                  <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${level.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`text-xs font-semibold ${level.text}`}>{item.label}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">{item.time}</div>
                  </div>
                  <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${level.text} border-current/30`}>{item.level}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <h3 className="mb-3 text-sm font-bold">Attention Score</h3>
          <div className="rounded-xl border border-[var(--color-border-accent)] bg-[var(--color-primary-bg)] p-4 text-center">
            <div className="text-4xl font-extrabold text-[var(--color-info-text)]">{behavior.riskScore}</div>
            <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{behavior.riskLabel}</div>
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">
            Score is based on recent motion, dwell time, and repeated camera observations for this selected profile.
          </p>
        </section>
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold"><Camera size={14} /> Activity Snapshots</h3>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Choose how many camera snapshots to review for this person.</p>
          </div>
          <label className="flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)]">
            <LayoutGrid size={13} className="text-[var(--color-info-text)]" />
            View
            <select
              value={layout}
              onChange={(event) => setLayout(event.target.value)}
              className="bg-transparent text-xs font-bold text-[var(--color-on-bg)] outline-none"
            >
              {Object.entries(snapshotLayouts).map(([value, option]) => (
                <option key={value} value={value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className={`grid gap-3 ${selectedLayout.grid}`}>
          {snapshots.map((snapshot) => {
            const color = behaviorColor[snapshot.behavior] || '#64748b';
            return (
              <div key={`${snapshot.camera}-${snapshot.time}`} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                <div className="relative flex aspect-video items-center justify-center border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                  <div className="h-20 w-12 rounded bg-[var(--color-surface-low)]" style={{ boxShadow: `0 0 0 2px ${color}` }} />
                  <span className="absolute left-2 top-2 rounded bg-[var(--color-surface)]/90 px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-secondary)]">{snapshot.camera}</span>
                  <span className="absolute right-2 top-2 rounded bg-[var(--color-surface)]/90 px-1.5 py-0.5 font-mono text-[9px] text-[var(--color-text-secondary)]">{snapshot.time}</span>
                </div>
                <div className="flex items-center justify-between gap-3 p-3">
                  <div>
                    <div className="text-xs font-bold" style={{ color }}>{snapshot.behavior}</div>
                    <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{behavior.subject}</div>
                  </div>
                  <div className="rounded-lg bg-emerald-50 px-2 py-1 font-mono text-[10px] font-bold text-emerald-700">
                    {snapshot.confidence}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
