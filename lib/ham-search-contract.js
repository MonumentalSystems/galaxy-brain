const SEARCH_MODES = new Set(["search", "multihop", "temporal"])
const GALAXY_NODE_TYPES = new Set([
  "note",
  "document",
  "image",
  "video",
  "audio",
  "3d",
  "code",
  "flow",
  "canvas",
  "link",
  "folder",
])
const TEMPORAL_MODES = new Set([
  "valid_at",
  "known_at",
  "event_before",
  "event_after",
  "event_near",
])
const HAM_SEARCH_RESULT_MAX = 50

export class HamSearchUpstreamResponseError extends Error {}

function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search request must be a JSON object.")
  }
  return value
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`)
  const cleaned = value.trim()
  if (!cleaned) throw new Error(`${label} is required.`)
  if (cleaned.length > maxLength) throw new Error(`${label} is too long.`)
  return cleaned
}

function boundedInteger(value, label, fallback, minimum, maximum) {
  const candidate = value == null ? fallback : value
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`)
  }
  return candidate
}

function optionalTimestamp(value, label) {
  if (value == null || value === "") return null
  const cleaned = boundedText(value, label, 100)
  const timestamp = Date.parse(cleaned)
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid date and time.`)
  return new Date(timestamp).toISOString()
}

export function parseHamSearchRequest(input) {
  const source = objectValue(input)
  const query = boundedText(source.query, "Query", 20_000)
  const mode = source.mode == null ? "search" : boundedText(source.mode, "Search mode", 40)
  if (!SEARCH_MODES.has(mode)) throw new Error("Search mode is invalid.")
  const topK = boundedInteger(source.topK, "Result count", 10, 1, 50)

  const common = {
    query,
    top_k: topK,
    include_context: false,
  }

  if (mode === "search") {
    return { mode, path: "/search", body: common }
  }

  if (mode === "multihop") {
    return {
      mode,
      path: "/retrieve/multihop/scoped",
      body: {
        ...common,
        max_hops: boundedInteger(source.maxHops, "Hop count", 2, 0, 2),
      },
    }
  }

  const asOf = optionalTimestamp(source.asOf, "Temporal anchor")
  if (!asOf) throw new Error("Temporal anchor is required for temporal search.")
  const temporalMode = source.temporalMode == null
    ? "valid_at"
    : boundedText(source.temporalMode, "Temporal mode", 40)
  if (!TEMPORAL_MODES.has(temporalMode)) throw new Error("Temporal mode is invalid.")
  return {
    mode,
    path: "/retrieve/temporal/scoped",
    body: {
      ...common,
      as_of: asOf,
      mode: temporalMode,
      include_history: source.includeHistory !== false,
    },
  }
}

function optionalString(value, maxLength = 2_000) {
  return typeof value === "string" && value.length <= maxLength ? value : undefined
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeGalaxyNodeType(value) {
  const candidate = optionalString(value, 100)?.trim().toLowerCase()
  return candidate && GALAXY_NODE_TYPES.has(candidate) ? candidate : "note"
}

function projectTemporal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const source = value
  const projected = {}
  for (const key of [
    "mode",
    "as_of",
    "event_at",
    "observed_at",
    "valid_from",
    "valid_to",
    "recorded_at",
    "recorded_to",
  ]) {
    const item = optionalString(source[key], 100)
    if (item !== undefined) projected[key] = item
  }
  return Object.keys(projected).length > 0 ? projected : undefined
}

export function projectHamSearchResultsForBrowser(input) {
  const source = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray(input.items)
      ? input.items
      : null
  if (!source) throw new HamSearchUpstreamResponseError("HAM returned an invalid search response.")

  // The browser projection is bounded independently of the requested top_k.
  // A malformed or drifting upstream must not send an arbitrarily large array
  // through the BFF and into a synchronous client render.
  return source.slice(0, HAM_SEARCH_RESULT_MAX).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return []
    const content = optionalString(raw.content, 200_000)
    const id = typeof raw.id === "number" || typeof raw.id === "string" ? String(raw.id) : null
    if (!id || content === undefined) return []
    const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? raw.metadata
      : {}
    const title = optionalString(metadata.title, 1_000)
    const type = normalizeGalaxyNodeType(metadata.type)
    const ranking = raw.ranking && typeof raw.ranking === "object" && !Array.isArray(raw.ranking)
      ? raw.ranking
      : {}
    return [{
      id,
      content,
      tier: optionalNumber(raw.tier) ?? 0,
      score: optionalNumber(raw.score),
      hop: optionalNumber(raw.hop),
      via_cue: optionalString(raw.via_cue, 500),
      timestamp: optionalString(raw.timestamp, 100),
      state: optionalString(raw.state, 40),
      version: optionalNumber(raw.version),
      metadata: {
        ...(title === undefined ? {} : { title }),
        type,
      },
      temporal: projectTemporal(ranking.temporal),
    }]
  })
}

export const HAM_SEARCH_MODES = Object.freeze([...SEARCH_MODES])
export const HAM_TEMPORAL_MODES = Object.freeze([...TEMPORAL_MODES])
