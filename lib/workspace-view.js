/**
 * Resolve the opening projection without letting an invalid URL or stale
 * preference escape the feature-gated set of views.
 *
 * @param {{
 *   requestedView?: string | null,
 *   preferredView?: string | null,
 *   allowedViewModes: readonly string[],
 *   fallbackView: string,
 * }} options
 */
export function resolveWorkspaceView({
  requestedView,
  preferredView,
  allowedViewModes,
  fallbackView,
}) {
  if (requestedView && allowedViewModes.includes(requestedView)) return requestedView
  if (preferredView && allowedViewModes.includes(preferredView)) return preferredView
  return fallbackView
}
