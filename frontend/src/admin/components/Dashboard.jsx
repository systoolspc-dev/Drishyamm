import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { Spinner } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatDate } from '../data/index.js'
import { KpiTile, StatusDot } from './account/parts.jsx'
import { usageTone, EXPIRING_DAYS } from './account/format.js'
import { useActivity, useActivityEvents } from './activity/activityStore.js'
import { ActivityRow, CategoryChips } from './activity/parts.jsx'
import { readCategories, saveCategories } from './activity/format.js'

/**
 * Home — what needs an operator today, on one screen.
 *
 * Two requests, once per visit (plus the Refresh button): the Accounts list
 * (owners, enforced limits, real camera health) and the service health check.
 * No /admin/stats here: its aggregates (MRR from plan price, DB camera status,
 * all-time unacknowledged events) were not numbers anyone could act on.
 *
 * Live: the KPI tiles follow platform.counters from the operator socket, and a
 * signup / account change / camera event re-reads the two requests (debounced),
 * so nothing here polls. The Live activity panel streams the latest events.
 */

const LIVE_CATS_KEY = 'admin_home_activity_cats'
const isToday = (iso) => !!iso && new Date(iso).toDateString() === new Date().toDateString()
const LIVE_ROWS = 15

const SERVICE_NAMES = { db: 'Database', redis: 'Redis', aiService: 'AI engine' }

function services(health) {
  const c = health?.components || {}
  const out = []
  for (const k of ['db', 'redis', 'aiService']) if (c[k]) out.push({ key: k, name: SERVICE_NAMES[k], ok: c[k].ok, meta: c[k].ok ? `${c[k].latencyMs ?? '—'} ms` : 'down' })
  for (const m of c.mediamtx || []) out.push({ key: `mtx-${m.name}`, name: `Stream service${m.name && m.name !== 'default' ? ` · ${m.name}` : ''}`, ok: m.ok, meta: m.ok ? `${m.paths ?? 0} paths` : 'down' })
  return out
}

