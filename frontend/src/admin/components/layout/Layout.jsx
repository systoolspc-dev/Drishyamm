import { useState, useEffect, createContext, useContext } from 'react'
import Sidebar from './Sidebar.jsx'
import { ActivityBell, LivePill } from '../activity/parts.jsx'

const SidebarContext = createContext()

export function useSidebar() {
  return useContext(SidebarContext)
}

export function Topbar({ title, subtitle, actions }) {
  const { setSidebarOpen } = useSidebar()
  return (
    <header style={{
      height: 'var(--topbar-h)', borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-surface)', display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 12, flexShrink: 0, position: 'sticky', top: 0, zIndex: 10,
    }}>
      <button className="btn btn-ghost" style={{ padding: '7px 8px', minWidth: 0, flexShrink: 0 }} onClick={() => setSidebarOpen(prev => !prev)}>
        <span className="material-symbols-outlined">menu</span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.025em', color: 'var(--color-on-bg)', lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</p>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {actions}
        <ActivityBell />
        <LivePill />
      </div>
    </header>
  )
}

export default function Layout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 1024)
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 1024)

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 1024
      setIsDesktop(desktop)
      setSidebarOpen(desktop)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, isDesktop }}>
      <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden', position: 'relative', background: 'var(--color-bg)' }}>
        {sidebarOpen && !isDesktop && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 25, backdropFilter: 'blur(2px)' }} onClick={() => setSidebarOpen(false)} />
        )}
        <Sidebar open={sidebarOpen} isMobile={!isDesktop} onClose={() => setSidebarOpen(false)} />
        <div className="main-content" style={{
          display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, flex: 1,
          marginLeft: isDesktop && sidebarOpen ? 'var(--sidebar-w)' : '0',
          transition: 'margin-left 0.28s cubic-bezier(0.4, 0, 0.2, 1)',
          width: isDesktop && sidebarOpen ? 'calc(100% - var(--sidebar-w))' : '100%',
        }}>
          {children}
        </div>
      </div>
    </SidebarContext.Provider>
  )
}
