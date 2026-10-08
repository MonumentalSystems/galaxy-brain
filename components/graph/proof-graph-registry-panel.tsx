"use client"

import { Download, FileJson, Loader2, Network, Play, RefreshCw, ShieldCheck, Upload } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react"

import { ProofMissionSelector, type ProofMissionSelection } from "@/components/graph/proof-mission-selector"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { getCanonicalNostrRequestTarget, signNostrHttpRequest } from "@/lib/nostr-browser"
import {
  encodeProofMissionIntent,
  encodeProofMissionActivationRequest,
  normalizeProofMissionActivationResult,
  normalizeProofMissionCandidate,
  type ProofMissionActivationInput,
  type ProofMissionCandidate,
  type ProofMissionIntentInput,
} from "@/lib/proof-mission-contract-client.js"
import {
  PROOF_GRAPH_SELECTION_EVENT,
  normalizeProofGraphList,
  normalizeProofGraphSummary,
  normalizeProofVerificationSetList,
  normalizeProofWorkspaceList,
  encodeEmptyProofVerificationSet,
  proofGraphSelectionFromUrl,
  proofGraphSelectionUrl,
  proofRegistryErrorMessage,
  type ProofGraphSummary,
  type ProofWorkspaceSummary,
  type ProofVerificationSetSummary,
} from "@/lib/proof-graph-registry-client.js"
import { parseProofDag } from "@/lib/proof-task-graph.js"

const GRAPH_PAGE_SIZE = 50
const WORKSPACE_PAGE_SIZE = 50
const MAX_GRAPH_BYTES = 16_777_216
const SHA256 = /^[0-9a-f]{64}$/u

type Pending = "graphs" | "graph" | "workspaces" | "baselines" | "register"
  | "baseline-register" | "mission" | "activate" | "reconcile" | ""
type UrlSelection = { graphHash: string; workspaceId: string }

export interface ProofGraphRegistryPanelProps {
  className?: string
  onDiscardRiskChange?: (hasDiscardRisk: boolean) => void
  onMutationPendingChange?: (mutationPending: boolean) => void
}

function parseUrlSelection(): UrlSelection {
  return proofGraphSelectionFromUrl(window.location.href)
}

function publishUrlSelection(contentSha256: string | null, workspaceId: string | null = null) {
  const nextUrl = proofGraphSelectionUrl(
    window.location.href,
    contentSha256 ? { contentSha256, workspaceId } : null,
  )
  window.history.pushState(null, "", nextUrl)
  window.dispatchEvent(new CustomEvent(PROOF_GRAPH_SELECTION_EVENT, {
    detail: { contentSha256, workspaceId },
  }))
}

function replaceInvalidUrlSelection(contentSha256: string | null) {
  const nextUrl = proofGraphSelectionUrl(
    window.location.href,
    contentSha256 ? { contentSha256, workspaceId: null } : null,
  )
  window.history.replaceState(null, "", nextUrl)
  window.dispatchEvent(new CustomEvent(PROOF_GRAPH_SELECTION_EVENT, {
    detail: { contentSha256, workspaceId: null, normalizedByRegistryPanel: true },
  }))
}

function shortHash(value: string) { return `${value.slice(0, 10)}…${value.slice(-6)}` }

function responseBody(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>
}

async function requestJson(path: string, fallback: string, signal?: AbortSignal) {
  const response = await fetch(path, { cache: "no-store", signal })
  const body = await responseBody(response)
  if (!response.ok) throw new Error(proofRegistryErrorMessage(response.status, body, fallback))
  return body
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)), (byte) => (
    byte.toString(16).padStart(2, "0")
  )).join("")
}

function graphFromExactBytes(
  bytes: Uint8Array,
  contentSha256: string,
  graphIdHeader: string | null,
  graphKindHeader: string | null,
): { proofDag: Record<string, unknown>; summary: ProofGraphSummary } {
  const source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>
  const graphId = typeof source.graph_id === "string" ? source.graph_id : ""
  const graphKind = typeof source.graph_kind === "string" ? source.graph_kind : ""
  if (source.schema_id !== "galaxy.proof-dag.v1") {
    throw new Error("The exact proof graph uses an unsupported schema.")
  }
  let decodedHeaderId = ""
  try { decodedHeaderId = graphIdHeader ? decodeURIComponent(graphIdHeader) : "" } catch {}
  if (graphId !== decodedHeaderId || graphKind !== graphKindHeader) {
    throw new Error("The exact proof graph metadata did not match its registry headers.")
  }
  const summary = normalizeProofGraphSummary({
    schemaId: "gb.proof-graph.summary.v1",
    registrationId: `sha256:${contentSha256}`,
    graphId,
    graphKind,
    title: typeof source.title === "string" ? source.title : graphId,
    contentSha256,
    byteSize: bytes.byteLength,
    targetCount: Array.isArray(source.targets) ? source.targets.length : 0,
    relationCount: Array.isArray(source.relations) ? source.relations.length : 0,
    registeredByPrincipalId: "exact-revision",
    registeredByNostrPubkey: "exact-revision",
    registeredAt: new Date(0).toISOString(),
  })
  return { proofDag: source, summary }
}

