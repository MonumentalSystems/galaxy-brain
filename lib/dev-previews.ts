import "server-only"

/**
 * Design previews live under /dev. They are development-only by default, which
 * also makes them unreachable on a deployed instance.
 *
 * Setting GALAXY_DEV_PREVIEWS=true opts a deployment in, so the previews can be
 * reviewed against real hosting without lifting the gate for everyone. The flag
 * is server-side and defaults closed: an unset or malformed value keeps the
 * previews hidden outside development.
 */
export function devPreviewsEnabled() {
  if (process.env.NODE_ENV === "development") return true
  return process.env.GALAXY_DEV_PREVIEWS === "true"
}
