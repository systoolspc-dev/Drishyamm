import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import Sidebar from '@/core/layout/Sidebar';
import { Sheet, SheetContent, SheetTitle } from '@/core/ui/sheet';
import { useMediaQuery, BELOW_LG, BELOW_XL } from '@/core/hooks/useMediaQuery';
import Topbar from '@/core/layout/Topbar';
import ProtectedRoute from '@/core/layout/ProtectedRoute';
import AIToastHost from '@/core/layout/AIToastHost';
import ErrorBoundary from '@/core/layout/ErrorBoundary';

const AdminApp       = lazy(() => import('@/admin/AdminApp'));
// The AI-analytics design system (446 KB of CSS) lives behind this lazy boundary
// so it is fetched only on /ai-analytics/* routes. Importing the stylesheets here
// in the entry module would hoist them into the global CSS and block first paint
// on every route, /login included. See src/ai-analytics/AnalyticsScope.jsx.
const AnalyticsScope = lazy(() => import('@/ai-analytics/AnalyticsScope'));
const Login          = lazy(() => import('@/core/pages/Login'));
const Register       = lazy(() => import('@/core/pages/Register'));
const ForgotPassword = lazy(() => import('@/core/pages/ForgotPassword'));
const ResetPassword  = lazy(() => import('@/core/pages/ResetPassword'));
const Home           = lazy(() => import('@/core/pages/Home'));
const Dashboard      = lazy(() => import('@/core/pages/Dashboard'));
const LiveView       = lazy(() => import('@/core/pages/LiveView'));
const MonitorWallHome = lazy(() => import('@/core/pages/MonitorWallHome'));
const MonitorWallLive = lazy(() => import('@/core/pages/MonitorWallLive'));
const Map            = lazy(() => import('@/core/pages/Map'));
const Playback       = lazy(() => import('@/core/pages/Playback'));
const CameraSetup    = lazy(() => import('@/core/pages/CameraSetup'));
const Settings       = lazy(() => import('@/core/pages/Settings'));
const Help           = lazy(() => import('@/core/pages/Help'));
const Alerts         = lazy(() => import('@/modules/alerts/Alerts'));
const Watchlist      = lazy(() => import('@/modules/face/Watchlist'));
const CameraHealth   = lazy(() => import('@/core/pages/CameraHealth'));
const PersonnelSearch = lazy(() => import('@/modules/face/PersonnelSearch'));
const JourneyMap      = lazy(() => import('@/modules/person-tracking/JourneyMap'));
const AiFeed          = lazy(() => import('@/modules/ai-feed/AiFeed'));
const AttendanceReport = lazy(() => import('@/modules/employee-productivity/AttendanceReport'));
const ActivityDashboard = lazy(() => import('@/modules/employee-productivity/dashboard/ActivityDashboard'));
const CampusLiveActivity = lazy(() => import('@/modules/employee-productivity/campus/LiveActivityIntelligence'));
const CampusStudentActivity = lazy(() => import('@/modules/employee-productivity/campus/StudentActivity'));
const CampusFacultyActivity = lazy(() => import('@/modules/employee-productivity/campus/FacultyActivity'));
const CampusGroupActivity = lazy(() => import('@/modules/employee-productivity/campus/GroupActivity'));
const CampusRoomAnalytics = lazy(() => import('@/modules/employee-productivity/campus/RoomAnalytics'));
const CampusAttendanceIntelligence = lazy(() => import('@/modules/employee-productivity/campus/AttendanceIntelligence'));
const CampusProductivityAnalytics = lazy(() => import('@/modules/employee-productivity/campus/ProductivityAnalytics'));
const CampusReports = lazy(() => import('@/modules/employee-productivity/campus/Reports'));
const CampusRulesPolicies = lazy(() => import('@/modules/employee-productivity/campus/RulesPolicies'));
const CampusActiveActivities = lazy(() => import('@/modules/employee-productivity/campus/ActiveActivities'));
const SchoolAttendance   = lazy(() => import('@/modules/employee-productivity/school/AttendanceIntelligence'));
const SchoolSafety       = lazy(() => import('@/modules/employee-productivity/school/SafetySecurity'));
const SchoolTransport    = lazy(() => import('@/modules/employee-productivity/school/Transport'));
const SchoolDismissal    = lazy(() => import('@/modules/employee-productivity/school/Dismissal'));
const SchoolVisitors     = lazy(() => import('@/modules/employee-productivity/school/VisitorManagement'));
const SchoolStudent      = lazy(() => import('@/modules/employee-productivity/school/StudentActivity'));
const SchoolRooms        = lazy(() => import('@/modules/employee-productivity/school/ClassRoomAnalytics'));
const SchoolReports      = lazy(() => import('@/modules/employee-productivity/school/Reports'));
const SchoolRules        = lazy(() => import('@/modules/employee-productivity/school/RulesPolicies'));
const SchoolGuardians    = lazy(() => import('@/modules/employee-productivity/school/GuardianRegistry'));
// Cross-vertical: one zone-headcount page driven entirely by params.headcount
const ZoneHeadcount      = lazy(() => import('@/modules/employee-productivity/headcount/Headcount'));
const HostelMovement     = lazy(() => import('@/modules/employee-productivity/hostel/Movement'));
const HostelDining       = lazy(() => import('@/modules/employee-productivity/hostel/Dining'));
const HostelHousekeeping = lazy(() => import('@/modules/employee-productivity/hostel/Housekeeping'));
const HostelMaintenance  = lazy(() => import('@/modules/employee-productivity/hostel/Maintenance'));
const HostelSecurity     = lazy(() => import('@/modules/employee-productivity/hostel/Security'));
const HostelSafety       = lazy(() => import('@/modules/employee-productivity/hostel/Safety'));
const HostelStaff        = lazy(() => import('@/modules/employee-productivity/hostel/Staff'));
const HostelStaffDetail  = lazy(() => import('@/modules/employee-productivity/hostel/StaffDetail'));
const HostelProductivity = lazy(() => import('@/modules/employee-productivity/hostel/Productivity'));
const HostelAlerts       = lazy(() => import('@/modules/employee-productivity/hostel/Alerts'));
const HostelReports      = lazy(() => import('@/modules/employee-productivity/hostel/Reports'));
const HospGuestService   = lazy(() => import('@/modules/employee-productivity/hospitality/GuestService'));
const HospDeskDetail     = lazy(() => import('@/modules/employee-productivity/hospitality/DeskDetail'));
const HospHousekeeping   = lazy(() => import('@/modules/employee-productivity/hospitality/Housekeeping'));
const HospMovement       = lazy(() => import('@/modules/employee-productivity/hospitality/Movement'));
const HospSafety         = lazy(() => import('@/modules/employee-productivity/hospitality/Safety'));
const HospStaff          = lazy(() => import('@/modules/employee-productivity/hospitality/Staff'));
const HospStaffDetail    = lazy(() => import('@/modules/employee-productivity/hospitality/StaffDetail'));
const HospProductivity   = lazy(() => import('@/modules/employee-productivity/hospitality/Productivity'));
const HospReports        = lazy(() => import('@/modules/employee-productivity/hospitality/Reports'));
const BankTeller         = lazy(() => import('@/modules/employee-productivity/bank/Teller'));
const BankCashOps        = lazy(() => import('@/modules/employee-productivity/bank/CashOps'));
const BankProductivity   = lazy(() => import('@/modules/employee-productivity/bank/Productivity'));
const BankMovement       = lazy(() => import('@/modules/employee-productivity/bank/Movement'));
const BankSecurity       = lazy(() => import('@/modules/employee-productivity/bank/Security'));
const BankFacility       = lazy(() => import('@/modules/employee-productivity/bank/Facility'));
const BankStaffRoster    = lazy(() => import('@/modules/employee-productivity/bank/StaffRoster'));
const BankStaffDetail    = lazy(() => import('@/modules/employee-productivity/bank/StaffDetail'));
const BankAlerts         = lazy(() => import('@/modules/employee-productivity/bank/Alerts'));
const BankReports        = lazy(() => import('@/modules/employee-productivity/bank/Reports'));
const EmployeeDetail    = lazy(() => import('@/modules/employee-productivity/EmployeeDetail'));
const ActivityLog       = lazy(() => import('@/modules/employee-productivity/ActivityLog'));
const ActivityZoneSetup = lazy(() => import('@/modules/employee-productivity/ZoneSetup'));
const ZoneCoverage      = lazy(() => import('@/modules/employee-productivity/ZoneCoverage'));
const ProductivityReports = lazy(() => import('@/modules/employee-productivity/Reports'));
const StaffPerformance  = lazy(() => import('@/modules/employee-productivity/Performance'));
const StoreOfficeRules  = lazy(() => import('@/modules/employee-productivity/RulesPolicies'));
const EventLog        = lazy(() => import('@/modules/event-log/EventLog'));
const ActivityAnalytics = lazy(() => import('@/modules/employee-productivity/analytics/AnalyticsPage'));
const LiveTracker     = lazy(() => import('@/modules/person-tracking/LiveTracker'));
const FaceLearning    = lazy(() => import('@/modules/face/FaceLearning'));
const HeadCount       = lazy(() => import('@/modules/headcount/HeadCount'));
// Footfall & Occupancy: footfall line crossings, live zone headcount and
// congestion on one page, with the hourly RECORD of all three as its own
// route beside it -- the live wall and the history are read at different
// times by different people, so they are not two tabs of one screen.
const Occupancy = lazy(() => import('@/modules/occupancy/Occupancy'));
const UsageTrends = lazy(() => import('@/modules/occupancy/UsageTrends'));
const ZoneSetup = lazy(() => import('@/modules/occupancy/zone-setup/ZoneSetup'));
const ZoneBreaches = lazy(() => import('@/modules/occupancy/breaches/ZoneBreaches'));
const Reports         = lazy(() => import('@/modules/reports/ReportsHub'));
const ReportView      = lazy(() => import('@/modules/reports/ReportView'));
const PersonTracker   = lazy(() => import('@/modules/person-tracking/PersonTracker'));
const FeatureDemos    = lazy(() => import('@/core/pages/FeatureDemos'));
const ComputeCost     = lazy(() => import('@/core/pages/ComputeCost'));
// Pricing page parked for now — file kept, just not routed.
// const Pricing         = lazy(() => import('@/core/pages/Pricing'));

