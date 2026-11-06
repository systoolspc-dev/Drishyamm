import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout.jsx'
import Dashboard from './components/Dashboard.jsx'
import Customers from './components/Customers.jsx'
import AccountControl from './components/AccountControl.jsx'
import Cameras from './components/Camera.jsx'
import Events from './components/Events.jsx'
import LiveMonitor from './components/LiveMonitor.jsx'
import AuditLog from './components/Auditlog.jsx'
import Downloads from './components/Downloads.jsx'
import PricingCatalog from './components/PricingCatalog.jsx'
import PricingCalculator from './components/PricingCalculator.jsx'
import Licenses from './components/Licenses.jsx'
import LicenseDetail from './components/LicenseDetail.jsx'
import MailSettings from './components/MailSettings.jsx'
import Activity from './components/Activity.jsx'
import ActivityProvider from './components/activity/ActivityProvider.jsx'
import AdminLogin from './AdminLogin.jsx'
import './admin.css'

function AdminProtectedRoute({ children }) {
  const adminToken = localStorage.getItem('admin_token')
  const adminUser = (() => { try { return JSON.parse(localStorage.getItem('admin_user')) } catch { return null } })()

  if (!adminToken || adminUser?.role !== 'admin') {
    return <Navigate to="/admin/login" replace />
  }
  return children
}

export default function AdminApp() {
  return (
    <div className="admin-shell">
      <Routes>
        <Route path="login" element={<AdminLogin />} />
        <Route
          path="*"
          element={
            <AdminProtectedRoute>
              <ActivityProvider>
              <Layout>
                <Routes>
                  <Route index element={<Dashboard />} />
                  <Route path="customers" element={<Customers />} />
                  <Route path="customers/:id" element={<AccountControl />} />
                  <Route path="activity" element={<Activity />} />
                  <Route path="live" element={<LiveMonitor />} />
                  <Route path="cameras" element={<Cameras />} />
                  <Route path="events" element={<Events />} />
                  <Route path="audit" element={<AuditLog />} />
                  <Route path="downloads" element={<Downloads />} />
                  <Route path="pricing"    element={<PricingCatalog />} />
                  <Route path="calculator" element={<PricingCalculator />} />
                  <Route path="licenses"     element={<Licenses />} />
                  <Route path="licenses/:id" element={<LicenseDetail />} />
                  <Route path="settings"     element={<MailSettings />} />
                  <Route path="*" element={<Navigate to="/admin" replace />} />
                </Routes>
              </Layout>
              </ActivityProvider>
            </AdminProtectedRoute>
          }
        />
      </Routes>
    </div>
  )
}
