export type CodeEditorDraftScope = {
  tenantId: string
  principalId: string
  workspaceId: string
  canvasId: string
}
export type CodeEditorDraftLanguage = "javascript" | "typescript" | "jsx" | "tsx" | "python" | "css" | "json" | "bash" | "sql" | "go" | "rust" | "yaml" | "markdown" | "latex" | "plaintext"
export type CodeEditorDraftChannel = "code" | "markdown-note"
export type CodeEditorDraft = {
  readonly schemaId: "gb.code-editor-draft.v1"
  readonly title: string
  readonly filename: string
  readonly language: CodeEditorDraftLanguage
  readonly content: string
  readonly updatedAt: string
}
export const MAX_CODE_EDITOR_CONTENT_BYTES: number
export function normalizeCodeEditorDraft(value: unknown, options?: { channel?: CodeEditorDraftChannel }): CodeEditorDraft
export function loadCodeEditorDraft(storage: Pick<Storage, "getItem" | "removeItem">, scope: CodeEditorDraftScope, options?: { channel?: CodeEditorDraftChannel }): CodeEditorDraft | null
export function loadCodeEditorDraftWithWorkspaceFallback(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, scope: CodeEditorDraftScope, options?: { allowWorkspaceFallback?: boolean; channel?: CodeEditorDraftChannel }): CodeEditorDraft | null
export function writeCodeEditorDraft(storage: Pick<Storage, "setItem">, scope: CodeEditorDraftScope, draft: Omit<CodeEditorDraft, "schemaId" | "updatedAt">, options?: { channel?: CodeEditorDraftChannel }): CodeEditorDraft
export function removeCodeEditorDraft(storage: Pick<Storage, "removeItem">, scope: CodeEditorDraftScope, options?: { channel?: CodeEditorDraftChannel }): void
export function removeCodeEditorDraftWithWorkspaceFallback(storage: Pick<Storage, "removeItem">, scope: CodeEditorDraftScope, options?: { allowWorkspaceFallback?: boolean; channel?: CodeEditorDraftChannel }): void
