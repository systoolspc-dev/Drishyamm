import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminApi } from '../services/api'
import { Topbar } from './layout/Layout.jsx'

// Every POLL_MS while the tab is visible: services, the chosen customer's
// camera health and live ops numbers. The heavy /admin/stats aggregates (the
// account table, the customer's AI usage) load once per customer and on the
// Refresh button only — they were re-run every 8 s before.
const POLL_MS = 30_000

/**
 * LiveMonitor — advanced ops "mission control" for the whole installation.
 * Everything is DYNAMIC (live endpoints, nothing hardcoded):
 *   • infra services up/down (/admin/system-health)
 *   • per-client camera-stream health + on-click live WebRTC preview
 *   • per-client live activity: model inferences (frames), people detected,
 *     stream viewers, alerts triggered / delivered / unacked
 *   • which account uses which features & how much (global stats → per-org)
 * Scoped styles (.lm-*) so it doesn't depend on admin.css internals.
 */
const STATUS_META = {
  healthy: { label: 'Online', tone: 'ok' }, transcoding: { label: 'Transcoding', tone: 'ok' }, streaming: { label: 'Online', tone: 'ok' },
  starting: { label: 'Connecting', tone: 'warn' }, standby: { label: 'Idle', tone: 'idle' }, wobbling: { label: 'Unstable', tone: 'warn' },
  offline: { label: 'Offline', tone: 'bad' }, unknown: { label: 'Unknown', tone: 'bad' },
}
const DOWN = new Set(['offline', 'unknown'])
const fmtAgo = (s) => (s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`)
const fmtBps = (b) => (!b ? '0' : b > 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1e3)} Kbps`)
const nf = (n) => Number(n || 0).toLocaleString()
const kf = (n) => { n = Number(n || 0); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}` }

export default function LiveMonitor() {
  const [customers, setCustomers] = useState([])
  const [userId, setUserId] = useState('')
  const [health, setHealth] = useState(null)
  const [fleet, setFleet] = useState(null)
  const [stats, setStats] = useState(null)
  const [metrics, setMetrics] = useState(null)
  const [orgs, setOrgs] = useState([])
  const [preview, setPreview] = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)

  // Customer accounts only (owners) — not operators or sub-users.
  useEffect(() => {
    adminApi.listAccounts().then((d) => {
      const list = (d.accounts || []).map((a) => ({ id: a.id, name: a.name, cameras: a.cameras?.used || 0 }))
      setCustomers(list)
      const best = [...list].sort((a, b) => (b.cameras || 0) - (a.cameras || 0))[0]
      if (best) setUserId(best.id)
    }).catch(() => {})
  }, [])

  // Light, polled
  const loadSystem = useCallback(async () => {
    try { setHealth(await adminApi.getSystemHealth()) } catch { /* keep */ }
  }, [])
  const loadClient = useCallback(async () => {
    if (!userId) return
    try {
      const [f, m] = await Promise.all([
        adminApi.getCustomerCameraHealth(userId),
        adminApi.getOpsMetrics(userId),
      ])
      setFleet(f); setMetrics(m); setUpdatedAt(Date.now())
    } catch { /* keep */ }
  }, [userId])
  // Heavy, not polled
  const loadOrgs = useCallback(async () => {
    try { const g = await adminApi.getStats({ range: '7d' }); setOrgs((g?.stats || g)?.topOrgs || []) } catch { /* keep */ }
  }, [])
  const loadClientStats = useCallback(async () => {
    if (!userId) return
    try { const s = await adminApi.getStats({ userId, range: '24h' }); setStats(s?.stats || s) } catch { /* keep */ }
  }, [userId])

  useEffect(() => {
    let live = true
    adminApi.getStats({ range: '7d' }).then((g) => { if (live) setOrgs((g?.stats || g)?.topOrgs || []) }).catch(() => {})
    return () => { live = false }
  }, [])
  useEffect(() => {
    if (!userId) return undefined
    let live = true
    adminApi.getStats({ userId, range: '24h' }).then((s) => { if (live) setStats(s?.stats || s) }).catch(() => {})
    return () => { live = false }
  }, [userId])
  useEffect(() => { (async () => { setLoading(true); await Promise.all([loadSystem(), loadClient()]); setLoading(false) })() }, [loadSystem, loadClient])
  useEffect(() => {
    const tick = () => { if (!document.hidden) { loadSystem(); loadClient() } }
    const t = setInterval(tick, POLL_MS)
    // Coming back to the tab refreshes at once instead of waiting a full period.
    const onVisible = () => { if (!document.hidden) { loadSystem(); loadClient() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [loadSystem, loadClient])
  const refreshAll = () => { loadSystem(); loadClient(); loadOrgs(); loadClientStats() }

  // Warm the on-demand stream (backend registers the path + starts the
  // H265→264 transcode if needed), THEN render the platform's proven
  // WebRTCStream player — same live WebRTC pipeline the operator app uses.
  const openPreview = useCallback(async (cam) => {
    setPreview({ monitorId: cam.monitorId, name: cam.name, status: cam.status, warmed: false, streamId: cam.monitorId })
    try {
      const r = await adminApi.adminStreamStart(cam.monitorId)
      // For H265 cameras the playable stream is the transcoded `cam_<id>_h264`
      // path — extract the real stream name from the returned WHEP URL so the
      // WebRTC player targets the H.264 sidecar, not the undecodable H265 path.
      // The backend returns the WHEP base (e.g. /whep/cam_<id> or the H264
      // sidecar /whep/cam_<id>_h264); the actual WebRTC POST target needs the
      // `/whep` action suffix — same URL the operator Live View negotiates.
      const base = (r?.webrtcUrl || `/whep/cam_${cam.monitorId}`).replace(/\/+$/, '')
      const url = base.endsWith('/whep') ? base : `${base}/whep`
      setPreview((p) => (p && p.monitorId === cam.monitorId ? { ...p, url, warmed: true } : p))
    } catch {
      setPreview((p) => (p && p.monitorId === cam.monitorId ? { ...p, url: `/whep/cam_${cam.monitorId}/whep`, warmed: true } : p))
    }
  }, [])

  // ── derived ──
  const comps = health?.components || {}
  const services = useMemo(() => {
    const out = []
    if (comps.db) out.push({ name: 'Database', ok: comps.db.ok, meta: `${comps.db.latencyMs ?? '—'}ms` })
    if (comps.redis) out.push({ name: 'Redis', ok: comps.redis.ok, meta: `${comps.redis.latencyMs ?? '—'}ms` })
    if (comps.aiService) out.push({ name: 'AI Engine', ok: comps.aiService.ok, meta: `${comps.aiService.latencyMs ?? '—'}ms` })
    for (const m of (comps.mediamtx || [])) out.push({ name: m.name || 'Stream Service', ok: m.ok, meta: `${m.paths ?? 0} paths` })
    return out
  }, [comps])

  const cams = useMemo(() => {
    const list = fleet?.cameras ? [...fleet.cameras] : []
    return list.sort((a, b) => (DOWN.has(b.status) - DOWN.has(a.status)) || String(a.name).localeCompare(String(b.name)))
  }, [fleet])
  const sum = fleet?.summary || {}
  // Same buckets as the customer Health page: idle (standby) cameras are
  // reachable and count as online; "streaming" = video flowing right now.
  const streaming = (sum.healthy || 0) + (sum.transcoding || 0) + (sum.starting || 0)
  const online = streaming + (sum.standby || 0)
  const offline = (sum.offline || 0) + (sum.unknown || 0)
  const m = metrics || {}
  const mAi = m.ai || {}; const mAlert = m.alerts || {}; const mStream = m.streams || {}

  return (
    <div className="page">
    <Topbar title="Live monitor" subtitle="Services, camera streams, AI activity and alerts for one customer" />
    <div className="page-inner">
    <div className="lm">
      <style>{LM_CSS}</style>

      <div className="lm-head">
        <div>
          <p className="lm-sub">Refreshes every 30 s while this tab is open. Video starts only when you click Live on a camera.</p>
        </div>
        <div className="lm-controls">
          <select className="lm-select" aria-label="Customer account" value={userId} onChange={(e) => setUserId(e.target.value)}>
            {customers.length === 0 && <option>Loading…</option>}
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.cameras || 0} cams</option>)}
          </select>
          <button className="lm-btn" title="Refresh" aria-label="Refresh" onClick={refreshAll}><span className="material-symbols-outlined">refresh</span></button>
          <span className="lm-updated">{updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span>
        </div>
      </div>

      {/* infra services */}
      <div className="lm-services">
        {services.length === 0 && <span className="lm-muted">Checking services…</span>}
        {services.map((s, i) => (
          <div key={i} className={`lm-svc ${s.ok ? 'ok' : 'bad'}`}><span className="lm-dot" /><span className="lm-svc-name">{s.name}</span><span className="lm-svc-meta">{s.ok ? s.meta : 'DOWN'}</span></div>
        ))}
      </div>

      {/* live activity metrics — the "is it actually working" numbers */}
      <div className="lm-metrics">
        <Metric icon="memory"       big={kf(mAi.framesProcessed)} label="Model inferences" sub={`${mAi.detectingCameras || 0} cams · ${mAi.avgFps || 0} fps`} tone="pri" />
        <Metric icon="groups"       big={nf(mAi.personsNow)}      label="People detected now" sub={`${mAi.boxesNow || 0} boxes live`} tone="ok" />
        <Metric icon="visibility"   big={nf(mStream.liveViewers)} label="Live viewers" sub={`${mStream.streaming || 0} streaming`} tone="pri" />
        <Metric icon="notifications_active" big={nf(mAlert.triggered24h)} label="Alerts triggered (24h)" sub={`${mAlert.critical24h || 0} critical`} tone={mAlert.triggered24h ? 'warn' : 'idle'} />
        <Metric icon="send"         big={nf((mAlert.sentPush || 0) + (mAlert.sentEmail || 0))} label="Alerts sent today" sub={`${nf(mAlert.sentPush)} push · ${nf(mAlert.sentEmail)} email`} tone="ok" />
        <Metric icon="mark_email_unread" big={nf(mAlert.unacked)} label="Unacknowledged · 7 d" sub={`${mAlert.pushDevices || 0} devices · ${mAlert.emailRecipients || 0} emails`} tone={mAlert.unacked ? 'bad' : 'idle'} />
      </div>

      <div className="lm-grid2">
        {/* camera streams */}
        <div className="lm-panel">
          <div className="lm-panel-head"><span className="material-symbols-outlined">grid_view</span> Camera streams
            <span className="lm-count">{online}/{sum.total ?? cams.length} online · {streaming} streaming</span>
            {offline > 0 && <span className="lm-flag">{offline} down</span>}
          </div>
          {loading && !cams.length ? <div className="lm-empty">Loading camera health…</div>
            : cams.length === 0 ? <div className="lm-empty">No cameras for this customer.</div>
              : (
                <div className="lm-cams">
                  {cams.map((c) => {
                    const meta = STATUS_META[c.status] || STATUS_META.unknown
                    return (
                      <div key={c.id} className={`lm-cam ${meta.tone}`}>
                        <div className="lm-cam-top">
                          <span className={`lm-pill ${meta.tone}`}><span className="lm-dot" />{meta.label}</span>
                          <button className="lm-live" onClick={() => openPreview(c)}><span className="material-symbols-outlined">play_circle</span> Live</button>
                        </div>
                        <div className="lm-cam-name" title={c.name}>{c.name}</div>
                        <div className="lm-cam-meta">
                          <span>{c.codec || '—'}{c.resolution ? ` · ${c.resolution}` : ''}</span>
                          <span>{c.readers ?? 0} viewers · {fmtBps(c.meanBps || c.bpsIn)}</span>
                        </div>
                        <div className="lm-cam-tags">
                          {c.transcoder && <span className={`lm-tag ${c.transcoder.running ? 'ok' : 'bad'}`}>H265→264 {c.transcoder.running ? 'on' : 'off'}</span>}
                          {c.flapCount > 0 && <span className="lm-tag warn">{c.flapCount} flaps</span>}
                          {c.framesInError > 0 && <span className="lm-tag warn">frame errs</span>}
                          <span className="lm-tag idle">seen {fmtAgo(c.readSinceSec)}</span>
                        </div>
                        {c.reason && DOWN.has(c.status) && <div className="lm-cam-reason">{c.reason}</div>}
                      </div>
                    )
                  })}
                </div>
              )}
        </div>

        {/* AI features for this client */}
        <div className="lm-panel">
          <div className="lm-panel-head"><span className="material-symbols-outlined">neurology</span> AI features (this client)</div>
          <div className="lm-ai">
            <AiRow label="Face recognition" value={(stats?.aiFeatures || {}).face_recognition} icon="face" />
            <AiRow label="Person detection" value={(stats?.aiFeatures || {}).person_detection} icon="directions_walk" />
            <AiRow label="Behavior / alerts" value={(stats?.aiFeatures || {}).behavior_alerts} icon="warning" />
            <AiRow label="Vehicle / ANPR" value={(stats?.aiFeatures || {}).vehicle_detection} icon="directions_car" />
            <div className="lm-ai-foot">
              <div><b>{(stats?.usage || {}).aiAdoptionPct ?? 0}%</b><span>AI adoption</span></div>
              <div><b>{kf((stats?.usage || {}).eventsStored ?? stats?.totalEvents)}</b><span>events stored</span></div>
              <div><b>{kf((stats?.usage || {}).cameraHours)}</b><span>camera-hours</span></div>
            </div>
          </div>
        </div>
      </div>

      {/* which account uses which features & how much */}
      <div className="lm-panel" style={{ marginTop: 14 }}>
        <div className="lm-panel-head"><span className="material-symbols-outlined">table_chart</span> Feature usage by account</div>
        <div className="lm-tablewrap">
          <table className="lm-table">
            <thead><tr><th>Account</th><th>Cameras</th><th>AI cams</th><th>Face rec</th><th>Person</th><th>Behavior</th><th>Events</th></tr></thead>
            <tbody>
              {orgs.length === 0 && <tr><td colSpan={7} className="lm-empty sm">Loading accounts…</td></tr>}
              {orgs.map((o) => (
                <tr key={o.id} className={o.id === userId ? 'sel' : ''} onClick={() => setUserId(o.id)}>
                  <td className="lm-acc">{o.name}</td>
                  <td>{nf(o.cameras)}</td>
                  <td>{o.aiCameras ? <b>{nf(o.aiCameras)}</b> : <span className="lm-off">0</span>}</td>
                  <td>{feat(o.faceRec)}</td>
                  <td>{feat(o.personDet)}</td>
                  <td>{feat(o.behavior)}</td>
                  <td>{nf(o.events)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* live preview modal */}
      {preview && (
        <div className="lm-modal" onClick={() => setPreview(null)}>
          <div className="lm-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="lm-modal-head">
              <span className="material-symbols-outlined">videocam</span>
              <span className="lm-modal-title">{preview.name}</span>
              <span className={`lm-pill ${(STATUS_META[preview.status] || {}).tone || 'idle'}`}>{(STATUS_META[preview.status] || {}).label || preview.status}</span>
              <button className="lm-btn" style={{ marginLeft: 'auto' }} onClick={() => setPreview(null)}><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="lm-video">
              {!preview.warmed
                ? <div className="lm-empty">Warming up the stream…</div>
                : <WhepVideo key={preview.url} url={preview.url} />}
            </div>
            <p className="lm-modal-foot">Live WebRTC · started on demand when you clicked (kept off otherwise, to protect the NVR).</p>
          </div>
        </div>
      )}
    </div>
    </div>
    </div>
  )
}

function feat(v) {
  const n = Number(v || 0)
  return n ? <span className="lm-on">{n}</span> : <span className="lm-off">—</span>
}

function Metric({ icon, big, label, sub, tone }) {
  return (
    <div className={`lm-metric ${tone}`}>
      <span className="material-symbols-outlined lm-metric-ic">{icon}</span>
      <div className="lm-metric-body">
        <div className="lm-metric-big">{big}</div>
        <div className="lm-metric-label">{label}</div>
        {sub && <div className="lm-metric-sub">{sub}</div>}
      </div>
    </div>
  )
}
function AiRow({ label, value, icon }) {
  const n = Number(value || 0)
  return (
    <div className={`lm-ai-row ${n ? 'on' : ''}`}>
      <span className="material-symbols-outlined">{icon}</span>
      <span className="lm-ai-label">{label}</span>
      <span className="lm-ai-val">{n ? `${n} cam${n === 1 ? '' : 's'}` : 'off'}</span>
    </div>
  )
}

/**
 * Self-contained WHEP player — genuine WebRTC (RTCPeerConnection) negotiated
 * over MediaMTX's WHEP endpoint. Deliberately has NO main-app coupling (no
 * shared api / auth / interceptors) so it can't trigger the operator-app 401
 * redirect from inside the admin console. `url` already points at the correct
 * playable path (H.264 sidecar for H265 sources).
 */
function WhepVideo({ url }) {
  const ref = useRef(null)
  const [state, setState] = useState('connecting') // connecting | live | failed
  useEffect(() => {
    if (!url) return undefined
    let cancelled = false
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.ontrack = (e) => { if (ref.current && e.streams[0]) { ref.current.srcObject = e.streams[0]; setState('live') } }
    pc.oniceconnectionstatechange = () => { if (['failed', 'disconnected'].includes(pc.iceConnectionState)) setState((s) => (s === 'live' ? s : 'failed')) }
    ;(async () => {
      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); const t = setTimeout(r, 700); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); r() } } })
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp })
        if (!resp.ok) throw new Error(`WHEP ${resp.status}`)
        const answer = await resp.text()
        if (!cancelled && answer) await pc.setRemoteDescription({ type: 'answer', sdp: answer })
      } catch { if (!cancelled) setState('failed') }
    })()
    return () => { cancelled = true; try { pc.getSenders?.().forEach((s) => s.track?.stop()) } catch { /* */ } try { pc.close() } catch { /* */ } }
  }, [url])
  return (
    <div className="lm-whep">
      <video ref={ref} autoPlay muted playsInline className="lm-video-el" style={{ display: state === 'live' ? 'block' : 'none' }} />
      {state === 'live' && <span className="lm-livebadge"><span className="lm-dot" /> LIVE</span>}
      {state !== 'live' && (
        <div className="lm-vid-status">
          <span className="lm-spinner material-symbols-outlined">{state === 'failed' ? 'videocam_off' : 'sync'}</span>
          <span>{state === 'failed' ? 'Stream not available right now — try again in a moment.' : 'Connecting to live camera…'}</span>
        </div>
      )}
    </div>
  )
}

const LM_CSS = `
.lm{--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--idle:var(--color-text-secondary,#64748b);--pri:var(--color-primary,#F7983A);margin-bottom:22px}
.lm *{box-sizing:border-box}
.lm-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.lm-title{display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;margin:0}
.lm-title .material-symbols-outlined{color:var(--pri)}
.lm-sub{margin:2px 0 0;font-size:13px;opacity:.62}
.lm-controls{display:flex;align-items:center;gap:8px}
.lm-select{height:34px;border:1px solid var(--color-border,#e5e7eb);border-radius:8px;background:var(--color-surface,#fff);padding:0 10px;font-size:13px;font-weight:600;color:inherit;max-width:230px}
.lm-btn{height:34px;min-width:34px;display:grid;place-items:center;border:1px solid var(--color-border,#e5e7eb);border-radius:8px;background:var(--color-surface,#fff);cursor:pointer;color:inherit}
.lm-btn:hover{background:light-dark(rgba(0,0,0,.05),rgba(255,255,255,.06))}
.lm-updated{font-size:12px;opacity:.55;font-variant-numeric:tabular-nums;min-width:64px}
.lm-services{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.lm-svc{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;font-size:12.5px;font-weight:700;border:1px solid}
.lm-svc.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 9%,transparent)}
.lm-svc.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.lm-svc-meta{opacity:.7;font-weight:600}
.lm-dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 20%,transparent)}
.lm-svc.ok .lm-dot{animation:lm-pulse 1.8s infinite}
@keyframes lm-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.lm-metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px}
.lm-metric{display:flex;gap:11px;padding:13px 14px;border:1px solid var(--color-border,#e5e7eb);border-radius:12px;background:var(--color-surface,#fff)}
.lm-metric-ic{font-size:24px;opacity:.9}
.lm-metric.pri .lm-metric-ic{color:var(--pri)}.lm-metric.ok .lm-metric-ic{color:var(--ok)}.lm-metric.bad .lm-metric-ic{color:var(--bad)}.lm-metric.warn .lm-metric-ic{color:var(--warn)}.lm-metric.idle .lm-metric-ic{color:var(--idle)}
.lm-metric-big{font-size:24px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.lm-metric-label{font-size:11.5px;font-weight:700;margin-top:4px;opacity:.85}
.lm-metric-sub{font-size:10.5px;opacity:.55;margin-top:2px}
.lm-grid2{display:grid;grid-template-columns:1.55fr 1fr;gap:14px}
.lm-panel{border:1px solid var(--color-border,#e5e7eb);border-radius:14px;background:var(--color-surface,#fff);padding:14px}
.lm-panel-head{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;opacity:.8;margin-bottom:12px}
.lm-panel-head .material-symbols-outlined{font-size:18px;color:var(--pri)}
.lm-count{margin-left:auto;font-size:11px;opacity:.6;text-transform:none;letter-spacing:0}
.lm-flag{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent);padding:2px 8px;border-radius:999px;font-size:11px;margin-left:8px}
.lm-cams{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:10px}
.lm-cam{border:1px solid var(--color-border,#e5e7eb);border-radius:11px;padding:11px;background:var(--color-surface,#fff)}
.lm-cam.offline,.lm-cam.unknown{border-color:color-mix(in srgb,var(--bad) 45%,transparent);background:color-mix(in srgb,var(--bad) 6%,transparent)}
.lm-cam.wobbling{border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.lm-cam-top{display:flex;justify-content:space-between;align-items:center;gap:6px}
.lm-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}
.lm-pill.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.lm-pill.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.lm-pill.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}
.lm-pill.idle{color:var(--idle);background:color-mix(in srgb,var(--idle) 12%,transparent)}
.lm-live{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:700;color:var(--pri);background:none;border:0;cursor:pointer;padding:2px 4px;border-radius:6px}
.lm-live:hover{background:color-mix(in srgb,var(--pri) 12%,transparent)}
.lm-live .material-symbols-outlined{font-size:15px}
.lm-cam-name{font-size:14px;font-weight:700;margin:7px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lm-cam-meta{display:flex;flex-direction:column;gap:1px;font-size:11px;opacity:.62}
.lm-cam-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.lm-tag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:5px}
.lm-tag.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.lm-tag.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.lm-tag.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.lm-tag.idle{color:var(--idle);background:color-mix(in srgb,var(--idle) 12%,transparent)}
.lm-cam-reason{margin-top:7px;font-size:11px;color:var(--bad);opacity:.9}
.lm-ai{display:flex;flex-direction:column;gap:7px}
.lm-ai-row{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--color-border,#e5e7eb);border-radius:9px;font-size:13px;opacity:.55}
.lm-ai-row.on{opacity:1;border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 6%,transparent)}
.lm-ai-row .material-symbols-outlined{font-size:18px;color:var(--pri)}
.lm-ai-label{font-weight:600}.lm-ai-val{margin-left:auto;font-weight:800;font-size:12px}
.lm-ai-foot{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px;text-align:center}
.lm-ai-foot div{border:1px solid var(--color-border,#e5e7eb);border-radius:9px;padding:8px}
.lm-ai-foot b{display:block;font-size:16px;font-weight:800}.lm-ai-foot span{font-size:10px;opacity:.6}
.lm-tablewrap{overflow-x:auto}
.lm-table{width:100%;border-collapse:collapse;font-size:12.5px}
.lm-table th{text-align:left;padding:8px 10px;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.55;border-bottom:1px solid var(--color-border,#e5e7eb)}
.lm-table td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,var(--color-border,#e5e7eb) 55%,transparent);font-variant-numeric:tabular-nums}
.lm-table tr{cursor:pointer}.lm-table tbody tr:hover{background:color-mix(in srgb,var(--pri) 5%,transparent)}
.lm-table tr.sel{background:color-mix(in srgb,var(--pri) 9%,transparent)}
.lm-acc{font-weight:700}
.lm-on{color:var(--ok);font-weight:800}.lm-off{opacity:.35}
.lm-empty{padding:26px;text-align:center;opacity:.55;font-size:13px}.lm-empty.sm{padding:14px}
.lm-muted{opacity:.5;font-size:13px}
.lm-modal{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:20px}
.lm-modal-box{width:min(880px,calc(var(--app-vw)*0.94));background:var(--color-surface,#111);border:1px solid var(--color-border,#333);border-radius:14px;overflow:hidden}
.lm-modal-head{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--color-border,#333)}
.lm-modal-title{font-weight:800;font-size:15px}
.lm-video{aspect-ratio:16/9;background:#000;display:grid;place-items:center}
.lm-video-el{width:100%;height:100%;object-fit:contain;background:#000}
.lm-whep{position:relative;width:100%;height:100%;display:grid;place-items:center}
.lm-livebadge{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:5px;background:#dc2626;color:#fff;font-size:11px;font-weight:800;letter-spacing:.05em;padding:3px 9px;border-radius:6px}
.lm-livebadge .lm-dot{background:#fff;animation:lm-pulse 1.4s infinite}
.lm-vid-status{display:flex;flex-direction:column;align-items:center;gap:10px;color:#94a3b8;font-size:13px;text-align:center;padding:20px}
.lm-vid-status .lm-spinner{font-size:34px;color:var(--pri)}
.lm-vid-status .material-symbols-outlined{animation:lm-spin 1.4s linear infinite}
@keyframes lm-spin{to{transform:rotate(360deg)}}
.lm-modal-foot{margin:0;padding:9px 14px;font-size:11.5px;opacity:.6}
@media(max-width:1100px){.lm-metrics{grid-template-columns:repeat(3,1fr)}.lm-grid2{grid-template-columns:1fr}}
@media(max-width:720px){.lm-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
