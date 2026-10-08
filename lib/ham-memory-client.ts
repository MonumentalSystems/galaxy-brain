export type HamMemoryRelation = "cites" | "verifies" | "contradicts" | "depends-on"
export type HamMemoryEffectiveRelation =
  | HamMemoryRelation
  | "cited-by"
  | "verified-by"
  | "contradicted-by"
  | "required-by"
  | "supersedes"
  | "superseded_by"

export interface HamMemorySummary {
  id: string
  title?: string
  type?: string
  state: string
  version: number
  snippet: string
}

export interface HamMemoryEdge {
  kind: "typed" | "lifecycle"
  id: string
  relation: HamMemoryRelation | "supersedes" | "superseded_by"
  effectiveRelation: HamMemoryEffectiveRelation
  direction: "outgoing" | "incoming"
  sourceId: string
  targetId: string
  adjacentId: string
  state: string
  version: number
  createdAt?: string
  adjacent: HamMemorySummary | null
}

export interface HamMemoryDetail {
  id: string
  content: string
  title?: string
  type?: string
  tier: number
  state: string
  version: number
  status?: string
  durability?: string
  visibility?: string
  agentId?: string
  timestamp?: string
  createdAt?: string
  updatedAt?: string
  organization: {
    project?: string
    repo?: string
    task?: string
    sequence?: string
    scopes: string[]
  }
  cues: Array<{ cue: string; source?: string }>
}

export interface HamMemoryView {
  memory: HamMemoryDetail
  edges: HamMemoryEdge[]
  truncated: boolean
}

export type HamMemoryMutationResult =
  | {
      status: "committed"
      action: "supersede" | "link" | "unlink"
      memoryId: string
      view: HamMemoryView
    }
  | {
      status: "committed-refresh-failed"
      action: "supersede" | "link" | "unlink"
      memoryId: string
      view: null
    }

export interface SupersedeHamMemoryInput {
  expectedVersion: number
  idempotencyKey: string
  content?: string
  title?: string | null
  type?: string | null
  project?: string | null
  repo?: string | null
  task?: string | null
  sequence?: string | null
  scopes?: string[]
  cues?: string[]
  reason?: string | null
}

function errorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fallback
  const error = (body as { error?: unknown }).error
  return typeof error === "string" ? error : fallback
}

async function requestHamMemory(memoryId: string, init?: RequestInit): Promise<HamMemoryView> {
  const response = await fetch(`/api/ham/memories/${encodeURIComponent(memoryId)}`, {
    cache: "no-store",
    ...init,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(errorMessage(body, `HAM memory request failed (${response.status})`))
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("HAM returned an invalid memory response")
  }
  return body as HamMemoryView
}

async function mutateHamMemory(memoryId: string, init: RequestInit): Promise<HamMemoryMutationResult> {
  const response = await fetch(`/api/ham/memories/${encodeURIComponent(memoryId)}`, {
    cache: "no-store",
    ...init,
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(errorMessage(body, `HAM memory request failed (${response.status})`))
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("HAM returned an invalid mutation acknowledgement")
  }
  const result = body as Partial<HamMemoryMutationResult>
  if (
    (result.status !== "committed" && result.status !== "committed-refresh-failed")
    || typeof result.memoryId !== "string"
    || (result.status === "committed" && !result.view)
    || (result.status === "committed-refresh-failed" && result.view !== null)
  ) {
    throw new Error("HAM returned an invalid mutation acknowledgement")
  }
  return result as HamMemoryMutationResult
}

function mutationRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

export function getHamMemory(memoryId: string) {
  return requestHamMemory(memoryId)
}

export function supersedeHamMemory(memoryId: string, input: SupersedeHamMemoryInput) {
  return mutateHamMemory(memoryId, mutationRequest({ action: "supersede", ...input }))
}

export function linkHamMemories(
  sourceMemoryId: string,
  input: { targetMemoryId: string; relation: HamMemoryRelation },
) {
  return mutateHamMemory(sourceMemoryId, mutationRequest({ action: "link", ...input }))
}

export function unlinkHamMemories(
  sourceMemoryId: string,
  input: { linkId: string; expectedVersion: number; reason?: string | null },
) {
  return mutateHamMemory(sourceMemoryId, mutationRequest({ action: "unlink", ...input }))
}
