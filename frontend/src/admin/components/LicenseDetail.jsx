import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Topbar } from './layout/Layout.jsx'
import { Spinner, InfoRow, Modal } from './ui.jsx'
import { adminApi } from '../services/api.js'
import { formatCurrency } from '../data/index.js'

const STATUS_META = {
  draft:      { label: 'Draft',      color: 'var(--color-text-secondary)', bg: 'var(--surface-muted)' },
  trial:      { label: 'Trial',      color: '#7c3aed', bg: 'light-dark(#faf5ff, var(--ai-soft))' },
  active:     { label: 'Active',     color: '#16a34a', bg: 'var(--color-success-bg)' },
  suspended:  { label: 'Suspended',  color: '#d97706', bg: 'var(--color-warning-bg)' },
  expired:    { label: 'Expired',    color: '#dc2626', bg: 'var(--color-danger-bg)' },
  terminated: { label: 'Terminated', color: '#dc2626', bg: 'var(--color-danger-bg)' },
}

const TERM_LABELS = {
  trial_30:  'Trial 30 days',  trial_60: 'Trial 60 days',  trial_90: 'Trial 90 days',
  monthly:   'Monthly',        annual:   '1-Year',
  biennial:  '2-Year',         triennial: '3-Year',
}

const RESOURCE_META = {
  cam_hd:     { label: 'HD Cameras',       icon: 'videocam',      color: '#2563eb', unitLabel: 'cameras' },
  cam_4k:     { label: '4K Cameras',       icon: '4k',            color: '#7c3aed', unitLabel: 'cameras' },
  storage_gb: { label: 'Storage',          icon: 'database',      color: '#16a34a', unitLabel: 'GB',     formatQuota: q => q >= 1024 ? `${(q/1024).toFixed(1)} TB` : `${q} GB` },
  gpu_hour:   { label: 'GPU Inference',    icon: 'memory',        color: '#F7983A', unitLabel: 'hours/mo' },
}

const FEATURE_META = {
  feat_face_rec: { label: 'Face Recognition',    icon: 'face',           color: '#F7983A' },
  feat_behavior: { label: 'Behaviour Detection', icon: 'warning',        color: '#7c3aed' },
  feat_lpr:      { label: 'LPR / Vehicle',       icon: 'directions_car', color: '#0ea5e9' },
  feat_talkback: { label: 'Talkback Audio',      icon: 'mic',            color: '#16a34a' },
  feat_mobile:   { label: 'Mobile App',          icon: 'phone_iphone',   color: '#2563eb' },
  feat_api:      { label: 'API Access',          icon: 'api',            color: '#dc2626' },
}

