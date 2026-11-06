import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { severityLabels, todayActiveAlerts } from './aggressionIncidentData';
import AggressionReportModal from './AggressionReportModal';
// Optional demo clip — the media binaries aren't part of the checkout, so this
// resolves the file when present and yields null when it isn't, instead of
// failing the module graph at import time.
const demoClips = import.meta.glob('../../assets/*.webm', { eager: true, query: '?url', import: 'default' });
const fightDemoVideo = demoClips['../../assets/fight_0076.webm'] || null;

const LAYOUTS = [
  { id: 'single', label: 'Single', icon: 'crop_16_9', count: 1 },
  { id: '2x2', label: '2x2', icon: 'grid_view', count: 4 },
  { id: '3x3', label: '3x3', icon: 'apps', count: 9 },
];

const CAMERAS = [
  {
    id: 'CAM-FIGHT-01',
    loc: 'Residential Driveway',
    zone: 'Uploaded CCTV Demo',
    severity: 'critical',
    status: 'Fight detected',
    activity: 'High activity cluster',
    confidence: 97,
    time: '15:27:08',
    video: fightDemoVideo,
    detectionKeyframes: [
      [
        { left: '28%', top: '36%', width: '32%', height: '44%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '18%', top: '28%', width: '52%', height: '58%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '36%', top: '38%', width: '30%', height: '42%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '26%', top: '30%', width: '50%', height: '56%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '22%', top: '34%', width: '44%', height: '46%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '14%', top: '26%', width: '60%', height: '60%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '20%', top: '40%', width: '30%', height: '40%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '12%', top: '32%', width: '48%', height: '54%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '30%', top: '36%', width: '28%', height: '44%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '22%', top: '28%', width: '44%', height: '58%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '32%', top: '28%', width: '30%', height: '42%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '24%', top: '20%', width: '46%', height: '56%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '18%', top: '32%', width: '48%', height: '48%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '10%', top: '24%', width: '64%', height: '62%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
      [
        { left: '26%', top: '38%', width: '34%', height: '44%', color: '#ef4444', label: 'PHYSICAL FIGHT', labelBg: '#dc2626' },
        { left: '16%', top: '30%', width: '54%', height: '58%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
      ],
    ],
  },
  { id: 'CAM-07', loc: 'Main Road - East Gate', zone: 'Gate perimeter', severity: 'critical', status: 'Aggression', activity: 'High activity', confidence: 98, time: '14:22:11' },
  { id: 'CAM-03', loc: 'Main Concourse', zone: 'Public corridor', severity: 'high', status: 'Pushing', activity: 'Elevated activity', confidence: 91, time: '13:58:42' },
  { id: 'CAM-11', loc: 'Waiting Lounge', zone: 'Platform lobby', severity: 'medium', status: 'Crowding', activity: 'Crowded activity', confidence: 82, time: '13:41:09' },
  { id: 'CAM-15', loc: 'Food Court', zone: 'Retail bay', severity: 'clear', status: 'Clear', activity: 'Normal activity', confidence: 0, time: '13:18:26' },
  { id: 'CAM-19', loc: 'East Entrance', zone: 'Entry ramp', severity: 'high', status: 'Threat posture', activity: 'Elevated activity', confidence: 88, time: '12:54:17' },
  { id: 'CAM-22', loc: 'Security Gate B', zone: 'Checkpoint', severity: 'clear', status: 'Clear', activity: 'Normal activity', confidence: 0, time: '12:09:54' },
  { id: 'CAM-28', loc: 'Bus Bay', zone: 'Transit lane', severity: 'medium', status: 'Verbal clash', activity: 'Moderate activity', confidence: 76, time: '11:43:31' },
  { id: 'CAM-31', loc: 'Parking Exit', zone: 'Vehicle lane', severity: 'clear', status: 'Clear', activity: 'Normal activity', confidence: 0, time: '11:20:06' },
  { id: 'CAM-34', loc: 'North Stairwell', zone: 'Vertical core', severity: 'medium', status: 'Fall risk', activity: 'Moderate activity', confidence: 79, time: '10:47:22' },
];

const DAILY_ALERTS = todayActiveAlerts;

const actionLabels = {
  view_live: 'View Live',
  timeline: 'Incident Timeline',
  reid: 'Camera Trail',
  replay: 'Replay',
  acknowledge: 'Acknowledge',
  report: 'Create Report',
};

const DETECTION_BOXES = [
  { left: '22%', top: '26%', width: '58%', height: '54%', color: '#ef4444', label: 'AGGRESSION ACTIVITY', labelBg: '#dc2626' },
  { left: '16%', top: '34%', width: '72%', height: '48%', color: '#f59e0b', label: 'MOTION CLUSTER', labelBg: '#b45309' },
];

function CameraTile({ camera, selected, compact, onSelect }) {
  const hasAlert = camera.severity !== 'clear';
  const [frameIndex, setFrameIndex] = useState(0);
  const [detecting, setDetecting] = useState(!camera.detectionKeyframes);

  const boxes = camera.detectionKeyframes
    ? camera.detectionKeyframes[frameIndex % camera.detectionKeyframes.length]
    : camera.detections || DETECTION_BOXES;

  const handleTimeUpdate = (e) => {
    const t = e.currentTarget.currentTime;
    if (!detecting && t >= 5) setDetecting(true);
    if (!camera.detectionKeyframes) return;
    const newIdx = Math.floor(Math.max(0, t - 5) / 2) % camera.detectionKeyframes.length;
    setFrameIndex(prev => prev === newIdx ? prev : newIdx);
  };

  return (
    <button
      type="button"
      className={`aggression-feed-tile ${selected ? 'selected' : ''} ${hasAlert ? camera.severity : 'clear'} ${compact ? 'compact' : ''}`}
      onClick={() => onSelect(camera)}
    >
      {camera.video ? (
        <video
          src={camera.video}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          onTimeUpdate={handleTimeUpdate}
          aria-label={`${camera.id} ${camera.loc} aggression feed`}
        />
      ) : (
        <img src="/aggression-demo.jpg" alt={`${camera.id} ${camera.loc} feed`} />
      )}
      <span className="aggression-feed-noise" />
      <span className="aggression-feed-scanlines" />
      <motion.span
        className="aggression-feed-sweep"
        animate={{ top: ['2%', '96%'] }}
        transition={{ repeat: Infinity, duration: 4, ease: 'linear' }}
      />
      <span className="aggression-feed-topline">
        <strong>{camera.id}</strong>
        <span>{camera.time}</span>
      </span>
      <span className="aggression-feed-rec">
        <motion.i animate={{ opacity: [1, 0.1, 1] }} transition={{ repeat: Infinity, duration: 1.2 }} />
        REC
      </span>
      <span className={`aggression-feed-state ${camera.severity}`}>
        {hasAlert ? `${camera.status} ${camera.confidence}%` : 'Clear'}
      </span>
      <span className="aggression-feed-bottomline">
        <span>{camera.loc}</span>
        <span>{camera.activity}</span>
      </span>
      {hasAlert && detecting && (
        <>
          {boxes.map((box, index) => (
            <motion.span
              key={box.label + index}
              className="aggression-feed-person-box"
              animate={{ opacity: [0.85, 1, 0.85] }}
              transition={{ repeat: Infinity, duration: 2 + index * 0.3 }}
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                borderColor: box.color,
                background: `${box.color}12`,
                transition: 'left 0.6s ease, top 0.6s ease, width 0.6s ease, height 0.6s ease',
              }}
            >
              <span style={{ background: box.labelBg }}>{box.label}</span>
            </motion.span>
          ))}
          <span className="aggression-feed-zone">
            <motion.i animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 0.8 }} />
            VIOLENCE ZONE
          </span>
        </>
      )}
    </button>
  );
}

