"use client"

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react"
import { FileJson, FlaskConical, Network, RefreshCw, Rocket } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ProofTaskGraph } from "@/components/tasks/proof-task-graph"
import { fillMissingProofCampaignSequenceIndexes } from "@/lib/proof-campaign-contract"
import {
  dispatchProofCampaign,
  fetchProofCampaignStatus,
  previewProofCampaign,
  type ProofCampaignDispatchReceipt,
  type ProofCampaignPreview,
  registerProofCampaign,
} from "@/lib/proof-campaign-client"
import {
  parseProofDag,
  parseProofTaskManifest,
  proofDagFromHamManifest,
  proofWorkStateFromHamTasks,
  projectProofTaskGraph,
  sha256Text,
} from "@/lib/proof-task-graph"
import type { TaskSummary } from "@/lib/types/tasks"

type ControllerStatus = {
  currentDirectiveSha256?: string
  currentDecision?: string
  currentTargets?: Array<{ packetId?: string; packet_id?: string; action?: string }>
  dispatches?: ProofCampaignDispatchReceipt[]
  registration?: { programId?: string; registeredAt?: string }
}

type CampaignPacket = {
  packet_id?: string
  title?: string
  objective?: string
  prerequisite_packet_ids?: string[]
  theorem_targets?: Array<{ target_id?: string; statement?: string; assumptions?: string[] }>
  mandatory_controls?: Array<{ control_id?: string; kind?: string; requirement?: string }>
}

function manifestFromText(text: string) {
  const value = jsonObjectFromText(text)
  if (value.schema_id !== "ham.audit-program.v3") throw new Error("Manifest must use ham.audit-program.v3")
  if (typeof value.program_id !== "string" || !value.program_id) throw new Error("Manifest needs a program_id")
  return fillMissingProofCampaignSequenceIndexes(value)
}

function jsonObjectFromText(text: string) {
  const value = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Proof artifact must be a JSON object")
  return value as Record<string, unknown>
}

function shortHash(value?: string) {
  return value ? `${value.slice(0, 12)}…${value.slice(-8)}` : "—"
}

function dispatchOutcomeError(receipt: ProofCampaignDispatchReceipt) {
  const unresolved = (receipt.tasks || [])
    .filter((task) => task.state !== "dispatched" && task.state !== "reused")
    .map((task) => `${task.packetId || "unknown packet"} (${task.state || "unknown"})`)
    .join(", ")
  const detail = unresolved ? ` Unresolved: ${unresolved}.` : ""
  if (receipt.state === "outcome_unknown") {
    return `Hyades could not determine whether every HAM task was created.${detail} Refresh and reconcile this exact directive before retrying.`
  }
  return `Hyades reported a ${receipt.state || "non-final"} dispatch.${detail} No complete-dispatch claim was recorded.`
}

