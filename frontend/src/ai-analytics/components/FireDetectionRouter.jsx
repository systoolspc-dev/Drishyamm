import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
// WebP q82 at the originals' intrinsic size — these were already small enough
// to display 1:1, they were just stored as needlessly heavy PNGs.
import fireImg1 from '../assets/fire-1.webp';
import fireImg2 from '../assets/fire-2.webp';
import fireImg3 from '../assets/fire-3.webp';
import fireCctv from '../assets/fire-cctv.webp';
// Optional demo clip — the media binaries aren't part of the checkout, so this
// resolves the file when present and yields null when it isn't, instead of
// failing the module graph at import time.
const demoClips = import.meta.glob('../assets/*.mp4', { eager: true, query: '?url', import: 'default' });
const fireDemoVideo = demoClips['../assets/Security Camera Video of Fire at WLNE.mp4'] || null;

const FIRE_CAMERAS = [
  {
    id: 'CAM-FIRE-01',
    location: 'WLNE Office Corridor',
    signal: 'Flame and smoke detected',
    confidence: 98,
    severity: 'critical',
    time: '14:32:11',
    date: '2026-06-15',
    temperature: 92,
    zone: 'Office Floor',
    status: 'Active',
    video: fireDemoVideo,
    image: fireCctv,
    detectionSummary: 'Smoke forms at the lower-left equipment area before visible flame appears.',
    detectionStages: {
      smoke: {
        title: 'Smoke detected in live feed',
        signal: 'Smoke detected',
        summary: 'Smoke plume visible near lower-left equipment rack.',
        confidence: 91,
        severity: 'high',
        temperature: 58,
        icon: 'air',
        detections: [
          { label: 'Smoke plume', left: '0%', top: '42%', width: '22%', height: '44%', color: '#f97316' },
        ],
      },
      fire: {
        title: 'Fire detected in live feed',
        signal: 'Fire detected',
        summary: 'Open flame visible at lower-left equipment bench with smoke spread.',
        confidence: 98,
        severity: 'critical',
        temperature: 92,
        icon: 'local_fire_department',
        detections: [
          { label: 'Flame', left: '0%', top: '66%', width: '13%', height: '22%', color: '#dc2626' },
          { label: 'Smoke spread', left: '0%', top: '39%', width: '23%', height: '47%', color: '#f97316' },
        ],
      },
    },
  },
  { id: 'CAM-04', location: 'Kitchen Block', signal: 'Smoke plume', confidence: 94, severity: 'critical', time: '14:24:08', date: '2026-06-04', temperature: 78, zone: 'Food Court', status: 'Active' },
  { id: 'CAM-11', location: 'Generator Room', signal: 'Flame signature', confidence: 91, severity: 'critical', time: '14:21:32', date: '2026-06-04', temperature: 86, zone: 'Utility', status: 'Active' },
  { id: 'CAM-07', location: 'Loading Bay', signal: 'Heat haze anomaly', confidence: 82, severity: 'high', time: '14:16:55', date: '2026-06-04', temperature: 63, zone: 'Logistics', status: 'Active' },
  { id: 'CAM-02', location: 'Parking Level B1', signal: 'Smoke-like motion', confidence: 76, severity: 'warning', time: '14:09:41', date: '2026-06-04', temperature: 48, zone: 'Parking', status: 'Active' },
  { id: 'CAM-05', location: 'Electrical Panel A', signal: 'Breaker heat spike', confidence: 88, severity: 'high', time: '14:07:18', date: '2026-06-04', temperature: 69, zone: 'Electrical', status: 'Active' },
  { id: 'CAM-12', location: 'Food Court Duct', signal: 'Duct smoke trace', confidence: 84, severity: 'high', time: '14:04:52', date: '2026-06-04', temperature: 57, zone: 'Food Court', status: 'Active' },
  { id: 'CAM-15', location: 'Basement Store', signal: 'Low smoke layer', confidence: 79, severity: 'warning', time: '14:01:36', date: '2026-06-04', temperature: 46, zone: 'Storage', status: 'Active' },
  { id: 'CAM-06', location: 'Service Corridor', signal: 'Thermal movement', confidence: 74, severity: 'warning', time: '13:59:44', date: '2026-06-04', temperature: 43, zone: 'Service', status: 'Active' },
  { id: 'CAM-19', location: 'Laundry Utility', signal: 'Steam versus smoke review', confidence: 71, severity: 'warning', time: '13:56:28', date: '2026-06-04', temperature: 42, zone: 'Utility', status: 'Active' },
  { id: 'CAM-21', location: 'Atrium Cafe', signal: 'Flame-like reflection', confidence: 69, severity: 'warning', time: '13:53:09', date: '2026-06-04', temperature: 39, zone: 'Food Court', status: 'Active' },
  { id: 'CAM-16', location: 'Retail Storage', signal: 'Thermal rise', confidence: 72, severity: 'warning', time: '13:58:20', date: '2026-06-04', temperature: 44, zone: 'Retail', status: 'Review' },
  { id: 'CAM-09', location: 'South Exit', signal: 'Clear frame', confidence: 22, severity: 'clear', time: '13:54:12', date: '2026-06-04', temperature: 31, zone: 'Exit', status: 'Clear' },
  { id: 'CAM-13', location: 'Admin Pantry', signal: 'Steam cleared', confidence: 39, severity: 'clear', time: '2026-06-03 19:42:10', date: '2026-06-03', temperature: 34, zone: 'Admin', status: 'Resolved' },
  { id: 'CAM-18', location: 'North Store', signal: 'Smoke review', confidence: 68, severity: 'warning', time: '2026-06-03 18:15:22', date: '2026-06-03', temperature: 41, zone: 'Storage', status: 'Resolved' },
];

