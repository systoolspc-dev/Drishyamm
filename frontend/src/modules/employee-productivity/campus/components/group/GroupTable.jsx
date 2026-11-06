import { Users } from 'lucide-react';
import Panel from '../Panel';
import { GROUPS, DEPT_CHIP } from '../../group-data';

// Active groups table — Group · Members · Department Mix · Purpose · Location ·
// Duration. Large groups (crowds) get a subtle amber member count.
export default function GroupTable() {
  return (
    <Panel icon={Users} title="Active Groups" count={GROUPS.length} bodyClass="p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-2 pb-2 font-semibold">Group</th>
              <th className="px-2 pb-2 text-right font-semibold">Members</th>
              <th className="px-2 pb-2 font-semibold">Department Mix</th>
              <th className="px-2 pb-2 font-semibold">Purpose</th>
              <th className="px-2 pb-2 font-semibold">Location</th>
              <th className="px-2 pb-2 text-right font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {GROUPS.map((g) => (
              <tr key={g.id} className="hover:bg-surface-sunken">
                <td className="px-2 py-2.5 text-heading font-semibold text-fg">{g.label}</td>
                <td className={`px-2 py-2.5 text-right font-bold tabular-nums ${g.members >= 20 ? 'text-warning-ink' : 'text-fg-secondary'}`}>{g.members}</td>
                <td className="px-2 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {g.deptMix.map((d) => (
                      <span key={d} className={`rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${DEPT_CHIP[d] || DEPT_CHIP.Mixed}`}>{d}</span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2.5 text-fg-secondary">{g.purpose}</td>
                <td className="px-2 py-2.5 text-fg-muted">{g.location}</td>
                <td className="px-2 py-2.5 text-right font-mono text-small font-semibold text-fg-secondary">{g.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
