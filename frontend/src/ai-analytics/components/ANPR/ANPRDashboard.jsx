import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { anprMockData } from '../../data/ANPR';
import TacticalActionsBar from '../common/TacticalActionsBar.jsx';

const statusTone = {
  BLACKLISTED: 'critical',
  STOLEN: 'critical',
  SUSPICIOUS: 'warning',
  WATCHLIST: 'warning',
  NORMAL: 'clear',
};

function VehicleStatus({ status }) {
  return <span className={`anpr-status ${statusTone[status] || 'clear'}`}>{status}</span>;
}

function ANPRMedia({ vehicle, className = '', stage = false, onTime }) {
  if (vehicle?.video) {
    return (
      <video
        className={className}
        src={vehicle.video}
        poster={vehicle.poster || vehicle.image}
        muted
        loop
        autoPlay={stage}
        playsInline
        controls={stage}
        preload={stage ? 'metadata' : 'none'}
        onTimeUpdate={onTime}
      />
    );
  }

  // width/height mirror the container's 16/9 aspect box (.anpr-camera-media),
  // not the file's intrinsic size: CSS pins this img to width/height 100% with
  // object-fit cover, so the container's aspect-ratio is what reserves layout
  // space. Matching it keeps the browser's inferred ratio from fighting the CSS
  // before the bytes land, which is what holds CLS on a grid of these tiles.
  return (
    <img
      className={className}
      src={vehicle?.poster || vehicle?.image}
      alt={vehicle?.plate || 'ANPR footage'}
      loading="lazy"
      decoding="async"
      width={1280}
      height={720}
    />
  );
}

const LAYOUTS = [
  { id: 'single', label: 'Single', icon: 'crop_free', count: 1 },
  { id: '2x2', label: '2x2', icon: 'grid_view', count: 4 },
  { id: '3x3', label: '3x3', icon: 'apps', count: 9 },
];

// Interpolate a tracking box between hardcoded keyframes for the current video time.
// Returns null outside the detection window (so the box only shows when the car is there).
function interpBox(keys, t) {
  if (!keys || !keys.length) return null;
  if (t < keys[0].t - 0.15 || t > keys[keys.length - 1].t + 0.4) return null;
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
  }
  const span = (b.t - a.t) || 1;
  const f = Math.min(1, Math.max(0, (t - a.t) / span));
  const lerp = (p, q) => p + (q - p) * f;
  return { x: lerp(a.x, b.x), y: lerp(a.y, b.y), w: lerp(a.w, b.w), h: lerp(a.h, b.h) };
}

