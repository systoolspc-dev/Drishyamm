import { useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, UserCheck, UserX, Clock, HelpCircle, UserMinus, Ticket, Users,
  Plus, Search, Camera, Check, Ban, Pencil, Trash2, X, CheckCircle2, ArrowUpRight, UserPlus2,
  QrCode, KeyRound, RefreshCw, History,
} from 'lucide-react';
import Panel from '../campus/components/Panel';
import { StatCards, Chip } from './components/bits';
import { GUARDIANS, GUARDIAN_RELATIONSHIPS, UNKNOWN_PICKUPS, TEMP_PASSES, PASS_AUDIT, STUDENTS } from './pages-data';

const CARD_ICONS = { verified: UserCheck, blocked: UserX, pending: Clock, unknown: HelpCircle, passes: Ticket, without: UserMinus };
const nowTime = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
// Module-scope (not a component/hook) so the OTP mock stays out of render purity.
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const ATTEMPT_CHIP = {
  'Blocked guardian': 'bg-danger-soft text-danger-ink ring-danger-line',
  'Face mismatch': 'bg-warning-soft text-warning-ink ring-warning-line',
  Unknown: 'bg-surface-muted text-fg-muted ring-line',
};
const STUDENT_NAMES = STUDENTS.map((s) => s.name);
const emptyForm = { id: null, name: '', relationship: 'Parent', students: [], phone: '', idProof: '', faceEnrolled: false };

