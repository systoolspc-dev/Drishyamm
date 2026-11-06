import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from './services/api.js'

export default function AdminLogin() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPw, setShowPw] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await adminApi.login(email, password)
      // Platform operators only — every tenant owner is role:admin, so gate on
      // the isPlatformAdmin flag (matches the backend /api/admin/* guard).
      if (data.user?.isPlatformAdmin !== true) {
        setError('Access denied. Platform administrators only.')
        return
      }
      localStorage.setItem('admin_token', data.token)
      localStorage.setItem('admin_user', JSON.stringify(data.user))
      navigate('/admin')
    } catch (err) {
      setError(err.message || 'Invalid email or password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes adm-spin { to { transform: rotate(360deg); } }
        .adm-input {
          width: 100%;
          padding: 11px 14px 11px 40px;
          border: 1.5px solid var(--color-border);
          border-radius: 10px;
          font-size: 14px;
          font-family: inherit;
          color: var(--color-on-bg);
          background: var(--color-surface);
          outline: none;
          transition: border-color .15s, box-shadow .15s;
          box-sizing: border-box;
        }
        .adm-input:focus {
          border-color: #F7983A;
          box-shadow: 0 0 0 3px rgba(255,107,0,.12);
        }
        .adm-input::placeholder { color: var(--text-disabled); }
        .adm-login-bg { background: linear-gradient(135deg, #f0f4ff 0%, #f5f7fa 60%, #FEF3E7 100%); }
        .dark .adm-login-bg { background: linear-gradient(135deg, var(--surface-app) 0%, var(--surface-app) 60%, var(--brand-soft) 100%); }
        .adm-submit {
          width: 100%;
          padding: 12px;
          border: none;
          border-radius: 10px;
          background: #F7983A;
          color: #fff;
          font-size: 14px;
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: background .15s, box-shadow .15s, transform .1s;
          box-shadow: 0 4px 16px rgba(255,107,0,.3);
        }
        .adm-submit:hover:not(:disabled) {
          background: #e85f00;
          box-shadow: 0 6px 20px rgba(255,107,0,.4);
          transform: translateY(-1px);
        }
        .adm-submit:disabled { opacity: .75; cursor: not-allowed; }
      `}</style>

      {/* Full-screen background */}
      <div className="adm-login-bg" style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        fontFamily: "'Inter', -apple-system, sans-serif",
      }}>
        {/* Subtle background blobs */}
        <div style={{ position: 'absolute', top: '10%', right: '15%', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,107,0,.06) 0%, transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', bottom: '15%', left: '10%', width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, rgba(37,99,235,.05) 0%, transparent 70%)', pointerEvents: 'none' }} />

        {/* Card */}
        <div style={{
          width: '100%', maxWidth: 420,
          background: 'var(--color-surface)',
          borderRadius: 20,
          padding: '40px 40px 36px',
          boxShadow: '0 8px 40px rgba(11,28,48,.10), 0 2px 8px rgba(11,28,48,.06)',
          border: '1px solid light-dark(rgba(226,232,240,.8), var(--line))',
          position: 'relative', zIndex: 1,
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12,
              background: '#F7983A',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(255,107,0,.35)',
              flexShrink: 0,
            }}>
              <span className="material-symbols-outlined icon-filled" style={{ color: '#fff', fontSize: 22 }}>visibility</span>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--color-on-bg)', letterSpacing: '-.02em', lineHeight: 1.2 }}>Drishyam</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>Admin Console</div>
            </div>
          </div>

          {/* Heading */}
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-bg)', letterSpacing: '-.02em', marginBottom: 4 }}>Sign in</h1>
            <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>Enter your admin credentials to continue</p>
          </div>

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '11px 14px',
              background: 'var(--color-danger-bg)', border: '1.5px solid var(--danger-line)', borderRadius: 10,
              marginBottom: 20,
            }}>
              <span className="material-symbols-outlined icon-sm icon-filled" style={{ color: '#ef4444', flexShrink: 0 }}>error</span>
              <span style={{ fontSize: 13, color: 'var(--color-danger-text)', fontWeight: 500 }}>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Email */}
            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'light-dark(#374151, var(--text-secondary))', marginBottom: 7, letterSpacing: '.01em' }}>
                Email address
              </label>
              <div style={{ position: 'relative' }}>
                <span className="material-symbols-outlined icon-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-disabled)', pointerEvents: 'none' }}>mail</span>
                <input
                  className="adm-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@drishyam.com"
                  required
                  autoFocus
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'light-dark(#374151, var(--text-secondary))', marginBottom: 7, letterSpacing: '.01em' }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <span className="material-symbols-outlined icon-sm" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-disabled)', pointerEvents: 'none' }}>lock</span>
                <input
                  className="adm-input"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={{ paddingRight: 42 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center' }}
                  tabIndex={-1}
                >
                  <span className="material-symbols-outlined icon-sm">{showPw ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>

            {/* Submit */}
            <button className="adm-submit" type="submit" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? (
                <>
                  <div style={{ width: 15, height: 15, border: '2.5px solid rgba(255,255,255,.35)', borderTopColor: '#fff', borderRadius: '50%', animation: 'adm-spin .65s linear infinite' }} />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <span className="material-symbols-outlined icon-sm">arrow_forward</span>
                </>
              )}
            </button>
          </form>

          {/* Footer */}
          <p style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-disabled)' }}>
            Drishyam VMS · Restricted to admins only
          </p>
        </div>
      </div>
    </>
  )
}
