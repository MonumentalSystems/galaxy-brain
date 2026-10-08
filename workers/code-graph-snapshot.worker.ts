/// <reference lib="webworker" />

import {
  codeGraphRequestFromGalaxyObjectReference,
  type CodeGraphProvider,
  type CodeGraphRepositoryRef,
} from "../lib/code-graph-provider.js"
import {
  CodeGraphSnapshotImportError,
  openCodeGraphSnapshotProvider,
} from "../lib/code-graph-snapshot-import.js"
import { parseGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const SOURCE_NODE_LIMIT = 20_000
const SOURCE_EDGE_LIMIT = 80_000

type LoadedSession = Readonly<{
  key: string
  provider: CodeGraphProvider
  review: Awaited<ReturnType<typeof openCodeGraphSnapshotProvider>>["review"]
  tenantId: string
  authorityScope: string
}>

type WorkerRequest =
  | Readonly<{ id: number; kind: "load"; key: string; bytes: ArrayBuffer; tenantId: string; authorityScope: string }>
  | Readonly<{ id: number; kind: "neighbors"; key: string; reference: string | null; depth: number; limit: number }>

let session: LoadedSession | null = null
let loadGeneration = 0

type WorkerErrorCode = "over-cap" | "invalid-snapshot" | "selected-pin" | "session-stale" | "invalid-request"

class WorkerFailure extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(code)
  }
}

function loadFailure(error: unknown): WorkerFailure {
  return new WorkerFailure(
    error instanceof CodeGraphSnapshotImportError && error.code === "source-bound"
      ? "over-cap"
      : "invalid-snapshot",
  )
}

function workerFailureCode(error: unknown): WorkerErrorCode {
  return error instanceof WorkerFailure ? error.code : "invalid-request"
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    if (request.kind === "load") {
      const generation = ++loadGeneration
      let opened
      try {
        opened = await openCodeGraphSnapshotProvider(request.bytes, {
          maxNodes: SOURCE_NODE_LIMIT,
          maxEdges: SOURCE_EDGE_LIMIT,
        })
      } catch (error) {
        throw loadFailure(error)
      }
      if (generation !== loadGeneration) throw new WorkerFailure("session-stale")
      session = Object.freeze({
        key: request.key,
        provider: opened.provider,
        review: opened.review,
        tenantId: request.tenantId,
        authorityScope: request.authorityScope,
      })
      self.postMessage({ id: request.id, ok: true, kind: "loaded", review: opened.review })
      return
    }

    if (request.kind !== "neighbors") throw new WorkerFailure("invalid-request")
    if (!session || session.key !== request.key) throw new WorkerFailure("session-stale")
    const repositoryRef: CodeGraphRepositoryRef = {
      kind: "repository",
      repositoryId: session.review.repository.repositoryId,
    }
    const parsed = request.reference ? parseGalaxyObjectReference(request.reference) : null
    const selected = parsed
      ? codeGraphRequestFromGalaxyObjectReference(parsed, {
          tenantId: session.tenantId,
          authorityScope: session.authorityScope,
        })
      : {
          ref: repositoryRef,
          scope: {
            tenantId: session.tenantId,
            authorityScope: session.authorityScope,
            repository: {
              repositoryId: session.review.repository.repositoryId,
              commit: session.review.repository.commit,
              snapshotDigest: session.review.declaredSnapshotDigest,
            },
          },
        }
    if (!selected) throw new WorkerFailure("selected-pin")
    let neighborhood
    try {
      neighborhood = await session.provider.neighbors(
        selected.ref,
        selected.scope,
        request.depth,
        request.limit,
      )
    } catch {
      throw new WorkerFailure("selected-pin")
    }
    self.postMessage({ id: request.id, ok: true, kind: "neighbors", neighborhood })
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, errorCode: workerFailureCode(error) })
  }
})

export {}
