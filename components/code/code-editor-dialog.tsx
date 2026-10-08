"use client"

import { FileCode2, Save } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"

import { CodeEditor, type SupportedLanguage } from "@/components/code-editor"
import { focusFirstConnected } from "@/components/atlas/presenter-focus"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  loadCodeEditorDraftWithWorkspaceFallback,
  MAX_CODE_EDITOR_CONTENT_BYTES,
  removeCodeEditorDraftWithWorkspaceFallback,
  writeCodeEditorDraft,
  type CodeEditorDraftChannel,
  type CodeEditorDraftScope,
} from "@/lib/code-editor-draft.js"
import type { DurableDocumentImport } from "@/lib/durable-document-import.js"

export type CodeEditorSavePhase = "idle" | "importing" | "transforming" | "placing"
export type CodeEditorPreset = "code" | "markdown-note"

export type CodeEditorDialogProps = {
  open: boolean
  phase: CodeEditorSavePhase
  error: string
  notice?: string
  imported: DurableDocumentImport | null
  ambiguous: boolean
  scope: CodeEditorDraftScope
  allowWorkspaceFallback: boolean
  preset?: CodeEditorPreset
  onOpenChange: (open: boolean) => void
  onSave: (file: File, title: string) => void
  onRetryPlacement: () => void
  onAbandon: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
  fallbackFocus?: HTMLElement | null
}

const DEFAULT_DRAFT = Object.freeze({
  title: "Untitled source",
  filename: "untitled.ts",
  language: "typescript" as SupportedLanguage,
  content: "",
})

const MARKDOWN_NOTE_DRAFT = Object.freeze({
  title: "Untitled note",
  filename: "note.md",
  language: "markdown" as SupportedLanguage,
  content: "",
})

const EDITOR_PRESETS = Object.freeze({
  code: Object.freeze({
    draft: DEFAULT_DRAFT,
    channel: "code" as CodeEditorDraftChannel,
    title: "Code field note",
    description: "Author source without executing it. Save preserves exact bytes as an immutable document revision and places it on Atlas.",
    editorLabel: "Source code",
    durableNoun: "source revision",
  }),
  "markdown-note": Object.freeze({
    draft: MARKDOWN_NOTE_DRAFT,
    channel: "markdown-note" as CodeEditorDraftChannel,
    title: "Markdown note",
    description: "Author a Markdown research note. Save preserves the exact UTF-8 text, analyzes it through the Documents plan, and places its pinned revision on Atlas.",
    editorLabel: "Markdown note",
    durableNoun: "note revision",
  }),
})

const MEDIA_TYPES: Record<SupportedLanguage, string> = {
  javascript: "text/javascript",
  typescript: "text/x-typescript",
  jsx: "text/jsx",
  tsx: "text/tsx",
  python: "text/x-python",
  css: "text/css",
  json: "application/json",
  bash: "text/x-shellscript",
  sql: "text/x-sql",
  go: "text/x-go",
  rust: "text/x-rust",
  yaml: "text/yaml",
  markdown: "text/markdown",
  latex: "text/x-tex",
  plaintext: "text/plain",
}

