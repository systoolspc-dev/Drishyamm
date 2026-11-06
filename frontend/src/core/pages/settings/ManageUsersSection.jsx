import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  UsersRound, UserPlus, Pencil, Trash2, KeyRound, X, ShieldCheck, Loader2, Plus, Check,
} from 'lucide-react';
import { manageUsersService, manageRolesService } from '@/core/services/manageUsers';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import { SectionHeading, CardHeading } from '@/core/ui/typography';
import { HeaderInfo } from '@/core/ui/header-info';
import { PageTabs } from '@/core/layout/OperationsPage';

// Role presentation. Must mirror the backend ROLE_CAPABILITIES tiers.
const ROLE_META = {
  admin:    { label: 'Admin',    desc: 'Full access + user management', cls: 'bg-danger-soft text-danger-ink border-danger-line' },
  manager:  { label: 'Manager',  desc: 'Cameras + AI, no user mgmt',     cls: 'bg-ai-soft text-ai-ink border-ai-line' },
  operator: { label: 'Operator', desc: 'Live, playback, ack alerts',     cls: 'bg-info-soft text-info-ink border-info-line' },
  viewer:   { label: 'Viewer',   desc: 'Read-only live + playback',      cls: 'bg-surface-muted text-fg-secondary border-line' },
};
const ROLE_ORDER = ['admin', 'manager', 'operator', 'viewer'];

