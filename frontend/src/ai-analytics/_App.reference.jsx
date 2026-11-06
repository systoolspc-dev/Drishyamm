import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import Cameras from './components/System/Camera'
import Events from './components/Incidents'
import LiveMonitoring from './components/VMS/LiveMonitoring'
import Playback from './components/VMS/Playback'
import Recordings from './components/VMS/Recordings'
import CameraHealth from './components/VMS/CameraHealth'
import Evidence from './components/VMS/Evidence'
import PersonnelSearch from './components/System/PersonnelSearch'
import GISPage from './components/GIS/GISPage'
import GISIntakePage from './components/GIS/GISIntakePage'
import './App.css'

const AIAnalyticsHub = lazy(() => import('./components/AIAnalyticsHub'))
const WeaponRouter = lazy(() => import('./components/WeaponRouter'))
const AggressionRouter = lazy(() => import('./components/AggressionRouter'))
const CrowdMonitoring = lazy(() => import('./components/CrowdMonitoring'))
const FireDetectionRouter = lazy(() => import('./components/FireDetectionRouter'))
const RestrictedZone = lazy(() => import('./components/RestrictedZone'))
const FaceWatchListRouter = lazy(() => import('./components/FaceWatchListRouter'))
const ANPRRouter = lazy(() => import('./components/ANPRRouter'))

function RouteLoader() {
  return (
    <div className="route-loader">
      <span className="material-symbols-outlined icon-filled">hourglass_top</span>
      Loading workspace...
    </div>
  )
}

function ComingSoon({ module: mod, page }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: 14,
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 16,
        background: 'var(--color-surface-high)',
        border: '1px solid var(--color-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span className="material-symbols-outlined icon-lg" style={{ color: 'var(--color-text-muted)' }}>
          construction
        </span>
      </div>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-secondary)', marginBottom: 4 }}>{page}</p>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{mod} - coming soon</p>
      </div>
    </div>
  )
}

function App() {
  return (
    <Layout>
      <Suspense fallback={<RouteLoader />}>
        <Routes>
          {/* Root redirect -> VMS live monitoring as primary landing */}
          <Route path="/" element={<Navigate to="/vms/live" replace />} />

          {/* VMS Core Layer */}
          <Route path="/vms/live"       element={<LiveMonitoring />} />
          <Route path="/vms/cameras"    element={<Cameras />} />
          <Route path="/vms/playback"   element={<Playback />} />
          <Route path="/vms/recordings" element={<Recordings />} />
          <Route path="/vms/health"     element={<CameraHealth />} />
          <Route path="/vms/evidence"   element={<Evidence />} />

          {/* Command & Control */}
          <Route path="/gis"        element={<GISPage />} />
          <Route path="/gis-intake" element={<GISIntakePage />} />
          <Route path="/incidents"  element={<Events />} />

          {/* AI Analytics Layer */}
          <Route path="/ai-analytics"                      element={<AIAnalyticsHub />} />
          <Route path="/ai-analytics/weapon/*"             element={<WeaponRouter />} />
          <Route path="/ai-analytics/aggression/*"         element={<AggressionRouter />} />
          <Route path="/ai-analytics/fire/*"               element={<FireDetectionRouter />} />
          <Route path="/ai-analytics/restricted"           element={<RestrictedZone />} />
          <Route path="/ai-analytics/watchlist/*"          element={<FaceWatchListRouter />} />
          <Route path="/ai-analytics/vehicle/*"            element={<ANPRRouter />} />
          <Route path="/ai-analytics/crowd"                element={<CrowdMonitoring />} />
          <Route path="/ai-analytics/crowd/detections"     element={<CrowdMonitoring page="detections" />} />

          {/* System */}
          <Route path="/system/cameras"   element={<Cameras />} />
          <Route path="/system/personnel" element={<PersonnelSearch />} />
          <Route path="/system/settings"  element={<ComingSoon mod="System" page="Settings" />} />

          {/* Legacy aliases - keep old bookmarks working */}
          <Route path="/threat/weapon/*"         element={<Navigate to="/ai-analytics/weapon" replace />} />
          <Route path="/threat/aggression/*"     element={<Navigate to="/ai-analytics/aggression" replace />} />
          <Route path="/fire-detection/*"        element={<Navigate to="/ai-analytics/fire" replace />} />
          <Route path="/threat/restricted"       element={<Navigate to="/ai-analytics/restricted" replace />} />
          <Route path="/human/watchlist/*"       element={<Navigate to="/ai-analytics/watchlist" replace />} />
          <Route path="/vehicle/*"               element={<Navigate to="/ai-analytics/vehicle" replace />} />
          <Route path="/crowd/occupancy/*"       element={<Navigate to="/ai-analytics/crowd" replace />} />
          <Route path="/cameras"                 element={<Navigate to="/vms/cameras" replace />} />
          <Route path="/faces/*"                 element={<Navigate to="/ai-analytics/watchlist" replace />} />
          <Route path="/personnel"               element={<Navigate to="/system/personnel" replace />} />
          <Route path="/events"                  element={<Navigate to="/incidents" replace />} />
          <Route path="/weapon-detection/*"      element={<Navigate to="/ai-analytics/weapon" replace />} />
          <Route path="/aggression-detection/*"  element={<Navigate to="/ai-analytics/aggression" replace />} />
          <Route path="/crowd-monitoring"        element={<Navigate to="/ai-analytics/crowd" replace />} />
          <Route path="/anpr/*"                  element={<Navigate to="/ai-analytics/vehicle" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

export default App
