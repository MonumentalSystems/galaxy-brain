"use client"

import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react"
import { Layers3, LoaderCircle, RefreshCw } from "lucide-react"

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
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import { promotedSurfaceReference } from "@/lib/surface-placement.js"
import type { GalaxySurfaceRecord } from "@/lib/types/surfaces"

type PromotedSurfacePlaceDialogProps = {
  open: boolean
  busy: boolean
  placementError: string
  onOpenChange: (open: boolean) => void
  onPlace: (subjectRef: string) => boolean
  onEdit: () => void
  returnFocus: HTMLElement | null
}

export function PromotedSurfacePlaceDialog({
  open,
  busy,
  placementError,
  onOpenChange,
  onPlace,
  onEdit,
  returnFocus,
}: PromotedSurfacePlaceDialogProps) {
  const [surfaces, setSurfaces] = useState<GalaxySurfaceRecord[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [reload, setReload] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const deferredQuery = useDeferredValue(query.trim())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError("")
    galaxyBrainAPI.getSurfaces({ status: "promoted", query: deferredQuery || undefined, limit: 200 })
      .then((records) => {
        if (cancelled) return
        if (records === null) throw new Error("Surface service unavailable")
        const promoted = records.filter((surface) => surface.status === "promoted")
        setSurfaces(promoted)
        setSelectedId((current) => promoted.some((surface) => surface.id === current)
          ? current
          : promoted[0]?.id ?? "")
      })
      .catch(() => {
        if (!cancelled) {
          setSurfaces([])
          setSelectedId("")
          setLoadError("Promoted surfaces could not be loaded.")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [deferredQuery, open, reload])

  const selectedVisible = surfaces.some((surface) => surface.id === selectedId)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const selected = surfaces.find((surface) => surface.id === selectedId)
    if (!selected) return
    try {
      onPlace(promotedSurfaceReference(selected))
    } catch {
      setLoadError("This promoted revision has an invalid immutable identifier.")
    }
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
        className="max-w-[min(94vw,720px)]"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
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
          <DialogTitle className="research-display text-2xl">Place promoted Generous surface</DialogTitle>
          <DialogDescription>
            Choose a reviewed Generous surface. Atlas stores only a pinned canonical reference and layout;
            draft surfaces never appear here.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <Input
            ref={searchRef}
            value={query}
            maxLength={240}
            placeholder="Search promoted surfaces"
            aria-label="Search promoted surfaces"
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="max-h-[min(48vh,24rem)] overflow-y-auto rounded-xl border p-2">
            {loading ? (
              <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" /> Loading promoted surfaces…
              </div>
            ) : loadError ? (
              <div role="alert" className="grid min-h-32 place-items-center gap-3 p-5 text-center text-sm text-destructive">
                <p>{loadError}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry
                </Button>
              </div>
            ) : surfaces.length === 0 ? (
              <div className="grid min-h-32 place-items-center p-5 text-center text-sm text-muted-foreground">
                <div><Layers3 className="mx-auto mb-2 h-7 w-7" />No promoted surfaces found.</div>
              </div>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="sr-only">Promoted surface</legend>
                {surfaces.map((surface) => (
                  <label
                    key={surface.id}
                    className={`min-h-12 cursor-pointer rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-galaxy-600 focus-within:ring-offset-2 ${selectedId === surface.id ? "border-galaxy-400 bg-galaxy-50 dark:bg-galaxy-950/30" : "border-transparent hover:bg-muted/60"}`}
                  >
                    <input
                      type="radio"
                      name="promoted-surface"
                      value={surface.id}
                      checked={selectedId === surface.id}
                      disabled={busy}
                      className="sr-only"
                      onChange={() => {
                        setSelectedId(surface.id)
                        onEdit()
                      }}
                    />
                    <span className="block font-medium">{surface.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      revision {surface.current_version} · {surface.current_content_hash.slice(0, 12)}…
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          {!loading && !loadError && surfaces.length === 200 ? (
            <p className="text-xs text-muted-foreground" role="status">
              Showing 200 matches. Refine the search to find older promoted surfaces.
            </p>
          ) : null}

          {placementError ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {placementError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || loading || !selectedVisible}>
              {busy ? "Placing…" : "Place promoted revision"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
