import { createGalaxyObjectReference } from "./galaxy-object-reference.js"
import { createGalaxyObjectProjection } from "./object-projection.js"
import { projectProofObject } from "./object-projection-adapters.js"
import {
  parseProofDag,
  parseProofWorkState,
  projectProofTaskGraph,
  proofTaskResourceRef,
} from "./proof-task-graph.js"

export const AUTHORIZED_PROOF_GRAPH_SOURCE_SCHEMA_ID = "gb.authorized-proof-graph-source.v1"
export const AUTHORIZED_PROOF_GRAPH_SOURCE_RESULT_SCHEMA_ID = "gb.authorized-proof-graph-source-result.v1"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const GRAPH_KINDS = new Set(["repository-field", "campaign", "mission"])
const ACTIVE_GRAPH_KINDS = new Set(["campaign", "mission"])
const INPUT_KEYS = new Set([
  "schemaId", "authorized", "activateCoordination", "scope", "query", "proofDag", "proofDagSha256", "workState",
  "sourceCursor", "sourceLimit", "priorityRefs",
])
const SOURCE_PAGE_MAXIMUM = 10_000
const DEFAULT_SOURCE_PAGE_MAXIMUM = 1_000

const STRUCTURE_RELATIONS = Object.freeze({
  MILESTONE_OF: "part_of",
  DEPENDS_ON: "required_by",
  REDUCES_TO: "required_by",
  USES: "required_by",
  PROMOTED_TO: "corresponds_to",
  AUTHORED_PREREQUISITE: "required_by",
})

function invalid(message) {
  throw new TypeError(`Invalid ${AUTHORIZED_PROOF_GRAPH_SOURCE_SCHEMA_ID}: ${message}`)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not part of the contract`)
  }
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    invalid(`${label} is outside its bounded text contract`)
  }
  return normalized
}

function optionalExternalText(value, maximum) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized && Array.from(normalized).length <= maximum && !CONTROL_CHARACTERS.test(normalized)
    ? normalized
    : null
}

function normalizeScope(value) {
  const source = record(value, "scope")
  exactKeys(source, new Set(["tenantId", "workspaceId"]), "scope")
  const tenantId = boundedText(source.tenantId, 64, "scope.tenantId")
  if (!UUID.test(tenantId)) invalid("scope.tenantId must be a UUID")
  return Object.freeze({
    tenantId: tenantId.toLowerCase(),
    workspaceId: boundedText(source.workspaceId, 512, "scope.workspaceId"),
  })
}

function stableHash(value) {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  const values = seeds.map((seed) => seed >>> 0)
  for (const character of value) {
    const code = character.codePointAt(0)
    for (let index = 0; index < values.length; index += 1) {
      values[index] ^= code + index * 0x1000193
      values[index] = Math.imul(values[index], 0x01000193) >>> 0
      values[index] = (values[index] ^ (values[index] >>> 13)) >>> 0
    }
  }
  return values.map((item) => item.toString(16).padStart(8, "0")).join("")
}

function proofNodeProjectionId(graphId, nodeId, contentSha256, nodeIndex) {
  const readable = `${graphId}#${nodeId}`
  return Array.from(readable).length <= 512
    ? readable
    : `proof-node-${contentSha256}-${nodeIndex}`
}

function projectPinnedProofObject(source) {
  const revisionId = `sha256:${source.contentSha256}`
  const id = source.nodeId || source.graphId
  const base = projectProofObject({
    ...(source.nodeId ? { nodeRefId: source.nodeId } : { graphId: source.graphId }),
    title: source.title,
    objective: source.objective,
    summary: source.summary,
    provider: source.provider,
    revisionId,
  })
  return createGalaxyObjectProjection({
    ...base,
    ref: createGalaxyObjectReference(base.kind, id, { mode: "pinned", revision: revisionId }),
    revision: { policy: "pinned", id: revisionId, contentHash: source.contentSha256 },
    representations: base.representations.map((representation) => ({
      ...representation,
      contentHash: source.contentSha256,
    })),
  })
}

