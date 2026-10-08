const SHA256 = /^[0-9a-f]{64}$/u
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SUMMARY_KEYS = new Set([
  "schemaId", "registrationId", "projectId", "repository", "commit", "tree",
  "environment", "conversionProfile", "manifestSha256", "proofGraphRef",
  "artifacts", "registeredByPrincipalId", "registeredByNostrPubkey",
  "registeredAt", "replayed",
])
const ARTIFACT_ROLES = Object.freeze([
  "formalGraph", "repositoryGraph", "authoredConceptualDag",
  "repositoryFieldDag", "correspondence",
])
export const FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT = 65_536

function invalid(message) {
  throw new TypeError(`Invalid formal project package response: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`)
  }
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) invalid(`${label}.${key} is required`)
  }
}

function text(value, maximum, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || Array.from(value).length > maximum) {
    invalid(`${label} is outside its bounded contract`)
  }
  return value
}

function digest(value, label) {
  const result = text(value, 64, label)
  if (!SHA256.test(result)) invalid(`${label} is invalid`)
  return result
}

function gitOid(value, label) {
  const result = text(value, 64, label)
  if (!GIT_OID.test(result)) invalid(`${label} is invalid`)
  return result
}

function timestamp(value, label) {
  const result = text(value, 80, label)
  if (!Number.isFinite(Date.parse(result))) invalid(`${label} must be an ISO timestamp`)
  return result
}

function normalizedArtifact(value, role) {
  const source = record(value, `summary.artifacts.${role}`)
  exactKeys(source, new Set(["materialized", "sha256"]), `summary.artifacts.${role}`)
  if (typeof source.materialized !== "boolean") {
    invalid(`summary.artifacts.${role}.materialized must be boolean`)
  }
  return Object.freeze({
    materialized: source.materialized,
    sha256: digest(source.sha256, `summary.artifacts.${role}.sha256`),
  })
}

/** Normalize and bind a registration response to the exact package reviewed by the caller. */
export function normalizeFormalProjectPackageSummary(value, expected) {
  const source = record(value, "summary")
  exactKeys(
    source,
    source.replayed === undefined ? new Set([...SUMMARY_KEYS].filter((key) => key !== "replayed")) : SUMMARY_KEYS,
    "summary",
  )
  if (source.schemaId !== "gb.formal-project-package.summary.v1") {
    invalid("summary.schemaId is unsupported")
  }
  if (source.conversionProfile !== "rosetta-authored-conceptual-dag-to-galaxy-repository-field.v1") {
    invalid("summary.conversionProfile is unsupported")
  }
  if (source.replayed !== undefined && source.replayed !== true) {
    invalid("summary.replayed must be true when present")
  }
  const environment = record(source.environment, "summary.environment")
  exactKeys(environment, new Set(["leanToolchain", "mathlibRevision"]), "summary.environment")
  const proofGraphRef = record(source.proofGraphRef, "summary.proofGraphRef")
  exactKeys(proofGraphRef, new Set(["graph_id", "content_sha256"]), "summary.proofGraphRef")
  const artifactsSource = record(source.artifacts, "summary.artifacts")
  exactKeys(artifactsSource, new Set(ARTIFACT_ROLES), "summary.artifacts")
  const artifacts = Object.freeze(Object.fromEntries(
    ARTIFACT_ROLES.map((role) => [role, normalizedArtifact(artifactsSource[role], role)]),
  ))
  const result = Object.freeze({
    schemaId: source.schemaId,
    registrationId: text(source.registrationId, 128, "summary.registrationId"),
    projectId: text(source.projectId, 512, "summary.projectId"),
    repository: text(source.repository, 500, "summary.repository"),
    commit: gitOid(source.commit, "summary.commit"),
    tree: gitOid(source.tree, "summary.tree"),
    environment: Object.freeze({
      leanToolchain: text(environment.leanToolchain, 200, "summary.environment.leanToolchain"),
      mathlibRevision: gitOid(environment.mathlibRevision, "summary.environment.mathlibRevision"),
    }),
    conversionProfile: source.conversionProfile,
    manifestSha256: digest(source.manifestSha256, "summary.manifestSha256"),
    proofGraphRef: Object.freeze({
      graphId: text(proofGraphRef.graph_id, 512, "summary.proofGraphRef.graph_id"),
      contentSha256: digest(
        proofGraphRef.content_sha256,
        "summary.proofGraphRef.content_sha256",
      ),
    }),
    artifacts,
    registeredByPrincipalId: text(
      source.registeredByPrincipalId,
      128,
      "summary.registeredByPrincipalId",
    ),
    registeredByNostrPubkey: text(
      source.registeredByNostrPubkey,
      128,
      "summary.registeredByNostrPubkey",
    ),
    registeredAt: timestamp(source.registeredAt, "summary.registeredAt"),
    ...(source.replayed === true ? { replayed: true } : {}),
  })

  const expectedGraphId = expected.repositoryFieldDag.graph_id
  const comparisons = [
    [result.projectId, expected.projectId, "projectId"],
    [result.repository, expected.repository, "repository"],
    [result.commit, expected.commit, "commit"],
    [result.tree, expected.tree, "tree"],
    [result.environment.leanToolchain, expected.environment.leanToolchain, "leanToolchain"],
    [result.environment.mathlibRevision, expected.environment.mathlibRevision, "mathlibRevision"],
    [result.manifestSha256, expected.manifestSha256, "manifestSha256"],
    [result.proofGraphRef.graphId, expectedGraphId, "proofGraphRef.graph_id"],
    [
      result.proofGraphRef.contentSha256,
      expected.repositoryFieldDagSha256,
      "proofGraphRef.content_sha256",
    ],
  ]
  for (const [actual, wanted, label] of comparisons) {
    if (actual !== wanted) invalid(`summary.${label} does not match the reviewed package`)
  }
  for (const role of ARTIFACT_ROLES) {
    if (artifacts[role].sha256 !== expected.artifacts[role].sha256) {
      invalid(`summary.artifacts.${role}.sha256 does not match the reviewed package`)
    }
  }
  if (!artifacts.authoredConceptualDag.materialized
    || !artifacts.repositoryFieldDag.materialized
    || !artifacts.correspondence.materialized
    || artifacts.formalGraph.materialized
    || artifacts.repositoryGraph.materialized) {
    invalid("summary.artifacts materialization state is invalid")
  }
  return result
}

/** Read one bounded JSON response without trusting upstream error text. */
export async function readFormalProjectPackageResponse(response) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT) {
    throw new TypeError("Formal project package response exceeds its byte bound")
  }
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > FORMAL_PROJECT_PACKAGE_RESPONSE_LIMIT) {
        await reader.cancel()
        throw new TypeError("Formal project package response exceeds its byte bound")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError("Formal project package response is not valid bounded JSON")
  }
}

/** Package-specific status copy; upstream detail is deliberately never surfaced. */
export function formalProjectPackageErrorMessage(status) {
  if (status === 401) return "Sign in before importing a formal project package."
  if (status === 403) return "A verified Nostr identity is required to import this package."
  if (status === 409) return "The immutable formal project package conflicts with an existing registration."
  if (status === 413) return "The formal project package exceeds the import byte limit."
  if (status === 415) return "The formal project package media type was not accepted."
  if (status === 422) return "The server rejected the package structure or cross-bindings."
  return "The formal project package import service is unavailable."
}