export function ProofCampaignLauncher({
  configured,
  allowMutations,
  tasks,
}: {
  configured: boolean
  allowMutations: boolean
  tasks: TaskSummary[]
}) {
  const [manifestText, setManifestText] = useState("")
  const [preview, setPreview] = useState<ProofCampaignPreview | null>(null)
  const [controller, setController] = useState<ControllerStatus | null>(null)
  const [lastDispatch, setLastDispatch] = useState<ProofCampaignDispatchReceipt | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [artifactSha256, setArtifactSha256] = useState("")
  const previewRequestId = useRef(0)

  const programId = preview?.programId || controller?.registration?.programId || ""
  const currentDirectiveSha256 = controller?.currentDirectiveSha256 || preview?.directiveSha256 || ""
  const artifactView = useMemo(() => {
    try {
      return jsonObjectFromText(manifestText)
    } catch {
      return null
    }
  }, [manifestText])
  const artifactKind = artifactView?.schema_id === "galaxy.proof-dag.v1" ? "galaxy" : artifactView?.schema_id === "ham.audit-program.v3" ? "ham" : null
  const manifestView = artifactKind === "ham"
    ? artifactView as Record<string, unknown> & { packets?: CampaignPacket[] }
    : null
  const localManifest = useMemo(() => {
    try {
      return parseProofTaskManifest(manifestView)
    } catch {
      return null
    }
  }, [manifestView])
  useEffect(() => {
    let current = true
    setArtifactSha256("")
    if (artifactView && artifactKind) {
      void sha256Text(manifestText).then((digest) => {
        if (current) setArtifactSha256(digest)
      })
    }
    return () => { current = false }
  }, [artifactKind, artifactView, manifestText])
  const proofDag = useMemo(() => {
    if (!artifactSha256) return null
    try {
      if (localManifest) return proofDagFromHamManifest(localManifest, artifactSha256)
      if (artifactKind === "galaxy") return parseProofDag(artifactView, artifactSha256)
    } catch {}
    return null
  }, [artifactKind, artifactSha256, artifactView, localManifest])
  const workState = useMemo(() => proofDag ? proofWorkStateFromHamTasks(proofDag, tasks) : null, [proofDag, tasks])
  const proofGraph = useMemo(() => proofDag && workState ? projectProofTaskGraph(proofDag, workState) : null, [proofDag, workState])
  const availableNodes = useMemo(() => proofGraph?.nodes.filter((node) => node.state === "available") || [], [proofGraph])
  const readyTargets = useMemo(() => controller?.currentTargets?.map((target) => target.packetId || target.packet_id).filter(Boolean)
    || preview?.readyPacketIds || [], [controller, preview])
  const canDispatch = allowMutations && Boolean(controller?.registration)
    && controller?.currentDecision === "dispatch_frontier" && Boolean(currentDirectiveSha256)
  const currentDispatch = useMemo(() => {
    const matching = (controller?.dispatches || []).filter((dispatchReceipt) =>
      dispatchReceipt.directiveSha256 === currentDirectiveSha256)
    return matching[matching.length - 1]
      || (lastDispatch?.directiveSha256 === currentDirectiveSha256 ? lastDispatch : null)
  }, [controller, currentDirectiveSha256, lastDispatch])

  function resetDerived() {
    previewRequestId.current += 1
    setPreview(null)
    setController(null)
    setLastDispatch(null)
    setError("")
    setStatus("")
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    resetDerived()
    const requestId = previewRequestId.current
    setBusy("load")
    try {
      const text = await file.text()
      if (requestId !== previewRequestId.current) return
      setManifestText(text)
    } catch {
      if (requestId === previewRequestId.current) {
        setError("The campaign manifest file could not be read")
      }
    } finally {
      setBusy((current) => current === "load" ? "" : current)
    }
  }

  async function runPreview() {
    const requestId = ++previewRequestId.current
    setBusy("preview")
    setError("")
    setStatus("Validating with HAM's authoritative v3 compiler through Hyades.")
    try {
      const next = await previewProofCampaign(manifestFromText(manifestText))
      if (requestId !== previewRequestId.current) return
      setPreview(next)
      setController(null)
      setStatus("Preview compiled. Nothing was stored and no task was dispatched.")
    } catch (nextError) {
      if (requestId !== previewRequestId.current) return
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "Campaign preview failed")
    } finally {
      setBusy((current) => current === "preview" ? "" : current)
    }
  }

  async function loadController(program: string) {
    const next = await fetchProofCampaignStatus(program) as ControllerStatus
    setController(next)
    return next
  }

  async function refresh(program = programId) {
    if (!program) return
    setBusy("refresh")
    setError("")
    try {
      await loadController(program)
      setStatus("Durable Hyades controller state refreshed.")
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Campaign status refresh failed")
    } finally {
      setBusy("")
    }
  }

  async function register() {
    const requestId = previewRequestId.current
    setBusy("register")
    setError("")
    setStatus("Registering the exact immutable campaign. This does not dispatch tasks.")
    try {
      const manifest = manifestFromText(manifestText)
      await registerProofCampaign(manifest)
      if (requestId !== previewRequestId.current) {
        setStatus("")
        setError(`Campaign ${String(manifest.program_id)} was registered, but the displayed manifest changed. Preview it again before continuing.`)
        return
      }
      setStatus("Campaign registered. Its frontier is durable; dispatch still requires explicit confirmation.")
      try {
        await loadController(String(manifest.program_id))
      } catch (refreshError) {
        setError(`Campaign registered, but its controller could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "status refresh failed"}`)
      }
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "Campaign registration failed")
    } finally {
      setBusy("")
    }
  }

  async function dispatch() {
    setBusy("dispatch")
    setError("")
    setStatus("Authorizing the exact current frontier and materializing its HAM tasks.")
    try {
      const receipt = await dispatchProofCampaign(programId, currentDirectiveSha256)
      setLastDispatch(receipt)
      if (receipt.state === "dispatched") {
        setStatus(`Current frontier dispatched (${receipt.tasks?.length || 0} HAM tasks materialized or reused). HAM remains canonical for task claim and run state.`)
      } else {
        setStatus("")
        setError(dispatchOutcomeError(receipt))
      }
      try {
        await loadController(programId)
      } catch (refreshError) {
        setError((current) => `${current ? `${current} ` : ""}The dispatch receipt was preserved, but the controller could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "status refresh failed"}`)
      }
    } catch (nextError) {
      setStatus("")
      setError(nextError instanceof Error ? nextError.message : "Campaign dispatch failed")
    } finally {
      setBusy("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Network aria-hidden="true" /> Proof campaign graph</CardTitle>
        <CardDescription>
          Galaxy holds the proof structure; HAM holds claimable coordination tasks. Task completion never implies theorem verification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Label htmlFor="proof-campaign-manifest">Proof campaign artifact</Label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent">
              <FileJson className="size-4" aria-hidden="true" /> Load JSON
              <input className="sr-only" type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={loadFile} />
            </label>
          </div>
          <Textarea
            id="proof-campaign-manifest"
            className="min-h-48 font-mono text-xs"
            value={manifestText}
            placeholder="Paste or load galaxy.proof-dag.v1 (preferred) or ham.audit-program.v3"
            spellCheck={false}
            disabled={Boolean(busy)}
            onChange={(event) => { setManifestText(event.target.value); resetDerived() }}
          />
          <p className="text-xs text-muted-foreground">
            Galaxy DAGs render a read-only derived frontier. Production materialization only follows the authoritative HAM v3 compiler and Hyades controller path. Missing packet sequence indexes are assigned from document order before validation.
          </p>
        </div>

        {proofGraph ? (
          <>
            <ProofTaskGraph proofDag={proofDag!} workState={workState!} />
            <div className="rounded-xl border border-[#456c59]/25 bg-[#f3f0e4] p-3 text-sm text-[#294b3b]">
              <p><strong>{availableNodes.length}</strong> packet{availableNodes.length === 1 ? "" : "s"} currently appear available · {proofGraph.nodes.filter((node) => node.workItem?.work.taskId).length} linked to HAM</p>
              <p className="mt-2">
                This browser view never publishes its locally derived frontier. Convert the canonical DAG to HAM v3, then use the authoritative preview, registration, and exact-directive dispatch controls below.
              </p>
            </div>
          </>
        ) : manifestText.trim() ? (
          <p role="status" className="rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
            The graph appears after a valid campaign or mission DAG (or HAM v3 manifest) has unique targets, bounded fields, known prerequisites, and no dependency cycle. Passive repository fields remain reference-only.
          </p>
        ) : null}

        <details className="rounded-xl border bg-muted/20 p-4">
          <summary className="cursor-pointer font-medium">Advanced campaign compiler and Hyades controller</summary>
          {artifactKind === "galaxy" ? (
            <p className="mt-3 text-sm text-muted-foreground">This is the canonical Galaxy DAG. Use its converter-produced HAM v3 artifact only when registering or dispatching through the current Hyades controller.</p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={runPreview} disabled={artifactKind !== "ham" || !configured || !manifestText.trim() || Boolean(busy)}>
              <FlaskConical aria-hidden="true" /> {busy === "preview" ? "Compiling…" : "Preview campaign"}
            </Button>
            <Button type="button" onClick={register} disabled={artifactKind !== "ham" || !allowMutations || !preview || Boolean(busy)}>
              Register exact manifest
            </Button>
            <Button type="button" variant="outline" onClick={() => void refresh()} disabled={!programId || Boolean(busy)}>
              <RefreshCw className={busy === "refresh" ? "animate-spin" : ""} aria-hidden="true" /> Refresh controller
            </Button>
          </div>
        </details>

        {!configured ? (
          <p className="rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
            Server-only Hyades campaign control is not configured. The launcher is visible so the missing deployment gate is explicit; no request or credential is available to the browser.
          </p>
        ) : !allowMutations ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">Campaign mutations are disabled. You can compile and inspect a pure preview, but registration and dispatch remain gated.</p>
        ) : null}
        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</p>

        {preview ? (
          <section aria-labelledby="campaign-preview-heading" className="space-y-4 rounded-xl border p-4">
            <h3 id="campaign-preview-heading" className="font-semibold">Compiled preview</h3>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Program</dt><dd className="font-mono">{preview.programId}</dd></div>
              <div><dt className="text-muted-foreground">Decision</dt><dd>{preview.directive.decision || "—"}</dd></div>
              <div><dt className="text-muted-foreground">Program hash</dt><dd className="font-mono" title={preview.programSha256}>{shortHash(preview.programSha256)}</dd></div>
              <div><dt className="text-muted-foreground">Directive hash</dt><dd className="font-mono" title={preview.directiveSha256}>{shortHash(preview.directiveSha256)}</dd></div>
            </dl>
            <p className="mt-3 text-sm"><span className="text-muted-foreground">Initial frontier:</span> {preview.readyPacketIds.join(", ") || "none"}</p>
            <div>
              <h4 className="text-sm font-semibold">Mathematical packets</h4>
              <ol className="mt-2 grid gap-3 lg:grid-cols-2">
                {(manifestView?.packets || []).map((packet, index) => (
                  <li key={packet.packet_id || index} className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Packet {index + 1} · {packet.packet_id || "unnamed"}</p>
                    <h5 className="mt-1 font-semibold">{packet.title || "Untitled packet"}</h5>
                    <p className="mt-2 text-sm">{packet.objective}</p>
                    <p className="mt-2 text-xs text-muted-foreground">Depends on: {packet.prerequisite_packet_ids?.join(", ") || "initial frontier"}</p>
                    {packet.theorem_targets?.length ? (
                      <div className="mt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Frozen targets</p>
                        <ul className="mt-1 space-y-1 text-sm">
                          {packet.theorem_targets.map((target, targetIndex) => (
                            <li key={target.target_id || targetIndex}><span className="font-mono text-xs">{target.target_id}</span>: {target.statement}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {packet.mandatory_controls?.length ? (
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer font-medium">Controls ({packet.mandatory_controls.length})</summary>
                        <ul className="mt-2 space-y-1 text-muted-foreground">
                          {packet.mandatory_controls.map((control, controlIndex) => (
                            <li key={control.control_id || controlIndex}>{control.kind}: {control.requirement}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}

        {controller?.registration ? (
          <section aria-labelledby="campaign-controller-heading" className="rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 id="campaign-controller-heading" className="font-semibold">Durable controller</h3>
                <p className="mt-1 text-sm text-muted-foreground">Decision: {controller.currentDecision || "—"} · SHA {shortHash(controller.currentDirectiveSha256)}</p>
                <p className="mt-1 text-sm">Frontier: {readyTargets.join(", ") || "none"}</p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" disabled={!canDispatch || Boolean(busy)}><Rocket aria-hidden="true" /> Dispatch frontier</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Dispatch {programId}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This grants Hyades authority for the exact current directive and creates real HAM tasks for {readyTargets.join(", ") || "the current frontier"}. Agents still claim and run them with their own scoped identities.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void dispatch()}>Authorize exact frontier</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {currentDispatch ? (
              <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-sm">
                <p><span className="text-muted-foreground">Latest dispatch receipt:</span> <span className="font-medium">{currentDispatch.state || "unknown"}</span></p>
                <ul className="mt-2 space-y-1">
                  {(currentDispatch.tasks || []).map((task, index) => (
                    <li key={`${task.packetId || "packet"}-${index}`}>
                      <span className="font-mono text-xs">{task.packetId || "unknown packet"}</span>: {task.state || "unknown"}
                      {task.taskId ? <span className="text-muted-foreground"> · task {task.taskId}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
      </CardContent>
    </Card>
  )
}