function scoped(scope, valueKey, value) {
  return Object.freeze({ scope, [valueKey]: Object.freeze(value) })
}

function sourceCursorState(cursor, sourceHash) {
  if (cursor === undefined || cursor === null || cursor === "") return { edgeOffset: 0, isolatedOffset: 0 }
  if (typeof cursor !== "string" || cursor.length > 200) invalid("sourceCursor is invalid")
  const match = /^pgs1:([a-f0-9]{32}):(\d+):(\d+)$/u.exec(cursor)
  if (!match || match[1] !== sourceHash) invalid("sourceCursor does not belong to this proof source")
  const edgeOffset = Number(match[2])
  const isolatedOffset = Number(match[3])
  if (!Number.isSafeInteger(edgeOffset) || !Number.isSafeInteger(isolatedOffset)) invalid("sourceCursor offset is invalid")
  return { edgeOffset, isolatedOffset }
}

function selectSourcePage(proofDag, workState, activateCoordination, cursor, priorityNodeIds, priorityRefs, pageMaximum) {
  const sourceHash = stableHash([
    proofDag.contentSha256,
    workState ? `${workState.workspaceId}:${workState.version}:${workState.updatedAt}` : "structure-only",
    activateCoordination ? "active" : "passive",
    pageMaximum,
    priorityRefs.join(","),
  ].join(":"))
  const state = sourceCursorState(cursor, sourceHash)
  const priorityNodeSet = new Set(priorityNodeIds)
  const edges = [...proofDag.edges].sort((left, right) => (
    (priorityNodeSet.has(left.source) || priorityNodeSet.has(left.target) ? 0 : 1)
    - (priorityNodeSet.has(right.source) || priorityNodeSet.has(right.target) ? 0 : 1)
    || left.id.localeCompare(right.id)
    || left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
  ))
  if (state.edgeOffset > edges.length) invalid("sourceCursor edge offset is invalid")
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]))
  const isolated = proofDag.nodes.map((node) => node.nodeId).filter((nodeId) => !connected.has(nodeId)).sort()
  if (state.isolatedOffset > isolated.length) invalid("sourceCursor isolated offset is invalid")

  if (priorityNodeSet.size + 1 > pageMaximum) invalid("priorityRefs exceed the source page object limit")
  const selectedNodeIds = new Set(priorityNodeIds)
  const selectedEdges = []
  let edgeOffset = state.edgeOffset
  for (; edgeOffset < edges.length; edgeOffset += 1) {
    const edge = edges[edgeOffset]
    const addedNodes = Number(!selectedNodeIds.has(edge.source)) + Number(!selectedNodeIds.has(edge.target))
    const nextNodeCount = selectedNodeIds.size + addedNodes
    const nextEdgeCount = selectedEdges.length + 1
    if (1 + nextNodeCount > pageMaximum || nextNodeCount + nextEdgeCount > pageMaximum) break
    selectedNodeIds.add(edge.source)
    selectedNodeIds.add(edge.target)
    selectedEdges.push(edge)
  }

  let isolatedOffset = state.isolatedOffset
  if (edgeOffset === edges.length) {
    for (; isolatedOffset < isolated.length; isolatedOffset += 1) {
      if (selectedNodeIds.has(isolated[isolatedOffset])) continue
      if (1 + selectedNodeIds.size + 1 > pageMaximum) break
      if (selectedNodeIds.size + 1 + selectedEdges.length > pageMaximum) break
      selectedNodeIds.add(isolated[isolatedOffset])
    }
  }
  const hasMore = edgeOffset < edges.length || isolatedOffset < isolated.length
  return Object.freeze({
    nodeIds: Object.freeze([...selectedNodeIds].sort()),
    edges: Object.freeze(selectedEdges),
    continuation: Object.freeze({
      cursor: hasMore ? `pgs1:${sourceHash}:${edgeOffset}:${isolatedOffset}` : null,
      hasMore,
      omitted: Object.freeze({
        nodes: proofDag.nodes.length - selectedNodeIds.size,
        relations: proofDag.nodes.length + proofDag.edges.length - selectedNodeIds.size - selectedEdges.length,
      }),
      reasons: Object.freeze(hasMore ? ["source-input-bound"] : []),
    }),
  })
}