// AI Analytics modules — each router handles its own sub-routes
const ANPRRouter          = lazy(() => import('@/ai-analytics/components/ANPRRouter'));
const VehicleHub          = lazy(() => import('@/modules/vehicle/VehicleHub'));
const WeaponRouter        = lazy(() => import('@/ai-analytics/components/WeaponRouter'));
const AggressionRouter    = lazy(() => import('@/ai-analytics/components/AggressionRouter'));
const FireDetectionRouter = lazy(() => import('@/ai-analytics/components/FireDetectionRouter'));
const FaceWatchListRouter = lazy(() => import('@/ai-analytics/components/FaceWatchListRouter'));
const Productivity        = lazy(() => import('@/ai-analytics/components/Productivity/index'));

// Only ever written by an explicit toggle, so the automatic collapse that
// happens on narrow screens cannot overwrite what the user chose on desktop.
const SIDEBAR_PREF_KEY = 'sidebar-open';
function readSidebarPref() {
  try { return localStorage.getItem(SIDEBAR_PREF_KEY) !== 'false'; } catch { return true; }
}

// Shell: one viewport-high flex row, [rail | column], nothing scrolls but
// <main>. The rail is IN the flow (not position: fixed), so the content column
// is simply `flex-1` of whatever it leaves — there is no margin to keep in sync
// with the rail's width, and collapsing it hands the space straight to the
// page with no dead strip. The Topbar sits above <main> in the column, so it
// never scrolls and pages measure their height as `100vh - var(--topbar-h)`.
//
// The nav has two shapes, and width decides which one is on screen:
//
//   ≥ 1024  an in-flow rail. The Topbar toggle (and Ctrl/Cmd+B) switches it
//           between 256px with labels and a 64px icon-only rail, and that
//           choice is remembered.
//   < 1024  the rail leaves the flow entirely and becomes an overlay drawer,
//           so content gets the whole viewport. The same toggle opens it.
//
// Crossing below 1280 collapses the rail once, because pages in that band are
// already fighting for width — Face Watchlist wants 1284px for two columns.
// It is a nudge, not a lock: the toggle still works there, and because the
// auto-collapse is never written to storage, the desktop preference survives
// a trip through a narrow window.
function AppLayout({ children, sidebarOpen, onToggleSidebar, onSetSidebar }) {
  const belowLg = useMediaQuery(BELOW_LG);
  const belowXl = useMediaQuery(BELOW_XL);
  const [navOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();

  // Navigating inside the drawer should dismiss it — otherwise the page the
  // user just chose is hidden behind the panel that chose it.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // Fires only when the breakpoint is actually crossed, so it never fights a
  // manual toggle made while inside the band.
  const wasBelowXl = useRef(belowXl);
  useEffect(() => {
    if (belowXl === wasBelowXl.current) return;
    wasBelowXl.current = belowXl;
    onSetSidebar(belowXl ? false : readSidebarPref());
  }, [belowXl, onSetSidebar]);

  const toggle = useCallback(() => {
    if (belowLg) setNavOpen((v) => !v);
    else onToggleSidebar();
  }, [belowLg, onToggleSidebar]);

  // Ctrl/Cmd+B, the same shortcut editors use for this. Ignored while typing,
  // so it cannot hijack the shortcut inside a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (String(e.key).toLowerCase() !== 'b') return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <div data-app-shell="" className="flex h-[var(--app-dvh)] w-full overflow-hidden bg-background">
      <Sidebar open={sidebarOpen} />

      {/* Mobile nav. Radix owns the focus trap, Escape handling and scroll
          lock; we only supply the frame and the same <Sidebar> the rail uses,
          so there is exactly one nav definition in the app. */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="border-sidebar-border p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar open variant="sheet" onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <div data-app-content="" className="flex min-w-0 flex-1 flex-col">
        <Topbar
          navMode={belowLg ? 'drawer' : 'rail'}
          onToggleNav={toggle}
          sidebarOpen={belowLg ? navOpen : sidebarOpen}
        />
        {/* The app's one scroll container. `min-w-0` lets wide page content
            (tables, grids) scroll inside it instead of widening the column. */}
        <main data-app-main="" className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-96">
                <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            }
          >
            {children}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

// /analytics/:tab → /activity-monitoring/analytics/:tab. A component rather
// than a <Navigate to>, because `to` is a literal and cannot interpolate the
// matched param — and dropping the tab would send every old Staff/Traffic
// bookmark to Today's Trends instead.
function LegacyAnalyticsRedirect() {
  const { tab } = useParams();
  return <Navigate to={`/activity-monitoring/analytics/${tab}`} replace />;
}

export default function App() {
  // Lives here rather than in AppLayout: every route renders its own AppLayout
  // element, so state held there would reset on each navigation.
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarPref);

  // A deliberate toggle is remembered; the width-driven collapse is not.
  const handleToggle = useCallback(() => {
    setSidebarOpen((v) => {
      const next = !v;
      try { localStorage.setItem(SIDEBAR_PREF_KEY, String(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const wrap = (page) => (
    <AppLayout
      sidebarOpen={sidebarOpen}
      onToggleSidebar={handleToggle}
      onSetSidebar={setSidebarOpen}
    >
      {page}
    </AppLayout>
  );

  // AI-analytics pages render inside the host chrome but need their own scoped
  // design system (.ai-analytics-scope supplies the --color-* tokens + classes).
  // AnalyticsScope renders that same wrapper div and carries the stylesheets with
  // it, so the CSS arrives with the scope rather than on every route. It sits
  // inside wrap()'s Suspense, so the boundary holds the fallback until the CSS
  // link has loaded — the div never mounts ahead of its styles.
  const ai = (page) => wrap(<AnalyticsScope>{page}</AnalyticsScope>);

  return (
    <>
      {/* Global toast layer for high-severity AI events — stays mounted across routes */}
      <AIToastHost />

    <ErrorBoundary>
    <Routes>
      {/* Admin dashboard — fully self-contained, own layout + auth */}
      <Route path="/admin/*" element={<Suspense fallback={null}><AdminApp /></Suspense>} />

      {/* Public */}
      <Route path="/login"           element={<Suspense fallback={null}><Login /></Suspense>} />
      <Route path="/register"        element={<Suspense fallback={null}><Register /></Suspense>} />
      <Route path="/forgot-password" element={<Suspense fallback={null}><ForgotPassword /></Suspense>} />
      <Route path="/reset-password"  element={<Suspense fallback={null}><ResetPassword /></Suspense>} />

      {/* Redirect root */}
      <Route path="/" element={<Navigate to="/home" replace />} />

      {/* Protected */}
      <Route path="/home"      element={<ProtectedRoute>{wrap(<Home />)}</ProtectedRoute>} />
      <Route path="/camera-setup" element={<ProtectedRoute>{wrap(<CameraSetup />)}</ProtectedRoute>} />
      <Route path="/cameras"   element={<ProtectedRoute><Navigate to="/camera-setup?tab=cameras" replace /></ProtectedRoute>} />
      <Route path="/devices"   element={<ProtectedRoute><Navigate to="/camera-setup?tab=devices" replace /></ProtectedRoute>} />
      <Route path="/timelapse" element={<ProtectedRoute><Navigate to="/playback?tab=timelapse" replace /></ProtectedRoute>} />
      <Route path="/gallery"   element={<ProtectedRoute><Navigate to="/playback?tab=recordings" replace /></ProtectedRoute>} />
      <Route path="/live"      element={<ProtectedRoute>{wrap(<LiveView />)}</ProtectedRoute>} />
      {/* Legacy alias — renders the same auto WebRTC→HLS live view. */}
      <Route path="/live-hls"  element={<ProtectedRoute>{wrap(<LiveView />)}</ProtectedRoute>} />
      {/* Monitor Wall — the wall inside the app chrome (its layout builder
          opens in a dialog on the same page); /live is the same wall full
          screen with no sidebar or top bar. */}
      <Route path="/monitor-wall" element={<ProtectedRoute>{wrap(<MonitorWallHome />)}</ProtectedRoute>} />
      <Route path="/monitor-wall/live" element={
        <ProtectedRoute>
          <Suspense fallback={
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
            </div>
          }>
            <MonitorWallLive />
          </Suspense>
        </ProtectedRoute>
      } />
      <Route path="/timeline"  element={<ProtectedRoute><Navigate to="/playback" replace /></ProtectedRoute>} />
      <Route path="/map"       element={<ProtectedRoute>{wrap(<Map />)}</ProtectedRoute>} />
      <Route path="/dashboard" element={<ProtectedRoute>{wrap(<Dashboard />)}</ProtectedRoute>} />
      <Route path="/playback"  element={<ProtectedRoute>{wrap(<Playback />)}</ProtectedRoute>} />
      <Route path="/settings"  element={<ProtectedRoute>{wrap(<Settings />)}</ProtectedRoute>} />
      <Route path="/help"      element={<ProtectedRoute>{wrap(<Help />)}</ProtectedRoute>} />
      {/* Pricing page parked for now
      <Route path="/pricing"   element={<ProtectedRoute>{wrap(<Pricing />)}</ProtectedRoute>} />
      */}
      <Route path="/alerts"    element={<ProtectedRoute>{wrap(<Alerts />)}</ProtectedRoute>} />
      <Route path="/watchlist" element={<ProtectedRoute>{wrap(<Watchlist />)}</ProtectedRoute>} />
      <Route path="/face-learning" element={<ProtectedRoute>{wrap(<FaceLearning />)}</ProtectedRoute>} />
      <Route path="/ai-event"  element={<ProtectedRoute><Navigate to="/ai-event/personlsearch" replace /></ProtectedRoute>} />
      <Route path="/ai-event/personlsearch" element={<ProtectedRoute>{wrap(<PersonnelSearch />)}</ProtectedRoute>} />
      <Route path="/ai-event/cameramapping" element={<Navigate to="/occupancy/zone-setup" replace />} />
      <Route path="/ai-event/journeymap" element={<ProtectedRoute>{wrap(<JourneyMap />)}</ProtectedRoute>} />
      <Route path="/ai-event/headcount"  element={<ProtectedRoute>{wrap(<HeadCount />)}</ProtectedRoute>} />
      <Route path="/occupancy" element={<ProtectedRoute>{wrap(<Occupancy />)}</ProtectedRoute>} />
      {/* Past head-count records. It was ?tab=usage-trends on the page above;
          Occupancy redirects that slug (and the older ?tab=analytics) here. */}
      <Route path="/occupancy/usage-trends" element={<ProtectedRoute>{wrap(<UsageTrends />)}</ProtectedRoute>} />
      <Route path="/occupancy/zone-setup" element={<ProtectedRoute>{wrap(<ZoneSetup />)}</ProtectedRoute>} />
      <Route path="/occupancy/breaches"   element={<ProtectedRoute>{wrap(<ZoneBreaches />)}</ProtectedRoute>} />
      {/* Zone configuration has moved twice -- its own route, then a tab, now
          its own route again. Both old addresses still land. */}
      <Route path="/occupancy/settings" element={<ProtectedRoute><Navigate to="/occupancy/zone-setup" replace /></ProtectedRoute>} />
      <Route path="/reports"             element={<ProtectedRoute>{wrap(<Reports />)}</ProtectedRoute>} />
      {/* A live preview (no id) and a saved report share one view — same document. */}
      <Route path="/reports/view"        element={<ProtectedRoute>{wrap(<ReportView />)}</ProtectedRoute>} />
      <Route path="/reports/:id"         element={<ProtectedRoute>{wrap(<ReportView />)}</ProtectedRoute>} />
      <Route path="/person-tracker" element={<ProtectedRoute>{wrap(<PersonTracker />)}</ProtectedRoute>} />
      <Route path="/feature-demos"  element={<ProtectedRoute>{wrap(<FeatureDemos />)}</ProtectedRoute>} />
      <Route path="/compute-cost"   element={<ProtectedRoute>{wrap(<ComputeCost />)}</ProtectedRoute>} />
      <Route path="/sites"     element={<ProtectedRoute><Navigate to="/camera-setup?tab=sites" replace /></ProtectedRoute>} />
      <Route path="/health"    element={<ProtectedRoute>{wrap(<CameraHealth />)}</ProtectedRoute>} />
      <Route path="/ai-feed"   element={<ProtectedRoute>{wrap(<AiFeed />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring" element={<ProtectedRoute>{wrap(<ActivityDashboard />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/live-activity" element={<ProtectedRoute>{wrap(<CampusLiveActivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/student" element={<ProtectedRoute>{wrap(<CampusStudentActivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/faculty" element={<ProtectedRoute>{wrap(<CampusFacultyActivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/groups" element={<ProtectedRoute>{wrap(<CampusGroupActivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/rooms" element={<ProtectedRoute>{wrap(<CampusRoomAnalytics />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/attendance-intel" element={<ProtectedRoute>{wrap(<CampusAttendanceIntelligence />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/productivity" element={<ProtectedRoute>{wrap(<CampusProductivityAnalytics />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/campus-reports" element={<ProtectedRoute>{wrap(<CampusReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/rules" element={<ProtectedRoute>{wrap(<CampusRulesPolicies />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/active-activities" element={<ProtectedRoute>{wrap(<CampusActiveActivities />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/attendance" element={<ProtectedRoute>{wrap(<SchoolAttendance />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/safety" element={<ProtectedRoute>{wrap(<SchoolSafety />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/transport" element={<ProtectedRoute>{wrap(<SchoolTransport />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/dismissal" element={<ProtectedRoute>{wrap(<SchoolDismissal />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/visitors" element={<ProtectedRoute>{wrap(<SchoolVisitors />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/student" element={<ProtectedRoute>{wrap(<SchoolStudent />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/rooms" element={<ProtectedRoute>{wrap(<SchoolRooms />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/reports" element={<ProtectedRoute>{wrap(<SchoolReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/rules" element={<ProtectedRoute>{wrap(<SchoolRules />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/school/guardians" element={<ProtectedRoute>{wrap(<SchoolGuardians />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/headcount" element={<ProtectedRoute>{wrap(<ZoneHeadcount />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/movement" element={<ProtectedRoute>{wrap(<HostelMovement />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/dining" element={<ProtectedRoute>{wrap(<HostelDining />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/housekeeping" element={<ProtectedRoute>{wrap(<HostelHousekeeping />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/maintenance" element={<ProtectedRoute>{wrap(<HostelMaintenance />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/security" element={<ProtectedRoute>{wrap(<HostelSecurity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/safety" element={<ProtectedRoute>{wrap(<HostelSafety />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/staff" element={<ProtectedRoute>{wrap(<HostelStaff />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/staff/:id" element={<ProtectedRoute>{wrap(<HostelStaffDetail />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/productivity" element={<ProtectedRoute>{wrap(<HostelProductivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/alerts" element={<ProtectedRoute>{wrap(<HostelAlerts />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hostel/reports" element={<ProtectedRoute>{wrap(<HostelReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/guest-service" element={<ProtectedRoute>{wrap(<HospGuestService />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/guest-service/:id" element={<ProtectedRoute>{wrap(<HospDeskDetail />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/housekeeping" element={<ProtectedRoute>{wrap(<HospHousekeeping />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/movement" element={<ProtectedRoute>{wrap(<HospMovement />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/safety" element={<ProtectedRoute>{wrap(<HospSafety />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/staff" element={<ProtectedRoute>{wrap(<HospStaff />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/staff/:id" element={<ProtectedRoute>{wrap(<HospStaffDetail />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/productivity" element={<ProtectedRoute>{wrap(<HospProductivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/hospitality/reports" element={<ProtectedRoute>{wrap(<HospReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/teller" element={<ProtectedRoute>{wrap(<BankTeller />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/cash-ops" element={<ProtectedRoute>{wrap(<BankCashOps />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/productivity" element={<ProtectedRoute>{wrap(<BankProductivity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/movement" element={<ProtectedRoute>{wrap(<BankMovement />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/security" element={<ProtectedRoute>{wrap(<BankSecurity />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/facility" element={<ProtectedRoute>{wrap(<BankFacility />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/staff-roster" element={<ProtectedRoute>{wrap(<BankStaffRoster />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/staff/:id" element={<ProtectedRoute>{wrap(<BankStaffDetail />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/alerts" element={<ProtectedRoute>{wrap(<BankAlerts />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/bank/reports" element={<ProtectedRoute>{wrap(<BankReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/employee/:id" element={<ProtectedRoute>{wrap(<EmployeeDetail />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/activity-log" element={<ProtectedRoute>{wrap(<ActivityLog />)}</ProtectedRoute>} />
      {/* Breaks & Idle and Phone Usage were two pages of the same table,
          differing only in the event type they filtered to. Both are now the
          Activity Log, and their URLs land on it pre-filtered so a bookmark
          still opens the view it named. `wrap` keeps the chrome mounted
          across the hop (see the Analytics redirect below). */}
      <Route path="/activity-monitoring/breaks" element={<ProtectedRoute>{wrap(<Navigate to="/activity-monitoring/activity-log?type=breaks" replace />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/phone"  element={<ProtectedRoute>{wrap(<Navigate to="/activity-monitoring/activity-log?type=phone" replace />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/zones"   element={<ProtectedRoute>{wrap(<ZoneCoverage />)}</ProtectedRoute>} />
      {/* What a zone MEANS to staff activity (post / queue point, and the
          coverage limits). Where it IS stays on /occupancy/zone-setup. */}
      <Route path="/activity-monitoring/zone-setup" element={<ProtectedRoute>{wrap(<ActivityZoneSetup />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/performance" element={<ProtectedRoute>{wrap(<StaffPerformance />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/reports" element={<ProtectedRoute>{wrap(<ProductivityReports />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/policies" element={<ProtectedRoute>{wrap(<StoreOfficeRules />)}</ProtectedRoute>} />
      <Route path="/attendance-report" element={<ProtectedRoute>{wrap(<AttendanceReport />)}</ProtectedRoute>} />
      {/* Canonical is the plural: the Activity Monitoring header CTA, the
          sidebar and every in-app link point at /event-logs. The old singular
          is kept as a redirect so existing bookmarks and any link still
          spelling it the old way keep working. */}
      <Route path="/event-logs" element={<ProtectedRoute>{wrap(<EventLog />)}</ProtectedRoute>} />
      <Route path="/event-log" element={<Navigate to="/event-logs" replace />} />

      {/* Retail Analytics — the charts that used to sit at the bottom of the
          Activity Monitoring dashboard. Opens on Today's Trends; the tab is the
          route, so each view is linkable and the back button works.

          It hangs off /activity-monitoring because that is the module it
          reports on. A top-level /analytics said "analytics for the whole
          product" and delivered analytics for one module, and it sat in a
          different sidebar group from every other page it talked about. */}
      {/* Redirects render inside wrap() so the layout stays mounted across the
          hop — a bare <Navigate> unmounts the sidebar and top bar for a frame,
          which reads as a full page refresh. */}
      <Route path="/activity-monitoring/analytics" element={<ProtectedRoute>{wrap(<Navigate to="/activity-monitoring/analytics/trends" replace />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/analytics/:tab" element={<ProtectedRoute>{wrap(<ActivityAnalytics />)}</ProtectedRoute>} />
      <Route path="/activity-monitoring/analytics/:tab/:view" element={<ProtectedRoute>{wrap(<ActivityAnalytics />)}</ProtectedRoute>} />
      {/* Bookmarks and any link still on the old top-level path. The tab is
          carried across, so /analytics/staff lands on Staff rather than
          dumping the reader back on the default view. */}
      <Route path="/analytics" element={<ProtectedRoute>{wrap(<Navigate to="/activity-monitoring/analytics/trends" replace />)}</ProtectedRoute>} />
      <Route path="/analytics/:tab" element={<ProtectedRoute>{wrap(<LegacyAnalyticsRedirect />)}</ProtectedRoute>} />
      <Route path="/live-tracker" element={<ProtectedRoute>{wrap(<LiveTracker />)}</ProtectedRoute>} />
      <Route path="/compute"   element={<ProtectedRoute><Navigate to="/settings?tab=usage" replace /></ProtectedRoute>} />

      {/* AI Analytics modules — splat routes let each router own its sub-routes.
          Paths match the modules' own internal navigation (/ai-analytics/<segment>). */}
      {/* The Analytics Hub landing page is gone: every module it linked to has
          its own sidebar row, so the hub was only ever an extra click. Old
          bookmarks land on Home rather than the catch-all's login screen. */}
      <Route path="/ai-analytics"                  element={<ProtectedRoute><Navigate to="/home" replace /></ProtectedRoute>} />
      <Route path="/ai-analytics/weapon/*"         element={<ProtectedRoute>{ai(<WeaponRouter />)}</ProtectedRoute>} />
      <Route path="/ai-analytics/aggression/*"     element={<ProtectedRoute>{ai(<AggressionRouter />)}</ProtectedRoute>} />
      <Route path="/ai-analytics/fire/*"           element={<ProtectedRoute>{ai(<FireDetectionRouter />)}</ProtectedRoute>} />
      <Route path="/ai-analytics/watchlist/*"      element={<ProtectedRoute>{ai(<FaceWatchListRouter />)}</ProtectedRoute>} />
      {/* The hub is a module, not an ai-analytics page: that folder's global
          reset beats Tailwind, which is why everything in it carries a
          hand-written stylesheet. On the app shell the hub gets the design
          tokens and dark mode for free. The deeper ANPR pages -- watchlist,
          vehicle profile, relationship graph -- stay where they are and are
          reached from inside the hub. */}
      <Route path="/ai-analytics/vehicle"          element={<ProtectedRoute>{wrap(<VehicleHub />)}</ProtectedRoute>} />
      <Route path="/ai-analytics/vehicle/*"        element={<ProtectedRoute>{ai(<ANPRRouter />)}</ProtectedRoute>} />
      {/* Restricted Zone was a third polygon-over-camera editor with its own
          store. Zone Setup is the one editor now and writes to the same
          /restricted-zones API, so the old address lands there. */}
      <Route path="/ai-analytics/restricted"       element={<ProtectedRoute><Navigate to="/occupancy/zone-setup" replace /></ProtectedRoute>} />
      <Route path="/ai-analytics/productivity"     element={<ProtectedRoute>{ai(<Productivity />)}</ProtectedRoute>} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
    </ErrorBoundary>
    </>
  );
}
