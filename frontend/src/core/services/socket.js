/**
 * socket.js — single socket.io client shared across the app.
 *
 * Usage:
 *   import { connectSocket, on, off } from '@/core/services/socket';
 *
 *   useEffect(() => {
 *     connectSocket();                       // safe to call repeatedly
 *     const unsub = on('ai.event', handler);
 *     return unsub;
 *   }, []);
 *
 * Reconnection is handled by socket.io itself with exponential backoff;
 * we just expose the singleton + a helper that returns an unsubscribe fn.
 */

import { io } from 'socket.io-client';
import { API_BASE as URL } from '@/core/config/endpoints';

let _socket = null;

function getToken() {
  // authService stores the JWT directly as `auth_token` in localStorage.
  return localStorage.getItem('auth_token');
}

/**
 * Connect (or reuse) the singleton socket. Call after login.
 * Safe to call multiple times — only one socket is ever created.
 */
export function connectSocket() {
  if (_socket && _socket.connected) return _socket;

  const token = getToken();
  if (!token) return null;

  if (!_socket) {
    _socket = io(URL, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket'],   // skip long-poll fallback in dev
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });

    _socket.on('connect_error', (err) => {
      // Token may have expired — surface to console; the global axios interceptor
      // will refresh on the next REST call and the socket will reconnect.
      console.warn('[socket] connect_error', err.message);
    });
  } else {
    // Token may have rotated since last connect — update auth and reconnect
    _socket.auth = { token };
    _socket.connect();
  }

  return _socket;
}

/** Disconnect on logout. */
export function disconnectSocket() {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}

/**
 * Subscribe to a server-pushed event. Returns an unsubscribe function so
 * components can wire it directly into useEffect cleanup.
 */
export function on(eventName, handler) {
  const s = connectSocket();
  if (!s) return () => {};
  s.on(eventName, handler);
  return () => s.off(eventName, handler);
}

/** Manual off — usually you want the unsubscribe returned by `on(...)`. */
export function off(eventName, handler) {
  if (_socket) _socket.off(eventName, handler);
}

export function getSocket() {
  return _socket;
}
