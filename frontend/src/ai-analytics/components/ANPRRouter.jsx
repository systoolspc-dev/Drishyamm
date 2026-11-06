import { Routes, Route, Navigate } from 'react-router-dom';
import ANPRDashboard from './ANPR/ANPRDashboard';
import VehicleWatchlistManagement from './ANPR/VehicleWatchlistManagement';
import VehicleJourneyTracking from './ANPR/VehicleJourneyTracking';
import VehicleIntelligenceProfile from './ANPR/VehicleIntelligenceProfile';
import VehicleRelationshipGraph from './ANPR/VehicleRelationshipGraph';

export default function ANPRRouter() {
  return (
    <div className="page-content">
      <Routes>
        <Route index element={<ANPRDashboard />} />
        <Route path="dashboard" element={<ANPRDashboard />} />
        <Route path="watchlist" element={<VehicleWatchlistManagement />} />
        <Route path="profile" element={<VehicleIntelligenceProfile />} />
        <Route path="profile/:plate" element={<VehicleIntelligenceProfile />} />
        <Route path="vehicle-profile" element={<VehicleIntelligenceProfile />} />
        <Route path="vehicle-profile/:plate" element={<VehicleIntelligenceProfile />} />
        <Route path="journey" element={<VehicleJourneyTracking />} />
        <Route path="journey-tracking" element={<VehicleJourneyTracking />} />
        <Route path="relationship" element={<VehicleRelationshipGraph />} />
        <Route path="relationship/:plate" element={<VehicleRelationshipGraph />} />

        <Route path="analytics" element={<Navigate to="/ai-analytics/vehicle" replace />} />
        <Route path="heatmap" element={<Navigate to="/ai-analytics/vehicle" replace />} />
        <Route path="parking" element={<Navigate to="/ai-analytics/vehicle" replace />} />
        <Route path="traffic" element={<Navigate to="/ai-analytics/vehicle" replace />} />
        <Route path="traffic-enforcement" element={<Navigate to="/ai-analytics/vehicle" replace />} />
        <Route path="replay" element={<Navigate to="/ai-analytics/vehicle" replace />} />
      </Routes>
    </div>
  );
}
