import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { anprDetections, anprMockData, blacklistedVehicles } from '../../data/ANPR';

const STATUS_STYLES = {
  blacklisted: { color: 'var(--color-danger-text)', bg: 'var(--color-danger-bg)', border: 'var(--color-danger-border)', label: 'Blacklisted' },
  watchlist: { color: 'var(--color-warning-text)', bg: 'var(--color-warning-bg)', border: 'var(--color-warning-border)', label: 'Watchlist' },
  suspicious: { color: 'var(--color-info-text)', bg: 'var(--color-info-bg)', border: 'var(--color-border)', label: 'Suspicious' },
  clear: { color: 'var(--color-success-text)', bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', label: 'Clear' },
};

const tabs = [
  { id: 'movement', label: 'Movement', icon: 'route' },
  { id: 'alerts', label: 'Alerts', icon: 'warning' },
  { id: 'owner', label: 'Owner', icon: 'person' },
  { id: 'evidence', label: 'Evidence', icon: 'folder_special' },
];

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.clear;
  return <span className="anpr-profile-badge" style={{ color: style.color, background: style.bg, borderColor: style.border }}>{style.label}</span>;
}

function InfoRow({ label, value }) {
  return (
    <div className="anpr-profile-info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function buildVehicleProfile(vehicle) {
  const watch = blacklistedVehicles.find((item) => item.plate === vehicle.plate);
  const ownerName = vehicle.plate === 'DL8CAF5678' ? 'Amit Kumar' : vehicle.plate === 'RJ14GH2345' ? 'City Shuttle Operator' : 'Unknown Owner';
  const allSightings = [
    { camera: 'CAM-01', location: 'Main Gate', time: '08:14:22', event: 'Entry', confidence: 94 },
    { camera: 'CAM-03', location: 'Parking Area', time: '08:16:05', event: 'Parked', confidence: 91 },
    { camera: 'CAM-02', location: 'North Gate', time: '10:42:18', event: 'Seen', confidence: 89 },
    { camera: vehicle.camera, location: vehicle.location, time: vehicle.timestamp.split(' ')[1] || '14:22:10', event: 'Latest ANPR hit', confidence: Math.round(vehicle.confidence * 100) },
  ];

  return {
    watch,
    ownerName,
    allSightings,
    riskScore: vehicle.status === 'clear' ? '21 / 100' : vehicle.status === 'suspicious' ? '68 / 100' : '92 / 100',
    incidentCount: vehicle.status === 'clear' ? 0 : vehicle.status === 'suspicious' ? 2 : 5,
  };
}

export default function VehicleIntelligenceProfile({ onBack }) {
  const navigate = useNavigate();
  const routeParams = useParams();
  const [params] = useSearchParams();
  const requestedPlate = params.get('plate') || routeParams.plate;
  const [activeTab, setActiveTab] = useState('movement');
  const vehicle = anprDetections.find(v => v.plate === requestedPlate) || anprDetections.find(v => v.status === 'blacklisted') || anprDetections[0];
  const evidence = anprMockData.liveFeed.find((item) => item.plate === vehicle.plate) || anprMockData.liveFeed[0];
  const profile = useMemo(() => buildVehicleProfile(vehicle), [vehicle]);

  const openJourney = () => navigate(`/ai-analytics/vehicle/journey?plate=${vehicle.plate}`);
  const openRelationship = () => navigate(`/ai-analytics/vehicle/relationship?plate=${vehicle.plate}`);
  const openFaceRelationship = () => navigate(`/ai-analytics/watchlist/relationship?vehiclePlate=${vehicle.plate}&source=vehicle-profile`);

  return (
    <main className="anpr-profile-page">
      <div className="anpr-profile-top">
        <button className="btn btn-ghost icon-btn" onClick={onBack || (() => navigate('/ai-analytics/vehicle/watchlist'))}>
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h2>Vehicle Intelligence Profile</h2>
          <p className="mono">{vehicle.plate} / {vehicle.make} / {vehicle.camera}</p>
        </div>
        <div className="anpr-inline-actions">
          <button className="btn btn-ghost" onClick={() => navigate('/ai-analytics/vehicle/watchlist')}>
            <span className="material-symbols-outlined icon-sm">format_list_bulleted</span>
            Watchlist
          </button>
          <button className="btn btn-ghost" onClick={openJourney}>
            <span className="material-symbols-outlined icon-sm">route</span>
            Journey
          </button>
          <button className="btn btn-primary" onClick={openRelationship}>
            <span className="material-symbols-outlined icon-sm">hub</span>
            Relationship Graph
          </button>
        </div>
      </div>

      <div className="anpr-profile-layout">
        <aside className="card anpr-profile-sidebar">
          <div className="anpr-profile-sidebar-head">
            <h3>All Profiles</h3>
            <p>{anprDetections.length} retained vehicle profiles</p>
          </div>
          <div className="anpr-profile-list">
            {anprDetections.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.plate === vehicle.plate ? 'active' : ''}
                onClick={() => navigate(`/ai-analytics/vehicle/profile?plate=${item.plate}`)}
              >
                <span className="material-symbols-outlined">directions_car</span>
                <div>
                  <strong className="mono">{item.plate}</strong>
                  <small>{item.make} / {item.location}</small>
                </div>
                <StatusBadge status={item.status} />
              </button>
            ))}
          </div>
        </aside>

        <section className="card anpr-profile-main">
          <div className="anpr-profile-hero">
            <div className="anpr-profile-visual">
              {evidence?.video ? (
                <video src={evidence.video} poster={evidence.poster || evidence.image} controls muted playsInline preload="metadata" />
              ) : evidence?.image ? (
                <img
                  src={evidence.image}
                  alt={`${vehicle.plate} ANPR evidence`}
                  loading="lazy"
                  decoding="async"
                  width={1280}
                  height={720}
                />
              ) : (
                <span className="material-symbols-outlined">directions_car</span>
              )}
              <strong>{(STATUS_STYLES[vehicle.status] || STATUS_STYLES.clear).label.toUpperCase()}</strong>
            </div>
            <div className="anpr-profile-identity">
              <div>
                <StatusBadge status={vehicle.status} />
                <h1 className="mono">{vehicle.plate}</h1>
                <p>{vehicle.color} {vehicle.make} / {vehicle.vehicleType}</p>
              </div>
              <div className="anpr-profile-actions">
                <button className="btn btn-ghost" onClick={openJourney}>Open Journey</button>
                <button className="btn btn-primary" onClick={openRelationship}>Relationship Graph</button>
              </div>
            </div>
          </div>

          <div className="anpr-profile-tabs">
            {tabs.map((tab) => (
              <button key={tab.id} type="button" className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>
                <span className="material-symbols-outlined icon-sm">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="anpr-profile-tab-panel">
            {activeTab === 'movement' && (
              <div className="anpr-profile-timeline">
                {profile.allSightings.map((item, index) => (
                  <div key={`${item.camera}-${item.time}`} className={index === profile.allSightings.length - 1 ? 'active' : ''}>
                    <span className="material-symbols-outlined">videocam</span>
                    <div>
                      <strong>{item.location}</strong>
                      <small>{item.camera} / {item.event} / {item.confidence}% confidence</small>
                    </div>
                    <code>{item.time}</code>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'alerts' && (
              <div className="anpr-profile-grid compact">
                <div><span>Watch Reason</span><strong>{profile.watch?.reason || `${vehicle.status} ANPR detection`}</strong></div>
                <div><span>Risk Score</span><strong>{profile.riskScore}</strong></div>
                <div><span>Linked Alerts</span><strong>{profile.incidentCount}</strong></div>
                <div><span>Evidence State</span><strong>Reviewable</strong></div>
              </div>
            )}

            {activeTab === 'owner' && (
              <div className="anpr-owner-card anpr-owner-card-with-action">
                <div className="anpr-owner-photo">
                  <span className="material-symbols-outlined">person</span>
                </div>
                <div>
                  <span>Registered owner signal</span>
                  <strong>{profile.ownerName}</strong>
                  <small>
                    {profile.ownerName === 'Unknown Owner'
                      ? 'Manual owner or PUC details can be added from Watchlist. Open the Face Watchlist relationship graph with this vehicle plate as evidence context.'
                      : 'Linked from registration / operator entry. Open the Face Watchlist relationship graph to inspect associations.'}
                  </small>
                </div>
                <button className="btn btn-primary" onClick={openFaceRelationship}>
                  <span className="material-symbols-outlined icon-sm">hub</span>
                  Face Relationship Graph
                </button>
              </div>
            )}

            {activeTab === 'evidence' && (
              <div className="anpr-profile-grid compact">
                <div><span>Camera</span><strong>{vehicle.camera}</strong></div>
                <div><span>Location</span><strong>{vehicle.location}</strong></div>
                <div><span>Timestamp</span><strong>{vehicle.timestamp}</strong></div>
                <div><span>OCR Confidence</span><strong>{(vehicle.confidence * 100).toFixed(1)}%</strong></div>
              </div>
            )}
          </div>
        </section>

        <aside className="card anpr-profile-intel">
          <span className="section-label">Key Intelligence</span>
          <div className="anpr-profile-score">
            <strong>{profile.riskScore}</strong>
            <small>Operational risk score</small>
          </div>
          <div className="anpr-profile-info">
            <InfoRow label="Last Seen" value={vehicle.location} />
            <InfoRow label="Last Camera" value={vehicle.camera} />
            <InfoRow label="Speed" value={`${vehicle.speed} km/h`} />
            <InfoRow label="Record Since" value={profile.watch?.addedDate || vehicle.timestamp.split(' ')[0]} />
            <InfoRow label="Owner" value={profile.ownerName} />
          </div>
          <div className="anpr-profile-quick-actions">
            <button className="btn btn-primary" onClick={openRelationship}>
              <span className="material-symbols-outlined icon-sm">hub</span>
              Open Relationship Graph
            </button>
            <button className="btn btn-ghost" onClick={openJourney}>
              <span className="material-symbols-outlined icon-sm">route</span>
              Open Journey Mapping
            </button>
            <button className="btn btn-ghost" onClick={openFaceRelationship}>
              <span className="material-symbols-outlined icon-sm">account_tree</span>
              Face Relationship Graph
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/ai-analytics/vehicle/watchlist')}>
              <span className="material-symbols-outlined icon-sm">playlist_add</span>
              Manage Watchlist
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
