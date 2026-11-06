import { Routes, Route } from 'react-router-dom';
import FaceWatchlistDashboard   from './FaceWatchlist';
import WatchlistManagementPage  from './FaceWatchlist/WatchListManagementPage';
import SuspectProfilePage       from './FaceWatchlist/SuspectProfilePge';
import REIDTrackingPage         from './FaceWatchlist/LiveReIDTrackingPage';
import BehaviorIntelligencePage from './FaceWatchlist/BehaviourIntelligencePage';
import RelationshipGraphPage    from './FaceWatchlist/RelationshipGraphPage';
import FaceSearchPage           from './FaceWatchlist/FaceSearchPage';

export default function FaceWatchListRouter() {
  // Host app supplies Sidebar + Topbar chrome; render only the routed content.
  return (
    <div className="page-content">
      <Routes>
        <Route index              element={<FaceWatchlistDashboard />} />
        <Route path="watchlist"   element={<WatchlistManagementPage />} />
        <Route path="suspect"     element={<SuspectProfilePage />} />
        <Route path="suspect/:personId" element={<SuspectProfilePage />} />
        <Route path="reid"        element={<REIDTrackingPage />} />
        <Route path="reid/:personId" element={<REIDTrackingPage />} />
        <Route path="behavior"    element={<BehaviorIntelligencePage />} />
        <Route path="behavior/:personId" element={<BehaviorIntelligencePage />} />
        <Route path="relationship" element={<RelationshipGraphPage />} />
        <Route path="relationship/:personId" element={<RelationshipGraphPage />} />
        <Route path="search"      element={<FaceSearchPage />} />
      </Routes>
    </div>
  );
}
