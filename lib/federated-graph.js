const FEDERATED_OBJECT_KINDS = new Set([
  "paper",
  "document",
  "document.anchor",
  "code.repo",
  "code.commit",
  "code.file",
  "code.symbol",
  "code.graph",
  "proof.graph",
  "proof.node",
  "ham.memory",
])

const TRUST_CLASSES = new Set([
  "deterministic_structure",
  "authored_assertion",
  "verified_proof",
  "semantic_candidate",
])

const SEMANTIC_KIND_BY_OBJECT_KIND = Object.freeze({
  paper: "paper",
  document: "document",
  "document.anchor": "document-anchor",
  "code.repo": "code-repository",
  "code.commit": "code-commit",
  "code.file": "code-file",
  "code.symbol": "code-symbol",
  "code.graph": "code-graph",
  "proof.graph": "proof-graph",
  "proof.node": "proof-node",
  "ham.memory": "memory",
})

const RELATION_KINDS = new Set([
  "contains",
  "depends_on",
  "defines",
  "imports",
  "calls",
  "extends",
  "implements",
  "verifies",
  "related",
  "cites",
  "part_of",
  "derived_from",
  "context_for",
  "formalized_by",
  "defined_in",
  "documents",
  "corresponds_to",
  "references",
  "supports",
  "near",
  "supersedes",
  "superseded_by",
  "contradicts",
  "verified_by",
  "cited_by",
  "required_by",
])

const TRUST_PRIORITY = Object.freeze({
  verified_proof: 0,
  deterministic_structure: 1,
  authored_assertion: 2,
  semantic_candidate: 3,
})

const DEFAULT_LIMITS = Object.freeze({ maxNodes: 120, maxEdges: 240, maxFanout: 16 })
const HARD_LIMITS = Object.freeze({ maxNodes: 250, maxEdges: 500, maxFanout: 32 })
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

function boundedText(value, maximum) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized && normalized.length <= maximum && !CONTROL_CHARACTERS.test(normalized)
    ? normalized
    : null
}

function boundedLimit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
}

function decodeCanonicalComponent(value, maximum) {
  try {
    const decoded = decodeURIComponent(value)
    if (!boundedText(decoded, maximum) || encodeURIComponent(decoded) !== value) return null
    return decoded
  } catch {
    return null
  }
}

/**
 * Validate the small canonical-reference surface required by the browser
 * projector. Authorization and referent resolution remain provider concerns.
 */
function parseFederatedReference(value) {
  if (typeof value !== "string" || value.length > 16_384 || !value.startsWith("gb:object:v1:")) return null
  const segments = value.slice("gb:object:v1:".length).split(":")
  if (segments.length !== 3 && segments.length !== 4) return null
  const [kind, encodedId, mode, encodedRevision] = segments
  if (!FEDERATED_OBJECT_KINDS.has(kind)) return null
  const id = decodeCanonicalComponent(encodedId, 512)
  if (!id) return null
  if (mode === "latest" && segments.length === 3) return { ref: value, kind, id, revision: null }
  if (mode !== "pinned" || segments.length !== 4) return null
  const revision = decodeCanonicalComponent(encodedRevision, 256)
  return revision ? { ref: value, kind, id, revision } : null
}

function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const provider = boundedText(value.provider, 80)
  const recordId = value.recordId === undefined ? undefined : boundedText(value.recordId, 256)
  const revision = value.revision === undefined ? undefined : boundedText(value.revision, 256)
  if (!provider || (value.recordId !== undefined && !recordId) || (value.revision !== undefined && !revision)) return null
  return { provider, ...(recordId ? { recordId } : {}), ...(revision ? { revision } : {}) }
}

function sourceKey(source) {
  return `${source.provider}\u0000${source.recordId ?? ""}\u0000${source.revision ?? ""}`
}

function entityId(reference) {
  // References are already canonical and bounded. Encoding keeps ':' and other
  // selector punctuation from becoming accidental application identifiers.
  return `federated:${encodeURIComponent(reference)}`
}

