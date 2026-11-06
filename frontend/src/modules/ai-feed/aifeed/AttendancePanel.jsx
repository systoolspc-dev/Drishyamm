import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DoorOpen, LogIn, LogOut, UserRound, PencilLine, Maximize2, X, HelpCircle, ClipboardList } from 'lucide-react';
import { aiService } from '@/core/services/ai';

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
// Always India time, whatever the viewer's browser is on.
function fmtClock(ts) {
  if (!ts) return '—';
  try { return new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }); } catch { return '—'; }
}

function Stat({ label, value, tone = 'slate' }) {
  const c = { slate: 'text-fg', green: 'text-success-ink', amber: 'text-warning-ink', blue: 'text-info-ink' }[tone];
  return (
    <div className="rounded-lg border border-line bg-surface-sunken/60 px-2.5 py-2 text-center">
      <div className={`text-heading font-bold tabular-nums leading-none ${c}`}>{value}</div>
      <div className="mt-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
    </div>
  );
}

function CrossingRow({ c }) {
  const isIn = c.direction === 'in';
  const known = !!c.name;
  return (
    <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-2">
      {isIn ? <LogIn className="h-4 w-4 shrink-0 text-success" /> : <LogOut className="h-4 w-4 shrink-0 text-fg-subtle" />}
      <span className={`w-8 shrink-0 text-micro font-bold ${isIn ? 'text-success-ink' : 'text-fg-subtle'}`}>{isIn ? 'IN' : 'OUT'}</span>
      <span className={`min-w-0 flex-1 truncate text-small font-semibold ${known ? 'text-fg' : 'text-fg-subtle italic'}`}>{c.name || 'Unknown person'}</span>
      {!isIn && c.duration_sec != null && <span className="shrink-0 text-micro text-fg-subtle">{fmtDur(c.duration_sec)}</span>}
      <span className="shrink-0 text-micro tabular-nums text-fg-subtle">{fmtClock(c.ts)}</span>
    </div>
  );
}

export default function AttendancePanel({ hasLine, aiEnabled, onDrawLine }) {
  const [openFull, setOpenFull] = useState(false);
  const { data } = useQuery({ queryKey: ['ai-attendance'], queryFn: () => aiService.activityAttendance(), refetchInterval: 3000 });
  const people = data?.people || [];
  const totals = data?.totals || {};
  const insideKnown = data?.inside_count ?? 0;
  const insideUnknown = data?.unknown_inside ?? 0;
  const recent = data?.recent || [];

  if (!aiEnabled) {
    return <Shell><div className="px-4 py-6 text-center text-small text-fg-muted">Turn on AI / Face Detection for this camera to record attendance.</div></Shell>;
  }
  if (!hasLine) {
    return (
      <Shell>
        <div className="px-4 py-6 text-center">
          <p className="text-small text-fg-muted">Draw an <b>in/out line</b> on this camera — everyone crossing it is recorded (recognized people by name, others as “Unknown”).</p>
          {onDrawLine && <button onClick={onDrawLine} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-small font-bold text-white hover:opacity-90"><PencilLine className="h-3.5 w-3.5" /> Draw line</button>}
        </div>
      </Shell>
    );
  }

  return (
    <>
      <Shell right={
        <div className="flex items-center gap-1.5">
          <Link to="/attendance-report" className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-caption font-semibold text-fg-secondary hover:bg-surface-sunken"><ClipboardList className="h-3 w-3" /> Report</Link>
          <button onClick={() => setOpenFull(true)} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-caption font-semibold text-fg-secondary hover:bg-surface-sunken"><Maximize2 className="h-3 w-3" /> Full view</button>
        </div>
      }>
        {/* live totals */}
        <div className="grid grid-cols-4 gap-1.5 px-3 pt-3">
          <Stat label="Inside" value={insideKnown + insideUnknown} tone="green" />
          <Stat label="In today" value={totals.in ?? 0} tone="blue" />
          <Stat label="Out today" value={totals.out ?? 0} />
          <Stat label="Unknown" value={totals.in_unknown ?? 0} tone="amber" />
        </div>
        {/* live recent feed */}
        <div className="px-4 pt-3 pb-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Latest activity</div>
        <div className="max-h-52 overflow-y-auto">
          {recent.length === 0
            ? <div className="px-4 py-5 text-center text-small text-fg-subtle">No crossings yet — the line is live and watching.</div>
            : recent.slice(0, 12).map((c, i) => <CrossingRow key={i} c={c} />)}
        </div>
      </Shell>
      {openFull && <FullAttendance onClose={() => setOpenFull(false)} people={people} totals={totals} insideKnown={insideKnown} insideUnknown={insideUnknown} date={data?.date} />}
    </>
  );
}

function Shell({ children, right }) {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
        <DoorOpen className="h-4 w-4 text-brand" />
        <h3 className="text-body font-bold text-fg">In / Out Attendance</h3>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </div>
  );
}

