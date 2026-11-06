import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, ConciergeBell } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { GUEST_SERVICE_DATA } from './pages-data';
import { Chip } from './components/bits';

export default function DeskDetail() {
  const { id } = useParams();
  const desk = GUEST_SERVICE_DATA.desks.find((x) => x.id === id);

  if (!desk) {
    return (
      <div className="w-full page-inset-x py-10 text-center">
        <p className="text-body text-fg-muted">Desk not found.</p>
        <Link to="/activity-monitoring/hospitality/guest-service" className="mt-2 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to Guest Service</Link>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <Link to="/activity-monitoring/hospitality/guest-service" className="mb-2 inline-flex items-center gap-1 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink"><ChevronLeft className="h-3.5 w-3.5" /> Back to Guest Service</Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-ink"><ConciergeBell className="h-6 w-6" strokeWidth={2} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold text-fg sm:text-base">{desk.name}</h2><Chip status={desk.status} label={desk.status} /></div>
            <p className="truncate text-small text-fg-muted">{desk.role}</p>
          </div>
        </div>
        <div className="max-w-md">
          <Panel icon={ConciergeBell} title="Current Status" bodyClass="p-4">
            <div className="space-y-2 text-small text-fg-secondary">
              <div className="flex items-center justify-between"><span className="text-fg-subtle">Function</span><span className="font-semibold text-fg">{desk.role}</span></div>
              <div className="flex items-center justify-between"><span className="text-fg-subtle">Guests waiting</span><span className="font-semibold text-fg">{desk.queue}</span></div>
              <div className="flex items-center justify-between"><span className="text-fg-subtle">Desk status</span><Chip status={desk.status} label={desk.status} /></div>
            </div>
            <p className="mt-3 border-t border-line-subtle pt-3 text-caption text-fg-muted">{desk.queue} guest{desk.queue === 1 ? '' : 's'} currently waiting at this desk.</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
