"use client"

import { useEffect, useId, useState } from "react"
import { Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  searchHam,
  type HamSearchMode,
  type HamSearchResult,
  type HamTemporalMode,
} from "@/lib/ham-search-client"
import { summarizeHamSearchResult } from "@/lib/ham-search-summary.js"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (result: HamSearchResult) => void
  returnFocus?: HTMLElement | null
  selectionBusyId?: string | null
  selectionError?: string
  handoffFocus?: boolean
}

function localDateTimeValue(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function safeSearchError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return ""
  return error instanceof Error && error.message === "Unauthorized"
    ? "Sign in again to search HAM memory."
    : "HAM search is temporarily unavailable. Try again."
}

export function HAMSearchModal({
  open,
  onOpenChange,
  onSelect,
  returnFocus = null,
  selectionBusyId = null,
  selectionError = "",
  handoffFocus = false,
}: Props) {
  const queryId = useId()
  const statusId = useId()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<HamSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<HamSearchMode>("search")
  const [asOf, setAsOf] = useState(() => localDateTimeValue())
  const [temporalMode, setTemporalMode] = useState<HamTemporalMode>("valid_at")

  useEffect(() => {
    if (!open) return
    const normalizedQuery = query.trim()
    if (!normalizedQuery) {
      setResults([])
      setError(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const temporalAnchor = mode === "temporal" ? new Date(asOf) : null
      if (temporalAnchor && !Number.isFinite(temporalAnchor.getTime())) {
        setResults([])
        setError("Choose a valid temporal anchor.")
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      void searchHam({
        query: normalizedQuery,
        mode,
        topK: 10,
        ...(mode === "multihop" ? { maxHops: 2 } : {}),
        ...(temporalAnchor ? {
          asOf: temporalAnchor.toISOString(),
          temporalMode,
          includeHistory: true,
        } : {}),
      }, { signal: controller.signal })
        .then((nextResults) => setResults(nextResults))
        .catch((cause) => {
          const message = safeSearchError(cause)
          if (!message) return
          setResults([])
          setError(message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [asOf, mode, open, query, temporalMode])

  const status = selectionBusyId
    ? `Opening HAM memory ${selectionBusyId}…`
    : loading
      ? "Searching HAM memory…"
      : error || selectionError
        ? ""
        : query.trim()
          ? `${results.length} ${results.length === 1 ? "result" : "results"} found.`
          : "Type a query to search authorized HAM memory."

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[min(88dvh,760px)] max-w-[min(94vw,760px)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 [&>button]:size-11"
        onEscapeKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (handoffFocus) {
            event.preventDefault()
            return
          }
          if (!returnFocus?.isConnected) return
          event.preventDefault()
          returnFocus.focus()
        }}
      >
        <DialogHeader className="border-b px-5 pb-4 pt-5 pr-16 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" aria-hidden="true" />
            Search HAM memory
          </DialogTitle>
          <DialogDescription>
            Search the authorized tenant view, then open the canonical HAM record. Results are summaries, not Galaxy copies.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-b bg-muted/25 p-4">
          <div className="grid gap-1.5">
            <Label htmlFor={queryId}>Memory query</Label>
            <Input
              id={queryId}
              autoFocus
              type="search"
              className="min-h-11"
              maxLength={2_000}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-describedby={statusId}
              placeholder="Mechanism, decision, project, or evidence…"
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Search mode">
            {([
              ["search", "Search"],
              ["multihop", "Multi-hop"],
              ["temporal", "At time"],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={mode === value ? "default" : "outline"}
                className="min-h-11"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </div>
          {mode === "temporal" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={`${queryId}-temporal-mode`}>Temporal question</Label>
                <select
                  id={`${queryId}-temporal-mode`}
                  value={temporalMode}
                  onChange={(event) => setTemporalMode(event.target.value as HamTemporalMode)}
                  className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="valid_at">Claim valid at</option>
                  <option value="known_at">Known by</option>
                  <option value="event_before">Event before</option>
                  <option value="event_after">Event after</option>
                  <option value="event_near">Event near</option>
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${queryId}-temporal-anchor`}>Anchor</Label>
                <Input
                  id={`${queryId}-temporal-anchor`}
                  type="datetime-local"
                  className="min-h-11"
                  value={asOf}
                  onChange={(event) => setAsOf(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          <p id={statusId} className="min-h-5 text-xs text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
            {status}
          </p>
          {error || selectionError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              {selectionError || error}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 overflow-y-auto" aria-busy={loading || Boolean(selectionBusyId)}>
          {!error && !selectionError && results.length === 0 && query.trim() && !loading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No results found.</p>
          ) : null}
          <ul aria-label="HAM memory results" className="divide-y">
            {results.map((result) => {
              const summary = summarizeHamSearchResult(result)
              return (
                <li key={`${result.id}:${result.version ?? "latest"}`}>
                  <button
                    type="button"
                    className="min-h-14 w-full p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
                    disabled={Boolean(selectionBusyId)}
                    onClick={() => onSelect(result)}
                    aria-label={`Open canonical HAM memory ${result.id}: ${summary.title}`}
                  >
                    <span className="block font-semibold">{summary.title}</span>
                    {summary.snippet ? <span className="mt-1 block text-sm text-muted-foreground">{summary.snippet}</span> : null}
                    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">HAM #{result.id}</span>
                      {result.version ? <span>version {result.version}</span> : null}
                      {result.state ? <span>{result.state}</span> : null}
                      {result.hop ? <span>hop {result.hop}</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
