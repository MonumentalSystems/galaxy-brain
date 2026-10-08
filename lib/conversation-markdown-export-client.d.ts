export const CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES: number
export class ConversationMarkdownDownloadError extends Error { readonly code: string }
export interface ConversationMarkdownExportDownload {
  readonly blob: Blob
  readonly filename: string
  readonly contentSha256: string
  readonly byteLength: number
}
export function fetchConversationMarkdownExport(
  conversationReference: string,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal; digest?: (bytes: Uint8Array) => Promise<string> },
): Promise<ConversationMarkdownExportDownload>
export function saveConversationMarkdownExport(
  exported: ConversationMarkdownExportDownload,
  options?: {
    documentValue?: Document
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
    scheduleCleanup?: (callback: () => void) => void
  },
): void
export function downloadConversationMarkdown(
  conversationReference: string,
  options?: Parameters<typeof fetchConversationMarkdownExport>[1] & {
    saver?: (exported: ConversationMarkdownExportDownload, options?: object) => void
  },
): Promise<ConversationMarkdownExportDownload>
