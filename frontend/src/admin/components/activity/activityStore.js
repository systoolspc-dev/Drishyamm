import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * Live platform activity shared by the whole admin console (one socket).
 * Provided by ActivityProvider; read with useActivity().
 *
 *   status     'connecting' | 'live' | 'reconnecting' | 'denied'
 *   events     newest first (live + backfill), capped
 *   counters   last platform.counters payload, or null
 *   unread     bell count (everything except sign-ins, newer than last opened)
 *   markSeen() bell opened
 *   subscribe(fn) every new event, live or backfilled → unsubscribe
 *   tick       changes every 30 s so relative times re-render
 */
export const ActivityContext = createContext({
  status: 'connecting', events: [], counters: null, unread: 0, tick: 0,
  markSeen: () => {}, subscribe: () => () => {},
})

export function useActivity() {
  return useContext(ActivityContext)
}

/** Call fn for every new platform event while the component is mounted. */
export function useActivityEvents(fn) {
  const { subscribe } = useActivity()
  const ref = useRef(fn)
  useEffect(() => { ref.current = fn })
  useEffect(() => subscribe((ev, meta) => ref.current(ev, meta)), [subscribe])
}
