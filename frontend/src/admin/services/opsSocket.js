/**
 * opsSocket — the admin console's own socket.io connection to the operators'
 * live-activity room ('platform-ops').
 *
 * Separate from the customer app's singleton (core/services/socket.js): the
 * admin console signs in with its own token (`admin_token`), and both apps can
 * be open in one browser. `forceNew` keeps the two from sharing a manager.
 *
 * The token is read on every (re)connect attempt, so a fresh sign-in is picked
 * up without rebuilding the socket. Reconnection uses socket.io's exponential
 * backoff (1 s → 15 s, jittered). A refusal by the server's auth middleware
 * (expired token) does not auto-retry in socket.io, so that case is retried
 * here on the same backoff.
 */
import { io } from 'socket.io-client'
import { API_BASE } from '@/core/config/endpoints'

const readToken = () => {
  try { return localStorage.getItem('admin_token') } catch { return null }
}

/**
 * @param {object} h  { onStatus(status), onEvent(ev), onCounters(c), onJoined() }
 *   status: 'connecting' | 'live' | 'reconnecting' | 'denied'
 * @returns {() => void} close
 */
export function openOpsSocket(h) {
  let closed = false
  let retry = null
  let attempt = 0
  const socket = io(API_BASE, {
    path: '/socket.io',
    transports: ['websocket'],
    forceNew: true,
    auth: (cb) => cb({ token: readToken() }),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.5,
  })

  const retryLater = () => {
    if (closed || retry) return
    attempt += 1
    const ms = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)) * (0.75 + Math.random() * 0.5)
    retry = setTimeout(() => { retry = null; if (!closed && !socket.connected) socket.connect() }, ms)
  }

  socket.on('connect', () => {
    attempt = 0
    socket.emit('ops.join', {}, (ack) => {
      if (closed) return
      if (ack && ack.ok) { h.onStatus('live'); h.onJoined && h.onJoined() } else h.onStatus('denied')
    })
  })
  socket.on('disconnect', () => { if (!closed) h.onStatus('reconnecting') })
  socket.on('connect_error', () => {
    if (closed) return
    h.onStatus('reconnecting')
    // Middleware refusals leave socket.active false: socket.io will not retry.
    if (!socket.active) retryLater()
  })
  socket.on('ops.denied', () => h.onStatus('denied'))
  socket.on('platform.event', (ev) => h.onEvent && h.onEvent(ev))
  socket.on('platform.counters', (c) => h.onCounters && h.onCounters(c))

  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    socket.removeAllListeners()
    socket.close()
  }
}
