import { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { shinobiService } from '@/core/services/shinobi';

/**
 * Shinobi Embed Player Component
 * Uses Shinobi's native embed player which handles streaming automatically
 * Works with cameras in both "record" and "start" modes
 */
export default function ShinobiEmbedPlayer({ monitorId, className = '' }) {
  const iframeRef = useRef(null);
  const [state, setState] = useState('loading'); // loading | playing | error
  const [embedUrl, setEmbedUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!monitorId) return;

    let mounted = true;

    const initStream = async () => {
      try {
        setState('loading');
        setError(null);

        // Get Shinobi embed player URL
        const url = await shinobiService.getEmbedUrl(monitorId);
        console.log('🎬 Loading Shinobi embed player:', url);

        if (!mounted) return;

        setEmbedUrl(url);

        // Give iframe a moment to load
        setTimeout(() => {
          if (mounted) {
            setState('playing');
          }
        }, 1500);

      } catch (err) {
        console.error('Embed player init error:', err);
        if (mounted) {
          setState('error');
          setError(err.message || 'Failed to load stream');
        }
      }
    };

    initStream();

    return () => {
      mounted = false;
    };
  }, [monitorId]);

  return (
    <div className={`relative bg-neutral-950 flex items-center justify-center ${className}`}>
      {/* Embed iframe */}
      {embedUrl && (
        <iframe
          ref={iframeRef}
          src={embedUrl}
          className={`w-full h-full border-0 ${state === 'playing' ? 'opacity-100' : 'opacity-0'}`}
          allow="autoplay; fullscreen"
          title="Camera Live Stream"
        />
      )}

      {/* Loading state */}
      {state === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-10 h-10 text-brand animate-spin" />
          <span className="text-small text-white/50 tracking-wide font-medium">Connecting to camera…</span>
        </div>
      )}

      {/* Error state */}
      {state === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950/80 p-6">
          <AlertCircle className="w-10 h-10 text-danger" />
          <div className="text-center">
            <p className="text-body font-semibold text-white mb-1">Stream Unavailable</p>
            <p className="text-small text-white/60">{error || 'Could not connect to camera'}</p>
          </div>
        </div>
      )}
    </div>
  );
}
