import { useThreatFeed } from './useThreatFeed';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TacticalFeed from './TacticalFeed';

const WEAPON_FEED_ALERT_MS = 6000;

const FALLBACK_ALERTS = [
  { id: 'demo-1', weapon_id: 'WEAP-RFL-00042', metadata: { weaponType: 'Rifle' }, confidence: 0.94, location: 'Main Gate', camera_id: 'CAM-04', created_at: new Date(Date.now() - 75 * 1000).toISOString(), severity: 'critical', status: 'active' },
  { id: 'demo-2', weapon_id: 'WEAP-PST-00017', metadata: { weaponType: 'Pistol' }, confidence: 0.91, location: 'Parking Area', camera_id: 'CAM-07', created_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(), severity: 'critical', status: 'active' },
  { id: 'demo-3', weapon_id: 'WEAP-KNF-00031', metadata: { weaponType: 'Knife' }, confidence: 0.88, location: 'North Entry', camera_id: 'CAM-01', created_at: new Date(Date.now() - 9 * 60 * 1000).toISOString(), severity: 'warning', status: 'active' },
  { id: 'demo-4', weapon_id: 'WEAP-RFL-00043', metadata: { weaponType: 'Rifle' }, confidence: 0.87, location: 'Bus Bay', camera_id: 'CAM-03', created_at: new Date(Date.now() - 13 * 60 * 1000).toISOString(), severity: 'warning', status: 'acknowledged' },
  { id: 'demo-5', weapon_id: 'WEAP-PST-00018', metadata: { weaponType: 'Pistol' }, confidence: 0.72, location: 'Back Gate', camera_id: 'CAM-02', created_at: new Date(Date.now() - 21 * 60 * 1000).toISOString(), severity: 'high', status: 'active' },
  { id: 'demo-6', weapon_id: 'WEAP-UNK-00009', metadata: { weaponType: 'Unknown' }, confidence: 0.69, location: 'Service Lane', camera_id: 'CAM-06', created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(), severity: 'warning', status: 'active' },
];

const CAMERA_NAMES = {
  'CAM-01': 'North Entry',
  'CAM-02': 'Back Gate',
  'CAM-03': 'Bus Bay',
  'CAM-04': 'Main Gate',
  'CAM-05': 'South Gate',
  'CAM-06': 'Service Lane',
  'CAM-07': 'Parking Area',
  'CAM-08': 'North Corridor',
  'CAM-09': 'Cafeteria',
  'CAM-10': 'Parking Exit',
  'CAM-11': 'Control Room',
  'CAM-12': 'Service Road',
};

function getCameraLabel(cameraId) {
  return `${CAMERA_NAMES[cameraId] || 'Camera'} - ${cameraId}`;
}

function getAge(value) {
  const ts = new Date(String(value).replace(' ', 'T')).getTime();
  if (!Number.isFinite(ts)) return '--';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function SeverityPill({ severity }) {
  return <span className={`weapon-alert-pill severity-${severity || 'warning'}`}>{severity || 'warning'}</span>;
}

function StatusPill({ status }) {
  return <span className={`weapon-alert-pill status-${status || 'active'}`}>{status || 'active'}</span>;
}

function ActiveWeaponAlerts({ detections, onCameraSelect }) {
  const navigate = useNavigate();
  const rows = (detections.length ? detections : FALLBACK_ALERTS)
    .filter(item => (item.event_type ? item.event_type === 'weapon_detected' : true))
    .slice(0, 12);

  return (
    <div className="card weapon-card weapon-active-alerts-panel">
      <div className="weapon-panel-title-row">
        <div>
          <h3>Active Alerts</h3>
          <p>Weapon response queue</p>
        </div>
        <span className="weapon-status-inline"><span />{rows.filter(row => (row.status || 'active') === 'active').length} Active</span>
      </div>

      <div className="weapon-alerts-scroll">
        <table className="data-table weapon-alerts-table">
          <thead>
            <tr>
              <th>Weapon Type</th>
              <th>Severity</th>
              <th>Location</th>
              <th>Camera</th>
              <th>Confidence</th>
              <th>Age</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(alert => (
              <tr key={alert.id}>
                <td>
                  <div className="weapon-alert-type">
                    <span className="material-symbols-outlined">report</span>
                    <strong>{alert.metadata?.weaponType || 'Unknown'}</strong>
                  </div>
                </td>
                <td><SeverityPill severity={alert.severity} /></td>
                <td>{alert.location}</td>
                <td>
                  <button
                    type="button"
                    className="weapon-camera-link mono"
                    title={`Show ${getCameraLabel(alert.camera_id)} in live feed`}
                    onClick={() => onCameraSelect?.(alert.camera_id)}
                  >
                    <span className="material-symbols-outlined">videocam</span>
                    {getCameraLabel(alert.camera_id)}
                  </button>
                </td>
                <td className="mono weapon-alert-confidence">{(parseFloat(alert.confidence) * 100).toFixed(0)}%</td>
                <td className="mono">{getAge(alert.created_at)}</td>
                <td><StatusPill status={alert.status} /></td>
                <td>
                  <div className="weapon-alert-actions">
                    <button
                      type="button"
                      title="Open weapon journey map"
                      aria-label="Open weapon journey map"
                      onClick={() => navigate(`/ai-analytics/weapon/journey/${alert.weapon_id || alert.id}?camera=${alert.camera_id}`)}
                    >
                      <span className="material-symbols-outlined">route</span>
                    </button>
                    <button
                      type="button"
                      title="Review evidence"
                      aria-label="Review evidence"
                      onClick={() => navigate(`/ai-analytics/weapon/evidence?incident=${alert.incident_id || alert.linkedIncident || 'WPN-DEMO-001'}&weapon=${alert.weapon_id || alert.id}`)}
                    >
                      <span className="material-symbols-outlined">folder_special</span>
                    </button>
                    <button type="button" title="Acknowledge alert" aria-label="Acknowledge alert">
                      <span className="material-symbols-outlined">done</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function WeaponOverview() {
  const { detections } = useThreatFeed();
  const [focusedCamera, setFocusedCamera] = useState(FALLBACK_ALERTS[0].camera_id);
  const [generatedAlerts, setGeneratedAlerts] = useState([]);
  const [feedAlert, setFeedAlert] = useState(null);
  const [feedAlertVisibleUntil, setFeedAlertVisibleUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const activeFeedAlert = feedAlert && now < feedAlertVisibleUntil ? feedAlert : null;
  const mergedDetections = [...generatedAlerts, ...detections];
  const topAlert = mergedDetections.find(d => d.severity === 'critical') || mergedDetections[0];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const handleWeaponAlert = (alert) => {
    setGeneratedAlerts(prev => [alert, ...prev.filter(item => item.weapon_id !== alert.weapon_id)].slice(0, 12));
    setFeedAlert(alert);
    setFeedAlertVisibleUntil(Date.now() + WEAPON_FEED_ALERT_MS);
    setNow(Date.now());
  };

  return (
    <div style={{ padding: 20 }}>
      <div className="weapon-overview-stack">
        <TacticalFeed
          alert={topAlert}
          focusedCamera={focusedCamera}
          activeFeedAlert={activeFeedAlert}
          onWeaponAlert={handleWeaponAlert}
        />
        <ActiveWeaponAlerts detections={mergedDetections} onCameraSelect={setFocusedCamera} />
      </div>
    </div>
  );
}
