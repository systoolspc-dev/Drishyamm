import { ChevronDown, FileSpreadsheet, FileText, Loader2, Sheet } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';

// The one export control every report offers: [ Export Report ▾ ] → pick a
// format. Same button, same three formats, on every card and page.
const EXPORT_FORMATS = [
  { id: 'pdf', label: 'Download PDF Document', hint: 'Formatted, print-ready', icon: FileText },
  { id: 'xlsx', label: 'Download Excel Workbook (.xlsx)', hint: 'One tab per table', icon: FileSpreadsheet },
  { id: 'csv', label: 'Download Raw Data (.csv)', hint: 'Plain rows for any tool', icon: Sheet },
];

// `formats`: optional subset of format ids ('pdf' | 'xlsx' | 'csv') for a
// report that does not offer all three; the order stays the same.
//
// `blocked` + `onBlocked`: the report can't be built yet (no site chosen). The
// button still looks live and says why on click, rather than sitting greyed
// out with the reason hidden.
export default function ExportReportMenu({
  onSelect, busy = false, disabled = false, blocked = false, onBlocked, label = 'Export Report', reportName,
  className = '', align = 'start', formats,
}) {
  const btnCls = `inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-brand-hover ${className}`;
  const aria = reportName ? `${label} — ${reportName}` : label;
  const face = (
    <>
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {busy ? 'Preparing…' : label}
      {!busy && <ChevronDown className="h-4 w-4 opacity-80" />}
    </>
  );

  if (blocked) {
    return <button type="button" aria-label={aria} disabled={disabled} onClick={onBlocked} className={btnCls}>{face}</button>;
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled || busy}>
        <button type="button" aria-label={aria} className={btnCls}>{face}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 border-line bg-surface">
        <DropdownMenuLabel className="text-micro font-semibold uppercase tracking-wider text-fg-subtle">Choose a format</DropdownMenuLabel>
        {EXPORT_FORMATS.filter((f) => !formats || formats.includes(f.id)).map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onSelect(f.id)} className="items-start gap-2.5 py-2">
            <f.icon className="mt-0.5 text-fg-muted" />
            <span className="min-w-0">
              <span className="block text-small font-semibold text-fg">{f.label}</span>
              <span className="block text-micro text-fg-subtle">{f.hint}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
