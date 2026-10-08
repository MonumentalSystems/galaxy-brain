import { NextRequest, NextResponse } from "next/server"

import { getCurrentUser } from "@/lib/auth"
import { readBoundedRequestBody, RequestBodyTooLargeError } from "@/lib/bounded-multipart.js"
import { mapWithBoundedConcurrency } from "@/lib/bounded-work-pool.js"
import { fetchHamTask, HamTaskProxyError } from "@/lib/ham-task-proxy"
import { projectHamTaskDetailForBrowser } from "@/lib/ham-task-browser-projection.js"
import {
  assertExactHamTaskBinding,
  assertExactHamTaskAssignment,
  parseHyadesTaskBindingReconcileRequest,
  type HyadesTaskBinding,
  type ProofGraphRef,
} from "@/lib/hyades-proof-task-bindings-contract.js"
import {
  fetchHyadesProofTaskBindings,
  HyadesTaskBindingsError,
} from "@/lib/hyades-proof-task-bindings-client"
import { getVerifiedNostrRequestIdentity } from "@/lib/request-identity"

const INTERNAL_GALAXY_API = process.env.GALAXY_API_INTERNAL || "http://localhost:8044"
const MAX_BODY_BYTES = 16_384
const HAM_TASK_CORROBORATION_CONCURRENCY = 8

type RouteContext = { params: Promise<{ workspaceId: string }> }
type WorkState = {
  schema_id: "galaxy.proof-work-state.v1"
  workspace_id: string
  graph_ref: ProofGraphRef
  version: number
  items: Array<{
    node_id: string
    version: number
    external?: { hyades_task_binding?: HyadesTaskBinding }
  }>
  replayed?: true
}

class ReconcileError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

async function readBoundedBody(request: NextRequest) {
  if (!request.body) return new Uint8Array()
  try {
    return new Uint8Array(await readBoundedRequestBody(request.body, MAX_BODY_BYTES))
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new ReconcileError("Request body is too large", 413)
    }
    throw error
  }
}

function internalHeaders(identity: {
  tenantId: string; principalId: string; kind: string; nostrPubkey: string | null
}) {
  const proxyToken = process.env.GALAXY_API_PROXY_TOKEN
  if (!proxyToken) throw new ReconcileError("Galaxy proof work transport is not configured", 503)
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-GB-Proxy-Token": proxyToken,
    "X-GB-Tenant-ID": identity.tenantId,
    "X-GB-Principal-ID": identity.principalId,
    "X-GB-Principal-Kind": identity.kind,
  })
  if (identity.nostrPubkey) headers.set("X-GB-Nostr-Pubkey", identity.nostrPubkey)
  return headers
}

function assertWorkState(value: unknown, workspaceId: string, graphRef: ProofGraphRef): WorkState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReconcileError("Galaxy returned invalid proof work state", 502)
  const state = value as Partial<WorkState>
  if (state.schema_id !== "galaxy.proof-work-state.v1" || state.workspace_id !== workspaceId
    || !state.graph_ref || state.graph_ref.graph_id !== graphRef.graph_id
    || state.graph_ref.content_sha256 !== graphRef.content_sha256
    || !Number.isSafeInteger(state.version) || !Array.isArray(state.items)) {
    throw new ReconcileError("Galaxy returned mismatched proof work state", 502)
  }
  for (const item of state.items) {
    if (!item || typeof item !== "object" || typeof item.node_id !== "string"
      || !Number.isSafeInteger(item.version) || item.version < 0) {
      throw new ReconcileError("Galaxy returned invalid proof work items", 502)
    }
  }
  return state as WorkState
}

