import { Download } from 'lucide-react';
import Panel from '../Panel';
import { RECENT_REPORTS, FORMAT_META } from '../../reports-data';

// Recent Reports — the download history. Each row re-downloads in its stored
// format.
export default function RecentReports({ onExport }) {
  return (
    <Panel icon={Download} title="Recent Reports" count={RECENT_REPORTS.length} bodyClass="p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-2 pb-2 font-semibold">Report</th>
              <th className="px-2 pb-2 font-semibold">Type</th>
              <th className="px-2 pb-2 font-semibold">Period</th>
              <th className="px-2 pb-2 font-semibold">Scope</th>
              <th className="px-2 pb-2 font-semibold">Generated</th>
              <th className="px-2 pb-2 text-right font-semibold">Size</th>
              <th className="px-2 pb-2 font-semibold">Format</th>
              <th className="px-2 pb-2 text-right font-semibold">Download</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {RECENT_REPORTS.map((r, i) => {
              const fmt = FORMAT_META[r.format] || FORMAT_META.CSV;
              return (
                <tr key={i} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{r.name}</td>
                  <td className="px-2 py-2 text-fg-secondary">{r.type}</td>
                  <td className="px-2 py-2 text-fg-muted">{r.period}</td>
                  <td className="px-2 py-2 text-fg-muted">{r.scope}</td>
                  <td className="px-2 py-2 text-fg-muted">{r.generated}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-muted">{r.size}</td>
                  <td className="px-2 py-2">
                    <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${fmt.chip}`}>{fmt.label}</span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => onExport({ title: r.name, type: r.type, period: r.period, scope: r.scope }, r.format)}
                      title={`Download ${r.format}`}
                      className="inline-flex items-center justify-center rounded-md border border-line bg-surface p-1.5 text-fg-muted transition hover:border-brand/40 hover:text-brand-ink"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
