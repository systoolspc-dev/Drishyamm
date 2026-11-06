import { useState } from 'react';
import { ArrowUpRight, Info } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/core/ui/dialog';
import { StatusBadge } from '@/core/ui/status-badge';
import { COLUMNS } from './health-columns';
import { BUCKETS } from './health-vocabulary';

function Section({ title, children }) {
  return (
    <section>
      <h3 className="text-small font-bold uppercase tracking-wide text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * What every column and every status on this page means, on demand.
 *
 * This used to be a card in the sidebar, permanently open, costing ~140px of
 * the page's height to say something an operator reads once. It is now an info
 * icon in the header controls and a dialog behind it: the same words, no
 * standing rent, and room for the full reference that never fitted in a 320px
 * column.
 *
 * Both lists are generated — the columns from COLUMNS, the statuses from
 * BUCKETS — so the page cannot grow a column or a state and leave it
 * unexplained here.
 */
export function HealthGuide({ className }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="What the columns mean"
        title="What the columns mean"
        className={cn('text-fg-muted hover:text-brand-ink', className)}
      >
        <Info className="h-4 w-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(var(--app-vh)*0.85)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reading the camera list</DialogTitle>
            <DialogDescription>
              Camera Status monitors the health, connectivity and performance of every camera in
              real time, refreshing every ten seconds while auto refresh is on. Use Columns on the
              table to choose which of these to show.
            </DialogDescription>
          </DialogHeader>

          <Section title="What each column shows">
            <dl className="mt-2 divide-y divide-line border-y border-line">
              {COLUMNS.map((column) => (
                <div
                  key={column.id}
                  className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4"
                >
                  <dt className="shrink-0 text-small font-bold text-fg sm:w-32">{column.label}</dt>
                  <dd className="min-w-0 text-small leading-relaxed text-fg-secondary">
                    {column.help}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="What each status means">
            <dl className="mt-2 space-y-2">
              {BUCKETS.map((bucket) => (
                <div
                  key={bucket.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-sunken p-3 sm:flex-row sm:items-start sm:gap-3"
                >
                  <dt className="shrink-0 sm:w-28">
                    <StatusBadge status={bucket.status} label={bucket.label} size="sm" />
                  </dt>
                  <dd className="min-w-0 text-small leading-relaxed text-fg-secondary">
                    {bucket.meaning} <span className="text-fg-muted">{bucket.fix}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="Working the list">
            <p className="mt-1.5 text-small leading-relaxed text-fg-secondary">
              The list is sorted worst-first, so the cameras that need you are at the top. Each
              row&apos;s menu opens the camera in Live View, reconnects it or clears a freeze; tick
              several rows to reconnect or export them together. On narrower screens the extra
              columns move into each row&apos;s detail panel, which the chevron opens.
            </p>
          </Section>

          <DialogFooter className="flex-row items-center justify-between">
            {/* A router Link, not an <a href>: a bare anchor would hard-reload
                the whole SPA to reach a page that is already loaded. The
                anchor is one that actually exists in Help — there is no
                camera-health section to deep-link to yet. */}
            <Link
              to="/help#cameras"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1 text-small font-semibold text-brand-ink transition hover:underline"
            >
              Learn more in Help
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
            <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default HealthGuide;