/** Every reason an account needs attention, worst first. */
function attentionItems(accounts, svc) {
  const items = []
  for (const s of svc) {
    if (!s.ok) items.push({ id: `svc-${s.key}`, tone: 'danger', title: `${s.name} is down`, detail: 'Platform service health check failed', to: '/admin/live', action: 'Live monitor' })
  }
  for (const a of accounts) {
    const hub = `/admin/customers/${a.id}`
    if (a.status === 'suspended') continue
    if (usageTone(a.cameras.used, a.cameras.limit) === 'danger') {
      items.push({ id: `cam-${a.id}`, tone: 'danger', accountId: a.id, title: a.name, detail: `Cameras at or over licence: ${a.cameras.used} / ${a.cameras.limit}`, to: `${hub}?tab=licences`, action: 'Licences' })
    }
    for (const l of a.ai) {
      if (l.on && usageTone(l.used, l.limit) === 'danger') {
        items.push({ id: `ai-${a.id}-${l.key}`, tone: 'danger', accountId: a.id, title: a.name, detail: `${l.label} at or over licence: ${l.used} / ${l.limit}`, to: `${hub}?tab=licences`, action: 'Licences' })
      }
    }
    const rec = a.licenceRecord
    if (rec && rec.daysLeft !== null && rec.daysLeft <= EXPIRING_DAYS && ['active', 'trial'].includes(rec.status)) {
      items.push({
        id: `lic-${a.id}`,
        tone: rec.daysLeft < 0 ? 'danger' : 'warning',
        accountId: a.id, title: a.name,
        detail: rec.daysLeft < 0 ? `Licence record expired ${formatDate(rec.endDate)}` : `Licence record ends ${formatDate(rec.endDate)} (${rec.daysLeft} d)`,
        to: `${hub}?tab=billing`,
        action: 'Billing',
      })
    }
    if (a.nvrs?.down) {
      items.push({ id: `nvr-${a.id}`, tone: 'danger', accountId: a.id, title: a.name, detail: `${a.nvrs.down} of ${a.nvrs.total} NVR${a.nvrs.total === 1 ? '' : 's'} down (every camera offline)`, to: `${hub}?tab=cameras`, action: 'Cameras' })
    } else if (a.health.offline) {
      items.push({ id: `off-${a.id}`, tone: 'danger', accountId: a.id, title: a.name, detail: `${a.health.offline} of ${a.health.total} cameras offline`, to: `${hub}?tab=cameras`, action: 'Cameras' })
    }
    if (a.health.unstable) {
      items.push({ id: `uns-${a.id}`, tone: 'warning', accountId: a.id, title: a.name, detail: `${a.health.unstable} camera${a.health.unstable === 1 ? '' : 's'} unstable`, to: `${hub}?tab=cameras`, action: 'Cameras' })
    }
  }
  const rank = { danger: 0, warning: 1 }
  return items.sort((x, y) => rank[x.tone] - rank[y.tone])
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState(null)
  const [health, setHealth] = useState(null)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)

  const fetchAll = useCallback(() => Promise.all([
    adminApi.listAccounts().then((d) => setAccounts(d.accounts || [])),
    adminApi.getSystemHealth().then(setHealth).catch(() => setHealth({ components: {} })),
  ]).then(() => { setError(null); setUpdatedAt(new Date()) }).catch((e) => setError(e.message)), [])

  useEffect(() => { fetchAll() }, [fetchAll])
  const refresh = async () => { setRefreshing(true); await fetchAll(); setRefreshing(false) }

  // ── live ──
  const { events, counters } = useActivity()
  const [cats, setCatsState] = useState(() => readCategories(LIVE_CATS_KEY))
  const setCats = (v) => { setCatsState(v); saveCategories(LIVE_CATS_KEY, v) }
  const [fresh, setFresh] = useState(() => new Set())
  const refetchTimer = useRef(null)
  useEffect(() => () => clearTimeout(refetchTimer.current), [])
  useActivityEvents((ev, meta) => {
    if (meta?.live && ev.id) setFresh((s) => new Set(s).add(ev.id))
    if (ev.category === 'system') {
      adminApi.getSystemHealth().then(setHealth).catch(() => {})
      return
    }
    if (ev.category === 'logins') return
    clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => { fetchAll() }, 3000)
  })
  const liveList = useMemo(() => events.filter((e) => cats.includes(e.category)).slice(0, LIVE_ROWS), [events, cats])

  const svc = useMemo(() => services(health), [health])
  const items = useMemo(() => (accounts ? attentionItems(accounts, svc) : []), [accounts, svc])

  const k = useMemo(() => {
    const list = accounts || []
    const sum = (f) => list.reduce((n, a) => n + f(a), 0)
    // Pushed counters win while they are newer than the last full read.
    const c = counters && (!updatedAt || new Date(counters.at) > updatedAt) ? counters : null
    return {
      accounts: c ? c.accounts : list.length,
      suspended: c ? c.suspended : list.filter((a) => a.status === 'suspended').length,
      signupsToday: c ? c.signupsToday : list.filter((a) => isToday(a.createdAt)).length,
      online: c ? c.cameras.online : sum((a) => a.health.online),
      total: c ? c.cameras.total : sum((a) => a.health.total),
      offline: c ? c.cameras.offline : sum((a) => a.health.offline),
      attentionAccounts: new Set(items.map((i) => i.accountId).filter(Boolean)).size,
      expiring: list.filter((a) => a.licenceRecord && a.licenceRecord.daysLeft !== null && a.licenceRecord.daysLeft <= EXPIRING_DAYS).length,
    }
  }, [accounts, items, counters, updatedAt])
  const down = svc.filter((s) => !s.ok).length

  return (
    <div className="page">
      <Topbar
        title="Home"
        subtitle={updatedAt ? `What needs attention · updated ${updatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'What needs attention'}
        actions={
          <button className={`refresh-btn ${refreshing ? 'spinning' : ''}`} onClick={refresh} disabled={refreshing}>
            <span className="material-symbols-outlined">refresh</span>
            <span className="hide-mobile-inline">{refreshing ? 'Refreshing' : 'Refresh'}</span>
          </button>
        }
      />
      <div className="page-inner">
        {error && <div className="notice notice-danger" style={{ marginBottom: 16 }}>Could not load: {error}</div>}
        {!accounts ? (error ? null : <Spinner />) : (
          <>
            <div className="hub-tiles five">
              <Link to="/admin/customers" style={{ textDecoration: 'none', color: 'inherit' }}>
                <KpiTile
                  label="Customer accounts"
                  value={k.accounts}
                  sub={[k.signupsToday ? `${k.signupsToday} new today` : null, k.suspended ? `${k.suspended} suspended` : 'none suspended'].filter(Boolean).join(' · ')}
                />
              </Link>
              <KpiTile label="Cameras online" value={`${k.online} / ${k.total}`} sub={k.offline ? `${k.offline} offline` : 'none offline'} subTone={k.offline ? 'danger' : null} />
              <KpiTile label="Accounts needing attention" value={k.attentionAccounts} sub="limits, licences or cameras" tone={k.attentionAccounts ? 'warning' : null} />
              <KpiTile label={`Licences ending ≤ ${EXPIRING_DAYS} d`} value={k.expiring} sub="or already expired" tone={k.expiring ? 'warning' : null} />
              <KpiTile label="Platform services" value={down ? `${down} down` : 'All up'} sub={`${svc.length} checked`} tone={down ? 'danger' : null} />
            </div>

            <div className="hub-grid">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title"><span className="material-symbols-outlined">priority_high</span>Needs attention</div>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{items.length} item{items.length === 1 ? '' : 's'}</span>
                </div>
                <div className="panel-body-flush" style={{ maxHeight: 'calc(var(--app-vh, 100vh) - 330px)', minHeight: 160 }}>
                  {items.length === 0 ? (
                    <div style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                      <span className="material-symbols-outlined" style={{ display: 'block', fontSize: 28, color: 'var(--color-success)', marginBottom: 6 }}>task_alt</span>
                      Nothing needs attention. Every account is within its limits and its cameras are reachable.
                    </div>
                  ) : items.map((it) => (
                    <Link key={it.id} to={it.to} className="attn-row">
                      <StatusDot tone={it.tone}>{it.tone === 'danger' ? 'Act' : 'Check'}</StatusDot>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontWeight: 600, display: 'block' }} className="truncate">{it.title}</span>
                        <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{it.detail}</span>
                      </span>
                      <span className="panel-link" style={{ whiteSpace: 'nowrap' }}>{it.action}<span className="material-symbols-outlined icon-sm">chevron_right</span></span>
                    </Link>
                  ))}
                </div>
              </section>

              <div className="hub-side">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title"><span className="material-symbols-outlined">bolt</span>Live activity</div>
                  <Link className="panel-link" to="/admin/activity">All activity</Link>
                </div>
                <div className="act-panel-tools"><CategoryChips value={cats} onChange={setCats} /></div>
                <div className="panel-body-flush" style={{ maxHeight: 520 }}>
                  {liveList.length === 0
                    ? <p className="act-empty">{cats.length ? 'Nothing yet. New signups, account changes and camera problems appear here as they happen.' : 'Choose at least one kind of activity.'}</p>
                    : liveList.map((e) => <ActivityRow key={e.id || `${e.type}${e.createdAt}`} e={e} fresh={fresh.has(e.id)} />)}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title"><span className="material-symbols-outlined">dns</span>Platform services</div>
                  <Link className="panel-link" to="/admin/live">Live monitor</Link>
                </div>
                <div className="panel-body-flush">
                  {svc.length === 0 ? <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-muted)' }}>Health check did not answer.</p>
                    : svc.map((s) => (
                      <div key={s.key} className="hub-list-row">
                        <span style={{ fontWeight: 600 }}>{s.name}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{s.meta}</span>
                          <StatusDot tone={s.ok ? 'success' : 'danger'}>{s.ok ? 'Up' : 'Down'}</StatusDot>
                        </span>
                      </div>
                    ))}
                </div>
              </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