function normalizeNode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const reference = parseFederatedReference(value.ref)
  const title = boundedText(value.title, 160)
  const detail = value.detail === undefined ? "" : boundedText(value.detail, 500)
  const source = normalizeSource(value.source)
  const happenedAt = value.happenedAt === undefined ? "" : boundedText(value.happenedAt, 100)
  if (!reference || !title || detail === null || !source || happenedAt === null) return null
  return { reference, title, detail, source, happenedAt }
}

function normalizeVerification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "verified") return null
  const method = boundedText(value.method, 80)
  const evidenceRef = boundedText(value.evidenceRef, 1_024)
  return method && evidenceRef ? { status: "verified", method, evidenceRef } : null
}

function normalizeEdge(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const from = parseFederatedReference(value.fromRef)
  const to = parseFederatedReference(value.toRef)
  const relation = boundedText(value.relation, 80)
  const basis = boundedText(value.basis, 40)
  const source = normalizeSource(value.source)
  if (!from || !to || from.ref === to.ref || !relation || !RELATION_KINDS.has(relation) || !basis || !TRUST_CLASSES.has(basis) || !source) {
    return null
  }

  const verification = normalizeVerification(value.verification)
  if (basis === "verified_proof" && !verification) return null

  // A retrieval score can surface a candidate, but cannot turn `supports` or
  // `verifies` into proof evidence. Preserve the provider's term separately
  // while rendering every semantic candidate as proximity.
  const projectedRelation = basis === "semantic_candidate" ? "near" : relation
  const sourceRelation = projectedRelation === relation ? undefined : relation
  return {
    fromRef: from.ref,
    toRef: to.ref,
    relation: projectedRelation,
    ...(sourceRelation ? { sourceRelation } : {}),
    basis,
    source,
    ...(verification ? { verification } : {}),
    inputIndex: index,
  }
}

function normalizeLedgerLink(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const basis = value.basis === "authored"
    ? "authored_assertion"
    : value.basis === "imported" || value.basis === "derived"
      ? "deterministic_structure"
      : null
  const provenance = value.provenance && typeof value.provenance === "object" && !Array.isArray(value.provenance)
    ? value.provenance
    : null
  const sourceSystem = provenance?.source_system === undefined
    ? undefined
    : boundedText(provenance.source_system, 80)
  const provider = sourceSystem ?? (provenance ? boundedText(provenance.source, 80) : null)
  const revision = provenance?.source_snapshot === undefined
    ? undefined
    : boundedText(provenance.source_snapshot, 256)
  const recordId = value.id === undefined ? undefined : boundedText(String(value.id), 256)
  if (
    !basis || !provider || (provenance?.source_system !== undefined && !sourceSystem)
    || (value.id !== undefined && !recordId)
    || (provenance?.source_snapshot !== undefined && !revision)
  ) return null
  return normalizeEdge({
    fromRef: value.from_ref,
    toRef: value.to_ref,
    relation: value.relation,
    basis,
    source: {
      provider: `ledger:${provider}`,
      ...(recordId ? { recordId } : {}),
      ...(revision ? { revision } : {}),
    },
  }, index)
}

function compareEdges(left, right) {
  return TRUST_PRIORITY[left.basis] - TRUST_PRIORITY[right.basis]
    || left.fromRef.localeCompare(right.fromRef)
    || left.toRef.localeCompare(right.toRef)
    || left.relation.localeCompare(right.relation)
    || sourceKey(left.source).localeCompare(sourceKey(right.source))
    || left.inputIndex - right.inputIndex
}

function edgeId(edge) {
  return [
    "federated-edge",
    edge.basis,
    edge.relation,
    encodeURIComponent(edge.fromRef),
    encodeURIComponent(edge.toRef),
    encodeURIComponent(sourceKey(edge.source)),
  ].join(":")
}

/**
 * Project already-authorized provider results and ledger assertions into the
 * Semantic Field contract. This is deliberately a bounded presentation step;
 * it does not resolve references or broaden access.
 *
 * @param {unknown} input
 * @param {unknown} [options]
 */
