import { NavLink, useNavigate } from 'react-router-dom'

// â”€â”€ AI module workspace navigation config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const AI_MODULE_NAV = {
  weapon: {
    label: 'Weapon Detection',
    icon: 'report',
    color: '#dc2626',
    iconBg: '#fef2f2',
    basePath: '/ai-analytics/weapon',
    tabs: [
      { id: '',          label: 'Overview',   icon: 'dashboard' },
      { id: 'watchlist', label: 'Incident Center', icon: 'crisis_alert', badge: '12' },
      { id: 'journey/WEAP-RFL-00042', label: 'Journey Map', icon: 'route' },
      { id: 'evidence',  label: 'Evidence',   icon: 'folder_special' },
      { id: 'suspects',  label: 'Suspects',   icon: 'person_off',        badge: '47' },
    ],
  },
  aggression: {
    label: 'Aggression Detection',
    icon: 'front_hand',
    color: '#0A1F44',
    ink: 'var(--color-text)',
    iconBg: '#EAF0F6',
    basePath: '/ai-analytics/aggression',
    tabs: [
      { id: 'live',      label: 'Live Feed',       icon: 'videocam',      badge: 'LIVE', badgeGreen: true },
      { id: 'reid',      label: 'Camera Trail',    icon: 'route' },
      { id: 'timeline',  label: 'Timeline',        icon: 'timeline' },
      { id: 'incidents', label: 'Incidents',       icon: 'crisis_alert',  badge: '5' },
    ],
  },
  fire: {
    label: 'Fire Detection',
    icon: 'local_fire_department',
    color: '#ef4444',
    iconBg: '#fef2f2',
    basePath: '/ai-analytics/fire',
    tabs: [
      { id: '',       label: 'Overview',      icon: 'dashboard' },
      { id: 'live',   label: 'Live Feed',     icon: 'videocam', badge: 'LIVE', badgeGreen: true },
      { id: 'alerts', label: 'Active Alerts', icon: 'local_fire_department', badge: '10' },
      { id: 'all',    label: 'View All',      icon: 'calendar_month' },
    ],
  },
  watchlist: {
    label: 'Face Watchlist',
    icon: 'face',
    color: '#0A1F44',
    ink: 'var(--color-text)',
    iconBg: '#EAF0F6',
    basePath: '/ai-analytics/watchlist',
    tabs: [
      { id: '',             label: 'Overview',  icon: 'dashboard' },
      { id: 'watchlist',    label: 'Watchlist', icon: 'manage_accounts', badge: '5.2k' },
      { id: 'suspect',      label: 'Profile',   icon: 'person_search' },
      { id: 'reid',         label: 'REID',      icon: 'navigation',      badge: 'LIVE', badgeGreen: true },
      { id: 'behavior',     label: 'Behavior',  icon: 'psychology' },
      { id: 'relationship', label: 'Relations', icon: 'share' },
      { id: 'search',       label: 'Search',    icon: 'search' },
    ],
  },
  vehicle: {
    label: 'Vehicle Intelligence',
    icon: 'directions_car',
    color: '#0A1F44',
    ink: 'var(--color-text)',
    iconBg: '#EAF0F6',
    basePath: '/ai-analytics/vehicle',
    tabs: [
      { id: '',          label: 'Overview',  icon: 'dashboard' },
      { id: 'watchlist', label: 'Watchlist', icon: 'manage_search',  badge: '5' },
      { id: 'profile',   label: 'Profile',   icon: 'directions_car' },
      { id: 'journey',   label: 'Journey',   icon: 'route',          badge: 'LIVE', badgeGreen: true },
    ],
  },
  restricted: {
    label: 'Restricted Zone',
    icon: 'no_accounts',
    color: '#be185d',
    iconBg: '#fdf2f8',
    basePath: '/occupancy/breaches',
    tabs: [],
  },
}

export const AI_MODULE_KEYS = new Set(Object.keys(AI_MODULE_NAV))

