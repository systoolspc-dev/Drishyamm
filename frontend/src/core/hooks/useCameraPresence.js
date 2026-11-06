import { useCameras } from '@/core/hooks/useQueries';
import { isEmptyPreview } from '@/core/lib/emptyPreview'; // TEMP-PREVIEW

/**
 * Does this ACCOUNT have any cameras? The one answer every page shares.
 *
 * Pages used to decide this from whatever list they already had — groups,
 * health rows, usage rows — so a fresh account could get onboarding on one
 * page and a bare empty grid on the next. This reads the same camera list
 * Camera Setup counts, and TanStack Query dedupes it across pages.
 *
 *   'loading' — first request still in flight
 *   'error'   — request failed and there is nothing cached to fall back on
 *   'empty'   — request succeeded with zero cameras
 *   'ready'   — at least one camera
 *
 * Cached data wins over a failed refetch: a blip must not flip a working page
 * to "no cameras".
 *
 * Pass `enabled: false` for pages that bring their own data (AI Feed's sample
 * mode); the hook then reports 'ready' and makes no request.
 */
export function useCameraPresence({ enabled = true } = {}) {
  const preview = enabled && isEmptyPreview();
  const query = useCameras({ enabled: enabled && !preview });

  if (!enabled) return { status: 'ready', count: 0 };
  if (preview) return { status: 'empty', count: 0 };

  const { data, isError, error, refetch } = query;
  if (Array.isArray(data)) {
    return { status: data.length ? 'ready' : 'empty', count: data.length };
  }
  if (isError) return { status: 'error', count: 0, error, retry: refetch };
  return { status: 'loading', count: 0 };
}
