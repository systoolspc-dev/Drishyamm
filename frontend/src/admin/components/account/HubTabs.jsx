import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../../services/api.js'
import { formatDate, formatDateTime, formatCurrency } from '../../data/index.js'
import { EmptyState, Spinner, Modal } from '../ui.jsx'
import { UsageMeter, KpiTile, StatusDot } from './parts.jsx'
import { ActivityRow, CategoryChips } from '../activity/parts.jsx'
import { useActivityEvents } from '../activity/activityStore.js'
import { CATEGORIES } from '../activity/format.js'
import {
  usageTone, timeAgo, BUCKET_LABEL, BUCKET_TONE, ENGINE_DETAIL, ACTION_LABELS, describeChange, expiryTone, daysUntil,
} from './format.js'

/**
 * The account hub's tabs. Each takes the hub payload (GET /admin/accounts/:id/hub)
 * and renders one job. Paged tabs (Alerts & events, Audit) fetch their own pages.
 * Nothing here starts video: the Cameras tab offers one still per click.
 */

const bucketTone = (b) => (b === 'online' ? 'success' : BUCKET_TONE[b] || 'neutral')

function Panel({ icon, title, action, children, flush = true }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title"><span className="material-symbols-outlined">{icon}</span>{title}</div>
        {action}
      </div>
      <div className={flush ? 'panel-body-flush' : 'panel-body'}>{children}</div>
    </section>
  )
}

function Pager({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <div className="pager">
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {total ? `${(page - 1) * limit + 1}–${Math.min(total, page * limit)} of ${total.toLocaleString('en-IN')}` : '0'}
      </span>
      <button className="btn btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <span className="material-symbols-outlined icon-sm">chevron_left</span>
      </button>
      <button className="btn btn-ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        <span className="material-symbols-outlined icon-sm">chevron_right</span>
      </button>
    </div>
  )
}

/* ═══════════════════ Overview ═══════════════════ */

