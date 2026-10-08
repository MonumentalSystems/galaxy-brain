import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  loadCodeEditorDraft,
  loadCodeEditorDraftWithWorkspaceFallback,
  MAX_CODE_EDITOR_CONTENT_BYTES,
  normalizeCodeEditorDraft,
  removeCodeEditorDraft,
  removeCodeEditorDraftWithWorkspaceFallback,
  writeCodeEditorDraft,
} from "../lib/code-editor-draft.js"
import {
  durableUploadMediaType,
  IngestionContractError,
  prepareDurableDocumentImport,
} from "../lib/durable-document-import.js"

function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

const scope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  workspaceId: "workspace-1",
  canvasId: "canvas-1",
}

function pdfFixture() {
  const beforeXref = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
  const xrefOffset = new TextEncoder().encode(beforeXref).byteLength
  return new TextEncoder().encode(`${beforeXref}xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
}

test("authored source uploads require structured PDF bytes or valid UTF-8 text", () => {
  const text = new TextEncoder().encode("theorem useful : True := by trivial").buffer
  assert.equal(durableUploadMediaType({ name: "Useful.lean", type: "text/plain" }, text), "text/plain")
  assert.equal(durableUploadMediaType({ name: "notes.tex", type: "text/x-tex" }, text), "text/x-tex")
  assert.equal(durableUploadMediaType(
    { name: "paper.pdf", type: "application/pdf" },
    pdfFixture().buffer,
  ), "application/pdf")
  assert.throws(
    () => durableUploadMediaType({ name: "paper.pdf", type: "application/pdf" }, text),
    IngestionContractError,
  )
  assert.throws(
    () => durableUploadMediaType(
      { name: "paper.pdf", type: "application/pdf" },
      new TextEncoder().encode("ordinary prose containing %PDF-1.7 but no PDF header or cross-reference").buffer,
    ),
    IngestionContractError,
  )
  assert.throws(
    () => durableUploadMediaType(
      { name: "paper.pdf", type: "application/pdf" },
      new TextEncoder().encode("%PDF-1.7\nplain text without an xref and terminal EOF record").buffer,
    ),
    IngestionContractError,
  )
  assert.throws(
    () => durableUploadMediaType({ name: "source.ts", type: "application/octet-stream" }, text),
    IngestionContractError,
  )
  assert.throws(
    () => durableUploadMediaType({ name: "source.ts", type: "text/plain" }, Uint8Array.from([0xff]).buffer),
    IngestionContractError,
  )
})

test("code drafts are tenant-principal scoped, bounded, and recoverable", () => {
  const state = storage()
  const draft = writeCodeEditorDraft(state, scope, {
    title: "Finite proof",
    filename: "Finite.lean",
    language: "plaintext",
    content: "theorem finite : True := by trivial",
  })
  assert.equal(draft.schemaId, "gb.code-editor-draft.v1")
  assert.deepEqual(loadCodeEditorDraft(state, scope), draft)
  const partial = writeCodeEditorDraft(state, scope, { ...draft, title: "", filename: "" })
  assert.equal(partial.title, "")
  assert.equal(partial.filename, "")
  assert.deepEqual(loadCodeEditorDraft(state, scope), partial)
  assert.equal(loadCodeEditorDraft(state, { ...scope, canvasId: "canvas-2" }), null)
  removeCodeEditorDraft(state, scope)
  assert.equal(loadCodeEditorDraft(state, scope), null)
  assert.throws(() => normalizeCodeEditorDraft({
    title: "Large",
    filename: "large.ts",
    language: "typescript",
    content: "x".repeat(MAX_CODE_EDITOR_CONTENT_BYTES + 1),
  }), /256 KB/)
})

test("first-canvas creation migrates the workspace-local draft without changing its source", () => {
  const state = storage()
  const localScope = { ...scope, canvasId: `local:${scope.workspaceId}` }
  const durableScope = { ...scope, canvasId: "canvas-created-later" }
  const draft = writeCodeEditorDraft(state, localScope, {
    title: "Before canvas",
    filename: "Before.lean",
    language: "plaintext",
    content: "theorem before : True := by trivial",
  })
  assert.equal(loadCodeEditorDraftWithWorkspaceFallback(state, durableScope), null)
  assert.deepEqual(loadCodeEditorDraft(state, localScope), draft)
  const restored = loadCodeEditorDraftWithWorkspaceFallback(state, durableScope, {
    allowWorkspaceFallback: true,
  })
  assert.equal(restored.title, draft.title)
  assert.equal(restored.filename, draft.filename)
  assert.equal(restored.language, draft.language)
  assert.equal(restored.content, draft.content)
  assert.deepEqual(loadCodeEditorDraft(state, durableScope), restored)
  assert.equal(loadCodeEditorDraft(state, localScope), null)
  removeCodeEditorDraftWithWorkspaceFallback(state, durableScope, { allowWorkspaceFallback: true })
  assert.equal(loadCodeEditorDraft(state, durableScope), null)
  assert.equal(loadCodeEditorDraft(state, localScope), null)
})

test("Markdown notes use a separate draft channel while legacy code keys remain unchanged", () => {
  const state = storage()
  const legacyKey = "gb:code-editor-draft:v1:tenant-1:principal-1:workspace-1:canvas-1"
  const noteKey = `${legacyKey}:markdown-note`
  const code = writeCodeEditorDraft(state, scope, {
    title: "Source",
    filename: "source.ts",
    language: "typescript",
    content: "export const exact = true",
  })
  const note = writeCodeEditorDraft(state, scope, {
    title: "Research note",
    filename: "note.md",
    language: "typescript",
    content: "# Note\n\n\\(E=mc^2\\)",
  }, { channel: "markdown-note" })
  assert.equal(JSON.parse(state.getItem(legacyKey)).language, "typescript")
  assert.equal(JSON.parse(state.getItem(noteKey)).language, "markdown")
  assert.deepEqual(loadCodeEditorDraft(state, scope), code)
  assert.deepEqual(loadCodeEditorDraft(state, scope, { channel: "markdown-note" }), note)

  state.setItem(noteKey, JSON.stringify({ ...note, language: "python" }))
  assert.equal(loadCodeEditorDraft(state, scope, { channel: "markdown-note" }).language, "markdown")
  removeCodeEditorDraft(state, scope, { channel: "markdown-note" })
  assert.deepEqual(loadCodeEditorDraft(state, scope), code)
  assert.equal(loadCodeEditorDraft(state, scope, { channel: "markdown-note" }), null)
})

test("blocked draft storage keeps the in-memory authored-source path available", () => {
  const blocked = {
    getItem() { throw new DOMException("blocked", "SecurityError") },
    setItem() { throw new DOMException("blocked", "SecurityError") },
    removeItem() { throw new DOMException("blocked", "SecurityError") },
  }
  assert.equal(loadCodeEditorDraftWithWorkspaceFallback(blocked, scope, { allowWorkspaceFallback: true }), null)
  assert.doesNotThrow(() => removeCodeEditorDraftWithWorkspaceFallback(blocked, scope))
})

test("Atlas code editor is structurally separated from execution surfaces", async () => {
  const [dialog, atlas] = await Promise.all([
    readFile(new URL("../components/code/code-editor-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])
  assert.match(dialog, /<CodeEditor/)
  assert.match(dialog, /window\.sessionStorage/)
  assert.match(dialog, /Draft recovery is unavailable in this browser context/)
  assert.match(dialog, /!nextOpen && \(ambiguous \|\| draftStorageWarning\)/)
  assert.match(dialog, /if \(skipDraftWriteRef\.current\)/)
  assert.doesNotMatch(dialog, /window\.localStorage/)
  assert.match(dialog, /readOnly=\{busy \|\| ambiguous\}/)
  assert.match(dialog, /Boolean\(imported\) \|\| ambiguous/)
  assert.doesNotMatch(dialog, /CodeSandbox|NotebookView|onRun=/)
  assert.doesNotMatch(dialog, /galaxyBrainService|contentProcessingService/)
  assert.match(atlas, /result\.effect\.kind !== "open-code-editor"/)
  assert.match(atlas, /galaxyBrainAPI\.importDocument\(file/)
  assert.match(atlas, /allowWorkspaceFallback: codeDraftAllowsWorkspaceFallback/)
  assert.match(atlas, /Boolean\(!atlas\?\.durableCanvas \|\| atlas\.durableCanvas\.isDefault\)/)
  assert.match(atlas, /No code was executed/)
})

test("Markdown note mode is fixed, plan-backed, target-bound, and placement-only after persistence", async () => {
  const [dialog, editor, atlas] = await Promise.all([
    readFile(new URL("../components/code/code-editor-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/code-editor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])
  assert.match(dialog, /"markdown-note"/)
  assert.match(dialog, /title: "Untitled note"/)
  assert.match(dialog, /filename: "note\.md"/)
  assert.match(dialog, /language: "markdown"/)
  assert.match(dialog, /type: MEDIA_TYPES\[submittedLanguage\]/)
  assert.match(dialog, /textareaLabel=\{presetConfig\.editorLabel\}/)
  assert.match(dialog, /languageLocked=\{preset === "markdown-note"\}/)
  assert.match(editor, /languageLocked \? \(/)
  assert.match(editor, /aria-label=\{textareaLabel\}/)
  assert.doesNotMatch(editor, /disabled=\{languageLocked\}/)

  const noteSave = atlas.slice(
    atlas.indexOf("const saveMarkdownNoteAndPlace"),
    atlas.indexOf("const retryMarkdownNotePlacement"),
  )
  assert.match(noteSave, /executeAtlasDocumentIngestionPlan\(/)
  assert.match(noteSave, /sourceKind: "upload"/)
  assert.match(noteSave, /onPersisted: \(confirmation\) => \{[\s\S]*setMarkdownNoteRecovery/)
  assert.match(noteSave, /setMarkdownNotePhase\("transforming"\)/)
  assert.match(noteSave, /setMarkdownNoteIngestionNotice\(ingestionOutcomeMessage\(result\)\)/)
  assert.match(noteSave, /currentAtlasTargetRef\.current/)
  assert.match(noteSave, /placeReference\(confirmation\.document\.ref, confirmation\.placementOperationId\)/)
  assert.doesNotMatch(noteSave, /galaxyBrainAPI\.importDocument/)
  assert.match(atlas, /channel: MARKDOWN_NOTE_DRAFT_CHANNEL/)
  assert.match(atlas, /completion\.canvas\.canvasId !== markdownNoteRecovery\.canvasId/)
  assert.match(atlas, /Retry placement only; do not save another revision\./)
  assert.match(atlas, /ingestion plan could not confirm its derived representation/)
  assert.match(atlas, /markdownNoteIngestionNotice \? ` \$\{markdownNoteIngestionNotice\}`/)
  assert.match(atlas, /analysisStateForResult\(/)
  assert.match(atlas, /analysisStateForConfirmation\(/)

  const closeNote = atlas.slice(
    atlas.indexOf("const changeMarkdownNoteOpen"),
    atlas.indexOf("const abandonMarkdownNote"),
  )
  assert.match(closeNote, /if \(!markdownNoteRecovery\) \{[\s\S]*setMarkdownNoteTarget\(null\)/)
  assert.match(noteSave, /if \(!safeError\.ambiguous\) setMarkdownNoteTarget\(null\)/)
})

test("durable import identity includes the normalized media type", async () => {
  const bytes = new TextEncoder().encode("same exact bytes")
  const metadata = {
    title: "Same source",
    filename: "same.md",
    sourceKind: "upload",
    sourceUri: null,
    arxivId: null,
  }
  const source = (type) => ({
    name: metadata.filename,
    type,
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.slice().buffer },
  })
  const markdown = await prepareDurableDocumentImport(source("text/markdown"), metadata)
  const plain = await prepareDurableDocumentImport(source("text/plain"), metadata)
  assert.equal(markdown.mediaType, "text/markdown")
  assert.equal(plain.mediaType, "text/plain")
  assert.notEqual(markdown.idempotencyKey, plain.idempotencyKey)
})

test("reusable editor toolbar controls never submit an enclosing save form", async () => {
  const editor = await readFile(new URL("../components/code-editor.tsx", import.meta.url), "utf8")
  const buttonTags = [...editor.matchAll(/<Button[\s\S]*?>/g)].map((match) => match[0])
  assert.ok(buttonTags.length >= 2)
  for (const button of buttonTags) assert.match(button, /type="button"/)
  assert.match(editor, /aria-label="Copy source code"/)
  assert.match(editor, /textareaLabel = "Source code"/)
  assert.match(editor, /aria-label=\{textareaLabel\}/)
  assert.match(editor, /e\.ctrlKey && e\.key\.toLowerCase\(\) === "m"/)
  assert.match(editor, /if \(e\.shiftKey \|\| tabMovesFocus\)/)
})
