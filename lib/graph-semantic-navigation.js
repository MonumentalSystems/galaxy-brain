import { parseGalaxyObjectReference, serializeGalaxyObjectReference } from "./galaxy-object-reference.js"

const GRAPH_SCALES = new Set(["corpus", "project", "task", "run", "object", "atomic"])
const SHA256 = /^[0-9a-f]{64}$/u
const FALLBACK_ORIGIN = "https://galaxy.invalid"
const INCOMPATIBLE_SELECTION_PARAMETERS = Object.freeze([
  "ref",
  "proofGraph",
  "proofWorkspace",
  "proofRegistry",
  "conversation",
  "codeSnapshot",
  "corpusWindow",
])

function invalid(message) {
  throw new TypeError(`Invalid graph semantic navigation: ${message}`)
}

function routeUrl(value) {
  if (typeof value !== "string" || !value) invalid("currentUrl must be a non-empty URL")
  try {
    return new URL(value, FALLBACK_ORIGIN)
  } catch (cause) {
    throw new TypeError("Invalid graph semantic navigation: currentUrl is invalid", { cause })
  }
}

function routeHref(url) {
  return `${url.pathname}${url.search}${url.hash}`
}

export function isExactPinnedProofGraphReference(reference) {
  const parsed = typeof reference === "string" ? parseGalaxyObjectReference(reference) : null
  return Boolean(
    parsed
      && parsed.format === "canonical"
      && parsed.kind === "proof.graph"
      && parsed.selector.mode === "pinned"
      && parsed.selector.revision.startsWith("sha256:")
      && SHA256.test(parsed.selector.revision.slice("sha256:".length))
      && serializeGalaxyObjectReference(parsed) === reference,
  )
}

/**
 * Plan the only transport-changing semantic-scale transition in this slice.
 * All nearer scales remain local to the already-authorized exact projection.
 */
export function planProofCorpusScaleNavigation(currentUrl, requestedScale, proofGraphReference) {
  if (!GRAPH_SCALES.has(requestedScale)) invalid("requestedScale is unsupported")
  if (requestedScale !== "corpus" || !isExactPinnedProofGraphReference(proofGraphReference)) {
    return Object.freeze({ kind: "local", scale: requestedScale })
  }

  const url = routeUrl(currentUrl)
  for (const key of INCOMPATIBLE_SELECTION_PARAMETERS) url.searchParams.delete(key)
  url.searchParams.set("mode", "mixed")
  url.searchParams.set("lens", "explore")
  url.searchParams.set("scale", "corpus")
  url.searchParams.set("focus", proofGraphReference)
  url.searchParams.set("corpusWindow", "1")
  return Object.freeze({ kind: "route", href: routeHref(url), focusRef: proofGraphReference })
}

/** Return from a bounded corpus window to the exact proof graph that opened it. */
export function proofGraphReturnHref(currentUrl, focusReference) {
  if (!isExactPinnedProofGraphReference(focusReference)) return null
  const url = routeUrl(currentUrl)
  for (const key of INCOMPATIBLE_SELECTION_PARAMETERS) url.searchParams.delete(key)
  url.searchParams.delete("focus")
  url.searchParams.set("mode", "proof")
  url.searchParams.set("lens", "explore")
  url.searchParams.set("scale", "project")
  url.searchParams.set("ref", focusReference)
  return routeHref(url)
}
