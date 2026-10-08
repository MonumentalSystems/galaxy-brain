import { createGalaxyObjectReference } from "./galaxy-object-reference.js"
import { parseHamRelationOverlayResponse } from "./ham-relation-overlay-contract.js"

const HAM_MEMORY_ID = /^[1-9][0-9]{0,18}$/
const MAX_NEIGHBORS = 8
const AUTHORITATIVE_RELATIONS = new Map([
  ["cites", "cites"],
  ["verifies", "verifies"],
  ["contradicts", "contradicts"],
  ["depends-on", "depends_on"],
  ["supersedes", "supersedes"],
  ["superseded_by", "superseded_by"],
])

function boundedText(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : ""
}

/**
 * HAM retrieval gives semantic neighbors, not authored Galaxy graph edges.
 * Project those hits as explicitly provisional links around one selected
 * object. No search result is promoted to `supports`, `cites`, or `contains`.
 */
export function projectHamFieldNeighborhood(anchorId, results) {
  if (typeof anchorId !== "string" || !anchorId || !Array.isArray(results)) {
    return { entities: [], relations: [] }
  }

  const entities = []
  const relations = []
  const seen = new Set()
  for (const result of results) {
    if (entities.length >= MAX_NEIGHBORS) break
    if (!result || typeof result !== "object" || Array.isArray(result)) continue
    const memoryId = String(result.id ?? "")
    if (!HAM_MEMORY_ID.test(memoryId) || seen.has(memoryId)) continue
    seen.add(memoryId)

    const title = boundedText(result.metadata?.title, 120)
      || boundedText(result.content, 120).replace(/\s+/g, " ")
      || `HAM memory #${memoryId}`
    const entityId = `ham-memory:${memoryId}`
    entities.push({
      id: entityId,
      kind: "memory",
      title,
      detail: `HAM memory #${memoryId} · semantic neighbor, not an authored relation`,
      parentIds: [],
      access: { audience: "private" },
      time: { happenedAt: boundedText(result.timestamp, 100) || "" },
      sourceMemoryId: memoryId,
      sourceReference: createGalaxyObjectReference("ham.memory", memoryId),
      status: "candidate",
    })
    relations.push({
      id: `ham-near:${encodeURIComponent(anchorId)}:${memoryId}`,
      from: anchorId,
      to: entityId,
      kind: "near",
      basis: "ham_candidate",
    })
  }
  return { entities, relations }
}

/**
 * Convert the exact, already-authorized HAM memory view into provider graph
 * input. Unlike retrieval results, these edges are HAM-owned assertions and
 * retain their canonical source -> target direction.
 */
export function projectAuthoritativeHamMemoryView(view) {
  if (!view || typeof view !== "object" || Array.isArray(view) || !view.memory || !Array.isArray(view.edges)) {
    return { nodes: [], edges: [] }
  }
  const memoryId = String(view.memory.id ?? "")
  if (!HAM_MEMORY_ID.test(memoryId)) return { nodes: [], edges: [] }

  const memories = new Map([[memoryId, view.memory]])
  for (const edge of view.edges) {
    const adjacentId = String(edge?.adjacentId ?? "")
    if (!HAM_MEMORY_ID.test(adjacentId)) continue
    if (!edge?.adjacent || String(edge.adjacent.id ?? "") !== adjacentId) continue
    memories.set(adjacentId, edge.adjacent)
  }

  const nodes = Array.from(memories, ([id, memory]) => ({
    ref: createGalaxyObjectReference("ham.memory", id),
    title: boundedText(memory.title, 160)
      || boundedText(memory.snippet, 160).replace(/\s+/g, " ")
      || boundedText(memory.content, 160).replace(/\s+/g, " ")
      || `HAM memory #${id}`,
    detail: boundedText(memory.snippet, 500).replace(/\s+/g, " ")
      || boundedText(memory.content, 500).replace(/\s+/g, " ")
      || `HAM memory #${id}`,
    happenedAt: boundedText(memory.updatedAt, 100) || boundedText(memory.timestamp, 100),
    source: { provider: "ham", recordId: id, revision: `v${Number.isSafeInteger(memory.version) ? memory.version : 1}` },
  }))

  const edges = []
  const seen = new Set()
  for (const raw of view.edges) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    if (raw.state !== "active") continue
    const sourceId = String(raw.sourceId ?? "")
    const targetId = String(raw.targetId ?? "")
    const relation = AUTHORITATIVE_RELATIONS.get(raw.relation)
    if (!HAM_MEMORY_ID.test(sourceId) || !HAM_MEMORY_ID.test(targetId) || sourceId === targetId || !relation) continue
    if (!memories.has(sourceId) || !memories.has(targetId)) continue
    const recordId = boundedText(raw.id, 256)
    const identity = `${recordId}\u0000${raw.relation}\u0000${sourceId}\u0000${targetId}`
    if (seen.has(identity)) continue
    seen.add(identity)
    edges.push({
      fromRef: createGalaxyObjectReference("ham.memory", sourceId),
      toRef: createGalaxyObjectReference("ham.memory", targetId),
      relation,
      basis: "authored_assertion",
      source: {
        provider: "ham",
        ...(recordId ? { recordId } : {}),
        revision: `v${Number.isSafeInteger(raw.version) ? raw.version : 1}`,
      },
    })
  }
  return { nodes, edges }
}

/**
 * Project the strict relations-only provider envelope into federated graph
 * edges. Nodes remain owned by the caller's independently authorized object
 * projections; this adapter never invents adjacent HAM objects.
 */
export function projectAuthoritativeHamRelationOverlay(value) {
  let overlay
  try {
    overlay = parseHamRelationOverlayResponse(value)
  } catch {
    return { nodes: [], edges: [] }
  }
  return {
    nodes: [],
    edges: overlay.relations.map((raw) => ({
      fromRef: raw.sourceRef,
      toRef: raw.targetRef,
      relation: AUTHORITATIVE_RELATIONS.get(raw.relation),
      basis: "authored_assertion",
      source: {
        provider: "ham",
        recordId: raw.id,
        revision: `v${raw.version}`,
      },
    })),
  }
}
