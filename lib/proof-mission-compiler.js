import { parseProofDag } from "./proof-task-graph.js"

const PREREQUISITE_RELATION_TYPES = new Set([
  "DEPENDS_ON",
  "REDUCES_TO",
  "USES",
  "AUTHORED_PREREQUISITE",
])
const MISSION_INPUT_KEYS = new Set([
  "sourceProofDagBytes",
  "missionId",
  "mainTargetId",
  "milestoneTargetIds",
  "relationDirection",
])
const MAX_MISSION_TARGETS = 2_000
const MAX_MISSION_RELATIONS = 10_000
const MAX_MISSION_MILESTONES = 500
const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_CORRESPONDENCE_ITEMS = 2_000

function invalid(message) {
  throw new Error(message)
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`)
  return value
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label}.${key} is not supported`)
  }
}

function text(value, label, maximum, required = false) {
  if (value === undefined || value === null) {
    if (required) invalid(`${label} is required`)
    return ""
  }
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (required && !normalized) invalid(`${label} is required`)
  if (normalized.length > maximum) invalid(`${label} exceeds ${maximum} characters`)
  return normalized
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function optionalText(value, label, maximum) {
  if (value === undefined) return undefined
  return text(value, label, maximum, true)
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") invalid(`${label} must be boolean`)
  return value
}

function textArray(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_CORRESPONDENCE_ITEMS) {
    invalid(`${label} must contain at most ${MAX_CORRESPONDENCE_ITEMS} entries`)
  }
  const seen = new Set()
  return value.map((entry, index) => {
    const item = text(entry, `${label}[${index}]`, 512, true)
    if (seen.has(item)) invalid(`${label} contains duplicate ${item}`)
    seen.add(item)
    return item
  })
}

function nullableText(value, label, maximum) {
  if (value === null) return null
  return text(value, label, maximum, true)
}

function nullableTextArray(value, label) {
  if (value === null) return null
  if (value === undefined) invalid(`${label} is required`)
  return textArray(value, label)
}

function nestedTextArrays(value, label) {
  if (!Array.isArray(value) || value.length > MAX_CORRESPONDENCE_ITEMS) {
    invalid(`${label} must contain at most ${MAX_CORRESPONDENCE_ITEMS} entries`)
  }
  let total = 0
  return value.map((step, index) => {
    const parsed = textArray(step, `${label}[${index}]`)
    total += parsed.length
    if (total > MAX_CORRESPONDENCE_ITEMS) {
      invalid(`${label} must contain at most ${MAX_CORRESPONDENCE_ITEMS} dependency kinds`)
    }
    return parsed
  })
}

function copyFormalCorrespondence(value, label) {
  const source = record(value, label)
  return {
    status: text(source.status, `${label}.status`, 120, true),
    support_kind: nullableText(source.support_kind, `${label}.support_kind`, 120),
    declaration_path: nullableTextArray(source.declaration_path, `${label}.declaration_path`),
    dependency_kinds_by_step: nestedTextArrays(
      source.dependency_kinds_by_step,
      `${label}.dependency_kinds_by_step`,
    ),
  }
}

