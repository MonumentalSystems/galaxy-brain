import type { ResearchRecordDocument } from "./research-record"
import type { DurableDocumentAnchor } from "./paper-reader-client"
import type { GalaxyPaper, GalaxyPaperDetail, GalaxyPaperRevision } from "./types/papers"
import type { GalaxySurfaceRecord } from "./types/surfaces"
import type { TaskSummary } from "./types/tasks"
import type { GalaxyObjectProjection } from "./object-projection"
import type {
  GalaxyGraphQuery,
  GalaxyGraphScope,
  ScopedGalaxyObjectLink,
  UnifiedGraphInput,
} from "./unified-graph"

export type AuthorizedGraphEnvelope<T> = {
  authorized: boolean
  scope: GalaxyGraphScope
} & T

export type ActiveObjectLinkRow = Omit<ScopedGalaxyObjectLink["link"], "provenance"> & {
  provenance: ScopedGalaxyObjectLink["link"]["provenance"] & {
    source_ref?: string
    extractor_version?: string
    confidence?: number
  }
  created_by_principal_id?: string
  created_at?: string
  version?: number
}

export interface AuthorizedGraphSourceInput {
  schemaId: "gb.authorized-graph-source.v1"
  scope: GalaxyGraphScope
  query: GalaxyGraphQuery
  providers: Array<{
    scope: GalaxyGraphScope
    provider: string
    status: "ready" | "partial" | "unavailable"
    snapshot?: string
    revision?: string
  }>
  /** Exact gateway-authorized projections for this scope, including moving HAM-memory heads. */
  projections?: Array<AuthorizedGraphEnvelope<{ projection: GalaxyObjectProjection }>>
  papers?: Array<AuthorizedGraphEnvelope<{
    paper: GalaxyPaper | GalaxyPaperDetail
    revision?: GalaxyPaperRevision | null
  }>>
  anchors?: Array<AuthorizedGraphEnvelope<{ anchor: DurableDocumentAnchor }>>
  /** A caller first converts its authorized Experiment through experimentToResearchRecord. */
  experiments?: Array<AuthorizedGraphEnvelope<{ record: ResearchRecordDocument }>>
  tasks?: Array<AuthorizedGraphEnvelope<{ task: TaskSummary }>>
  surfaces?: Array<AuthorizedGraphEnvelope<{ surface: GalaxySurfaceRecord }>>
  links?: Array<AuthorizedGraphEnvelope<{ active: boolean; link: ActiveObjectLinkRow }>>
}

export interface AuthorizedGraphSourceResult {
  schemaId: "gb.authorized-graph-source-result.v1"
  graphInput: UnifiedGraphInput
  diagnostics: {
    omitted: {
      unauthorized: { projections: number; papers: number; anchors: number; experiments: number; tasks: number; surfaces: number; links: number }
      inactiveLinks: number
      missingEndpointLinks: number
      taskResourceRelations: number
    }
    missingEndpointLinks: Array<{ linkId: string; missingRefs: string[] }>
    partialProviders: Array<{ provider: string; status: "partial" | "unavailable" }>
  }
}

export const AUTHORIZED_GRAPH_SOURCE_SCHEMA_ID: "gb.authorized-graph-source.v1"
export const AUTHORIZED_GRAPH_SOURCE_RESULT_SCHEMA_ID: "gb.authorized-graph-source-result.v1"
export function buildAuthorizedGraphSource(input: AuthorizedGraphSourceInput | unknown): AuthorizedGraphSourceResult
