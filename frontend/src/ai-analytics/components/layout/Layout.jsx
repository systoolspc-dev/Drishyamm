import { useState, useEffect, createContext, useContext } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar.jsx'
import WorkspaceSidebar, { AI_MODULE_KEYS } from './WorkspaceSidebar.jsx'
import { useAlertStream } from '../../core/hooks/useAlertStream.js'
import ThemeToggle from '../common/ThemeToggle.jsx'

const SidebarContext = createContext()

export function useSidebar() {
  return useContext(SidebarContext)
}

export function Topbar({ title, subtitle, actions }) {
  const { setSidebarOpen, criticalCount } = useSidebar()

  return (
    <header style={{
      height: 'var(--topbar-h)',
      borderBottom: '1px solid var(--glass-border)',
      background: 'var(--glass-surface-strong)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      boxShadow: 'var(--glass-shadow)',
      display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 12,
      flexShrink: 0,
      position: 'sticky', top: 0, zIndex: 10,
    }}>
      <button
        className="btn btn-ghost"
        style={{ padding: '7px 8px', minWidth: 0, flexShrink: 0 }}
        onClick={() => setSidebarOpen(prev => !prev)}
        type="button"
        aria-label="Toggle sidebar navigation"
        title="Toggle navigation"
      >
        <span className="material-symbols-outlined">menu</span>
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{
          fontSize: 20, fontWeight: 700, letterSpacing: '-0.025em',
          color: 'var(--color-on-bg)', lineHeight: 1.25,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{
            fontSize: 'var(--type-label)', color: 'var(--color-text-secondary)', marginTop: 1,
            lineHeight: 'var(--leading-normal)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {subtitle}
          </p>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {actions}

        {criticalCount > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: 'var(--color-danger-bg)',
            borderRadius: 99,
            border: '1px solid rgba(220,38,38,.24)',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-danger)', boxShadow: '0 0 0 2px rgba(220,38,38,.18)', flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-danger-text)', fontVariantNumeric: 'tabular-nums' }}>
              {criticalCount} Critical
            </span>
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          background: 'var(--color-success-bg)',
          borderRadius: 99,
          border: '1px solid rgba(34,197,94,0.25)',
        }}>
          <span className="live-dot" />
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-success-text)' }}>Live</span>
        </div>

        <ThemeToggle />

        <button className="btn btn-ghost" style={{ padding: '7px 8px', minWidth: 0 }} type="button" aria-label="Open notifications" title="Notifications">
          <span className="material-symbols-outlined">notifications</span>
        </button>
      </div>
    </header>
  )
}

export default function Layout({ children }) {
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 1024)
  const [isDesktop, setIsDesktop]     = useState(window.innerWidth >= 1024)

  const { data: alerts } = useAlertStream({ limit: 50 })
  const criticalCount = alerts.filter(a => a.severity === 'critical').length

  useEffect(() => {
    const handleResize = () => {
      const desktop = window.innerWidth >= 1024
      setIsDesktop(desktop)
      setSidebarOpen(desktop)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Detect if we're inside a specific AI feature module (workspace mode)
  const aiModuleMatch = location.pathname.match(/^\/ai-analytics\/([^/]+)/)
  const activeModuleKey = aiModuleMatch?.[1]
  const isWorkspace = !!(activeModuleKey && AI_MODULE_KEYS.has(activeModuleKey))

  return (
    <SidebarContext.Provider value={{ sidebarOpen, setSidebarOpen, isDesktop, criticalCount }}>
      <div style={{
        display: 'flex', height: 'var(--app-vh)', width: 'var(--app-vw)',
        overflow: 'hidden', position: 'relative',
        background: 'var(--color-bg)',
      }}>
        {/* Mobile overlay â€” shared between both sidebar modes */}
        {sidebarOpen && !isDesktop && (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 25, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* â”€â”€ Workspace mode: dedicated feature sidebar â”€â”€ */}
        {isWorkspace ? (
          <WorkspaceSidebar
            moduleKey={activeModuleKey}
            open={sidebarOpen}
            isMobile={!isDesktop}
            onClose={() => setSidebarOpen(false)}
          />
        ) : (
          /* â”€â”€ Normal mode: main VMS sidebar â”€â”€ */
          <Sidebar
            open={sidebarOpen}
            isMobile={!isDesktop}
            onClose={() => setSidebarOpen(false)}
            criticalCount={criticalCount}
          />
        )}

        {/* Main content â€” same margin logic regardless of which sidebar is active */}
        <div
          className="main-content"
          style={{
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden', minWidth: 0, flex: 1,
            marginLeft: isDesktop && sidebarOpen ? 'var(--sidebar-w)' : '0',
            transition: 'margin-left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
            width: isDesktop && sidebarOpen ? 'calc(100% - var(--sidebar-w))' : '100%',
          }}
        >
          {children}
        </div>
      </div>
    </SidebarContext.Provider>
  )
}