export function CodeEditorDialog({
  open,
  phase,
  error,
  notice = "",
  imported,
  ambiguous,
  scope,
  allowWorkspaceFallback,
  preset = "code",
  onOpenChange,
  onSave,
  onRetryPlacement,
  onAbandon,
  onEdit,
  returnFocus,
  fallbackFocus,
}: CodeEditorDialogProps) {
  const presetConfig = EDITOR_PRESETS[preset]
  const [title, setTitle] = useState<string>(presetConfig.draft.title)
  const [filename, setFilename] = useState<string>(presetConfig.draft.filename)
  const [language, setLanguage] = useState<SupportedLanguage>(presetConfig.draft.language)
  const [content, setContent] = useState<string>(presetConfig.draft.content)
  const [localError, setLocalError] = useState("")
  const [draftStorageWarning, setDraftStorageWarning] = useState("")
  const [discardOpen, setDiscardOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const hydratedRef = useRef(false)
  const skipDraftWriteRef = useRef(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const busy = phase !== "idle"
  const byteLength = useMemo(() => new TextEncoder().encode(content).byteLength, [content])

  useEffect(() => {
    if (!open) {
      hydratedRef.current = false
      setDiscardOpen(false)
      return
    }
    if (hydratedRef.current) return
    hydratedRef.current = true
    skipDraftWriteRef.current = true
    let restored = null
    try {
      restored = loadCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, scope, {
        allowWorkspaceFallback,
        channel: presetConfig.channel,
      })
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
    const draft = restored || presetConfig.draft
    setTitle(draft.title)
    setFilename(draft.filename)
    setLanguage(preset === "markdown-note" ? "markdown" : draft.language as SupportedLanguage)
    setContent(draft.content)
    setLocalError("")
  }, [allowWorkspaceFallback, open, preset, presetConfig, scope])

  useEffect(() => {
    if (!open || !hydratedRef.current || imported) return
    if (skipDraftWriteRef.current) {
      skipDraftWriteRef.current = false
      return
    }
    try {
      writeCodeEditorDraft(
        window.sessionStorage,
        scope,
        { title, filename, language: preset === "markdown-note" ? "markdown" : language, content },
        { channel: presetConfig.channel },
      )
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
  }, [content, filename, imported, language, open, preset, presetConfig.channel, scope, title])

  function edit(update: () => void) {
    if (busy || imported || ambiguous) return
    update()
    setLocalError("")
    onEdit()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (imported) {
      onRetryPlacement()
      return
    }
    const normalizedTitle = title.trim()
    const normalizedFilename = filename.trim()
    if (!normalizedTitle || Array.from(normalizedTitle).length > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(normalizedTitle)) {
      setLocalError("Enter a title between 1 and 240 characters.")
      titleRef.current?.focus()
      return
    }
    if (
      !normalizedFilename
      || Array.from(normalizedFilename).length > 240
      || /[\u0000-\u001f\u007f-\u009f]/u.test(normalizedFilename)
      || !/\.[a-z0-9]{1,10}$/iu.test(normalizedFilename)
    ) {
      setLocalError(preset === "markdown-note"
        ? "Enter a Markdown filename ending in .md or .markdown."
        : "Enter a filename with a short extension, such as analysis.ts or proof.lean.")
      return
    }
    if (preset === "markdown-note" && !/\.(?:md|markdown)$/iu.test(normalizedFilename)) {
      setLocalError("Enter a Markdown filename ending in .md or .markdown.")
      return
    }
    if (byteLength < 1 || byteLength > MAX_CODE_EDITOR_CONTENT_BYTES) {
      setLocalError("Enter between 1 byte and 256 KB of UTF-8 source text.")
      return
    }
    try {
      writeCodeEditorDraft(window.sessionStorage, scope, {
        title: normalizedTitle,
        filename: normalizedFilename,
        language: preset === "markdown-note" ? "markdown" : language,
        content,
      }, { channel: presetConfig.channel })
      setDraftStorageWarning("")
    } catch {
      setDraftStorageWarning("Draft recovery is unavailable in this browser context. Keep this dialog open until save and placement finish.")
    }
    const submittedLanguage = preset === "markdown-note" ? "markdown" : language
    onSave(new File([content], normalizedFilename, { type: MEDIA_TYPES[submittedLanguage] }), normalizedTitle)
  }

  function abandon() {
    try {
      removeCodeEditorDraftWithWorkspaceFallback(window.sessionStorage, scope, {
        allowWorkspaceFallback,
        channel: presetConfig.channel,
      })
    } catch {}
    setDiscardOpen(false)
    onAbandon()
  }

  const status = phase === "importing"
    ? `Preserving exact UTF-8 ${preset === "markdown-note" ? "Markdown note" : "source"} bytes as a durable document revision.`
    : phase === "transforming"
      ? "The exact note revision is durable. Running bounded document analysis now."
    : phase === "placing"
      ? `The ${presetConfig.durableNoun} is durable. Placing it on this Atlas.`
      : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return
        if (!nextOpen && (ambiguous || draftStorageWarning)) {
          setDiscardOpen(true)
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        ref={contentRef}
        tabIndex={-1}
        className="atlas-command-presenter research-workbench flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[1180px] flex-col overflow-hidden p-0 sm:h-[min(92dvh,860px)]"
        closeDisabled={busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (focusFirstConnected([returnFocus, fallbackFocus], contentRef.current)) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader className="atlas-command-presenter__section shrink-0 border-b px-5 py-4 pr-14 text-left">
          <DialogTitle className="research-display flex items-center gap-2 text-2xl">
            <FileCode2 className="h-5 w-5" aria-hidden="true" /> {presetConfig.title}
          </DialogTitle>
          <DialogDescription className="atlas-command-presenter__muted">
            {presetConfig.description}
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col overflow-y-auto" onSubmit={submit}>
          <div className="atlas-command-presenter__surface grid shrink-0 gap-3 border-b p-4 md:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor="code-editor-title" className="text-sm font-semibold">Title</label>
              <Input
                ref={titleRef}
                id="code-editor-title"
                value={title}
                maxLength={240}
                disabled={busy || Boolean(imported) || ambiguous}
                onChange={(event) => edit(() => setTitle(event.target.value))}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="code-editor-filename" className="text-sm font-semibold">Filename</label>
              <Input
                id="code-editor-filename"
                value={filename}
                maxLength={240}
                disabled={busy || Boolean(imported) || ambiguous}
                spellCheck={false}
                onChange={(event) => edit(() => setFilename(event.target.value))}
              />
            </div>
          </div>
          {imported ? (
            <div className="atlas-command-presenter__card m-5 rounded-xl border p-4">
              <p className="font-semibold">{imported.title}</p>
              <p className="atlas-command-presenter__muted mt-1 break-all font-mono text-xs">{imported.display_filename}</p>
              <p className="mt-2 text-sm">The immutable revision is safe. Retry only its Atlas placement.</p>
            </div>
          ) : (
            <CodeEditor
              value={content}
              onChange={(value) => edit(() => setContent(value))}
              language={language}
              onLanguageChange={preset === "code" ? (value) => edit(() => setLanguage(value)) : undefined}
              languageLocked={preset === "markdown-note"}
              textareaLabel={presetConfig.editorLabel}
              readOnly={busy || ambiguous}
              className="min-h-[16rem] flex-1 shrink-0 rounded-none border-0"
            />
          )}
          <div className="atlas-command-presenter__section shrink-0 border-t px-4 py-3 sm:px-5">
            {localError ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{localError}</p> : null}
            {draftStorageWarning ? <p role="status" className="atlas-command-presenter__warning mb-2 text-sm">{draftStorageWarning}</p> : null}
            {notice ? <p role="status" className="atlas-command-presenter__muted mb-2 text-sm">{notice}</p> : null}
            {error ? <p role="alert" className="atlas-command-presenter__warning mb-2 text-sm">{error}</p> : null}
            <DialogFooter className="gap-3 sm:items-center sm:justify-between">
              <span className="atlas-command-presenter__muted text-xs">
                {byteLength.toLocaleString()} / {MAX_CODE_EDITOR_CONTENT_BYTES.toLocaleString()} bytes · {draftStorageWarning ? "in-memory draft; keep this dialog open until placement" : "draft retained in this tab until placement"}
              </span>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
                <Button className="min-h-11 w-full sm:w-auto" type="button" variant="ghost" disabled={busy} onClick={() => setDiscardOpen(true)}>Discard draft</Button>
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => (ambiguous || draftStorageWarning) ? setDiscardOpen(true) : onOpenChange(false)}
                >
                  {ambiguous ? "Resolve retry" : draftStorageWarning ? "Close…" : "Keep draft & close"}
                </Button>
                <Button className="min-h-11 w-full sm:w-auto" type="submit" disabled={busy || (!imported && (byteLength < 1 || byteLength > MAX_CODE_EDITOR_CONTENT_BYTES))}>
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {phase === "importing"
                    ? "Saving…"
                    : phase === "transforming"
                      ? "Analyzing…"
                      : phase === "placing"
                        ? "Placing…"
                        : imported
                          ? "Retry placement"
                          : ambiguous
                            ? "Retry safe save"
                            : "Save & place"}
                </Button>
              </div>
            </DialogFooter>
            <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
          </div>
        </form>
        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent className="atlas-command-presenter research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>{ambiguous
                ? "Abandon the safe save retry?"
                : draftStorageWarning
                  ? `Discard this in-memory ${preset === "markdown-note" ? "note" : "code"} draft?`
                  : `Discard this ${preset === "markdown-note" ? "note" : "code"} draft?`}</AlertDialogTitle>
              <AlertDialogDescription className="atlas-command-presenter__muted">
                {ambiguous
                  ? "The first request may already have stored the exact source revision. Keeping the draft in this tab lets Galaxy derive the same safe operation identity and reconcile it later."
                  : draftStorageWarning
                    ? "This browser cannot recover the draft after closing. Keep editing, or explicitly discard the in-memory source. No durable document is deleted."
                  : "This removes the browser draft. No durable document is deleted."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction onClick={abandon} className="atlas-command-presenter__danger-action">
                {ambiguous ? "Abandon retry" : "Discard draft"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