export function ProofGraphRegistryPanel({
  className = "",
  onDiscardRiskChange,
  onMutationPendingChange,
}: ProofGraphRegistryPanelProps) {
  const syncGeneration = useRef(0)
  const missionCandidateGeneration = useRef(0)
  const graphsRef = useRef<ProofGraphSummary[]>([])
  const [graphs, setGraphs] = useState<ProofGraphSummary[]>([])
  const [graphNextOffset, setGraphNextOffset] = useState<number | null>(null)
  const [selectedHash, setSelectedHash] = useState("")
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("")
  const [selectedSummary, setSelectedSummary] = useState<ProofGraphSummary | null>(null)
  const [selectedProofDag, setSelectedProofDag] = useState<Record<string, unknown> | null>(null)
  const [workspaces, setWorkspaces] = useState<ProofWorkspaceSummary[]>([])
  const [workspaceNextOffset, setWorkspaceNextOffset] = useState<number | null>(null)
  const [verificationSets, setVerificationSets] = useState<ProofVerificationSetSummary[]>([])
  const [selectedVerificationHash, setSelectedVerificationHash] = useState("")
  const [activationWorkspaceId, setActivationWorkspaceId] = useState("")
  const [pending, setPending] = useState<Pending>("graphs")
  const [error, setError] = useState("")
  const [status, setStatus] = useState("Loading registered proof graphs.")
  const [importText, setImportText] = useState("")
  const [importBytes, setImportBytes] = useState<Uint8Array | null>(null)
  const [importName, setImportName] = useState("")
  const [missionCandidate, setMissionCandidate] = useState<{
    candidate: ProofMissionCandidate
    text: string
    input: ProofMissionIntentInput
  } | null>(null)
  const [missionDraftDiscardRisk, setMissionDraftDiscardRisk] = useState(false)

  const mutationPending = pending === "register"
    || pending === "baseline-register"
    || pending === "activate"
    || pending === "reconcile"
  const hasDiscardRisk = Boolean(
    importBytes?.byteLength
    || importText.trim()
    || missionCandidate
    || missionDraftDiscardRisk
    || pending === "mission",
  )

  useEffect(() => {
    onMutationPendingChange?.(mutationPending)
  }, [mutationPending, onMutationPendingChange])

  useEffect(() => {
    onDiscardRiskChange?.(hasDiscardRisk)
  }, [hasDiscardRisk, onDiscardRiskChange])

  useEffect(() => () => {
    onMutationPendingChange?.(false)
    onDiscardRiskChange?.(false)
  }, [onDiscardRiskChange, onMutationPendingChange])

  const selectedParsedProofDag = useMemo(() => {
    if (!selectedProofDag || !selectedHash || selectedSummary?.graphKind !== "repository-field") return null
    try {
      return parseProofDag(selectedProofDag, selectedHash)
    } catch {
      return null
    }
  }, [selectedHash, selectedProofDag, selectedSummary?.graphKind])

  const loadWorkspacePage = useCallback(async (
    summary: ProofGraphSummary,
    offset = 0,
    append = false,
    signal?: AbortSignal,
    expectedGeneration = syncGeneration.current,
  ) => {
    const isCurrent = () => !signal?.aborted && expectedGeneration === syncGeneration.current
    if (!isCurrent()) return
    if (summary.graphKind === "repository-field") {
      setWorkspaces([])
      setWorkspaceNextOffset(null)
      return
    }
    setPending("workspaces")
    const query = new URLSearchParams({
      graph_id: summary.graphId,
      content_sha256: summary.contentSha256,
      limit: String(WORKSPACE_PAGE_SIZE),
      offset: String(offset),
    })
    try {
      const body = await requestJson(`/api/eln/proof-workspaces?${query}`, "Proof workspaces could not be loaded.", signal)
      const page = normalizeProofWorkspaceList(body, summary)
      if (!isCurrent()) return
      setWorkspaces((current) => {
        const combined = append ? [...current, ...page.workspaces] : [...page.workspaces]
        return [...new Map(combined.map((workspace) => [workspace.workspaceId, workspace])).values()]
      })
      setWorkspaceNextOffset(page.nextOffset)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      if (!isCurrent()) return
      setError(cause instanceof Error ? cause.message : "Proof workspaces could not be loaded.")
    } finally {
      if (isCurrent()) setPending("")
    }
  }, [])

  const loadVerificationSets = useCallback(async (
    summary: ProofGraphSummary,
    preferredHash = "",
    signal?: AbortSignal,
    expectedGeneration = syncGeneration.current,
  ) => {
    const isCurrent = () => !signal?.aborted && expectedGeneration === syncGeneration.current
    if (!isCurrent()) return
    if (summary.graphKind !== "repository-field") {
      setVerificationSets([])
      setSelectedVerificationHash("")
      return
    }
    setPending("baselines")
    const query = new URLSearchParams({
      graph_content_sha256: summary.contentSha256,
      limit: "200",
      offset: "0",
    })
    try {
      const body = await requestJson(
        `/api/eln/proof-verification-sets?${query}`,
        "Proof verification baselines could not be loaded.",
        signal,
      )
      const page = normalizeProofVerificationSetList(body, summary)
      if (!isCurrent()) return
      setVerificationSets([...page.verificationSets])
      const empty = page.verificationSets.filter((item) => item.itemCount === 0)
      const selected = empty.find((item) => item.contentSha256 === preferredHash)
        || empty[0]
        || null
      setSelectedVerificationHash(selected?.contentSha256 || "")
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      if (!isCurrent()) return
      setVerificationSets([])
      setSelectedVerificationHash("")
      setError(cause instanceof Error ? cause.message : "Proof verification baselines could not be loaded.")
    } finally {
      if (isCurrent()) setPending("")
    }
  }, [])

  const resolveSelectedGraph = useCallback(async (
    selection: UrlSelection,
    knownGraphs: ProofGraphSummary[],
    signal?: AbortSignal,
  ) => {
    const generation = ++syncGeneration.current
    missionCandidateGeneration.current += 1
    setSelectedHash(selection.graphHash)
    setSelectedWorkspaceId(selection.workspaceId)
    setSelectedSummary(null)
    setSelectedProofDag(null)
    setMissionCandidate(null)
    setWorkspaces([])
    setWorkspaceNextOffset(null)
    setVerificationSets([])
    setSelectedVerificationHash("")
    setActivationWorkspaceId("")
    if (!selection.graphHash) {
      if (selection.workspaceId) replaceInvalidUrlSelection(null)
      setPending("")
      setStatus("No proof graph selected.")
      return false
    }
    if (!SHA256.test(selection.graphHash)) {
      setPending("")
      setError("The proofGraph URL parameter must be a lowercase SHA-256 digest.")
      setStatus("")
      return false
    }
    if (Array.from(selection.workspaceId).length > 512) {
      setPending("")
      setError("The proofWorkspace URL parameter exceeds 512 characters.")
      setStatus("")
      return false
    }
    setPending("graph")
    setError("")
    try {
      const listed = knownGraphs.find((graph) => graph.contentSha256 === selection.graphHash) || null
      const response = await fetch(`/api/eln/proof-graphs/${selection.graphHash}`, { cache: "no-store", signal })
      if (!response.ok) {
        const body = await responseBody(response)
        throw new Error(proofRegistryErrorMessage(response.status, body, "The pinned proof graph could not be loaded."))
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (await sha256(bytes) !== selection.graphHash
        || response.headers.get("X-Content-SHA256")?.toLowerCase() !== selection.graphHash) {
        throw new Error("The pinned proof graph did not match its registered content hash.")
      }
      const exact = graphFromExactBytes(
        bytes,
        selection.graphHash,
        response.headers.get("X-Proof-Graph-ID"),
        response.headers.get("X-Proof-Graph-Kind"),
      )
      // Exact registry metadata is not enough: parse the complete artifact now
      // so an invalid registered document fails visibly instead of merely
      // making the mission selector disappear.
      parseProofDag(exact.proofDag, selection.graphHash)
      if (listed && (listed.graphId !== exact.summary.graphId
        || listed.graphKind !== exact.summary.graphKind
        || listed.byteSize !== exact.summary.byteSize)) {
        throw new Error("The proof graph summary did not match its exact registered artifact.")
      }
      const summary = listed || exact.summary
      if (signal?.aborted || generation !== syncGeneration.current) return false
      setSelectedSummary(summary)
      setSelectedProofDag(exact.proofDag)
      if (summary.graphKind === "repository-field" && selection.workspaceId) {
        setSelectedWorkspaceId("")
        replaceInvalidUrlSelection(summary.contentSha256)
      }
      setStatus(summary.graphKind === "repository-field"
        ? "Passive repository field selected. It cannot create or activate a claimable frontier."
        : selection.workspaceId
          ? `Exact graph and workspace ${selection.workspaceId} are selected. Live state is loaded by the graph provider.`
          : "Immutable graph selected. Choose a workspace explicitly to activate coordination.")
      await loadVerificationSets(summary, "", signal, generation)
      await loadWorkspacePage(summary, 0, false, signal, generation)
      return !signal?.aborted && generation === syncGeneration.current
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return false
      if (generation !== syncGeneration.current) return false
      setError(cause instanceof Error ? cause.message : "The pinned proof graph could not be loaded.")
      setStatus("")
      return false
    } finally {
      if (!signal?.aborted && generation === syncGeneration.current) setPending("")
    }
  }, [loadVerificationSets, loadWorkspacePage])

  const loadGraphPage = useCallback(async (
    offset = 0,
    append = false,
    rehydrateSelection = false,
    signal?: AbortSignal,
  ) => {
    setPending("graphs")
    setError("")
    try {
      const body = await requestJson(
        `/api/eln/proof-graphs?limit=${GRAPH_PAGE_SIZE}&offset=${offset}`,
        "Registered proof graphs could not be loaded.",
        signal,
      )
      const page = normalizeProofGraphList(body)
      const combined = append
        ? [...new Map([...graphsRef.current, ...page.graphs].map((graph) => [graph.contentSha256, graph])).values()]
        : [...page.graphs]
      graphsRef.current = combined
      setGraphs(combined)
      setGraphNextOffset(page.nextOffset)
      setStatus(page.hasMore
        ? `${offset + page.graphs.length} graph revisions loaded. More are available.`
        : `${offset + page.graphs.length} graph revision${offset + page.graphs.length === 1 ? "" : "s"} loaded.`)
      if (rehydrateSelection || offset === 0) await resolveSelectedGraph(parseUrlSelection(), combined, signal)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return
      setError(cause instanceof Error ? cause.message : "Registered proof graphs could not be loaded.")
      setStatus("")
    } finally {
      if (!signal?.aborted) setPending("")
    }
  }, [resolveSelectedGraph])

  useEffect(() => {
    const controller = new AbortController()
    void loadGraphPage(0, false, true, controller.signal)
    return () => controller.abort()
  }, [loadGraphPage])

  useEffect(() => {
    let controller: AbortController | null = null
    const syncFromUrl = (event?: Event) => {
      if (event instanceof CustomEvent
        && (event.detail?.refresh === true || event.detail?.normalizedByRegistryPanel === true)) return
      controller?.abort()
      controller = new AbortController()
      try {
        void resolveSelectedGraph(parseUrlSelection(), graphsRef.current, controller.signal)
      } catch (cause) {
        setPending("")
        setStatus("")
        setError(cause instanceof Error ? cause.message : "The proof graph URL selection is invalid.")
      }
    }
    window.addEventListener("popstate", syncFromUrl)
    window.addEventListener(PROOF_GRAPH_SELECTION_EVENT, syncFromUrl)
    return () => {
      controller?.abort()
      window.removeEventListener("popstate", syncFromUrl)
      window.removeEventListener(PROOF_GRAPH_SELECTION_EVENT, syncFromUrl)
    }
  }, [resolveSelectedGraph])

  const refresh = async () => {
    await loadGraphPage(0, false, true)
    try {
      const selection = parseUrlSelection()
      window.dispatchEvent(new CustomEvent(PROOF_GRAPH_SELECTION_EVENT, {
        detail: {
          contentSha256: selection.graphHash || null,
          workspaceId: selection.workspaceId || null,
          refresh: true,
        },
      }))
    } catch (cause) {
      setStatus("")
      setError(cause instanceof Error ? cause.message : "The proof graph URL selection is invalid.")
    }
  }

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError("")
    if (file.size > MAX_GRAPH_BYTES) {
      setImportBytes(null)
      setImportText("")
      setError("Proof graph exceeds the 16 MiB registration limit.")
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const source = JSON.parse(text) as Record<string, unknown>
      const parsed = parseProofDag(source, await sha256(bytes))
      if (parsed.graphKind !== "repository-field") {
        throw new Error("Only passive repository-field proof DAGs can be registered directly. Derive missions from a registered passive source.")
      }
      setImportBytes(bytes)
      setImportText(text)
      setImportName(file.name)
      setStatus(`${file.name} is staged as ${bytes.byteLength.toLocaleString()} exact UTF-8 bytes.`)
    } catch (cause) {
      setImportBytes(null)
      setImportText("")
      setError(cause instanceof Error ? cause.message : "Choose a UTF-8 JSON proof DAG file.")
    }
  }

  const register = async () => {
    if (!importBytes?.byteLength) return
    setPending("register")
    setError("")
    setStatus("Requesting a fresh Nostr signature for these exact bytes.")
    try {
      const path = "/api/eln/proof-graphs"
      const signingUrl = await getCanonicalNostrRequestTarget(path)
      const authorization = await signNostrHttpRequest({ url: signingUrl, method: "POST", body: importBytes })
      const response = await fetch(path, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: importBytes.slice().buffer,
      })
      const body = await responseBody(response)
      if (!response.ok) {
        throw new Error(proofRegistryErrorMessage(response.status, body, "The proof graph could not be registered."))
      }
      const summary = normalizeProofGraphSummary(body)
      const next = [summary, ...graphsRef.current.filter((item) => item.contentSha256 !== summary.contentSha256)]
      graphsRef.current = next
      setGraphs(next)
      publishUrlSelection(summary.contentSha256, null)
      setStatus(summary.replayed
        ? "Those exact bytes were already registered. The immutable revision is selected passively."
        : "Immutable proof graph registered. Its exact revision is selected passively.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The proof graph could not be registered.")
      setStatus("")
    } finally {
      setPending("")
    }
  }

  const requestMissionCandidate = async (selection: ProofMissionSelection) => {
    if (!selectedSummary || selectedSummary.graphKind !== "repository-field") return
    const candidateGeneration = ++missionCandidateGeneration.current
    const graphGeneration = syncGeneration.current
    const expected: ProofMissionIntentInput = {
      sourceGraphId: selectedSummary.graphId,
      sourceContentSha256: selectedSummary.contentSha256,
      missionId: selection.missionId,
      mainTargetId: selection.mainTheoremId,
      milestoneTargetIds: [...selection.milestoneIds],
    }
    setError("")
    setMissionCandidate(null)
    setPending("mission")
    setStatus(`Asking Galaxy to derive inactive mission candidate ${selection.missionId} from the exact passive source.`)
    try {
      const { bytes: intentBytes } = encodeProofMissionIntent(expected)
      const response = await fetch(
        `/api/eln/proof-graphs/${selectedSummary.contentSha256}/mission-candidates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: intentBytes.slice().buffer,
        },
      )
      const body = await responseBody(response)
      if (!response.ok) {
        throw new Error(proofRegistryErrorMessage(
          response.status,
          body,
          "The inactive mission candidate could not be derived.",
        ))
      }
      const candidate = normalizeProofMissionCandidate(body, expected)
      parseProofDag(candidate.missionDag, candidate.missionContentSha256)
      if (candidateGeneration !== missionCandidateGeneration.current
        || graphGeneration !== syncGeneration.current) return
      setMissionCandidate({
        candidate,
        text: `${JSON.stringify(body, null, 2)}\n`,
        input: expected,
      })
      setActivationWorkspaceId(selection.missionId)
      setStatus(`Galaxy derived inactive mission candidate ${candidate.selection.missionId}. It has not been registered or activated.`)
    } catch (cause) {
      if (candidateGeneration !== missionCandidateGeneration.current
        || graphGeneration !== syncGeneration.current) return
      setMissionCandidate(null)
      setStatus("")
      setError(cause instanceof Error ? cause.message : "The inactive mission candidate could not be derived.")
    } finally {
      if (candidateGeneration === missionCandidateGeneration.current
        && graphGeneration === syncGeneration.current) setPending("")
    }
  }

  const invalidateMissionCandidate = useCallback(() => {
    missionCandidateGeneration.current += 1
    setMissionCandidate(null)
    setPending((current) => current === "mission" ? "" : current)
    setError("")
    setStatus("Mission selection changed. Confirm the current selection to request a new server-derived candidate.")
  }, [])

  const downloadMissionCandidate = () => {
    if (!missionCandidate) return
    const url = URL.createObjectURL(new Blob([missionCandidate.text], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${missionCandidate.candidate.selection.missionId}.galaxy-proof-mission-candidate.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const registerEmptyBaseline = async () => {
    if (!selectedSummary || selectedSummary.graphKind !== "repository-field") return
    const generation = syncGeneration.current
    setPending("baseline-register")
    setError("")
    setStatus("Requesting a fresh Nostr signature for an explicit zero-inheritance baseline.")
    try {
      const path = "/api/eln/proof-verification-sets"
      const { bytes } = encodeEmptyProofVerificationSet(selectedSummary)
      const signingUrl = await getCanonicalNostrRequestTarget(path)
      const authorization = await signNostrHttpRequest({
        url: signingUrl,
        method: "POST",
        body: bytes,
      })
      const response = await fetch(path, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: bytes.slice().buffer,
      })
      const body = await responseBody(response)
      if (!response.ok) {
        throw new Error(proofRegistryErrorMessage(
          response.status,
          body,
          "The empty proof verification baseline could not be registered.",
        ))
      }
      if (generation !== syncGeneration.current) return
      const registeredHash = body && typeof body === "object"
        && typeof (body as { contentSha256?: unknown }).contentSha256 === "string"
        ? (body as { contentSha256: string }).contentSha256
        : ""
      await loadVerificationSets(selectedSummary, registeredHash, undefined, generation)
      setStatus("Explicit empty baseline registered. It confers no inherited proof status.")
    } catch (cause) {
      if (generation !== syncGeneration.current) return
      setError(cause instanceof Error ? cause.message : "The empty baseline could not be registered.")
      setStatus("")
    } finally {
      if (generation === syncGeneration.current) setPending("")
    }
  }

  const activateMission = async () => {
    if (!selectedSummary || !missionCandidate || !selectedVerificationHash) return
    const baseline = verificationSets.find(
      (item) => item.contentSha256 === selectedVerificationHash,
    )
    if (!baseline || baseline.itemCount !== 0) {
      setError("PR17 activation requires an explicit empty verification baseline.")
      return
    }
    const generation = ++missionCandidateGeneration.current
    const graphGeneration = syncGeneration.current
    setPending("activate")
    setError("")
    setStatus("Requesting a fresh Nostr signature for this exact mission, baseline, and workspace.")
    try {
      const stableInput = {
        ...missionCandidate.input,
        expectedMissionContentSha256: missionCandidate.candidate.missionContentSha256,
        verificationSetContentSha256: selectedVerificationHash,
        workspaceId: activationWorkspaceId,
      }
      const idempotencyDigest = await sha256(new TextEncoder().encode(JSON.stringify(stableInput)))
      const activationInput: ProofMissionActivationInput = {
        ...stableInput,
        idempotencyKey: `activate-${idempotencyDigest}`,
      }
      const { bytes } = encodeProofMissionActivationRequest(activationInput)
      const path = `/api/eln/proof-graphs/${selectedSummary.contentSha256}/mission-activations`
      const signingUrl = await getCanonicalNostrRequestTarget(path)
      const authorization = await signNostrHttpRequest({
        url: signingUrl,
        method: "POST",
        body: bytes,
      })
      const response = await fetch(path, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: bytes.slice().buffer,
      })
      const body = await responseBody(response)
      if (!response.ok) {
        throw new Error(proofRegistryErrorMessage(
          response.status,
          body,
          "The proof mission could not be activated.",
        ))
      }
      const activated = normalizeProofMissionActivationResult(body, activationInput)
      if (generation !== missionCandidateGeneration.current
        || graphGeneration !== syncGeneration.current) return
      setStatus(activated.replayed
        ? `Mission ${activated.missionGraph.graphId} was already active; its exact workspace is selected.`
        : `Mission ${activated.missionGraph.graphId} is active with ${activated.initialFrontierNodeIds.length} available frontier nodes.`)
      publishUrlSelection(
        activated.missionGraph.contentSha256,
        activated.workspace.workspaceId,
      )
    } catch (cause) {
      if (generation !== missionCandidateGeneration.current
        || graphGeneration !== syncGeneration.current) return
      setError(cause instanceof Error ? cause.message : "The proof mission could not be activated.")
      setStatus("")
    } finally {
      if (generation === missionCandidateGeneration.current
        && graphGeneration === syncGeneration.current) setPending("")
    }
  }

  const reconcileHyadesTasks = async () => {
    if (!selectedSummary || !selectedWorkspaceId || selectedSummary.graphKind === "repository-field") return
    const selectedWorkspace = workspaces.find((workspace) => workspace.workspaceId === selectedWorkspaceId)
    if (!selectedWorkspace) {
      setError("Refresh the bounded workspace list before reconciling this pinned workspace.")
      return
    }
    const generation = syncGeneration.current
    setPending("reconcile")
    setError("")
    setStatus("Requesting a fresh signed Hyades reconciliation for the selected exact workspace.")
    try {
      const graphRef = {
        graph_id: selectedSummary.graphId,
        content_sha256: selectedSummary.contentSha256,
      }
      const stable = JSON.stringify([
        selectedWorkspaceId,
        graphRef.graph_id,
        graphRef.content_sha256,
        selectedWorkspace.version,
      ])
      const body = new TextEncoder().encode(JSON.stringify({
        schema_id: "gb.hyades-proof-task-binding-reconcile.v1",
        graph_ref: graphRef,
        expected_workspace_version: selectedWorkspace.version,
        idempotency_key: `hyades-reconcile-${await sha256(new TextEncoder().encode(stable))}`,
      }))
      const path = `/${["api", "proof-workspaces", encodeURIComponent(selectedWorkspaceId), "hyades-task-bindings", "reconcile"].join("/")}`
      const authorization = await signNostrHttpRequest({
        url: await getCanonicalNostrRequestTarget(path),
        method: "POST",
        body,
      })
      const response = await fetch(path, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: body.slice().buffer,
      })
      const result = await responseBody(response)
      if (!response.ok) {
        throw new Error(proofRegistryErrorMessage(
          response.status,
          result,
          "Hyades task bindings could not be refreshed.",
        ))
      }
      if (generation !== syncGeneration.current) return
      const summary = result && typeof result === "object" ? result as Record<string, unknown> : {}
      setStatus(
        `Hyades task bindings refreshed: ${Number(summary.applied_count || 0)} applied, ${Number(summary.replayed_count || 0)} already current.`,
      )
      await loadWorkspacePage(selectedSummary, 0, false, undefined, generation)
      window.dispatchEvent(new CustomEvent(PROOF_GRAPH_SELECTION_EVENT, {
        detail: { contentSha256: selectedSummary.contentSha256, workspaceId: selectedWorkspaceId, refresh: true },
      }))
    } catch (cause) {
      if (generation !== syncGeneration.current) return
      setError(cause instanceof Error ? cause.message : "Hyades task bindings could not be refreshed.")
      setStatus("")
    } finally {
      if (generation === syncGeneration.current) setPending("")
    }
  }

  const busy = pending !== ""
  const selectedOutsidePage = selectedHash && !graphs.some((graph) => graph.contentSha256 === selectedHash)
  const selectedWorkspaceOutsidePage = selectedWorkspaceId
    && !workspaces.some((workspace) => workspace.workspaceId === selectedWorkspaceId)

  return (
    <section className={`graph-surface rounded-2xl border p-4 ${className}`} aria-labelledby="proof-graph-registry-heading" aria-busy={busy}>
      <header className="graph-surface__header flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div>
          <p className="graph-surface__warning inline-flex rounded-full border px-2 py-1 font-sans text-[10px] font-semibold uppercase tracking-[.2em]">Proof atlas source</p>
          <h2 id="proof-graph-registry-heading" className="mt-1 flex items-center gap-2 font-serif text-lg font-semibold"><Network className="size-4" aria-hidden="true" /> Immutable proof graphs</h2>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw className={`size-4 ${pending === "graphs" ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh</Button>
      </header>

      <div className="mt-4 grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="proof-graph-revision">Immutable graph revision</Label>
          <select id="proof-graph-revision" className="graph-surface__control min-h-11 w-full rounded-lg border px-3 text-sm" value={selectedHash} disabled={pending === "graph"} onChange={(event) => publishUrlSelection(event.target.value || null, null)}>
            <option value="">No proof graph selected</option>
            {selectedOutsidePage ? <option value={selectedHash}>Pinned revision · {shortHash(selectedHash)}</option> : null}
            {graphs.map((graph) => <option key={graph.contentSha256} value={graph.contentSha256}>{graph.title} · {graph.graphKind} · {shortHash(graph.contentSha256)}</option>)}
          </select>
          {selectedOutsidePage ? <p className="graph-surface__muted text-xs" role="status">This exact URL-pinned revision is outside the bounded registry page; it was resolved directly by hash.</p> : null}
          {graphNextOffset !== null ? <Button type="button" size="sm" variant="ghost" className="justify-self-start" disabled={busy} onClick={() => void loadGraphPage(graphNextOffset, true)}>Load more graph revisions</Button> : null}
        </div>

        {selectedSummary ? <div className="graph-surface__card min-w-0 rounded-xl border p-3">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-serif font-semibold">{selectedSummary.title}</p><p className="graph-surface__muted mt-1 break-all font-mono text-[11px]" title={selectedSummary.contentSha256}>sha256:{shortHash(selectedSummary.contentSha256)}</p></div><span className="rounded-full border border-current/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">{selectedSummary.graphKind}</span></div>
          <p className="graph-surface__muted mt-2 text-xs">{selectedSummary.targetCount.toLocaleString()} targets · {selectedSummary.relationCount.toLocaleString()} relations · exact registered bytes</p>
        </div> : null}

        {selectedSummary?.graphKind === "repository-field" ? <div className="grid gap-4">
          <p className="graph-surface__warning rounded-xl border p-3 text-sm">Reference corpus only. Repository fields remain visible and traversable, but never become claimable frontiers.</p>
          {selectedParsedProofDag ? <ProofMissionSelector proofDag={selectedParsedProofDag} acknowledgedSelection={missionCandidate ? {
            missionId: missionCandidate.candidate.selection.missionId,
            mainTheoremId: missionCandidate.candidate.selection.mainTargetId,
            milestoneIds: missionCandidate.candidate.selection.milestoneTargetIds,
          } : null} onSelection={(selection) => { void requestMissionCandidate(selection) }} onDraftInvalidated={invalidateMissionCandidate} onDiscardRiskChange={setMissionDraftDiscardRisk} /> : null}
          <div className="graph-surface__card rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="flex items-center gap-2 font-serif font-semibold"><ShieldCheck className="size-4" aria-hidden="true" /> Immutable proof baseline</p><p className="graph-surface__muted mt-1 text-xs leading-5">Activation is bound to one exact baseline revision. PR17 deliberately accepts only a zero-inheritance baseline.</p></div>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void registerEmptyBaseline()}>{pending === "baseline-register" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />} Register empty baseline</Button>
            </div>
            <div className="mt-3 grid gap-1.5"><Label htmlFor="proof-verification-baseline">Exact baseline revision</Label><select id="proof-verification-baseline" className="graph-surface__control min-h-11 w-full rounded-lg border px-3 text-sm" value={selectedVerificationHash} disabled={busy} onChange={(event) => setSelectedVerificationHash(event.target.value)}><option value="">No accepted empty baseline</option>{verificationSets.map((item) => <option key={item.contentSha256} value={item.contentSha256} disabled={item.itemCount !== 0}>{item.itemCount === 0 ? "Empty baseline" : `${item.itemCount} verified nodes · not activatable yet`} · {shortHash(item.contentSha256)}</option>)}</select></div>
          </div>
          {missionCandidate ? <div className="graph-surface__warning rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><p className="font-serif font-semibold">Inactive server-derived mission candidate</p><p className="graph-surface__muted mt-1 text-xs">{missionCandidate.candidate.missionDag.targets.length.toLocaleString()} targets · {missionCandidate.candidate.missionDag.relations.length.toLocaleString()} relations · sha256:{shortHash(missionCandidate.candidate.missionContentSha256)}</p></div>
              <Button type="button" size="sm" variant="outline" onClick={downloadMissionCandidate}><Download className="size-4" aria-hidden="true" /> Download candidate</Button>
            </div>
            <p className="graph-surface__muted mt-3 text-xs leading-5">Galaxy rederived this candidate from the exact registered source. It remains inactive and non-registerable until a separate server-authoritative activation binds already-proven dependencies to accepted receipts.</p>
            <div className="mt-4 grid gap-3 border-t border-current/20 pt-4">
              <div className="grid gap-1.5"><Label htmlFor="proof-activation-workspace">Coordination workspace</Label><Input id="proof-activation-workspace" value={activationWorkspaceId} disabled={busy} maxLength={512} onChange={(event) => setActivationWorkspaceId(event.target.value)} /></div>
              <div className="flex flex-wrap items-center justify-between gap-3"><p className="graph-surface__muted max-w-xl text-xs leading-5">Explicit activation creates one mission graph and one coordination workspace atomically. It does not create HAM tasks, infer proof status, or mutate the passive source.</p><Button type="button" disabled={busy || !selectedVerificationHash || !activationWorkspaceId.trim()} onClick={() => void activateMission()}>{pending === "activate" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}{pending === "activate" ? "Activating…" : "Sign & activate mission"}</Button></div>
            </div>
          </div> : null}
        </div> : selectedSummary ? <div className="grid gap-1.5">
          <Label htmlFor="proof-workspace">Coordination overlay</Label>
          <select id="proof-workspace" className="graph-surface__control min-h-11 w-full rounded-lg border px-3 text-sm" value={selectedWorkspaceId} disabled={pending === "workspaces"} onChange={(event) => publishUrlSelection(selectedSummary.contentSha256, event.target.value || null)}>
            <option value="">None — keep this graph passive</option>
            {selectedWorkspaceOutsidePage ? <option value={selectedWorkspaceId}>Pinned workspace · {selectedWorkspaceId}</option> : null}
            {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.workspaceId} · v{workspace.version} · {workspace.itemCount} items</option>)}
          </select>
          <p className="graph-surface__muted text-xs">Galaxy never combines workspaces. Exactly one must be chosen to show live claims or runs.</p>
          <Button type="button" size="sm" variant="outline" className="justify-self-start" disabled={busy || !selectedWorkspaceId || Boolean(selectedWorkspaceOutsidePage)} onClick={() => void reconcileHyadesTasks()}>{pending === "reconcile" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}{pending === "reconcile" ? "Refreshing Hyades tasks…" : "Refresh Hyades tasks"}</Button>
          {workspaceNextOffset !== null ? <Button type="button" size="sm" variant="ghost" className="justify-self-start" disabled={busy} onClick={() => void loadWorkspacePage(selectedSummary, workspaceNextOffset, true)}>Load more workspaces</Button> : null}
        </div> : null}

        <details className="graph-surface__card rounded-xl border p-3"><summary className="graph-surface__focus cursor-pointer rounded-sm text-sm font-semibold">Register an exact Galaxy proof DAG</summary><div className="mt-3 grid gap-3">
          <label className="graph-surface__control flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 text-sm font-medium focus-within:outline focus-within:outline-2 focus-within:outline-offset-2"><FileJson className="size-4" aria-hidden="true" /> Choose JSON file<input className="sr-only" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void loadFile(event)} /></label>
          <div className="grid gap-1.5"><Label htmlFor="proof-graph-import">Exact UTF-8 JSON bytes</Label><Textarea id="proof-graph-import" className="graph-surface__control min-h-32 font-mono text-xs" value={importText} spellCheck={false} disabled={busy} placeholder="Paste galaxy.proof-dag.v1 or preserve exact bytes by choosing its JSON file." onChange={(event) => { setImportText(event.target.value); setImportBytes(new TextEncoder().encode(event.target.value)); setImportName("pasted JSON") }} /></div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><p className="graph-surface__muted min-w-0 break-all text-xs">{importBytes ? `${importName || "JSON"} · ${importBytes.byteLength.toLocaleString()} bytes` : "Nothing staged"}</p><Button type="button" size="sm" disabled={!importBytes?.byteLength || busy} onClick={() => void register()}>{pending === "register" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Upload className="size-4" aria-hidden="true" />}{pending === "register" ? "Registering…" : "Sign and register"}</Button></div>
          <p className="graph-surface__muted text-xs">Registration stores immutable structure only. It never creates a workspace, claim, run, mission frontier, or verification.</p>
        </div></details>
      </div>

      {error ? <p className="graph-surface__danger mt-3 break-words rounded-lg border p-3 text-sm [overflow-wrap:anywhere]" role="alert">{error}</p> : null}
      <p className="graph-surface__muted mt-3 min-h-5 break-words text-xs [overflow-wrap:anywhere]" role="status" aria-live="polite">{busy && <Loader2 className="mr-1 inline size-3 animate-spin" aria-hidden="true" />}{status}</p>
    </section>
  )
}
