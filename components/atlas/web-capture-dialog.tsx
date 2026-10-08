"use client"

import { Globe2, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent } from "react"

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
import { Textarea } from "@/components/ui/textarea"
import type {
  AtlasWebCaptureInput,
  AtlasWebCapturePlacementRecovery,
} from "@/lib/atlas-web-capture.js"

export type AtlasWebCapturePhase = "idle" | "capturing" | "placing"

type WebCaptureField = "url" | "title" | "content"

type WebCaptureFieldError = Readonly<{
  field: WebCaptureField
  message: string
}>

type WebCaptureDialogProps = {
  open: boolean
  phase: AtlasWebCapturePhase
  error: string
  ambiguous: boolean
  recovery: AtlasWebCapturePlacementRecovery | null
  onOpenChange: (open: boolean) => void
  onCapture: (input: AtlasWebCaptureInput) => void
  onRetryPlacement: () => void
  onAbandonCapture: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
}

export function WebCaptureDialog({
  open,
  phase,
  error,
  ambiguous,
  recovery,
  onOpenChange,
  onCapture,
  onRetryPlacement,
  onAbandonCapture,
  onEdit,
  returnFocus,
}: WebCaptureDialogProps) {
  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")
  const [format, setFormat] = useState<AtlasWebCaptureInput["format"]>("markdown")
  const [content, setContent] = useState("")
  const [localError, setLocalError] = useState<WebCaptureFieldError | null>(null)
  const [abandonOpen, setAbandonOpen] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const busy = phase !== "idle"

  useEffect(() => {
    if (open) return
    setUrl("")
    setTitle("")
    setFormat("markdown")
    setContent("")
    setLocalError(null)
    setAbandonOpen(false)
  }, [open])

  function edit(update: () => void) {
    update()
    setLocalError(null)
    onEdit()
  }

  function rejectField(field: WebCaptureField, message: string) {
    setLocalError({ field, message })
    const target = field === "url" ? urlRef : field === "title" ? titleRef : contentRef
    target.current?.focus()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (recovery) {
      onRetryPlacement()
      return
    }
    if (!/^https?:\/\//iu.test(url.trim())) {
      rejectField("url", "Enter the http(s) URL where these bytes came from. Galaxy will store it as provenance and will not fetch it.")
      return
    }
    if (!title.trim() || Array.from(title.trim()).length > 400) {
      rejectField("title", "Enter a title between 1 and 400 characters.")
      return
    }
    if (!content.trim()) {
      rejectField("content", "Paste the exact HTML, Markdown, or text bytes to preserve.")
      return
    }
    setLocalError(null)
    onCapture({ url: url.trim(), title: title.trim(), format, content })
  }

  const status = phase === "capturing"
    ? "Preserving the exact submitted bytes, then running the registered bounded transform."
    : phase === "placing"
      ? "The capture is durable. Placing its pinned document revision on the original Atlas canvas."
      : ""

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && busy) return
          if (!nextOpen && ambiguous) {
            setAbandonOpen(true)
            return
          }
          onOpenChange(nextOpen)
        }}
      >
        <DialogContent
          className="max-h-[calc(100dvh-1rem)] max-w-[min(94vw,720px)] overflow-y-auto"
          closeDisabled={busy}
          onOpenAutoFocus={(event) => {
            if (recovery) return
            event.preventDefault()
            urlRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocus?.isConnected) return
            event.preventDefault()
            returnFocus.focus()
          }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault() }}
        >
          <DialogHeader>
            <DialogTitle className="research-display text-2xl">Capture web content</DialogTitle>
            <DialogDescription>
              Paste exact content you already have and record its provenance URL. Galaxy does not fetch the URL,
              execute markup, or infer semantic relations.
            </DialogDescription>
          </DialogHeader>

          <form className="grid gap-4" onSubmit={submit}>
            {recovery ? (
              <div className="rounded-xl border border-[#93a48e]/45 bg-[#edf1e7] p-4 text-[#18372b]">
                <div className="flex items-start gap-3">
                  <Globe2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-semibold">{recovery.title}</p>
                    <p className="mt-1 break-all text-xs text-[#4f6359]">{recovery.captureUrl}</p>
                    <p className="mt-1 text-xs text-[#4f6359]">Exact {recovery.format} original · pinned durable document</p>
                    {phase === "idle" ? (
                      <a
                        className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
                        href={`/documents/${encodeURIComponent(recovery.durableDocument.revision_id)}`}
                      >
                        Open exact document revision
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="grid gap-2">
                  <label htmlFor="atlas-web-capture-url" className="text-sm font-semibold">Provenance URL</label>
                  <Input
                    ref={urlRef}
                    id="atlas-web-capture-url"
                    type="url"
                    inputMode="url"
                    value={url}
                    maxLength={2048}
                    disabled={busy || ambiguous}
                    aria-invalid={localError?.field === "url"}
                    aria-describedby={`atlas-web-capture-url-help${localError?.field === "url" ? " atlas-web-capture-url-error" : ""}`}
                    onChange={(event) => edit(() => setUrl(event.target.value))}
                  />
                  <p id="atlas-web-capture-url-help" className="text-xs leading-5 text-muted-foreground">
                    Provenance only. Galaxy never requests this URL.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
                  <div className="grid gap-2">
                    <label htmlFor="atlas-web-capture-title" className="text-sm font-semibold">Title</label>
                    <Input
                      ref={titleRef}
                      id="atlas-web-capture-title"
                      value={title}
                      maxLength={400}
                      disabled={busy || ambiguous}
                      aria-invalid={localError?.field === "title"}
                      aria-describedby={`atlas-web-capture-title-help${localError?.field === "title" ? " atlas-web-capture-title-error" : ""}`}
                      onChange={(event) => edit(() => setTitle(event.target.value))}
                    />
                    <p id="atlas-web-capture-title-help" className="text-xs leading-5 text-muted-foreground">
                      Use a concise title between 1 and 400 characters.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <label htmlFor="atlas-web-capture-format" className="text-sm font-semibold">Content format</label>
                    <select
                      id="atlas-web-capture-format"
                      className="flex h-10 min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      value={format}
                      disabled={busy || ambiguous}
                      onChange={(event) => edit(() => setFormat(event.target.value as AtlasWebCaptureInput["format"]))}
                    >
                      <option value="html">HTML</option>
                      <option value="markdown">Markdown</option>
                      <option value="text">Plain text</option>
                    </select>
                  </div>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="atlas-web-capture-content" className="text-sm font-semibold">Exact content</label>
                  <Textarea
                    ref={contentRef}
                    id="atlas-web-capture-content"
                    className="min-h-[min(38vh,18rem)] font-mono text-sm"
                    value={content}
                    maxLength={2_000_000}
                    disabled={busy || ambiguous}
                    aria-invalid={localError?.field === "content"}
                    aria-describedby={`atlas-web-capture-content-help${localError?.field === "content" ? " atlas-web-capture-content-error" : ""}`}
                    onChange={(event) => edit(() => setContent(event.target.value))}
                  />
                  <p id="atlas-web-capture-content-help" className="text-xs leading-5 text-muted-foreground">
                    The submitted UTF-8 bytes become the immutable original. Scripts are stored as text and are never executed here.
                  </p>
                </div>
              </>
            )}

            {localError ? (
              <p
                id={`atlas-web-capture-${localError.field}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {localError.message}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => ambiguous ? setAbandonOpen(true) : onOpenChange(false)}
              >
                {recovery ? "Keep for later" : ambiguous ? "Abandon retry" : "Cancel"}
              </Button>
              <Button type="submit" disabled={busy || (!recovery && !ambiguous && !content.trim())}>
                {phase === "capturing" ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {phase === "capturing"
                  ? "Saving exact capture…"
                  : phase === "placing"
                    ? "Placing…"
                    : recovery
                      ? "Retry placement only"
                      : ambiguous
                        ? "Retry frozen capture"
                        : "Save and place"}
              </Button>
            </DialogFooter>
          </form>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</p>
        </DialogContent>
      </Dialog>

      <AlertDialog open={abandonOpen} onOpenChange={setAbandonOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandon this frozen retry?</AlertDialogTitle>
            <AlertDialogDescription>
              Galaxy could not confirm the capture response. Abandoning forgets its replay key; retrying is safer if the exact original may already be durable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continue retrying</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setAbandonOpen(false)
              onAbandonCapture()
            }}>
              Abandon retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
