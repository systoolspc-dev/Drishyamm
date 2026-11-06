import { ClipboardList, LogOut, ShieldCheck, CheckCircle2, Clock } from 'lucide-react';
import Panel from '../Panel';
import { SESSIONS, TEMP_ABSENCE, TEACHER_VERIFICATION, SESSION_STATUS } from '../../attendance-data';

function Chip({ status }) {
  const s = SESSION_STATUS[status] || SESSION_STATUS.pending;
  return <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${s.chip}`}>{s.label}</span>;
}

export default function AttendanceTables() {
  return (
    <div className="space-y-4">
      {/* Attendance Sessions */}
      <Panel icon={ClipboardList} title="Attendance Sessions" count={SESSIONS.length} bodyClass="p-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-2 pb-2 font-semibold">Time</th>
                <th className="px-2 pb-2 font-semibold">Session</th>
                <th className="px-2 pb-2 font-semibold">Room</th>
                <th className="px-2 pb-2 font-semibold">Teacher</th>
                <th className="px-2 pb-2 text-right font-semibold">Present / Expected</th>
                <th className="px-2 pb-2 font-semibold">Attendance</th>
                <th className="px-2 pb-2 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {SESSIONS.map((s, i) => (
                <tr key={i} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 font-mono text-small font-semibold text-fg-secondary">{s.time}</td>
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{s.subject}</td>
                  <td className="px-2 py-2 text-fg-muted">{s.room}</td>
                  <td className="px-2 py-2 text-fg-secondary">{s.teacher}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{s.present} / {s.expected}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted">
                        <div className="h-full rounded-full" style={{ width: `${s.pct}%`, background: s.pct >= 85 ? '#F7983A' : '#f59e0b' }} />
                      </div>
                      <span className="tabular-nums text-caption font-semibold text-fg-secondary">{s.pct}%</span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right"><Chip status={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Temporary Absence */}
        <Panel icon={LogOut} title="Temporary Absence" count={TEMP_ABSENCE.length} bodyClass="p-4">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Student</th>
                  <th className="px-2 pb-2 font-semibold">Left</th>
                  <th className="px-2 pb-2 font-semibold">Away</th>
                  <th className="px-2 pb-2 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {TEMP_ABSENCE.map((t, i) => (
                  <tr key={i} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2">
                      <p className="font-semibold text-fg">{t.name}</p>
                      <p className="text-micro text-fg-subtle">{t.id} · {t.dept} · {t.lastRoom}</p>
                    </td>
                    <td className="px-2 py-2 font-mono text-small text-fg-secondary">{t.leftAt}</td>
                    <td className="px-2 py-2 text-fg-secondary">{t.away}</td>
                    <td className="px-2 py-2 text-right"><Chip status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Teacher Verification */}
        <Panel icon={ShieldCheck} title="Teacher Verification" count={TEACHER_VERIFICATION.length} bodyClass="p-4">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Session</th>
                  <th className="px-2 pb-2 text-right font-semibold">AI</th>
                  <th className="px-2 pb-2 text-right font-semibold">Verified</th>
                  <th className="px-2 pb-2 text-right font-semibold">Adj.</th>
                  <th className="px-2 pb-2 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {TEACHER_VERIFICATION.map((t, i) => (
                  <tr key={i} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2">
                      <p className="font-semibold text-fg">{t.session}</p>
                      <p className="flex items-center gap-1 text-micro text-fg-subtle">
                        {t.status === 'verified' ? <CheckCircle2 className="h-3 w-3 text-success" /> : <Clock className="h-3 w-3 text-fg-subtle" />}
                        {t.teacher} · {t.time}
                      </p>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-fg-muted">{t.auto}</td>
                    <td className="px-2 py-2 text-right tabular-nums font-semibold text-fg">{t.verified ?? '—'}</td>
                    <td className={`px-2 py-2 text-right font-semibold tabular-nums ${t.adjust.startsWith('+') ? 'text-success-ink' : 'text-fg-muted'}`}>{t.adjust}</td>
                    <td className="px-2 py-2 text-right"><Chip status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
