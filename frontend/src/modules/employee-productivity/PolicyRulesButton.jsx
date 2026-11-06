import { useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Info, Clock, Coffee, Hourglass, Smartphone, MonitorX, UsersRound } from 'lucide-react';
import { useActivityParams } from './useCaseStore';

// "ⓘ Retail Policy Rules" — the vertical's thresholds as a structured card,
// opened on hover (a glance) or click / Enter (touch, keyboard). It replaces the
// full-width PolicyBar strip on pages where the rules are reference, not
// content: the same facts, grouped and labelled, without a row of page height.
//
// Every value is read from the vertical's params (src/use-cases/<vertical>),
// so the card can never disagree with what the system actually enforces. A
// rule the vertical does not define simply does not render.

const mins = (sec) => `${Math.round(sec / 60)}m`;

function rulesFor(params) {
  const [open, close] = String(params.businessHours || '').split('-');
  const b = params.breaks || {};
  const rows = [
    params.businessHours && {
      icon: Clock, label: 'Store hours',
      value: `${open} – ${close}`,
      note: params.lateAfter ? `Grace period until ${params.lateAfter}` : null,
    },
    (b.teaMaxSec || b.lunchMaxSec || params.breakGapSec) && {
      icon: Coffee, label: 'Breaks',
      value: [
        b.teaMaxSec && `Max tea ${mins(b.teaMaxSec)}`,
        b.lunchMaxSec && `Max lunch ${mins(b.lunchMaxSec)}`,
        params.breakGapSec && `Min gap ${mins(params.breakGapSec)}`,
      ].filter(Boolean).join(' · '),
    },
    params.idleAlertSec && { icon: Hourglass, label: 'Max idle / event', value: mins(params.idleAlertSec) },
    params.phone && {
      icon: Smartphone, label: 'Phone usage',
      value: `${params.phone.holdSec}s hold${params.phone.requireHand ? ' · active in-hand' : ''}`,
    },
    params.zones?.counterUnattendedSec && { icon: MonitorX, label: 'Counter unattended', value: mins(params.zones.counterUnattendedSec) },
    params.queue?.maxQueue && { icon: UsersRound, label: 'Max queue threshold', value: `${params.queue.maxQueue} people` },
  ];
  return rows.filter(Boolean);
}

export default function PolicyRulesButton({ className = '' }) {
  const { params } = useActivityParams();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const hoverOpen = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hoverClose = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };
  const rules = rulesFor(params);
  if (!rules.length) return null;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className={`inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-caption font-semibold text-fg-muted transition hover:border-brand/40 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:border-brand/40 data-[state=open]:text-brand-ink lg:h-7 ${className}`}
        >
          <Info className="h-3.5 w-3.5" /> Policy Rules
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className="z-50 w-80 max-w-[calc(var(--app-vw)-2rem)] rounded-xl border border-line bg-surface p-3 text-left shadow-lg outline-none"
        >
          <p className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Policy</p>
          <dl className="mt-2 divide-y divide-line-subtle">
            {rules.map(({ icon: Icon, label: k, value, note }) => (
              <div key={k} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                <dt className="flex-1 text-small text-fg-muted">{k}</dt>
                <dd className="text-right">
                  <span className="block text-small font-semibold tabular-nums text-fg">{value}</span>
                  {note && <span className="block text-caption text-fg-subtle">{note}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <PopoverPrimitive.Arrow className="fill-surface" width={10} height={5} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
