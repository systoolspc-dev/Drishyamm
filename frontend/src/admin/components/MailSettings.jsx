import { useEffect, useState } from 'react'
import { adminApi } from '../services/api.js'
import { Topbar } from './layout/Layout.jsx'

const PROVIDERS = [
  { id: 'webmail', label: 'Webmail (cPanel)', icon: 'dns',   hint: 'drishyam.io mail server' },
  { id: 'gmail',   label: 'Gmail',            icon: 'mail',  hint: 'smtp.gmail.com · app password' },
  { id: 'custom',  label: 'Custom SMTP',      icon: 'tune',  hint: 'SendGrid, Zoho, any host' },
]

const inputStyle = {
  width: '100%', padding: '10px 12px', border: '1.5px solid var(--color-border)', borderRadius: 9,
  fontSize: 14, fontFamily: 'inherit', color: 'var(--color-on-bg)', background: 'var(--color-surface)', outline: 'none', boxSizing: 'border-box',
}
const labelStyle = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'light-dark(#374151, var(--text-secondary))', marginBottom: 6 }

export default function MailSettings() {
  const [cfg, setCfg] = useState({
    provider: 'webmail', host: '', port: 465, secure: true,
    username: '', password: '', fromName: 'Drishyam Alerts', fromEmail: '', enabled: true,
  })
  const [presets, setPresets] = useState({})
  const [hasPassword, setHasPassword] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [msg, setMsg] = useState(null) // { kind:'ok'|'err', text }

  const flash = (kind, text) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 5000) }

  useEffect(() => {
    (async () => {
      try {
        const { config, presets } = await adminApi.getMailConfig()
        setPresets(presets || {})
        setHasPassword(!!config.hasPassword)
        setCfg((c) => ({ ...c, ...config, password: '' }))
      } catch (e) { flash('err', e.message) }
      finally { setLoading(false) }
    })()
  }, [])

  const pickProvider = (id) => {
    const p = presets[id]
    setCfg((c) => ({ ...c, provider: id, ...(p ? { host: p.host, port: p.port, secure: p.secure } : {}) }))
  }

  const save = async () => {
    setSaving(true)
    try {
      const body = { ...cfg }
      if (!body.password) delete body.password // keep existing
      const { config } = await adminApi.saveMailConfig(body)
      setHasPassword(!!config.hasPassword)
      setCfg((c) => ({ ...c, ...config, password: '' }))
      flash('ok', 'Email settings saved.')
    } catch (e) { flash('err', e.message) }
    finally { setSaving(false) }
  }

  const sendTest = async () => {
    if (!testTo.trim()) { flash('err', 'Enter an address to send the test to.'); return }
    setTesting(true)
    try {
      const r = await adminApi.testMailConfig(testTo.trim())
      flash('ok', r.message || 'Test sent.')
    } catch (e) { flash('err', e.message) }
    finally { setTesting(false) }
  }

  const header = <Topbar title="Email / SMTP" subtitle="The account alerts are sent from. Users add their own recipients in the app." />
  if (loading) return <div className="page">{header}<div className="page-inner" style={{ color: 'var(--color-text-secondary)' }}>Loading…</div></div>

  return (
    <div className="page">
    {header}
    <div className="page-inner" style={{ maxWidth: 820 }}>

      {msg && (
        <div style={{
          margin: '16px 0', padding: '11px 14px', borderRadius: 10, fontSize: 13.5, fontWeight: 500,
          background: msg.kind === 'ok' ? 'var(--success-soft)' : 'var(--color-danger-bg)',
          border: `1.5px solid ${msg.kind === 'ok' ? 'var(--success-line)' : 'var(--danger-line)'}`,
          color: msg.kind === 'ok' ? 'var(--success-ink)' : 'var(--color-danger-text)',
        }}>{msg.text}</div>
      )}

      {/* provider */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid light-dark(#e8edf3, var(--line))', borderRadius: 14, padding: 20, marginTop: 16 }}>
        <p style={{ ...labelStyle, marginBottom: 10 }}>Mail provider</p>
        <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 20 }}>
          {PROVIDERS.map((p) => {
            const active = cfg.provider === p.id
            return (
              <button key={p.id} type="button" onClick={() => pickProvider(p.id)} style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 11, cursor: 'pointer',
                border: `1.5px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                background: active ? 'rgba(255,107,0,.06)' : 'var(--color-surface)', transition: 'all .12s',
              }}>
                <span className="material-symbols-outlined icon-sm" style={{ color: active ? 'var(--color-primary)' : 'var(--color-text-muted)' }}>{p.icon}</span>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-on-bg)', marginTop: 4 }}>{p.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{p.hint}</div>
              </button>
            )
          })}
        </div>

        {/* fields */}
        <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
          <div>
            <label style={labelStyle}>SMTP host</label>
            <input style={inputStyle} value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} placeholder="smtp.example.com" />
          </div>
          <div>
            <label style={labelStyle}>Port</label>
            <input style={inputStyle} type="number" value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
          </div>
        </div>

        <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
          <div>
            <label style={labelStyle}>Username (full email)</label>
            <input style={inputStyle} value={cfg.username} onChange={(e) => setCfg({ ...cfg, username: e.target.value })} placeholder="alerts@drishyam.io" autoComplete="off" />
          </div>
          <div>
            <label style={labelStyle}>Password {hasPassword && <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>· saved</span>}</label>
            <input style={inputStyle} type="password" value={cfg.password} onChange={(e) => setCfg({ ...cfg, password: e.target.value })} placeholder={hasPassword ? '•••••••• (unchanged)' : 'SMTP / app password'} autoComplete="new-password" />
          </div>
        </div>

        <div className="stack-sm" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
          <div>
            <label style={labelStyle}>From name</label>
            <input style={inputStyle} value={cfg.fromName} onChange={(e) => setCfg({ ...cfg, fromName: e.target.value })} placeholder="Drishyam Alerts" />
          </div>
          <div>
            <label style={labelStyle}>From email</label>
            <input style={inputStyle} value={cfg.fromEmail} onChange={(e) => setCfg({ ...cfg, fromEmail: e.target.value })} placeholder="alerts@drishyam.io" />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 18 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, color: 'light-dark(#374151, var(--text-secondary))', cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.secure} onChange={(e) => setCfg({ ...cfg, secure: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }} />
            SSL/TLS (port 465)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, color: 'light-dark(#374151, var(--text-secondary))', cursor: 'pointer' }}>
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }} />
            Enabled (use for outbound mail)
          </label>
        </div>

        <div style={{ marginTop: 20 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving} style={{ fontWeight: 700 }}>
            <span className="material-symbols-outlined icon-sm">save</span>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      {/* test */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid light-dark(#e8edf3, var(--line))', borderRadius: 14, padding: 20, marginTop: 16 }}>
        <p style={{ ...labelStyle, marginBottom: 8 }}>Send a test email</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" type="email" />
          <button className="btn btn-ghost" onClick={sendTest} disabled={testing} style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>
            <span className="material-symbols-outlined icon-sm">send</span>
            {testing ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>Save settings first. The test uses the saved config, so a wrong host/password fails here before real alerts do.</p>
      </div>
    </div>
    </div>
  )
}
