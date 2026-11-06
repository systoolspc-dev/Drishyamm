import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { adminApi } from '../services/api.js'
import { formatCurrency } from '../data/index.js'

// GPU-hours per camera per month, derived from real inference cost.
// One Blackwell GPU @ ~120 simultaneous face-rec streams ≈ 86,400 cam-hours/mo
// → ~6 GPU-hours per camera-month for face recognition.
const GPU_FACTORS_PER_CAM_MONTH = {
  feat_face_rec:  6.0,
  feat_behavior:  3.0,
  feat_lpr:       4.0,
  feat_talkback:  0,
  feat_mobile:    0,
  feat_api:       0,
}

const TERM_OPTIONS = [
  { value: 'trial_30',  label: 'Trial 30',   months: 1,  multiplier: 0,    badge: 'Free pilot' },
  { value: 'trial_60',  label: 'Trial 60',   months: 2,  multiplier: 0,    badge: 'Free pilot' },
  { value: 'trial_90',  label: 'Trial 90',   months: 3,  multiplier: 0,    badge: 'Free pilot' },
  { value: 'monthly',   label: 'Monthly',    months: 1,  multiplier: 1.00, badge: '' },
  { value: 'annual',    label: '1-Year',     months: 12, multiplier: 0.85, badge: 'Save 15%' },
  { value: 'biennial',  label: '2-Year',     months: 24, multiplier: 0.75, badge: 'Save 25%' },
  { value: 'triennial', label: '3-Year',     months: 36, multiplier: 0.65, badge: 'Save 35%' },
]

const FEATURE_LIST = [
  { sku: 'feat_face_rec', label: 'Face Recognition',    sub: 'AdaFace + SCRFD pipeline',     icon: 'face',           color: '#F7983A' },
  { sku: 'feat_behavior', label: 'Behaviour Detection', sub: 'Tripwire · loitering · intrusion', icon: 'warning',    color: '#7c3aed' },
  { sku: 'feat_lpr',      label: 'LPR / Vehicle',       sub: 'Licence-plate recognition',    icon: 'directions_car', color: '#0ea5e9' },
  { sku: 'feat_talkback', label: 'Talkback Audio',      sub: 'Two-way audio',                icon: 'mic',            color: '#16a34a' },
  { sku: 'feat_mobile',   label: 'Mobile App',          sub: 'iOS + Android',                icon: 'phone_iphone',   color: '#2563eb' },
  { sku: 'feat_api',      label: 'API Access',          sub: 'Programmatic access',          icon: 'api',            color: '#dc2626' },
]

const SUPPORT_OPTIONS = [
  { sku: 'support_basic',    label: 'Basic',    sub: 'email · 3 BD',          color: '#64748b' },
  { sku: 'support_business', label: 'Business', sub: '1 BD SLA · phone',      color: '#2563eb' },
  { sku: 'support_24x7',     label: '24×7',     sub: 'CSM · 1-hr critical',   color: '#F7983A' },
]

const RETENTION_PRESETS = [7, 30, 60, 90, 180, 365]

// Quick-jump camera presets — supports anything from a single store to a 10k-camera
// city-wide deployment. The number input still accepts any custom value.
const CAMERA_PRESETS = [10, 50, 100, 500, 1000, 2000, 5000, 10000]
const CAMERA_MAX     = 100000   // 100k upper bound on input (custom range)

// Storage presets in GB — covers 1 TB to 1 PB
const STORAGE_PRESETS_GB = [1024, 5120, 10240, 51200, 102400, 512000, 1048576]
const STORAGE_MAX_GB     = 10485760  // 10 PB upper bound on input

const DEFAULT_FORM = {
  customerId: '',
  cam_hd: 50,
  cam_4k: 0,
  storage_gb: 5000,
  retentionDays: 30,
  gpu_hour: 0,
  gpuOverride: false,
  features: {
    feat_face_rec: { enabled: false, cameras: 0 },
    feat_behavior: { enabled: false, cameras: 0 },
    feat_lpr:      { enabled: false, cameras: 0 },
    feat_talkback: { enabled: false, cameras: 0 },
    feat_mobile:   { enabled: false, cameras: 0 },
    feat_api:      { enabled: false, cameras: 0 },
  },
  support: 'support_basic',
  includeSetupFee: true,
  term: 'annual',
  discountPct: 0,
}

