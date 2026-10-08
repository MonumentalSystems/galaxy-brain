export const DOCX_MEDIA_TYPE: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
export const MAX_DOCX_BYTES: number
export const MAX_DOCX_ENTRIES: number
export const MAX_DOCX_ENTRY_BYTES: number
export const MAX_DOCX_EXPANDED_BYTES: number
export const MAX_DOCX_COMPRESSION_RATIO: number

export class DocxDocumentContractError extends Error {}
export function isDocxCandidate(filename: unknown, mediaType?: unknown): boolean
export function validateDocxPackageMetadata(
  filename: string,
  mediaType: string,
  buffer: ArrayBuffer,
): Readonly<{ mediaType: typeof DOCX_MEDIA_TYPE; entryCount: number; expandedBytes: number }>
