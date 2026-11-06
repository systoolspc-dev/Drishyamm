import { useState, useRef, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { weaponDetectionService } from './weaponDetectionService';
// Optional demo clip — the media binaries aren't part of the checkout, so this
// resolves the file when present and yields null when it isn't, instead of
// failing the module graph at import time.
const demoClips = import.meta.glob('../../assets/*.webm', { eager: true, query: '?url', import: 'default' });
const weaponDemoVideo = demoClips['../../assets/weapondetection video demo.webm'] || null;

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
const CAMERAS = Object.keys(CAMERA_NAMES);
const GRID_MODES = [
  { id: 'single', label: 'Single', icon: 'crop_16_9', count: 1 },
  { id: '2x2', label: '2x2', icon: 'grid_view', count: 4 },
  { id: '3x3', label: '3x3', icon: 'apps', count: 9 },
];

const BOX_COLORS = {
  gun:    { stroke: '#ef4444', fill: 'rgba(239,68,68,0.15)',  label: '#ef4444' },
  knife:  { stroke: '#b45309', fill: 'rgba(249,115,22,0.15)', label: '#b45309' },
  person: { stroke: '#3b82f6', fill: 'rgba(59,130,246,0.10)', label: '#3b82f6' },
};

const GUN_VISIBLE_SECOND = 2;
const GUN_VISIBLE_WINDOW = 0.6;

function drawDetections(canvas, img, detections) {
  if (!canvas || !img) return;
  const { naturalWidth, naturalHeight, offsetWidth, offsetHeight } = img;
  canvas.width  = offsetWidth;
  canvas.height = offsetHeight;
  const sx = offsetWidth  / naturalWidth;
  const sy = offsetHeight / naturalHeight;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const det of detections) {
    const [x1, y1, x2, y2] = det.bbox;
    const rx = x1 * sx, ry = y1 * sy;
    const rw = (x2 - x1) * sx, rh = (y2 - y1) * sy;
    const c  = BOX_COLORS[det.class] || BOX_COLORS.person;

    ctx.fillStyle   = c.fill;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = c.stroke;
    ctx.lineWidth   = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    const label = `${det.class.toUpperCase()}  ${(det.confidence * 100).toFixed(0)}%`;
    ctx.font      = 'bold 11px monospace';
    const tw      = ctx.measureText(label).width + 10;
    const lh      = 18;
    const ly      = ry - lh - 2 < 0 ? ry + 2 : ry - lh - 2;
    ctx.fillStyle = c.stroke;
    ctx.beginPath();
    ctx.roundRect(rx, ly, tw, lh, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(label, rx + 5, ly + 13);
  }
}

function SignalBars({ strength = 4 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} style={{
          width: 3,
          height: 3 + i * 2,
          borderRadius: 1,
          background: i <= strength ? '#22c55e' : 'rgba(255,255,255,0.2)',
        }} />
      ))}
    </div>
  );
}

function getCameraLabel(cameraId) {
  return `${CAMERA_NAMES[cameraId] || 'Camera'} - ${cameraId}`;
}

function useTime() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function CameraGridTile({ cam, active, alert, index, timestamp, onSelect }) {
  const hasThreat = active || index === 1 || index === 4;
  const confidence = hasThreat ? (alert?.confidence ? Math.round(parseFloat(alert.confidence) * 100) : 98) : 0;
  const weaponType = alert?.metadata?.weaponType || (index === 1 ? 'Pistol' : index === 4 ? 'Knife' : 'Rifle');

  return (
    <button
      type="button"
      className={`weapon-grid-camera ${active ? 'active' : ''} ${hasThreat ? 'critical' : ''}`}
      onClick={onSelect}
    >
      <img src="/weapon-demo.jpg" alt={`${getCameraLabel(cam)} live feed`} />
      <span className="weapon-grid-scanline" />
      <span className="weapon-grid-camera-id">{getCameraLabel(cam)}</span>
      <span className="weapon-grid-time">{timestamp}</span>
      <span className={`weapon-grid-state ${hasThreat ? 'critical' : 'clear'}`}>
        {hasThreat ? `${weaponType} ${confidence}%` : 'Clear'}
      </span>
      {hasThreat && (
        <span className="weapon-grid-box">
          <span>{weaponType.toUpperCase()}</span>
        </span>
      )}
    </button>
  );
}

