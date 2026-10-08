"use client"

import { FileText, Upload } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { AtlasDropImportError, planAtlasFileImport } from "@/lib/atlas-drop-import.js"
import type { DurableDocumentImport } from "@/lib/durable-document-import.js"
import { inferPdfImportTitle } from "@/lib/pdf-import-title.js"

export type DocumentImportPhase = "idle" | "importing" | "transforming" | "placing"
type TitleDetection = "idle" | "detecting" | "detected" | "fallback"

export type DocumentImportDialogProps = {
  open: boolean
  phase: DocumentImportPhase
  error: string
  ingestionNotice: string
  errorField: "file" | "title" | null
  imported: DurableDocumentImport | null
  ambiguous: boolean
  onOpenChange: (open: boolean) => void
  onImport: (file: File, title: string) => void
  onRetryPlacement: () => void
  onAbandon: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
}

function titleFromFilename(filename: string) {
  const withoutExtension = filename.replace(/\.[^.]+$/u, "")
  return withoutExtension.replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/gu, " ").trim()
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024)).toLocaleString()} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function atlasImportErrorMessage(error: unknown) {
  return error instanceof AtlasDropImportError
    ? error.message.replace(/^Drop /u, "Choose ").replace(/^The dropped file/u, "The selected file")
    : "Choose one supported local document or media file."
}