export default function PricingCalculator() {
  const navigate = useNavigate()
  const [users, setUsers] = useState([])
  const [form, setForm]   = useState(DEFAULT_FORM)
  const [quote, setQuote] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [saving, setSaving]   = useState(null) // 'quote' | 'license' | null
  const [notes, setNotes]     = useState('')
  const [feedback, setFeedback] = useState(null)
  const debounceRef = useRef(null)

  useEffect(() => {
    adminApi.getUsers().then(d => setUsers(d.users || [])).catch(() => {})
  }, [])

  const totalCameras = (form.cam_hd || 0) + (form.cam_4k || 0)

  // Auto-derive GPU hours from enabled features × camera count
  const gpuAuto = useMemo(() => {
    let total = 0
    for (const sku of Object.keys(GPU_FACTORS_PER_CAM_MONTH)) {
      const f = form.features[sku]
      if (!f || !f.enabled) continue
      const cams = Number(f.cameras > 0 ? f.cameras : totalCameras)
      total += cams * GPU_FACTORS_PER_CAM_MONTH[sku]
    }
    return Math.round(total)
  }, [form.features, totalCameras])

  const gpuEffective = form.gpuOverride ? form.gpu_hour : gpuAuto

  // Build the API payload from form state
  const payload = useMemo(() => ({
    resources: {
      cam_hd:     { quota: form.cam_hd     || 0 },
      cam_4k:     { quota: form.cam_4k     || 0 },
      storage_gb: { quota: form.storage_gb || 0 },
      gpu_hour:   { quota: gpuEffective    || 0 },
    },
    features: Object.fromEntries(
      Object.entries(form.features).map(([sku, f]) => [
        sku,
        { enabled: f.enabled, cameras: f.cameras > 0 ? f.cameras : totalCameras },
      ])
    ),
    support: form.support,
    includeSetupFee: form.includeSetupFee,
    term: form.term,
    discountPct: form.discountPct,
    retentionDays: form.retentionDays,
  }), [form, totalCameras, gpuEffective])

  // Debounced calc on form change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setLoading(true)
      adminApi.calculateQuote(payload)
        .then(d => { setQuote(d.quote); setError(null) })
        .catch(e => setError(e.message))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(debounceRef.current)
  }, [payload])

  const update = (patch) => setForm(p => ({ ...p, ...patch }))
  const setFeature = (sku, patch) => setForm(p => ({
    ...p,
    features: { ...p.features, [sku]: { ...p.features[sku], ...patch } },
  }))
  const reset = () => { setForm(DEFAULT_FORM); setNotes(''); setFeedback(null) }

  const saveAsQuote = async () => {
    setSaving('quote'); setFeedback(null)
    try {
      const d = await adminApi.saveQuote({ userId: form.customerId || null, payload, notes: notes || null })
      setFeedback({ type: 'ok', msg: `Quote saved · expires ${new Date(d.quote.expiresAt).toLocaleDateString()}` })
    } catch (e) { setFeedback({ type: 'err', msg: e.message }) }
    setSaving(null)
  }

  const convertToLicense = async () => {
    if (!form.customerId) {
      setFeedback({ type: 'err', msg: 'Pick a customer first — anonymous quotes cannot be converted to a license.' })
      return
    }
    setSaving('license'); setFeedback(null)
    try {
      const d = await adminApi.createLicense({ userId: form.customerId, payload, notes: notes || null })
      navigate(`/admin/licenses/${d.license.id}`)
    } catch (e) {
      setFeedback({ type: 'err', msg: e.message })
      setSaving(null)
    }
  }

  const enabledFeatureCount = Object.values(form.features).filter(f => f.enabled).length

  return (
    <div className="page">
      <Topbar
        title="Pricing Calculator"
        subtitle="Live quote · auto-GPU · margin-aware"
        actions={
          <>
            <button className="btn btn-ghost" onClick={reset}>
              <span className="material-symbols-outlined icon-sm">refresh</span>
              Reset
            </button>
            <a href="/admin/pricing" className="btn btn-ghost">
              <span className="material-symbols-outlined icon-sm">price_change</span>
              Edit rates
            </a>
          </>
        }
      />
      <div className="page-inner">
        <div className="calc-grid">
          {/* ────────────── LEFT: builder ────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* STEP 1 — Customer */}
            <Step num={1} title="Customer" meta={form.customerId ? 'selected' : 'anonymous quote'}>
              <select
                className="select"
                style={{ width: '100%', fontWeight: 600 }}
                value={form.customerId}
                onChange={e => update({ customerId: e.target.value })}
              >
                <option value="">— Anonymous quote (price-only) —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
              </select>
            </Step>

            {/* STEP 2 — Cameras */}
            <Step num={2} title="Cameras" meta={`${totalCameras} total`}>
              <div className="calc-cam-grid">
                <CameraTile
                  label="HD · 1080p"
                  sub="2 MP · H.264/265"
                  value={form.cam_hd}
                  color="#2563eb"
                  icon="videocam"
                  onChange={v => update({ cam_hd: v })}
                />
                <CameraTile
                  label="4K · 8 MP"
                  sub="4× compute & storage"
                  value={form.cam_4k}
                  color="#7c3aed"
                  icon="4k"
                  onChange={v => update({ cam_4k: v })}
                />
              </div>
            </Step>

            {/* STEP 3 — Storage & Retention */}
            <Step num={3} title="Storage & Retention"
                  meta={`${fmtStorage(form.storage_gb)} · ${form.retentionDays}d`}>
              <div style={{ marginBottom: 12 }}>
                <Label>Storage allocated</Label>
                <div className="calc-num-row" style={{ marginTop: 6 }}>
                  <input
                    type="number" min="0" max={STORAGE_MAX_GB} step="100"
                    className="input"
                    style={{ fontSize: 14, fontWeight: 700 }}
                    value={form.storage_gb}
                    onChange={e => update({ storage_gb: Math.max(0, Math.min(STORAGE_MAX_GB, Number(e.target.value) || 0)) })}
                  />
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>GB</span>
                  {form.storage_gb >= 1024 && (
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      = {fmtStorage(form.storage_gb)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {STORAGE_PRESETS_GB.map(p => (
                    <button
                      key={p}
                      onClick={() => update({ storage_gb: p })}
                      style={{
                        fontSize: 10.5, fontWeight: 700,
                        padding: '3px 9px',
                        borderRadius: 99,
                        border: `1px solid ${form.storage_gb === p ? 'var(--color-primary)' : 'var(--color-border)'}`,
                        background: form.storage_gb === p ? 'var(--color-primary-bg)' : 'var(--color-surface)',
                        color: form.storage_gb === p ? 'var(--color-primary-dark)' : 'var(--color-text-secondary)',
                        cursor: 'pointer',
                        transition: 'all .12s',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {fmtStorage(p)}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  Custom up to {fmtStorage(STORAGE_MAX_GB)} (10 PB)
                </div>
              </div>
              <div>
                <Label>Retention window</Label>
                <div className="filter-group" style={{ marginTop: 6 }}>
                  {RETENTION_PRESETS.map(d => (
                    <button
                      key={d}
                      className={`filter-pill ${form.retentionDays === d ? 'active' : ''}`}
                      onClick={() => update({ retentionDays: d })}
                    >{d < 365 ? `${d}d` : '1y'}</button>
                  ))}
                </div>
                {form.retentionDays > 30 && (
                  <div style={{ fontSize: 11, color: 'var(--color-warning-text)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 13 }}>info</span>
                    Storage cost scales × {(form.retentionDays / 30).toFixed(2)}
                  </div>
                )}
              </div>
            </Step>

            {/* STEP 4 — AI Features (with auto-GPU) */}
            <Step num={4} title="AI Features" meta={`${enabledFeatureCount} / ${FEATURE_LIST.length} enabled`}>
              {/* Auto-GPU display */}
              <div className="calc-gpu-auto" style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: '#7c3aed18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="material-symbols-outlined" style={{ color: '#7c3aed', fontSize: 22 }}>memory</span>
                  </div>
                  <div>
                    <div className="calc-gpu-auto-lbl">
                      GPU compute · {form.gpuOverride ? 'manual' : 'auto'}
                    </div>
                    <div className="calc-gpu-auto-num">
                      {(form.gpuOverride ? form.gpu_hour : gpuAuto).toLocaleString()} <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)' }}>hrs/mo</span>
                    </div>
                    {!form.gpuOverride && enabledFeatureCount > 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginTop: 2 }}>
                        derived from {enabledFeatureCount} feature{enabledFeatureCount > 1 ? 's' : ''} × cameras
                      </div>
                    )}
                  </div>
                </div>
                <button
                  className="calc-switch"
                  data-on={form.gpuOverride}
                  onClick={() => update({ gpuOverride: !form.gpuOverride, gpu_hour: form.gpuOverride ? 0 : gpuAuto })}
                  title={form.gpuOverride ? 'Switch to auto-derive' : 'Manually override'}
                />
              </div>

              {form.gpuOverride && (
                <div style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
                  <Label>Manual GPU hours / month</Label>
                  <div className="calc-num-row" style={{ marginTop: 6 }}>
                    <input
                      type="number" min="0" max="500000" step="10"
                      className="input"
                      style={{ fontSize: 14, fontWeight: 700 }}
                      value={form.gpu_hour}
                      onChange={e => update({ gpu_hour: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>hrs/mo</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                    {[100, 500, 1000, 5000, 10000, 50000, 100000].map(p => (
                      <button
                        key={p}
                        onClick={() => update({ gpu_hour: p })}
                        style={{
                          fontSize: 10.5, fontWeight: 700,
                          padding: '3px 8px',
                          borderRadius: 99,
                          border: `1px solid ${form.gpu_hour === p ? '#7c3aed' : 'var(--color-border)'}`,
                          background: form.gpu_hour === p ? 'light-dark(#faf5ff, var(--ai-soft))' : 'var(--color-surface)',
                          color: form.gpu_hour === p ? '#7c3aed' : 'var(--color-text-secondary)',
                          cursor: 'pointer',
                          transition: 'all .12s',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {fmtCount(p)}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6 }}>
                    Auto suggests <strong>{gpuAuto.toLocaleString()}</strong> hrs/mo for this feature mix
                  </div>
                </div>
              )}

              {/* Feature cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {FEATURE_LIST.map(f => {
                  const state = form.features[f.sku]
                  const gpuFactor = GPU_FACTORS_PER_CAM_MONTH[f.sku] || 0
                  return (
                    <div
                      key={f.sku}
                      className={`calc-feat ${state.enabled ? 'on' : ''}`}
                      style={{ '--__feat-tint': f.color + '14', borderColor: state.enabled ? f.color + '60' : undefined }}
                      onClick={() => setFeature(f.sku, { enabled: !state.enabled, cameras: !state.enabled ? totalCameras : 0 })}
                    >
                      <div className="calc-feat-icon" style={{ background: f.color + (state.enabled ? '22' : '12') }}>
                        <span className="material-symbols-outlined" style={{ color: f.color, fontSize: 20 }}>{f.icon}</span>
                      </div>
                      <div className="calc-feat-body">
                        <div className="calc-feat-title">{f.label}</div>
                        <div className="calc-feat-sub">
                          {f.sub}
                          {gpuFactor > 0 && state.enabled && (
                            <span style={{ marginLeft: 6, color: '#7c3aed', fontWeight: 600 }}>
                              · {gpuFactor.toFixed(1)} GPU-h / cam-mo
                            </span>
                          )}
                        </div>
                        {state.enabled && (
                          <div className="calc-feat-cam" onClick={(e) => e.stopPropagation()}>
                            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Apply to</span>
                            <input
                              type="number" min="0" max={totalCameras}
                              value={state.cameras || ''}
                              placeholder={`all (${totalCameras})`}
                              onChange={e => setFeature(f.sku, { cameras: Math.max(0, Math.min(totalCameras, Number(e.target.value) || 0)) })}
                            />
                            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>cameras</span>
                          </div>
                        )}
                      </div>
                      <button
                        className="calc-switch"
                        data-on={state.enabled}
                        onClick={(e) => { e.stopPropagation(); setFeature(f.sku, { enabled: !state.enabled, cameras: !state.enabled ? totalCameras : 0 }) }}
                      />
                    </div>
                  )
                })}
              </div>
            </Step>

            {/* STEP 5 — Support */}
            <Step num={5} title="Support Tier"
                  meta={SUPPORT_OPTIONS.find(s => s.sku === form.support)?.label}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {SUPPORT_OPTIONS.map(s => {
                  const active = form.support === s.sku
                  return (
                    <button
                      key={s.sku}
                      onClick={() => update({ support: s.sku })}
                      style={{
                        textAlign: 'left', cursor: 'pointer',
                        padding: '12px 14px',
                        border: `2px solid ${active ? s.color : 'var(--color-border)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: active ? `${s.color}10` : 'var(--color-surface)',
                        color: 'var(--color-on-bg)',
                        transition: 'all .12s',
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: active ? s.color : 'var(--color-on-bg)' }}>{s.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{s.sub}</div>
                    </button>
                  )
                })}
              </div>
            </Step>

            {/* STEP 6 — Term & Discount */}
            <Step num={6} title="Term & Discount"
                  meta={`${TERM_OPTIONS.find(t => t.value === form.term)?.label} · ${form.discountPct}% off`}>
              <Label>Commitment — pick your term</Label>
              <div className="calc-term-grid">
                {TERM_OPTIONS.map(t => {
                  const active = form.term === t.value
                  return (
                    <button
                      key={t.value}
                      className={`calc-term-tile ${active ? 'active' : ''}`}
                      onClick={() => update({ term: t.value })}
                    >
                      <div className="calc-term-name">{t.label}</div>
                      {t.badge && <div className="calc-term-save">{t.badge}</div>}
                    </button>
                  )
                })}
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Label>Discretionary discount</Label>
                  <span style={{ fontSize: 16, fontWeight: 800, color: form.discountPct > 0 ? 'var(--color-primary)' : 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {form.discountPct}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0" max="25" step="1"
                  value={form.discountPct}
                  onChange={e => update({ discountPct: Number(e.target.value) })}
                  style={{ width: '100%', marginTop: 6, accentColor: 'var(--color-primary)' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  <span>0%</span><span>25% (max — supervisor approval beyond)</span>
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 14, padding: '10px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
                <input
                  type="checkbox"
                  checked={form.includeSetupFee}
                  onChange={e => update({ includeSetupFee: e.target.checked })}
                  style={{ accentColor: 'var(--color-primary)' }}
                />
                <span style={{ fontSize: 13, fontWeight: 500 }}>Include one-time setup & onboarding fee</span>
              </label>
            </Step>
          </div>

          {/* ────────────── RIGHT: hero summary ────────────── */}
          <aside className="calc-summary">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Hero */}
              <div className="calc-hero">
                <div className="calc-hero-label">
                  {loading && <span className="calc-pulse" />}Monthly total
                </div>
                <div className={`calc-hero-num ${loading ? 'calculating' : ''}`}>
                  {quote ? formatCurrency(quote.totalMonthly) : '—'}
                </div>
                <div className="calc-hero-sub">
                  {!quote ? 'configuring…'
                    : quote.term.startsWith('trial') ? `Free pilot · ${quote.months} months`
                    : `× ${quote.months} mo = ${formatCurrency(quote.totalTerm)}`}
                </div>

                <div className="calc-hero-row">
                  <div>
                    <div className="calc-hero-stat-lbl">ARR</div>
                    <div className="calc-hero-stat-val">{quote ? formatCurrency(quote.arr) : '—'}</div>
                  </div>
                  <div>
                    <div className="calc-hero-stat-lbl">Setup</div>
                    <div className="calc-hero-stat-val">{quote && quote.setupFee > 0 ? formatCurrency(quote.setupFee) : '—'}</div>
                  </div>
                </div>

                {quote && (
                  <div className="calc-margin">
                    <div className="calc-margin-row">
                      <span>Gross Margin</span>
                      <span className="calc-margin-pct" style={{
                        color: quote.marginPct >= 50 ? '#86efac' : quote.marginPct >= 30 ? '#fdba74' : '#fca5a5',
                      }}>{quote.marginPct}%</span>
                    </div>
                    <div className="calc-margin-bar">
                      <div className="calc-margin-fill" style={{
                        width: `${Math.min(100, Math.max(0, quote.marginPct))}%`,
                        background: quote.marginPct >= 50 ? 'linear-gradient(90deg, #4ade80, #86efac)'
                                  : quote.marginPct >= 30 ? 'linear-gradient(90deg, #fb923c, #fdba74)'
                                  : 'linear-gradient(90deg, #f87171, #fca5a5)',
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,.55)', marginTop: 6 }}>
                      Revenue {formatCurrency(quote.totalMonthly)} − COGS {formatCurrency(quote.cogsMonthly)} = <strong style={{ color: '#fff' }}>{formatCurrency(quote.grossProfitMonthly)}/mo</strong>
                    </div>
                  </div>
                )}
              </div>

              {/* Line items */}
              <div className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <span className="material-symbols-outlined">receipt_long</span>
                    Breakdown
                  </div>
                </div>
                <div className="panel-body" style={{ padding: 0 }}>
                  {error ? (
                    <div style={{ padding: 14, color: 'var(--color-danger-text)', fontSize: 12 }}>{error}</div>
                  ) : !quote || quote.lineItems.length === 0 ? (
                    <div style={{ padding: 14, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                      Configure resources to see line items
                    </div>
                  ) : (
                    <>
                      {quote.lineItems.map((li, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', fontSize: 12.5, borderBottom: i === quote.lineItems.length - 1 ? 'none' : '1px solid var(--color-border)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: 'var(--color-on-bg)' }} className="truncate">{li.name}</div>
                            <div style={{ color: 'var(--color-text-muted)', fontSize: 11, marginTop: 1 }}>
                              {li.qty.toLocaleString()} × {formatCurrency(li.unit_price)}{li.unit !== 'one_time' && ' /mo'}
                            </div>
                          </div>
                          <div className="mono" style={{ fontWeight: 700, whiteSpace: 'nowrap', marginLeft: 10 }}>
                            {formatCurrency(li.line_total)}
                          </div>
                        </div>
                      ))}
                      <div style={{ borderTop: '1px solid var(--color-border)', padding: '10px 16px', background: 'var(--color-bg)' }}>
                        <RowSm label="Subtotal" value={formatCurrency(quote.subtotalRecurring)} />
                        {quote.termMultiplier !== 1 && (
                          <RowSm label={`Term × ${quote.termMultiplier.toFixed(2)}`} value={formatCurrency(quote.subtotalRecurring * quote.termMultiplier)} />
                        )}
                        {quote.discountPct > 0 && (
                          <RowSm label={`Discount −${quote.discountPct}%`} value={`− ${formatCurrency(quote.subtotalRecurring * quote.termMultiplier * (quote.discountPct / 100))}`} negative />
                        )}
                        <RowSm label="Monthly" value={formatCurrency(quote.totalMonthly)} bold />
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Notes + Actions */}
              <div className="panel">
                <div className="panel-body" style={{ padding: 14 }}>
                  <Label>Internal notes (optional)</Label>
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="e.g. negotiated 12% discount with CFO, deploy by 1 Apr…"
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    style={{ resize: 'vertical', fontSize: 12, minHeight: 56, marginTop: 6 }}
                  />

                  {feedback && (
                    <div style={{
                      marginTop: 10, padding: '9px 12px',
                      borderRadius: 'var(--radius)',
                      background: feedback.type === 'ok' ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                      border: `1px solid ${feedback.type === 'ok' ? 'light-dark(#bbf7d0, var(--success-line))' : 'var(--danger-line)'}`,
                      color: feedback.type === 'ok' ? 'var(--color-success-text)' : 'var(--color-danger-text)',
                      fontSize: 12, display: 'flex', alignItems: 'flex-start', gap: 6,
                    }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14, marginTop: 1 }}>
                        {feedback.type === 'ok' ? 'check_circle' : 'error'}
                      </span>
                      <span style={{ flex: 1 }}>{feedback.msg}</span>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                    <button
                      className="btn btn-primary"
                      onClick={convertToLicense}
                      disabled={!!saving || !form.customerId || !quote || quote.lineItems.length === 0}
                      style={{ width: '100%' }}
                    >
                      <span className="material-symbols-outlined icon-sm">verified</span>
                      {saving === 'license' ? 'Activating…' : 'Convert to License'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={saveAsQuote}
                      disabled={!!saving || !quote || quote.lineItems.length === 0}
                      style={{ width: '100%' }}
                    >
                      <span className="material-symbols-outlined icon-sm">save</span>
                      {saving === 'quote' ? 'Saving…' : 'Save as Quote'}
                    </button>
                    {!form.customerId && (
                      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'center', margin: 0 }}>
                        Pick a customer above to activate a license
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────── Subcomponents ─────────────────── */

function Step({ num, title, meta, children }) {
  return (
    <div className="calc-card">
      <div className="calc-card-head">
        <div className="calc-step-num">{num}</div>
        <div className="calc-card-title">{title}</div>
        {meta && <div className="calc-card-meta">{meta}</div>}
      </div>
      <div className="calc-card-body">{children}</div>
    </div>
  )
}

function fmtCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return `${n}`
}

function fmtStorage(gb) {
  if (gb >= 1024 * 1024) return `${(gb / (1024 * 1024)).toFixed(gb % (1024 * 1024) === 0 ? 0 : 1)} PB`
  if (gb >= 1024)        return `${(gb / 1024).toFixed(gb % 1024 === 0 ? 0 : 1)} TB`
  return `${gb} GB`
}

function CameraTile({ label, sub, value, color, icon, onChange }) {
  return (
    <div
      className={`calc-cam-tile ${value > 0 ? 'active' : ''}`}
      style={{ color: value > 0 ? color : 'var(--color-on-bg)' }}
    >
      <div className="calc-cam-tile-head">
        <div className="calc-cam-tile-icon" style={{ background: color + (value > 0 ? '22' : '12') }}>
          <span className="material-symbols-outlined" style={{ color, fontSize: 18 }}>{icon}</span>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-bg)' }}>{label}</div>
          <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>{sub}</div>
        </div>
      </div>
      <input
        type="number"
        min="0" max={CAMERA_MAX} step="1"
        value={value}
        onChange={e => onChange(Math.max(0, Math.min(CAMERA_MAX, Number(e.target.value) || 0)))}
        placeholder="0"
        className="input"
        style={{
          width: '100%', padding: '6px 10px',
          fontSize: 26, fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-.02em',
          color: value > 0 ? color : 'var(--color-on-bg)',
          border: 'none', background: 'transparent',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {CAMERA_PRESETS.map(p => (
          <button
            key={p}
            onClick={() => onChange(p)}
            style={{
              fontSize: 10.5, fontWeight: 700,
              padding: '3px 8px',
              borderRadius: 99,
              border: `1px solid ${value === p ? color : 'var(--color-border)'}`,
              background: value === p ? color + '18' : 'var(--color-surface)',
              color: value === p ? color : 'var(--color-text-secondary)',
              cursor: 'pointer',
              transition: 'all .12s',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmtCount(p)}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
        Custom range up to {fmtCount(CAMERA_MAX)} cameras
      </div>
    </div>
  )
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{children}</div>
}

function RowSm({ label, value, bold, negative }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontWeight: bold ? 700 : 500, fontSize: bold ? 14 : 12, color: bold ? 'var(--color-on-bg)' : negative ? 'var(--color-success-text)' : 'var(--color-text-secondary)' }}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  )
}
