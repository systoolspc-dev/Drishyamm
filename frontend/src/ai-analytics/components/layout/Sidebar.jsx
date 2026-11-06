import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

const NAV_GROUPS = [
  {
    id: 'monitoring',
    type: 'flat',
    label: 'Monitoring',
    items: [
      { to: '/vms/live',       icon: 'monitor',     label: 'Live Monitoring' },
      { to: '/vms/cameras',    icon: 'videocam',    label: 'Cameras' },
      { to: '/vms/playback',   icon: 'play_circle', label: 'Playback' },
      { to: '/vms/recordings', icon: 'folder_open', label: 'Recordings' },
      { to: '/vms/evidence',   icon: 'folder_special', label: 'Evidence' },
      { to: '/vms/health',     icon: 'monitor_heart', label: 'Camera Health' },
    ],
  },
  {
    id: 'ops',
    type: 'flat',
    label: 'Command & Control',
    items: [
      { to: '/incidents', icon: 'crisis_alert', label: 'Incident Center', hasAlerts: true },
      { to: '/gis',       icon: 'map',          label: 'GIS Command Map' },
    ],
  },
  {
    id: 'ai',
    type: 'flat',
    label: 'Intelligence',
    items: [
      { to: '/ai-analytics', icon: 'smart_toy', label: 'AI Analytics', isAI: true },
    ],
  },
  {
    id: 'system',
    type: 'collapsible',
    label: 'System',
    icon: 'settings',
    items: [
      { to: '/system/personnel', icon: 'badge', label: 'Personnel' },
      { to: '/system/settings',  icon: 'tune',  label: 'Settings' },
    ],
  },
]

function CriticalDot() {
  return (
    <span style={{ position: 'relative', width: 7, height: 7, flexShrink: 0 }}>
      <span style={{ display: 'block', width: 7, height: 7, borderRadius: '50%', background: 'var(--color-danger)' }} />
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--color-danger)', animation: 'pulse-ring 1.8s ease-out infinite' }} />
    </span>
  )
}

function NavItem({ to, icon, label, showDot, isAI }) {
  const location = useLocation()
  const isAIActive = isAI && location.pathname.startsWith('/ai-analytics')

  return (
    <NavLink
      to={to}
      end={!isAI}
      style={({ isActive }) => {
        const active = isAI ? isAIActive : isActive
        return {
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '7px 10px', borderRadius: 7,
          fontSize: 13, fontWeight: 500,
          color: active ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
          background: active ? 'var(--sidebar-active-bg)' : 'transparent',
          boxShadow: active ? 'inset 0 0 0 1px var(--sidebar-border), 0 8px 22px rgba(10,31,68,.08)' : 'none',
          textDecoration: 'none', transition: 'all .12s', marginBottom: 1,
          borderLeft: active ? '2px solid var(--color-primary)' : '2px solid transparent',
        }
      }}
    >
      {({ isActive }) => {
        const active = isAI ? isAIActive : isActive
        return (
          <>
            <span
              className={`material-symbols-outlined icon-sm ${active ? 'icon-filled' : ''}`}
              style={{ color: active ? 'var(--color-primary)' : 'var(--sidebar-icon)', flexShrink: 0 }}
            >
              {icon}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {label}
            </span>
            {showDot && <CriticalDot />}
          </>
        )
      }}
    </NavLink>
  )
}

function CollapsibleGroup({ group, isOpen, onToggle, criticalCount }) {
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', background: 'none', border: 'none', cursor: 'pointer', borderRadius: 7, transition: 'background .12s' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--sidebar-hover-bg)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <span className="material-symbols-outlined icon-sm" style={{ color: 'var(--sidebar-icon)', flexShrink: 0 }}>{group.icon}</span>
        <span style={{ flex: 1, textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--sidebar-text-muted)' }}>
          {group.label}
        </span>
        {group.hasAlerts && criticalCount > 0 && <CriticalDot />}
        <span className="material-symbols-outlined" style={{ color: 'var(--sidebar-text-faint)', fontSize: 14, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .2s' }}>
          expand_more
        </span>
      </button>
      <div style={{ overflow: 'hidden', maxHeight: isOpen ? '600px' : '0', transition: 'max-height 0.22s ease', paddingLeft: 6 }}>
        {group.items.map(item => (
          <NavItem key={item.to} {...item} showDot={item.hasAlerts && criticalCount > 0} />
        ))}
      </div>
    </div>
  )
}

export default function Sidebar({ open, onClose, isMobile, criticalCount = 0 }) {
  const [expanded, setExpanded] = useState(() => {
    const init = {}
    NAV_GROUPS.forEach(g => { if (g.type === 'collapsible') init[g.id] = true })
    return init
  })

  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }))

  return (
    <>
      {open && isMobile && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
          onClick={onClose}
        />
      )}

      <aside style={{
        width: 'var(--sidebar-w)', minWidth: 'var(--sidebar-w)',
        height: 'var(--app-vh)', background: 'var(--sidebar-bg)',
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

        {/* Logo */}
        <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--sidebar-divider)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: 'linear-gradient(135deg, #0A1F44 0%, #2C2F33 56%, #C7794A 100%)', border: '1px solid var(--color-border-accent, rgba(199,121,74,.24))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 10px 26px rgba(10,31,68,.24), inset 0 1px 0 rgba(255,255,255,.16)' }}>
              <span className="material-symbols-outlined icon-filled" style={{ color: '#fff', fontSize: 17 }}>visibility</span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--sidebar-text-active)', letterSpacing: '.04em', lineHeight: 1.2 }}>DRISHYAM AI</div>
              <div style={{ fontSize: 9, color: 'var(--sidebar-text-faint)', fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', marginTop: 1 }}>Command Console</div>
            </div>
            {criticalCount > 0 && (
              <div style={{ marginLeft: 'auto', background: 'var(--color-danger)', color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 99, letterSpacing: '.04em', flexShrink: 0, boxShadow: '0 0 0 2px rgba(220,38,38,.16)' }}>
                {criticalCount}
              </div>
            )}
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          {NAV_GROUPS.map(group => {
            if (group.type === 'collapsible') {
              return (
                <CollapsibleGroup
                  key={group.id}
                  group={group}
                  isOpen={expanded[group.id]}
                  onToggle={() => toggle(group.id)}
                  criticalCount={criticalCount}
                />
              )
            }
            return (
              <div key={group.id} style={{ marginBottom: 8 }}>
                {group.label && (
                  <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--sidebar-text-faint)', padding: '8px 10px 4px' }}>
                    {group.label}
                  </p>
                )}
                {group.items.map(item => (
                  <NavItem key={item.to} {...item} showDot={item.hasAlerts && criticalCount > 0} />
                ))}
              </div>
            )
          })}
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
