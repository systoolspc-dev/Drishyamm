import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { aiService } from '@/core/services/ai'
import AttendancePanel from './AttendancePanel'
import MonitoredCameras from './MonitoredCameras'

// state → label + accent (design tokens, light/dark aware)
const STATE = {
  working:     { label: 'Working',      color: 'var(--color-success-text)', bg: 'var(--color-success-bg)', border: 'var(--color-success-border)', bar: '#16a34a' },
  on_phone:    { label: 'On phone',     color: '#b45309',                   bg: 'var(--color-warning-bg, #fef3c7)', border: '#f59e0b', bar: '#f59e0b' },
  not_working: { label: 'Away / idle',  color: 'var(--status-neutral-text)', bg: 'var(--status-neutral-bg)', border: 'var(--status-neutral-border)', bar: '#94a3b8' },
  talking:     { label: 'Talking',      color: 'var(--color-info-text)',    bg: 'var(--color-primary-bg)', border: 'var(--color-border-accent)', bar: '#2563eb' },
}
const STATE_ORDER = ['working', 'on_phone', 'talking', 'not_working']

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}
function fmtClock(ts) {
  if (!ts) return '—'
  try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '—' }
}

function StateBadge({ state }) {
  const m = STATE[state] || STATE.not_working
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: m.bar, display: 'inline-block' }} />
      {m.label}
    </span>
  )
}

function TimeBar({ stateSeconds }) {
  const total = STATE_ORDER.reduce((s, k) => s + (stateSeconds?.[k] || 0), 0) || 1
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden', background: 'var(--color-border)', minWidth: 120 }} title={STATE_ORDER.map((k) => `${STATE[k].label} ${fmtDur(stateSeconds?.[k])}`).join(' · ')}>
      {STATE_ORDER.map((k) => {
        const pct = ((stateSeconds?.[k] || 0) / total) * 100
        return pct > 0 ? <div key={k} style={{ width: `${pct}%`, background: STATE[k].bar }} /> : null
      })}
    </div>
  )
}

function StatCard({ icon, value, label, accent, bg, border }) {
  return (
    <div className="ai-hub-summary-card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderRadius: 12, minWidth: 190, flex: '1 1 190px' }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: bg, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 19, color: accent }}>{icon}</span>
      </div>
      <div>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-on-bg)', lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', fontWeight: 600 }}>{label}</div>
      </div>
    </div>
  )
}

// Live annotated feed — polls the latest JPEG (authed blob → object URL) ~1/s.
function LiveFeed({ stream }) {
  const streamId = stream?.id
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!streamId) return
    let alive = true
    let current = null
    const tick = async () => {
      try {
        const blob = await aiService.activitySnapshotBlob(streamId)
        if (!alive || !blob || blob.size === 0) return
        const next = URL.createObjectURL(blob)
        setSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return next })
        current = next
      } catch { /* keep last frame */ }
    }
    tick()
    const iv = setInterval(tick, 1200)
    return () => { alive = false; clearInterval(iv); if (current) URL.revokeObjectURL(current) }
  }, [streamId])

  const act = stream?.activity || {}
  return (
    <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-info-text)' }}>videocam</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-on-bg)' }}>{stream?.name || 'Live feed'}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, color: stream?.connected ? 'var(--color-success-text)' : 'var(--status-neutral-text)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: stream?.connected ? 'var(--color-success)' : 'var(--status-neutral-text)', display: 'inline-block' }} />
          {stream?.connected ? `LIVE · ${Math.round(stream?.fps || 0)} fps` : 'offline'}
        </span>
      </div>
      <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#0b1220', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {src
          ? <img src={src} alt="Live activity feed" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          : <span style={{ color: 'rgba(255,255,255,.5)', fontSize: 12 }}>connecting…</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', flexWrap: 'wrap' }}>
        {STATE_ORDER.map((k) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: STATE[k].bg, color: STATE[k].color, border: `1px solid ${STATE[k].border}` }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: STATE[k].bar, display: 'inline-block' }} />
            {STATE[k].label} {act[k] || 0}
          </span>
        ))}
      </div>
    </div>
  )
}

