import { useState, useEffect, useRef, useCallback } from 'react'
import { eventsApi } from '../services/apiClient.js'

export function useAlertStream({ eventType, severity, limit = 50, pollInterval = 5000 } = {}) {
  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const timerRef              = useRef(null)

  const fetchData = useCallback(async () => {
    try {
      const result = await eventsApi.list({
        event_type: eventType,
        severity,
        status: 'active',
        limit,
      })
      setData(result)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [eventType, severity, limit])

  useEffect(() => {
    fetchData()
    timerRef.current = setInterval(fetchData, pollInterval)
    return () => clearInterval(timerRef.current)
  }, [fetchData, pollInterval])

  return { data, loading, error, refetch: fetchData }
}
