import { FileText, Sheet, FileDown } from 'lucide-react';

// The three export formats (PDF · Excel · CSV) as a compact button group. Each
// is a real, branded download (report-document.js).
const FORMATS = [
  { id: 'PDF', icon: FileText },
  { id: 'Excel', icon: Sheet },
  { id: 'CSV', icon: FileDown },
];

export default function ExportButtons({ onExport, size = 'md' }) {
  const pad = size === 'sm' ? 'px-1.5 py-1' : 'px-2 py-1.5';
  return (
    <div className="inline-flex items-center gap-1">
      {FORMATS.map((f) => {
        const Icon = f.icon;
        return (
          <button
            key={f.id}
            onClick={() => onExport(f.id)}
            title={`Export ${f.id}`}
            className={`inline-flex items-center gap-1 rounded-md border border-line bg-surface ${pad} text-micro font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink`}
          >
            <Icon className="h-3.5 w-3.5" /> {f.id}
          </button>
        );
      })}
    </div>
  );
}