export default function TacticalFeed({ alert, focusedCamera, activeFeedAlert, onWeaponAlert }) {
  const alertArmedRef = useRef(true);
  const [activeCam, setActiveCam]   = useState(3);
  const [feedLayout, setFeedLayout] = useState('single');
  const [imageUrl,  setImageUrl]    = useState(null);
  const [detections, setDetections] = useState(null);
  const [loading,   setLoading]     = useState(false);
  const [error,     setError]       = useState(null);
  const [fps,       setFps]         = useState(29);
  const [videoTime, setVideoTime]   = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const imgRef        = useRef(null);
  const canvasRef     = useRef(null);
  const sceneWrapRef  = useRef(null);

  const now       = useTime();
  const timestamp = now.toLocaleTimeString('en-US', { hour12: false });
  const dateStr   = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });

  useEffect(() => {
    if (!focusedCamera) return;
    const index = CAMERAS.indexOf(focusedCamera);
    if (index >= 0) setActiveCam(index);
  }, [focusedCamera]);

  useEffect(() => {
    const id = setInterval(() => {
      setFps(prev => Math.max(24, Math.min(30, prev + Math.floor(Math.random() * 3) - 1)));
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Native fullscreen for the live feed. Keep React state in sync with the
  // browser (so Esc / OS-level exit flips the icon back too).
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === sceneWrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = sceneWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const gunVisible = !imageUrl && feedLayout === 'single' && Math.abs(videoTime - GUN_VISIBLE_SECOND) <= GUN_VISIBLE_WINDOW;

  useEffect(() => {
    if (!gunVisible) {
      if (Math.abs(videoTime - GUN_VISIBLE_SECOND) > GUN_VISIBLE_WINDOW) alertArmedRef.current = true;
      return;
    }
    if (!alertArmedRef.current) return;

    alertArmedRef.current = false;
    onWeaponAlert?.({
      id: `weapon-video-${Date.now()}`,
      weapon_id: 'WEAP-HGN-VIDEO-001',
      incident_id: 'WPN-DEMO-001',
      metadata: { weaponType: 'Handgun' },
      confidence: 0.98,
      location: CAMERA_NAMES[CAMERAS[activeCam]] || 'Main Gate',
      camera_id: CAMERAS[activeCam],
      created_at: new Date().toISOString(),
      severity: 'critical',
      status: 'active',
      event_type: 'weapon_detected',
      description: 'Handgun visible in live tactical feed. Alert generated from weapon overview video.',
    });
  }, [activeCam, gunVisible, imageUrl, feedLayout, onWeaponAlert, videoTime]);

  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    setError(null);
    setDetections(null);

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setLoading(true);

    try {
      const result = await weaponDetectionService.predict(file, {
        cameraId: CAMERAS[activeCam],
        location: 'Tactical Feed',
      });
      setDetections(result.detections);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeCam]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onImageLoad = useCallback(() => {
    if (detections) drawDetections(canvasRef.current, imgRef.current, detections);
  }, [detections]);

  const prevDetections = useRef(null);
  if (detections !== prevDetections.current) {
    prevDetections.current = detections;
    if (detections && imgRef.current?.complete) {
      drawDetections(canvasRef.current, imgRef.current, detections);
    }
  }

  const weaponHits = detections?.filter(d => d.class !== 'person') ?? [];

  return (
    <div className="card weapon-card weapon-tactical-feed">
      <div className="weapon-feed-header">
        <div className="weapon-feed-title">
          <motion.div
            animate={{ opacity: [1, 0.45, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="weapon-live-pill"
          >
            <span />Live
          </motion.div>
          <h3>Live Tactical Feed - {getCameraLabel(CAMERAS[activeCam])}</h3>
        </div>
        <div className="weapon-feed-controls">
          <div className="weapon-layout-toggle" aria-label="Feed layout">
            {GRID_MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                className={feedLayout === mode.id ? 'active' : ''}
                onClick={() => setFeedLayout(mode.id)}
                title={mode.label}
                aria-label={`${mode.label} layout`}
              >
                <span className="material-symbols-outlined">{mode.icon}</span>
              </button>
            ))}
          </div>
          <div className="weapon-signal">
            <span className="material-symbols-outlined">network_wifi</span>
            <strong>{timestamp}</strong>
          </div>
        </div>
      </div>

      {/* Viewport */}
      <div
        className="weapon-video-shell"
        style={{ position: 'relative', cursor: 'default' }}
      >
        {feedLayout !== 'single' && !imageUrl ? (
          <div className={`weapon-feed-grid mode-${feedLayout}`}>
            {Array.from({ length: GRID_MODES.find(mode => mode.id === feedLayout)?.count || 4 }).map((_, index) => {
              const cam = CAMERAS[index % CAMERAS.length];
              return (
                <CameraGridTile
                  key={`${feedLayout}-${cam}-${index}`}
                  cam={cam}
                  index={index}
                  active={index === activeCam}
                  alert={alert}
                  timestamp={timestamp}
                  onSelect={() => setActiveCam(index % CAMERAS.length)}
                />
              );
            })}
          </div>
        ) : imageUrl ? (
          <div style={{ position: 'relative', width: '100%', lineHeight: 0 }}>
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Uploaded frame"
              onLoad={onImageLoad}
              style={{ width: '100%', display: 'block', borderRadius: 0 }}
            />
            <canvas
              ref={canvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            />

            {loading && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 10,
              }}>
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                  style={{ width: 32, height: 32, border: '3px solid rgba(255,255,255,.2)', borderTopColor: '#0A1F44', borderRadius: '50%' }}
                />
                <span style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>Running YOLO modelâ€¦</span>
              </div>
            )}

            {!loading && detections && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: weaponHits.length > 0 ? 'rgba(220,38,38,0.9)' : 'rgba(22,163,74,0.9)',
                padding: '6px 12px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>
                  {weaponHits.length > 0
                    ? `âš  ${weaponHits.length} weapon${weaponHits.length > 1 ? 's' : ''} detected`
                    : 'âœ“ No weapons detected'}
                </span>
                <button
                  onClick={() => { setImageUrl(null); setDetections(null); setError(null); }}
                  style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                >
                  Clear
                </button>
              </div>
            )}

            {error && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: 'rgba(127,29,29,0.95)', padding: '8px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span className="material-symbols-outlined" style={{ color: '#fca5a5', fontSize: 16 }}>error</span>
                <span style={{ color: '#fca5a5', fontSize: 11 }}>{error}</span>
              </div>
            )}
          </div>
        ) : (
          /* â”€â”€ Default: real CCTV capture with full HUD overlays â”€â”€ */
          <div
            ref={sceneWrapRef}
            style={isFullscreen ? {
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 'var(--app-vw)', height: 'var(--app-vh)', background: '#000',
            } : undefined}
          >
          <div
            className="weapon-video-scene"
            style={isFullscreen ? {
              position: 'relative', overflow: 'hidden',
              width: 'min(var(--app-vw), calc(var(--app-vh) * 16 / 9))', maxWidth: 'none',
              margin: 0, height: 'auto', minHeight: 0, aspectRatio: '16 / 9', borderRadius: 0,
            } : {
              position: 'relative',
              overflow: 'hidden',
              width: '100%',
              maxWidth: 1120,
              margin: '0 auto',
              height: 'auto',
              minHeight: 0,
              aspectRatio: '16 / 9',
              borderRadius: 14,
              boxShadow: '0 18px 44px -22px rgba(2,6,23,0.55)',
            }}
          >
            <video
              className="weapon-demo-video"
              src={weaponDemoVideo}
              alt="Live feed"
              autoPlay
              muted
              loop
              playsInline
              onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center center', display: 'block' }}
            />

            {/* CCTV grain texture */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, opacity: 0.06,
              backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
              backgroundSize: '180px 180px',
            }} />

            {/* Scanline overlay */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
              background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,.07) 2px, rgba(0,0,0,.07) 4px)',
            }} />

            {activeFeedAlert && (
              <div style={{
                position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
                boxShadow: 'inset 0 0 90px rgba(220,38,38,.30)',
              }} />
            )}

            {/* AI scan sweep line */}
            <motion.div
              animate={{ top: ['2%', '98%'] }}
              transition={{ repeat: Infinity, duration: 3.5, ease: 'linear' }}
              style={{
                position: 'absolute', left: 0, right: 0, height: 2, zIndex: 6, pointerEvents: 'none',
                background: 'linear-gradient(90deg, transparent 0%, rgba(251,191,36,0.0) 10%, rgba(251,191,36,0.5) 40%, rgba(251,191,36,0.7) 50%, rgba(251,191,36,0.5) 60%, rgba(251,191,36,0.0) 90%, transparent 100%)',
                boxShadow: '0 0 8px rgba(251,191,36,0.4)',
              }}
            />

            {/* Corner brackets */}
            {[
              { top: 8,    left:  8,  borderTop: '2px solid rgba(239,68,68,.7)', borderLeft:  '2px solid rgba(239,68,68,.7)' },
              { top: 8,    right: 8,  borderTop: '2px solid rgba(239,68,68,.7)', borderRight: '2px solid rgba(239,68,68,.7)' },
              { bottom: 8, left:  8,  borderBottom: '2px solid rgba(239,68,68,.7)', borderLeft:  '2px solid rgba(239,68,68,.7)' },
              { bottom: 8, right: 8,  borderBottom: '2px solid rgba(239,68,68,.7)', borderRight: '2px solid rgba(239,68,68,.7)' },
            ].map((style, i) => (
              <div key={i} style={{ position: 'absolute', width: 18, height: 18, zIndex: 4, ...style }} />
            ))}

            {/* REC indicator â€” top-right corner inside bracket */}
            <div style={{
              position: 'absolute', top: 12, right: 14, zIndex: 7,
              display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
            }}>
              {/* REC blinker */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <motion.div
                  animate={{ opacity: [1, 0.1, 1] }}
                  transition={{ repeat: Infinity, duration: 1.2 }}
                  style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444' }}
                />
                <span style={{ fontSize: 9, fontWeight: 900, color: '#ef4444', fontFamily: 'monospace', letterSpacing: '.1em' }}>REC</span>
              </div>

              {activeFeedAlert && (
                <div style={{
                  background: 'rgba(10,15,30,.82)', backdropFilter: 'blur(6px)',
                  border: '1px solid rgba(239,68,68,.35)', borderRadius: 8,
                  padding: '8px 12px', minWidth: 192,
                }}>
                  <div style={{ fontSize: 9, color: 'rgba(252,165,165,.8)', fontWeight: 800, letterSpacing: '.08em', marginBottom: 5 }}>AI DETECTION RESULT</div>
                  <div style={{ fontSize: 11, color: '#fecaca', fontFamily: 'monospace', marginBottom: 2 }}>WEAPONS DETECTED: 1</div>
                  <div style={{ fontSize: 11, color: '#fca5a5', fontFamily: 'monospace', marginBottom: 2 }}>EVENT TYPE: ARMED THREAT</div>
                  <div style={{ fontSize: 11, color: '#ef4444', fontFamily: 'monospace', fontWeight: 800 }}>CONFIDENCE: 98%</div>
                </div>
              )}
            </div>

            {/* Pulsing threat badge â€” top-left */}
            {activeFeedAlert && (
              <motion.div
                animate={{ opacity: [1, 0.55, 1] }}
                transition={{ repeat: Infinity, duration: 1 }}
                style={{
                  position: 'absolute', top: 12, left: 14, zIndex: 5,
                  background: 'rgba(220,38,38,.9)', backdropFilter: 'blur(4px)',
                  borderRadius: 6, padding: '4px 10px',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', display: 'block' }} />
                <span style={{ fontSize: 10, fontWeight: 900, color: '#fff', letterSpacing: '.06em' }}>GUN DETECTED</span>
              </motion.div>
            )}

            {activeFeedAlert && (
              <motion.div
                initial={{ opacity: 0, scale: .96 }}
                animate={{ opacity: 1, scale: 1 }}
                style={{
                  position: 'absolute',
                  left: '33%',
                  top: '42%',
                  width: '15%',
                  height: '26%',
                  zIndex: 6,
                  border: '3px solid #ef4444',
                  boxShadow: '0 0 0 1px rgba(255,255,255,.35), 0 0 24px rgba(239,68,68,.55)',
                  pointerEvents: 'none',
                }}
              >
                <span style={{
                  position: 'absolute',
                  left: -3,
                  top: -27,
                  height: 24,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 9px',
                  background: '#ef4444',
                  color: '#fff',
                  fontSize: 10,
                  fontWeight: 900,
                  fontFamily: 'monospace',
                }}>
                  HANDGUN 98%
                </span>
              </motion.div>
            )}

            {activeFeedAlert && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  position: 'absolute',
                  top: 58,
                  left: 14,
                  zIndex: 8,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  maxWidth: 'min(430px, calc(100% - 28px))',
                  padding: '10px 12px',
                  border: '1px solid rgba(248,113,113,.72)',
                  borderRadius: 8,
                  color: '#fff',
                  background: 'rgba(127,29,29,.90)',
                  boxShadow: '0 18px 38px rgba(0,0,0,.34)',
                }}
              >
                <span className="material-symbols-outlined" style={{ flex: '0 0 auto', fontSize: 22, color: '#fecaca' }}>warning</span>
                <div>
                  <strong style={{ display: 'block', fontSize: 12, fontWeight: 950, lineHeight: 1.15 }}>Handgun detected in live feed</strong>
                  <small style={{ display: 'block', marginTop: 3, color: 'rgba(255,255,255,.78)', fontSize: 10, fontWeight: 750 }}>
                    {activeFeedAlert.location} / {activeFeedAlert.camera_id} / 98% confidence / Alert created
                  </small>
                </div>
              </motion.div>
            )}

            {/* Motion detection label */}
            {!activeFeedAlert && (
              <div style={{
                position: 'absolute', top: 48, left: 14, zIndex: 5,
                background: 'rgba(251,191,36,0.18)', border: '1px solid rgba(251,191,36,0.5)',
                borderRadius: 4, padding: '2px 8px',
                display: 'flex', alignItems: 'center', gap: 5,
              }}>
                <motion.div
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                  style={{ width: 5, height: 5, borderRadius: '50%', background: '#fbbf24' }}
                />
                <span style={{ fontSize: 9, fontWeight: 700, color: '#fbbf24', fontFamily: 'monospace', letterSpacing: '.06em' }}>MOTION DETECTED</span>
              </div>
            )}

            {/* Fullscreen toggle */}
            <button
              type="button"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              style={{
                position: 'absolute', bottom: 38, right: 12, zIndex: 8,
                width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 8, border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(10,15,30,0.62)', backdropFilter: 'blur(6px)',
                color: '#e2e8f0', cursor: 'pointer',
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                {isFullscreen ? 'fullscreen_exit' : 'fullscreen'}
              </span>
            </button>

            {/* Bottom HUD bar */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 5,
              background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              padding: '4px 12px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: '#22c55e', fontSize: 10, fontWeight: 800, fontFamily: 'monospace' }}>{getCameraLabel(CAMERAS[activeCam])}</span>
                <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>|</span>
                <span style={{ color: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}>{fps} FPS</span>
                <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>|</span>
                <SignalBars strength={4} />
                <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10 }}>|</span>
                <span style={{ color: '#60a5fa', fontSize: 9, fontWeight: 700, letterSpacing: '.05em' }}>AI ACTIVE</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#64748b', fontSize: 10, fontFamily: 'monospace' }}>{dateStr}</span>
                <span style={{ color: '#e2e8f0', fontSize: 10, fontFamily: 'monospace', fontWeight: 700 }}>{timestamp}</span>
              </div>
            </div>
          </div>
          </div>
        )}
      </div>

      {/* Camera strip */}
      <div className="weapon-camera-carousel" aria-label="Camera selector">
        <button
          type="button"
          className="weapon-camera-arrow"
          title="Previous camera"
          onClick={() => setActiveCam(index => (index - 1 + CAMERAS.length) % CAMERAS.length)}
        >
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
        <div className="weapon-camera-strip">
          {CAMERAS.map((cam, index) => (
            <button
              key={cam}
              className={`weapon-camera-thumb ${index === activeCam ? 'active' : ''}`}
              onClick={() => setActiveCam(index)}
              title={`Show ${getCameraLabel(cam)}`}
            >
              <span className="weapon-thumb-scene" />
              <strong><span>{CAMERA_NAMES[cam]}</span><em>{cam}</em></strong>
              {index === activeCam && <i />}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="weapon-camera-arrow"
          title="Next camera"
          onClick={() => setActiveCam(index => (index + 1) % CAMERAS.length)}
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
    </div>
  );
}
