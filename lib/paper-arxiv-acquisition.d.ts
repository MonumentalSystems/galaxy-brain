import type { DurableDocumentImport } from "./durable-document-import.js"
import type {
  ArxivPaperMetadata,
  ArxivSearchResult,
  GalaxyPaperDetail,
  GalaxyPaperRevision,
  ImportedGalaxyPaper,
  PaperDocument,
} from "./types/papers"

export class PaperArxivAcquisitionError extends TypeError {
  readonly code: string
}

export type PaperArxivClient = {
  searchArxiv(query: string, limit?: number, signal?: AbortSignal): Promise<ArxivSearchResult>
  importArxivPaper(arxivId: string, signal?: AbortSignal): Promise<ImportedGalaxyPaper | null>
  getPaper(id: string, signal?: AbortSignal): Promise<GalaxyPaperDetail | null>
  fetchPaperDocument(id: string, revisionId: string, signal?: AbortSignal): Promise<PaperDocument>
}

export type ExactArxivPaperImport = Readonly<{
  paper: GalaxyPaperDetail
  revision: GalaxyPaperRevision
}>

export type ExactArxivPaperAcquisition = ExactArxivPaperImport & Readonly<{
  paperDocument: PaperDocument & { durable_document: DurableDocumentImport }
  document: DurableDocumentImport
}>

export function exactArxivVersionedId(value: ArxivPaperMetadata): string
export function paperArxivImportRegistered(): boolean
export function searchExactArxivPapers(
  client: Pick<PaperArxivClient, "searchArxiv">,
  query: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<Readonly<{ total: number; results: readonly ArxivPaperMetadata[] }>>
export function importExactArxivPaper(
  client: Pick<PaperArxivClient, "importArxivPaper" | "getPaper">,
  selection: ArxivPaperMetadata,
  signal?: AbortSignal,
): Promise<ExactArxivPaperImport>
export function saveExactArxivPaperDocument(
  client: Pick<PaperArxivClient, "fetchPaperDocument">,
  paper: GalaxyPaperDetail,
  revision: GalaxyPaperRevision,
  signal?: AbortSignal,
): Promise<PaperDocument & { durable_document: DurableDocumentImport }>
export function acquireExactArxivPaper(
  client: PaperArxivClient,
  selection: ArxivPaperMetadata,
  signal?: AbortSignal,
): Promise<ExactArxivPaperAcquisition>
