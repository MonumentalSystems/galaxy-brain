import { galaxyBrainAPI, type Experiment } from "@/lib/galaxy-brain-api"
import type { DocumentCorpusSearchItem } from "@/lib/document-corpus-search.js"
import { searchHam, type HamSearchResult } from "@/lib/ham-search-client"
import type { ArxivPaperMetadata, GalaxyPaper } from "@/lib/types/papers"

const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_DOCUMENTS = 1_000

export type LibraryDocument = Readonly<{
  id: string
  title: string
  displayFilename: string
  currentRevisionId: string
  currentVersion: number
  createdAt: string
  updatedAt: string
}>

export type LibraryCatalog = Readonly<{
  documents: readonly LibraryDocument[]
  papers: readonly GalaxyPaper[]
  experiments: readonly Experiment[]
  unavailable: readonly string[]
}>

export type LibrarySearchResults = Readonly<{
  documents: readonly DocumentCorpusSearchItem[]
  ham: readonly HamSearchResult[]
  arxiv: readonly ArxivPaperMetadata[]
  arxivTotal: number
  unavailable: readonly string[]
}>

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Library returned an invalid document list.")
  return value as UnknownRecord
}

function boundedString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`Library returned an invalid ${label}.`)
  }
  return value
}

function timestamp(value: unknown, label: string) {
  const text = boundedString(value, label, 64)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Library returned an invalid ${label}.`)
  return text
}

function projectDocument(value: unknown): LibraryDocument {
  const source = record(value)
  const id = boundedString(source.id, "document id", 64).toLowerCase()
  const currentRevisionId = boundedString(source.current_revision_id, "document revision id", 64).toLowerCase()
  if (!DOCUMENT_ID.test(id) || !DOCUMENT_ID.test(currentRevisionId)) {
    throw new Error("Library returned an invalid document identity.")
  }
  if (!Number.isSafeInteger(source.current_version) || Number(source.current_version) < 1) {
    throw new Error("Library returned an invalid document version.")
  }
  return Object.freeze({
    id,
    title: boundedString(source.title, "document title", 512),
    displayFilename: boundedString(source.display_filename, "document filename", 512),
    currentRevisionId,
    currentVersion: Number(source.current_version),
    createdAt: timestamp(source.created_at, "document creation time"),
    updatedAt: timestamp(source.updated_at, "document update time"),
  })
}

export async function listLibraryDocuments(signal?: AbortSignal): Promise<readonly LibraryDocument[]> {
  const response = await fetch("/api/eln/documents", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  })
  if (!response.ok) throw new Error("Documents are unavailable.")
  const body = record(await response.json())
  if (body.schemaId !== "gb.document.list.v1" || !Array.isArray(body.documents) || body.documents.length > MAX_DOCUMENTS) {
    throw new Error("Library returned an invalid document list.")
  }
  return Object.freeze(body.documents.map(projectDocument))
}

export async function loadLibraryCatalog(signal?: AbortSignal): Promise<LibraryCatalog> {
  const [documents, papers, experiments] = await Promise.allSettled([
    listLibraryDocuments(signal),
    galaxyBrainAPI.getPapers(250),
    galaxyBrainAPI.getExperiments(),
  ])
  if (signal?.aborted) throw new DOMException("Library load aborted", "AbortError")
  const unavailable = [
    ...(documents.status === "rejected" ? ["documents"] : []),
    ...(papers.status === "rejected" ? ["papers"] : []),
    ...(experiments.status === "rejected" ? ["ELN"] : []),
  ]
  return Object.freeze({
    documents: documents.status === "fulfilled" ? documents.value : Object.freeze([]),
    papers: Object.freeze(papers.status === "fulfilled" ? papers.value : []),
    experiments: Object.freeze(experiments.status === "fulfilled" ? experiments.value : []),
    unavailable: Object.freeze(unavailable),
  })
}

export async function searchLibrary(query: string, signal?: AbortSignal): Promise<LibrarySearchResults> {
  const normalized = query.trim()
  if (normalized.length < 2 || normalized.length > 500) throw new Error("Search with 2 to 500 characters.")
  const [documents, ham, arxiv] = await Promise.allSettled([
    galaxyBrainAPI.searchDocumentCorpus({ query: normalized, limit: 12, signal }),
    searchHam({ query: normalized, mode: "multihop", topK: 12, maxHops: 2 }, { signal }),
    galaxyBrainAPI.searchArxiv(normalized, 12, signal),
  ])
  if (signal?.aborted) throw new DOMException("Library search aborted", "AbortError")
  return Object.freeze({
    documents: documents.status === "fulfilled" ? documents.value.items : Object.freeze([]),
    ham: ham.status === "fulfilled" ? Object.freeze(ham.value) : Object.freeze([]),
    arxiv: arxiv.status === "fulfilled" ? Object.freeze(arxiv.value.results) : Object.freeze([]),
    arxivTotal: arxiv.status === "fulfilled" ? arxiv.value.total : 0,
    unavailable: Object.freeze([
      ...(documents.status === "rejected" ? ["document corpus"] : []),
      ...(ham.status === "rejected" ? ["HAM"] : []),
      ...(arxiv.status === "rejected" ? ["arXiv"] : []),
    ]),
  })
}
