export type HamSearchMode = "search" | "multihop" | "temporal"
export type HamTemporalMode = "valid_at" | "known_at" | "event_before" | "event_after" | "event_near"
export type HamSearchNodeType = "note" | "document" | "image" | "video" | "audio" | "3d" | "code" | "flow" | "canvas" | "link" | "folder"

export interface HamSearchResult {
  id: string
  content: string
  tier: number
  score?: number
  hop?: number
  via_cue?: string
  timestamp?: string
  state?: string
  version?: number
  metadata?: { title?: string; type?: HamSearchNodeType }
  temporal?: Partial<Record<
    "mode" | "as_of" | "event_at" | "observed_at" | "valid_from" | "valid_to" | "recorded_at" | "recorded_to",
    string
  >>
}

export async function searchHam(input: {
  query: string
  mode?: HamSearchMode
  topK?: number
  maxHops?: number
  asOf?: string
  temporalMode?: HamTemporalMode
  includeHistory?: boolean
}, options: { signal?: AbortSignal } = {}): Promise<HamSearchResult[]> {
  const response = await fetch("/api/ham/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `HAM search failed (${response.status})`
    throw new Error(message)
  }
  if (!Array.isArray(body)) throw new Error("HAM returned an invalid search response")
  return body as HamSearchResult[]
}
