import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Map as MapIcon, X } from 'lucide-react';
import { FLOOR_ZONES, FLOOR_EMPLOYEES, FLOOR_CUSTOMERS, STATUS_META, EMPLOYEES } from './data';
import { useActivityParams } from '../useCaseStore';
import { T } from '../type';

// SECTION 3 — Interactive store snapshot.
//
// A schematic floor plan (1000×560 floor units) rendered as SVG: zones,
// counters, live employee dots (identified) and customer dots (anonymous
// tracks). Dummy positions only — the future backend projects camera
// detections onto this plane via the camera-mapping homography and streams
// { zones[], employees[], customers[] } (see data.js for field names).
//
// Interactions: hover any zone/employee → floating card; click → pin the
// selection (highlighted outline + detail strip under the map); click again
// or ✕ to clear.

const ZONE_FILL = {
  ok:   'fill-surface-sunken',
  low:  'fill-warning-soft',
  none: 'fill-danger-soft',
};
const ZONE_STROKE = {
  ok:   'stroke-line-strong',
  low:  'stroke-warning',
  none: 'stroke-danger',
};

export default function StoreSnapshot({ loading }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);        // { kind, data, x, y } — px inside wrapper
  const [selected, setSelected] = useState(null);  // { kind: 'zone'|'employee', data }
  const { params } = useActivityParams();          // zones page only exists where params.zones does

  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 h-4 w-44 rounded bg-surface-muted" />
        <div className="h-[320px] rounded-lg bg-surface-muted" />
      </div>
    );
  }

  const track = (e, kind, data) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    // capture the wrapper width here (event handler) — refs must not be read in render
    setHover({ kind, data, x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width });
  };
  const toggle = (kind, data) => {
    setSelected((s) => (s && s.kind === kind && s.data.id === data.id ? null : { kind, data }));
  };
  const staffIn = (zoneId) => FLOOR_EMPLOYEES.filter((p) => p.zone === zoneId);
  const isSel = (kind, id) => selected?.kind === kind && selected.data.id === id;

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MapIcon className="h-4 w-4 text-brand" />
        <h2 className="text-lg font-semibold text-fg">Store Snapshot</h2>
        <span className={T.itemMeta}>Live positions · updated 5s ago</span>
        {/* Legend */}
        <div className="ml-auto flex flex-wrap items-center gap-3 text-micro text-fg-muted">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-brand" /> Staff</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neutral" /> Customer</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-warning bg-warning-soft" /> Low activity</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-danger bg-danger-soft" /> Unattended</span>
        </div>
        {params.zones && (
          <Link to="/activity-monitoring/zones" className="text-caption font-semibold text-brand-ink hover:underline">
            Coverage details →
          </Link>
        )}
      </div>

      <div ref={wrapRef} className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox="0 0 1000 560" className="w-full rounded-lg bg-surface-muted/60" role="img" aria-label="Store floor layout">
          {/* Zones */}
          {FLOOR_ZONES.map((z) => (
            <g
              key={z.id}
              className="cursor-pointer"
              onMouseMove={(e) => track(e, 'zone', z)}
              onClick={() => toggle('zone', z)}
            >
              <rect
                x={z.x} y={z.y} width={z.w} height={z.h} rx={10}
                className={`${ZONE_FILL[z.coverage]} ${ZONE_STROKE[z.coverage]} transition ${isSel('zone', z.id) ? 'stroke-brand' : ''}`}
                strokeWidth={isSel('zone', z.id) ? 3 : 1.5}
                strokeDasharray={z.kind === 'back' ? '6 4' : undefined}
              />
              <text x={z.x + 10} y={z.y + 20} className="fill-fg-muted select-none" fontSize="13" fontWeight="600">
                {z.label}
              </text>
              {z.kind === 'counter' && (
                <text x={z.x + 10} y={z.y + z.h - 10} className={z.coverage === 'none' ? 'fill-danger' : 'fill-fg-subtle'} fontSize="11">
                  {z.coverage === 'none' ? 'UNATTENDED' : `${staffIn(z.id).length} staff · ${z.customers} in queue`}
                </text>
              )}
            </g>
          ))}

          {/* Customers — anonymous, small and muted so staff reads first */}
          {FLOOR_CUSTOMERS.map((c) => (
            <circle key={c.id} cx={c.x} cy={c.y} r={5} className="fill-fg-subtle/70" />
          ))}

          {/* Employees — brand-orange, initials, hoverable/selectable */}
          {FLOOR_EMPLOYEES.map((p) => {
            const initials = p.name.split(' ').map((w) => w[0]).join('');
            const sel = isSel('employee', p.id);
            return (
              <g
                key={p.id}
                className="cursor-pointer"
                onMouseMove={(e) => track(e, 'employee', p)}
                onClick={(e) => { e.stopPropagation(); toggle('employee', p); }}
              >
                {sel && <circle cx={p.x} cy={p.y} r={17} className="fill-none stroke-brand" strokeWidth={2.5} />}
                <circle cx={p.x} cy={p.y} r={12} className="fill-brand stroke-surface" strokeWidth={2.5} />
                <text x={p.x} y={p.y + 4} textAnchor="middle" className="fill-white select-none" fontSize="10" fontWeight="700">
                  {initials}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Hover card — follows the cursor, flips near the right edge */}
        {hover && (
          <div
            className="pointer-events-none absolute z-10 w-52 rounded-lg border border-line bg-surface p-2.5 shadow-lg"
            style={{
              left: Math.min(hover.x + 14, (hover.w || 600) - 220),
              top: Math.max(hover.y - 10, 0),
            }}
          >
            {hover.kind === 'employee' ? (
              <EmployeeHover emp={hover.data} />
            ) : (
              <ZoneHover zone={hover.data} staff={staffIn(hover.data.id)} />
            )}
          </div>
        )}
      </div>

      {/* Pinned selection strip */}
      {selected && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-small text-fg-secondary">
          <span className="font-semibold text-fg">
            {selected.kind === 'employee' ? selected.data.name : selected.data.label}
          </span>
          {selected.kind === 'employee' ? (
            <span className="text-fg-muted">
              {EMPLOYEES.find((e) => e.id === selected.data.id)?.role} · in {FLOOR_ZONES.find((z) => z.id === selected.data.zone)?.label} · {STATUS_META[selected.data.status]?.label}
            </span>
          ) : (
            <span className="text-fg-muted">
              {staffIn(selected.data.id).length} staff · {selected.data.customers} customers · coverage {selected.data.coverage === 'ok' ? 'normal' : selected.data.coverage === 'low' ? 'low activity' : 'unattended'}
            </span>
          )}
          <button onClick={() => setSelected(null)} className="ml-auto text-fg-subtle hover:text-fg-secondary" aria-label="Clear selection">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function EmployeeHover({ emp }) {
  const meta = STATUS_META[emp.status] || STATUS_META.onfloor;
  const detail = EMPLOYEES.find((e) => e.id === emp.id);
  return (
    <>
      <p className={T.itemTitle}>{emp.name}</p>
      <p className={T.itemMeta}>{detail?.role} · since {detail?.clockIn || '—'}</p>
      <span className={`mt-1.5 inline-flex items-center gap-1 ${T.stateBadge} ring-1 ${meta.cls}`}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} /> {meta.label}
      </span>
    </>
  );
}

function ZoneHover({ zone, staff }) {
  return (
    <>
      <p className={T.itemTitle}>{zone.label}</p>
      <p className={`mt-0.5 ${T.itemMeta}`}>
        {staff.length} staff · {zone.customers} customer{zone.customers === 1 ? '' : 's'}
      </p>
      <p className={`mt-1 text-xs font-semibold ${zone.coverage === 'ok' ? 'text-success-ink' : zone.coverage === 'low' ? 'text-warning-ink' : 'text-danger-ink'}`}>
        {zone.coverage === 'ok' ? 'Coverage normal' : zone.coverage === 'low' ? 'Low activity 38m' : 'Unattended 6m 20s'}
      </p>
      {staff.length > 0 && (
        <p className={`mt-1 truncate ${T.itemMeta}`}>{staff.map((s) => s.name.split(' ')[0]).join(', ')}</p>
      )}
    </>
  );
}
