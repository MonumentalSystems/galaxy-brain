export const GRAPH_WINDOW_REQUEST_SCHEMA_ID: "gb.graph-window-request.v1"
export const GRAPH_WINDOW_SCHEMA_ID: "gb.graph-window.v1"
export const GRAPH_WINDOW_MEMBER_LIMIT: 200

export interface GraphWindowRequest {
  schemaId: "gb.graph-window-request.v1"
  workspaceId: "tenant-catalog"
  mode: "mixed"
  lens: "explore"
  scale: "corpus"
  viewport: { x: number; y: number; width: number; height: number } | null
  filters: { kinds: readonly string[]; relations: readonly string[] }
  rootRef: string | null
  expandClusterId: string | null
  cursor: string | null
}

export interface GraphWindowCluster {
  id: string
  provider: string
  kind: string
  label: string
  count: number | null
  countStatus: "exact" | "unavailable"
  expandable: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface GraphWindowMember {
  ref: string
  clusterId: string
  provider: string
  kind: string
  title: string
  updatedAt: string
}

export interface GraphWindowProvider {
  provider: string
  status: "ready" | "partial" | "unavailable"
  count?: number
  reason?: string
}

export interface GraphWindowResponse {
  schemaId: "gb.graph-window.v1"
  consistency: "follow-latest"
  query: GraphWindowRequest
  windowHash: string
  clusters: readonly GraphWindowCluster[]
  members: readonly GraphWindowMember[]
  edges: readonly []
  focus: { ref: string } | null
  providers: readonly Readonly<GraphWindowProvider>[]
  provenance: Readonly<{
    workspaceId: "tenant-catalog"
    source: string
    memberReferences: "exact-pinned-only"
  }>
  continuation: { cursor: string | null; hasMore: boolean; model: "replace-page" }
}

export function createGraphWindowRequest(value?: {
  mode?: GraphWindowRequest["mode"]
  viewport?: GraphWindowRequest["viewport"]
  kinds?: readonly string[]
  relations?: readonly string[]
  rootRef?: string | null
  expandClusterId?: string | null
  cursor?: string | null
}): GraphWindowRequest

export function parseGraphWindowResponse(value: unknown, request: GraphWindowRequest | Parameters<typeof createGraphWindowRequest>[0]): GraphWindowResponse
