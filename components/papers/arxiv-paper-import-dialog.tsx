"use client"

import { Database, LoaderCircle, Search } from "lucide-react"
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
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"
import {
  exactArxivVersionedId,
  searchExactArxivPapers,
} from "@/lib/paper-arxiv-acquisition.js"
import type { PaperImportPlacementRecovery } from "@/lib/paper-import-placement-recovery.js"
import type { ArxivPaperMetadata } from "@/lib/types/papers"

export type ArxivPaperImportPhase = "idle" | "acquiring" | "placing"

type ArxivPaperImportDialogProps = {
  open: boolean
  phase: ArxivPaperImportPhase
  error: string
  acquired: PaperImportPlacementRecovery | null
  onOpenChange: (open: boolean) => void
  onAcquire: (selection: ArxivPaperMetadata) => void
  onRetryPlacement: () => void
  onEdit: () => void
  returnFocus: HTMLElement | null
}

function resultKey(result: ArxivPaperMetadata) {
  return exactArxivVersionedId(result)
}

export function ArxivPaperImportDialog({
  open,
  phase,
  error,
  acquired,
  onOpenChange,
  onAcquire,
  onRetryPlacement,
  onEdit,
  returnFocus,
}: ArxivPaperImportDialogProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<readonly ArxivPaperMetadata[]>([])
  const [selectedKey, setSelectedKey] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchStatus, setSearchStatus] = useState("")
  const [searchError, setSearchError] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const searchGenerationRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const busy = phase !== "idle"

  useEffect(() => {
    if (open) return
    searchGenerationRef.current += 1
    searchAbortRef.current?.abort()
    searchAbortRef.current = null
    setSearching(false)
    setSearchError("")
    setSearchStatus("")
    setResults([])
    setSelectedKey("")
  }, [open])

  useEffect(() => () => {
    searchGenerationRef.current += 1
    searchAbortRef.current?.abort()
  }, [])

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (searching || busy || acquired) return
    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    searchAbortRef.current?.abort()
    const abortController = new AbortController()
    searchAbortRef.current = abortController
    setSearching(true)
    setSearchError("")
    setSearchStatus("Searching arXiv metadata…")
    try {
      const response = await searchExactArxivPapers(galaxyBrainAPI, query, 10, abortController.signal)
      if (searchGenerationRef.current !== generation || !open) return
      setResults(response.results)
      setSelectedKey(response.results[0] ? resultKey(response.results[0]) : "")
      setSearchStatus(response.results.length
        ? `Found ${response.total.toLocaleString()} matches; showing ${response.results.length}.`
        : "No arXiv papers matched this search.")
    } catch (nextError) {
      if (abortController.signal.aborted) return
      if (searchGenerationRef.current !== generation || !open) return
      setResults([])
      setSelectedKey("")
      setSearchStatus("")
      setSearchError(nextError instanceof Error ? nextError.message : "arXiv search is temporarily unavailable.")
    } finally {
      if (searchGenerationRef.current === generation) setSearching(false)
      if (searchAbortRef.current === abortController) searchAbortRef.current = null
    }
  }

  function submitSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (acquired) {
      onRetryPlacement()
      return
    }
    const selected = results.find((result) => resultKey(result) === selectedKey)
    if (!selected) {
      setSearchError("Choose one exact arXiv revision to save and place.")
      return
    }
    setSearchError("")
    onAcquire(selected)
  }

  const phaseStatus = phase === "acquiring"
    ? "Importing exact metadata and privately preserving this exact PDF revision."
    : phase === "placing"
      ? "The exact PDF is durable. Placing its pinned document revision on the original Atlas canvas."
      : ""

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
        closeDisabled={busy}
        onOpenAutoFocus={(event) => {
          if (acquired) return
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
          <DialogTitle className="research-display text-2xl">Find an arXiv paper</DialogTitle>
          <DialogDescription>
            Choose an exact version. Galaxy imports its metadata, privately preserves the server-fetched
            PDF, and places only the pinned durable document on this Atlas.
          </DialogDescription>
        </DialogHeader>

        {acquired ? (
          <form className="grid gap-4" onSubmit={submitSelection}>
            <div className="rounded-xl border border-[#93a48e]/45 bg-[#edf1e7] p-4 text-[#18372b]">
              <div className="flex items-start gap-3">
                <Database className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-semibold">{acquired.title}</p>
                  <p className="mt-1 text-xs text-[#61766b]">
                    {`${acquired.arxiv_id}v${acquired.arxiv_version}`} · exact private PDF · {(acquired.durableDocument.byte_size / 1_000_000).toFixed(1)} MB
                  </p>
                  {phase === "idle" ? (
                    <a
                      className="mt-3 inline-block text-sm font-semibold underline underline-offset-4"
                      href={`/documents/${encodeURIComponent(acquired.durableDocument.revision_id)}`}
                    >
                      Open exact document revision
                    </a>
                  ) : null}
                </div>
              </div>
            </div>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Keep without placing
              </Button>
              <Button type="submit" disabled={busy}>
                {phase === "placing" ? "Placing…" : "Retry placement only"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <form role="search" className="flex gap-2" onSubmit={search}>
              <label htmlFor="atlas-arxiv-paper-query" className="sr-only">Search arXiv</label>
              <Input
                ref={searchRef}
                id="atlas-arxiv-paper-query"
                type="search"
                value={query}
                minLength={2}
                maxLength={300}
                disabled={busy || searching}
                placeholder="Title, author, abstract, or arXiv ID"
                aria-describedby="atlas-arxiv-paper-search-status"
                onChange={(event) => {
                  setQuery(event.target.value)
                  setSearchError("")
                  onEdit()
                }}
              />
              <Button type="submit" disabled={busy || searching || query.trim().length < 2}>
                {searching ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="mr-2 h-4 w-4" aria-hidden="true" />}
                Search
              </Button>
            </form>

            <form className="grid gap-4" onSubmit={submitSelection}>
              <div className="max-h-[min(48vh,24rem)] overflow-y-auto rounded-xl border p-2">
                {results.length ? (
                  <fieldset className="grid gap-2">
                    <legend className="sr-only">Exact arXiv revision</legend>
                    {results.map((result) => {
                      const key = resultKey(result)
                      return (
                        <label
                          key={key}
                          className={`min-h-12 cursor-pointer rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-galaxy-600 focus-within:ring-offset-2 ${selectedKey === key ? "border-galaxy-400 bg-galaxy-50 dark:bg-galaxy-950/30" : "border-transparent hover:bg-muted/60"}`}
                        >
                          <input
                            type="radio"
                            name="arxiv-paper-revision"
                            value={key}
                            checked={selectedKey === key}
                            disabled={busy}
                            className="sr-only"
                            onChange={() => {
                              setSelectedKey(key)
                              setSearchError("")
                              onEdit()
                            }}
                          />
                          <span className="block font-medium">{result.title}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {key} · {result.authors.slice(0, 3).map((author) => author.name).join(", ")}
                          </span>
                        </label>
                      )
                    })}
                  </fieldset>
                ) : (
                  <div className="grid min-h-32 place-items-center p-5 text-center text-sm text-muted-foreground">
                    Search arXiv to choose an exact paper revision.
                  </div>
                )}
              </div>
              {searchError || error ? (
                <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {searchError || error}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button type="submit" disabled={busy || !selectedKey}>
                  {phase === "acquiring" ? "Saving exact PDF…" : "Save and place exact PDF"}
                </Button>
              </DialogFooter>
            </form>
          </div>
        )}

        <p id="atlas-arxiv-paper-search-status" className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {phaseStatus || searchStatus}
        </p>
      </DialogContent>
    </Dialog>
  )
}