export default function LicenseDetail() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [license, setLicense] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [confirm, setConfirm] = useState(null) // { status, label }
  const [acting, setActing]   = useState(false)

  const load = () => {
    setLoading(true)
    adminApi.getLicense(id)
      .then(d => setLicense(d.license))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [id])

  const changeStatus = async (newStatus) => {
    setActing(true)
    try {
      await adminApi.setLicenseStatus(id, newStatus)
      setConfirm(null)
      load()
    } catch (e) {
      alert('Failed: ' + e.message)
    }
    setActing(false)
  }

  if (loading) {
    return (
      <div className="page">
        <Topbar title="License" subtitle="Loading…" />
        <div className="page-inner"><Spinner /></div>
      </div>
    )
  }

  if (error || !license) {
    return (
      <div className="page">
        <Topbar title="License" subtitle="Not found" />
        <div className="page-inner">
          <div style={{ padding: '14px 18px', background: 'var(--color-danger-bg)', border: '1px solid var(--danger-line)', borderRadius: 'var(--radius-md)', color: 'var(--color-danger-text)' }}>
            {error || 'License not found'}
          </div>
          <button className="btn btn-ghost" onClick={() => navigate('/admin/licenses')} style={{ marginTop: 12 }}>
            <span className="material-symbols-outlined icon-sm">arrow_back</span> Back to Licenses
          </button>
        </div>
      </div>
    )
  }

  const meta = STATUS_META[license.status] || STATUS_META.draft
  const camResources = license.resources.filter(r => r.sku === 'cam_hd' || r.sku === 'cam_4k')
  const totalCamQuota = camResources.reduce((s, r) => s + r.quota, 0)
  const camsUsed = license.utilisation?.cameras?.used || 0
  const camsOnline = license.utilisation?.cameras?.online || 0
  const enabledFeatures = license.features.filter(f => f.enabled)

  return (
    <div className="page">
      <Topbar
        title={license.user?.name || 'License'}
        subtitle={license.user?.email}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => navigate('/admin/licenses')}>
              <span className="material-symbols-outlined icon-sm">arrow_back</span> Back
            </button>
            {license.status === 'active' && (
              <button className="btn btn-ghost" onClick={() => setConfirm({ status: 'suspended', label: 'Suspend' })}>
                <span className="material-symbols-outlined icon-sm">pause_circle</span> Suspend
              </button>
            )}
            {license.status === 'suspended' && (
              <button className="btn btn-primary" onClick={() => setConfirm({ status: 'active', label: 'Reactivate' })}>
                <span className="material-symbols-outlined icon-sm">play_circle</span> Reactivate
              </button>
            )}
            {(license.status === 'active' || license.status === 'suspended' || license.status === 'trial') && (
              <button className="btn btn-danger" onClick={() => setConfirm({ status: 'terminated', label: 'Terminate' })}>
                <span className="material-symbols-outlined icon-sm">cancel</span> Terminate
              </button>
            )}
          </>
        }
      />
      <div className="page-inner">
        {/* Hero strip */}
        <div className="panel" style={{ marginBottom: 18, padding: 0 }}>
          <div style={{ padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 99,
              background: meta.bg, color: meta.color,
              fontSize: 13, fontWeight: 700, letterSpacing: '.02em',
            }}>
              <span className="chip-dot" style={{ background: meta.color }} />
              {meta.label}
            </span>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', flex: 1 }}>
              <Stat label="Term"      value={TERM_LABELS[license.term] || license.term} />
              <Stat label="Starts"    value={license.startDate || '—'} mono />
              <Stat label="Ends"      value={license.endDate || '—'} mono />
              <Stat label="MRR"       value={formatCurrency(license.mrr)} bold />
              <Stat label="ARR"       value={formatCurrency(license.arr)} />
              {license.discountPct > 0 && <Stat label="Discount" value={`${license.discountPct}%`} />}
              {license.setupFee > 0 && <Stat label="Setup fee" value={formatCurrency(license.setupFee)} />}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 18 }} className="license-grid">
          {/* LEFT: Resources + Features */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Resources */}
            <div className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <span className="material-symbols-outlined">tune</span>
                  Resources & Quotas
                </div>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{license.resources.length} allocated</span>
              </div>
              <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {license.resources.length === 0 ? (
                  <div className="empty-state">
                    <span className="material-symbols-outlined">tune</span>
                    <p>No resources allocated</p>
                  </div>
                ) : license.resources.map(r => {
                  const m = RESOURCE_META[r.sku] || { label: r.sku, icon: 'category', color: '#64748b', unitLabel: '' }
                  // For cam_hd / cam_4k we don't have per-tier used; show the quota only
                  // For storage_gb we show the quota; live "used" comes from a future metering job
                  const used = r.used || 0
                  const pct = r.quota > 0 ? Math.min(100, (used / r.quota) * 100) : 0
                  const overage = used > r.quota
                  const fmtQ = m.formatQuota ? m.formatQuota(r.quota) : `${r.quota.toLocaleString()} ${m.unitLabel || ''}`
                  return (
                    <div key={r.sku} style={{ padding: 14, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                        <div style={{ width: 36, height: 36, borderRadius: 10, background: m.color + '18', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span className="material-symbols-outlined" style={{ color: m.color, fontSize: 20 }}>{m.icon}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-bg)' }}>{m.label}</div>
                          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                            quota {fmtQ} · @ {formatCurrency(r.unitPriceSnapshot)}
                          </div>
                        </div>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: overage ? '#dc2626' : 'var(--color-on-bg)' }}>
                          {used.toLocaleString()}
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 500 }}> / {r.quota.toLocaleString()}</span>
                        </div>
                      </div>
                      <div style={{ height: 8, background: 'var(--color-bg)', borderRadius: 99, overflow: 'hidden' }}>
                        <div style={{
                          width: `${pct}%`, height: '100%',
                          background: overage ? '#dc2626' : pct >= 90 ? '#dc2626' : pct >= 75 ? '#d97706' : m.color,
                          transition: 'width .3s',
                        }} />
                      </div>
                      {overage && (
                        <div style={{ fontSize: 11, color: '#dc2626', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 13 }}>warning</span>
                          Over quota — overage billing applies
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Live cameras (from Camera table, not from `used` column) */}
                {totalCamQuota > 0 && (
                  <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 6 }}>
                      Live camera utilisation
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span className="chip chip-blue"><span className="chip-dot" />{camsUsed} provisioned</span>
                      <span className="chip chip-green"><span className="chip-dot" />{camsOnline} online</span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        of {totalCamQuota} total quota
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Features */}
            <div className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <span className="material-symbols-outlined">smart_toy</span>
                  AI Features
                </div>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{enabledFeatures.length} enabled</span>
              </div>
              <div className="panel-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                {license.features.map(f => {
                  const m = FEATURE_META[f.featureKey] || { label: f.featureKey, icon: 'extension', color: '#64748b' }
                  return (
                    <div key={f.featureKey} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px',
                      border: `1px solid ${f.enabled ? m.color + '40' : 'var(--color-border)'}`,
                      borderRadius: 'var(--radius)',
                      background: f.enabled ? m.color + '08' : 'transparent',
                      opacity: f.enabled ? 1 : 0.55,
                    }}>
                      <span className="material-symbols-outlined" style={{ color: m.color, fontSize: 18 }}>{m.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</div>
                        {f.config?.cameras !== undefined && f.enabled && (
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{f.config.cameras} cameras</div>
                        )}
                      </div>
                      {f.enabled
                        ? <span className="material-symbols-outlined icon-sm icon-filled" style={{ color: '#16a34a' }}>check_circle</span>
                        : <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--color-text-muted)' }}>radio_button_unchecked</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* RIGHT: License meta + actions */}
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <span className="material-symbols-outlined">info</span>
                  License Meta
                </div>
              </div>
              <div className="panel-body">
                <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                  <InfoRow label="License ID" value={<code style={{ fontSize: 11, background: 'var(--color-bg)', padding: '2px 6px', borderRadius: 4 }}>{license.id.slice(0, 8)}…</code>} />
                  <InfoRow label="Customer"   value={license.user?.name || '—'} />
                  <InfoRow label="Email"      value={license.user?.email || '—'} />
                  <InfoRow label="Status"     value={<span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>} />
                  <InfoRow label="Term"       value={TERM_LABELS[license.term] || license.term} />
                  <InfoRow label="Currency"   value={license.currency} />
                  <InfoRow label="Created"    value={new Date(license.createdAt).toLocaleString()} />
                  <InfoRow label="Last update" value={new Date(license.updatedAt).toLocaleString()} />
                </div>
              </div>
            </div>

            {license.notes && (
              <div className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <span className="material-symbols-outlined">sticky_note_2</span>
                    Notes
                  </div>
                </div>
                <div className="panel-body" style={{ fontSize: 13, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  {license.notes}
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <span className="material-symbols-outlined">key</span>
                  License Key
                </div>
              </div>
              <div className="panel-body">
                {license.licenseKey ? (
                  <code style={{ fontSize: 11, background: '#0b1c30', color: '#fb923c', padding: '10px 12px', borderRadius: 'var(--radius)', display: 'block', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {license.licenseKey}
                  </code>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '8px 0' }}>
                    Signed license key will be generated in Phase D (runtime enforcement). For now this is a billing-record only.
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Confirm modal */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`${confirm?.label} this license?`}
        width={440}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={acting}>Cancel</button>
            <button
              className={confirm?.status === 'terminated' || confirm?.status === 'suspended' ? 'btn btn-danger' : 'btn btn-primary'}
              onClick={() => changeStatus(confirm.status)}
              disabled={acting}
            >
              {acting ? 'Working…' : confirm?.label}
            </button>
          </>
        }
      >
        {confirm && (
          <div style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
            {confirm.status === 'suspended'  && 'The customer will retain access for now but new resource allocations will be blocked once Phase D enforcement is enabled.'}
            {confirm.status === 'active'     && 'The license will return to active status. Quota enforcement resumes immediately.'}
            {confirm.status === 'terminated' && (
              <span style={{ color: 'var(--color-danger-text)' }}>
                This will permanently end the license. The customer's runtime access can no longer be restored from this screen.
              </span>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Stat({ label, value, bold, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{label}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: bold ? 18 : 14, fontWeight: bold ? 700 : 600, color: 'var(--color-on-bg)', marginTop: 2 }}>{value}</div>
    </div>
  )
}
