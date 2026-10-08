import type { GalaxyDocumentStructure } from "./ingestion-contract.js"

export const DOCUMENT_STRUCTURE_PROJECTION_SCHEMA: "gb.document-structure-projection.v1"
export const DOCUMENT_STRUCTURE_BATCH_SCHEMA: "gb.document-structure-projection-batch.v1"

export class DocumentStructureProjectionError extends Error {}

export type ProjectedDocumentBlock = {
  id: string
  kind: string
  order: number
  readingOrderIndex: number
  text: string | null
  latex: string | null
  page: number | null
  region: Record<string, string | number | boolean | null> | null
}

export type DocumentStructureProjection = {
  schemaId: "gb.document-structure-projection.v1"
  pages: unknown[]
  totalBlocks: number
  blocks: ProjectedDocumentBlock[]
}

export type DocumentStructureProjectionBatch = {
  schemaId: "gb.document-structure-projection-batch.v1"
  batchIndex: number
  start: number
  totalBlocks: number
  done: boolean
  pages: unknown[] | null
  blocks: ProjectedDocumentBlock[]
}

export type DocumentStructureProjectionOptions = {
  maxBlocks?: number
  batchSize?: number
}

export function projectDocumentStructure(
  structure: GalaxyDocumentStructure,
  options?: DocumentStructureProjectionOptions,
): DocumentStructureProjection

export function projectDocumentStructureBatches(
  structure: GalaxyDocumentStructure,
  options?: DocumentStructureProjectionOptions,
): Generator<DocumentStructureProjectionBatch, void, unknown>
