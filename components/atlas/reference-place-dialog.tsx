"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"

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
  inspectPlaceableReference,
  MAX_PLACEABLE_REFERENCE_CHARACTERS,
} from "@/lib/canvas/reference-placement.js"

export type ReferencePlaceDialogProps = {
  open: boolean
  busy: boolean
  error: string
  onOpenChange: (open: boolean) => void
  onPlace: (subjectRef: string) => void
  onEdit: () => void
  returnFocus: HTMLElement | null
}

function validationMessage(value: string) {
  if (!value) return "Paste a canonical Galaxy object reference."
  const result = inspectPlaceableReference(value, { allowSurface: false })
  if (result.ok) return ""
  if (result.code === "unsupported_kind") return "This reference kind is not yet placeable in Atlas."
  if (result.code === "noncanonical_reference") return "Use the exact canonical serialization of this reference."
  return `Enter a valid canonical reference no longer than ${MAX_PLACEABLE_REFERENCE_CHARACTERS.toLocaleString()} characters.`
}

export function ReferencePlaceDialog({
  open,
  busy,
  error,
  onOpenChange,
  onPlace,
  onEdit,
  returnFocus,
}: ReferencePlaceDialogProps) {
  const [value, setValue] = useState("")
  const [localError, setLocalError] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setLocalError("")
  }, [open])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const candidate = value
    const message = validationMessage(candidate)
    if (message) {
      setLocalError(message)
      return
    }
    setLocalError("")
    onPlace(candidate)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className="max-w-[min(94vw,620px)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="research-display text-2xl">Place a canonical reference</DialogTitle>
          <DialogDescription>
            Add a durable Atlas placement. Only the reference and presentation geometry are stored;
            authorized content resolves after placement.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid gap-2">
            <label htmlFor="atlas-reference-input" className="text-sm font-semibold">
              Galaxy object reference
            </label>
            <Input
              ref={inputRef}
              id="atlas-reference-input"
              value={value}
              maxLength={MAX_PLACEABLE_REFERENCE_CHARACTERS}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="gb:object:v1:paper:…:latest"
              aria-invalid={Boolean(localError)}
              aria-describedby={`atlas-reference-help${localError ? " atlas-reference-error" : ""}`}
              disabled={busy}
              onChange={(event) => {
                setValue(event.target.value)
                setLocalError("")
                onEdit()
              }}
            />
            <p id="atlas-reference-help" className="text-xs leading-5 text-muted-foreground">
              Supported now: papers, documents and anchors, ELN experiments, HAM tasks and memories,
              and proof graphs or nodes. Use “Place promoted Generous surface” for Generous surfaces.
            </p>
            {localError ? (
              <p id="atlas-reference-error" role="alert" className="text-sm text-destructive">
                {localError}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} aria-describedby="atlas-reference-place-status">
              {busy ? "Placing…" : "Place reference"}
            </Button>
          </DialogFooter>
          <p id="atlas-reference-place-status" className="sr-only" role="status" aria-live="polite">
            {busy ? "Placing the reference on the durable Atlas canvas." : ""}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  )
}
