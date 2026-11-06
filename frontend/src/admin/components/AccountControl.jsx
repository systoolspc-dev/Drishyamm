import { useState, useEffect, useCallback, useRef } from 'react'
import { DEMO_KEYS } from '@/core/nav/entitlements'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { Spinner, Modal, InfoRow } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatDate } from '../data/index.js'
import { UsageMeter, StatusDot, SuspendConfirm } from './account/parts.jsx'
import {
  OverviewTab, CamerasTab, AiServicesTab, UsersTab, BillingTab, EventsTab, ActivityTab, AuditTab,
} from './account/HubTabs.jsx'
import { useActivityEvents } from './activity/activityStore.js'

/**
 * Account hub — one customer account. Tabs are URL-addressable (?tab=), so a
 * link can open straight onto Billing or Cameras.
 *
 * Licences & features is the enforced source of truth (the owner's
 * Subscription: plan, camera_limit, feature_limits, features). Every switch is
 * enforced by the backend too, and every save lands in the audit log.
 * The feature switches are drawn from the backend catalog, so a key added to
 * featureCatalog appears here without a frontend change.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'licences', label: 'Licences & features' },
  { id: 'cameras', label: 'Cameras & NVRs' },
  { id: 'ai', label: 'AI services' },
  { id: 'users', label: 'Users' },
  { id: 'billing', label: 'Billing' },
  { id: 'events', label: 'Alerts & events' },
  { id: 'activity', label: 'Activity' },
  { id: 'audit', label: 'Audit' },
]

// Empty input = no separate limit (null); otherwise a whole number.
const toInput = (v) => (v === null || v === undefined ? '' : String(v))
const fromInput = (s) => (String(s).trim() === '' ? null : Number(s))
const SEARCH_FROM = 20 // show the feature search box past this many switches

// Keyed on the account id so switching accounts starts from a clean slate.
export default function AccountControl() {
  const { id } = useParams()
  return <AccountHub key={id} id={id} />
}

function AccountHub({ id }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview'
  const setTab = useCallback((t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: false }), [setParams])

  const [control, setControl] = useState(null)
  const [hub, setHub] = useState(null)
  const [error, setError] = useState(null)
  const [redirectOwner, setRedirectOwner] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState(null)

  const loadHub = useCallback(() => {
    adminApi.getAccountHub(id).then((r) => setHub(r.data)).catch((e) => {
      if (e.data?.ownerId) setRedirectOwner(e.data.ownerId)
      setError(e.message)
    })
  }, [id])
  const loadControl = useCallback(() => {
    adminApi.getAccountControl(id).then((r) => setControl(r.data)).catch((e) => {
      if (e.data?.ownerId) setRedirectOwner(e.data.ownerId)
      setError(e.message)
    })
  }, [id])

  useEffect(() => { loadHub(); loadControl() }, [loadHub, loadControl])

  // Someone else changed this account (another operator, the customer adding
  // cameras, an NVR going down): re-read the hub, at most every 2 s.
  const reloadTimer = useRef(null)
  useEffect(() => () => clearTimeout(reloadTimer.current), [])
  useActivityEvents((ev) => {
    if (ev.accountId !== id || ev.category === 'logins') return
    clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => { loadHub() }, 2000)
  })
  // Bumped on every saved snapshot so the Licences tab re-reads its drafts.
  const [controlVersion, setControlVersion] = useState(0)

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 6000) }

  if (error) {
    return (
      <div className="page">
        <Topbar title="Account" />
        <div className="page-inner">
          <div className="notice notice-danger">{error}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => { setError(null); setRedirectOwner(null); loadHub(); loadControl() }}>Try again</button>
            <button className="btn btn-ghost" onClick={() => navigate('/admin/customers')}>Back to Accounts</button>
            {redirectOwner && (
              <button className="btn btn-primary" onClick={() => navigate(`/admin/customers/${redirectOwner}`)}>Open account owner</button>
            )}
          </div>
        </div>
      </div>
    )
  }
  if (!hub || !control) return <div className="page"><Topbar title="Account" /><Spinner /></div>

  const account = hub.account
  const active = account.status === 'active'

  return (
    <div className="page">
      <Topbar
        title={account.name}
        subtitle={`${account.email || 'no email'} · ${account.members + 1} user${account.members ? 's' : ''}`}
        actions={
          <Link className="btn btn-ghost" to="/admin/customers" title="Back to Accounts">
            <span className="material-symbols-outlined icon-sm">arrow_back</span>
            <span className="hide-mobile-inline">Accounts</span>
          </Link>
        }
      />
      <div className="page-inner">
        <div className="hub-head">
          <div className="hub-head-meta">
            <StatusDot tone={active ? 'success' : 'danger'}>{active ? 'Active' : 'Suspended'}</StatusDot>
            <span>{hub.plan ? `${hub.plan.name} plan${hub.plan.aiEnabled ? '' : ' · no AI'}` : 'No plan'}</span>
            <span>Customer since {formatDate(account.createdAt)}</span>
          </div>
          {!confirming && (
            <button className={`btn ${active ? 'btn-danger' : 'btn-primary'}`} onClick={() => setConfirming(true)}>
              <span className="material-symbols-outlined icon-sm">{active ? 'block' : 'lock_open'}</span>
              {active ? 'Suspend account' : 'Reactivate account'}
            </button>
          )}
        </div>

        {confirming && (
          <div style={{ marginBottom: 16 }}>
            <SuspendConfirm
              account={account}
              onCancel={() => setConfirming(false)}
              onDone={(status) => {
                setConfirming(false)
                flash(status === 'active' ? 'Account reactivated. Its users can sign in again.' : 'Account suspended. Its users were signed out.')
                loadHub(); loadControl(); setControlVersion((v) => v + 1)
              }}
            />
          </div>
        )}
        {!active && !confirming && (
          <div className="notice notice-danger" style={{ marginBottom: 16 }}>
            This account is suspended. Its users cannot sign in or use the API.
          </div>
        )}
        {notice && <div className="notice" role="status" style={{ marginBottom: 16 }}>{notice}</div>}

        <div className="hub-tabs" role="tablist" aria-label="Account sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="hub-tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'billing' && hub.billing.mismatches.length > 0 && <span className="hub-tab-count tone-warning">!</span>}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab hub={hub} onTab={setTab} />}
        {tab === 'licences' && (
          <LicencesTab
            id={id}
            key={controlVersion}
            data={control}
            onSaved={(d, msg) => { setControl(d); setControlVersion((v) => v + 1); flash(msg); loadHub() }}
          />
        )}
        {tab === 'cameras' && <CamerasTab hub={hub} accountId={id} />}
        {tab === 'ai' && <AiServicesTab hub={hub} />}
        {tab === 'users' && <UsersTab hub={hub} accountId={id} />}
        {tab === 'billing' && <BillingTab hub={hub} />}
        {tab === 'events' && <EventsTab accountId={id} />}
        {tab === 'activity' && <ActivityTab accountId={id} />}
        {tab === 'audit' && <AuditTab accountId={id} />}
      </div>
    </div>
  )
}

/* ═════════════════════════ Licences & features ═════════════════════════ */

