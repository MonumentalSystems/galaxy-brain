const ENTITY_KIND_BY_OBJECT_KIND = Object.freeze({
  paper: "paper",
  document: "document",
  "document.anchor": "document-anchor",
  "document.mark": "document-anchor",
  "eln.experiment": "artifact",
  "eln.observation": "artifact",
  "eln.hypothesis": "claim",
  surface: "artifact",
  claim: "claim",
  artifact: "artifact",
  "code.repo": "code-repository",
  "code.commit": "code-commit",
  "code.file": "code-file",
  "code.symbol": "code-symbol",
  "code.graph": "code-graph",
  "proof.graph": "proof-graph",
  "proof.node": "proof-node",
  "ham.memory": "memory",
  "ham.task": "task",
  "task-plan": "task",
  "task-plan.job": "task",
  chat: "chat",
  run: "run",
  turn: "turn",
})

const RELATION_BASIS_BY_TRUST = Object.freeze({
  structure: "deterministic_structure",
  assertion: "authored_assertion",
  verification: "verified_proof",
  candidate: "semantic_candidate",
})

const DEFAULT_LIMITS = Object.freeze({ maxNodes: 250, maxEdges: 500, maxFanout: 32 })
const HARD_LIMITS = Object.freeze({ maxNodes: 500, maxEdges: 1_000, maxFanout: 64 })
const DERIVED_ONLY_KINDS = new Set(["document.chunk"])

function boundedLimit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
}

function entityId(reference) {
  return `unified:${encodeURIComponent(reference)}`
}

function entityKind(kind) {
  return ENTITY_KIND_BY_OBJECT_KIND[kind] ?? null
}

function entityStatus(node) {
  const state = node.overlays?.proof?.nodeState?.state
  if (state === "completed") return "complete"
  if (state === "blocked" || state === "waiting") return "blocked"
  if (state === "reference") return "draft"
  return "active"
}

