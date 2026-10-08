const SHA256 = /^[0-9a-f]{64}$/u
const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const RELATION_DIRECTION = "prerequisite-to-dependent"

export const MAX_PROOF_MISSION_INTENT_BYTES = 65_536
export const MAX_PROOF_MISSION_ACTIVATION_BYTES = 131_072

function invalid(message) {
  throw new TypeError(`Invalid proof mission contract: ${message}`)
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

function text(value, maximum, label) {
  if (typeof value !== "string") invalid(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) invalid(`${label} is outside its bounded contract`)
  return normalized
}

function digest(value, label) {
  const normalized = text(value, 64, label).toLowerCase()
  if (!SHA256.test(normalized)) invalid(`${label} is not a lowercase SHA-256 digest`)
  return normalized
}

function stringArray(value, maximumItems, label) {
  if (!Array.isArray(value) || value.length > maximumItems) invalid(`${label} is not a bounded array`)
  const result = value.map((item, index) => text(item, 512, `${label}[${index}]`))
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate identifiers`)
  return result
}

function normalizedExpected(input) {
  const sourceGraphId = text(input.sourceGraphId, 512, "expected.sourceGraphId")
  const sourceContentSha256 = digest(input.sourceContentSha256, "expected.sourceContentSha256")
  const missionId = text(input.missionId, 120, "expected.missionId")
  if (!MISSION_ID.test(missionId)) invalid("expected.missionId is invalid")
  const mainTargetId = text(input.mainTargetId, 512, "expected.mainTargetId")
  const milestoneTargetIds = stringArray(
    input.milestoneTargetIds ?? [],
    500,
    "expected.milestoneTargetIds",
  ).sort()
  if (milestoneTargetIds.includes(mainTargetId)) invalid("the main target cannot also be a milestone")
  return { sourceGraphId, sourceContentSha256, missionId, mainTargetId, milestoneTargetIds }
}

export function createProofMissionIntent(input) {
  const expected = normalizedExpected(input)
  return Object.freeze({
    schema_id: "galaxy.proof-mission-intent.v1",
    source_graph: Object.freeze({
      graph_id: expected.sourceGraphId,
      graph_kind: "repository-field",
      content_sha256: expected.sourceContentSha256,
    }),
    mission_id: expected.missionId,
    main_target_id: expected.mainTargetId,
    curated_milestone_target_ids: Object.freeze(expected.milestoneTargetIds),
    relation_direction: RELATION_DIRECTION,
  })
}

export function encodeProofMissionIntent(input) {
  const intent = createProofMissionIntent(input)
  const bytes = new TextEncoder().encode(JSON.stringify(intent))
  if (bytes.byteLength > MAX_PROOF_MISSION_INTENT_BYTES) invalid("mission intent exceeds 64 KiB")
  return Object.freeze({ intent, bytes })
}

export function normalizeProofMissionCandidate(value, expectedInput) {
  const expected = normalizedExpected(expectedInput)
  const source = record(value, "candidate")
  exactKeys(source, new Set([
    "schema_id", "activation_state", "registerable", "source_graph", "selection",
    "mission_content_sha256", "mission_dag",
  ]), "candidate")
  if (source.schema_id !== "galaxy.proof-mission-candidate.v1") invalid("candidate.schema_id is unsupported")
  if (source.activation_state !== "inactive" || source.registerable !== false) {
    invalid("candidate must remain inactive and non-registerable")
  }

  const sourceGraph = record(source.source_graph, "candidate.source_graph")
  exactKeys(sourceGraph, new Set(["graph_id", "graph_kind", "content_sha256"]), "candidate.source_graph")
  if (sourceGraph.graph_kind !== "repository-field"
    || text(sourceGraph.graph_id, 512, "candidate.source_graph.graph_id") !== expected.sourceGraphId
    || digest(sourceGraph.content_sha256, "candidate.source_graph.content_sha256") !== expected.sourceContentSha256) {
    invalid("candidate source does not match the selected immutable graph")
  }

  const selection = record(source.selection, "candidate.selection")
  exactKeys(selection, new Set([
    "mission_id", "main_target_id", "curated_milestone_target_ids", "relation_direction",
  ]), "candidate.selection")
  const milestones = stringArray(
    selection.curated_milestone_target_ids,
    500,
    "candidate.selection.curated_milestone_target_ids",
  )
  if (selection.relation_direction !== RELATION_DIRECTION
    || text(selection.mission_id, 120, "candidate.selection.mission_id") !== expected.missionId
    || text(selection.main_target_id, 512, "candidate.selection.main_target_id") !== expected.mainTargetId
    || milestones.length !== expected.milestoneTargetIds.length
    || milestones.some((item, index) => item !== expected.milestoneTargetIds[index])) {
    invalid("candidate selection does not match the confirmed intent")
  }

  const missionDag = record(source.mission_dag, "candidate.mission_dag")
  if (missionDag.schema_id !== "galaxy.proof-dag.v1"
    || missionDag.graph_kind !== "mission"
    || missionDag.graph_id !== expected.missionId) {
    invalid("candidate mission DAG identity does not match the confirmed intent")
  }
  if (!Array.isArray(missionDag.targets) || missionDag.targets.length > 2_000) {
    invalid("candidate.mission_dag.targets is not a bounded array")
  }
  if (!Array.isArray(missionDag.relations) || missionDag.relations.length > 10_000) {
    invalid("candidate.mission_dag.relations is not a bounded array")
  }

  return Object.freeze({
    schemaId: source.schema_id,
    activationState: source.activation_state,
    registerable: source.registerable,
    sourceGraph: Object.freeze({
      graphId: expected.sourceGraphId,
      graphKind: sourceGraph.graph_kind,
      contentSha256: expected.sourceContentSha256,
    }),
    selection: Object.freeze({
      missionId: expected.missionId,
      mainTargetId: expected.mainTargetId,
      milestoneTargetIds: Object.freeze(milestones),
      relationDirection: selection.relation_direction,
    }),
    missionContentSha256: digest(source.mission_content_sha256, "candidate.mission_content_sha256"),
    missionDag,
  })
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative safe integer`)
  return value
}

