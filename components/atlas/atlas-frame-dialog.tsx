"use client"

import { useEffect, useState, type FormEvent } from "react"

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
import { Label } from "@/components/ui/label"
import type { CanvasFrameTone } from "@/lib/canvas/canvas-snapshot"

export type AtlasFrameDraft = Readonly<{ title: string; tone: CanvasFrameTone }>

export function AtlasFrameDialog({
  open,
  busy,
  error,
  returnFocus,
  fallbackFocus,
  recoveryDraft,
  onOpenChange,
  onCreate,
}: Readonly<{
  open: boolean
  busy: boolean
  error: string
  returnFocus: HTMLElement | null
  fallbackFocus: HTMLElement | null
  recoveryDraft?: AtlasFrameDraft | null
  onOpenChange: (open: boolean) => void
  onCreate: (draft: AtlasFrameDraft) => void
}>) {
  const [title, setTitle] = useState("")
  const [tone, setTone] = useState<CanvasFrameTone>("sage")

  useEffect(() => {
    if (open && recoveryDraft) {
      setTitle(recoveryDraft.title)
      setTone(recoveryDraft.tone)
    } else if (!open) {
      setTitle("")
      setTone("sage")
    }
  }, [open, recoveryDraft])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalized = title.trim()
    if (!normalized || normalized.length > 120 || busy) return
    onCreate({ title: normalized, tone })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent
        closeDisabled={busy}
        className="research-panel border-[color:var(--research-line)] bg-[hsl(var(--research-paper))]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = returnFocus?.isConnected ? returnFocus : fallbackFocus
          target?.focus({ preventScroll: true })
        }}
      >
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="research-display text-2xl">New Atlas frame</DialogTitle>
            <DialogDescription>
              Frames organize the canvas visually. They do not own, hydrate, group, or change enclosed objects.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="atlas-frame-title">Title</Label>
              <Input id="atlas-frame-title" autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Tone</legend>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Frame tone">
                {(["neutral", "sage", "amber", "plum"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    aria-pressed={tone === value}
                    variant={tone === value ? "default" : "outline"}
                    onClick={() => setTone(value)}
                  >
                    {value[0].toUpperCase() + value.slice(1)}
                  </Button>
                ))}
              </div>
            </fieldset>
            {error ? <p role="alert" className="text-sm text-[#7f321c]">{error}</p> : null}
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>{busy ? "Creating…" : "Create frame"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