export default function AggressionLiveFeed() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState(CAMERAS[0]);
  const [layout, setLayout] = useState('single');
  const [filter, setFilter] = useState('all');
  const [alertUpdates, setAlertUpdates] = useState({});
  const [reportTarget, setReportTarget] = useState(null);

  const activeLayout = LAYOUTS.find(item => item.id === layout) || LAYOUTS[1];
  const filteredCameras = useMemo(() => {
    if (filter === 'alerts') return CAMERAS.filter(camera => camera.severity !== 'clear');
    return CAMERAS;
  }, [filter]);
  const visibleCameras = layout === 'single' ? [selected] : filteredCameras.slice(0, activeLayout.count);
  const alertCount = DAILY_ALERTS.length;

  const selectAlertCamera = alert => {
    const camera = CAMERAS.find(item => item.id === alert.camera);
    if (camera) setSelected(camera);
    setLayout('single');
  };

  const openIncidentTimeline = alert => {
    selectAlertCamera(alert);
    navigate(`/ai-analytics/aggression/timeline?incident=${encodeURIComponent(alert.id)}`);
  };

  const openIncidentReid = alert => {
    selectAlertCamera(alert);
    navigate(`/ai-analytics/aggression/reid?incident=${encodeURIComponent(alert.id)}&camera=${encodeURIComponent(alert.camera)}`);
  };

  const updateAlert = (alert, changes) => {
    setAlertUpdates(prev => ({
      ...prev,
      [alert.id]: {
        reviewStage: prev[alert.id]?.reviewStage || alert.reviewStage,
        reportStatus: prev[alert.id]?.reportStatus || alert.reportStatus,
        ...changes,
      },
    }));
  };

  const getCurrentAlert = alert => ({ ...alert, ...(alertUpdates[alert.id] || {}) });

  return (
    <main className="aggression-live-page">
      <header className="aggression-live-header">
        <div>
          <h2>Live Camera Feed</h2>
          <p>Real-time aggression monitoring across active site cameras</p>
        </div>
        <div className="aggression-live-actions">
          <div className="aggression-live-toggle" aria-label="Camera grid layout">
            {LAYOUTS.map(item => (
              <button
                key={item.id}
                type="button"
                className={layout === item.id ? 'active' : ''}
                onClick={() => setLayout(item.id)}
                title={item.label}
                aria-label={`${item.label} layout`}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
              </button>
            ))}
          </div>
          <select className="select" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All Cameras</option>
            <option value="alerts">Alert Only</option>
          </select>
        </div>
      </header>

      <section className="card aggression-live-panel">
        <div className="aggression-live-panel-header">
          <div>
            <h3>Live Aggression Detection Grid</h3>
            <span>{selected.id} selected - {selected.loc} - {severityLabels[selected.severity]} status</span>
          </div>
          <div className="aggression-live-summary">
            <span><i /> Live</span>
            <strong>{alertCount} active alerts today</strong>
          </div>
        </div>

        <div className={`aggression-camera-grid mode-${layout}`}>
          {visibleCameras.map(camera => (
            <CameraTile
              key={camera.id}
              camera={camera}
              selected={selected.id === camera.id}
              compact={layout === '3x3'}
              onSelect={setSelected}
            />
          ))}
        </div>
      </section>

      <section className="card aggression-alerts-panel">
        <div className="aggression-live-panel-header">
          <div>
            <h3>Today Active Alerts</h3>
            <span>Latest aggression events sorted by detection time</span>
          </div>
          <div className="aggression-alert-heading-actions">
            <strong className="aggression-alert-count">{DAILY_ALERTS.length}</strong>
            <button type="button" onClick={() => navigate('/ai-analytics/aggression/incidents?date=10%20Jun%202026&status=active')}>
              View All
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
          </div>
        </div>

        <div className="aggression-alert-scroll" aria-label="Today aggression alerts">
          {DAILY_ALERTS.map(alert => {
            const current = { ...alert, ...(alertUpdates[alert.id] || {}) };
            return (
              <article key={alert.id} className={`aggression-alert-row ${alert.severity}`}>
                <button
                  type="button"
                  className="aggression-alert-main"
                  onClick={() => selectAlertCamera(alert)}
                >
                  <span className="aggression-alert-icon">
                    <span className="material-symbols-outlined">warning</span>
                  </span>
                  <span className="aggression-alert-copy">
                    <span className="aggression-alert-titleline">
                      <strong>{alert.title}</strong>
                      <i>{alert.type}</i>
                    </span>
                    <small>{alert.detail}</small>
                    <em>{alert.id} - {alert.date} - {alert.time} - {alert.duration}</em>
                  </span>
                  <span className="aggression-alert-status">
                    <strong>{severityLabels[alert.severity]}</strong>
                    <small>{current.reviewStage}</small>
                  </span>
                </button>

                <div className="aggression-alert-params">
                  <span><strong>Camera</strong>{alert.camera}</span>
                  <span><strong>Zone</strong>{alert.zone}</span>
                  <span><strong>Status</strong>{alert.status}</span>
                  <span><strong>Duration</strong>{alert.duration}</span>
                  <span><strong>Confidence</strong>{alert.confidence}%</span>
                  <span><strong>Activity</strong>{alert.activity}</span>
                  <span><strong>Report</strong>{current.reportStatus}</span>
                </div>

                <div className="aggression-alert-actions" aria-label={`${alert.id} actions`}>
                  <button type="button" title={actionLabels.view_live} onClick={() => selectAlertCamera(alert)}>
                    <span className="material-symbols-outlined">videocam</span>
                  </button>
                  <button type="button" title={actionLabels.timeline} onClick={() => openIncidentTimeline(alert)}>
                    <span className="material-symbols-outlined">timeline</span>
                  </button>
                  <button type="button" title={actionLabels.reid} onClick={() => openIncidentReid(alert)}>
                    <span className="material-symbols-outlined">manage_search</span>
                  </button>
                  <button type="button" title={actionLabels.replay}>
                    <span className="material-symbols-outlined">replay</span>
                  </button>
                  <button
                    type="button"
                    title={actionLabels.acknowledge}
                    disabled={current.reviewStage === 'Acknowledged'}
                    onClick={() => updateAlert(alert, { reviewStage: 'Acknowledged' })}
                  >
                    <span className="material-symbols-outlined">done</span>
                  </button>
                  <button
                    type="button"
                    title={actionLabels.report}
                    onClick={() => setReportTarget(alert)}
                  >
                    <span className="material-symbols-outlined">description</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <AggressionReportModal
        incident={reportTarget ? getCurrentAlert(reportTarget) : null}
        onClose={() => setReportTarget(null)}
        onSubmit={(incident) => updateAlert(incident, { reportStatus: 'Submitted', reviewStage: 'Acknowledged' })}
      />
    </main>
  );
}
