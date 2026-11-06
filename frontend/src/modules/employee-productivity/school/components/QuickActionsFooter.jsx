import { useNavigate } from 'react-router-dom';
import { Search, FileText, BellRing, Flame, Zap } from 'lucide-react';

// Sticky footer — always-visible quick actions for the school console.
export default function QuickActionsFooter({ onSearch, onNotifyParents }) {
  const navigate = useNavigate();
  const actions = [
    { label: 'Search', icon: Search, primary: true, onClick: onSearch },
    { label: 'Generate Report', icon: FileText, onClick: () => navigate('/activity-monitoring') },
    { label: 'Notify Parents', icon: BellRing, onClick: onNotifyParents },
    { label: 'View Heatmap', icon: Flame, onClick: () => navigate('/map') },
  ];
  return (
    <div className="sticky bottom-0 z-20 page-bleed mt-4 border-t border-line bg-white/85 page-inset-x py-2.5 backdrop-blur supports-[backdrop-filter]:bg-white/70">
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="mr-1 inline-flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle">
          <Zap className="h-3.5 w-3.5 text-brand" /> Quick Actions
        </span>
        {actions.map((a) => (
          <button key={a.label} onClick={a.onClick}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-small font-semibold transition ${
              a.primary ? 'bg-brand text-white shadow-sm hover:bg-brand-hover' : 'border border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'
            }`}>
            <a.icon className="h-4 w-4" /> {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
