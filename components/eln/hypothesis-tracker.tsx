"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/components/ui/use-toast"
import { galaxyBrainAPI, type Hypothesis } from "@/lib/galaxy-brain-api"
import { NewHypothesisDialog } from "./new-hypothesis-dialog"

type HypothesisStatus = Hypothesis["status"]

function statusBadge(status: HypothesisStatus) {
  switch (status) {
    case "open":
      return <Badge variant="secondary" className="border border-[hsl(var(--research-cool)/0.45)] bg-[hsl(var(--research-cool)/0.12)] text-[hsl(var(--field-cool-strong))]">open</Badge>
    case "confirmed":
      return <Badge variant="secondary" className="border border-[hsl(var(--research-accent)/0.45)] bg-[hsl(var(--research-accent)/0.12)] text-primary">confirmed</Badge>
    case "refuted":
      return <Badge variant="secondary" className="border border-[hsl(var(--research-alert)/0.45)] bg-[hsl(var(--research-alert)/0.12)] text-[hsl(var(--field-alert-strong))]">refuted</Badge>
    case "superseded":
      return <Badge variant="secondary" className="border border-[var(--research-line)] bg-muted text-muted-foreground">superseded</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}

const STATUS_OPTIONS: HypothesisStatus[] = ["open", "confirmed", "refuted", "superseded"]

interface StatusDropdownProps {
  hypothesis: Hypothesis
  onUpdated: (updated: Hypothesis) => void
}

function StatusDropdown({ hypothesis, onUpdated }: StatusDropdownProps) {
  const [updating, setUpdating] = useState(false)

  const handleChange = async (status: HypothesisStatus) => {
    if (status === hypothesis.status) return
    setUpdating(true)
    try {
      const updated = await galaxyBrainAPI.updateHypothesis(hypothesis.id, { status })
      if (updated) {
        onUpdated(updated)
        toast({ title: "Status updated", description: `Hypothesis marked as ${status}.` })
      } else {
        toast({ title: "Update failed", variant: "destructive" })
      }
    } finally {
      setUpdating(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-h-8 items-center gap-1 rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={updating}
          aria-label="Change hypothesis status"
          aria-busy={updating}
        >
          {statusBadge(hypothesis.status)}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {STATUS_OPTIONS.map((s) => (
          <DropdownMenuItem
            key={s}
            className="capitalize"
            onClick={() => handleChange(s)}
          >
            {s}
            {s === hypothesis.status && (
              <span className="ml-auto text-xs text-muted-foreground">current</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function HypothesisTracker() {
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [newDialogOpen, setNewDialogOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    galaxyBrainAPI
      .getHypotheses()
      .then((data) => {
        if (data == null) {
          setError("Could not load hypotheses — is the backend running?")
        } else {
          setHypotheses(data)
        }
      })
      .catch(() => {
        setError("Could not load hypotheses — is the backend running?")
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleUpdated = (updated: Hypothesis) => {
    setHypotheses((prev) => prev.map((h) => (h.id === updated.id ? updated : h)))
  }

  return (
    <div className="space-y-4">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {loading ? "Loading hypotheses." : error ? "Hypotheses could not be loaded." : `${hypotheses.length} hypotheses loaded.`}
      </p>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setNewDialogOpen(true)}>
          + New Hypothesis
        </Button>
      </div>

      <div className="eln-table-scroll overflow-x-auto rounded-lg border border-[var(--research-line)]" role="region" tabIndex={0} aria-label="Hypothesis table" aria-busy={loading}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead>Claim</TableHead>
              <TableHead className="w-[140px]">Status</TableHead>
              <TableHead className="w-[120px]">Domain</TableHead>
              <TableHead className="w-[110px] text-right">Confidence</TableHead>
              <TableHead className="w-[130px] text-right">Supporting / Refuting</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {loading && (
              <>
                {[...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                  </TableRow>
                ))}
              </>
            )}

            {!loading && error && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12">
                  <p className="text-destructive mb-3">{error}</p>
                  <Button variant="outline" size="sm" onClick={load}>
                    Retry
                  </Button>
                </TableCell>
              </TableRow>
            )}

            {!loading && !error && hypotheses.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  No hypotheses tracked yet.
                </TableCell>
              </TableRow>
            )}

            {!loading && !error &&
              hypotheses.map((hyp) => (
                <TableRow key={hyp.id}>
                  <TableCell className="text-sm">
                    {hyp.claim.length > 100 ? hyp.claim.slice(0, 100) + "…" : hyp.claim}
                  </TableCell>
                  <TableCell>
                    <StatusDropdown hypothesis={hyp} onUpdated={handleUpdated} />
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground text-sm">
                    {hyp.domain || "general"}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {Math.round((hyp.confidence ?? 0) * 100)}%
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                    {(hyp.supporting_experiments?.length ?? 0)} /{" "}
                    {(hyp.refuting_experiments?.length ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      <NewHypothesisDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onCreated={load}
      />
    </div>
  )
}
