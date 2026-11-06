import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from '../../services/api.js'
import { openOpsSocket } from '../../services/opsSocket.js'
import { ActivityContext } from './activityStore.js'
import { TOAST_TYPES, TOAST_TITLE, eventLink, iconFor, inBell, severityTone, whoLine } from './format.js'

/**
 * One operator socket for the whole console. Keeps the latest events, the
 * bell's unread count and the live KPI counters, raises a toast for the few
 * events worth interrupting for, and backfills whatever was missed while the
 * socket was down (GET /admin/activity?afterId=<last id seen>).
 */

const KEEP = 120          // events kept in memory (pages fetch their own history)
const INITIAL = 40        // first load
const SEEN_KEY = 'admin_activity_seen'
const TOAST_MS = 8000

const keyOf = (e) => e.id || `${e.type}|${e.createdAt}|${e.summary}`
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0 } catch { return 0 } }

export default function ActivityProvider({ children }) {
  const navigate = useNavigate()
  const [status, setStatus] = useState('connecting')
  const [events, setEvents] = useState([])
  const [counters, setCounters] = useState(null)
  const [seenId, setSeenId] = useState(readSeen)
  const [toasts, setToasts] = useState([])
  const [tick, setTick] = useState(0)

  const listeners = useRef(new Set())
  const known = useRef(new Set())
  const lastId = useRef(0)
  const loaded = useRef(false)

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn)
    return () => listeners.current.delete(fn)
  }, [])

  /** Merge events (any order), newest first; returns only the ones not seen before. */
  const merge = useCallback((list) => {
    const fresh = []
    for (const e of list) {
      const k = keyOf(e)
      if (known.current.has(k)) continue
      known.current.add(k)
      fresh.push(e)
      const n = Number(e.id)
      if (n > lastId.current) lastId.current = n
    }
    if (fresh.length) {
      setEvents((prev) => [...fresh, ...prev]
        .sort((a, b) => (new Date(b.createdAt) - new Date(a.createdAt)) || (Number(b.id || 0) - Number(a.id || 0)))
        .slice(0, KEEP))
    }
    return fresh
  }, [])

  const notify = useCallback((list, meta) => {
    for (const e of list) for (const fn of listeners.current) { try { fn(e, meta) } catch { /* a page's handler must not break the feed */ } }
  }, [])

  const dismiss = useCallback((k) => setToasts((t) => t.filter((x) => x.k !== k)), [])

  useEffect(() => {
    const onEvent = (ev) => {
      const fresh = merge([ev])
      if (!fresh.length) return
      notify(fresh, { live: true })
      if (TOAST_TYPES.has(ev.type)) {
        const k = keyOf(ev)
        setToasts((t) => [...t.filter((x) => x.k !== k), { k, ev }].slice(-3))
        setTimeout(() => setToasts((t) => t.filter((x) => x.k !== k)), TOAST_MS)
      }
    }
    const onJoined = async () => {
      try {
        if (!loaded.current) {
          const d = await adminApi.listActivity({ limit: INITIAL })
          loaded.current = true
          merge(d.events || [])
          // First visit ever: start the bell at zero rather than at 40.
          if (!readSeen() && lastId.current) {
            setSeenId(lastId.current)
            try { localStorage.setItem(SEEN_KEY, String(lastId.current)) } catch { /* storage blocked */ }
          }
        } else if (lastId.current) {
          // Missed while disconnected: oldest first so subscribers see them in order.
          const d = await adminApi.listActivity({ afterId: lastId.current, limit: 200 })
          const fresh = merge(d.events || [])
          notify([...fresh].reverse(), { backfill: true })
        }
      } catch { /* the next reconnect retries */ }
    }
    const close = openOpsSocket({ onStatus: setStatus, onEvent, onCounters: setCounters, onJoined })
    const t = setInterval(() => setTick((n) => n + 1), 30000)
    return () => { close(); clearInterval(t) }
  }, [merge, notify])

  const markSeen = useCallback(() => {
    const top = lastId.current
    setSeenId(top)
    try { localStorage.setItem(SEEN_KEY, String(top)) } catch { /* storage blocked */ }
  }, [])

  const unread = useMemo(() => events.filter((e) => inBell(e) && (!e.id || Number(e.id) > seenId)).length, [events, seenId])

  const value = useMemo(() => ({ status, events, counters, unread, tick, markSeen, subscribe }),
    [status, events, counters, unread, tick, markSeen, subscribe])

  return (
    <ActivityContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="act-toasts" role="status" aria-live="polite">
          {toasts.map(({ k, ev }) => (
            <div key={k} className={`act-toast tone-${severityTone(ev.severity)}`}>
              <button className="act-toast-main" onClick={() => { dismiss(k); navigate(eventLink(ev)) }}>
                <span className="act-icon"><span className="material-symbols-outlined icon-sm">{iconFor(ev.type)}</span></span>
                <span style={{ minWidth: 0 }}>
                  <span className="act-toast-title">{TOAST_TITLE[ev.type] || 'Activity'}</span>
                  <span className="act-toast-body">{ev.type === 'account.created' ? ev.summary.replace(/^New account:\s*/, '') : ev.summary}</span>
                  {ev.type !== 'account.created' && <span className="act-toast-meta">{whoLine(ev)}</span>}
                </span>
              </button>
              <button className="act-toast-x" aria-label="Dismiss" onClick={() => dismiss(k)}>
                <span className="material-symbols-outlined icon-sm">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </ActivityContext.Provider>
  )
}