async function galaxyRequest(
  path: string,
  identity: Parameters<typeof internalHeaders>[0],
  init?: { method: "POST"; body: unknown },
) {
  let response: Response
  try {
    response = await fetch(new URL(path, INTERNAL_GALAXY_API), {
      method: init?.method || "GET",
      headers: internalHeaders(identity),
      body: init ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ReconcileError("Galaxy proof work service is unavailable", 502)
  }
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) throw new ReconcileError("Galaxy proof work request failed", response.status)
  return body
}

async function loadWorkspace(
  workspaceId: string,
  graphRef: ProofGraphRef,
  identity: Parameters<typeof internalHeaders>[0],
) {
  const query = new URLSearchParams({
    graph_id: graphRef.graph_id,
    content_sha256: graphRef.content_sha256,
  })
  const body = await galaxyRequest(
    `/proof-workspaces/${encodeURIComponent(workspaceId)}?${query}`,
    identity,
  )
  return assertWorkState(body, workspaceId, graphRef)
}

function itemVersion(state: WorkState, nodeId: string) {
  return state.items.find((item) => item.node_id === nodeId)?.version || 0
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await getCurrentUser()
    if (!user || user.authMethod !== "nostr" || !user.nostrPubkey) {
      return NextResponse.json({ error: "A signed-in Nostr user is required" }, { status: 401 })
    }
    const bytes = await readBoundedBody(request)
    const identity = await getVerifiedNostrRequestIdentity(request, bytes)
    if (!identity || identity.kind !== "human" || identity.principalId !== user.principalId
      || identity.tenantId !== user.tenantId || identity.nostrPubkey !== user.nostrPubkey) {
      return NextResponse.json({ error: "A fresh body-bound Nostr signature is required" }, { status: 401 })
    }
    let input: ReturnType<typeof parseHyadesTaskBindingReconcileRequest>
    try { input = parseHyadesTaskBindingReconcileRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) } catch {
      return NextResponse.json({ error: "The reconciliation request is invalid" }, { status: 422 })
    }
    const { workspaceId } = await context.params
    if (!workspaceId || Array.from(workspaceId).length > 512) {
      return NextResponse.json({ error: "workspaceId is invalid" }, { status: 422 })
    }

    let state = await loadWorkspace(workspaceId, input.graph_ref, identity)
    if (state.version !== input.expected_workspace_version) {
      return NextResponse.json({ error: "Proof work expected_workspace_version is stale" }, { status: 409 })
    }
    const projection = await fetchHyadesProofTaskBindings(input.graph_ref)

    // Validate every external task before opening the local mutation sequence.
    await mapWithBoundedConcurrency(
      projection.bindings,
      HAM_TASK_CORROBORATION_CONCURRENCY,
      async (binding, _index, signal) => {
        const rawTask = await fetchHamTask("detail", {
          user,
          taskId: binding.task_id,
          signal,
        })
        const task = projectHamTaskDetailForBrowser(rawTask)
        try {
          assertExactHamTaskAssignment(rawTask, binding)
          assertExactHamTaskBinding(task, binding)
        } catch {
          throw new ReconcileError("HAM task binding could not be verified", 502)
        }
      },
    )

    const bulk = await galaxyRequest(
      `/proof-workspaces/${encodeURIComponent(workspaceId)}/coordination-task-bindings/bulk`,
      identity,
      {
        method: "POST",
        body: {
          graph_ref: input.graph_ref,
          expected_version: input.expected_workspace_version,
          bindings: projection.bindings.map((binding) => ({
            node_id: binding.packet_id,
            expected_item_version: itemVersion(state, binding.packet_id),
            binding,
          })),
          idempotency_key: input.idempotency_key,
        },
      },
    )
    state = assertWorkState(bulk, workspaceId, input.graph_ref)
    const counts = bulk as { applied_count?: unknown; replayed_count?: unknown }
    if (!Number.isSafeInteger(counts.applied_count) || !Number.isSafeInteger(counts.replayed_count)
      || Number(counts.applied_count) < 0 || Number(counts.replayed_count) < 0
      || Number(counts.applied_count) + Number(counts.replayed_count) !== projection.bindings.length) {
      throw new ReconcileError("Galaxy returned invalid reconciliation counts", 502)
    }
    return NextResponse.json({
      schema_id: "gb.hyades-proof-task-binding-reconcile-result.v1",
      workspace_id: workspaceId,
      graph_ref: input.graph_ref,
      projection_sha256: projection.projection_sha256,
      workspace_version: state.version,
      binding_count: projection.bindings.length,
      applied_count: counts.applied_count,
      replayed_count: counts.replayed_count,
    })
  } catch (error) {
    if (error instanceof HyadesTaskBindingsError || error instanceof HamTaskProxyError || error instanceof ReconcileError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: "Proof task reconciliation failed" }, { status: 500 })
  }
}