export function DocumentImportDialog({
  open,
  phase,
  error,
  ingestionNotice,
  errorField,
  imported,
  ambiguous,
  onOpenChange,
  onImport,
  onRetryPlacement,
  onAbandon,
  onEdit,
  returnFocus,
}: DocumentImportDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [titleDetection, setTitleDetection] = useState<TitleDetection>("idle")
  const [localError, setLocalError] = useState<{ field: "file" | "title"; message: string } | null>(null)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const titleDetectionGenerationRef = useRef(0)
  const busy = phase !== "idle"
  const closeBlocked = phase === "importing" || phase === "placing"

  useEffect(() => {
    if (open) return
    setFile(null)
    setTitle("")
    setTitleDetection("idle")
    titleDetectionGenerationRef.current += 1
    setLocalError(null)
    setAbandonOpen(false)
  }, [open])

  useEffect(() => {
    if (!open || !errorField) return
    if (errorField === "file") fileRef.current?.focus()
    else titleRef.current?.focus()
  }, [errorField, open])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || titleDetection === "detecting") return
    if (imported) {
      onRetryPlacement()
      return
    }
    if (!file) {
      setLocalError({ field: "file", message: "Choose a document or media file to import." })
      fileRef.current?.focus()
      return
    }
    let plan
    try {
      plan = planAtlasFileImport(file)
    } catch (error) {
      setLocalError({
        field: "file",
        message: atlasImportErrorMessage(error),
      })
      fileRef.current?.focus()
      return
    }
    const normalizedTitle = title.trim()
    if (!normalizedTitle || Array.from(normalizedTitle).length > 500) {
      setLocalError({ field: "title", message: "Enter a document title between 1 and 500 characters." })
      titleRef.current?.focus()
      return
    }
    setLocalError(null)
    onImport(plan.file, normalizedTitle)
  }

  const status = phase === "importing"
    ? "Importing exact file bytes into the durable document store."
    : phase === "transforming"
      ? "The exact original is durable. Running bounded document analysis."
    : phase === "placing"
      ? "The document is durable. Placing its immutable revision on this Atlas."
      : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && closeBlocked) return
        if (!nextOpen && ambiguous) {
          setAbandonOpen(true)
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-w-[min(94vw,640px)]"
        closeDisabled={closeBlocked}
        onOpenAutoFocus={(event) => {
          if (imported) return
          event.preventDefault()
          fileRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (closeBlocked) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (closeBlocked) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="research-display text-2xl">Import a document</DialogTitle>
          <DialogDescription>
            Preserve the exact file first, run the registered replayable analysis plan, then place its
            immutable revision on the Atlas.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          {imported ? (
            <div className="rounded-xl border border-[#93a48e]/45 bg-[#edf1e7] p-4 text-[#18372b]">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-semibold">{imported.title}</p>
                  <p className="mt-1 break-all text-xs text-[#61766b]">{imported.display_filename}</p>
                  {phase === "idle" ? <a
                    className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
                    href={`/documents/${encodeURIComponent(imported.revision_id)}`}
                  >
                    Open exact document revision
                  </a> : null}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <label htmlFor="atlas-document-file" className="text-sm font-semibold">Document or media file</label>
                <Input
                  ref={fileRef}
                  id="atlas-document-file"
                  type="file"
                  accept=".pdf,.docx,.md,.markdown,.mdx,.txt,.text,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.java,.c,.h,.cc,.cpp,.cxx,.hpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.kts,.scala,.sh,.bash,.zsh,.fish,.ps1,.sql,.css,.scss,.sass,.less,.html,.htm,.json,.jsonl,.ipynb,.xml,.csv,.yaml,.yml,.toml,.png,.jpg,.jpeg,.webp,.gif,.webm"
                  disabled={busy || ambiguous}
                  aria-invalid={localError?.field === "file" || errorField === "file"}
                  aria-describedby={`atlas-document-file-help${localError?.field === "file" ? " atlas-document-local-error" : ""}${errorField === "file" ? " atlas-document-import-error" : ""}`}
                  onChange={(event) => {
                    const nextFile = event.target.files?.item(0) || null
                    const detectionGeneration = titleDetectionGenerationRef.current + 1
                    titleDetectionGenerationRef.current = detectionGeneration
                    setFile(nextFile)
                    setTitle(nextFile ? titleFromFilename(nextFile.name) : "")
                    setTitleDetection("idle")
                    setLocalError(null)
                    onEdit()
                    if (!nextFile) return
                    let plan
                    try {
                      plan = planAtlasFileImport(nextFile)
                    } catch (error) {
                      setLocalError({ field: "file", message: atlasImportErrorMessage(error) })
                      return
                    }
                    if (/\.pdf$/iu.test(plan.file.name)) {
                      setTitleDetection("detecting")
                      void inferPdfImportTitle(plan.file).then((result) => {
                        if (titleDetectionGenerationRef.current !== detectionGeneration) return
                        if (result) {
                          setTitle(result.title)
                          setTitleDetection("detected")
                        } else {
                          setTitleDetection("fallback")
                        }
                      }).catch(() => {
                        if (titleDetectionGenerationRef.current === detectionGeneration) setTitleDetection("fallback")
                      })
                    }
                  }}
                />
                <p id="atlas-document-file-help" className="text-xs leading-5 text-muted-foreground">
                  One allowlisted PDF, non-macro DOCX (up to 25 MiB), text/code/Markdown, static image, or WebM/Opus file. The original bytes are retained unchanged.
                </p>
                {file ? (
                  <p className="flex items-center gap-2 text-xs text-[#486054]">
                    <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0">{formatBytes(file.size)}</span>
                  </p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <label htmlFor="atlas-document-title" className="text-sm font-semibold">Document title</label>
                <Input
                  ref={titleRef}
                  id="atlas-document-title"
                  value={title}
                  maxLength={500}
                  disabled={busy || ambiguous}
                  placeholder="Enter the actual document title"
                  aria-invalid={localError?.field === "title" || errorField === "title"}
                  aria-describedby={`atlas-document-title-help${localError?.field === "title" ? " atlas-document-local-error" : ""}${errorField === "title" ? " atlas-document-import-error" : ""}`}
                  onChange={(event) => {
                    titleDetectionGenerationRef.current += 1
                    setTitle(event.target.value)
                    setTitleDetection("idle")
                    setLocalError(null)
                    onEdit()
                  }}
                />
                <p id="atlas-document-title-help" className="text-xs leading-5 text-muted-foreground">
                  {titleDetection === "detecting"
                    ? "Detecting the title from PDF metadata and first-page layout…"
                    : titleDetection === "detected"
                      ? "Title detected automatically from the PDF. You can override it before import."
                      : titleDetection === "fallback"
                        ? "No reliable PDF title was detected, so Galaxy Brain is using the filename as a fallback."
                        : "Galaxy Brain detects PDF titles automatically; this field remains available for an optional override."}
                </p>
              </div>
            </>
          )}
          {localError ? <p id="atlas-document-local-error" role="alert" className="text-sm text-destructive">{localError.message}</p> : null}
          {error ? (
            <p id="atlas-document-import-error" role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {ingestionNotice ? (
            <p className="rounded-md border border-[#93a48e]/45 bg-[#edf1e7] p-3 text-sm text-[#294438]">
              {ingestionNotice}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={closeBlocked}
              onClick={() => ambiguous ? setAbandonOpen(true) : onOpenChange(false)}
            >
              {phase === "transforming"
                ? "Continue in background"
                : ambiguous
                  ? "Abandon retry"
                  : imported
                    ? "Keep without placing"
                    : "Cancel"}
            </Button>
            <Button type="submit" disabled={busy || titleDetection === "detecting"} aria-describedby="atlas-document-import-status">
              {phase === "importing" ? "Importing…" : phase === "transforming" ? "Analyzing…" : phase === "placing" ? "Placing…" : imported ? "Retry placement" : titleDetection === "detecting" ? "Detecting title…" : "Import and place"}
            </Button>
          </DialogFooter>
          <p id="atlas-document-import-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {status}
          </p>
        </form>
      </DialogContent>
      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop retrying this import?</AlertDialogTitle>
            <AlertDialogDescription>
              The first request may already have stored the file. You can recover it later by choosing
              the exact same file and title; Galaxy Brain derives the same safe operation identity again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue safe retry</AlertDialogCancel>
            <AlertDialogAction onClick={onAbandon}>Abandon import retry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