// Phone-usage evidence log — recent completed on_phone sessions.
function SessionsLog({ sessions }) {
  return (
    <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: '#b45309' }}>smartphone</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-on-bg)' }}>Phone-usage log</span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--color-text-muted)', fontWeight: 600 }}>evidence</span>
      </div>
      <div style={{ maxHeight: 320, overflowY: 'auto', flex: 1 }}>
        {(!sessions || sessions.length === 0) ? (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12.5 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 26, display: 'block', marginBottom: 6, color: 'var(--status-neutral-text)' }}>check_circle</span>
            No phone usage recorded yet today.
          </div>
        ) : sessions.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: i ? '1px solid var(--color-border)' : 'none' }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--color-warning-bg, #fef3c7)', border: '1px solid #f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#b45309' }}>smartphone</span>
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-on-bg)' }}>{s.name || 'Unidentified'}</div>
              <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>{fmtClock(s.start_ts)} – {fmtClock(s.end_ts)}</div>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#b45309' }}>{fmtDur(s.duration_sec)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Daily history — per-person phone time as day-by-day bars (grows over time).
function HistoryPanel({ history }) {
  const days = history?.days || []
  const people = history?.people || []
  if (!people.length) return null
  let max = 1
  people.forEach((p) => days.forEach((d) => { const v = p.by_date?.[d]?.on_phone_sec || 0; if (v > max) max = v }))
  const fmtDay = (d) => { try { return new Date(`${d}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }) } catch { return d } }
  return (
    <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden', marginTop: 24 }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-info-text)' }}>calendar_month</span>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--color-on-bg)' }}>Daily history</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>phone time · last {days.length} day{days.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: 'var(--color-text-muted)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'left' }}>
              <th style={{ padding: '9px 18px', fontWeight: 700 }}>Person</th>
              {days.map((d) => <th key={d} style={{ padding: '9px 8px', fontWeight: 700, textAlign: 'center' }}>{fmtDay(d)}</th>)}
              <th style={{ padding: '9px 18px', fontWeight: 700, textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.key} style={{ borderTop: '1px solid var(--color-border)' }}>
                <td style={{ padding: '9px 18px', fontWeight: 700, color: 'var(--color-on-bg)', whiteSpace: 'nowrap' }}>{p.name || 'Unidentified'}</td>
                {days.map((d) => {
                  const v = p.by_date?.[d]?.on_phone_sec || 0
                  const h = Math.max(2, Math.round((v / max) * 34))
                  return (
                    <td key={d} style={{ padding: '9px 8px', verticalAlign: 'bottom' }} title={`${fmtDay(d)}: ${fmtDur(v)}`}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <div style={{ width: 22, height: h, borderRadius: 4, background: v > 0 ? '#f59e0b' : 'var(--color-border)' }} />
                        <span style={{ fontSize: 9.5, color: 'var(--color-text-muted)' }}>{v > 0 ? fmtDur(v) : '–'}</span>
                      </div>
                    </td>
                  )
                })}
                <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 800, color: '#b45309', whiteSpace: 'nowrap' }}>{fmtDur(p.totals?.on_phone_sec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function Productivity() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['activity-people'],
    queryFn: () => aiService.activityPeople(),
    refetchInterval: 4000,
    staleTime: 3000,
  })
  const streamsQ = useQuery({ queryKey: ['activity-streams'], queryFn: () => aiService.activityStreams(), refetchInterval: 4000 })
  const sessionsQ = useQuery({ queryKey: ['activity-sessions'], queryFn: () => aiService.activitySessions({ limit: 25 }), refetchInterval: 8000 })
  const historyQ = useQuery({ queryKey: ['activity-history'], queryFn: () => aiService.activityHistory(7), refetchInterval: 30000 })
  const primaryStream = (streamsQ.data?.streams || [])[0] || null
  const sessions = sessionsQ.data?.sessions || []

  const people = (data?.people || []).slice().sort((a, b) => (b.on_phone_seconds || 0) - (a.on_phone_seconds || 0))
  const onPhoneNow = people.filter((p) => p.on_phone_now).length
  const totalPhone = people.reduce((s, p) => s + (p.on_phone_seconds || 0), 0)
  const totalSessions = people.reduce((s, p) => s + (p.phone_sessions || 0), 0)

  return (
    <div className="page-content ai-hub-shell">
      <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>

        {/* Header. The old "← AI Modules" back button pointed at the
            Analytics Hub, which no longer exists — the sidebar is the way
            back. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 7 }}>Operations &amp; Intelligence</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.25, color: 'var(--color-on-bg)', letterSpacing: '-0.025em', marginBottom: 7 }}>Productivity Monitor</h2>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 560, lineHeight: 1.55 }}>
              Per-person phone usage and activity across monitored workstations — who's on their phone, how often and how long. Updates live.
            </p>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 13px', border: '1px solid var(--color-success-border)', borderRadius: 999, background: 'var(--color-success-bg)', color: 'var(--color-success-text)', fontSize: 11.5, fontWeight: 700 }}>
            <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1.6 }} style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--color-success)', display: 'inline-block' }} />
            Live{dataUpdatedAt ? ` · ${fmtClock(dataUpdatedAt / 1000)}` : ''}
          </div>
        </div>

        {/* Which cameras run phone-usage / activity monitoring (user-controlled) */}
        <MonitoredCameras />

        {/* In/Out attendance (line crossing) — the headline feature */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 14px' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 19, color: 'var(--color-success-text)' }}>meeting_room</span>
          <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-on-bg)', margin: 0 }}>In / Out Attendance</h3>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>draw a line on the feed — recognized people are logged as they cross in and out</span>
        </div>
        <AttendancePanel />

        {/* Summary */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
          <StatCard icon="groups"          value={people.length}          label="People tracked today" accent="var(--color-info-text)" bg="var(--color-primary-bg)" border="var(--color-border-accent)" />
          <StatCard icon="smartphone"      value={onPhoneNow}             label="On phone right now"   accent="#b45309" bg="var(--color-warning-bg, #fef3c7)" border="#f59e0b" />
          <StatCard icon="schedule"        value={fmtDur(totalPhone)}     label="Total phone time"     accent="#b45309" bg="var(--color-warning-bg, #fef3c7)" border="#f59e0b" />
          <StatCard icon="touch_app"       value={totalSessions}          label="Phone pickups"        accent="var(--color-info-text)" bg="var(--color-primary-bg)" border="var(--color-border-accent)" />
        </div>

        {/* Live feed + phone-usage evidence log */}
        <div style={{ display: 'flex', gap: 15, flexWrap: 'wrap', marginBottom: 24 }}>
          <div style={{ flex: '2 1 340px', minWidth: 0 }}>
            {primaryStream
              ? <LiveFeed stream={primaryStream} />
              : <div className="ai-hub-summary-card" style={{ borderRadius: 14, padding: 28, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 12.5 }}>No monitored camera online.</div>}
          </div>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <SessionsLog sessions={sessions} />
          </div>
        </div>

        {/* Table */}
        <div className="ai-hub-summary-card" style={{ borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--color-info-text)' }}>leaderboard</span>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--color-on-bg)' }}>Per-person breakdown</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>sorted by phone time</span>
          </div>

          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>Loading activity…</div>
          ) : isError ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 30, color: 'var(--status-neutral-text)', display: 'block', marginBottom: 8 }}>cloud_off</span>
              Activity service isn't reachable yet.
            </div>
          ) : people.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 30, color: 'var(--status-neutral-text)', display: 'block', marginBottom: 8 }}>person_search</span>
              No one detected on the monitored cameras yet today.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    <th style={{ padding: '10px 18px', fontWeight: 700 }}>#</th>
                    <th style={{ padding: '10px 12px', fontWeight: 700 }}>Person</th>
                    <th style={{ padding: '10px 12px', fontWeight: 700 }}>Now</th>
                    <th style={{ padding: '10px 12px', fontWeight: 700 }}>Phone time</th>
                    <th style={{ padding: '10px 12px', fontWeight: 700 }}>Pickups</th>
                    <th style={{ padding: '10px 12px', fontWeight: 700, minWidth: 150 }}>Time breakdown</th>
                    <th style={{ padding: '10px 18px', fontWeight: 700 }}>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p, i) => {
                    const named = !!p.name
                    return (
                      <tr key={p.key} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '11px 18px', color: 'var(--color-text-muted)', fontWeight: 700 }}>{i + 1}</td>
                        <td style={{ padding: '11px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            <div style={{ width: 30, height: 30, borderRadius: 99, background: 'var(--color-primary-bg)', border: '1px solid var(--color-border-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 17, color: 'var(--color-info-text)' }}>{named ? 'person' : 'person_outline'}</span>
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, color: 'var(--color-on-bg)' }}>{p.name || 'Unidentified'}</div>
                              {!named && <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>track {p.key?.split('#').pop()}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '11px 12px' }}><StateBadge state={p.current_state} /></td>
                        <td style={{ padding: '11px 12px', fontWeight: 700, color: (p.on_phone_seconds > 0 ? '#b45309' : 'var(--color-text-secondary)') }}>{fmtDur(p.on_phone_seconds)}</td>
                        <td style={{ padding: '11px 12px', fontWeight: 700, color: 'var(--color-on-bg)' }}>{p.phone_sessions}</td>
                        <td style={{ padding: '11px 12px' }}><TimeBar stateSeconds={p.state_seconds} /></td>
                        <td style={{ padding: '11px 18px', color: 'var(--color-text-muted)' }}>{fmtClock(p.last_seen)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Daily history */}
        <HistoryPanel history={historyQ.data} />

        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14, fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          {STATE_ORDER.map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: STATE[k].bar, display: 'inline-block' }} />
              {STATE[k].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
