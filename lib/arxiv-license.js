const REDISTRIBUTABLE_LICENSE_PATHS = [
  /^\/licenses\/(?:by|by-sa)\/[0-9]+(?:\.[0-9]+)+\/?$/,
  /^\/publicdomain\/zero\/[0-9]+(?:\.[0-9]+)+\/?$/,
]

/**
 * Galaxy Brain may transiently serve an arXiv PDF only when the imported
 * metadata names a Creative Commons license that permits commercial sharing.
 * @param {string | null | undefined} licenseUrl
 */
export function arxivPdfProxyAllowed(licenseUrl) {
  if (typeof licenseUrl !== "string" || !licenseUrl) return false
  try {
    const parsed = new URL(licenseUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (parsed.protocol !== "https:") return false
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false
    if (hostname !== "creativecommons.org" && !hostname.endsWith(".creativecommons.org")) return false
    return REDISTRIBUTABLE_LICENSE_PATHS.some((pattern) => pattern.test(parsed.pathname.toLowerCase()))
  } catch {
    return false
  }
}
