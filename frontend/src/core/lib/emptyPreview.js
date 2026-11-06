/**
 * TEMP-PREVIEW: dev-only `?preview=empty` forces each Camera Setup tab's
 * empty state, and the no-cameras screen on every page gated by
 * RequireCameras (via useCameraPresence), so the design can be reviewed
 * without a backend. Remove this file and its call sites after design review.
 */
export function isEmptyPreview() {
  return import.meta.env.DEV
    && new URLSearchParams(window.location.search).get('preview') === 'empty';
}
