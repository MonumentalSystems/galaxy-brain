"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, FlaskConical, Plus, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { galaxyBrainAPI, type Experiment } from "@/lib/galaxy-brain-api"

const DOMAINS = ["all", "general", "kuramoto", "gelation", "neurogenesis", "memory", "fusion", "corpus", "tokenization"] as const

type StatusFilter = "all" | "hypothesis" | "running" | "complete" | "abandoned"

const statusSymbols: Record<Experiment["status"], string> = {
  hypothesis: "◇",
  running: "●",
  complete: "✓",
  abandoned: "×",
}

function statusBadge(status: Experiment["status"]) {
  const classes = {
    hypothesis: "border-[hsl(var(--research-cool)/0.45)] bg-[hsl(var(--research-cool)/0.12)] text-[hsl(var(--field-cool-strong))]",
    running: "border-[hsl(var(--research-warm)/0.5)] bg-[hsl(var(--research-warm)/0.14)] text-[hsl(var(--field-warm-strong))]",
    complete: "border-[hsl(var(--research-accent)/0.45)] bg-[hsl(var(--research-accent)/0.12)] text-primary",
    abandoned: "border-[hsl(var(--research-alert)/0.45)] bg-[hsl(var(--research-alert)/0.12)] text-[hsl(var(--field-alert-strong))]",
  }[status]

  return (
    <Badge variant="outline" className={`rounded-md font-normal ${classes}`}>
      <span aria-hidden="true">{statusSymbols[status]}</span>
      <span className="capitalize">{status}</span>
    </Badge>
  )
}

function relativeTime(iso: string): string {
  const deltaSeconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second")
  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute")
  const deltaHours = Math.round(deltaMinutes / 60)
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour")
  const deltaDays = Math.round(deltaHours / 24)
  if (Math.abs(deltaDays) < 30) return formatter.format(deltaDays, "day")
  return formatter.format(Math.round(deltaDays / 30), "month")
}

interface ExperimentBrowserProps {
  refreshKey?: number
  onCreate?: () => void
}

