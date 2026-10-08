/// <reference lib="webworker" />

import { parseFormalProjectPackage } from "@/lib/formal-project-package.js"
import { encodeFormalProjectPackageEnvelope } from "@/lib/formal-project-package-envelope.js"

type FileRole = "manifestBytes" | "authoredConceptualDagBytes"
  | "repositoryFieldDagBytes" | "correspondenceBytes"
type ExactBuffers = Record<FileRole, ArrayBuffer>
type PackageRequest = { requestId: number; files: ExactBuffers }

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : "The four files do not form a valid package."
  return Array.from(message).length <= 500
    ? message
    : "The four files do not form a valid package."
}

self.addEventListener("message", async (event: MessageEvent<PackageRequest>) => {
  const requestId = event.data?.requestId
  const files = event.data?.files
  if (!files) return
  try {
    const input = {
      manifestBytes: new Uint8Array(files.manifestBytes),
      authoredConceptualDagBytes: new Uint8Array(files.authoredConceptualDagBytes),
      repositoryFieldDagBytes: new Uint8Array(files.repositoryFieldDagBytes),
      correspondenceBytes: new Uint8Array(files.correspondenceBytes),
    }
    const parsed = await parseFormalProjectPackage(input)
    const envelopeBytes = encodeFormalProjectPackageEnvelope(input)
    const envelope = envelopeBytes.buffer as ArrayBuffer
    self.postMessage({
      requestId,
      ok: true,
      envelope,
      review: {
        projectId: parsed.projectId,
        repository: parsed.repository,
        commit: parsed.commit,
        tree: parsed.tree,
        environment: parsed.environment,
        manifestSha256: parsed.manifestSha256,
        repositoryFieldDagSha256: parsed.repositoryFieldDagSha256,
        repositoryFieldDag: { graph_id: parsed.repositoryFieldDag.graph_id },
        artifacts: parsed.artifacts,
      },
    }, [envelope])
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: boundedError(error) })
  }
})

export {}
