import "server-only"

import { readBoundedResponseText, ResponseBodyTooLargeError } from "@/lib/bounded-response.js"
import {
  HYADES_PROOF_TASK_BINDINGS_MAX_BYTES,
  parseHyadesProofTaskBindings,
  type ProofGraphRef,
} from "@/lib/hyades-proof-task-bindings-contract.js"
import { resolveHyadesProofTaskBindingsUrl } from "@/lib/hyades-proof-task-bindings-config.js"

export class HyadesTaskBindingsError extends Error {
  constructor(message: string, public readonly status: number) { super(message) }
}

function config(graphRef: ProofGraphRef) {
  const bearerToken = process.env.GALAXY_DEPLOY_HYADES_PROOF_TASK_BINDINGS_BEARER_TOKEN
    || process.env.HYADES_PROOF_TASK_BINDINGS_BEARER_TOKEN
  const url = resolveHyadesProofTaskBindingsUrl(process.env, graphRef)
  if (!url || !bearerToken) throw new HyadesTaskBindingsError("Hyades task binding read transport is not configured", 503)
  return { url, bearerToken }
}

export async function fetchHyadesProofTaskBindings(graphRef: ProofGraphRef) {
  const { url, bearerToken } = config(graphRef)
  let response: Response
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${bearerToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new HyadesTaskBindingsError("Hyades task binding projection is unavailable", 502)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HyadesTaskBindingsError("Hyades task binding projection request failed", response.status)
  }
  let text: string
  try {
    text = await readBoundedResponseText(response, HYADES_PROOF_TASK_BINDINGS_MAX_BYTES)
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new HyadesTaskBindingsError("Hyades task binding projection is too large", 502)
    }
    throw new HyadesTaskBindingsError("Hyades returned an invalid task binding projection", 502)
  }
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch {}
  try { return parseHyadesProofTaskBindings(body, graphRef) } catch {
    throw new HyadesTaskBindingsError("Hyades returned an invalid task binding projection", 502)
  }
}
