import { Grid3x3 } from 'lucide-react';
import Panel from '../Panel';
import { HEATMAP } from '../../group-data';

// Collaboration heatmap — location × time, cells scaled by group intensity.
// Accent opacity encodes intensity; the peak reads darkest.
export default function GroupHeatmap() {
  const max = Math.max(...HEATMAP.zones.flatMap((z) => z.values));

  return (
    <Panel icon={Grid3x3} title="Collaboration Heatmap" right={<span className="text-caption text-fg-subtle">location × time</span>} bodyClass="p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="w-36" />
              {HEATMAP.hours.map((h) => (
                <th key={h} className="px-1 pb-1 text-micro font-semibold text-fg-subtle">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HEATMAP.zones.map((z) => (
              <tr key={z.zone}>
                <td className="whitespace-nowrap pr-2 text-right text-small font-medium text-fg-secondary">{z.zone}</td>
                {z.values.map((v, i) => {
                  const alpha = v === 0 ? 0 : 0.12 + (v / max) * 0.88;
                  const strong = v / max > 0.55;
                  return (
                    <td key={i} className="p-0">
                      <div
                        title={`${z.zone} · ${HEATMAP.hours[i]} · ${v} groups`}
                        className="flex h-9 items-center justify-center rounded-md text-caption font-bold tabular-nums transition"
                        style={{
                          backgroundColor: v === 0 ? 'var(--surface-sunken)' : `rgba(247,152,58,${alpha})`,
                          color: strong ? '#fff' : v === 0 ? 'var(--text-disabled)' : '#7c4a12',
                        }}
                      >
                        {v}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-2 text-micro text-fg-subtle">
        <span>Low</span>
        <div className="flex gap-1">
          {[0.12, 0.35, 0.58, 0.8, 1].map((a) => (
            <span key={a} className="h-3 w-6 rounded-sm" style={{ backgroundColor: `rgba(247,152,58,${a})` }} />
          ))}
        </div>
        <span>High</span>
        <span className="ml-2">· cell value = active groups</span>
      </div>
    </Panel>
  );
}