const SEVERITY = {
  critical: { label: 'Critical', color: '#dc2626', bg: '#fef2f2', border: '#fecaca', rank: 4 },
  high: { label: 'High', color: '#b45309', bg: '#fffbeb', border: '#fde68a', rank: 3 },
  warning: { label: 'Warning', color: '#b45309', bg: '#fffbeb', border: '#fde68a', rank: 2 },
  clear: { label: 'Clear', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0', rank: 1 },
};

const LAYOUTS = [
  { id: '2x2', label: '2x2', count: 4, columns: 2 },
  { id: '3x3', label: '3x3', count: 9, columns: 3 },
  { id: 'single', label: 'Single', count: 1, columns: 1 },
];

// Camera → fire image mapping (by location type)
const CAM_IMAGES = {
  'CAM-04': fireCctv,   // Kitchen Block → CCTV office fire
  'CAM-11': fireImg1,   // Generator Room → aerial/industrial fire
  'CAM-07': fireImg2,   // Loading Bay → building exterior fire
  'CAM-05': fireImg2,   // Electrical Panel A → building fire
  'CAM-12': fireImg3,   // Food Court Duct → office smoke fire
  'CAM-02': fireImg2,   // Parking Level B1 → exterior building fire
  'CAM-15': fireImg3,   // Basement Store → indoor smoke
  'CAM-06': fireCctv,   // Service Corridor → CCTV angle
  'CAM-21': fireImg3,   // Atrium Cafe → office/indoor fire
  'CAM-16': fireImg2,   // Retail Storage → building fire
};

function getCameraImg(camera) {
  if (camera.severity === 'clear') return null;
  if (camera.image) return camera.image;
  return CAM_IMAGES[camera.id] || (camera.severity === 'critical' ? fireCctv : fireImg2);
}

function expandFireAlerts(cameras) {
  return cameras.flatMap((item) => {
    if (item.id !== 'CAM-FIRE-01' || !item.detectionStages) return [item];
    return [
      {
        ...item,
        id: 'CAM-FIRE-01-SMOKE',
        cameraId: item.id,
        signal: item.detectionStages.smoke.signal,
        confidence: item.detectionStages.smoke.confidence,
        severity: item.detectionStages.smoke.severity,
        temperature: item.detectionStages.smoke.temperature,
        time: '14:32:04',
        eventType: 'SMOKE',
        detectionSummary: item.detectionStages.smoke.summary,
      },
      {
        ...item,
        id: 'CAM-FIRE-01-FIRE',
        cameraId: item.id,
        signal: item.detectionStages.fire.signal,
        confidence: item.detectionStages.fire.confidence,
        severity: item.detectionStages.fire.severity,
        temperature: item.detectionStages.fire.temperature,
        time: '14:32:15',
        eventType: 'FIRE',
        detectionSummary: item.detectionStages.fire.summary,
      },
    ];
  });
}

const baseActiveAlerts = expandFireAlerts(FIRE_CAMERAS.filter((item) => item.status === 'Active' && item.id !== 'CAM-FIRE-01'));

function getDemoFireAlerts(stage) {
  if (stage === 'fire') return expandFireAlerts(FIRE_CAMERAS.slice(0, 1));
  if (stage === 'smoke') return expandFireAlerts(FIRE_CAMERAS.slice(0, 1)).slice(0, 1);
  return [];
}

function getActiveFireAlerts(stage) {
  return [...getDemoFireAlerts(stage), ...baseActiveAlerts];
}

function StatCard({ label, value, icon, tone = 'var(--color-info-text)', bg = 'var(--color-primary-bg)', border = 'var(--color-border-accent)' }) {
  return (
    <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 42, height: 42, borderRadius: 10, background: bg, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-outlined icon-filled" style={{ color: tone, fontSize: 20 }}>{icon}</span>
      </div>
      <div>
        <div style={{ fontSize: 22, lineHeight: 1, fontWeight: 800, color: 'var(--color-on-bg)' }}>{value}</div>
        <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>{label}</div>
      </div>
    </div>
  );
}

function SeverityPill({ severity }) {
  const sev = SEVERITY[severity] || SEVERITY.warning;
  return (
    <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 99, color: sev.color, background: sev.bg, border: `1px solid ${sev.border}`, whiteSpace: 'nowrap' }}>
      {sev.label}
    </span>
  );
}

