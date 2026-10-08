import type { DurableTransformReceipt, GalaxyDocumentStructure } from "./ingestion-contract.js"
import type { ReaderRepresentation } from "./paper-reader.js"

export class DerivedDocumentError extends Error {}
export type ExactDerivedDocumentDescriptor = Readonly<{
  artifactId: string
  contentSha256: string
  mediaType: string
  representationId: string
  revisionId?: string
}>
export type ExactDerivedDocumentState = Readonly<{
  structure: (ReaderRepresentation & { kind: "document-structure"; content: GalaxyDocumentStructure }) | null
  markdown: (ReaderRepresentation & { kind: "markdown"; content: string }) | null
  receipt: DurableTransformReceipt | null
  primaryReceipt: DurableTransformReceipt | null
  fallbackReceipt: DurableTransformReceipt | null
}>
export function shouldAcceptDerivedDocumentCompletion(
  completion: { generation: number; revisionId: string } | null | undefined,
  current: { generation: number; revisionId: string } | null | undefined,
): boolean
export function selectExactDerivedDocumentState(
  descriptor: ExactDerivedDocumentDescriptor,
  representations: unknown,
  receipts: unknown,
  options?: Readonly<{
    label?: string
    primaryPluginId?: string
    primaryEngine?: string
    fallbackPluginId?: string
    fallbackEngine?: string
  }>,
): ExactDerivedDocumentState