function timestamp(value, label) {
  const normalized = text(value, 80, label)
  if (!Number.isFinite(Date.parse(normalized))) invalid(`${label} must be an ISO timestamp`)
  return normalized
}

export function encodeProofMissionActivationRequest(input) {
  const intent = createProofMissionIntent(input)
  const expectedMissionContentSha256 = digest(
    input.expectedMissionContentSha256,
    "activation.expectedMissionContentSha256",
  )
  const verificationSetContentSha256 = digest(
    input.verificationSetContentSha256,
    "activation.verificationSetContentSha256",
  )
  const workspaceId = text(input.workspaceId, 512, "activation.workspaceId")
  const idempotencyKey = text(input.idempotencyKey, 200, "activation.idempotencyKey")
  if (idempotencyKey.length < 8 || !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey)) {
    invalid("activation.idempotencyKey is invalid")
  }
  const request = Object.freeze({
    schema_id: "galaxy.proof-mission-activation-request.v1",
    mission_intent: intent,
    expected_mission_content_sha256: expectedMissionContentSha256,
    verification_set_ref: Object.freeze({
      graph_id: intent.source_graph.graph_id,
      graph_content_sha256: intent.source_graph.content_sha256,
      content_sha256: verificationSetContentSha256,
    }),
    workspace_id: workspaceId,
    idempotency_key: idempotencyKey,
  })
  const bytes = new TextEncoder().encode(JSON.stringify(request))
  if (bytes.byteLength > MAX_PROOF_MISSION_ACTIVATION_BYTES) {
    invalid("activation request exceeds 128 KiB")
  }
  return Object.freeze({ request, bytes })
}