export function projectFederatedGraph(input, options = {}) {
  const settings = options && typeof options === "object" && !Array.isArray(options) ? options : {}
  const limits = {
    maxNodes: boundedLimit(settings.maxNodes, DEFAULT_LIMITS.maxNodes, HARD_LIMITS.maxNodes),
    maxEdges: boundedLimit(settings.maxEdges, DEFAULT_LIMITS.maxEdges, HARD_LIMITS.maxEdges),
    maxFanout: boundedLimit(settings.maxFanout, DEFAULT_LIMITS.maxFanout, HARD_LIMITS.maxFanout),
  }
  const rawNodes = input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.nodes)
    ? input.nodes
    : []
  const rawEdges = input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.edges)
    ? input.edges
    : []
  const rawLinks = input && typeof input === "object" && !Array.isArray(input) && Array.isArray(input.links)
    ? input.links
    : []

  const byReference = new Map()
  let rejectedNodes = 0
  let nodeLimitReached = false
  for (const value of rawNodes) {
    const node = normalizeNode(value)
    if (!node) {
      rejectedNodes += 1
      continue
    }
    const existing = byReference.get(node.reference.ref)
    if (existing) {
      if (!existing.sourceKeys.has(sourceKey(node.source))) {
        existing.sourceKeys.add(sourceKey(node.source))
        existing.sources.push(node.source)
      }
      continue
    }
    if (byReference.size >= limits.maxNodes) {
      nodeLimitReached = true
      continue
    }
    byReference.set(node.reference.ref, {
      ...node,
      sources: [node.source],
      sourceKeys: new Set([sourceKey(node.source)]),
    })
  }

  const relationCandidates = []
  let rejectedEdges = 0
  rawEdges.forEach((value, index) => {
    const edge = normalizeEdge(value, index)
    if (!edge || !byReference.has(edge.fromRef) || !byReference.has(edge.toRef)) {
      rejectedEdges += 1
      return
    }
    relationCandidates.push(edge)
  })
  rawLinks.forEach((value, index) => {
    const edge = normalizeLedgerLink(value, rawEdges.length + index)
    if (!edge || !byReference.has(edge.fromRef) || !byReference.has(edge.toRef)) {
      rejectedEdges += 1
      return
    }
    relationCandidates.push(edge)
  })
  relationCandidates.sort(compareEdges)

  const fanout = new Map()
  const seenEdges = new Set()
  const relations = []
  let fanoutOmissions = 0
  let edgeLimitReached = false
  for (const edge of relationCandidates) {
    if (relations.length >= limits.maxEdges) {
      edgeLimitReached = true
      break
    }
    const id = edgeId(edge)
    if (seenEdges.has(id)) continue
    const fromFanout = fanout.get(edge.fromRef) ?? 0
    const toFanout = fanout.get(edge.toRef) ?? 0
    if (fromFanout >= limits.maxFanout || toFanout >= limits.maxFanout) {
      fanoutOmissions += 1
      continue
    }
    seenEdges.add(id)
    fanout.set(edge.fromRef, fromFanout + 1)
    fanout.set(edge.toRef, toFanout + 1)
    relations.push({
      id,
      from: entityId(edge.fromRef),
      to: entityId(edge.toRef),
      kind: edge.relation,
      basis: edge.basis,
      source: edge.source,
      ...(edge.sourceRelation ? { sourceRelation: edge.sourceRelation } : {}),
      ...(edge.verification ? { verification: edge.verification } : {}),
    })
  }

  const entities = Array.from(byReference.values(), (node) => ({
    id: entityId(node.reference.ref),
    kind: SEMANTIC_KIND_BY_OBJECT_KIND[node.reference.kind],
    title: node.title,
    detail: node.detail || `${node.reference.kind} · ${node.reference.id}`,
    parentIds: [],
    access: { audience: "private" },
    time: { happenedAt: node.happenedAt },
    sourceReference: node.reference.ref,
    sourceKind: node.reference.kind,
    sources: node.sources,
    status: "active",
  }))

  return {
    corpusStatementCount: entities.length,
    entities,
    relations,
    truncation: {
      nodeLimitReached,
      edgeLimitReached,
      fanoutOmissions,
      rejectedNodes,
      rejectedEdges,
      limits,
    },
  }
}
