import type { DurableDocumentImport } from "@/lib/durable-document-import.js"

export type ArxivPaperMetadata = {
  arxiv_id: string
  arxiv_version: number
  title: string
  abstract: string
  authors: Array<{ name: string }>
  categories: string[]
  published_at?: string | null
  source_updated_at?: string | null
  abs_url: string
  pdf_url: string
  doi?: string | null
  journal_ref?: string | null
  license_url?: string | null
}

export type PaperAnnotationAnchor =
  | { type: "text"; quote: string; startOffset: number; endOffset: number }
  | { type: "ink"; points: Array<{ x: number; y: number }>; width: number }
  | { type: "region"; x: number; y: number; width: number; height: number }

export type PaperAnnotation = {
  id: string
  paper_id: string
  paper_revision_id: string
  kind: "highlight" | "comment" | "ink"
  page_number: number
  anchor: PaperAnnotationAnchor
  body: string
  color: string
  lens: "proof" | "audit" | "analysis"
  semantic_role: "claim" | "evidence" | "note"
  tags: string[]
  version: number
  created_at: string
  updated_at: string
}

export type PaperDocument = {
  id: string
  paper_id: string
  paper_revision_id: string
  media_type: "application/pdf"
  filename: string
  byte_size: number
  content_sha256: string
  source_url: string
  stored_at: string
  deduplicated?: boolean
  bridge_replayed?: boolean
  deduplicated_artifact?: boolean
  durable_document?: DurableDocumentImport | null
}

export type GalaxyPaperRevision = {
  id: string
  paper_id: string
  arxiv_version: number
  metadata_hash: string
  metadata: ArxivPaperMetadata
  imported_at: string
  document?: PaperDocument | null
}

export type PaperClaim = {
  id: string
  paper_id: string
  source_annotation_id?: string | null
  statement: string
  status: "open" | "supported" | "refuted" | "mixed"
  tags: string[]
  created_at: string
  updated_at: string
}

export type ClaimEvidenceLink = {
  claim_id: string
  annotation_id: string
  relation: "supports" | "refutes" | "context"
  created_at: string
}

export type PaperTaskLink = {
  id: string
  paper_id: string
  annotation_id?: string | null
  claim_id?: string | null
  ham_task_id: string
  parent_ham_task_id?: string | null
  relation: "document-task" | "subtask"
  title_snapshot: string
  created_at: string
}

export type GalaxyPaper = ArxivPaperMetadata & {
  id: string
  metadata_hash: string
  imported_at: string
  updated_at: string
}

export type ImportedGalaxyPaper = GalaxyPaper & {
  imported_revision_id: string
  imported_revision_metadata_hash: string
  imported_revision_arxiv_version: number
}

export type GalaxyPaperDetail = GalaxyPaper & {
  revisions: GalaxyPaperRevision[]
  annotations: PaperAnnotation[]
  claims: PaperClaim[]
  evidence_links: ClaimEvidenceLink[]
  task_links: PaperTaskLink[]
}

export type ArxivSearchResult = { total: number; results: ArxivPaperMetadata[] }