// Full-screen complete attendance: stats + per-person + the entire live entry/exit feed.
function FullAttendance({ onClose, people, totals, insideKnown, insideUnknown, date }) {
  const { data } = useQuery({ queryKey: ['ai-crossings-full'], queryFn: () => aiService.activityCrossings({ limit: 500 }), refetchInterval: 3000 });
  const feed = data?.crossings || [];
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[calc(var(--app-vh)*0.9)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line-subtle px-5 py-3.5">
          <DoorOpen className="h-5 w-5 text-brand" />
          <h2 className="text-heading font-bold text-fg">In / Out Attendance</h2>
          <span className="text-small text-fg-subtle">Camera Recp · {date || 'today'}</span>
          <button onClick={onClose} className="ml-auto rounded-md p-1.5 text-fg-subtle hover:bg-surface-muted"><X className="h-4.5 w-4.5" /></button>
        </div>

        {/* stats */}
        <div className="grid grid-cols-2 gap-2 px-5 py-3 sm:grid-cols-5">
          <Stat label="Inside now" value={insideKnown + insideUnknown} tone="green" />
          <Stat label="Entries today" value={totals.in ?? 0} tone="blue" />
          <Stat label="Exits today" value={totals.out ?? 0} />
          <Stat label="Recognized in" value={totals.in_known ?? 0} tone="green" />
          <Stat label="Unknown in" value={totals.in_unknown ?? 0} tone="amber" />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-2">
          {/* per-person */}
          <div className="flex min-h-0 flex-col border-t border-line-subtle md:border-r">
            <div className="px-5 pt-3 pb-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">People today ({people.length})</div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {people.length === 0 ? <div className="px-3 py-6 text-center text-small text-fg-subtle">No recognized people yet.</div>
                : people.map((p) => (
                  <div key={p.name} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-sunken">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full ${p.currently_inside ? 'bg-success-soft text-success-ink' : 'bg-surface-muted text-fg-subtle'}`}><UserRound className="h-4.5 w-4.5" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-body font-bold text-fg">{p.name}</span>
                        {p.currently_inside ? <span className="rounded bg-success-soft px-1.5 py-px text-micro font-bold text-success-ink">IN</span> : <span className="rounded bg-surface-muted px-1.5 py-px text-micro font-bold text-fg-muted">OUT</span>}
                      </div>
                      <div className="text-micro text-fg-subtle">first in {fmtClock(p.first_entry)} · {p.in_count}× in · {p.out_count}× out</div>
                    </div>
                    <div className="text-right">
                      <div className="text-body font-bold tabular-nums text-fg-secondary">{fmtDur(p.total_inside_sec)}</div>
                      <div className="text-micro text-fg-subtle">{p.currently_inside ? `now ${fmtDur(p.current_inside_sec)}` : 'inside total'}</div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
          {/* complete feed */}
          <div className="flex min-h-0 flex-col border-t border-line-subtle">
            <div className="flex items-center gap-1.5 px-5 pt-3 pb-1 text-caption font-semibold uppercase tracking-wide text-fg-subtle">
              Every entry / exit ({feed.length})
              <span className="inline-flex items-center gap-1 rounded bg-success-soft px-1.5 py-px text-micro font-bold text-success-ink"><span className="h-1 w-1 rounded-full bg-success" />live</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {feed.length === 0 ? <div className="px-5 py-6 text-center text-small text-fg-subtle">No crossings recorded yet today.</div>
                : feed.map((c, i) => <CrossingRow key={i} c={c} />)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-t border-line-subtle px-5 py-2 text-micro text-fg-subtle">
          <HelpCircle className="h-3.5 w-3.5" /> Recognized faces show by name; everyone else is logged as “Unknown”. Times are IST.
        </div>
      </div>
    </div>
  );
}
