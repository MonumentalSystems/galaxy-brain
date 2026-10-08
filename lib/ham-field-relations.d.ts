import type { SemanticEntity, SemanticRelation } from "./semantic-field"
import type { HamRelationOverlayResponse } from "./ham-relation-overlay-contract.js"

export interface HamFieldResult {
  id: string | number
  content?: string
  timestamp?: string
  metadata?: { title?: string }
}

export function projectHamFieldNeighborhood(
  anchorId: string,
  results: unknown,
): { entities: SemanticEntity[]; relations: SemanticRelation[] }

export interface AuthoritativeHamMemoryView {
  memory: {
    id: string
    title?: string
    content: string
    version: number
    timestamp?: string
    updatedAt?: string
  }
  edges: Array<{
    id: string
    relation: "cites" | "verifies" | "contradicts" | "depends-on" | "supersedes" | "superseded_by"
    sourceId: string
    targetId: string
    adjacentId: string
    state: "active"
    version: number
    adjacent?: {
      id: string
      title?: string
      snippet: string
      version: number
    } | null
  }>
}

export function projectAuthoritativeHamMemoryView(view: AuthoritativeHamMemoryView | unknown): {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
}

export function projectAuthoritativeHamRelationOverlay(
  value: HamRelationOverlayResponse | unknown,
): {
  nodes: []
  edges: Array<{
    fromRef: string
    toRef: string
    relation: "cites" | "verifies" | "contradicts" | "depends_on" | "supersedes" | "superseded_by"
    basis: "authored_assertion"
    source: { provider: "ham"; recordId: string; revision: string }
  }>
}