function RoleBadge({ role }) {
  const m = ROLE_META[role] || ROLE_META.viewer;
  return <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-caption font-bold ${m.cls}`}>{m.label}</span>;
}

function scopeSummary(scope, opts) {
  const s = scope || {};
  const siteN = (s.siteIds || []).length;
  const grpN = (s.groupIds || []).length;
  if (!siteN && !grpN) return 'All cameras';
  const parts = [];
  if (siteN) parts.push(`${siteN} site${siteN > 1 ? 's' : ''}`);
  if (grpN) parts.push(`${grpN} group${grpN > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export default function ManageUsersSection() {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(null); // {mode:'create'|'edit'|'password'|'delete', user?}
  const [view, setView] = useState('users'); // 'users' | 'roles'
  const invalidate = () => qc.invalidateQueries({ queryKey: ['manage-users'] });

  const usersQ = useQuery({ queryKey: ['manage-users'], queryFn: manageUsersService.list });
  const optsQ = useQuery({ queryKey: ['manage-users-options'], queryFn: manageUsersService.options, staleTime: 60_000 });

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><UsersRound className="h-4 w-4" strokeWidth={2} /></div>
        <div className="flex min-w-0 items-center gap-1.5">
          <SectionHeading>Manage Users</SectionHeading>
          <HeaderInfo
            label="Manage Users"
            text="Create team members, set their role, and scope them to specific sites or camera groups."
          />
        </div>
        {view === 'users' && (
          <Button className="ml-auto" onClick={() => setDialog({ mode: 'create' })}>
            <UserPlus /> Add user
          </Button>
        )}
      </div>

      {/* Users / Custom roles switch */}
      <PageTabs
        tabs={[{ id: 'users', label: 'Users' }, { id: 'roles', label: 'Custom roles' }]}
        active={view}
        onChange={setView}
      />

      {view === 'roles' && <RolesPanel />}

      {view === 'users' && (
      <div className="w-full overflow-hidden rounded-xl border border-line bg-surface shadow-sm dark:bg-surface-sunken!">
        {/* The scroll is the TABLE's, not the page's: this port is the width of
            the card, so the five columns scroll inside the card instead of
            widening it and having the card clip them. */}
        <div className="w-full overflow-x-auto">
          <table className="w-full text-left text-body">
            <thead className="bg-surface-sunken text-small font-semibold text-fg-muted dark:bg-surface-app/60">
              <tr>
                <th className="px-4 py-2.5">User</th><th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Scope</th><th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {usersQ.isLoading ? (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-fg-subtle"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
              ) : (usersQ.data || []).map((u) => (
                <tr key={u.id} className="hover:bg-surface-sunken/60">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-fg">{u.name}{u.isAccountOwner && <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-micro font-bold uppercase text-fg-muted">owner</span>}</div>
                    <div className="text-caption text-fg-muted">{u.username || u.email || '—'}</div>
                  </td>
                  <td className="px-4 py-3">
                    {u.customRoleName
                      ? <span className="inline-flex items-center gap-1 rounded-md border border-warning-line bg-warning-soft px-2 py-0.5 text-caption font-bold text-warning-ink"><ShieldCheck className="h-3 w-3" />{u.customRoleName}</span>
                      : <RoleBadge role={u.role} />}
                  </td>
                  <td className="px-4 py-3 text-small text-fg-secondary">{scopeSummary(u.scope)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 text-caption font-semibold ${u.isActive ? 'text-success-ink' : 'text-fg-subtle'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${u.isActive ? 'bg-success' : 'bg-line-strong'}`} />{u.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconBtn title="Edit" onClick={() => setDialog({ mode: 'edit', user: u })}><Pencil className="h-3.5 w-3.5" /></IconBtn>
                      <IconBtn title="Reset password" onClick={() => setDialog({ mode: 'password', user: u })}><KeyRound className="h-3.5 w-3.5" /></IconBtn>
                      {!u.isAccountOwner && <IconBtn title="Delete" danger onClick={() => setDialog({ mode: 'delete', user: u })}><Trash2 className="h-3.5 w-3.5" /></IconBtn>}
                    </div>
                  </td>
                </tr>
              ))}
              {!usersQ.isLoading && !(usersQ.data || []).length && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-body text-fg-subtle">No users yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {(dialog?.mode === 'create' || dialog?.mode === 'edit') && (
        <UserFormDialog mode={dialog.mode} user={dialog.user} options={optsQ.data}
          onClose={() => setDialog(null)} onSaved={() => { invalidate(); setDialog(null); }} />
      )}
      {dialog?.mode === 'password' && (
        <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />
      )}
      {dialog?.mode === 'delete' && (
        <DeleteDialog user={dialog.user} onClose={() => setDialog(null)} onDone={() => { invalidate(); setDialog(null); }} />
      )}
    </section>
  );
}

function IconBtn({ children, title, onClick, danger }) {
  return (
    <button title={title} onClick={onClick}
      className={`grid h-7 w-7 place-items-center rounded-md border border-line text-fg-muted transition hover:bg-surface-sunken ${danger ? 'hover:border-danger-line hover:text-danger-ink' : 'hover:text-fg'}`}>
      {children}
    </button>
  );
}

/**
 * The modal frame behind all four user/role dialogs.
 *
 * PORTALLED TO <body>, which is the part that is load-bearing rather than
 * cosmetic. It used to render where it sits in the tree — inside Settings'
 * section pane, which is inside the `settings-shell` scroll port, which is
 * inside the Operations frame's `overflow-hidden`. `position: fixed` escapes
 * an ancestor's overflow, so that happened to work; what it does NOT escape is
 * an ancestor that establishes a containing block for fixed descendants, and
 * `transform`, `filter`, `backdrop-filter`, `will-change`, `contain` and
 * `perspective` all do. `backdrop-blur` is already in use a few hundred lines
 * away in this same console (the license hero), so the modal was one such
 * class on any ancestor away from being laid out inside a 660px pane and
 * clipped by it — with no error and nothing in the markup to explain it.
 * At <body> there are no ancestors left to be clipped by.
 *
 * HEIGHT. The panel is capped at 90% of the viewport and the BODY scrolls
 * inside it, so the title bar and the Cancel/Save row are always on screen.
 * Only the body had a cap before (70vh) with the header and footer outside it,
 * so the real height was 70vh + ~100px of chrome + 32px of overlay padding —
 * over the viewport on a phone in landscape, where the footer ended up below
 * the fold of a container that does not scroll. The buttons were unreachable.
 *
 * `calc(var(--app-vh) * 0.9)` is this file's 90vh. Raw `vh` is wrong here:
 * `html` carries `zoom: 0.9` from `lg` up (see index.css), and CSS zoom
 * shrinks viewport units along with everything else, so `90vh` would resolve
 * to 81% of the screen on desktop. `--app-vh` divides the zoom back out.
 *
 * Z-INDEX. z-1000, up from z-50. AIToastHost is mounted globally in App.jsx,
 * outside the routes, and sits at z-60 precisely so it clears the z-50 layers;
 * a high-severity AI event therefore painted its toast over whatever dialog
 * was open, and being earlier in the DOM it would have lost a tie anyway, so
 * z-60 was not an accident to match.
 *
 * Safe to raise this far only because nothing inside these dialogs is a Radix
 * popper. Select, Dropdown, Popover and Tooltip all portal to <body> at z-50
 * and rely on mounting LATER than the dialog to paint above it; a Select added
 * inside one of these dialogs would now open underneath. Keep that true, or
 * raise the popper's z-index along with it.
 */
function Shell({ title, icon: Icon, onClose, children, footer }) {
  return createPortal(
    // The overlay is itself a scroll port. Belt and braces: the panel is
    // capped so it should always fit, but a zoom level or a font scale that
    // pushes the chrome past the cap scrolls here instead of going off-screen.
    // `my-auto` on the panel rather than `place-items-center` on the port —
    // a centred flex item taller than its scroll container has its overflow
    // cut off at the TOP, unreachable, and auto margins centre without that.
    <div
      className="fixed inset-0 z-1000 flex items-center justify-center overflow-y-auto overscroll-contain bg-black/50 p-3 sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="my-auto flex max-h-[calc(var(--app-vh)*0.9)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-line bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-line-subtle px-4 py-3.5 sm:px-5">
          <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          <CardHeading className="min-w-0 flex-1 truncate">{title}</CardHeading>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-fg-subtle hover:text-fg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* `min-h-0` is what makes the cap bite: without it this flex item's
            automatic minimum is its content height, so the panel would grow
            past 90vh instead of the body scrolling. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {/* Wraps: two buttons plus a spinner label at 320px were overflowing
            the row rather than stacking. */}
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line-subtle px-4 py-3 sm:px-5">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const labelCls = 'mb-1 block text-small font-medium text-fg-secondary';

function UserFormDialog({ mode, user, options, onClose, onSaved }) {
  const editing = mode === 'edit';
  const [form, setForm] = useState({
    name: user?.name || '', username: user?.username || '', email: user?.email || '',
    password: '', role: user?.role || 'viewer', customRoleId: user?.customRoleId || null,
    siteIds: user?.scope?.siteIds || [], groupIds: user?.scope?.groupIds || [],
  });
  const [err, setErr] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k, id) => setForm((f) => ({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] }));

  const mut = useMutation({
    mutationFn: () => {
      const scope = { siteIds: form.siteIds, groupIds: form.groupIds };
      const roleFields = form.customRoleId ? { customRoleId: form.customRoleId } : { role: form.role };
      if (editing) return manageUsersService.update(user.id, { name: form.name, scope, ...roleFields });
      return manageUsersService.create({ name: form.name, username: form.username || null, email: form.email || null, password: form.password, scope, ...roleFields });
    },
    onSuccess: onSaved,
    onError: (e) => setErr(e?.response?.data?.message || e.message || 'Failed to save'),
  });

  const sites = options?.sites || [];
  const groups = options?.groups || [];
  const scopeEmpty = !form.siteIds.length && !form.groupIds.length;

  return (
    <Shell title={editing ? `Edit ${user.name}` : 'Add user'} icon={editing ? Pencil : UserPlus} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={mut.isPending} onClick={() => { setErr(''); mut.mutate(); }}>
          {mut.isPending && <Loader2 className="animate-spin" />}{editing ? 'Save changes' : 'Create user'}
        </Button>
      </>}>
      {err && <div className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">{err}</div>}
      <div className="space-y-3.5">
        <div><label className={labelCls}>Full name</label><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ravi Kumar" /></div>
        {!editing && (
          <div className="settings-fields gap-3">
            <div><label className={labelCls}>Username</label><Input value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="ravi" /></div>
            <div><label className={labelCls}>Email (optional)</label><Input value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="ravi@co.com" /></div>
          </div>
        )}
        {!editing && <div><label className={labelCls}>Password</label><Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="Min 8 characters" /></div>}

        <div>
          <label className={labelCls}>Role</label>
          <div className="settings-fields gap-2">
            {ROLE_ORDER.map((r) => {
              const on = form.role === r && !form.customRoleId;
              return (
                <button key={r} type="button" onClick={() => setForm((f) => ({ ...f, role: r, customRoleId: null }))}
                  className={`rounded-lg border px-3 py-2 text-left transition ${on ? 'border-brand bg-brand-soft/60' : 'border-line hover:bg-surface-sunken'}`}>
                  <div className="text-small font-bold text-fg">{ROLE_META[r].label}</div>
                  <div className="text-micro text-fg-muted">{ROLE_META[r].desc}</div>
                </button>
              );
            })}
          </div>
          {!!(options?.customRoles || []).length && (
            <>
              <p className="mb-1 mt-2.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Custom roles</p>
              <div className="settings-fields gap-2">
                {options.customRoles.map((cr) => {
                  const on = form.customRoleId === cr.id;
                  const n = (cr.capabilities || []).length;
                  return (
                    <button key={cr.id} type="button" onClick={() => setForm((f) => ({ ...f, customRoleId: cr.id }))}
                      className={`rounded-lg border px-3 py-2 text-left transition ${on ? 'border-brand bg-brand-soft/60' : 'border-line hover:bg-surface-sunken'}`}>
                      <div className="flex items-center gap-1 text-small font-bold text-fg"><ShieldCheck className="h-3 w-3 text-warning-ink" />{cr.name}</div>
                      <div className="text-micro text-fg-muted">{n} feature{n !== 1 ? 's' : ''}</div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div>
          <label className={labelCls}>Scope — which cameras this user can access</label>
          <p className="mb-2 text-caption text-fg-subtle">Leave everything unticked for <b>full account access</b>. Otherwise they see only the chosen sites/groups.</p>
          {scopeEmpty && <div className="mb-2 rounded-md bg-success-soft px-2.5 py-1.5 text-caption font-medium text-success-ink">Currently: all cameras</div>}
          {!!sites.length && <ScopeGroup title="Sites" items={sites} selected={form.siteIds} onToggle={(id) => toggle('siteIds', id)} />}
          {!!groups.length && <ScopeGroup title="Camera groups" items={groups} selected={form.groupIds} onToggle={(id) => toggle('groupIds', id)} />}
          {!sites.length && !groups.length && <p className="text-caption text-fg-subtle">No sites or groups yet — the user will have full access.</p>}
        </div>
      </div>
    </Shell>
  );
}

function ScopeGroup({ title, items, selected, onToggle }) {
  return (
    <div className="mb-2">
      <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-fg-subtle">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => {
          const on = selected.includes(it.id);
          return (
            <button key={it.id} type="button" onClick={() => onToggle(it.id)}
              className={`rounded-full border px-2.5 py-1 text-caption font-medium transition ${on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-fg-secondary hover:bg-surface-sunken'}`}>
              {it.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PasswordDialog({ user, onClose, onSaved }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const mut = useMutation({
    mutationFn: () => manageUsersService.resetPassword(user.id, pw),
    onSuccess: onSaved,
    onError: (e) => setErr(e?.response?.data?.message || e.message),
  });
  return (
    <Shell title={`Reset password — ${user.name}`} icon={KeyRound} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={mut.isPending} onClick={() => { setErr(''); mut.mutate(); }}>Set password</Button>
      </>}>
      {err && <div className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">{err}</div>}
      <label className={labelCls}>New password</label>
      <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Min 8 characters" autoFocus />
    </Shell>
  );
}

function DeleteDialog({ user, onClose, onDone }) {
  const mut = useMutation({ mutationFn: () => manageUsersService.remove(user.id), onSuccess: onDone });
  return (
    <Shell title="Delete user" icon={Trash2} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={mut.isPending} onClick={() => mut.mutate()}>Delete</Button>
      </>}>
      <p className="text-body text-fg-secondary">Delete <b className="text-fg">{user.name}</b> ({user.username || user.email})? They will lose access immediately. This can be undone by support (soft delete).</p>
    </Shell>
  );
}

/* ─────────────────────────── Custom roles ─────────────────────────── */

function RolesPanel() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(null); // {} for new, {role} for edit
  const rolesQ = useQuery({ queryKey: ['manage-roles'], queryFn: manageRolesService.list });
  const capsQ = useQuery({ queryKey: ['manage-role-caps'], queryFn: manageRolesService.capabilities, staleTime: 300_000 });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['manage-roles'] }); qc.invalidateQueries({ queryKey: ['manage-users-options'] }); };
  const labelFor = (key) => (capsQ.data || []).find((c) => c.key === key)?.label || key;
  const del = useMutation({ mutationFn: (id) => manageRolesService.remove(id), onSuccess: invalidate });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-small text-fg-muted">Define your own roles and assign exactly the features each should have.</p>
        <Button variant="outline" className="ml-auto" onClick={() => setEditing({})}>
          <Plus /> New role
        </Button>
      </div>

      {rolesQ.isLoading ? <div className="py-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-fg-subtle" /></div>
        : !(rolesQ.data || []).length ? (
          <div className="rounded-xl border border-dashed border-line py-10 text-center text-body text-fg-subtle">No custom roles yet. Click <b>New role</b> to create one.</div>
        ) : (
          <div className="settings-fields gap-2.5">
            {rolesQ.data.map((r) => (
              <div key={r.id} className="rounded-xl border border-line bg-surface p-3.5 shadow-sm dark:bg-surface-sunken!">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-warning-ink" />
                  <span className="text-body font-bold text-fg">{r.name}</span>
                  <div className="ml-auto flex gap-1">
                    <IconBtn title="Edit" onClick={() => setEditing({ role: r })}><Pencil className="h-3.5 w-3.5" /></IconBtn>
                    <IconBtn title="Delete" danger onClick={() => del.mutate(r.id)}><Trash2 className="h-3.5 w-3.5" /></IconBtn>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(r.capabilities || []).map((c) => (
                    <span key={c} className="rounded-md bg-surface-muted px-1.5 py-0.5 text-micro font-medium text-fg-secondary">{labelFor(c)}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

      {editing && <RoleFormDialog role={editing.role} caps={capsQ.data || []} onClose={() => setEditing(null)} onSaved={() => { invalidate(); setEditing(null); }} />}
    </div>
  );
}

function RoleFormDialog({ role, caps, onClose, onSaved }) {
  const editing = !!role;
  const [name, setName] = useState(role?.name || '');
  const [selected, setSelected] = useState(role?.capabilities || []);
  const [err, setErr] = useState('');
  const toggle = (key) => setSelected((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key]));
  const mut = useMutation({
    mutationFn: () => (editing
      ? manageRolesService.update(role.id, { name, capabilities: selected })
      : manageRolesService.create({ name, capabilities: selected })),
    onSuccess: onSaved,
    onError: (e) => setErr(e?.response?.data?.message || e.message),
  });
  return (
    <Shell title={editing ? `Edit role — ${role.name}` : 'New custom role'} icon={ShieldCheck} onClose={onClose}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={mut.isPending} onClick={() => { setErr(''); mut.mutate(); }}>
          {mut.isPending && <Loader2 className="animate-spin" />}{editing ? 'Save role' : 'Create role'}
        </Button>
      </>}>
      {err && <div className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">{err}</div>}
      <div className="mb-4"><label className={labelCls}>Role name</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shift Supervisor" autoFocus /></div>
      <label className={labelCls}>Features this role can use</label>
      <div className="space-y-1.5">
        {caps.map((c) => {
          const on = selected.includes(c.key);
          return (
            <button key={c.key} type="button" onClick={() => toggle(c.key)}
              className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${on ? 'border-brand-line bg-brand-soft/50' : 'border-line hover:bg-surface-sunken'}`}>
              <span className={`grid h-4.5 w-4.5 place-items-center rounded border ${on ? 'border-brand bg-brand text-white' : 'border-line-strong'}`}>{on && <Check className="h-3 w-3" />}</span>
              <span className="text-small font-medium text-fg">{c.label}</span>
            </button>
          );
        })}
      </div>
    </Shell>
  );
}
