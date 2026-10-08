import type { ArxivPaperMetadata } from "./types/papers"

export type ArxivPaperSource = {
  access: "redistributable" | "private-research" | "stored-private"
  readerUrl: string
  directUrl: string
}

export function canonicalArxivPdfUrl(arxivId: unknown, version: unknown): string
export function paperPdfFilename(metadata: Partial<ArxivPaperMetadata> | null | undefined): string
export function arxivPaperSource(
  metadata: Partial<ArxivPaperMetadata> | null | undefined,
  paperId: string,
  revisionId: string,
  stored?: boolean,
): ArxivPaperSource | null