function relation(scope, fromRef, toRef, relationName, trust, source, verification) {
  return scoped(scope, "relation", Object.fromEntries(Object.entries({
    fromRef,
    toRef,
    relation: relationName,
    trust,
    source: Object.freeze(source),
    verification: verification ? Object.freeze(verification) : undefined,
  }).filter(([, value]) => value !== undefined)))
}

function emptyResult(scope, query) {
  return Object.freeze({
    schemaId: AUTHORIZED_PROOF_GRAPH_SOURCE_RESULT_SCHEMA_ID,
    graphInput: Object.freeze({
      schemaId: "gb.graph-projection-input.v1",
      scope,
      query,
      objects: Object.freeze([]),
      external: Object.freeze([]),
      links: Object.freeze([]),
      relations: Object.freeze([]),
      proofContexts: Object.freeze([]),
      providers: Object.freeze([]),
    }),
    sourceContinuation: Object.freeze({
      cursor: null,
      hasMore: false,
      omitted: Object.freeze({ nodes: 0, relations: 0 }),
      reasons: Object.freeze([]),
    }),
    coordinationBindings: Object.freeze([]),
    diagnostics: Object.freeze({ omittedUnauthorized: true, passiveCoordinationItems: 0, partial: false }),
  })
}

function nodeState(nodeRef, node, active) {
  const item = node.workItem
  const verification = item?.proof.verification
  const acceptedVerification = item?.proof.status === "verified"
    && verification?.outcome === "accepted"
    && verification.sorryFree === true
    && verification.authority?.principalKind === "agent"
    && item.proof.candidateSha256 === verification.solutionSha256
  const rosetta = item?.external?.rosetta
  const rosettaStatus = rosetta && typeof rosetta === "object"
    ? optionalExternalText(rosetta.status, 80)
    : null
  const prove2me = item?.external?.prove2me
  const prove2meStatus = prove2me && typeof prove2me === "object"
    ? optionalExternalText(prove2me.status, 80)
    : null
  return Object.freeze(Object.fromEntries(Object.entries({
    nodeRef,
    state: active ? node.state : "reference",
    coordinationLabel: active
      ? node.coordinationLabel
      : "Reference corpus; select an explicit mission to claim",
    itemVersion: active && item ? item.version : undefined,
    workStatus: active && item ? item.work.status : undefined,
    proofStatus: active && item
      ? item.proof.status === "verified" && !acceptedVerification ? undefined : item.proof.status
      : acceptedVerification ? "verified" : undefined,
    claim: active && item?.work.claim ? Object.freeze({
      claimId: item.work.claim.claimId,
      expiresAt: item.work.claim.expiresAt,
    }) : undefined,
    run: active && item?.work.hyades?.runId ? Object.freeze({
      runId: item.work.hyades.runId,
      status: item.work.hyades.status,
    }) : undefined,
    taskId: active && item?.work.taskId ? item.work.taskId : undefined,
    linkedTaskCount: active && item?.work.taskId ? item.work.linkedTaskCount : undefined,
    candidateSha256: active && item?.proof.candidateSha256 ? item.proof.candidateSha256 : undefined,
    verification: acceptedVerification ? Object.freeze({
      status: "verified",
      method: verification.method,
      evidenceRef: `sha256:${verification.receiptSha256}`,
      solutionSha256: verification.solutionSha256,
      sorryFree: true,
      verifiedAt: verification.verifiedAt,
    }) : undefined,
    external: rosettaStatus || prove2meStatus ? Object.freeze(Object.fromEntries(Object.entries({
      rosettaStatus: rosettaStatus || undefined,
      prove2meStatus: prove2meStatus || undefined,
    }).filter(([, value]) => value !== undefined))) : undefined,
  }).filter(([, value]) => value !== undefined)))
}

/**
 * Convert one already-authorized immutable proof DAG and its hash-bound mutable
 * work state into a strict unified graph input. This adapter resolves nothing
 * and grants no access; callers must establish authorization before setting
 * `authorized: true`.
 */
