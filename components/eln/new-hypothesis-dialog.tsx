"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/use-toast"
import { galaxyBrainAPI } from "@/lib/galaxy-brain-api"

const DOMAINS = [
  "general",
  "kuramoto",
  "gelation",
  "neurogenesis",
  "memory",
  "fusion",
  "corpus",
  "tokenization",
] as const

interface NewHypothesisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
}

export function NewHypothesisDialog({ open, onOpenChange, onCreated }: NewHypothesisDialogProps) {
  const [submitting, setSubmitting] = useState(false)

  const [claim, setClaim] = useState("")
  const [domain, setDomain] = useState("general")
  const [confidence, setConfidence] = useState(50)

  const handleClose = () => {
    if (submitting) return
    setClaim("")
    setDomain("general")
    setConfidence(50)
    onOpenChange(false)
  }

  const handleSubmit = async () => {
    if (!claim.trim()) {
      toast({ title: "Claim required", description: "Please enter a hypothesis claim.", variant: "destructive" })
      return
    }

    setSubmitting(true)
    try {
      const result = await galaxyBrainAPI.createHypothesis({
        claim: claim.trim(),
        domain,
        confidence: confidence / 100,
        status: "open",
      })

      if (!result) {
        toast({
          title: "Failed to create hypothesis",
          description: "Check that the Galaxy Brain API is running.",
          variant: "destructive",
        })
        return
      }

      toast({ title: "Hypothesis recorded", description: `Confidence: ${confidence}%` })
      onCreated?.()
      handleClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="research-workbench max-h-[calc(100dvh-2rem)] overflow-y-auto border-[var(--research-line)] bg-[hsl(var(--research-panel))] text-foreground sm:max-w-[440px]">
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {submitting ? "Recording hypothesis." : ""}
        </p>
        <DialogHeader>
          <DialogTitle className="research-display text-2xl font-semibold text-foreground">New Hypothesis</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Record a falsifiable claim to track across experiments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Claim */}
          <div className="space-y-1.5">
            <Label className="research-kicker text-primary" htmlFor="hyp-claim">
              Claim <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="hyp-claim"
              placeholder="State a clear, falsifiable claim..."
              className="research-control min-h-24 resize-y rounded-lg"
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              disabled={submitting}
            />
          </div>

          {/* Domain */}
          <div className="space-y-1.5">
            <Label className="research-kicker text-primary" htmlFor="hyp-domain">Domain</Label>
            <Select value={domain} onValueChange={setDomain} disabled={submitting}>
              <SelectTrigger id="hyp-domain" className="research-control h-11 rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d} className="capitalize">
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Confidence slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label id="hyp-confidence-label" className="research-kicker text-primary">Initial Confidence</Label>
              <span className="text-sm font-medium tabular-nums text-foreground">{confidence}%</span>
            </div>
            <Slider
              value={[confidence]}
              onValueChange={([v]) => setConfidence(v)}
              min={0}
              max={100}
              step={5}
              disabled={submitting}
              aria-labelledby="hyp-confidence-label"
              className="w-full"
            />
            <div className="flex justify-between gap-4 text-xs text-muted-foreground">
              <span>0% — speculative</span>
              <span>100% — certain</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11 rounded-lg border-[var(--research-line)] bg-transparent text-primary shadow-none hover:bg-secondary hover:text-foreground" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button className="min-h-11 rounded-lg border border-primary bg-primary px-4 text-primary-foreground shadow-none hover:bg-primary/90" onClick={handleSubmit} disabled={submitting || !claim.trim()} aria-busy={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Record Hypothesis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