export function normalizeProofMissionActivationResult(value, expectedInput) {
  const expected = normalizedExpected(expectedInput)
  const source = record(value, "activationResult")
  exactKeys(source, new Set([
    "schema_id", "activation_id", "activation_state", "source_graph_ref",
    "mission_intent_ref", "verification_set_ref", "mission_graph", "workspace",
    "inherited_verified_node_ids", "initial_frontier_node_ids", "activated_at", "replayed",
  ]), "activationResult")
  if (source.schema_id !== "galaxy.proof-mission-activation-result.v1"
    || source.activation_state !== "active") {
    invalid("activation result is not active")
  }
  if (source.replayed !== undefined && source.replayed !== true) {
    invalid("activationResult.replayed must be true when present")
  }
  const sourceRef = record(source.source_graph_ref, "activationResult.source_graph_ref")
  exactKeys(sourceRef, new Set(["graph_id", "content_sha256"]), "activationResult.source_graph_ref")
  if (text(sourceRef.graph_id, 512, "activationResult.source_graph_ref.graph_id") !== expected.sourceGraphId
    || digest(sourceRef.content_sha256, "activationResult.source_graph_ref.content_sha256")
      !== expected.sourceContentSha256) {
    invalid("activation result source does not match the confirmed source")
  }
  const verificationRef = record(
    source.verification_set_ref,
    "activationResult.verification_set_ref",
  )
  exactKeys(verificationRef, new Set(["content_sha256"]), "activationResult.verification_set_ref")
  const verificationSetContentSha256 = digest(
    verificationRef.content_sha256,
    "activationResult.verification_set_ref.content_sha256",
  )
  if (verificationSetContentSha256 !== digest(
    expectedInput.verificationSetContentSha256,
    "expected.verificationSetContentSha256",
  )) {
    invalid("activation result baseline does not match the confirmed baseline")
  }
  const intentRef = record(source.mission_intent_ref, "activationResult.mission_intent_ref")
  exactKeys(intentRef, new Set(["content_sha256"]), "activationResult.mission_intent_ref")
  digest(intentRef.content_sha256, "activationResult.mission_intent_ref.content_sha256")
  const mission = record(source.mission_graph, "activationResult.mission_graph")
  exactKeys(mission, new Set([
    "graph_id", "content_sha256", "title", "target_count", "relation_count",
  ]), "activationResult.mission_graph")
  const missionHash = digest(mission.content_sha256, "activationResult.mission_graph.content_sha256")
  if (missionHash !== digest(
    expectedInput.expectedMissionContentSha256,
    "expected.expectedMissionContentSha256",
  ) || text(mission.graph_id, 512, "activationResult.mission_graph.graph_id") !== expected.missionId) {
    invalid("activation result mission does not match the reviewed candidate")
  }
  const workspace = record(source.workspace, "activationResult.workspace")
  exactKeys(workspace, new Set([
    "workspace_id", "graph_ref", "version", "updated_at", "item_count",
  ]), "activationResult.workspace")
  const workspaceGraph = record(workspace.graph_ref, "activationResult.workspace.graph_ref")
  exactKeys(workspaceGraph, new Set(["graph_id", "content_sha256"]), "activationResult.workspace.graph_ref")
  if (workspaceGraph.graph_id !== expected.missionId
    || digest(workspaceGraph.content_sha256, "activationResult.workspace.graph_ref.content_sha256") !== missionHash
    || text(workspace.workspace_id, 512, "activationResult.workspace.workspace_id")
      !== text(expectedInput.workspaceId, 512, "expected.workspaceId")) {
    invalid("activation result workspace does not match the activated mission")
  }
  const inherited = stringArray(
    source.inherited_verified_node_ids,
    2_000,
    "activationResult.inherited_verified_node_ids",
  )
  const frontier = stringArray(
    source.initial_frontier_node_ids,
    2_000,
    "activationResult.initial_frontier_node_ids",
  )
  return Object.freeze({
    schemaId: source.schema_id,
    activationId: text(source.activation_id, 128, "activationResult.activation_id"),
    sourceGraph: Object.freeze({
      graphId: expected.sourceGraphId,
      contentSha256: expected.sourceContentSha256,
    }),
    verificationSetContentSha256,
    missionGraph: Object.freeze({
      graphId: expected.missionId,
      contentSha256: missionHash,
      title: text(mission.title, 200, "activationResult.mission_graph.title"),
      targetCount: count(mission.target_count, "activationResult.mission_graph.target_count"),
      relationCount: count(mission.relation_count, "activationResult.mission_graph.relation_count"),
    }),
    workspace: Object.freeze({
      workspaceId: text(workspace.workspace_id, 512, "activationResult.workspace.workspace_id"),
      version: count(workspace.version, "activationResult.workspace.version"),
      updatedAt: timestamp(workspace.updated_at, "activationResult.workspace.updated_at"),
      itemCount: count(workspace.item_count, "activationResult.workspace.item_count"),
    }),
    inheritedVerifiedNodeIds: Object.freeze(inherited),
    initialFrontierNodeIds: Object.freeze(frontier),
    activatedAt: timestamp(source.activated_at, "activationResult.activated_at"),
    ...(source.replayed === true ? { replayed: true } : {}),
  })
}