function FireCameraTile({ camera, active, layout, onSelect, onDemoStageChange }) {
  const [videoTime, setVideoTime] = useState(0);
  const sev = SEVERITY[camera.severity] || SEVERITY.warning;
  const large = layout === 'single';
  const isClear = camera.severity === 'clear';
  const camImg = getCameraImg(camera);
  const hasVideo = Boolean(camera.video);
  const smokeVisible = hasVideo && videoTime >= 4 && videoTime < 14;
  const fireVisible = hasVideo && videoTime >= 14;
  const activeStage = fireVisible ? camera.detectionStages?.fire : smokeVisible ? camera.detectionStages?.smoke : null;
  const activeSeverity = activeStage?.severity || camera.severity;
  const activeSev = SEVERITY[activeSeverity] || sev;
  const activeSignal = activeStage?.signal || camera.signal;
  const activeConfidence = activeStage?.confidence || camera.confidence;
  const activeTemperature = activeStage?.temperature || camera.temperature;
  const detectionBoxes = activeStage?.detections || camera.detections || null;
  // Detection box offset varies per camera so each tile looks unique
  const camNum = Number(camera.id.replace('CAM-', '')) || 4;
  const boxLeft = 20 + (camNum % 5) * 8;
  const boxTop  = 18 + (camNum % 4) * 10;

  useEffect(() => {
    if (!hasVideo || !onDemoStageChange) return;
    onDemoStageChange(fireVisible ? 'fire' : smokeVisible ? 'smoke' : 'none');
  }, [fireVisible, hasVideo, onDemoStageChange, smokeVisible]);

  return (
    <button
      type="button"
      onClick={() => onSelect(camera.id)}
      style={{
        position: 'relative',
        minHeight: hasVideo ? undefined : large ? 540 : layout === '2x2' ? 255 : 168,
        aspectRatio: hasVideo ? '16 / 9' : undefined,
        background: '#07100c',
        border: `2px solid ${active ? activeSev.color : '#263a32'}`,
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: active ? `0 0 0 3px ${activeSev.color}26` : 'none',
      }}
    >
      {/* Live fire feed */}
      {hasVideo ? (
        <video
          src={camera.video}
          poster={camImg || undefined}
          autoPlay
          muted
          loop
          playsInline
          onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: isClear ? 0.28 : 0.84,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
          aria-label={`${camera.id} fire detection video feed`}
        />
      ) : camImg && (
        <img
          src={camImg}
          alt={`${camera.id} live feed`}
          draggable={false}
          loading="lazy"
          decoding="async"
          width={640}
          height={360}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: isClear ? 0.28 : 0.78,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Scanline + vignette overlay */}
      <div style={{
        position: 'absolute', inset: 0,
        background: camImg || hasVideo
          ? 'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.10) 3px,rgba(0,0,0,.10) 4px), radial-gradient(circle at 50% 50%,transparent 55%,rgba(0,0,0,.55) 100%)'
          : 'radial-gradient(circle at 52% 38%,rgba(239,68,68,.18),transparent 18%), repeating-linear-gradient(90deg,rgba(255,255,255,.025) 0 1px,transparent 1px 34px),repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 1px,transparent 1px 34px)',
        pointerEvents: 'none',
      }} />

      {/* Status badge */}
      <span style={{
        position: 'absolute', top: 10, left: 10,
        background: isClear ? '#15803d' : activeSeverity === 'critical' ? '#dc2626' : '#b45309',
        color: '#fff', fontSize: 9, fontWeight: 800,
        padding: '2px 8px', borderRadius: 4, letterSpacing: '.05em',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        {!isClear && <span style={{ width: 6, height: 6, borderRadius: 99, background: '#fff', display: 'inline-block', animation: 'pulse 1.2s infinite' }} />}
        {isClear ? 'CLEAR' : fireVisible ? 'FIRE ALERT' : smokeVisible ? 'SMOKE ALERT' : 'LIVE FIRE'}
      </span>

      {/* Timestamp */}
      <span className="mono" style={{ position: 'absolute', top: 10, right: 10, color: 'rgba(255,255,255,.82)', fontSize: 10, background: 'rgba(0,0,0,.42)', padding: '2px 6px', borderRadius: 4 }}>
        {camera.time}
      </span>

      {hasVideo && large && activeStage && (
        <div style={{
          position: 'absolute',
          top: 48,
          left: 10,
          zIndex: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          maxWidth: 'min(430px, calc(100% - 20px))',
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${activeSev.border}`,
          background: activeSeverity === 'critical' ? 'rgba(127,29,29,.88)' : 'rgba(120,53,15,.88)',
          color: '#fff',
          boxShadow: '0 18px 38px rgba(0,0,0,.36)',
        }}>
          <span className="material-symbols-outlined icon-filled" style={{ color: activeSeverity === 'critical' ? '#fecaca' : '#fed7aa', fontSize: 22 }}>{activeStage.icon}</span>
          <div>
            <strong style={{ display: 'block', fontSize: 12, fontWeight: 950 }}>{activeStage.title}</strong>
            <small style={{ display: 'block', marginTop: 3, color: 'rgba(255,255,255,.78)', fontSize: 10, fontWeight: 750 }}>
              {activeStage.summary} / {activeConfidence}% confidence
            </small>
          </div>
        </div>
      )}

      {/* AI detection bounding boxes */}
      {!isClear && detectionBoxes?.map((box, index) => (
        <div
          key={`${box.label}-${index}`}
          style={{
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: `2px solid ${box.color}`,
            borderRadius: 4,
            boxShadow: `0 0 18px ${box.color}90, inset 0 0 18px ${box.color}20`,
            zIndex: 2,
          }}
        >
          <div style={{
            position: 'absolute',
            top: large ? -26 : -20,
            left: -2,
            background: box.color,
            color: '#fff',
            fontSize: large ? 10 : 8,
            fontWeight: 900,
            padding: large ? '3px 8px' : '2px 6px',
            borderRadius: '4px 4px 4px 0',
            whiteSpace: 'nowrap',
          }}>
            {box.label} / {activeConfidence}%
          </div>
        </div>
      ))}

      {!isClear && !hasVideo && !detectionBoxes && (
        <div style={{
          position: 'absolute',
          left: `${boxLeft}%`,
          top: `${boxTop}%`,
          width: large ? '20%' : '25%',
          height: large ? '32%' : '34%',
          border: `2px solid ${sev.color}`,
          borderRadius: 4,
          boxShadow: `0 0 18px ${sev.color}90, inset 0 0 18px ${sev.color}20`,
        }}>
          {/* Corner accents */}
          {[['0','0','br'],['auto','0','bl'],['0','auto','tr'],['auto','auto','tl']].map(([t,b,key]) => (
            <span key={key} style={{
              position: 'absolute',
              top: t === 'auto' ? 'auto' : -1,
              bottom: b === 'auto' ? 'auto' : -1,
              left: key.endsWith('r') ? 'auto' : -1,
              right: key.endsWith('l') ? 'auto' : -1,
              width: 8, height: 8,
              borderTop: key.startsWith('t') ? `3px solid ${sev.color}` : 'none',
              borderBottom: key.startsWith('b') ? `3px solid ${sev.color}` : 'none',
              borderLeft: key.endsWith('r') ? `3px solid ${sev.color}` : 'none',
              borderRight: key.endsWith('l') ? `3px solid ${sev.color}` : 'none',
            }} />
          ))}
          <div style={{
            position: 'absolute', top: large ? -26 : -20, left: -2,
            background: sev.color, color: '#fff',
            fontSize: large ? 10 : 8, fontWeight: 800,
            padding: large ? '3px 8px' : '2px 6px',
            borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap',
          }}>
            {camera.signal} · {camera.confidence}%
          </div>
        </div>
      )}

      {/* Temperature badge */}
      {!isClear && (
        <div style={{
          position: 'absolute', top: 38, right: 10,
          background: 'rgba(0,0,0,.60)', color: activeTemperature > 65 ? '#f87171' : '#fbbf24',
          fontSize: large ? 13 : 10, fontWeight: 800,
          padding: '3px 7px', borderRadius: 6,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: large ? 13 : 10 }}>thermostat</span>
          {activeTemperature}°C
        </div>
      )}

      {/* Bottom metadata bar */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        background: 'linear-gradient(transparent, rgba(0,0,0,.82) 40%)',
        padding: large ? '32px 14px 12px' : '22px 10px 8px',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: large ? 15 : 12, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {camera.id} · {camera.location}
          </div>
          <div style={{ color: 'rgba(255,255,255,.62)', fontSize: large ? 11 : 9, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {camera.zone} · {activeSignal}
          </div>
        </div>
        <span style={{
          flexShrink: 0, fontSize: large ? 11 : 9, fontWeight: 800,
          color: activeSev.color, background: 'rgba(0,0,0,.68)',
          padding: '3px 8px', borderRadius: 99,
          border: `1px solid ${activeSev.color}60`,
        }}>
          {activeSev.label}
        </span>
      </div>
    </button>
  );
}

function FireLiveFeed({ onDemoStageChange }) {
  const [activeCam, setActiveCam] = useState('CAM-FIRE-01');
  const [layout, setLayout] = useState('single');
  const [sortMode, setSortMode] = useState('urgency');
  const activeLayout = LAYOUTS.find((item) => item.id === layout) || LAYOUTS[0];
  const active = FIRE_CAMERAS.find((camera) => camera.id === activeCam) || FIRE_CAMERAS[0];
  const cameras = [...FIRE_CAMERAS].sort((a, b) => {
    if (sortMode === 'confidence') return b.confidence - a.confidence;
    if (sortMode === 'temperature') return b.temperature - a.temperature;
    return (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0) || b.confidence - a.confidence;
  });
  const visibleCameras = layout === 'single' ? [active] : cameras.slice(0, activeLayout.count);

  return (
    <div className="page-inner" style={{ maxWidth: 'none' }}>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>Live Fire Detection Feed</h3>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{active.id} selected - smoke warning transitions to fire alert on the same evidence clip</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {LAYOUTS.map((item) => (
                <button key={item.id} type="button" onClick={() => setLayout(item.id)} style={{ height: 32, padding: '0 12px', border: `1px solid ${layout === item.id ? '#dc2626' : 'var(--color-border)'}`, background: layout === item.id ? '#fef2f2' : 'var(--color-surface)', color: layout === item.id ? '#dc2626' : 'var(--color-text-secondary)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>
                  {item.label}
                </button>
              ))}
            </div>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: '6px 8px', fontSize: 11, background: 'var(--color-surface)', color: 'var(--color-on-bg)', outline: 'none' }}>
              <option value="urgency">Urgency</option>
              <option value="confidence">Confidence</option>
              <option value="temperature">Temperature</option>
            </select>
          </div>
        </div>
        <div style={{ padding: 14, background: '#000' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${activeLayout.columns}, minmax(0, 1fr))`, gap: 12 }}>
            {visibleCameras.map((camera) => (
              <FireCameraTile key={camera.id} camera={camera} active={camera.id === activeCam} layout={layout} onSelect={setActiveCam} onDemoStageChange={onDemoStageChange} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function AlertsList({ alerts, compact = false }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      {alerts.map((alert) => {
        const alertImg = getCameraImg(alert);
        return (
          <div
            key={`${alert.id}-${alert.time}`}
            style={{
              minWidth: compact ? 0 : 720,
              padding: '10px 18px',
              borderBottom: '1px solid var(--color-border)',
              display: 'grid',
              gridTemplateColumns: compact ? '1fr auto' : 'minmax(230px, 1.4fr) repeat(5, minmax(95px, 1fr))',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0, display: 'flex', gap: 11, alignItems: 'center' }}>
              {/* Thumbnail or icon */}
              <div style={{
                width: compact ? 44 : 64,
                height: compact ? 36 : 46,
                borderRadius: 8,
                overflow: 'hidden',
                border: `1px solid ${alert.severity === 'critical' ? 'rgba(220,38,38,.4)' : 'rgba(180,83,9,.3)'}`,
                flexShrink: 0,
                position: 'relative',
                background: '#07100c',
              }}>
                {alert.video ? (
                  <video src={alert.video} poster={alertImg || undefined} muted loop autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.9 }} />
                ) : alertImg ? (
                  <img src={alertImg} alt={`${alert.id} capture`} loading="lazy" decoding="async" width={640} height={360} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.88 }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-danger-bg)' }}>
                    <span className="material-symbols-outlined icon-filled" style={{ color: '#dc2626', fontSize: 20 }}>local_fire_department</span>
                  </div>
                )}
                {(alertImg || alert.video) && (
                  <span style={{ position: 'absolute', bottom: 2, right: 2, fontSize: 7, fontWeight: 800, background: alert.severity === 'critical' ? '#dc2626' : '#b45309', color: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                    {alert.confidence}%
                  </span>
                )}
              </div>

              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13, color: 'var(--color-on-bg)', display: 'block' }}>{alert.signal}</strong>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{alert.cameraId || alert.id} · {alert.location}{alert.eventType ? ` · ${alert.eventType}` : ''}</div>
                {compact && <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 1 }}>{alert.temperature}°C</div>}
              </div>
            </div>

            {compact ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                <SeverityPill severity={alert.severity} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{alert.time}</span>
              </div>
            ) : (
              <>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{alert.date}</span>
                <span className="mono" style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{alert.time}</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{alert.zone}</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{alert.temperature}°C / {alert.confidence}%</span>
                <SeverityPill severity={alert.severity} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActiveFireAlerts({ alerts }) {
  const navigate = useNavigate();

  return (
    <div className="page-inner" style={{ maxWidth: 'none' }}>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>Active Fire Alerts</h3>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>Only live smoke, flame and thermal anomalies that need attention.</p>
          </div>
          <button className="btn btn-primary" type="button" onClick={() => navigate('/ai-analytics/fire/all')}>
            <span className="material-symbols-outlined icon-sm">calendar_month</span>
            View All
          </button>
        </div>
        <div className="fire-alerts-page-list">
          <AlertsList alerts={alerts} />
        </div>
      </section>
    </div>
  );
}

function ViewAllFireAlerts({ demoStage }) {
  const [filters, setFilters] = useState({ date: 'all', severity: 'all', camera: 'all', zone: 'all' });
  const allAlerts = useMemo(() => [
    ...getDemoFireAlerts(demoStage),
    ...expandFireAlerts(FIRE_CAMERAS.filter((item) => item.id !== 'CAM-FIRE-01')),
  ], [demoStage]);
  const dates = [...new Set(allAlerts.map((item) => item.date))];
  const cameras = [...new Set(allAlerts.map((item) => item.cameraId || item.id))];
  const zones = [...new Set(allAlerts.map((item) => item.zone))];
  const filteredAlerts = useMemo(() => allAlerts.filter((item) => (
    (filters.date === 'all' || item.date === filters.date)
    && (filters.severity === 'all' || item.severity === filters.severity)
    && (filters.camera === 'all' || (item.cameraId || item.id) === filters.camera)
    && (filters.zone === 'all' || item.zone === filters.zone)
  )), [allAlerts, filters]);
  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <div className="page-inner" style={{ maxWidth: 'none' }}>
      <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>View All Fire Alerts</h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>Filter detections by date, severity, camera and zone.</p>
        </div>
        <div style={{ padding: 14, borderBottom: '1px solid var(--color-border)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <select value={filters.date} onChange={(event) => setFilter('date', event.target.value)} style={filterStyle}>
            <option value="all">All dates</option>
            {dates.map((date) => <option key={date} value={date}>{date}</option>)}
          </select>
          <select value={filters.severity} onChange={(event) => setFilter('severity', event.target.value)} style={filterStyle}>
            <option value="all">All severity</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="warning">Warning</option>
            <option value="clear">Clear</option>
          </select>
          <select value={filters.camera} onChange={(event) => setFilter('camera', event.target.value)} style={filterStyle}>
            <option value="all">All cameras</option>
            {cameras.map((camera) => <option key={camera} value={camera}>{camera}</option>)}
          </select>
          <select value={filters.zone} onChange={(event) => setFilter('zone', event.target.value)} style={filterStyle}>
            <option value="all">All zones</option>
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </div>
        <AlertsList alerts={filteredAlerts} />
      </section>
    </div>
  );
}

function FireOverview({ alerts, onDemoStageChange }) {
  const navigate = useNavigate();

  return (
    <div className="page-inner" style={{ maxWidth: 'none' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <StatCard label="Active Fire Alerts" value={alerts.length} icon="local_fire_department" tone="var(--color-danger-text)" bg="var(--color-danger-bg)" border="var(--color-danger-text)" />
        <StatCard label="Cameras Monitoring" value={18} icon="videocam" />
        <StatCard label="Critical Zones" value={2} icon="warning" tone="#b45309" bg="#fffbeb" border="#fde68a" />
        <StatCard label="Avg Confidence" value="86%" icon="analytics" tone="var(--color-success-text)" bg="var(--color-success-bg)" border="var(--color-success-border)" />
      </div>

      <div className="fire-overview-main-grid">
        <section className="card fire-overview-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>Live Fire Detection Feed</h3>
              <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 0' }}>Smoke, flame and thermal anomaly model output</p>
            </div>
            <button className="btn btn-ghost" type="button" onClick={() => navigate('/ai-analytics/fire/live')}>
              <span className="material-symbols-outlined icon-sm">videocam</span>
              Open
            </button>
          </div>
          <FireCameraTile camera={FIRE_CAMERAS[0]} active layout="single" onSelect={() => navigate('/ai-analytics/fire/live')} onDemoStageChange={onDemoStageChange} />
        </section>

        <section className="card fire-overview-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>Active Fire Alerts</h3>
            <button className="btn btn-ghost" type="button" onClick={() => navigate('/ai-analytics/fire/all')}>
              View All
            </button>
          </div>
          <div className="fire-overview-alert-list">
            <AlertsList alerts={alerts} compact />
          </div>
        </section>
      </div>
    </div>
  );
}

const filterStyle = {
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-on-bg)',
  outline: 'none',
};

export default function FireDetectionRouter() {
  const [demoStage, setDemoStage] = useState('none');
  const activeAlerts = getActiveFireAlerts(demoStage);

  return (
    <div className="page-content">
      <Routes>
        <Route index element={<FireOverview alerts={activeAlerts} onDemoStageChange={setDemoStage} />} />
        <Route path="live" element={<FireLiveFeed onDemoStageChange={setDemoStage} />} />
        <Route path="alerts" element={<ActiveFireAlerts alerts={activeAlerts} />} />
        <Route path="all" element={<ViewAllFireAlerts demoStage={demoStage} />} />
        <Route path="zones" element={<Navigate to="../all" replace />} />
        <Route path="analytics" element={<Navigate to="../all" replace />} />
        <Route path="evidence" element={<Navigate to="../all" replace />} />
      </Routes>
    </div>
  );
}