function copyBridgeNomination(value, label) {
  const source = record(value, label)
  if (typeof source.nominated !== "boolean") invalid(`${label}.nominated must be boolean`)
  return {
    nominated: source.nominated,
    reason: text(source.reason, `${label}.reason`, 4_000, true),
  }
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function copyTarget(source, parsed) {
  const binding = source.formal_binding && typeof source.formal_binding === "object" && !Array.isArray(source.formal_binding)
    ? source.formal_binding
    : {}
  const copied = {
    target_id: parsed.nodeId,
    target_kind: parsed.targetKind,
    title: parsed.title,
    natural_language_summary: parsed.objective,
    category: parsed.category,
    formal_binding: {
      status: parsed.formalBindingStatus,
    },
  }
  const sourceId = optionalText(source.source_id, `Target ${parsed.nodeId} source_id`, 512)
  const sourceLabel = optionalText(source.source_label, `Target ${parsed.nodeId} source_label`, 1_000)
  const moduleIds = textArray(binding.module_ids, `Target ${parsed.nodeId} formal_binding.module_ids`)
  const declarationIds = textArray(binding.declaration_ids, `Target ${parsed.nodeId} formal_binding.declaration_ids`)
  const bindingKind = optionalText(binding.binding_kind, `Target ${parsed.nodeId} formal_binding.binding_kind`, 120)
  const mappingRule = optionalText(binding.mapping_rule, `Target ${parsed.nodeId} formal_binding.mapping_rule`, 4_000)
  const declarationEquivalenceClaimed = optionalBoolean(
    binding.declaration_equivalence_claimed,
    `Target ${parsed.nodeId} formal_binding.declaration_equivalence_claimed`,
  )
  if (sourceId !== undefined) copied.source_id = sourceId
  if (sourceLabel !== undefined) copied.source_label = sourceLabel
  if (moduleIds !== undefined) copied.formal_binding.module_ids = moduleIds
  if (declarationIds !== undefined) copied.formal_binding.declaration_ids = declarationIds
  if (bindingKind !== undefined) copied.formal_binding.binding_kind = bindingKind
  if (mappingRule !== undefined) copied.formal_binding.mapping_rule = mappingRule
  if (declarationEquivalenceClaimed !== undefined) {
    copied.formal_binding.declaration_equivalence_claimed = declarationEquivalenceClaimed
  }
  return copied
}

function copyRelation(source, relation) {
  const copied = {
    relation_id: relation.id,
    relation_type: relation.relationType,
    prerequisite_target_id: relation.source,
    dependent_target_id: relation.target,
  }
  const sourceEdgeId = optionalText(source.source_edge_id, `Relation ${relation.id} source_edge_id`, 512)
  const assertionLevel = optionalText(source.assertion_level, `Relation ${relation.id} assertion_level`, 120)
  if (sourceEdgeId !== undefined) copied.source_edge_id = sourceEdgeId
  if (assertionLevel !== undefined) copied.assertion_level = assertionLevel
  if (source.formal_correspondence !== undefined) {
    copied.formal_correspondence = copyFormalCorrespondence(
      source.formal_correspondence,
      `Relation ${relation.id} formal_correspondence`,
    )
  }
  // LeanProofs emits null when no bridge was nominated. The compiled mission
  // omits that absent annotation; a present nomination remains strictly typed.
  if (source.bridge_nomination !== undefined && source.bridge_nomination !== null) {
    copied.bridge_nomination = copyBridgeNomination(
      source.bridge_nomination,
      `Relation ${relation.id} bridge_nomination`,
    )
  }
  return copied
}

/**
 * Compile an explicit mission from an immutable passive repository field.
 *
 * The source digest is provenance, not a mutable "latest" pointer. The
 * compiler follows only authoritative prerequisite relations toward the main
 * target. Curated milestones label targets already in that closure; they do
 * not add dependencies or widen it. No work, claim, run, verification, remote
 * status is copied into the mission artifact. Source IDs and formal
 * correspondence survive as provenance only; canonical Galaxy IDs and edge
 * endpoints always come from the validated parser.
 */
export async function compileProofMission(input) {
  const request = record(input, "Mission compiler input")
  exactKeys(request, MISSION_INPUT_KEYS, "Mission compiler input")

  if (!(request.sourceProofDagBytes instanceof Uint8Array)) {
    invalid("sourceProofDagBytes must be exact UTF-8 bytes")
  }
  if (request.sourceProofDagBytes.byteLength === 0 || request.sourceProofDagBytes.byteLength > MAX_SOURCE_BYTES) {
    invalid(`sourceProofDagBytes must contain 1 to ${MAX_SOURCE_BYTES} bytes`)
  }
  // Snapshot synchronously before the first await so caller mutation cannot
  // change either the parsed document or the provenance digest mid-compile.
  const sourceBytes = new Uint8Array(request.sourceProofDagBytes)
  const sourceContentSha256 = toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", sourceBytes)))
  let sourceDocument
  try {
    sourceDocument = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes)),
      "sourceProofDagBytes document",
    )
  } catch (error) {
    if (error instanceof Error && error.message === "sourceProofDagBytes document must be an object") throw error
    invalid("sourceProofDagBytes must contain valid UTF-8 galaxy.proof-dag.v1 JSON")
  }
  const source = parseProofDag(sourceDocument, sourceContentSha256)
  if (source.graphKind !== "repository-field") {
    invalid("Mission source must be a passive repository-field proof DAG")
  }
  if (request.relationDirection !== "prerequisite-to-dependent") {
    invalid("relationDirection must explicitly be prerequisite-to-dependent")
  }

  const missionId = text(request.missionId, "missionId", 120, true)
  const mainTargetId = text(request.mainTargetId, "mainTargetId", 512, true)
  const sourceNodeById = new Map(source.nodes.map((node) => [node.nodeId, node]))
  if (!sourceNodeById.has(mainTargetId)) invalid(`Main target ${mainTargetId} is not in the source proof DAG`)

  if (request.milestoneTargetIds !== undefined && !Array.isArray(request.milestoneTargetIds)) {
    invalid("milestoneTargetIds must be an array")
  }
  const milestoneTargetIds = request.milestoneTargetIds ?? []
  if (milestoneTargetIds.length > MAX_MISSION_MILESTONES) {
    invalid(`Mission milestones exceed ${MAX_MISSION_MILESTONES}`)
  }
  const seenMilestones = new Set()
  for (let index = 0; index < milestoneTargetIds.length; index += 1) {
    const milestoneId = text(milestoneTargetIds[index], `milestoneTargetIds[${index}]`, 512, true)
    if (milestoneId === mainTargetId) invalid("The main target cannot also be a curated milestone")
    if (!sourceNodeById.has(milestoneId)) invalid(`Milestone target ${milestoneId} is not in the source proof DAG`)
    if (seenMilestones.has(milestoneId)) invalid(`Milestone target ${milestoneId} is duplicated`)
    seenMilestones.add(milestoneId)
  }
  const curatedMilestoneTargetIds = [...seenMilestones].sort(compareText)

  const prerequisiteEdges = source.edges.filter((edge) => PREREQUISITE_RELATION_TYPES.has(edge.relationType))
  const incoming = new Map(source.nodes.map((node) => [node.nodeId, []]))
  for (const edge of prerequisiteEdges) incoming.get(edge.target).push(edge.source)

  const selectedIds = new Set()
  const pending = [mainTargetId]
  while (pending.length > 0) {
    const targetId = pending.pop()
    if (selectedIds.has(targetId)) continue
    selectedIds.add(targetId)
    if (selectedIds.size > MAX_MISSION_TARGETS) {
      invalid(`Mission prerequisite closure exceeds ${MAX_MISSION_TARGETS} targets`)
    }
    for (const prerequisiteId of incoming.get(targetId)) pending.push(prerequisiteId)
  }

  for (const milestoneId of curatedMilestoneTargetIds) {
    if (!selectedIds.has(milestoneId)) {
      invalid(`Milestone target ${milestoneId} is outside the main target prerequisite closure`)
    }
  }

  const selectedRelations = source.edges.filter((edge) => (
    selectedIds.has(edge.source) && selectedIds.has(edge.target)
  ))
  const relationIds = new Set(selectedRelations.map((edge) => edge.id))
  const milestoneRelations = []
  let generatedRelationIndex = 1
  for (const milestoneId of curatedMilestoneTargetIds) {
    const alreadyVisible = selectedRelations.some((edge) => (
      edge.relationType === "MILESTONE_OF"
      && edge.source === milestoneId
      && edge.target === mainTargetId
    ))
    if (alreadyVisible) continue

    let relationId
    do {
      relationId = `mission-milestone-${String(generatedRelationIndex).padStart(6, "0")}`
      generatedRelationIndex += 1
    } while (relationIds.has(relationId))
    relationIds.add(relationId)
    milestoneRelations.push({
      id: relationId,
      relationType: "MILESTONE_OF",
      source: milestoneId,
      target: mainTargetId,
    })
  }
  const missionRelations = [...selectedRelations, ...milestoneRelations]
  if (missionRelations.length > MAX_MISSION_RELATIONS) {
    invalid(`Mission relations exceed ${MAX_MISSION_RELATIONS}`)
  }

  const rawTargetById = new Map(sourceDocument.targets.map((target) => [
    typeof target.target_id === "string" ? target.target_id.trim() : target.target_id,
    target,
  ]))
  const rawRelationById = new Map(sourceDocument.relations.map((relation) => [
    typeof relation.relation_id === "string" ? relation.relation_id.trim() : relation.relation_id,
    relation,
  ]))
  const targets = source.nodes
    .filter((node) => selectedIds.has(node.nodeId))
    .sort((left, right) => compareText(left.nodeId, right.nodeId))
    .map((node) => copyTarget(rawTargetById.get(node.nodeId), node))
  const relations = missionRelations
    .sort((left, right) => compareText(left.id, right.id))
    .map((relation) => copyRelation(rawRelationById.get(relation.id) ?? {}, relation))

  const mission = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: missionId,
    graph_kind: "mission",
    title: sourceNodeById.get(mainTargetId).title,
    mission: {
      main_target_id: mainTargetId,
      curated_milestone_target_ids: curatedMilestoneTargetIds,
    },
    provenance: {
      source_graph: {
        graph_id: source.graphId,
        graph_kind: "repository-field",
        content_sha256: source.contentSha256,
      },
      compiler: "galaxy.proof-mission-compiler.v1",
    },
    targets,
    relations,
  }

  // Re-parse the result before returning it. This catches identifier limits,
  // accidental dangling relations, cycles, and resource-reference overflows in
  // the exact active artifact shape. Its own content digest is assigned only
  // when the immutable bytes are serialized and registered.
  parseProofDag(mission, "0".repeat(64))
  return {
    schema_id: "galaxy.proof-mission-draft.v1",
    source_graph: {
      graph_id: source.graphId,
      graph_kind: "repository-field",
      content_sha256: source.contentSha256,
    },
    selection: {
      mission_id: missionId,
      main_target_id: mainTargetId,
      curated_milestone_target_ids: curatedMilestoneTargetIds,
      relation_direction: "prerequisite-to-dependent",
    },
    mission_dag: mission,
  }
}

export const PROOF_MISSION_COMPILER_LIMITS = Object.freeze({
  sourceBytes: MAX_SOURCE_BYTES,
  targets: MAX_MISSION_TARGETS,
  relations: MAX_MISSION_RELATIONS,
  milestones: MAX_MISSION_MILESTONES,
})
