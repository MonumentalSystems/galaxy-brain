import type { SemanticEntity, SemanticFieldProjection, SemanticRelation } from "./semantic-field"
import type { UnifiedGraphProjection } from "./unified-graph"

export interface UnifiedFieldProjection extends SemanticFieldProjection {
  entities: Array<SemanticEntity>
  relations: Array<SemanticRelation>
  incompleteProviders: Array<{
    provider: string
    status: "partial" | "unavailable"
  }>
  truncation: {
    nodeLimitReached: boolean
    edgeLimitReached: boolean
    fanoutOmissions: number
    omittedDerivedNodes: number
    omittedUnsupportedNodes: number
    limits: { maxNodes: number; maxEdges: number; maxFanout: number }
  }
}

/** Deterministic presentation-only adapter. It performs no loading or mutation. */
export function projectUnifiedGraphToSemanticField(
  projection: UnifiedGraphProjection,
  options?: {
    focusReference?: string | null
    maxNodes?: number
    maxEdges?: number
    maxFanout?: number
  },
): UnifiedFieldProjection