export function ExperimentBrowser({ refreshKey = 0, onCreate }: ExperimentBrowserProps) {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [domainFilter, setDomainFilter] = useState("all")
  const [search, setSearch] = useState("")

  const loadExperiments = useCallback(() => {
    setLoading(true)
    setError(null)
    galaxyBrainAPI
      .getExperiments()
      .then((data) => {
        if (data == null) {
          setError("The ELN service did not return a record index. Check the service connection and try again.")
        } else {
          setExperiments(data)
        }
      })
      .catch(() => {
        setError("The ELN service could not be reached. Check the service connection and try again.")
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadExperiments()
  }, [loadExperiments, refreshKey])

  const filtered = experiments.filter((experiment) => {
    if (statusFilter !== "all" && experiment.status !== statusFilter) return false
    if (domainFilter !== "all" && experiment.domain !== domainFilter) return false
    if (!search.trim()) return true
    const query = search.toLocaleLowerCase()
    return (
      experiment.title.toLocaleLowerCase().includes(query)
      || experiment.hypothesis?.toLocaleLowerCase().includes(query)
      || experiment.domain?.toLocaleLowerCase().includes(query)
    )
  })

  return (
    <div className="space-y-4">
      <div className="research-panel flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center">
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
          <SelectTrigger className="research-control h-11 w-full rounded-lg sm:w-[164px]" aria-label="Filter research records by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="hypothesis">Hypothesis</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="complete">Complete</SelectItem>
            <SelectItem value="abandoned">Abandoned</SelectItem>
          </SelectContent>
        </Select>

        <Select value={domainFilter} onValueChange={setDomainFilter}>
          <SelectTrigger className="research-control h-11 w-full rounded-lg sm:w-[164px]" aria-label="Filter research records by domain">
            <SelectValue placeholder="Domain" />
          </SelectTrigger>
          <SelectContent>
            {DOMAINS.map((domain) => (
              <SelectItem key={domain} value={domain} className="capitalize">
                {domain === "all" ? "All domains" : domain}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            name="record-search"
            autoComplete="off"
            placeholder="Search records…"
            aria-label="Search research records"
            className="research-control h-11 rounded-lg pl-9 placeholder:text-muted-foreground/70"
          />
        </div>
      </div>

      <section className="research-panel overflow-hidden rounded-xl border" aria-labelledby="record-catalogue-heading" aria-busy={loading}>
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {loading ? "Loading research records." : error ? "" : `${filtered.length} research records shown.`}
        </p>
        <header className="flex flex-col gap-2 border-b border-[var(--research-line)] bg-secondary px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="research-kicker">Medium Scale · Compact Blocks</p>
            <h3 id="record-catalogue-heading" className="research-display mt-1 text-xl font-semibold text-foreground">Research Record Catalogue</h3>
          </div>
          {!loading && !error && (
            <p className="font-mono text-[11px] text-muted-foreground">
              {filtered.length.toLocaleString()} of {experiments.length.toLocaleString()} records
            </p>
          )}
        </header>

        {loading && (
          <div className="divide-y divide-border" aria-label="Loading research records">
            {[...Array(5)].map((_, index) => (
              <div key={index} className="grid gap-3 px-5 py-5 sm:grid-cols-[2rem_minmax(0,1fr)_10rem]">
                <Skeleton className="h-7 w-7 rounded-full bg-secondary" />
                <div>
                  <Skeleton className="h-5 w-56 bg-secondary" />
                  <Skeleton className="mt-3 h-4 w-full bg-muted" />
                </div>
                <Skeleton className="h-5 w-24 bg-muted" />
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="px-5 py-12 text-center">
            <p className="research-display text-xl font-semibold text-destructive">Research records could not be loaded</p>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" className="research-control mt-5" onClick={loadExperiments}>
              Try Again
            </Button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="px-5 py-14 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-[var(--research-line)] bg-secondary text-primary">
              <FlaskConical className="h-5 w-5" aria-hidden="true" />
            </div>
            <h3 className="research-display mt-4 text-xl font-semibold text-foreground">
              {experiments.length === 0 ? "Begin the First Research Record" : "No Records Match This View"}
            </h3>
            <p className="research-prose mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              {experiments.length === 0
                ? "Capture a hypothesis, protocol, observations, evidence, and conclusions in one versioned object."
                : "Adjust the status, domain, or search query to widen the catalogue."}
            </p>
            {experiments.length === 0 && onCreate && (
              <Button onClick={onCreate} className="mt-5 bg-primary text-primary-foreground hover:bg-primary/90">
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Research Record
              </Button>
            )}
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <ol className="divide-y divide-border">
            {filtered.map((experiment, index) => (
              <li key={experiment.id}>
                <Link
                  href={`/eln/experiment/${encodeURIComponent(experiment.id)}`}
                  className="research-object-row group grid min-h-28 gap-3 px-5 py-5 focus-visible:outline-none sm:grid-cols-[2.5rem_minmax(0,1fr)_9rem_7rem] sm:items-center"
                >
                  <div className="flex items-center gap-3 sm:block">
                    <span className="research-display block text-2xl text-primary" aria-hidden="true">{statusSymbols[experiment.status]}</span>
                    <span className="font-mono text-[10px] text-muted-foreground sm:mt-1 sm:block">{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div className="min-w-0">
                    <h4 className="research-display flex items-center gap-2 text-lg font-semibold text-foreground group-hover:text-primary">
                      <span className="truncate">{experiment.title}</span>
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none" aria-hidden="true" />
                    </h4>
                    <p className="research-prose mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">
                      {experiment.hypothesis || "No hypothesis recorded yet."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 sm:block">
                    {statusBadge(experiment.status)}
                    <p className="mt-1 text-xs capitalize text-muted-foreground">{experiment.domain || "general"}</p>
                  </div>
                  <time dateTime={experiment.updated_at || undefined} className="font-mono text-[10px] tabular-nums text-muted-foreground sm:text-right">
                    {experiment.updated_at ? relativeTime(experiment.updated_at) : "Not updated"}
                  </time>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
