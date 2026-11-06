// Person Tracker — upload a face photo, find every camera + time it
// appeared, render a stitched MP4 + PDF report + map of the path.
//
// Multi-step flow (state machine):
//   idle      → operator hasn't uploaded anything yet
//   searching → POST /search in flight
//   reviewed  → candidates + sightings shown; operator picks "Generate"
//   stitching → job created, polling status
//   ready     → video + report + map URLs available
//
// All API access goes through @/core/services/personTracker; no axios here.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Camera as CameraIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Filter,
  Loader2,
  MapPin,
  PlayCircle,
  Radio,
  RotateCcw,
  ScanFace,
  ScanSearch,
  Search as SearchIcon,
  Sparkles,
  Upload,
  Video as VideoIcon,
} from 'lucide-react';
import { MapContainer, Marker, Polyline, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import personTrackerService from '@/core/services/personTracker';
import { PageIcon } from '@/core/layout/OperationsPage';
import { Link } from 'react-router-dom';
import { DEMO_FACE, DEMO_SUBJECT_FULL_NAME } from '@/core/demo/demoIdentity';
import { aiService } from '@/core/services/ai';
import { accumulate, createStore, formatAgo, staleAgeSec } from './live-session';

// Drisyam brand orange used as primary accent across the app.
const ORANGE = '#F7983A';

const POLL_INTERVAL_MS = 2500;

// Default search window — matches SEARCH_DEFAULT_WINDOW=7d on the service.
const DEFAULT_WINDOW_DAYS = 7;

// ── Demo data ──────────────────────────────────────────────────────────
// Lets the page tell the full Person-Tracker story (search → sightings →
// stitched video → map + report) on a machine with no live cameras or
// recordings. Everything below is synthetic and clearly labelled "Demo".
// `loadDemo()` jumps the state machine to the "reviewed" step; the presenter
// then clicks "Generate stitched video" to show a simulated render → result.
// Kept prefixed with "Demo subject" on this page: the tracker shows match
// scores and stitched footage, and a presenter must never be able to pass
// synthetic sightings off as a real hit.
const DEMO_SUBJECT_NAME = `Demo subject — ${DEMO_SUBJECT_FULL_NAME}`;

// Advertised on the dropzone, so it has to be enforced there too.
const MAX_UPLOAD_MB = 10;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// A campus walk — six cameras over ~30 minutes, tight lat/lng cluster so the
// path reads as a single site. Times are built relative to "now" at click time.
const DEMO_STOPS = [
  { code: 'CAM-01', name: 'Main Gate',        lat: 12.97161, lng: 77.59456, offsetMin: 32, dur: 41,  sim: 0.94 },
  { code: 'CAM-07', name: 'Parking Lot',      lat: 12.97189, lng: 77.59512, offsetMin: 28, dur: 26,  sim: 0.86 },
  { code: 'CAM-03', name: 'Library Entrance', lat: 12.97224, lng: 77.59498, offsetMin: 24, dur: 68,  sim: 0.91 },
  { code: 'CAM-12', name: 'Cafeteria',        lat: 12.97241, lng: 77.59437, offsetMin: 18, dur: 112, sim: 0.79 },
  { code: 'CAM-09', name: 'Block A Corridor', lat: 12.97205, lng: 77.59401, offsetMin: 12, dur: 33,  sim: 0.83 },
  { code: 'CAM-05', name: 'Admin Block',      lat: 12.97168, lng: 77.59428, offsetMin: 6,  dur: 54,  sim: 0.72 },
];

// Reuse the people-detection demo clip as the "stitched investigation" video.
const DEMO_VIDEO_URL = '/demos/human-detection.mp4';
const DEMO_SEARCH_RESULT = { query_face_quality: 0.93, total_matched: 42 };

function buildDemoSightings(now) {
  return DEMO_STOPS.map((s, i) => {
    const start = new Date(now - s.offsetMin * 60_000);
    const end = new Date(start.getTime() + s.dur * 1000);
    return {
      sighting_id: `demo-${i}`,
      camera_id: `demo-cam-${s.code}`,
      camera_code: s.name,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      best_similarity: s.sim,
      cover: DEMO_FACE,   // synthetic crop so demo cards render an image
    };
  });
}

function buildDemoMap(now) {
  const stops = DEMO_STOPS.map((s, i) => ({
    sighting_id: `demo-${i}`,
    name: s.name,
    camera_code: s.code,
    time: new Date(now - s.offsetMin * 60_000).toISOString(),
    lat: s.lat,
    lng: s.lng,
    cover: DEMO_FACE,
  }));
  return { stops, path: stops.map((s) => [s.lat, s.lng]) };
}

// Client-side printable report for the demo — opens a styled window the
// presenter can "Save as PDF". Keeps the demo self-contained (no backend).
function openDemoReport(sightings, searchResult) {
  const cams = new Set(sightings.map((s) => s.camera_id)).size;
  const rows = sightings
    .map(
      (s) => `<tr>
        <td>${s.camera_code}</td>
        <td>${new Date(s.started_at).toLocaleString()}</td>
        <td>${Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 1000))}s</td>
        <td style="text-align:right">${Math.round(s.best_similarity * 100)}%</td>
      </tr>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
    <title>Person Tracker — Demo Report</title>
    <style>
      *{box-sizing:border-box} body{font-family:Inter,system-ui,Arial,sans-serif;color:#0f172a;margin:0;padding:40px;}
      .tag{display:inline-block;background:#FFF1E2;color:#9a4a00;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
      h1{font-size:24px;margin:14px 0 2px} .sub{color:#64748b;font-size:13px;margin:0 0 22px}
      .cards{display:flex;gap:12px;margin-bottom:22px}
      .card{flex:1;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
      .card .n{font-size:22px;font-weight:800;color:#F7983A} .card .l{font-size:12px;color:#64748b}
      table{width:100%;border-collapse:collapse;font-size:13px} th{text-align:left;color:#64748b;font-weight:600;border-bottom:2px solid #e5e7eb;padding:8px 10px}
      td{padding:9px 10px;border-bottom:1px solid #f1f5f9} tr:last-child td{border-bottom:none}
      .ft{margin-top:24px;color:#94a3b8;font-size:11px;border-top:1px solid #e5e7eb;padding-top:12px}
    </style></head><body>
    <span class="tag">Demo report · sample data</span>
    <h1>Person Tracker — investigation summary</h1>
    <p class="sub">${DEMO_SUBJECT_NAME} · generated for presentation</p>
    <div class="cards">
      <div class="card"><div class="n">${sightings.length}</div><div class="l">sightings</div></div>
      <div class="card"><div class="n">${cams}</div><div class="l">cameras</div></div>
      <div class="card"><div class="n">${searchResult.total_matched}</div><div class="l">raw matches</div></div>
      <div class="card"><div class="n">${Math.round(searchResult.query_face_quality * 100)}%</div><div class="l">face quality</div></div>
    </div>
    <table><thead><tr><th>Camera</th><th>First seen</th><th>Duration</th><th style="text-align:right">Match</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="ft">Drishyam VMS · Person Tracker · This is synthetic demo data and does not represent a real person or event.</p>
    </body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => {
    try { w.print(); } catch { /* user can print manually */ }
  }, 350);
}

// ── Step indicator ─────────────────────────────────────────────────────
// Shows the operator where they are in the upload → review → render → result
// flow. Drives off the page's phase state machine.
const STEPS = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'review', label: 'Review', icon: ScanFace },
  { key: 'render', label: 'Render', icon: Sparkles },
  { key: 'result', label: 'Result', icon: VideoIcon },
];

function phaseToStep(phase) {
  if (phase === 'reviewed') return 1;
  if (phase === 'stitching') return 2;
  if (phase === 'ready') return 3;
  return 0; // idle | searching
}

function Stepper({ current }) {
  return (
    <ol className="mb-6 flex items-center">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const Icon = s.icon;
        return (
          <Fragment key={s.key}>
            <li className="flex items-center gap-2.5">
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full text-small font-bold ring-1 transition ${
                  active
                    ? 'bg-linear-to-br from-brand to-brand-active text-white shadow-md shadow-brand/20 ring-transparent'
                    : done
                    ? 'bg-linear-to-br from-brand to-brand-active text-white ring-transparent'
                    : 'bg-surface text-fg-subtle ring-line'
                }`}
              >
                {done ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <span
                className={`hidden text-body font-medium sm:inline ${
                  active ? 'text-fg' : done ? 'text-fg-secondary' : 'text-fg-subtle'
                }`}
              >
                {s.label}
              </span>
            </li>
            {i < STEPS.length - 1 && (
              <span
                className={`mx-2 h-0.5 flex-1 rounded-full transition sm:mx-3 ${
                  i < current ? 'bg-brand-line' : 'bg-line'
                }`}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

export default function PersonTracker() {
  // ── upload state ───────────────────────────────────────────────────
  const [file, setFile] = useState(null);
  // Whether a file is currently hovering the dropzone. The zone had no such
  // state, so dragging a photo over it gave no feedback at all.
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const fileInputRef = useRef(null);

  // ── search filters ─────────────────────────────────────────────────
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [minSimilarity, setMinSimilarity] = useState(0.4);  // CCTV matches land ~0.4–0.5; 0.5 was rejecting real hits
  // Where the filled half of the strictness track ends, as a percentage of
  // the input's own 0.30–0.90 range.
  const strictnessPct = Math.round(((minSimilarity - 0.3) / 0.6) * 100);
  // Cameras the operator has turned ON for person tracking. Checkbox = ON.
  const [cameras, setCameras] = useState([]);                 // { id, name, code, enabled }
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const [savingCamId, setSavingCamId] = useState('');

  // ── flow state ─────────────────────────────────────────────────────
  const [phase, setPhase] = useState('idle');     // idle|searching|reviewed|stitching|ready
  const [error, setError] = useState(null);
  const [searchResult, setSearchResult] = useState(null);
  const [sightings, setSightings] = useState([]);
  const [job, setJob] = useState(null);
  const [mapData, setMapData] = useState(null);
  const [demoMode, setDemoMode] = useState(false);   // presentation mode w/ synthetic data
  const [notice, setNotice] = useState(null);        // info banner (e.g. auto-widened window)
  // ── live tracking ──────────────────────────────────────────────────
  const [liveMode, setLiveMode] = useState(false);   // poll for new sightings as they happen
  const [liveLastUpdate, setLiveLastUpdate] = useState(null);
  const [liveWindowMin, setLiveWindowMin] = useState(15);  // rolling real-time window (minutes)
  // Every candidate seen this live session, keyed by appearance_id. Polls only
  // add to it, so a stop stays on screen after it ages out of the window.
  // `gen` bumps on reset so a poll already in flight can't refill a fresh store.
  const liveStoreRef = useRef({ gen: 0, store: createStore() });
  const resetLiveStore = useCallback(() => {
    liveStoreRef.current = { gen: liveStoreRef.current.gen + 1, store: createStore() };
  }, []);
  // Demo live-replay: reveal the demo journey stop-by-stop in real time.
  const [replayState, setReplayState] = useState(null);  // null | { all: [...], step: n }

  // ── load cameras for the scope dropdown (non-fatal if it fails) ────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const payload = await aiService.listCameraAiSettings();
        const raw = Array.isArray(payload) ? payload : (payload?.data ?? payload?.cameras ?? []);
        const list = (Array.isArray(raw) ? raw : [])
          .map((c) => ({
            id: c.id,
            name: c.name || c.code || c.monitorId || c.id,
            code: c.monitorId || c.code || '',
            // ON for person tracking unless journeyMapping is explicitly false.
            enabled: (c.ai?.journeyMapping ?? c.journeyMapping) !== false,
          }))
          .filter((c) => c.id);
        if (alive) setCameras(list);
      } catch { /* non-fatal: dropdown just stays empty */ }
    })();
    return () => { alive = false; };
  }, []);

  // ── preview URL management (revoke blobs to avoid leaks) ───────────
  // A new photo is a new subject: the live session store starts over too.
  useEffect(() => {
    resetLiveStore();
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, resetLiveStore]);

  // ── polling effect while a stitch job is in flight ─────────────────
  useEffect(() => {
    if (phase !== 'stitching' || !job?.job_id || demoMode) return;   // demo has its own renderer
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await personTrackerService.getJobStatus(job.job_id);
        if (cancelled) return;
        setJob(status);
        if (status.status === 'done') {
          setPhase('ready');
          // Lazy-fetch the map data once the job is done. Failure here
          // is non-fatal — the video + PDF still work without coords.
          try {
            const m = await personTrackerService.getMap(job.job_id);
            if (!cancelled) setMapData(m);
          } catch (e) {
            console.warn('map data load failed', e);
          }
        } else if (status.status === 'failed') {
          setError(status.failed_reason || 'stitch job failed');
          setPhase('reviewed');
        }
      } catch (e) {
        console.warn('job poll failed', e);
      }
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, job?.job_id, demoMode]);

  // ── simulated render for demo mode ─────────────────────────────────
  // Drives a believable progress bar, then reveals the canned video + map.
  useEffect(() => {
    if (!(demoMode && phase === 'stitching')) return;
    let cancelled = false;
    const steps = [
      { p: 0.15, m: 'Locating clips across 6 cameras…' },
      { p: 0.4,  m: 'Extracting matched segments…' },
      { p: 0.68, m: 'Stitching timeline + overlays…' },
      { p: 0.9,  m: 'Rendering MP4 and report…' },
      { p: 1,    m: 'Done' },
    ];
    let i = 0;
    const id = setInterval(() => {
      if (cancelled) return;
      const step = steps[i++];
      setJob((j) => ({
        ...(j || {}),
        job_id: 'demo',
        status: step.p >= 1 ? 'done' : 'running',
        progress: step.p,
        message: step.m,
      }));
      if (step.p >= 1) {
        clearInterval(id);
        setMapData(buildDemoMap(Date.now()));
        setPhase('ready');
      }
    }, 550);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [demoMode, phase]);

  // ── live tracking: re-search a recent window on an interval, merge the hits
  // into the session store and re-cluster the whole store, so new stops appear
  // as the person is detected and earlier stops stay once they leave the window.
  useEffect(() => {
    if (!liveMode || !file || demoMode) return;
    let cancelled = false;
    let inFlight = false;                 // overlap guard: never stack searches
    const LIVE_POLL_MS = 3000;           // refresh cadence (rolling window below)
    const tick = async () => {
      if (inFlight) return;               // previous poll still running — skip this tick
      inFlight = true;
      try {
        const { gen } = liveStoreRef.current;
        const end = new Date();
        const start = new Date(end.getTime() - liveWindowMin * 60 * 1000);
        const res = await personTrackerService.search(file, {
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          minSimilarity,
        });
        if (cancelled || liveStoreRef.current.gen !== gen) return;
        const store = accumulate(liveStoreRef.current.store, res.candidates);
        liveStoreRef.current = { gen, store };
        // Records kept from earlier polls were matched at whatever strictness
        // was set then; show only those that pass the current one.
        const session = [...store.values()].filter((c) => (c.similarity ?? 0) >= minSimilarity);
        const clustered = await personTrackerService.clusterSightings(session);
        if (cancelled || liveStoreRef.current.gen !== gen) return;
        setSearchResult({ ...res, total_matched: session.length });
        setSightings(clustered);          // the whole session, not just the current window
        setLiveLastUpdate(new Date());
        // Functional update so `phase` need not be an effect dependency (which
        // was tearing down + rebuilding the poll loop on every phase change).
        setPhase((p) => (p === 'idle' || p === 'searching' ? 'reviewed' : p));
      } catch (e) {
        // A 422 = no face in the uploaded photo. Re-polling the SAME photo will
        // never succeed, so stop live mode and surface it once instead of
        // flooding a failed request every 3s.
        if (e?.response?.status === 422 && !cancelled) {
          setError('No face detected in the photo. Upload a clear, front-facing close-up of the face — not a full-body or scene shot.');
          setLiveMode(false);
          return;
        }
        /* other errors transient — keep the last good frame, try again next tick */
      } finally {
        inFlight = false;
      }
    };
    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [liveMode, file, demoMode, minSimilarity, liveWindowMin]);

  // ── demo live-replay: reveal one more demo stop every couple seconds so the
  // journey "builds" in real time, mimicking watching someone walk the route ──
  useEffect(() => {
    if (!replayState || replayState.step >= replayState.all.length) return;
    const id = setTimeout(() => {
      const step = replayState.step + 1;
      setSightings(replayState.all.slice(0, step));
      setReplayState((r) => (r ? { ...r, step } : r));
    }, 2500);
    return () => clearTimeout(id);
  }, [replayState]);

  // ── handlers ───────────────────────────────────────────────────────
  const acceptFile = (f) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      const mb = Math.round(f.size / (1024 * 1024));
      setError(`That photo is ${mb} MB. Maximum ${MAX_UPLOAD_MB} MB — try a smaller or resized image.`);
      return;
    }
    setDemoMode(false);
    setReplayState(null);
    setFile(f);
    setSearchResult(null);
    setSightings([]);
    setJob(null);
    setMapData(null);
    setError(null);
    setPhase('idle');
  };

  const onPickFile = (e) => acceptFile(e.target.files?.[0] ?? null);

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith('image/')) {
      acceptFile(f);
    }
  };

  // ── demo mode ──────────────────────────────────────────────────────
  const loadDemo = useCallback(() => {
    const now = Date.now();
    const all = buildDemoSightings(now);
    setLiveMode(false);
    setDemoMode(true);
    setFile(null);              // the blob-preview effect clears previewUrl
    setError(null);
    setNotice(null);
    setSearchResult(DEMO_SEARCH_RESULT);
    setJob(null);
    setMapData(null);
    // Reveal stop-by-stop in real time (live replay) instead of all at once.
    setSightings(all.slice(0, 1));
    setReplayState({ all, step: 1 });
    setPhase('reviewed');       // jump straight to the sightings step
  }, []);

  const clearDemo = useCallback(() => {
    setDemoMode(false);
    setReplayState(null);
    setLiveMode(false);
    setFile(null);
    setSearchResult(null);
    setSightings([]);
    setJob(null);
    setMapData(null);
    setError(null);
    setNotice(null);
    setPhase('idle');
  }, []);

  const runSearch = useCallback(async () => {
    if (!file) return;
    resetLiveStore();
    setError(null);
    setNotice(null);
    setPhase('searching');
    try {
      // No per-search camera list: the search automatically uses the cameras
      // turned ON for person tracking (managed via the Cameras dropdown).
      const searchWindow = async (days) => {
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
        return personTrackerService.search(file, {
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          minSimilarity,
        });
      };

      let result = await searchWindow(windowDays);
      // Auto-widen: the gallery spans weeks, but a person last seen >Nd ago
      // returns nothing for a narrow window. Rather than show a misleading
      // "no matches", retry once at 30 days so a real subject isn't missed.
      if ((!result.candidates || result.candidates.length === 0) && windowDays < 30) {
        const wider = await searchWindow(30);
        if (wider.candidates && wider.candidates.length > 0) {
          result = wider;
          setNotice(
            `No matches in the last ${windowDays} day${windowDays === 1 ? '' : 's'} — ` +
            `automatically widened to 30 days and found ${wider.candidates.length} sighting${wider.candidates.length === 1 ? '' : 's'}.`,
          );
          setWindowDays(30);
        }
      }

      setSearchResult(result);
      // Immediately cluster candidates → sightings so the operator sees
      // both views without a second click.
      const clustered = await personTrackerService.clusterSightings(result.candidates);
      setSightings(clustered);
      setPhase('reviewed');
    } catch (e) {
      console.error(e);
      const raw = e.response?.data?.detail || e.response?.data?.error || e.message || '';
      // The AI returns 422 when it can't find a face in the uploaded photo — by
      // far the most common failure. Turn the raw error into clear guidance
      // instead of surfacing a bare AxiosError.
      const noFace = e.response?.status === 422 || /no face/i.test(raw);
      setError(
        noFace
          ? 'No face detected in the photo. Upload a clear, front-facing close-up of the face — not a full-body or scene shot.'
          : (raw || 'search failed'),
      );
      setPhase('idle');
    }
  }, [file, windowDays, minSimilarity, resetLiveStore]);

  // Turn a camera ON/OFF for person tracking (persists; checkbox = ON).
  const toggleCameraTracking = useCallback(async (cam) => {
    const next = !cam.enabled;
    setSavingCamId(cam.id);
    setCameras((prev) => prev.map((c) => (c.id === cam.id ? { ...c, enabled: next } : c)));  // optimistic
    try {
      await aiService.setPersonTrackerCameras([cam.id], next);
    } catch {
      setCameras((prev) => prev.map((c) => (c.id === cam.id ? { ...c, enabled: cam.enabled } : c)));  // revert
    } finally {
      setSavingCamId('');
    }
  }, []);

  const runStitch = useCallback(async () => {
    if (!sightings.length) return;
    setError(null);
    setMapData(null);
    setJob(null);
    setPhase('stitching');
    if (demoMode) {
      // Seed an initial job so the progress card shows immediately; the
      // demo render effect takes it from here to 'ready'.
      setJob({ job_id: 'demo', progress: 0.05, message: 'queued…' });
      return;
    }
    try {
      const created = await personTrackerService.createStitchJob(sightings);
      setJob({ ...created, progress: 0, message: 'queued…' });
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setError(msg || 'failed to enqueue stitch job');
      setPhase('reviewed');
    }
  }, [sightings, demoMode]);

  // ── derived UI bits ────────────────────────────────────────────────
  const cameraCount = useMemo(() => {
    const set = new Set(sightings.map((s) => s.camera_id));
    return set.size;
  }, [sightings]);

  const videoUrl  = demoMode
    ? DEMO_VIDEO_URL
    : (job?.job_id ? personTrackerService.videoUrl(job.job_id) : null);
  // In demo mode the PDF is generated client-side via openDemoReport(), so
  // there's no backend URL to point the link at.
  const reportUrl = demoMode
    ? null
    : (job?.job_id ? personTrackerService.reportUrl(job.job_id) : null);

  // Live treatment is on for real live polling OR while the demo journey is
  // still revealing stop-by-stop.
  const replaying = !!(replayState && replayState.step < replayState.all.length);
  const liveActive = liveMode || replaying;

  // Real-time status: is the person on a camera right now, or how long ago?
  let liveStatus = null;
  if (liveMode && sightings.length) {
    const newest = sightings.reduce(
      (a, b) => (new Date(b.ended_at || b.started_at) > new Date(a.ended_at || a.started_at) ? b : a),
      sightings[0],
    );
    const agoSec = Math.max(0, Math.round((Date.now() - new Date(newest.ended_at || newest.started_at).getTime()) / 1000));
    liveStatus = {
      onNow: agoSec <= 15,
      label: agoSec <= 15 ? 'on camera now' : `last seen ${secondsToHuman(agoSec)} ago`,
      cam: newest.camera_name || newest.camera_code || 'a camera',
    };
  }

  // ───────────────────────────────────────────────────────────────────
  return (
    <div className="page-inset">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3.5">
          <PageIcon icon={ScanSearch} />
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Track a person</h1>
            <p className="mt-0.5 text-small text-fg-muted">
              Upload a face, trace them across every camera — video, report &amp; map.
            </p>
            {/* One sidebar row covers both pages ("Track a person"), so each
                links to the other. */}
            <Link to="/live-tracker" className="mt-1 inline-flex items-center gap-1 text-small font-semibold text-brand hover:text-brand-hover">
              See who is where right now →
            </Link>
          </div>
        </div>

        {/* Demo control — populate the whole flow with synthetic data so the
            page can be presented without live cameras or recordings. */}
        {demoMode ? (
          <div className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-brand-line bg-brand-soft px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-small font-semibold text-brand-ink">
              <Sparkles size={14} /> Showing demo data
            </span>
            <button
              type="button"
              onClick={clearDemo}
              className="inline-flex items-center gap-1 rounded-lg border border-brand-line bg-surface px-2.5 py-1 text-small font-medium text-brand-ink hover:bg-brand-soft"
            >
              <RotateCcw size={12} /> Clear
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={loadDemo}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-body font-medium text-fg-secondary shadow-sm transition hover:border-brand-line hover:bg-brand-soft hover:text-brand-ink"
          >
            <PlayCircle size={16} style={{ color: ORANGE }} />
            Load demo investigation
          </button>
        )}
      </header>

      <Stepper current={phaseToStep(phase)} />

      {/* Step 1 — upload + filters ----------------------------------- */}
      <section className="mb-6 rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {/* upload card */}
          <div
            className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all md:col-span-2 ${
              dragging
                ? 'border-brand bg-brand-soft'
                : demoMode || previewUrl
                ? 'border-brand-line bg-brand-soft/30'
                : 'border-brand-line bg-surface-sunken/50 hover:border-brand hover:bg-brand-soft/30'
            }`}
            onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input ref={fileInputRef} type="file" accept="image/*,.heic,.heif" className="hidden" onChange={onPickFile} />

            {demoMode ? (
              <img src={DEMO_FACE} alt="demo subject" className="mb-4 h-24 w-24 rounded-2xl bg-brand-soft object-cover ring-1 ring-brand-line" />
            ) : previewUrl ? (
              <img src={previewUrl} alt="query face" className="mb-4 h-24 w-24 rounded-2xl bg-surface-muted object-cover shadow-sm ring-1 ring-line" />
            ) : (
              <div
                className={`mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-brand to-brand-active text-white shadow-lg shadow-brand/25 transition-transform ${
                  dragging ? 'scale-105' : 'group-hover:scale-105'
                }`}
              >
                {/* Lucide strokes with currentColor — `text-white` on the
                    container is what makes the arrow read against the fill. */}
                <Upload size={26} strokeWidth={2.25} />
              </div>
            )}

            <div className="mb-1 text-base font-semibold text-fg">
              {demoMode ? DEMO_SUBJECT_NAME : file ? file.name : 'Drag & drop a face photo here'}
            </div>
            <div className="mb-4 text-sm text-fg-muted">
              {demoMode
                ? 'Synthetic data for presentation'
                : file
                ? `${(file.size / 1024).toFixed(0)} KB · ready to search`
                : 'or click to browse from your device'}
            </div>

            {!file && !demoMode && (
              <>
                <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-3 py-1.5 text-small font-medium text-fg-secondary">
                  <Upload size={12} /> Choose photo
                </div>
                <p className="mt-3 text-caption text-fg-subtle">
                  JPEG, PNG or WEBP (Max {MAX_UPLOAD_MB}MB)
                </p>
              </>
            )}
          </div>

          {/* filters card */}
          <div className="rounded-xl border border-line bg-surface-sunken/60 p-4">
            {liveMode ? (
              <>
                <label className="mb-1.5 flex items-center justify-between text-caption font-semibold uppercase tracking-wide text-fg-subtle">
                  Live window
                  <span className="inline-flex items-center gap-1 normal-case text-danger">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" /> rolling
                  </span>
                </label>
                <select
                  value={liveWindowMin}
                  onChange={(e) => setLiveWindowMin(Number(e.target.value))}
                  className="w-full rounded-lg border border-danger-line bg-surface px-3 py-2 text-body font-medium text-fg-secondary shadow-sm outline-none focus:border-danger focus:ring-2 focus:ring-danger-line"
                >
                  <option value={5}>Last 5 minutes</option>
                  <option value={15}>Last 15 minutes</option>
                  <option value={30}>Last 30 minutes</option>
                  <option value={60}>Last 1 hour</option>
                </select>
              </>
            ) : (
              <>
                <label className="mb-1.5 block text-caption font-semibold uppercase tracking-wide text-fg-subtle">Look back</label>
                <select
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value))}
                  className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-body font-medium text-fg-secondary shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-line"
                >
                  <option value={1}>24 hours</option>
                  <option value={3}>3 days</option>
                  <option value={7}>7 days (default)</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                </select>
              </>
            )}

            <div className="mt-3 mb-1.5 flex items-center justify-between">
              <label className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Match strictness</label>
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-small font-bold text-brand-ink tabular-nums">
                {Math.round(minSimilarity * 100)}%
              </span>
            </div>
            {/* `accentColor` alone only tints the FILLED half; Chrome draws the
                rest of the track in its own near-black, which is the hard edge
                that showed after the thumb. With `appearance-none` the browser
                draws neither, so the fill is painted here as a gradient stop at
                the current value and the thumb is styled explicitly. */}
            <input
              type="range" min="0.30" max="0.90" step="0.05"
              value={minSimilarity}
              onChange={(e) => setMinSimilarity(Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full
                         [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110
                         [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand [&::-moz-range-thumb]:bg-surface [&::-moz-range-thumb]:shadow-md
                         focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/25"
              style={{
                background: `linear-gradient(to right, var(--brand) 0%, var(--brand-hover) ${strictnessPct}%, var(--surface-muted) ${strictnessPct}%, var(--surface-muted) 100%)`,
              }}
            />

            {/* Live tracking — when on, the page re-checks every few seconds so
                new stops appear on the timeline as the person is detected live. */}
            <button
              type="button"
              onClick={() => setLiveMode((v) => !v)}
              disabled={!file}
              title={file ? 'Continuously track this face in real time' : 'Upload a face first'}
              className={`mt-3 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-body transition disabled:cursor-not-allowed disabled:opacity-50 ${
                liveMode ? 'border-danger-line bg-danger-soft' : 'border-line-strong bg-surface hover:border-fg-subtle'
              }`}
            >
              <span className="flex items-center gap-2 font-medium text-fg-secondary">
                {liveMode && (
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
                  </span>
                )}
                <Radio size={14} className={liveMode ? 'text-danger' : 'text-fg-subtle'} />
                Live tracking
              </span>
              <span className={`flex h-5 w-9 items-center rounded-full px-0.5 transition ${liveMode ? 'bg-danger' : 'bg-line-strong'}`}>
                <span className={`h-4 w-4 rounded-full bg-surface shadow transition ${liveMode ? 'translate-x-4' : ''}`} />
              </span>
            </button>

            {/* Cameras turned ON for person tracking. Tick a camera to enable it
                (it starts producing appearances + is included in journey search). */}
            <label className="mb-1.5 mt-3 block text-caption font-semibold uppercase tracking-wide text-fg-subtle">
              Cameras for tracking
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setCamMenuOpen((o) => !o)}
                className="flex w-full items-center justify-between rounded-lg border border-line-strong bg-surface px-3 py-2 text-body text-fg-secondary shadow-sm transition hover:border-fg-subtle"
              >
                <span className="flex items-center gap-1.5">
                  <CameraIcon size={14} className="text-fg-subtle" />
                  <span className="font-medium">{cameras.filter((c) => c.enabled).length}</span>
                  <span className="text-fg-subtle">of {cameras.length} ON</span>
                </span>
                <ChevronDown size={15} className={`text-fg-subtle transition ${camMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {camMenuOpen && (
                <div className="absolute z-20 mt-1.5 max-h-56 w-full overflow-auto rounded-xl border border-line bg-surface py-1 shadow-lg ring-1 ring-black/5">
                  {cameras.length === 0 && (
                    <div className="px-3 py-1.5 text-small text-fg-subtle">No cameras found</div>
                  )}
                  {cameras.map((c) => (
                    <label
                      key={c.id}
                      className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-body hover:bg-brand-soft/60"
                    >
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        disabled={savingCamId === c.id}
                        onChange={() => toggleCameraTracking(c)}
                        className="h-4 w-4 rounded border-line-strong"
                        style={{ accentColor: ORANGE }}
                      />
                      <span className="flex-1 truncate text-fg-secondary">{c.name}</span>
                      {savingCamId === c.id
                        ? <Loader2 size={12} className="animate-spin text-fg-subtle" />
                        : c.enabled && <span className="rounded bg-brand-soft px-1.5 py-0.5 text-micro font-bold text-brand-ink">ON</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!file || phase === 'searching'}
              onClick={runSearch}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-body font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
              style={{ background: file && phase !== 'searching' ? ORANGE : undefined }}
            >
              {phase === 'searching' ? <Loader2 size={16} className="animate-spin" /> : <SearchIcon size={16} />}
              {phase === 'searching' ? 'Searching…' : 'Search cameras'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-body text-danger-ink">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
      </section>

      {/* Step 2 — sightings ------------------------------------------ */}
      {(phase === 'reviewed' || phase === 'stitching' || phase === 'ready') && (
        <section className="mb-6 rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-section font-semibold tracking-tight text-fg">
                <ScanFace size={18} style={{ color: ORANGE }} /> Sightings
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Chip>{sightings.length} sighting{sightings.length === 1 ? '' : 's'}</Chip>
                <Chip>{cameraCount} camera{cameraCount === 1 ? '' : 's'}</Chip>
                <Chip>{searchResult?.total_matched ?? 0} raw matches</Chip>
                {searchResult?.query_face_quality != null && (
                  <Chip>face quality {(searchResult.query_face_quality * 100).toFixed(0)}%</Chip>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={!sightings.length || phase === 'stitching'}
              onClick={runStitch}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-body font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
              style={{ background: sightings.length && phase !== 'stitching' ? ORANGE : undefined }}
            >
              {phase === 'stitching' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {phase === 'stitching' ? 'Rendering…' : 'Generate stitched video'}
            </button>
          </div>

          {liveActive && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-body text-danger-ink">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
              </span>
              <span className="font-semibold">LIVE</span>
              {liveStatus ? (
                <span>
                  — <span className={`font-semibold ${liveStatus.onNow ? 'text-danger-ink' : ''}`}>{liveStatus.label}</span>
                  {' '}at <span className="font-semibold">{liveStatus.cam}</span>
                </span>
              ) : (
                <span className="text-danger-ink/80">
                  {replaying ? 'Replaying a journey — new stops appear as the person moves.' : 'Watching for this person across your cameras…'}
                </span>
              )}
              {liveMode && liveLastUpdate && (
                <span className="ml-auto text-small tabular-nums text-danger">refreshed {liveLastUpdate.toLocaleTimeString()}</span>
              )}
            </div>
          )}

          {/* Plain-language recap of where the person went, so an operator
              gets the story at a glance before scanning the cards. */}
          <JourneySummary
            sightings={sightings}
            demoMode={demoMode}
            searchResult={searchResult}
            live={liveActive}
            liveWindowMs={liveMode ? liveWindowMin * 60 * 1000 : null}
            liveNowMs={liveMode ? liveLastUpdate?.getTime() ?? null : null}
          />

          {notice && (
            <div className="rounded-lg border border-info-line bg-info-soft text-info-ink px-3 py-2 text-body flex items-center gap-2">
              <Filter size={16} /> {notice}
            </div>
          )}

          {sightings.length === 0 ? (
            <div className="rounded-lg border border-warning-line bg-warning-soft text-warning-ink px-3 py-3 text-body">
              <div className="flex items-center gap-2">
                <Filter size={16} />
                No matches above {Math.round(minSimilarity * 100)}% even in the last 30 days.
                Try lowering the strictness, or this person may not have been recorded.
              </div>
              <button
                type="button"
                onClick={loadDemo}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-warning-line bg-surface px-3 py-1.5 text-small font-medium text-warning-ink hover:bg-warning-soft"
              >
                <PlayCircle size={14} /> Or load a demo investigation instead
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {sightings.map((s) => (
                <SightingCard key={s.sighting_id} sighting={s} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* Step 3 — render progress ----------------------------------- */}
      {phase === 'stitching' && job && (
        <section className="mb-6 rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin" style={{ color: ORANGE }} />
            <div className="flex-1">
              <div className="text-body font-medium">{job.message || 'Working…'}</div>
              <div className="mt-1 h-2 rounded-full bg-surface-muted overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${Math.round((job.progress || 0) * 100)}%`,
                    background: ORANGE,
                  }}
                />
              </div>
            </div>
            <span className="text-body tabular-nums">
              {Math.round((job.progress || 0) * 100)}%
            </span>
          </div>
        </section>
      )}

      {/* Step 4 — final outputs ------------------------------------- */}
      {phase === 'ready' && job && (
        <>
          <section className="mb-6 rounded-2xl border border-line bg-surface p-5 shadow-sm">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="flex items-center gap-2 text-section font-semibold tracking-tight text-fg">
                <VideoIcon size={18} style={{ color: ORANGE }} />
                Stitched investigation video
              </h2>
              <div className="flex items-center gap-2">
                <a
                  href={videoUrl}
                  download={`person-tracker-${job.job_id}.mp4`}
                  className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-body hover:bg-surface-sunken"
                >
                  <Download size={14} /> MP4
                </a>
                {demoMode ? (
                  <button
                    type="button"
                    onClick={() => openDemoReport(sightings, searchResult || DEMO_SEARCH_RESULT)}
                    className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-body hover:bg-surface-sunken"
                  >
                    <FileText size={14} /> PDF report
                  </button>
                ) : (
                  <a
                    href={reportUrl}
                    target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-body hover:bg-surface-sunken"
                  >
                    <FileText size={14} /> PDF report
                  </a>
                )}
              </div>
            </div>
            <video
              src={videoUrl}
              controls
              playsInline
              className="w-full rounded-xl bg-black"
            />
          </section>

          {mapData && (mapData.path?.length > 0 || mapData.stops?.length > 0) && (
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <h2 className="mb-3 flex items-center gap-2 text-section font-semibold tracking-tight text-fg">
                <MapPin size={18} style={{ color: ORANGE }} />
                Path across cameras
              </h2>
              <PathMap data={mapData} />
              {/* Cameras without configured coordinates show up here */}
              <UncoordinatedList stops={mapData.stops || []} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

// ── Movement summary ───────────────────────────────────────────────────
// A plain-language recap of the person's path: who, first/last sighting,
// how many cameras, total elapsed time, and the route as arrowed chips.
// Renders for both real searches and the loaded demo (synthetic) data.
// `liveWindowMs` / `liveNowMs` are set during live tracking: a stop whose
// newest record is older than the window (as of the last poll) is labelled
// "last seen X ago" instead of looking live.
function JourneySummary({ sightings, demoMode, searchResult, live = false, liveWindowMs = null, liveNowMs = null }) {
  const [lightbox, setLightbox] = useState(null); // full-size snapshot viewer
  const summary = useMemo(() => {
    if (!sightings?.length) return null;
    const ordered = [...sightings].sort(
      (a, b) => new Date(a.started_at) - new Date(b.started_at),
    );
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const cams = new Set(ordered.map((s) => s.camera_id)).size;
    const spanSec = Math.max(
      0,
      (new Date(last.ended_at || last.started_at) - new Date(first.started_at)) / 1000,
    );
    // Journey stops = consecutive same-camera sightings merged into one visit,
    // each with its time span, sighting count and best match. This is the clean
    // chronological "where they went" sequence the timeline renders.
    const stops = [];
    for (const s of ordered) {
      const label = s.camera_name || s.camera_code || s.camera_id?.slice(0, 8) || '?';
      const sim = s.best_similarity || 0;
      const snap = s.cover || s.best_snapshot_uri || null;
      const prev = stops[stops.length - 1];
      if (prev && prev.label === label) {
        prev.end = s.ended_at || s.started_at;
        prev.count += 1;
        if (sim > prev.bestSim) { prev.bestSim = sim; prev.snapshot = snap; }
      } else {
        stops.push({ label, start: s.started_at, end: s.ended_at || s.started_at, count: 1, bestSim: sim, snapshot: snap });
      }
    }
    return { first, last, cams, spanSec, stops };
  }, [sightings]);

  if (!summary) return null;
  const { first, last, cams, spanSec, stops } = summary;
  const subject = demoMode ? DEMO_SUBJECT_NAME : 'This person';
  const firstCam = first.camera_name || first.camera_code || first.camera_id?.slice(0, 8) || 'a camera';
  const single = sightings.length === 1;

  // Plain-language "what happened" recap — explains the route in words, capped
  // so a long back-and-forth journey doesn't turn into a wall of text.
  const story = [];
  if (stops.length > 1) {
    const f = stops[0];
    const l = stops[stops.length - 1];
    story.push(`${subject} was first seen at ${f.label} at ${shortTime(f.start)}.`);
    if (stops.length <= 6) {
      for (let i = 1; i < stops.length - 1; i += 1) {
        const c = stops[i];
        const dur = Math.max(0, (new Date(c.end) - new Date(c.start)) / 1000);
        story.push(`Then ${c.label} at ${shortTime(c.start)}${dur > 5 ? `, stayed ${secondsToHuman(dur)}` : ''}.`);
      }
    } else {
      story.push(`Then moved through ${stops.length - 2} more camera stops.`);
    }
    story.push(`Last seen at ${l.label} at ${shortTime(l.start)} — ${secondsToHuman(spanSec)} across the journey.`);
  }

  return (
    <div className="mb-5 overflow-hidden rounded-xl border border-line bg-surface">
      {/* header — one-line plain-language recap */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle bg-surface-sunken/70 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
            <MapPin size={16} />
          </span>
          <div>
            <h3 className="text-body font-semibold tracking-tight text-fg">Movement timeline</h3>
            <p className="text-small text-fg-muted">
              {single
                ? `${subject} was seen once at ${firstCam}.`
                : `${subject} moved across ${cams} camera${cams === 1 ? '' : 's'} — ${shortTime(first.started_at)} → ${shortTime(last.started_at)} · ${secondsToHuman(spanSec)}`}
            </p>
          </div>
        </div>
        {demoMode && (
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-brand-ink">
            Demo
          </span>
        )}
      </div>

      {/* horizontal chronological timeline — scrolls when the route is long */}
      <div className="overflow-x-auto px-4 py-5">
        <ol className="flex min-w-max items-start">
          {stops.map((v, i) => {
            const visitSec = Math.max(0, (new Date(v.end) - new Date(v.start)) / 1000);
            const isFirst = i === 0;
            const isLast = i === stops.length - 1;
            const staleSec = liveWindowMs && liveNowMs ? staleAgeSec(v.end, liveNowMs, liveWindowMs) : null;
            const cover = demoMode ? v.snapshot : personTrackerService.snapshotUrl(v.snapshot);
            return (
              <Fragment key={`${v.label}-${i}`}>
                <li className="flex w-32 shrink-0 flex-col items-center text-center">
                  <span className="text-caption font-medium tabular-nums text-fg-subtle">{shortTime(v.start)}</span>
                  {/* matched face photo for this stop (number as a badge) */}
                  <div className="relative my-1.5">
                    {cover ? (
                      <img
                        src={cover}
                        alt={v.label}
                        loading="lazy"
                        onClick={() => setLightbox(cover)}
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          if (e.currentTarget.nextSibling) e.currentTarget.nextSibling.style.display = 'flex';
                        }}
                        className="h-12 w-12 cursor-zoom-in rounded-full object-cover shadow-sm ring-2 ring-brand-line hover:ring-brand"
                      />
                    ) : null}
                    <span
                      className={`h-12 w-12 items-center justify-center rounded-full text-white shadow-sm ring-2 ${
                        isLast && live ? 'ring-danger' : 'ring-brand-line'
                      }`}
                      style={{ background: ORANGE, display: cover ? 'none' : 'flex' }}
                    >
                      <CameraIcon size={18} />
                    </span>
                    {isLast && live && (
                      <span className="absolute inset-0 animate-ping rounded-full ring-2 ring-danger" />
                    )}
                    <span className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-fg text-micro font-bold text-fg-inverse ring-2 ring-surface">
                      {i + 1}
                    </span>
                  </div>
                  <span className="text-body font-semibold leading-tight text-fg">{v.label}</span>
                  <span className="mt-0.5 text-caption text-fg-muted">
                    {v.count > 1 ? `${v.count} hits · ` : ''}{secondsToHuman(visitSec)}
                  </span>
                  <span className="mt-1 inline-flex items-center rounded-full bg-surface-muted px-1.5 py-0.5 text-micro font-bold text-fg-secondary tabular-nums">
                    {Math.round(v.bestSim * 100)}% match
                  </span>
                  {(isFirst || isLast) && (
                    <span className={`mt-1 inline-flex items-center gap-1 text-micro font-semibold uppercase tracking-wide ${
                      isLast && live ? 'text-danger' : 'text-brand'
                    }`}>
                      {isLast && live && <span className="h-1.5 w-1.5 rounded-full bg-danger" />}
                      {isFirst ? 'Start' : isLast && live ? (staleSec != null ? 'Latest' : 'Live') : 'Last seen'}
                    </span>
                  )}
                  {staleSec != null && (
                    <span className="mt-0.5 text-caption text-fg-muted">last seen {formatAgo(staleSec)} ago</span>
                  )}
                </li>
                {!isLast && (
                  <li className="flex shrink-0 items-center pt-[42px] text-fg-disabled" aria-hidden>
                    <span className="h-0.5 w-6 rounded-full bg-line sm:w-10" />
                    <ChevronRight size={16} className="-ml-1" />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      </div>

      {/* plain-language "what happened" recap */}
      {story.length > 0 && (
        <div className="border-t border-line-subtle px-4 py-3">
          <p className="mb-2 flex items-center gap-1.5 text-caption font-semibold uppercase tracking-wide text-fg-subtle">
            <BookOpen size={12} style={{ color: ORANGE }} /> What happened
          </p>
          <ol className="space-y-1.5 text-small leading-relaxed text-fg-secondary">
            {story.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" />
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* compact stat strip */}
      <div className="grid grid-cols-2 gap-px border-t border-line-subtle bg-surface-muted sm:grid-cols-4">
        <MiniStat label="First seen" value={shortTime(first.started_at)} />
        <MiniStat label="Last seen" value={shortTime(last.started_at)} />
        <MiniStat label="Cameras" value={cams} />
        <MiniStat label="Raw matches" value={searchResult?.total_matched ?? sightings.length} />
      </div>

      {lightbox && <SnapshotLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function Chip({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-surface-sunken px-2.5 py-0.5 text-small font-medium text-fg-secondary">
      {children}
    </span>
  );
}

// Full-screen snapshot viewer: click any sighting/stop photo to open the
// COMPLETE image (object-contain, not the cropped tile), click the image to
// toggle 2× zoom, click backdrop / press Esc to close.
function SnapshotLightbox({ src, onClose }) {
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!src) return null;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-label="Snapshot viewer"
    >
      <div className={`${zoom ? 'overflow-auto' : ''} max-h-[calc(var(--app-vh)*0.94)] max-w-[calc(var(--app-vw)*0.96)]`} onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt="Snapshot full view"
          onClick={() => setZoom((z) => !z)}
          className={
            zoom
              ? 'cursor-zoom-out scale-[1.75] origin-top-left transition-transform'
              : 'cursor-zoom-in max-h-[calc(var(--app-vh)*0.92)] max-w-[calc(var(--app-vw)*0.94)] object-contain rounded-lg shadow-2xl transition-transform'
          }
        />
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-xl font-bold text-white hover:bg-white/30"
      >
        ×
      </button>
      <span className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-caption text-white/80">
        click image to zoom · Esc to close
      </span>
    </div>
  );
}

// Compact stat cell for the timeline footer strip (gap-px on a slate bg draws
// the hairline dividers between cells).
function MiniStat({ label, value }) {
  return (
    <div className="bg-surface px-3 py-2.5 text-center">
      <div className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="mt-0.5 text-body font-bold text-fg tabular-nums">{value}</div>
    </div>
  );
}

// Color-code the match strength so strong hits read green at a glance.
function matchTone(pct) {
  if (pct >= 80) return 'bg-success';
  if (pct >= 60) return 'bg-warning';
  return 'bg-slate-500';
}

function SightingCard({ sighting }) {
  const started = formatTime(sighting.started_at);
  const dur = secondsToHuman(secondsBetween(sighting.started_at, sighting.ended_at));
  const cam = sighting.camera_name || sighting.camera_code || sighting.camera_id?.slice(0, 8) || '?';
  const pct = Math.round((sighting.best_similarity || 0) * 100);
  // The real matched-face crop: a demo cover, else the backend snapshot
  // proxy resolving `best_snapshot_uri`. null → graceful placeholder tile.
  const cover = sighting.cover || personTrackerService.snapshotUrl(sighting.best_snapshot_uri);
  const [imgState, setImgState] = useState(cover ? 'loading' : 'none'); // loading|ok|error|none
  const [open, setOpen] = useState(false); // full-size lightbox

  return (
    <div className="group overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-brand-line hover:shadow-lg">
      <div className="relative aspect-video overflow-hidden bg-slate-900">
        {cover && imgState !== 'error' ? (
          <>
            <img
              src={cover}
              alt={`Match on ${cam}`}
              loading="lazy"
              onClick={() => setOpen(true)}
              onLoad={() => setImgState('ok')}
              onError={() => setImgState('error')}
              className={`h-full w-full cursor-zoom-in object-cover transition duration-300 group-hover:scale-[1.03] ${
                imgState === 'ok' ? 'opacity-100' : 'opacity-0'
              }`}
            />
            {imgState === 'loading' && <div className="absolute inset-0 animate-pulse bg-slate-800" />}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 text-fg-muted">
            <CameraIcon size={22} className="mb-1" />
            <span className="text-small">No snapshot</span>
          </div>
        )}

        {/* match-strength pill */}
        <span
          className={`absolute right-2 top-2 inline-flex items-center rounded-full ${matchTone(pct)} px-2 py-0.5 text-caption font-bold text-white shadow-md ring-1 ring-white/25`}
        >
          {pct}% match
        </span>

        {/* camera label over a readability gradient */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent px-2.5 pb-2 pt-6">
          <span className="inline-flex items-center gap-1.5 text-small font-semibold text-white drop-shadow">
            <CameraIcon size={12} /> {cam}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2.5 text-small">
        <span className="inline-flex items-center gap-1.5 text-fg-secondary">
          <Clock3 size={12} className="text-fg-subtle" /> {started}
        </span>
        <span className="font-medium text-fg-subtle">{dur}</span>
      </div>

      {open && <SnapshotLightbox src={cover} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PathMap({ data }) {
  const pinned = (data.stops || []).filter((s) => s.lat != null && s.lng != null);
  if (!pinned.length) {
    return (
      <div className="rounded-lg border border-warning-line bg-warning-soft text-warning-ink px-3 py-2 text-body">
        Cameras don't have coordinates configured. Add lat/lng under <code>/camera-setup</code> → Mapping to see the path on a map.
      </div>
    );
  }
  const center = [pinned[0].lat, pinned[0].lng];
  return (
    <div className="h-[420px] rounded-xl overflow-hidden border border-line">
      <MapContainer center={center} zoom={17} scrollWheelZoom className="h-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {data.path?.length > 1 && (
          <Polyline positions={data.path} pathOptions={{ color: ORANGE, weight: 4, opacity: 0.85 }} />
        )}
        {pinned.map((s, i) => {
          const thumb = s.cover || personTrackerService.snapshotUrl(s.snapshot_uri);
          return (
            <Marker key={s.sighting_id || i} position={[s.lat, s.lng]}>
              <Popup>
                <div className="text-small">
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="mb-1.5 h-16 w-24 rounded object-cover"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                  ) : null}
                  <div className="font-medium">{s.name || s.camera_name || s.camera_code}</div>
                  <div className="text-fg-muted">{formatTime(s.time)}</div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}

function UncoordinatedList({ stops }) {
  const missing = stops.filter((s) => s.lat == null || s.lng == null);
  if (!missing.length) return null;
  return (
    <div className="mt-3 text-small text-fg-muted">
      <span className="font-medium text-fg-secondary">No map pin for:</span>{' '}
      {missing.map((s) => s.name || s.camera_name || s.camera_code || s.camera_id).join(', ')}
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Compact clock time (e.g. "10:42 AM") for the at-a-glance summary tiles.
function shortTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function secondsBetween(a, b) {
  try {
    return Math.max(0, (new Date(b) - new Date(a)) / 1000);
  } catch {
    return 0;
  }
}

function secondsToHuman(s) {
  if (!s) return '0s';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}
