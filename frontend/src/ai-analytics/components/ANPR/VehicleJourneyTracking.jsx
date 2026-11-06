import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const ROUTES = {
  MH14TC0786: [
    { camera: 'CAM-VID-01', location: 'Main Gate Live Lane', time: '14:32:02', action: 'Vehicle of interest detected in uploaded video feed', confidence: 96, x: 18, y: 54 },
    { camera: 'CAM-VID-01', location: 'Main Gate Live Lane', time: '14:32:05', action: 'White SUV tracked through lane with two nearby vehicles', confidence: 94, x: 46, y: 46 },
    { camera: 'CAM-VID-01', location: 'Exit Approach', time: '14:32:09', action: 'Plate retained for vehicle-of-interest profile', confidence: 92, x: 74, y: 58 },
  ],
  MH12AB1234: [
    { camera: 'CAM-01', location: 'Main Gate ANPR', time: '14:18:05', action: 'Entry captured', confidence: 97, x: 16, y: 28 },
    { camera: 'CAM-03', location: 'Parking Zone A', time: '14:19:20', action: 'Parked for 48 seconds', confidence: 94, x: 38, y: 62 },
    { camera: 'CAM-02', location: 'North Gate ANPR', time: '14:21:10', action: 'U-turn near exit lane', confidence: 92, x: 66, y: 36 },
    { camera: 'CAM-05', location: 'East Entry', time: '14:22:45', action: 'Exit attempt flagged', confidence: 95, x: 84, y: 54 },
  ],
  DL8CAF5678: [
    { camera: 'CAM-03', location: 'Parking Area', time: '14:21:44', action: 'Watchlist match in visitor bay', confidence: 94, x: 28, y: 64 },
    { camera: 'CAM-P2', location: 'Staff Parking', time: '14:25:18', action: 'Slow crawl between aisles', confidence: 91, x: 48, y: 48 },
    { camera: 'CAM-08', location: 'Parking Exit', time: '14:28:09', action: 'Route continues toward outer road', confidence: 88, x: 76, y: 32 },
  ],
  GJ01EF7890: [
    { camera: 'CAM-04', location: 'Bus Bay', time: '14:18:12', action: 'High speed pass captured', confidence: 89, x: 18, y: 68 },
    { camera: 'CAM-11', location: 'Service Road', time: '14:20:18', action: 'Plate reacquired', confidence: 86, x: 48, y: 42 },
    { camera: 'CAM-15', location: 'Outer Exit', time: '14:22:09', action: 'Likely exit vector', confidence: 83, x: 78, y: 30 },
  ],
};

const plates = Object.keys(ROUTES);

function StopCard({ stop, index, active, onClick }) {
  return (
    <button type="button" className={`anpr-stop-card ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="anpr-stop-top">
        <span>{index + 1}</span>
        <b className="mono">{stop.camera}</b>
      </div>
      <strong>{stop.location}</strong>
      <small>{stop.action}</small>
      <div className="anpr-stop-foot">
        <span className="mono">{stop.time}</span>
        <b>{stop.confidence}%</b>
      </div>
    </button>
  );
}

export default function VehicleJourneyTracking() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedPlate = params.get('plate');
  const [selectedPlate, setSelectedPlate] = useState(ROUTES[requestedPlate] ? requestedPlate : plates[0]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const route = ROUTES[selectedPlate] || ROUTES[plates[0]];
  const active = route[activeIndex] || route[0];

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => setActiveIndex((index) => (index + 1) % route.length), 1400);
    return () => window.clearInterval(timer);
  }, [playing, route.length]);

  const summary = useMemo(() => [
    ['Plate', selectedPlate],
    ['Current Zone', active.location],
    ['Camera', active.camera],
    ['Confidence', `${active.confidence}%`],
  ], [active, selectedPlate]);

  return (
    <main className="anpr-journey-page">
      <div className="anpr-summary-grid">
        {summary.map(([label, value]) => (
          <div className="card" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <section className="card anpr-journey-shell">
        <div className="anpr-section-head compact">
          <div>
            <h2>Camera-by-Camera Vehicle Journey</h2>
            <p>{selectedPlate} / ANPR stitched route / click a stop to inspect evidence.</p>
          </div>
          <div className="anpr-journey-controls">
            <select value={selectedPlate} onChange={(event) => { setSelectedPlate(event.target.value); setActiveIndex(0); }}>
              {plates.map((plate) => <option key={plate}>{plate}</option>)}
            </select>
            <button className="btn btn-ghost icon-btn" onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}><span className="material-symbols-outlined">chevron_left</span></button>
            <button className="btn btn-primary icon-btn" onClick={() => setPlaying((value) => !value)}><span className="material-symbols-outlined">{playing ? 'pause' : 'play_arrow'}</span></button>
            <button className="btn btn-ghost icon-btn" onClick={() => setActiveIndex((i) => Math.min(route.length - 1, i + 1))}><span className="material-symbols-outlined">chevron_right</span></button>
          </div>
        </div>

        <div className="anpr-stop-strip">
          {route.map((stop, index) => (
            <StopCard key={`${stop.camera}-${stop.time}`} stop={stop} index={index} active={index === activeIndex} onClick={() => setActiveIndex(index)} />
          ))}
        </div>

        <div className="anpr-journey-grid">
          <div className="anpr-route-map">
            <div className="anpr-map-grid" />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline points={route.map((stop) => `${stop.x},${stop.y}`).join(' ')} fill="none" stroke="#F7983A" strokeWidth="1.4" strokeDasharray="3 2" />
            </svg>
            {route.map((stop, index) => (
              <button key={stop.camera} className={`anpr-map-pin ${index === activeIndex ? 'active' : ''}`} style={{ left: `${stop.x}%`, top: `${stop.y}%` }} onClick={() => setActiveIndex(index)}>
                <span>{index + 1}</span>
                <b>{stop.camera}</b>
              </button>
            ))}
            <div className="anpr-route-caption">
              <strong>{active.location}</strong>
              <span>{active.camera} / {active.time} / {active.action}</span>
            </div>
          </div>

          <aside className="anpr-segment-panel">
            <div className="card">
              <span className="section-label">Selected Segment</span>
              {[
                ['Plate', selectedPlate],
                ['Location', active.location],
                ['Camera', active.camera],
                ['Time', active.time],
                ['Action', active.action],
                ['ANPR Confidence', `${active.confidence}%`],
              ].map(([label, value]) => (
                <div className="anpr-fact-row" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="card anpr-relationship-cta">
              <span className="material-symbols-outlined">hub</span>
              <strong>Relationship Graph</strong>
              <p>Open the connection map for this vehicle, owner signals, cameras, incidents, and route evidence.</p>
              <button className="btn btn-primary" onClick={() => navigate(`/ai-analytics/vehicle/relationship?plate=${selectedPlate}`)}>Open Graph</button>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
