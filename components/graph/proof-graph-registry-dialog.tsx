"use client"

import { Network } from "lucide-react"
import { useCallback, useRef, useState } from "react"

import { ProofGraphRegistryPanel } from "@/components/graph/proof-graph-registry-panel"
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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export type ProofGraphRegistryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProofGraphRegistryDialog({ open, onOpenChange }: ProofGraphRegistryDialogProps) {
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const [discardRisk, setDiscardRisk] = useState(false)
  const [mutationPending, setMutationPending] = useState(false)
  const [closeWarning, setCloseWarning] = useState<"discard" | "mutation" | null>(null)

  const requestOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true)
      return
    }
    if (mutationPending) {
      setCloseWarning("mutation")
      return
    }
    if (discardRisk) {
      setCloseWarning("discard")
      return
    }
    onOpenChange(false)
  }, [discardRisk, mutationPending, onOpenChange])

  return (
    <>
      <Dialog open={open} onOpenChange={requestOpenChange}>
        <DialogTrigger asChild>
          <Button className="min-h-11 w-full justify-start gap-3 sm:w-auto" variant="outline">
            <Network className="h-4 w-4" aria-hidden="true" />
            Proof sources and coordination
          </Button>
        </DialogTrigger>
        <DialogContent
          className="research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[min(96vw,1600px)] overflow-x-hidden overflow-y-auto p-3 sm:max-h-[94vh] sm:p-5"
          onInteractOutside={(event) => {
            if (closeWarning) event.preventDefault()
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            titleRef.current?.focus({ preventScroll: true })
          }}
        >
          <DialogHeader className="pr-10 text-left">
            <DialogTitle
              ref={titleRef}
              tabIndex={-1}
              className="rounded-sm font-serif text-2xl tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Proof sources and coordination
            </DialogTitle>
            <DialogDescription className="graph-surface__muted">
              Select an exact immutable proof graph and, for active missions only, one hash-bound work-state overlay.
              Passive repository fields remain traversable and never become claimable automatically.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <ProofGraphRegistryPanel
              className="shadow-none"
              onDiscardRiskChange={setDiscardRisk}
              onMutationPendingChange={setMutationPending}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={closeWarning !== null} onOpenChange={(nextOpen) => {
        if (!nextOpen) setCloseWarning(null)
      }}>
        <AlertDialogContent
          className="research-workbench max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-lg overflow-x-hidden overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (open) titleRef.current?.focus({ preventScroll: true })
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {closeWarning === "mutation"
                ? "Close while the signed request is unresolved?"
                : "Discard staged proof-registry work?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="graph-surface__muted">
              {closeWarning === "mutation"
                ? "The request cannot be cancelled safely and may still complete after this window closes. Reopen the proof registry to recheck the authoritative server state before retrying."
                : "Closing now discards the selected file, pasted bytes, mission-selection draft, or inactive mission candidate. Registered graphs and URL-pinned selections are unchanged."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="atlas-command-presenter__danger-action"
              onClick={() => {
                if (closeWarning === "discard") setDiscardRisk(false)
                setCloseWarning(null)
                onOpenChange(false)
              }}
            >
              {closeWarning === "mutation" ? "Close and recheck later" : "Discard staged work"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