export default function GuardianRegistry() {
  const [guardians, setGuardians] = useState(GUARDIANS);
  const [unknowns, setUnknowns] = useState(UNKNOWN_PICKUPS);
  const [passes, setPasses] = useState(TEMP_PASSES);
  const [audit, setAudit] = useState(PASS_AUDIT);
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [selStudent, setSelStudent] = useState(STUDENT_NAMES[0]);
  const [showIssue, setShowIssue] = useState(false);
  const [passForm, setPassForm] = useState({ person: '', phone: '', students: [], reason: '', window: '', oneTime: true });
  const [toast, setToast] = useState(null);
  const uid = useRef(100);
  const formRef = useRef(null);

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500); };
  const logAudit = (action, detail, actor = 'Operator') => setAudit((prev) => [{ id: `au${++uid.current}`, ts: nowTime(), actor, action, detail }, ...prev]);

  // ── derived cards ──
  const cards = useMemo(() => {
    const verified = guardians.filter((g) => g.status === 'verified').length;
    const blocked = guardians.filter((g) => g.status === 'blocked').length;
    const pending = guardians.filter((g) => g.status === 'pending').length;
    const withGuardian = new Set(guardians.filter((g) => g.status !== 'blocked').flatMap((g) => g.students));
    const without = STUDENT_NAMES.filter((n) => !withGuardian.has(n)).length;
    const activePasses = passes.filter((p) => p.status === 'active').length;
    return [
      { key: 'verified', label: 'Verified Guardians', value: `${verified}`, sub: 'face-enrolled & approved' },
      { key: 'blocked', label: 'Blocked Guardians', value: `${blocked}`, sub: 'pickup denied' },
      { key: 'pending', label: 'Pending Approval', value: `${pending}`, sub: 'awaiting verification' },
      { key: 'unknown', label: 'Unknown Pickup Attempts', value: `${unknowns.length}`, sub: 'today' },
      { key: 'passes', label: 'Active Temporary Passes', value: `${activePasses}`, sub: 'in effect now' },
      { key: 'without', label: 'Students Without a Guardian', value: `${without}`, sub: 'need enrollment' },
    ];
  }, [guardians, unknowns, passes]);

  // ── temporary pass ops ──
  const togglePassStudent = (name) => setPassForm((f) => ({ ...f, students: f.students.includes(name) ? f.students.filter((n) => n !== name) : [...f.students, name] }));
  const issuePass = () => {
    if (!passForm.person.trim() || passForm.students.length === 0) { notify('Person and at least one student are required.'); return; }
    const otp = genOtp();
    const id = `tp${++uid.current}`;
    const window = passForm.window.trim() || (passForm.oneTime ? 'Today (one-time)' : 'Custom range');
    setPasses((prev) => [{ id, person: passForm.person, phone: passForm.phone, students: passForm.students, reason: passForm.reason, window, otp, status: 'active' }, ...prev]);
    logAudit('Issued', `Temporary pass for ${passForm.person} (${passForm.students.join(', ')})`);
    notify('Temporary pass issued — parent notified.');
    setShowIssue(false);
    setPassForm({ person: '', phone: '', students: [], reason: '', window: '', oneTime: true });
  };
  const revokePass = (id) => { const p = passes.find((x) => x.id === id); setPasses((prev) => prev.map((x) => (x.id === id ? { ...x, status: 'revoked' } : x))); logAudit('Revoked', `Pass revoked — ${p?.person}`); notify('Temporary pass revoked.'); };
  const resendOtp = (id) => { const p = passes.find((x) => x.id === id); notify(`OTP resent to ${p?.phone || 'parent'}.`); };

  // ── guardian ops ──
  const setStatus = (id, status) => setGuardians((prev) => prev.map((g) => (g.id === id ? { ...g, status } : g)));
  const remove = (id) => setGuardians((prev) => prev.filter((g) => g.id !== id));
  const startEdit = (g) => { setForm({ ...g }); formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const toggleFormStudent = (name) => setForm((f) => ({ ...f, students: f.students.includes(name) ? f.students.filter((n) => n !== name) : [...f.students, name] }));

  const save = () => {
    if (!form.name.trim()) { notify('Guardian name is required.'); return; }
    if (form.id) {
      setGuardians((prev) => prev.map((g) => (g.id === form.id ? { ...g, ...form } : g)));
      notify(`Guardian "${form.name}" updated.`);
    } else {
      const id = `g${++uid.current}`;
      setGuardians((prev) => [{ ...form, id, status: 'pending' }, ...prev]);
      logAudit('Added', `Guardian added — ${form.name} (${form.students.join(', ') || 'no student'})`);
      notify(`Guardian "${form.name}" added — pending verification.`);
    }
    setForm(emptyForm);
  };

  const escalate = (id) => { const u = unknowns.find((x) => x.id === id); setUnknowns((prev) => prev.map((x) => (x.id === id ? { ...x, action: 'Escalated to security' } : x))); logAudit('Escalated', `Unauthorized pickup escalated — ${u?.student}`); notify('Escalated to security — parent notified.'); };
  const addAsGuardian = (u) => {
    const student = u.student.replace(/\s*\(.*\)$/, '');
    setForm({ ...emptyForm, students: STUDENT_NAMES.includes(student) ? [student] : [] });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    notify('Prefilled the Add Guardian form — complete the details.');
  };

  // ── list + mapping ──
  const filtered = guardians.filter((g) => (tab === 'all' || g.status === tab) && (!query || g.name.toLowerCase().includes(query.toLowerCase())));
  const counts = { all: guardians.length, verified: guardians.filter((g) => g.status === 'verified').length, blocked: guardians.filter((g) => g.status === 'blocked').length, pending: guardians.filter((g) => g.status === 'pending').length };
  const mapped = guardians.filter((g) => g.students.includes(selStudent) && g.status !== 'blocked');

  const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none';
  const labelCls = 'mb-1 block text-micro font-semibold uppercase tracking-wide text-fg-subtle';

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldCheck className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Guardian Registry</h1>
            <p className="mt-1 text-small text-fg-muted">The source-of-truth pickup verification checks against — verified, blocked and pending guardians.</p>
          </div>
        </div>

        {toast && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-success-line bg-success-soft px-3 py-2.5 text-small text-success-ink">
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <StatCards cards={cards} icons={CARD_ICONS} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Add Guardian */}
            <div ref={formRef} className="lg:col-span-2">
              <Panel icon={form.id ? Pencil : Plus} title={form.id ? 'Edit Guardian' : 'Add Guardian'} bodyClass="p-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div><label className={labelCls}>Guardian name</label><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Rajesh Sharma" className={inputCls} /></div>
                  <div><label className={labelCls}>Relationship</label>
                    <select value={form.relationship} onChange={(e) => setForm((f) => ({ ...f, relationship: e.target.value }))} className={inputCls}>
                      {GUARDIAN_RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div><label className={labelCls}>Phone</label><input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91 …" className={inputCls} /></div>
                  <div><label className={labelCls}>ID proof</label><input value={form.idProof} onChange={(e) => setForm((f) => ({ ...f, idProof: e.target.value }))} placeholder="Aadhaar / DL no." className={inputCls} /></div>
                  <div className="sm:col-span-2">
                    <label className={labelCls}>Linked student(s)</label>
                    <div className="flex flex-wrap gap-1.5">
                      {STUDENT_NAMES.map((n) => {
                        const on = form.students.includes(n);
                        return (
                          <button key={n} type="button" onClick={() => toggleFormStudent(n)}
                            className={`rounded-full px-2.5 py-1 text-caption font-semibold ring-1 transition ${on ? 'bg-brand/10 text-brand-ink ring-brand/30' : 'bg-surface text-fg-muted ring-line hover:text-fg-secondary'}`}>
                            {on && <Check className="mr-1 inline h-3 w-3" />}{n}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelCls}>Face enrollment</label>
                    <button type="button" onClick={() => setForm((f) => ({ ...f, faceEnrolled: !f.faceEnrolled }))}
                      className={`flex w-full items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-small font-semibold transition ${form.faceEnrolled ? 'border-success-line bg-success-soft text-success-ink' : 'border-line-strong bg-surface-sunken text-fg-muted hover:border-brand/40 hover:text-brand-ink'}`}>
                      {form.faceEnrolled ? <><CheckCircle2 className="h-4 w-4" /> Face enrolled</> : <><Camera className="h-4 w-4" /> Capture / upload face</>}
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover"><Plus className="h-4 w-4" /> {form.id ? 'Update' : 'Save'} Guardian</button>
                  {form.id && <button onClick={() => setForm(emptyForm)} className="rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary hover:text-fg">Cancel</button>}
                </div>
              </Panel>
            </div>

            {/* Per-student mapping */}
            <Panel icon={UserPlus2} title="Who can pick up…" bodyClass="p-4">
              <select value={selStudent} onChange={(e) => setSelStudent(e.target.value)} className={inputCls}>
                {STUDENT_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <div className="mt-3 space-y-1.5">
                {mapped.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-warning-line bg-warning-soft/60 p-3 text-caption text-warning-ink">No authorized guardian — add one.</p>
                ) : mapped.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 rounded-lg border border-line p-2">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-micro font-bold text-brand-ink">{(g.name.match(/\b\w/g) || []).slice(0, 2).join('')}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-small font-semibold text-fg">{g.name}</span><span className="block text-micro text-fg-subtle">{g.relationship}</span></span>
                    <Chip status={g.status} label={g.status} />
                  </div>
                ))}
                <button onClick={() => { setForm({ ...emptyForm, students: [selStudent] }); formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
                  className="mt-1 inline-flex items-center gap-1.5 text-caption font-semibold text-brand-ink hover:underline"><Plus className="h-3.5 w-3.5" /> Add guardian for {selStudent.split(' ')[0]}</button>
              </div>
            </Panel>
          </div>

          {/* Guardian list */}
          <Panel
            icon={Users} title="Guardians" count={guardians.length}
            right={
              <label className="relative inline-flex items-center">
                <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="w-40 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2 text-small text-fg-secondary focus:border-brand focus:outline-none" />
              </label>
            }
            bodyClass="p-4"
          >
            <div className="mb-3 flex gap-1 rounded-lg bg-surface-muted p-0.5 text-caption font-semibold">
              {['all', 'verified', 'blocked', 'pending'].map((t) => (
                <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-md px-2 py-1 capitalize transition ${tab === t ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>{t} ({counts[t]})</button>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Guardian</th><th className="px-2 pb-2 font-semibold">Relationship</th><th className="px-2 pb-2 font-semibold">Students</th>
                  <th className="px-2 pb-2 font-semibold">Phone</th><th className="px-2 pb-2 font-semibold">Face</th><th className="px-2 pb-2 font-semibold">Status</th><th className="px-2 pb-2 text-right font-semibold">Actions</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {filtered.length === 0 ? (
                    <tr><td colSpan={7} className="px-2 py-8 text-center text-small text-fg-subtle">No guardians match.</td></tr>
                  ) : filtered.map((g) => (
                    <tr key={g.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{g.name}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{g.relationship}</td>
                      <td className="px-2 py-2.5"><div className="flex flex-wrap gap-1">{g.students.map((s) => <span key={s} className="rounded bg-surface-muted px-1.5 py-0.5 text-micro font-medium text-fg-secondary">{s}</span>)}</div></td>
                      <td className="px-2 py-2.5 font-mono text-small text-fg-muted">{g.phone}</td>
                      <td className="px-2 py-2.5">{g.faceEnrolled ? <span className="text-caption font-semibold text-success-ink">Yes</span> : <span className="text-caption text-fg-subtle">No</span>}</td>
                      <td className="px-2 py-2.5"><Chip status={g.status} label={g.status} /></td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {g.status !== 'verified' && <button onClick={() => setStatus(g.id, 'verified')} title="Verify" className="rounded-md p-1.5 text-fg-subtle transition hover:bg-success-soft hover:text-success-ink"><Check className="h-3.5 w-3.5" /></button>}
                          {g.status === 'blocked'
                            ? <button onClick={() => setStatus(g.id, 'verified')} title="Unblock" className="rounded-md p-1.5 text-fg-subtle transition hover:bg-success-soft hover:text-success-ink"><UserCheck className="h-3.5 w-3.5" /></button>
                            : <button onClick={() => setStatus(g.id, 'blocked')} title="Block" className="rounded-md p-1.5 text-fg-subtle transition hover:bg-danger-soft hover:text-danger"><Ban className="h-3.5 w-3.5" /></button>}
                          <button onClick={() => startEdit(g)} title="Edit" className="rounded-md p-1.5 text-fg-subtle transition hover:bg-surface-muted hover:text-fg-secondary"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => remove(g.id)} title="Remove" className="rounded-md p-1.5 text-fg-subtle transition hover:bg-danger-soft hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Temporary Pickup Passes */}
          <Panel
            icon={Ticket} title="Temporary Pickup Passes" count={passes.length}
            right={<button onClick={() => setShowIssue(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-caption font-semibold text-white shadow-sm transition hover:bg-brand-hover"><Plus className="h-3.5 w-3.5" /> Issue Pass</button>}
            bodyClass="p-4"
          >
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Person</th><th className="px-2 pb-2 font-semibold">Student(s)</th><th className="px-2 pb-2 font-semibold">Reason</th>
                  <th className="px-2 pb-2 font-semibold">Window</th><th className="px-2 pb-2 font-semibold">OTP</th><th className="px-2 pb-2 font-semibold">Status</th><th className="px-2 pb-2 text-right font-semibold">Actions</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {passes.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5"><p className="font-semibold text-fg">{p.person}</p><p className="text-micro text-fg-subtle">{p.phone}</p></td>
                      <td className="px-2 py-2.5"><div className="flex flex-wrap gap-1">{p.students.map((s) => <span key={s} className="rounded bg-surface-muted px-1.5 py-0.5 text-micro font-medium text-fg-secondary">{s}</span>)}</div></td>
                      <td className="px-2 py-2.5 text-fg-muted">{p.reason}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{p.window}</td>
                      <td className="px-2 py-2.5"><span className="inline-flex items-center gap-1 font-mono text-caption font-semibold text-fg-secondary"><KeyRound className="h-3 w-3 text-fg-subtle" />{p.otp}</span></td>
                      <td className="px-2 py-2.5"><Chip status={p.status} label={p.status} /></td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {p.status === 'active' && <>
                            <button onClick={() => resendOtp(p.id)} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-micro font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink"><RefreshCw className="h-3 w-3" /> Resend OTP</button>
                            <button onClick={() => revokePass(p.id)} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-micro font-semibold text-fg-secondary transition hover:border-danger-line hover:text-danger-ink"><Ban className="h-3 w-3" /> Revoke</button>
                          </>}
                          {p.status !== 'active' && <span className="text-micro text-fg-disabled">—</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Unknown / Unauthorized pickup log */}
          <Panel icon={HelpCircle} title="Unknown / Unauthorized Pickup Attempts" count={unknowns.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Snapshot</th><th className="px-2 pb-2 font-semibold">Student</th><th className="px-2 pb-2 font-semibold">Attempted by</th>
                  <th className="px-2 pb-2 font-semibold">Gate</th><th className="px-2 pb-2 text-right font-semibold">Time</th><th className="px-2 pb-2 font-semibold">Action taken</th><th className="px-2 pb-2 text-right font-semibold">Resolve</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {unknowns.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5"><span className="grid h-9 w-12 place-items-center rounded-md bg-surface-muted text-fg-subtle"><Camera className="h-4 w-4" /></span></td>
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{u.student}</td>
                      <td className="px-2 py-2.5"><span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${ATTEMPT_CHIP[u.attemptedBy] || ATTEMPT_CHIP.Unknown}`}>{u.attemptedBy}</span></td>
                      <td className="px-2 py-2.5 text-fg-muted">{u.gate}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{u.time}</td>
                      <td className={`px-2 py-2.5 font-medium ${u.action.startsWith('Escalated') ? 'text-danger-ink' : 'text-fg-secondary'}`}>{u.action}</td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => escalate(u.id)} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-micro font-semibold text-fg-secondary transition hover:border-danger-line hover:text-danger-ink"><ArrowUpRight className="h-3 w-3" /> Escalate</button>
                          <button onClick={() => addAsGuardian(u)} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-micro font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink"><Plus className="h-3 w-3" /> Add guardian</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Audit trail */}
          <Panel icon={History} title="Recent Activity (Audit Trail)" count={audit.length} bodyClass="p-3 max-h-72 overflow-y-auto">
            <ul className="space-y-1">
              {audit.map((a) => (
                <li key={a.id} className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-surface-sunken">
                  <span className="w-12 shrink-0 text-right font-mono text-micro text-fg-subtle">{a.ts}</span>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${
                    a.action === 'Escalated' || a.action === 'Blocked' || a.action === 'Revoked' ? 'bg-danger-soft text-danger-ink ring-danger-line'
                    : a.action === 'Issued' || a.action === 'Added' || a.action === 'Approved' || a.action === 'Matched' ? 'bg-success-soft text-success-ink ring-success-line'
                    : 'bg-warning-soft text-warning-ink ring-warning-line'}`}>{a.action}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-secondary">{a.detail}</span>
                  <span className="shrink-0 text-micro text-fg-subtle">{a.actor}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      {/* Issue Temporary Pass modal */}
      {showIssue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={() => setShowIssue(false)} />
          <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
            <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
              <Ticket className="h-4 w-4 text-brand" />
              <p className="text-body font-bold text-fg">Issue Temporary Pickup Pass</p>
              <button onClick={() => setShowIssue(false)} className="ml-auto rounded-md p-1 text-fg-subtle hover:bg-surface-muted hover:text-fg-secondary"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(var(--app-vh)*0.7)] overflow-y-auto p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>Authorized person</label><input value={passForm.person} onChange={(e) => setPassForm((f) => ({ ...f, person: e.target.value }))} placeholder="e.g. Sunita (aunt)" className={inputCls} /></div>
                <div><label className={labelCls}>Phone</label><input value={passForm.phone} onChange={(e) => setPassForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91 …" className={inputCls} /></div>
                <div className="sm:col-span-2">
                  <label className={labelCls}>Student(s)</label>
                  <div className="flex flex-wrap gap-1.5">
                    {STUDENT_NAMES.map((n) => { const on = passForm.students.includes(n); return (
                      <button key={n} type="button" onClick={() => togglePassStudent(n)} className={`rounded-full px-2.5 py-1 text-caption font-semibold ring-1 transition ${on ? 'bg-brand/10 text-brand-ink ring-brand/30' : 'bg-surface text-fg-muted ring-line hover:text-fg-secondary'}`}>{on && <Check className="mr-1 inline h-3 w-3" />}{n}</button>
                    ); })}
                  </div>
                </div>
                <div><label className={labelCls}>Reason</label><input value={passForm.reason} onChange={(e) => setPassForm((f) => ({ ...f, reason: e.target.value }))} placeholder="e.g. Parent travelling" className={inputCls} /></div>
                <div><label className={labelCls}>Validity window</label><input value={passForm.window} onChange={(e) => setPassForm((f) => ({ ...f, window: e.target.value }))} placeholder="e.g. Today 13:00–15:00" className={inputCls} /></div>
                <div className="sm:col-span-2 flex items-center gap-4">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-small font-medium text-fg-secondary">
                    <input type="checkbox" checked={passForm.oneTime} onChange={(e) => setPassForm((f) => ({ ...f, oneTime: e.target.checked }))} className="accent-brand" /> One-time pass
                  </label>
                  {/* QR + OTP are generated on save (mock). */}
                  <span className="ml-auto inline-flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-caption text-fg-subtle ring-1 ring-line"><QrCode className="h-8 w-8 text-fg-disabled" /> OTP + QR generated on issue</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-line-subtle px-4 py-3">
              <button onClick={issuePass} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover"><Ticket className="h-4 w-4" /> Issue Pass &amp; Notify Parent</button>
              <button onClick={() => setShowIssue(false)} className="rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary hover:text-fg">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
