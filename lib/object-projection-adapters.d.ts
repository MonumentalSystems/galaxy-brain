import type { ResearchRecordDocument } from "./research-record"
import type { HamMemoryDetail } from "./ham-memory-client"
import type { GalaxyPaper, GalaxyPaperDetail, GalaxyPaperRevision } from "./types/papers"
import type { GalaxySurfaceRecord } from "./types/surfaces"
import type { TaskSummary } from "./types/tasks"
import type { CanonicalGalaxyObjectKind, GalaxyObjectReference } from "./galaxy-object-reference"
import type { GalaxyObjectProjection } from "./object-projection"

export function projectPaperObject(source: {
  paper: GalaxyPaper | GalaxyPaperDetail
  revision?: GalaxyPaperRevision | null
}): GalaxyObjectProjection

export function projectDocumentObject(source: {
  document_id: string
  revision_sha256: string
  title?: string
  display_filename?: string
  summary?: string
  media_type?: string
  representations?: Array<{
    id: string
    kind: "original" | "document-structure" | "markdown" | "text" | "thumbnail"
    media_type: string
    content_sha256: string
    label?: string
  }>
}): GalaxyObjectProjection

export function projectDocumentAnchorObject(source: {
  id: string
  representation_sha256: string
  anchor_sha256: string
  title?: string
  selector: {
    kind: "page-region" | "text-quote" | "json-pointer"
    page?: number
    exact?: string
    pointer?: string
  }
}): GalaxyObjectProjection

export function projectMarkdownObject(source: {
  objectKind?: CanonicalGalaxyObjectKind
  id: string
  revisionId?: string | null
  contentHash?: string | null
  title: string
  summary?: string
  mediaType?: string
  representationRef: string
  provider?: string
}): GalaxyObjectProjection

export function projectCodeObject(source: {
  objectKind: "code.graph" | "code.repo" | "code.commit" | "code.file" | "code.symbol"
  id: string
  revisionId: string
  contentHash: string
  title: string
  summary?: string
  representationRef: string
}): GalaxyObjectProjection

export function projectMediaObject(source: {
  objectKind?: CanonicalGalaxyObjectKind
  id: string
  revisionId?: string | null
  contentHash?: string | null
  title: string
  summary?: string
  mediaType: string
  representationRef: string
  label?: string
  provider?: string
}): GalaxyObjectProjection

export function projectElnObject(record: ResearchRecordDocument): GalaxyObjectProjection
export function projectElnObservation(source: {
  id: string
  experimentId: string
  version: number
  revisionSha256: string
  body: string
  observedAt: string
}): GalaxyObjectProjection
export function projectTaskObject(task: TaskSummary): GalaxyObjectProjection
export function projectChatObject(chat: {
  conversationId: string
  workspaceId: string
  title: string
  goalSummary: string
  version: number
  contentSha256: string
  turnCount: number
  branchCount: number
}): GalaxyObjectProjection
type ProofProjectionIdentity =
  | { graphId: string; nodeRefId?: never }
  | { nodeRefId: string; graphId?: never }

type ProofProjectionRevision =
  | { contentSha256: string; revisionId?: never }
  | { revisionId: `sha256:${string}`; contentSha256?: never }

export function projectProofObject(source: ProofProjectionIdentity & ProofProjectionRevision & {
  title?: string
  objective?: string
  summary?: string
  provider?: string
}): GalaxyObjectProjection
export function projectHamMemoryObject(memory: HamMemoryDetail): GalaxyObjectProjection
export function projectSurfaceObject(
  surface: GalaxySurfaceRecord & { readonly placement_eligible?: boolean },
): GalaxyObjectProjection
export function projectUnknownReference(
  reference: GalaxyObjectReference | string,
  reason?: string,
): GalaxyObjectProjection
