import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { aiService } from '@/core/services/ai'

const STREAM = 'reception'

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}
function fmtClock(ts) {
  if (!ts) return '—'
  try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) } catch { return '—' }
}

export default function AttendancePanel() {
  const [snap, setSnap] = useState(null)
  const [drawing, setDrawing] = useState(false)
  const [pts, setPts] = useState([])        // draft: [A, B, insideMarker] normalised
  const [saving, setSaving] = useState(false)
  const boxRef = useRef(null)

  const attendanceQ = useQuery({ queryKey: ['activity-attendance'], queryFn: () => aiService.activityAttendance(), refetchInterval: 3000 })
  const lineQ = useQuery({ queryKey: ['activity-line', STREAM], queryFn: () => aiService.activityGetLine(STREAM), staleTime: 60_000 })
  const savedLine = lineQ.data?.line || null

  // Live snapshot polling (authed blob → object URL).
  useEffect(() => {
    let alive = true, cur = null
    const tick = async () => {
      try {
        const b = await aiService.activitySnapshotBlob(STREAM)
        if (!alive || !b || !b.size) return
        const u = URL.createObjectURL(b)
        setSnap((p) => { if (p) URL.revokeObjectURL(p); return u })
        cur = u
      } catch { /* keep last */ }
    }
    tick(); const iv = setInterval(tick, 1200)
    return () => { alive = false; clearInterval(iv); if (cur) URL.revokeObjectURL(cur) }
  }, [])

  const onClick = (e) => {
    if (!drawing || !boxRef.current) return
    const r = boxRef.current.getBoundingClientRect()
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    setPts((prev) => (prev.length >= 3 ? prev : [...prev, { x, y }]))
  }

  const startDraw = () => { setPts([]); setDrawing(true) }
  const cancel = () => { setPts([]); setDrawing(false) }
  const save = async () => {
    if (pts.length < 3) return
    setSaving(true)
    const [a, b, ins] = pts
    try {
      await aiService.activitySetLine({ stream: STREAM, line: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, inside_x: ins.x, inside_y: ins.y } })
      await lineQ.refetch()
      setDrawing(false); setPts([])
    } finally { setSaving(false) }
  }
  const clearLine = async () => { await aiService.activitySetLine({ stream: STREAM, line: null }); lineQ.refetch() }

  const inside = attendanceQ.data?.inside || []
  const recent = attendanceQ.data?.recent || []
  const shown = drawing ? { pts } : savedLine
  const step = pts.length === 0 ? 'Click the FIRST end of the line' : pts.length === 1 ? 'Click the SECOND end' : pts.length === 2 ? 'Click a point on the INSIDE' : 'Ready — Save'

  return (
    <div style={{ display: 'flex', gap: 15, flexWrap: 'wrap', marginBottom: 24 }}>
      {/* Feed + line tool */}
      <div style={{ flex: '2 1 360px', minWidth: 0 }}>
        <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-info-text)' }}>videocam</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-on-bg)' }}>CP IP Cam · In/Out line</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {!drawing ? (
                <>
                  <button onClick={startDraw} style={btn('primary')}>{savedLine ? 'Redraw line' : 'Draw line'}</button>
                  {savedLine && <button onClick={clearLine} style={btn('ghost')}>Clear</button>}
                </>
              ) : (
                <>
                  <button onClick={save} disabled={pts.length < 3 || saving} style={btn(pts.length < 3 ? 'disabled' : 'primary')}>{saving ? 'Saving…' : 'Save'}</button>
                  <button onClick={cancel} style={btn('ghost')}>Cancel</button>
                </>
              )}
            </div>
          </div>
          <div
            ref={boxRef}
            onClick={onClick}
            style={{ position: 'relative', aspectRatio: '16 / 9', background: '#0b1220', cursor: drawing ? 'crosshair' : 'default' }}
          >
            {snap
              ? <img src={snap} alt="feed" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }} />
              : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,.5)', fontSize: 12 }}>connecting…</div>}
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <LineOverlay shown={shown} drawingPts={drawing ? pts : null} />
            </svg>
            {drawing && (
              <div style={{ position: 'absolute', left: 10, bottom: 10, background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 6 }}>{step}</div>
            )}
            {!savedLine && !drawing && (
              <div style={{ position: 'absolute', left: 10, bottom: 10, background: 'rgba(0,0,0,.65)', color: '#fbbf24', fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 6 }}>No line yet — click “Draw line”.</div>
            )}
          </div>
        </div>
      </div>

      {/* Who's inside + counts */}
      <div style={{ flex: '1 1 280px', minWidth: 0 }}>
        <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--color-success-text)', lineHeight: 1 }}>{inside.length}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-bg)' }}>inside now</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--color-text-muted)', fontWeight: 600 }}>from face data</span>
          </div>
          <div style={{ flex: 1, maxHeight: 250, overflowY: 'auto' }}>
            {inside.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12.5 }}>Nobody inside right now.</div>
            ) : inside.map((p) => (
              <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>
                <div style={{ width: 30, height: 30, borderRadius: 99, background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 17, color: 'var(--color-success-text)' }}>{p.name ? 'person' : 'person_outline'}</span>
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-bg)' }}>{p.name || 'Unidentified'}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>in since {fmtClock(p.entered_at)}</div>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--color-success-text)' }}>{fmtDur(p.duration_sec)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent in/out log — full width */}
      <div style={{ flex: '1 1 100%', minWidth: 0 }}>
        <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-info-text)' }}>login</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-on-bg)' }}>Entry / exit log</span>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {recent.length === 0 ? (
              <div style={{ padding: 22, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12.5 }}>No crossings recorded yet — draw the line, and it logs everyone who steps in or out.</div>
            ) : recent.map((c, i) => {
              const isIn = c.direction === 'in'
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: i ? '1px solid var(--color-border)' : 'none' }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: isIn ? 'var(--color-success-text)' : 'var(--status-neutral-text)' }}>{isIn ? 'login' : 'logout'}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, color: isIn ? 'var(--color-success-text)' : 'var(--status-neutral-text)', width: 34 }}>{isIn ? 'IN' : 'OUT'}</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-bg)', flex: 1, minWidth: 0 }}>{c.name || 'Unidentified'}</span>
                  {!isIn && c.duration_sec != null && <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>stayed {fmtDur(c.duration_sec)}</span>}
                  <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(c.ts)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function LineOverlay({ shown, drawingPts }) {
  // Draft while drawing.
  if (drawingPts) {
    const p = drawingPts
    return (
      <>
        {p.length >= 2 && <line x1={p[0].x * 100} y1={p[0].y * 100} x2={p[1].x * 100} y2={p[1].y * 100} stroke="#fbbf24" strokeWidth="0.8" />}
        {p.map((pt, i) => <circle key={i} cx={pt.x * 100} cy={pt.y * 100} r={i === 2 ? 1.4 : 1} fill={i === 2 ? '#16a34a' : '#fbbf24'} />)}
        {p.length === 3 && <text x={p[2].x * 100 + 2} y={p[2].y * 100} fill="#16a34a" fontSize="3" fontWeight="700">inside</text>}
      </>
    )
  }
  // Saved line.
  if (shown && shown.x1 != null) {
    return (
      <>
        <line x1={shown.x1 * 100} y1={shown.y1 * 100} x2={shown.x2 * 100} y2={shown.y2 * 100} stroke="#16a34a" strokeWidth="0.8" />
        <circle cx={shown.inside_x * 100} cy={shown.inside_y * 100} r="1.2" fill="#16a34a" />
        <text x={shown.inside_x * 100 + 2} y={shown.inside_y * 100} fill="#16a34a" fontSize="3" fontWeight="700">inside</text>
      </>
    )
  }
  return null
}

function btn(kind) {
  const base = { fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 7, cursor: 'pointer', border: 'none' }
  if (kind === 'primary') return { ...base, background: 'var(--action-primary)', color: '#fff' }
  if (kind === 'ghost') return { ...base, background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }
  return { ...base, background: 'var(--color-border)', color: 'var(--color-text-muted)', cursor: 'not-allowed' }
}