function entitySources(node) {
  const seen = new Set()
  const sources = []
  for (const item of node.provenance) {
    const provider = typeof item.provider === "string" ? item.provider : null
    if (!provider) continue
    const recordId = typeof item.sourceId === "string" ? item.sourceId : undefined
    const revision = typeof item.sourceRevision === "string" ? item.sourceRevision : undefined
    const key = `${provider}\u0000${recordId ?? ""}\u0000${revision ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(Object.freeze({ provider, ...(recordId ? { recordId } : {}), ...(revision ? { revision } : {}) }))
  }
  return Object.freeze(sources)
}

/**
 * Present an already-authorized unified graph as a Semantic Field. This is a
 * deterministic view adapter: it performs no fetch, reference resolution, or
 * scope expansion, and it never creates Atlas placements.
 *
 * @param {import("./unified-graph").UnifiedGraphProjection} projection
 * @param {{ focusReference?: string | null, maxNodes?: number, maxEdges?: number, maxFanout?: number }} [options]
 * @returns {import("./unified-field-projection").UnifiedFieldProjection}
 */
export function projectUnifiedGraphToSemanticField(projection, options = {}) {
  if (projection?.schemaId !== "gb.graph-projection.v1") {
    throw new TypeError("Field requires an authorized gb.graph-projection.v1 projection")
  }

  const limits = Object.freeze({
    maxNodes: boundedLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes, HARD_LIMITS.maxNodes),
    maxEdges: boundedLimit(options.maxEdges, DEFAULT_LIMITS.maxEdges, HARD_LIMITS.maxEdges),
    maxFanout: boundedLimit(options.maxFanout, DEFAULT_LIMITS.maxFanout, HARD_LIMITS.maxFanout),
  })
  const eligibleNodes = projection.nodes.filter((node) => !DERIVED_ONLY_KINDS.has(node.kind) && entityKind(node.kind))
  const eligibleByReference = new Map(eligibleNodes.map((node) => [node.ref, node]))
  const prioritizedReferences = []
  const prioritized = new Set()
  const addReference = (reference) => {
    if (!eligibleByReference.has(reference) || prioritized.has(reference)) return
    prioritized.add(reference)
    prioritizedReferences.push(reference)
  }
  if (typeof options.focusReference === "string") {
    addReference(options.focusReference)
    projection.edges.forEach((edge) => {
      if (edge.fromRef === options.focusReference) addReference(edge.toRef)
      if (edge.toRef === options.focusReference) addReference(edge.fromRef)
    })
  }
  eligibleNodes.forEach((node) => addReference(node.ref))
  const selectedReferences = prioritizedReferences.slice(0, limits.maxNodes)
  const selectedReferenceSet = new Set(selectedReferences)
  const selectedNodes = selectedReferences.map((reference) => eligibleByReference.get(reference))
  const entityIds = new Map(selectedReferences.map((reference) => [reference, entityId(reference)]))
  const entities = selectedNodes.map((node) => Object.freeze({
    id: entityIds.get(node.ref),
    kind: entityKind(node.kind),
    title: node.title,
    detail: node.summary ?? `${node.kind} · authorized Galaxy object`,
    parentIds: Object.freeze([]),
    access: Object.freeze({ audience: "private" }),
    time: Object.freeze({ happenedAt: "" }),
    sourceReference: node.ref,
    sourceKind: node.kind,
    sources: entitySources(node),
    status: entityStatus(node),
  }))
  const fanout = new Map()
  let fanoutOmissions = 0
  let eligibleEdgeCount = 0
  const relations = []
  for (const edge of projection.edges) {
    if (!selectedReferenceSet.has(edge.fromRef) || !selectedReferenceSet.has(edge.toRef)) continue
    eligibleEdgeCount += 1
    if (relations.length >= limits.maxEdges) continue
    const from = entityIds.get(edge.fromRef)
    const to = entityIds.get(edge.toRef)
    if (!from || !to) continue
    const fromFanout = fanout.get(edge.fromRef) ?? 0
    const toFanout = fanout.get(edge.toRef) ?? 0
    if (fromFanout >= limits.maxFanout || toFanout >= limits.maxFanout) {
      fanoutOmissions += 1
      continue
    }
    fanout.set(edge.fromRef, fromFanout + 1)
    fanout.set(edge.toRef, toFanout + 1)
    relations.push(Object.freeze({
      id: `unified-edge:${edge.id}`,
      from,
      to,
      kind: edge.relation,
      basis: RELATION_BASIS_BY_TRUST[edge.trust],
      source: Object.freeze({
        provider: edge.source.provider,
        ...(edge.source.recordId ? { recordId: edge.source.recordId } : {}),
        ...(edge.source.revision ? { revision: edge.source.revision } : {}),
      }),
      ...(edge.sourceRelation ? { sourceRelation: edge.sourceRelation } : {}),
      ...(edge.verification ? { verification: edge.verification } : {}),
    }))
  }
  const projectionProviders = Array.isArray(projection.provenance?.providers)
    ? projection.provenance.providers
    : []
  const incompleteProviders = projectionProviders.flatMap((value) => (
    value
    && typeof value === "object"
    && typeof value.provider === "string"
    && (value.status === "partial" || value.status === "unavailable")
      ? [Object.freeze({ provider: value.provider, status: value.status })]
      : []
  ))

  return Object.freeze({
    corpusStatementCount: eligibleNodes.length,
    entities: Object.freeze(entities),
    relations: Object.freeze(relations),
    incompleteProviders: Object.freeze(incompleteProviders),
    truncation: Object.freeze({
      nodeLimitReached: selectedNodes.length < eligibleNodes.length,
      edgeLimitReached: relations.length < eligibleEdgeCount,
      fanoutOmissions,
      omittedDerivedNodes: projection.nodes.filter((node) => DERIVED_ONLY_KINDS.has(node.kind)).length,
      omittedUnsupportedNodes: projection.nodes.filter((node) => (
        !DERIVED_ONLY_KINDS.has(node.kind) && !entityKind(node.kind)
      )).length,
      limits,
    }),
  })
}