// â”€â”€ WorkspaceSidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function WorkspaceSidebar({ moduleKey, open, onClose, isMobile }) {
  const navigate = useNavigate()
  const mod = AI_MODULE_NAV[moduleKey]

  if (!mod) return null

  return (
    <>
      {/* Mobile overlay */}
      {open && isMobile && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
          onClick={onClose}
        />
      )}

      <aside style={{
        width: 'var(--sidebar-w)', minWidth: 'var(--sidebar-w)',
        height: 'var(--app-vh)',
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        boxShadow: 'var(--glass-shadow)',
        isolation: 'isolate',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0,
        transform: open ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s ease',
        zIndex: 30, overflow: 'hidden',
      }}>

        {/* Brand header */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--sidebar-divider)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg, #0A1F44 0%, #2C2F33 56%, #C7794A 100%)', border: '1px solid var(--color-border-accent, rgba(199,121,74,.24))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 10px 26px rgba(10,31,68,.24), inset 0 1px 0 rgba(255,255,255,.16)' }}>
              <span className="material-symbols-outlined icon-filled" style={{ color: '#fff', fontSize: 17 }}>visibility</span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--sidebar-text-active)', letterSpacing: '.04em', lineHeight: 1.2 }}>DRISHYAM AI</div>
              <div style={{ fontSize: 9, color: 'var(--sidebar-text-faint)', fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', marginTop: 1 }}>Command Console</div>
            </div>
          </div>
        </div>

        {/* â† Back to AI Analytics */}
        <div style={{ padding: '10px 8px 0', flexShrink: 0 }}>
          <button
            onClick={() => navigate('/ai-analytics')}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', padding: '8px 10px',
              background: 'none', border: 'none', cursor: 'pointer',
              borderRadius: 7, transition: 'background .12s',
              fontSize: 12, fontWeight: 600,
              color: 'var(--sidebar-text-muted)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--sidebar-hover-bg)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--sidebar-icon)' }}>arrow_back</span>
            AI Analytics
          </button>
        </div>

        {/* Module identity block */}
        <div style={{
          margin: '8px 8px 0',
          padding: '10px 12px',
          borderRadius: 10,
          background: `${mod.color}12`,
          border: `1px solid ${mod.color}25`,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: mod.iconBg, border: `1px solid ${mod.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-outlined icon-filled" style={{ fontSize: 16, color: mod.ink || mod.color }}>{mod.icon}</span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: mod.ink || mod.color, lineHeight: 1.2 }}>
                {mod.label}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <span style={{ width: 5, height: 5, borderRadius: 99, background: '#22c55e', display: 'inline-block' }} />
                <span style={{ fontSize: 9, fontWeight: 600, color: '#16a34a', letterSpacing: '.04em' }}>WORKSPACE ACTIVE</span>
              </div>
            </div>
          </div>
        </div>

        {/* Workspace navigation */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '12px 8px 10px' }}>
          <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--sidebar-text-faint)', padding: '4px 10px 6px' }}>
            Workspace
          </p>

          {mod.tabs.map(tab => (
            <NavLink
              key={tab.id || 'overview'}
              to={tab.id ? `${mod.basePath}/${tab.id}` : mod.basePath}
              end={!tab.id}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '7px 10px', borderRadius: 7,
                fontSize: 13, fontWeight: 500,
                color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
                background: isActive ? 'var(--sidebar-active-bg)' : 'transparent',
                boxShadow: isActive ? 'inset 0 0 0 1px var(--sidebar-border), 0 8px 22px rgba(10,31,68,.10)' : 'none',
                textDecoration: 'none', transition: 'all .12s', marginBottom: 1,
                borderLeft: isActive ? `2px solid ${mod.color}` : '2px solid transparent',
              })}
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`material-symbols-outlined icon-sm ${isActive ? 'icon-filled' : ''}`}
                    style={{ color: isActive ? (mod.ink || mod.color) : 'var(--sidebar-icon)', flexShrink: 0 }}
                  >
                    {tab.icon}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tab.label}
                  </span>
                  {tab.badge && (
                    <span style={{
                      fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 99,
                      background: tab.badgeGreen ? 'var(--color-success-bg)' : 'var(--status-neutral-bg)',
                      color: tab.badgeGreen ? 'var(--color-success-text)' : 'var(--status-neutral-text)',
                      border: `1px solid ${tab.badgeGreen ? 'rgba(22,163,74,.18)' : 'var(--status-neutral-border)'}`,
                    }}>
                      {tab.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          ))}

          {mod.tabs.length === 0 && (
            <p style={{ fontSize: 11, color: 'var(--sidebar-text-muted)', padding: '4px 10px 8px', fontStyle: 'italic' }}>
              Navigate using page tabs
            </p>
          )}
        </nav>

        {/* User footer */}
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--sidebar-divider)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>SA</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--sidebar-text-active)', lineHeight: 1.2 }}>Sahil A.</div>
              <div style={{ fontSize: 10, color: 'var(--sidebar-text)' }}>Superadmin</div>
            </div>
            <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--sidebar-icon)', marginLeft: 'auto', cursor: 'pointer' }}>more_vert</span>
          </div>
        </div>
      </aside>
    </>
  )
}
