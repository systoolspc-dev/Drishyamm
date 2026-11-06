import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { aiService } from '@/core/services/ai'

// Per-camera control for phone-usage / activity monitoring. Users pick which
// cameras run the pose+phone pipeline (exactly like the person-tracker picker);
// the backend flips settings.ai.activityMonitoring and the activity-monitor
// reconciles its workers at runtime. Cameras are pulled from MediaMTX, so
// enabling one that already runs AI adds no new NVR load.
export default function MonitoredCameras() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  const acq = useQuery({
    queryKey: ['activity-cameras'],
    queryFn: () => aiService.getActivityCameras(),
    refetchInterval: 5000,
  })
  const camsQ = useQuery({
    queryKey: ['ai-cameras-all'],
    queryFn: () => aiService.listCameraAiSettings(),
    staleTime: 60000,
  })

  const enabled = acq.data?.enabled || []
  const liveById = useMemo(() => {
    const m = {}
    for (const l of acq.data?.live || []) m[l.id] = l
    return m
  }, [acq.data])
  const allCams = useMemo(() => {
    const list = camsQ.data?.data || camsQ.data?.cameras || (Array.isArray(camsQ.data) ? camsQ.data : [])
    return list.filter((c) => c?.id)
  }, [camsQ.data])

  const enabledIds = new Set(enabled.map((e) => e.id))
  const available = allCams.filter((c) => !enabledIds.has(c.id))

  async function toggle(cameraId, on) {
    setBusyId(cameraId)
    try {
      await aiService.setActivityCameras([cameraId], on)
      await qc.invalidateQueries({ queryKey: ['activity-cameras'] })
      qc.invalidateQueries({ queryKey: ['activity-streams'] })
      qc.invalidateQueries({ queryKey: ['activity-people'] })
    } catch {
      /* surfaced by the query error states */
    } finally {
      setBusyId(null)
      setOpen(false)
    }
  }

  const isAiOn = (c) => c?.ai?.enabled === true || c?.ai?.lifecycle === 'active'

  return (
    <div className="ai-hub-summary-card" style={{ borderRadius: 14, padding: '14px 18px', marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="material-symbols-outlined" style={{ fontSize: 19, color: 'var(--color-info-text)' }}>videocam</span>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--color-on-bg)' }}>Cameras monitored for activity</span>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
          phone-usage &amp; seated/working runs on the cameras you pick
        </span>

        {/* Add-camera dropdown */}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={!available.length}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px',
              borderRadius: 8, border: '1px solid var(--color-border-accent)', background: 'var(--color-primary-bg)',
              color: 'var(--color-info-text)', fontSize: 12, fontWeight: 700, cursor: available.length ? 'pointer' : 'not-allowed',
              opacity: available.length ? 1 : 0.5,
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>add</span>
            Add camera
          </button>
          {open && available.length > 0 && (
            <div
              style={{
                position: 'absolute', top: 38, right: 0, zIndex: 20, width: 280, maxHeight: 320, overflowY: 'auto',
                background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12,
                boxShadow: '0 12px 32px rgba(0,0,0,.18)', padding: 6,
              }}
            >
              {available.map((c) => (
                <button
                  key={c.id}
                  onClick={() => toggle(c.id, true)}
                  disabled={busyId === c.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                    padding: '9px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer',
                    color: 'var(--color-on-bg)', fontSize: 12.5,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-primary-bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 17, color: 'var(--color-text-muted)' }}>videocam</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{c.name || c.monitorId}</span>
                  {isAiOn(c)
                    ? <span title="AI already running — no extra NVR load" className="material-symbols-outlined" style={{ fontSize: 15, color: 'var(--color-success-text)' }}>bolt</span>
                    : <span title="AI not running — enabling will start a stream pull" className="material-symbols-outlined" style={{ fontSize: 15, color: 'var(--status-neutral-text)' }}>info</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Enabled camera chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: enabled.length ? 12 : 8 }}>
        {enabled.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
            No cameras selected yet — click <b>Add camera</b> to start monitoring phone usage &amp; activity.
          </span>
        ) : (
          enabled.map((c) => {
            const live = liveById[c.monitorId] || {}
            const online = !!live.online
            return (
              <span
                key={c.id}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 11px', borderRadius: 999,
                  border: `1px solid ${online ? 'var(--color-success-border)' : 'var(--color-border)'}`,
                  background: online ? 'var(--color-success-bg)' : 'var(--color-surface)',
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 99, background: online ? 'var(--color-success)' : 'var(--status-neutral-text)', display: 'inline-block' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-bg)' }}>{c.name || c.monitorId}</span>
                <span style={{ fontSize: 10.5, color: 'var(--color-text-muted)', fontWeight: 600 }}>
                  {online ? 'live' : (acq.isLoading ? '…' : 'starting')}
                </span>
                <button
                  onClick={() => toggle(c.id, false)}
                  disabled={busyId === c.id}
                  title="Stop monitoring this camera"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20,
                    borderRadius: 99, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-muted)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-danger-text, #dc2626)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-muted)')}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
                </button>
              </span>
            )
          })
        )}
      </div>
    </div>
  )
}