function LiveVehicleCard({ vehicle, active, onSelect, layout }) {
  const [videoT, setVideoT] = useState(0);
  const isStage = active && layout === 'single';
  const plateBoxes = (vehicle.plateTracks || [])
    .map((tr) => ({ tr, box: interpBox(tr.keys, videoT) }))
    .filter((d) => d.box);

  return (
    <article className={`anpr-camera-tile ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className={`anpr-camera-media ${vehicle.portrait ? 'portrait' : ''}`}>
        <ANPRMedia
          vehicle={vehicle}
          stage={isStage}
          onTime={(e) => setVideoT(e.currentTarget.currentTime)}
        />
        <div className="anpr-camera-overlay">
          <span className="anpr-rec">LIVE</span>
          <time className="mono">{vehicle.timestamp}</time>
        </div>
        <div className="anpr-camera-lock">
          <span>Plate lock</span>
          <strong className="mono">{vehicle.plate}</strong>
          <small>{vehicle.color} {vehicle.brand} {vehicle.model} / {vehicle.zone}</small>
        </div>

        {/* Number-plate detection boxes (each tracks its vehicle via keyframes) */}
        {plateBoxes.map(({ tr, box }) => (
          <div
            key={tr.plate}
            className="anpr-plate-detection-box"
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          >
            <span>{tr.plate} · {tr.confidence}%</span>
          </div>
        ))}

        {/* Legacy static boxes — only for cams that still define them and aren't tracked */}
        {!vehicle.plateTracks && vehicle.detections?.map((box) => (
          <div
            key={`${vehicle.id}-${box.label}-${box.x}`}
            className={`anpr-vehicle-detection-box ${box.interest ? 'interest' : ''}`}
            style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
          >
            <span>{box.label} / {box.color} / {box.confidence}%</span>
          </div>
        ))}
      </div>
      <div className="anpr-camera-footer">
        <div>
          <VehicleStatus status={vehicle.watchlist} />
          <p>{vehicle.zone} / {vehicle.state} / {vehicle.speed} km/h</p>
        </div>
      </div>
    </article>
  );
}

function AlertCard({ alert, onProfile, onJourney }) {
  return (
    <article className={`anpr-alert-card ${alert.severity.toLowerCase()}`}>
      <span className="material-symbols-outlined icon-filled">warning</span>
      <div>
        <div className="anpr-alert-head">
          <strong className="mono">{alert.plate}</strong>
          <time>{alert.time}</time>
        </div>
        <p>{alert.type}</p>
        <small>{alert.location} / {alert.severity}</small>
        <div className="anpr-card-actions compact">
          <button type="button" className="btn btn-ghost" onClick={onProfile}>Profile</button>
          <button type="button" className="btn btn-primary" onClick={onJourney}>Journey</button>
        </div>
      </div>
    </article>
  );
}

export default function ANPRDashboard() {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState(anprMockData.liveFeed[0]?.id);
  const [layout, setLayout] = useState('single');
  const selected = anprMockData.liveFeed.find((item) => item.id === selectedId) || anprMockData.liveFeed[0];
  const activeLayout = LAYOUTS.find((item) => item.id === layout) || LAYOUTS[0];

  const todaysAlerts = useMemo(() => {
    const feedAlerts = anprMockData.liveFeed
      .filter((item) => item.watchlist !== 'NORMAL')
      .map((item) => ({
        severity: item.watchlist === 'BLACKLISTED' ? 'CRITICAL' : 'HIGH',
        plate: item.plate,
        type: `${item.watchlist.toLowerCase()} vehicle match`,
        location: item.zone,
        time: item.timestamp,
      }));
    const feedKeys = new Set(feedAlerts.map((item) => `${item.plate}-${item.time}`));
    return [
      ...feedAlerts,
      ...anprMockData.activeThreats.filter((item) => !feedKeys.has(`${item.plate}-${item.time}`)),
    ];
  }, []);

  const openProfile = (plate = selected?.plate) => navigate(`/ai-analytics/vehicle/profile?plate=${plate}`);
  const openJourney = (plate = selected?.plate) => navigate(`/ai-analytics/vehicle/journey?plate=${plate}`);

  return (
    <main className="anpr-overview-page">
      <section className="anpr-live-command">
        <div className="anpr-section-head">
          <div>
            <h2>Live ANPR Feed</h2>
            <p>Real-time vehicle detections from active entry, parking, and exit cameras.</p>
          </div>
          <div className="anpr-feed-controls">
            <div className="anpr-layout-switch" aria-label="Feed layout">
              {LAYOUTS.map((item) => (
                <button
                  key={item.id}
                  className={layout === item.id ? 'active' : ''}
                  type="button"
                  onClick={() => setLayout(item.id)}
                  title={item.label}
                >
                  <span className="material-symbols-outlined icon-sm">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="anpr-live-state">
              <span className="live-dot" />
              Control Room Live
            </div>
          </div>
        </div>

        <div className={`anpr-camera-grid layout-${layout}`}>
          {(layout === 'single' ? [selected] : anprMockData.liveFeed.slice(0, activeLayout.count)).map((vehicle) => (
            <LiveVehicleCard
              key={vehicle.id}
              vehicle={vehicle}
              active={vehicle.id === selected?.id}
              layout={layout}
              onSelect={() => setSelectedId(vehicle.id)}
            />
          ))}
        </div>
      </section>

      <section className="anpr-alert-panel card anpr-alert-live-band">
        <div className="anpr-section-head compact">
          <div>
            <h2>Live Alert Stream</h2>
            <p>Recent ANPR matches with direct profile and journey actions.</p>
          </div>
          <span>{todaysAlerts.length}</span>
        </div>
        <div className="anpr-alert-scroll">
          {todaysAlerts.map((alert, index) => (
            <AlertCard
              key={`${alert.plate}-${alert.time}-${index}`}
              alert={alert}
              onProfile={() => openProfile(alert.plate)}
              onJourney={() => openJourney(alert.plate)}
            />
          ))}
        </div>
      </section>

      <TacticalActionsBar
        label="VEHICLE RESPONSE"
        icon="directions_car"
        actions={[
          { label: 'Vehicle Profile', icon: 'badge', onClick: () => openProfile() },
          { label: 'Journey Map', icon: 'route', onClick: () => openJourney() },
          { label: 'Relationship', icon: 'hub', onClick: () => navigate(`/ai-analytics/vehicle/relationship?plate=${selected?.plate}`) },
          { label: 'Watchlist', icon: 'playlist_add', onClick: () => navigate('/ai-analytics/vehicle/watchlist') },
          { label: 'Alert Patrol', icon: 'notifications_active' },
          { label: 'Export Evidence', icon: 'folder_special' },
        ]}
      />
    </main>
  );
}