export function buildAuthorizedProofGraphSource(input) {
  const source = record(input, "input")
  exactKeys(source, INPUT_KEYS, "input")
  if (source.schemaId !== AUTHORIZED_PROOF_GRAPH_SOURCE_SCHEMA_ID) invalid("unsupported schemaId")
  const scope = normalizeScope(source.scope)
  if (source.authorized !== true) return emptyResult(scope, source.query)

  const proofDag = parseProofDag(source.proofDag, source.proofDagSha256)
  if (!GRAPH_KINDS.has(proofDag.graphKind)) invalid("proofDag.graph_kind is not projectable")
  const workState = source.workState === undefined || source.workState === null
    ? null
    : parseProofWorkState(source.workState, proofDag)
  const projection = workState ? projectProofTaskGraph(proofDag, workState) : null
  const active = source.activateCoordination === true && ACTIVE_GRAPH_KINDS.has(proofDag.graphKind) && workState !== null
  const graphProjection = projectPinnedProofObject({
    graphId: proofDag.graphId,
    title: proofDag.title,
    summary: `${proofDag.graphKind} proof structure`,
    contentSha256: proofDag.contentSha256,
    provider: "galaxy.proof-dag",
  })
  // The parser preserves canonical target ordinality; the registry uses the
  // same ordinal for oversized identity fallbacks.
  const nodeIndexById = new Map(proofDag.nodes.map((node, index) => [node.nodeId, index]))
  const proofRevisionId = `sha256:${proofDag.contentSha256}`
  const nodeRefById = new Map(proofDag.nodes.map((node) => [
    node.nodeId,
    createGalaxyObjectReference(
      "proof.node",
      proofNodeProjectionId(
        proofDag.graphId,
        node.nodeId,
        proofDag.contentSha256,
        nodeIndexById.get(node.nodeId),
      ),
      { mode: "pinned", revision: proofRevisionId },
    ),
  ]))
  const queryRootRef = source.query && typeof source.query === "object" && !Array.isArray(source.query)
    && typeof source.query.rootRef === "string" ? source.query.rootRef : null
  const rawPriorityRefs = source.priorityRefs === undefined ? [] : source.priorityRefs
  if (!Array.isArray(rawPriorityRefs) || rawPriorityRefs.length > 32 || rawPriorityRefs.some((ref) => typeof ref !== "string")) {
    invalid("priorityRefs must be a bounded array of exact proof node references")
  }
  const priorityRefs = [...new Set([queryRootRef, ...rawPriorityRefs].filter(Boolean))].sort()
  const nodeIdByRef = new Map([...nodeRefById].map(([nodeId, reference]) => [reference, nodeId]))
  for (const reference of rawPriorityRefs) {
    if (!nodeIdByRef.has(reference)) invalid("priorityRefs must belong to this immutable proof DAG")
  }
  const priorityNodeIds = priorityRefs.map((reference) => nodeIdByRef.get(reference)).filter(Boolean)
  const sourceLimit = source.sourceLimit === undefined ? DEFAULT_SOURCE_PAGE_MAXIMUM : source.sourceLimit
  if (!Number.isSafeInteger(sourceLimit) || sourceLimit < 2 || sourceLimit > SOURCE_PAGE_MAXIMUM) {
    invalid(`sourceLimit must be a safe integer between 2 and ${SOURCE_PAGE_MAXIMUM}`)
  }
  const page = selectSourcePage(
    proofDag,
    workState,
    active,
    source.sourceCursor,
    priorityNodeIds,
    priorityRefs,
    sourceLimit,
  )
  const partialPage = page.continuation.hasMore || Boolean(source.sourceCursor)
  const selectedNodeIds = new Set(page.nodeIds)
  const nodeById = new Map(proofDag.nodes.map((node) => [node.nodeId, node]))
  const objects = [
    scoped(scope, "projection", graphProjection),
    ...page.nodeIds.map((nodeId) => {
      const node = nodeById.get(nodeId)
      const nodeProjection = projectPinnedProofObject({
        nodeId: proofNodeProjectionId(
          proofDag.graphId,
          node.nodeId,
          proofDag.contentSha256,
          nodeIndexById.get(node.nodeId),
        ),
        title: node.title,
        objective: node.objective || `${node.targetKind || "formal target"} ${node.nodeId}`,
        contentSha256: proofDag.contentSha256,
        provider: "galaxy.proof-dag",
      })
      if (nodeProjection.ref !== nodeRefById.get(nodeId)) invalid("proof node identity projection drifted")
      return scoped(scope, "projection", nodeProjection)
    }),
  ]

  const relations = []
  for (const nodeId of page.nodeIds) {
    const node = nodeById.get(nodeId)
    relations.push(relation(scope, graphProjection.ref, nodeRefById.get(node.nodeId), "contains", "structure", {
      provider: "galaxy.proof-dag",
      recordId: node.nodeId,
      revision: proofDag.contentSha256,
      sourceRef: graphProjection.ref,
      resourceMode: "target",
      resourceStatus: node.formalBindingStatus || "unmapped",
    }))
  }
  for (const edge of page.edges) {
    relations.push(relation(
      scope,
      nodeRefById.get(edge.source),
      nodeRefById.get(edge.target),
      STRUCTURE_RELATIONS[edge.relationType],
      "structure",
      {
        provider: "galaxy.proof-dag",
        recordId: edge.id,
        revision: proofDag.contentSha256,
        sourceRef: graphProjection.ref,
        resourceMode: edge.relationType,
      },
    ))
  }

  const nodeStates = Object.freeze((projection?.nodes ?? []).filter((node) => selectedNodeIds.has(node.nodeId)).map((node) => (
    nodeState(nodeRefById.get(node.nodeId), node, active)
  )))
  const coordinationBindings = Object.freeze((projection?.nodes ?? [])
    .filter((node) => selectedNodeIds.has(node.nodeId) && active && node.workItem?.work.taskId)
    .flatMap((node) => {
      try {
        return [Object.freeze({
          graphId: proofDag.graphId,
          nodeId: node.nodeId,
          nodeRef: nodeRefById.get(node.nodeId),
          taskId: node.workItem.work.taskId,
          linkedTaskCount: node.workItem.work.linkedTaskCount,
          resourceRef: proofTaskResourceRef(proofDag.graphId, node.nodeId, proofDag.contentSha256),
        })]
      } catch {
        // A proof target that cannot fit HAM's exact proof-packet resource
        // contract may still retain its work-state task label, but it cannot
        // produce an authoritative cross-provider coordination edge.
        return []
      }
    }))

  const graphInput = Object.freeze({
    schemaId: "gb.graph-projection-input.v1",
    scope,
    query: source.query,
    objects: Object.freeze(objects),
    external: Object.freeze([]),
    links: Object.freeze([]),
    relations: Object.freeze(relations),
    proofContexts: Object.freeze([Object.freeze({
      scope,
      graphRef: graphProjection.ref,
      graphKind: proofDag.graphKind,
      coordinationActive: active,
      nodeRefs: Object.freeze(page.nodeIds.map((nodeId) => nodeRefById.get(nodeId))),
      nodeStates,
    })]),
    providers: Object.freeze([
      Object.freeze({
        scope,
        provider: "galaxy.proof-dag",
        status: partialPage ? "partial" : "ready",
        snapshot: proofDag.contentSha256,
        revision: proofDag.contentSha256,
      }),
      ...(workState ? [Object.freeze({
        scope,
        provider: "galaxy.proof-work",
        status: partialPage ? "partial" : "ready",
        snapshot: workState.updatedAt,
        revision: `version:${workState.version}`,
      })] : []),
    ]),
  })
  return Object.freeze({
    schemaId: AUTHORIZED_PROOF_GRAPH_SOURCE_RESULT_SCHEMA_ID,
    graphInput,
    sourceContinuation: page.continuation,
    coordinationBindings,
    diagnostics: Object.freeze({
      omittedUnauthorized: false,
      passiveCoordinationItems: active || !workState ? 0 : workState.items.length,
      coordinationActive: active,
      partial: partialPage,
    }),
  })
}