export function OverviewTab({ hub, onTab }) {
  const h = hub.health.summary
  const attention = hub.health.cameras.filter((c) => c.bucket !== 'online')
  const camTone = usageTone(hub.cameras.used, hub.cameras.limit)
  const rec = hub.billing.records[0] || null
  const recDays = daysUntil(rec?.endDate)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="hub-tiles" style={{ marginBottom: 0 }}>
        <KpiTile
          label="Cameras online"
          value={`${h.online} / ${h.total}`}
          sub={h.offline ? `${h.offline} offline` : h.unstable ? `${h.unstable} unstable` : `${h.streaming} streaming now`}
          subTone={h.offline ? 'danger' : h.unstable ? 'warning' : null}
          onClick={() => onTab('cameras')}
        />
        <KpiTile
          label="Camera licence"
          value={hub.cameras.limit === null ? `${hub.cameras.used}` : `${hub.cameras.used} / ${hub.cameras.limit}`}
          sub={hub.cameras.limit === null ? 'no limit' : `${Math.max(0, hub.cameras.limit - hub.cameras.used)} left`}
          tone={camTone}
          onClick={() => onTab('licences')}
        />
        <KpiTile
          label={`Open alerts · ${hub.alerts.openDays} d`}
          value={hub.alerts.open.toLocaleString('en-IN')}
          sub="unacknowledged warning + critical"
          tone={hub.alerts.open ? 'warning' : null}
          onClick={() => onTab('events')}
        />
        <KpiTile
          label="Plan"
          value={hub.plan ? hub.plan.name : 'None'}
          sub={hub.plan
            ? (new Date(hub.plan.validUntil).getFullYear() > 2100 ? `${hub.plan.status} · open-ended` : `${hub.plan.status} · until ${formatDate(hub.plan.validUntil)}`)
            : 'assign one on Licences'}
          onClick={() => onTab('licences')}
        />
      </div>

      {hub.billing.mismatches.length > 0 && (
        <div className="notice notice-warning" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 220 }}>
            The licence record disagrees with the enforced limits on {hub.billing.mismatches.length} item{hub.billing.mismatches.length === 1 ? '' : 's'}.
          </span>
          <button className="btn btn-ghost" onClick={() => onTab('billing')}>Review in Billing</button>
        </div>
      )}

      <div className="hub-grid">
        <Panel icon="workspace_premium" title="Usage vs licence" action={<button className="panel-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => onTab('licences')}>Change limits</button>}>
          <div className="hub-list-row">
            <span style={{ fontWeight: 600 }}>Cameras</span>
            <UsageMeter used={hub.cameras.used} limit={hub.cameras.limit} />
          </div>
          {hub.aiServices.map((s) => (
            <div className="hub-list-row" key={s.key}>
              <span style={{ fontWeight: 600, color: s.on ? undefined : 'var(--color-text-muted)' }}>{s.label}</span>
              {!s.on ? <span className="tone-muted" style={{ fontSize: 12.5 }}>Off</span>
                : s.perCamera ? <UsageMeter used={s.used} limit={s.limit} />
                  : <span style={{ fontSize: 12.5 }}>On · no per-camera limit</span>}
            </div>
          ))}
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Panel icon="videocam" title="Cameras needing attention" action={<button className="panel-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => onTab('cameras')}>All cameras</button>}>
            {h.total === 0 ? <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-muted)' }}>No cameras added yet.</p>
              : attention.length === 0 ? <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-secondary)' }}>All {h.total} cameras are reachable.</p>
                : attention.slice(0, 6).map((c) => (
                  <div className="hub-list-row" key={c.id}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }} className="truncate">{c.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{c.groupName || 'No NVR'} · last seen {timeAgo(c.lastUpdate)}</div>
                    </div>
                    <StatusDot tone={bucketTone(c.bucket)}>{BUCKET_LABEL[c.bucket]}</StatusDot>
                  </div>
                ))}
            {attention.length > 6 && <p style={{ padding: '8px 18px', fontSize: 12, color: 'var(--color-text-muted)' }}>+{attention.length - 6} more on the Cameras tab</p>}
          </Panel>

          <Panel icon="receipt_long" title="Recent admin changes" action={<button className="panel-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => onTab('audit')}>Full audit</button>}>
            {hub.recentChanges.length === 0 ? <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-muted)' }}>No changes recorded yet.</p>
              : hub.recentChanges.map((c) => (
                <div className="hub-list-row" key={c.id} style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{ACTION_LABELS[c.action] || c.action}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{describeChange(c)}</div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {timeAgo(c.ts)}<br />{c.by || ''}
                  </div>
                </div>
              ))}
          </Panel>

          {rec && (
            <Panel icon="description" title="Licence record">
              <div className="hub-list-row">
                <span>{rec.status} · {rec.term}</span>
                <span style={{ color: expiryTone(recDays) === 'danger' ? 'var(--color-danger-text)' : expiryTone(recDays) === 'warning' ? 'var(--color-warning-text)' : undefined, fontWeight: 600 }}>
                  {rec.endDate ? `ends ${formatDate(rec.endDate)}` : 'no end date'}
                </span>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════ Cameras & NVRs ═══════════════════ */

export function CamerasTab({ hub, accountId }) {
  const [bucket, setBucket] = useState('all')
  const [shot, setShot] = useState(null) // { camera, url, at, error, loading }
  const cams = hub.health.cameras
  const counts = cams.reduce((a, c) => ({ ...a, [c.bucket]: (a[c.bucket] || 0) + 1 }), {})
  const shown = bucket === 'all' ? cams : cams.filter((c) => c.bucket === bucket)

  // NVR roll-up: down = every camera on it offline
  const nvrs = Object.values(cams.reduce((acc, c) => {
    const k = c.groupName || 'No NVR'
    acc[k] = acc[k] || { name: k, site: c.siteName, total: 0, offline: 0, online: 0 }
    acc[k].total += 1
    if (c.bucket === 'offline') acc[k].offline += 1
    if (c.bucket === 'online') acc[k].online += 1
    return acc
  }, {}))

  const loadShot = async (c) => {
    setShot({ camera: c, loading: true })
    try {
      const r = await adminApi.getCameraSnapshot(accountId, c.id)
      setShot({ camera: c, url: r.url, at: r.at })
    } catch (e) {
      setShot({ camera: c, error: e.message })
    }
  }
  const closeShot = () => { if (shot?.url) URL.revokeObjectURL(shot.url); setShot(null) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {hub.health.source !== 'live' && (
        <div className="notice notice-warning">The stream service did not answer; states below may be out of date.</div>
      )}
      <Panel icon="dns" title={`NVRs (${nvrs.length})`}>
        {nvrs.length === 0 ? <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-muted)' }}>No NVRs.</p> : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>NVR / group</th><th>Site</th><th>Cameras online</th><th>State</th></tr></thead>
              <tbody>
                {nvrs.map((n) => (
                  <tr key={n.name} style={{ cursor: 'default' }}>
                    <td style={{ fontWeight: 600 }}>{n.name}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{n.site || '—'}</td>
                    <td className="mono">{n.online} / {n.total}</td>
                    <td>{n.offline === n.total
                      ? <StatusDot tone="danger">Down</StatusDot>
                      : n.offline ? <StatusDot tone="warning">{n.offline} offline</StatusDot>
                        : <StatusDot tone="success">Up</StatusDot>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        icon="videocam"
        title={`Cameras (${cams.length})`}
        action={(
          <div className="filter-group" role="group" aria-label="Health filter">
            {['all', 'online', 'offline', 'unstable', 'setup'].filter((b) => b === 'all' || counts[b]).map((b) => (
              <button key={b} className={`filter-pill ${bucket === b ? 'active' : ''}`} onClick={() => setBucket(b)}>
                {b === 'all' ? 'All' : BUCKET_LABEL[b]} {b === 'all' ? cams.length : counts[b]}
              </button>
            ))}
          </div>
        )}
      >
        {shown.length === 0 ? <EmptyState icon="videocam_off" title="No cameras" message={cams.length ? 'Nothing in this state.' : 'This account has not added cameras yet.'} /> : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Camera</th><th>NVR</th><th>Health</th><th className="hide-mobile">Stream</th><th className="hide-mobile">Last update</th><th /></tr></thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} style={{ cursor: 'default' }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      {c.channel != null && <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>Channel {c.channel}</div>}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{c.groupName || '—'}</td>
                    <td>
                      <StatusDot tone={bucketTone(c.bucket)}>{BUCKET_LABEL[c.bucket]}</StatusDot>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 2 }}>
                        {ENGINE_DETAIL[c.status] || c.status}{c.flapCount ? ` · ${c.flapCount} drop${c.flapCount === 1 ? '' : 's'} in 24 h` : ''}
                      </div>
                    </td>
                    <td className="hide-mobile mono" style={{ fontSize: 12 }}>{c.codec ? `${c.codec}${c.resolution ? ` · ${c.resolution}` : ''}` : '—'}</td>
                    <td className="hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(c.lastUpdate)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost" disabled={c.bucket === 'offline'} title={c.bucket === 'offline' ? 'Camera is offline' : 'Load one still image'} onClick={() => loadShot(c)}>
                        <span className="material-symbols-outlined icon-sm">photo_camera</span>
                        <span className="hide-mobile">Still</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
        Online includes idle cameras that connect when someone opens them. A still is taken only when you click, one per recorder at a time.
      </p>

      <Modal open={!!shot} onClose={closeShot} title={shot?.camera?.name} subtitle={shot?.at ? `Still taken ${formatDateTime(shot.at)}` : 'One still image'} width={720}>
        {shot?.loading && <Spinner />}
        {shot?.error && <div className="notice notice-danger">{shot.error}</div>}
        {shot?.url && <img src={shot.url} alt={`Still from ${shot.camera.name}`} style={{ width: '100%', borderRadius: 'var(--radius-md)', background: '#000' }} />}
      </Modal>
    </div>
  )
}

/* ═══════════════════ AI services ═══════════════════ */

export function AiServicesTab({ hub }) {
  return (
    <Panel icon="neurology" title="AI services">
      {!hub.plan?.aiEnabled && (
        <p style={{ padding: '12px 18px 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>This plan has no AI. Every service below is off until the plan changes.</p>
      )}
      <div className="table-wrapper">
        <table className="data-table">
          <thead><tr><th>Service</th><th>State</th><th>Cameras on / licensed</th><th>Last event</th><th className="hide-mobile">Events stored</th></tr></thead>
          <tbody>
            {hub.aiServices.map((s) => (
              <tr key={s.key} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 600 }}>{s.label}</td>
                <td>{s.on ? <StatusDot tone="success">On</StatusDot> : <StatusDot>Off</StatusDot>}</td>
                <td>{s.perCamera ? <UsageMeter used={s.used} limit={s.limit} /> : <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>On/off only</span>}</td>
                <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{s.lastEventAt ? timeAgo(s.lastEventAt) : <span className="tone-muted">Never</span>}</td>
                <td className="hide-mobile mono" style={{ fontSize: 12.5 }}>{s.events.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ padding: '10px 18px 14px', fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
        “No limit” = bounded only by the camera licence. Weapon, fire, aggression and ANPR have no per-camera switch yet.
      </p>
    </Panel>
  )
}

/* ═══════════════════ Users ═══════════════════ */

export function UsersTab({ hub, accountId }) {
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const send = async (u) => {
    setBusy(u.id)
    setMsg(null)
    try {
      const r = await adminApi.sendPasswordReset(accountId, u.id)
      setMsg({ tone: 'ok', text: r.message })
    } catch (e) {
      setMsg({ tone: 'danger', text: e.message })
    }
    setBusy(null)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {msg && <div className={`notice ${msg.tone === 'danger' ? 'notice-danger' : ''}`} role="status">{msg.text}</div>}
      <Panel icon="group" title={`Users (${hub.users.length})`}>
        <div className="table-wrapper">
          <table className="data-table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th className="hide-mobile">Last active</th><th /></tr></thead>
            <tbody>
              {hub.users.map((u) => (
                <tr key={u.id} style={{ cursor: 'default' }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{u.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{u.email || (u.username ? `username: ${u.username}` : '—')}</div>
                  </td>
                  <td style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{u.role}</td>
                  <td>{u.status === 'active' && hub.account.status === 'active'
                    ? <StatusDot tone="success">Active</StatusDot>
                    : <StatusDot tone="danger">{u.status === 'active' ? 'Account suspended' : 'Suspended'}</StatusDot>}</td>
                  <td className="hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{timeAgo(u.lastActiveAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {u.email && (
                      <button className="btn btn-ghost" disabled={busy === u.id || hub.account.status !== 'active'} onClick={() => send(u)}>
                        {busy === u.id ? 'Sending…' : 'Send reset link'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ padding: '10px 18px 14px', fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
          The reset link is emailed and valid for 1 hour. Users without an email are reset from the customer’s own Users page.
        </p>
      </Panel>
    </div>
  )
}

/* ═══════════════════ Billing ═══════════════════ */

export function BillingTab({ hub }) {
  const { records, mismatches } = hub.billing
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="notice">
        The limits on the <strong>Licences &amp; features</strong> tab are what the platform enforces. The licence record below is the commercial record from Quotes; it is not enforced.
      </div>
      {mismatches.length > 0 && (
        <div className="notice notice-warning">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>The latest licence record disagrees with the enforced limits</div>
          <div className="table-wrapper">
            <table className="data-table" style={{ background: 'transparent' }}>
              <thead><tr><th>Item</th><th>Licence record</th><th>Enforced now</th></tr></thead>
              <tbody>
                {mismatches.map((m) => (
                  <tr key={m.key} style={{ cursor: 'default' }}>
                    <td style={{ fontWeight: 600 }}>{m.label}</td>
                    <td className="mono">{m.record}</td>
                    <td className="mono">{m.enforced}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6 }}>Fix whichever is wrong: change the limits on Licences &amp; features, or issue a new licence record.</div>
        </div>
      )}
      <Panel icon="description" title={`Licence records (${records.length})`} action={<Link className="panel-link" to="/admin/calculator">New quote</Link>}>
        {records.length === 0 ? <EmptyState icon="description" title="No licence record" message="Create one from Quotes when this account is sold a licence." /> : (
          <div className="table-wrapper">
            <table className="data-table">
              <thead><tr><th>Status</th><th>Term</th><th>Period</th><th>Cameras</th><th className="hide-mobile">MRR</th><th /></tr></thead>
              <tbody>
                {records.map((r) => {
                  const days = daysUntil(r.endDate)
                  const tone = ['active', 'trial'].includes(r.status) ? expiryTone(days) : null
                  return (
                    <tr key={r.id} style={{ cursor: 'default' }}>
                      <td><StatusDot tone={r.status === 'active' ? 'success' : ['expired', 'terminated', 'suspended'].includes(r.status) ? 'danger' : 'neutral'}>{r.status}</StatusDot></td>
                      <td style={{ fontSize: 12.5 }}>{r.term}</td>
                      <td style={{ fontSize: 12.5, whiteSpace: 'nowrap', color: tone === 'danger' ? 'var(--color-danger-text)' : tone === 'warning' ? 'var(--color-warning-text)' : undefined }}>
                        {formatDate(r.startDate)} – {formatDate(r.endDate)}
                      </td>
                      <td className="mono">{r.cameraQuota || '—'}</td>
                      <td className="hide-mobile mono">{r.currency === 'INR' ? formatCurrency(Math.round(r.mrr)) : `${r.currency} ${r.mrr}`}</td>
                      <td style={{ textAlign: 'right' }}><Link className="panel-link" to={`/admin/licenses/${r.id}`}>Open</Link></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

/* ═══════════════════ Alerts & events (server-paged) ═══════════════════ */

const SEV_TONE = { critical: 'danger', warning: 'warning', info: 'neutral' }

export function EventsTab({ accountId }) {
  const [page, setPage] = useState(1)
  const [severity, setSeverity] = useState('')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const limit = 25

  useEffect(() => {
    let live = true
    adminApi.getAccountEvents(accountId, { page, limit, severity, open })
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [accountId, page, severity, open])

  const pick = (fn) => { setPage(1); fn() }

  return (
    <Panel
      icon="crisis_alert"
      title="Alerts & events"
      action={(
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div className="filter-group" role="group" aria-label="Severity">
            {[['', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']].map(([v, l]) => (
              <button key={l} className={`filter-pill ${severity === v ? 'active' : ''}`} onClick={() => pick(() => setSeverity(v))}>{l}</button>
            ))}
          </div>
          <button className={`filter-pill ${open ? 'active' : ''}`} aria-pressed={open} onClick={() => pick(() => setOpen((v) => !v))}>Unacknowledged</button>
        </div>
      )}
    >
      {error ? <div className="notice notice-danger" style={{ margin: 14 }}>{error}</div>
        : !data ? <Spinner />
          : data.events.length === 0 ? <EmptyState icon="notifications_off" title="No events" message="Nothing matches this filter." /> : (
            <>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead><tr><th>When</th><th>Event</th><th>Severity</th><th>Camera</th><th className="hide-mobile">State</th></tr></thead>
                  <tbody>
                    {data.events.map((e) => (
                      <tr key={e.id} style={{ cursor: 'default' }}>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{formatDateTime(e.ts)}</td>
                        <td>
                          <div className="mono" style={{ fontSize: 12.5 }}>{e.type}</div>
                          {e.label && <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{e.label}</div>}
                        </td>
                        <td><StatusDot tone={SEV_TONE[e.severity]}>{e.severity}</StatusDot></td>
                        <td style={{ fontSize: 12.5 }}>{e.camera}</td>
                        <td className="hide-mobile" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{e.acked ? 'Acknowledged' : 'Open'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={data.page} limit={data.limit} total={data.total} onPage={setPage} />
            </>
          )}
    </Panel>
  )
}

/* ═══════════════════ Audit ═══════════════════ */

/** Shared by the hub's Audit tab and the Audit log page. */
export function AuditTable({ rows, showAccount = false }) {
  return (
    <div className="table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Change</th>
            {showAccount && <th>Account</th>}
            <th>Detail</th>
            <th className="hide-mobile">By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ cursor: 'default' }}>
              <td style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>{formatDateTime(r.ts)}</td>
              <td style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{ACTION_LABELS[r.action] || r.action}</td>
              {showAccount && (
                <td style={{ fontSize: 12.5 }}>
                  {r.account ? <Link className="panel-link" to={`/admin/customers/${r.account.id}`}>{r.account.name || r.account.id}</Link> : `${r.resourceType} ${r.resourceId || ''}`}
                </td>
              )}
              <td style={{ fontSize: 12.5 }}>{describeChange(r)}</td>
              <td className="hide-mobile" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{r.actor?.email || r.actor?.name || r.actor?.id || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AuditTab({ accountId }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const limit = 25
  useEffect(() => {
    let live = true
    adminApi.listAudit({ accountId, page, limit })
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [accountId, page])
  return (
    <Panel icon="receipt_long" title="Audit" action={<Link className="panel-link" to={`/admin/audit?accountId=${accountId}`}>Open in Audit log</Link>}>
      {error ? <div className="notice notice-danger" style={{ margin: 14 }}>{error}</div>
        : !data ? <Spinner />
          : data.rows.length === 0 ? <EmptyState icon="receipt_long" title="No admin changes yet" message="Plan, licence, feature and status changes made here are recorded." /> : (
            <>
              <AuditTable rows={data.rows} />
              <Pager page={data.page} limit={data.limit} total={data.total} onPage={setPage} />
            </>
          )}
    </Panel>
  )
}

/**
 * Everything that happened in this account (platform_events), live: sign-ins,
 * cameras and NVRs, team changes, and operator changes. The Audit tab stays
 * the operator-change record with before/after detail.
 */
export function ActivityTab({ accountId }) {
  const [page, setPage] = useState(1)
  const [cats, setCats] = useState(() => CATEGORIES.map((c) => c.id))
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [fresh, setFresh] = useState(() => new Set())
  const limit = 25
  const catKey = cats.slice().sort().join(',')
  const allCats = cats.length === CATEGORIES.length

  useEffect(() => {
    let live = true
    if (!catKey) return undefined
    adminApi.listActivity({ accountId, page, limit, category: allCats ? '' : catKey })
      .then((d) => { if (live) { setData(d); setError(null) } })
      .catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [accountId, page, catKey, allCats])

  useActivityEvents((ev) => {
    if (ev.accountId !== accountId || !cats.includes(ev.category) || page !== 1) return
    setData((d) => (!d || d.events.some((x) => x.id && x.id === ev.id) ? d : { ...d, total: d.total + 1, events: [ev, ...d.events].slice(0, limit) }))
    if (ev.id) setFresh((s) => new Set(s).add(ev.id))
  })

  return (
    <Panel icon="bolt" title="Activity" action={<Link className="panel-link" to={`/admin/activity?accountId=${accountId}`}>Open in Activity</Link>}>
      <div className="act-panel-tools"><CategoryChips value={cats} onChange={(v) => { setCats(v); setPage(1) }} /></div>
      {!catKey ? <EmptyState icon="filter_alt_off" title="Nothing selected" message="Choose at least one kind of activity." />
        : error ? <div className="notice notice-danger" style={{ margin: 14 }}>{error}</div>
          : !data ? <Spinner />
            : data.events.length === 0 ? <EmptyState icon="bolt" title="No activity yet" message="Sign-ins, camera changes, team changes and operator changes for this account appear here as they happen." /> : (
              <>
                {data.events.map((e) => <ActivityRow key={e.id || `${e.type}${e.createdAt}`} e={e} fresh={fresh.has(e.id)} />)}
                <Pager page={data.page} limit={data.limit} total={data.total} onPage={setPage} />
              </>
            )}
    </Panel>
  )
}