function LicencesTab({ id, data, onSaved }) {
  const [busy, setBusy] = useState(null) // 'plan' | 'save'
  // Drafts start from the saved snapshot; the parent remounts this tab (key)
  // whenever a new snapshot is saved.
  const [planId, setPlanId] = useState(data.subscription?.planId || '')
  const [camDraft, setCamDraft] = useState(toInput(data.cameras.override ?? data.cameras.planDefault))
  const [camUsePlan, setCamUsePlan] = useState(data.cameras.override === null)
  const [aiDraft, setAiDraft] = useState(() => Object.fromEntries(data.aiLicences.map((l) => [l.key, toInput(l.limit)])))
  const [featAll, setFeatAll] = useState(data.features.mode === 'all')
  const [featDraft, setFeatDraft] = useState(data.features.enabled)
  const [conflicts, setConflicts] = useState(null) // 409 BELOW_USAGE → choice modal
  const [query, setQuery] = useState('')

  const { subscription, plans, cameras, aiLicences, features, licenceRecord } = data
  const aiTier = subscription?.aiEnabled === true
  const planChanged = (subscription?.planId || '') !== planId && planId !== ''

  /* ── what is unsaved ── */
  const licenceBody = () => {
    const featureLimits = {}
    for (const l of aiLicences) {
      const next = fromInput(aiDraft[l.key] ?? '')
      if (next !== l.limit) featureLimits[l.key] = next
    }
    const body = {}
    const nextCam = camUsePlan ? null : fromInput(camDraft)
    if (nextCam !== cameras.override) body.cameraLimit = nextCam
    if (Object.keys(featureLimits).length) body.featureLimits = featureLimits
    return body
  }
  const lb = licenceBody()
  const licenceChanges = ('cameraLimit' in lb ? 1 : 0) + Object.keys(lb.featureLimits || {}).length
  const licenceInvalid = (!camUsePlan && (camDraft === '' || !Number.isInteger(Number(camDraft)) || Number(camDraft) < 0))
    || Object.values(aiDraft).some((v) => v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0))

  const savedAll = features.mode === 'all'
  // "All features" = every key EXCEPT the demo (sample-data) ones: a full
  // account never gets those — featureCatalog.isFeatureOn / DEMO_KEYS.
  const effective = (all, list) => (all
    ? features.groups.flatMap((g) => g.items.map((i) => i.key)).filter((k) => !DEMO_KEYS.includes(k))
    : list)
  const savedOn = new Set(effective(savedAll, features.enabled))
  const draftOn = new Set(effective(featAll, featDraft))
  const itemChanges = features.groups.flatMap((g) => g.items).filter((i) => savedOn.has(i.key) !== draftOn.has(i.key)).length
  // Switching 'All features' on/off with the same switches on is one change.
  const featureChanges = itemChanges || (featAll !== savedAll ? 1 : 0)
  const unsaved = licenceChanges + featureChanges

  // Head count / activity switched off entirely also stop on their cameras.
  const featureStops = featAll ? [] : aiLicences
      .filter((l) => ['headcount', 'activity'].includes(l.key) && l.used > 0)
      .filter((l) => l.features.some((k) => savedOn.has(k)))
      .filter((l) => !l.features.some((k) => featDraft.includes(k)))

  const discard = () => {
    setCamUsePlan(cameras.override === null)
    setCamDraft(toInput(cameras.override ?? cameras.planDefault))
    setAiDraft(Object.fromEntries(aiLicences.map((l) => [l.key, toInput(l.limit)])))
    setFeatAll(savedAll)
    setFeatDraft(features.enabled)
  }

  /* ── saves ── */
  const savePlan = async () => {
    setBusy('plan')
    try {
      const r = await adminApi.setAccountPlan(id, planId)
      onSaved(r.data, 'Plan saved.')
    } catch (e) { alert(e.message) }
    setBusy(null)
  }

  // One Save for both halves: licences first (they may need a choice), then features.
  const saveAll = async (choices = null) => {
    if (featureChanges && featureStops.length && !choices) {
      const msg = featureStops.map((l) => `${l.label} will also stop on ${l.used} camera(s).`).join('\n')
      if (!window.confirm(`${msg}\n\nSave anyway?`)) return
    }
    setBusy('save')
    let latest = null
    const parts = []
    try {
      if (licenceChanges || choices) {
        const r = await adminApi.setAccountLicences(id, { ...licenceBody(), ...(choices || {}) })
        latest = r.data
        setConflicts(null)
        const off = Object.entries(r.switchedOff || {}).map(([k, ids]) => `${ids.length} camera(s) for ${k}`)
        parts.push(off.length ? `Licences saved; switched off ${off.join(', ')}.` : 'Licences saved.')
      }
      if (featureChanges) {
        const r = await adminApi.setAccountFeatures(id, featAll ? { mode: 'all' } : { features: featDraft })
        latest = r.data
        parts.push('Features saved; the customer sees the change within a minute.')
      }
      if (latest) onSaved(latest, parts.join(' '))
    } catch (e) {
      if (e.status === 409 && e.data?.code === 'BELOW_USAGE') setConflicts(e.data.conflicts)
      else alert(e.message)
      if (latest) onSaved(latest, parts.join(' '))
    }
    setBusy(null)
  }

  /* ── feature switch helpers ── */
  const totalSwitches = features.groups.reduce((n, g) => n + g.items.length, 0)
  const q = query.trim().toLowerCase()
  const visibleGroups = features.groups
    .map((g) => ({
      ...g,
      items: q ? g.items.filter((i) => `${i.label} ${i.note || ''} ${i.description || ''} ${g.label}`.toLowerCase().includes(q)) : g.items,
    }))
    .filter((g) => g.items.length)

  // Leaving "all features" starts from what is effectively on now.
  const startCustom = () => { if (featAll) { setFeatAll(false); setFeatDraft([...draftOn]) } }
  const toggleFeature = (key) => {
    startCustom()
    setFeatDraft((prev) => {
      const base = featAll ? [...draftOn] : prev
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
    })
  }
  const setGroup = (g, on) => {
    const keys = g.items.map((i) => i.key)
    setFeatAll(false)
    setFeatDraft((prev) => {
      const base = featAll ? [...draftOn] : prev
      return on ? [...new Set([...base, ...keys])] : base.filter((k) => !keys.includes(k))
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: unsaved ? 72 : 0 }}>
      {/* ── Plan ─────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title"><span className="material-symbols-outlined">badge</span>Plan</div>
        </div>
        <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 18 }}>
          <div style={{ minWidth: 0 }}>
            <p className="section-label">Plan tier</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="select" style={{ flex: 1, minWidth: 0 }} value={planId} onChange={(e) => setPlanId(e.target.value)} aria-label="Plan tier">
                {!subscription && <option value="">No plan — choose one</option>}
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.aiEnabled ? 'includes AI' : 'no AI'} · {p.maxCameras > 0 ? `${p.maxCameras} cameras` : 'unlimited'}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={!planChanged || busy === 'plan'} onClick={savePlan}>
                {busy === 'plan' ? 'Saving…' : 'Save plan'}
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 8 }}>
              {aiTier ? 'AI features are available on this tier; switch each one below.' : 'This tier has no AI. AI pages stay hidden and AI APIs refuse, whatever is switched on below.'}
            </p>
          </div>
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', alignSelf: 'start', minWidth: 0 }}>
            <InfoRow label="Subscription" value={subscription ? subscription.status : 'none'} />
            <InfoRow label="Valid until" value={subscription ? (new Date(subscription.currentPeriodEnd).getFullYear() > 2100 ? 'Open-ended' : formatDate(subscription.currentPeriodEnd)) : '—'} />
            <InfoRow
              label="Licence record"
              value={licenceRecord
                ? <Link to={`/admin/licenses/${licenceRecord.id}`} className="panel-link">{licenceRecord.status} · ends {formatDate(licenceRecord.endDate)}</Link>
                : 'none'}
            />
          </div>
        </div>
      </section>

      {/* ── Licences ─────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title"><span className="material-symbols-outlined">workspace_premium</span>Licences (enforced)</div>
          {licenceChanges > 0 && <span className="tone-warning" style={{ fontSize: 12, fontWeight: 600 }}>{licenceChanges} unsaved</span>}
        </div>
        <div className="panel-body-flush">
          {!subscription && <p style={{ padding: '14px 18px', fontSize: 13, color: 'var(--color-text-secondary)' }}>Assign a plan first.</p>}
          <table className="data-table lic-table">
            <thead>
              <tr><th>Licence</th><th>In use</th><th>Allowed</th></tr>
            </thead>
            <tbody>
              <tr style={{ cursor: 'default' }}>
                <td>
                  <div style={{ fontWeight: 600 }}>Cameras (Basic VMS)</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    New cameras are refused past this.
                    {!cameras.enforced && ' Enforcement is off on this server (ENFORCE_CAMERA_LIMITS=false).'}
                  </div>
                </td>
                <td data-label="In use"><UsageMeter used={cameras.used} limit={cameras.limit} /></td>
                <td data-label="Allowed">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={camUsePlan} onChange={(e) => {
                      setCamUsePlan(e.target.checked)
                      if (e.target.checked) setCamDraft(toInput(cameras.planDefault))
                    }} />
                    Plan default ({cameras.planDefault ?? 'unlimited'})
                  </label>
                  <input
                    className="input mono" type="number" min="0" step="1"
                    aria-label="Camera licences allowed"
                    disabled={camUsePlan || !subscription}
                    value={camUsePlan ? toInput(cameras.planDefault) : camDraft}
                    placeholder="unlimited"
                    onChange={(e) => setCamDraft(e.target.value)}
                  />
                </td>
              </tr>
              {aiLicences.map((l) => (
                <tr key={l.key} style={{ cursor: 'default', opacity: l.featureOn ? 1 : 0.6 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{l.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {l.featureOn ? 'AI · per camera' : 'Feature switched off for this account'}
                      {l.cameras.length > 0 && (
                        <span title={l.cameras.map((c) => c.name).join('\n')}> · on {l.cameras.slice(0, 2).map((c) => c.name).join(', ')}{l.cameras.length > 2 ? ` +${l.cameras.length - 2}` : ''}</span>
                      )}
                    </div>
                  </td>
                  <td data-label="In use"><UsageMeter used={l.used} limit={l.limit} /></td>
                  <td data-label="Allowed">
                    <input
                      className="input mono" type="number" min="0" step="1"
                      aria-label={`${l.label} licences allowed`}
                      disabled={!subscription}
                      value={aiDraft[l.key] ?? ''}
                      placeholder="No separate limit"
                      onChange={(e) => setAiDraft((p) => ({ ...p, [l.key]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ padding: '10px 18px 14px', fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
            Empty AI limit = bounded only by the camera licence. Weapon, fire, aggression and ANPR are licensed on/off only (below).
          </p>
        </div>
      </section>

      {/* ── Features ─────────────────────────── */}
      <section className="panel">
        <div className="panel-head" style={{ flexWrap: 'wrap' }}>
          <div className="panel-title"><span className="material-symbols-outlined">toggle_on</span>Features in the customer’s app</div>
          {totalSwitches > SEARCH_FROM && (
            <div className="search-box" style={{ minWidth: 0, flex: '1 1 200px', maxWidth: 320 }}>
              <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>search</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${totalSwitches} features`} aria-label="Search features" />
            </div>
          )}
        </div>
        <div className="panel-body">
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 0 14px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
            <button
              type="button" className="calc-switch" data-on={featAll ? 'true' : 'false'}
              aria-pressed={featAll} aria-label="All features"
              onClick={() => { if (featAll) startCustom(); else setFeatAll(true) }}
              style={featAll ? { background: 'var(--color-primary)' } : undefined}
            />
            <span>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>All features</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                Everything the plan allows, including features added later — except Demo features, which stay off until switched on. Turn a switch off to choose.
              </span>
            </span>
          </label>

          {visibleGroups.length === 0 && <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 14 }}>No feature matches “{query}”.</p>}
          <div className="feat-groups">
            {visibleGroups.map((g) => {
              const aiLocked = g.ai && !aiTier
              const onCount = g.items.filter((i) => draftOn.has(i.key)).length
              return (
                <div key={g.id} className="feat-group" style={{ opacity: aiLocked ? 0.6 : 1 }}>
                  <div className="feat-group-head">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{g.label}{g.ai ? ' · AI' : ''}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                        {aiLocked ? 'Needs an AI plan' : `${onCount} of ${g.items.length} on`}{g.description ? ` · ${g.description}` : ''}
                      </div>
                    </div>
                    {g.items.length > 1 && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button type="button" className="btn btn-ghost feat-mini" disabled={onCount === g.items.length} onClick={() => setGroup(g, true)}>All on</button>
                        <button type="button" className="btn btn-ghost feat-mini" disabled={onCount === 0} onClick={() => setGroup(g, false)}>All off</button>
                      </div>
                    )}
                  </div>
                  {g.items.map((it) => {
                    const on = draftOn.has(it.key)
                    const changed = on !== savedOn.has(it.key)
                    const help = it.description || it.note
                    return (
                      <label key={it.key} className="feat-row">
                        <button
                          type="button" className="calc-switch" data-on={on ? 'true' : 'false'}
                          aria-pressed={on} aria-label={it.label}
                          onClick={() => toggleFeature(it.key)}
                          style={on ? { background: 'var(--color-primary)' } : undefined}
                        />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</span>
                          {DEMO_KEYS.includes(it.key) && <span className="mono" title="Runs on sample data, not a real detector. Off for every account until switched on here." style={{ fontSize: 10.5, fontWeight: 700, marginLeft: 6, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}>DEMO</span>}
                          {changed && <span className="tone-warning" style={{ fontSize: 11, fontWeight: 700, marginLeft: 6 }}>unsaved</span>}
                          {help && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--color-text-muted)' }}>{help}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )
            })}
          </div>
          {features.unknown.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 12 }}>
              Also on this account (set outside this console, kept as is): <span className="mono">{features.unknown.join(', ')}</span>
            </p>
          )}
          {featureStops.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--color-warning-text)', marginTop: 12 }}>
              {featureStops.map((l) => `${l.label} will also stop on ${l.used} camera(s).`).join(' ')}
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 12 }}>
            A switched-off feature disappears from the customer’s menu, its pages redirect to Home, and its APIs answer 403.
          </p>
        </div>
      </section>

      {unsaved > 0 && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <span style={{ fontWeight: 600 }}>{unsaved} unsaved change{unsaved === 1 ? '' : 's'}</span>
          {licenceInvalid && <span className="tone-danger" style={{ fontSize: 12.5 }}>Limits must be whole numbers.</span>}
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={discard} disabled={busy === 'save'}>Discard</button>
          <button className="btn btn-primary" onClick={() => saveAll()} disabled={!subscription || licenceInvalid || busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}

      <BelowUsageModal
        conflicts={conflicts}
        busy={busy === 'save'}
        onCancel={() => setConflicts(null)}
        onConfirm={(choices) => saveAll(choices)}
      />
    </div>
  )
}

/**
 * Shown when a save would put a limit under what is in use. Cameras are never
 * deleted by a licence change, so for cameras the only choice is to accept
 * that new ones are refused until the account is back under. For an AI
 * licence the admin picks: keep it running on every current camera, or switch
 * it off on the newest cameras over the limit.
 */
function BelowUsageModal({ conflicts, busy, onCancel, onConfirm }) {
  if (!conflicts) return null
  // Keyed on the conflict list so every new refusal starts with no choice made.
  return <BelowUsageChoices key={JSON.stringify(conflicts)} conflicts={conflicts} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
}

function BelowUsageChoices({ conflicts, busy, onCancel, onConfirm }) {
  const [choice, setChoice] = useState({})
  const [camOk, setCamOk] = useState(false)

  const camConflict = conflicts.find((c) => c.key === 'cameras')
  const aiConflicts = conflicts.filter((c) => c.key !== 'cameras')
  const ready = (!camConflict || camOk) && aiConflicts.every((c) => choice[c.key])

  const confirm = () => {
    const body = {}
    if (camConflict) body.confirmBelowUsage = true
    if (aiConflicts.length) body.overLimit = Object.fromEntries(aiConflicts.map((c) => [c.key, choice[c.key]]))
    onConfirm(body)
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title="Below what is in use"
      subtitle="Choose what happens to what the account already uses."
      width={560}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" disabled={!ready || busy} onClick={confirm}>
            {busy ? 'Saving…' : 'Save with these choices'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {camConflict && (
          <div style={{ border: '1px solid var(--danger-line, var(--color-border))', borderRadius: 'var(--radius-md)', padding: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>
              Cameras: limit {camConflict.limit}, {camConflict.used} already added
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', margin: '6px 0 8px' }}>
              No camera is removed. The existing {camConflict.used} keep working; adding cameras is refused until the
              account is under {camConflict.limit}.
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={camOk} onChange={(e) => setCamOk(e.target.checked)} />
              I understand — set it anyway
            </label>
          </div>
        )}
        {aiConflicts.map((c) => (
          <div key={c.key} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.label}: limit {c.limit}, on {c.used} cameras now</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginTop: 8, cursor: 'pointer' }}>
              <input type="radio" name={`ol-${c.key}`} checked={choice[c.key] === 'keep'} onChange={() => setChoice((p) => ({ ...p, [c.key]: 'keep' }))} />
              <span>Keep it running on all {c.used}. No more cameras can switch it on.</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginTop: 6, cursor: 'pointer' }}>
              <input type="radio" name={`ol-${c.key}`} checked={choice[c.key] === 'disable_excess'} onChange={() => setChoice((p) => ({ ...p, [c.key]: 'disable_excess' }))} />
              <span>Switch it off on the {c.used - c.limit} most recently changed camera{c.used - c.limit === 1 ? '' : 's'}.</span>
            </label>
          </div>
        ))}
      </div>
    </Modal>
  )
}
