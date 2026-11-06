import { Navigate, Route, Routes } from 'react-router-dom';
import WeaponOverview from './WeaponDetection/WeaponOverview';
import ThreatWatchlist from './WeaponDetection/ThreatWatchlist';
import EvidenceReplay from './WeaponDetection/EvidenceReplay';
import WeaponJourneyMap from './WeaponDetection/WeaponJourneyMap';
import BlacklistedSuspects from './WeaponDetection/BlacklistedSuspects';

export default function WeaponRouter() {
  return (
    <div className="page-content">
      <Routes>
        <Route index element={<WeaponOverview />} />
        <Route path="watchlist" element={<ThreatWatchlist />} />
        <Route path="timeline" element={<Navigate to="/ai-analytics/weapon/journey/WEAP-RFL-00042" replace />} />
        <Route path="journey" element={<Navigate to="/ai-analytics/weapon/journey/WEAP-RFL-00042" replace />} />
        <Route path="journey/:weaponId" element={<WeaponJourneyMap />} />
        <Route path="evidence" element={<EvidenceReplay />} />
        <Route path="suspects" element={<BlacklistedSuspects />} />
        <Route path="*" element={<Navigate to="/ai-analytics/weapon" replace />} />
      </Routes>
    </div>
  );
}
