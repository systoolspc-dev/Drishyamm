import { Navigate, Routes, Route } from 'react-router-dom';
import AggressionLiveFeed from './Aggression/AggressionLiveFeed';
import AggressionReID from './Aggression/AggressionReID';
import AggressionTimeline from './Aggression/AggressionTimeline';
import AggressionIncidents from './Aggression/AggressionIncidents';

export default function AggressionRouter() {
  return (
    <div className="page-content">
      <Routes>
        <Route index element={<Navigate to="live" replace />} />
        <Route path="live" element={<AggressionLiveFeed />} />
        <Route path="reid" element={<AggressionReID />} />
        <Route path="reid/:subjectId" element={<AggressionReID />} />
        <Route path="timeline" element={<AggressionTimeline />} />
        <Route path="incidents" element={<AggressionIncidents />} />
      </Routes>
    </div>
  );
}
