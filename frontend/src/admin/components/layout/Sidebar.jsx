import { NavLink, useNavigate } from 'react-router-dom'

// Sections in the order an operator works: the platform, the customers on it,
// what is running right now, the money, then console settings.
const SECTIONS = [
  { heading: null, items: [
    { to: '/admin', icon: 'home', label: 'Home', end: true },
  ] },
  { heading: 'Customers', items: [
    { to: '/admin/customers', icon: 'group', label: 'Accounts' },
  ] },
  { heading: 'Operations', items: [
    { to: '/admin/activity', icon: 'bolt',         label: 'Activity' },
    { to: '/admin/live',    icon: 'monitor_heart', label: 'Live monitor' },
    { to: '/admin/cameras', icon: 'videocam',      label: 'Cameras' },
    { to: '/admin/events',  icon: 'crisis_alert',  label: 'AI events' },
  ] },
  { heading: 'Revenue', items: [
    { to: '/admin/licenses',   icon: 'workspace_premium', label: 'Licences & renewals' },
    { to: '/admin/calculator', icon: 'calculate',         label: 'Quotes' },
    { to: '/admin/pricing',    icon: 'price_change',      label: 'Price catalog' },
  ] },
  { heading: 'Settings', items: [
    { to: '/admin/settings',  icon: 'outgoing_mail', label: 'Email / SMTP' },
    { to: '/admin/audit',     icon: 'receipt_long',  label: 'Audit log' },
    { to: '/admin/downloads', icon: 'download',      label: 'Downloads' },
  ] },
]

export default function Sidebar({ open, onClose, isMobile }) {
  const navigate = useNavigate()
  const adminUser = (() => { try { return JSON.parse(localStorage.getItem('admin_user')) } catch { return null } })()

  const handleLogout = () => {
    localStorage.removeItem('admin_token')
    localStorage.removeItem('admin_user')
    navigate('/admin/login')
  }

  return (
    <>
      {open && isMobile && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', zIndex: 20 }} onClick={onClose} />
      )}
      <aside style={{
        width: 'var(--sidebar-w)', minWidth: 'var(--sidebar-w)',
        height: 'var(--app-vh)', background: '#0b1c30',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0,
        transform: open ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.3s ease',
        zIndex: 30, overflow: 'hidden',
      }}>
        {/* Logo */}
        <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid rgba(255,255,255,.08)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-outlined icon-filled" style={{ color: '#fff', fontSize: 20 }}>visibility</span>
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', letterSpacing: '-.02em' }}>Drishyam</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)', fontWeight: 500, letterSpacing: '.05em', textTransform: 'uppercase' }}>Admin Console</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '12px 10px' }}>
          {SECTIONS.map((sec, i) => (
            <div key={sec.heading || 'home'} style={i ? { borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10, marginTop: 8 } : { marginBottom: 2 }}>
              {sec.heading && (
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,.28)', padding: '0 10px 4px' }}>{sec.heading}</p>
              )}
              {sec.items.map(item => <NavItem key={item.to} {...item} onClick={isMobile ? onClose : undefined} />)}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: '12px 14px', borderTop: '1px solid rgba(255,255,255,.08)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 50, background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
              {adminUser?.name?.slice(0, 2).toUpperCase() || 'AD'}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', lineHeight: 1.2 }} className="truncate">{adminUser?.name || 'Admin'}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)' }}>Administrator</div>
            </div>
            <button onClick={handleLogout} title="Logout" style={{ background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto', padding: 4 }}>
              <span className="material-symbols-outlined icon-sm" style={{ color: 'rgba(255,255,255,.35)' }}>logout</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

function NavItem({ to, icon, label, badge, end, onClick }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 8, fontSize: 13.5, fontWeight: 500,
        color: isActive ? '#fff' : 'rgba(255,255,255,.55)',
        background: isActive ? 'rgba(255,107,0,.2)' : 'transparent',
        textDecoration: 'none', transition: 'all .12s', marginBottom: 2,
        borderLeft: isActive ? '3px solid var(--color-primary)' : '3px solid transparent',
      })}
    >
      {({ isActive }) => (
        <>
          <span className={`material-symbols-outlined icon-sm ${isActive ? 'icon-filled' : ''}`} style={{ color: isActive ? 'var(--color-primary)' : 'rgba(255,255,255,.4)' }}>{icon}</span>
          <span style={{ flex: 1 }}>{label}</span>
          {badge && <span style={{ background: 'var(--color-primary)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99, lineHeight: 1.6 }}>{badge}</span>}
        </>
      )}
    </NavLink>
  )
}
