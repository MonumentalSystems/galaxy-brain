const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const PROOF_GRAPH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const GRAPH_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/
const TASK_RESOURCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/
const TASK_RESOURCE_MAXIMUM = 500
const SHA256 = /^[0-9a-f]{64}$/
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const NOSTR_PUBKEY = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const WORK_STATUSES = new Set(["idle", "claimed", "running", "submitted", "blocked", "closed"])
const PROOF_STATUSES = new Set(["open", "candidate", "attested", "verified", "rejected", "overridden", "superseded"])
const CLAIMABLE_GRAPH_KINDS = new Set(["campaign", "mission"])
const RELATION_TYPES = new Set([
  "MILESTONE_OF",
  "DEPENDS_ON",
  "REDUCES_TO",
  "USES",
  "PROMOTED_TO",
  // Retained for the existing passive repository-field artifact contract.
  "AUTHORED_PREREQUISITE",
])
const PREREQUISITE_RELATION_TYPES = new Set(["DEPENDS_ON", "REDUCES_TO", "USES", "AUTHORED_PREREQUISITE"])

function invalid(message) {
  throw new Error(message)
}

function boundedText(value, label, maximum, required = false) {
  if (value === undefined || value === null) {
    if (required) invalid(`${label} is required`)
    return ""
  }
  if (typeof value !== "string") invalid(`${label} must be text`)
  const text = value.trim()
  if (required && !text) invalid(`${label} is required`)
  if (text.length > maximum) invalid(`${label} exceeds ${maximum} characters`)
  return text
}

function parseTextObjects(raw, packetId, field, textField, maximumItems) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > maximumItems) {
    invalid(`Packet ${packetId} ${field} must contain at most ${maximumItems} entries`)
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`Packet ${packetId} ${field}[${index}] must be an object`)
    }
    return {
      ...entry,
      [textField]: boundedText(entry[textField], `Packet ${packetId} ${field}[${index}].${textField}`, 4_000, true),
    }
  })
}

function topologicalLayers(packets) {
  const indegree = new Map(packets.map((packet) => [packet.packetId, packet.prerequisitePacketIds.length]))
  const dependents = new Map(packets.map((packet) => [packet.packetId, []]))
  const layers = new Map(packets.map((packet) => [packet.packetId, 0]))
  for (const packet of packets) {
    for (const prerequisiteId of packet.prerequisitePacketIds) {
      dependents.get(prerequisiteId).push(packet.packetId)
    }
  }
  const queue = packets.filter((packet) => indegree.get(packet.packetId) === 0).map((packet) => packet.packetId)
  let cursor = 0
  while (cursor < queue.length) {
    const packetId = queue[cursor++]
    for (const dependentId of dependents.get(packetId)) {
      layers.set(dependentId, Math.max(layers.get(dependentId), layers.get(packetId) + 1))
      const remaining = indegree.get(dependentId) - 1
      indegree.set(dependentId, remaining)
      if (remaining === 0) queue.push(dependentId)
    }
  }
  if (queue.length !== packets.length) {
    const cyclePacket = packets.find((packet) => indegree.get(packet.packetId) > 0)
    invalid(`Campaign dependency cycle includes ${cyclePacket?.packetId || "an unknown packet"}`)
  }
  return layers
}

function graphLayers(nodes, edges) {
  const prerequisites = new Map(nodes.map((node) => [node.nodeId, []]))
  for (const edge of edges) prerequisites.get(edge.target).push(edge.source)
  return topologicalLayers(nodes.map((node) => ({
    packetId: node.nodeId,
    prerequisitePacketIds: prerequisites.get(node.nodeId),
  })))
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !GRAPH_NODE_ID.test(value)) invalid(`${label} is invalid`)
  return value
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256 digest`)
  return value
}

function parseGalaxyProofGraphRef(input, programId) {
  if (input === undefined || input === null) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("Manifest galaxy_proof_graph_ref must be an object or null")
  }
  const allowedKeys = new Set(["schema_id", "graph_id", "content_sha256"])
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    invalid(`Manifest galaxy_proof_graph_ref contains unsupported field ${unknownKey}`)
  }
  if (input.schema_id !== "galaxy.proof-graph-ref.v1") {
    invalid("Manifest galaxy_proof_graph_ref must use galaxy.proof-graph-ref.v1")
  }
  const graphId = typeof input.graph_id === "string" && PROOF_GRAPH_IDENTIFIER.test(input.graph_id)
    ? input.graph_id
    : invalid("Manifest galaxy_proof_graph_ref.graph_id is invalid")
  if (graphId !== programId) {
    invalid("Manifest galaxy_proof_graph_ref.graph_id must match program_id")
  }
  return {
    schemaId: input.schema_id,
    graphId,
    contentSha256: requireSha256(
      input.content_sha256,
      "Manifest galaxy_proof_graph_ref.content_sha256",
    ),
  }
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO timestamp`)
  return value
}

function requireGitOid(value, label) {
  if (typeof value !== "string" || !GIT_OID.test(value)) invalid(`${label} must be a lowercase Git object ID`)
  return value
}

function rejectSensitiveFields(value, path = "work state") {
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (/^(raw_?logs?|credentials?|tokens?|private_?key|secret)$/i.test(key)) {
      invalid(`${path}.${key} is not permitted`)
    }
    rejectSensitiveFields(child, `${path}.${key}`)
  }
}

/**
 * Parse the immutable, converter-produced Galaxy proof DAG. The digest is kept
 * outside the artifact because a document cannot contain its own content hash.
 */
export function parseProofDag(input, contentSha256) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Proof DAG must be a JSON object")
  if (input.schema_id !== "galaxy.proof-dag.v1") invalid("Proof DAG must use galaxy.proof-dag.v1")
  const graphId = requireIdentifier(input.graph_id, "Proof DAG graph_id")
  const graphKind = boundedText(input.graph_kind, "Proof DAG graph_kind", 120)
  const digest = requireSha256(contentSha256, "Proof DAG content hash")
  if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length > 10_000) {
    invalid("Proof DAG targets must contain 1 to 10,000 entries")
  }
  if (!Array.isArray(input.relations) || input.relations.length > 50_000) {
    invalid("Proof DAG relations must contain at most 50,000 entries")
  }

  const seen = new Set()
  const nodes = input.targets.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) invalid(`Target ${index + 1} must be an object`)
    const nodeId = requireIdentifier(target.target_id, `Target ${index + 1} target_id`)
    if (seen.has(nodeId)) invalid(`Target ${nodeId} is duplicated`)
    seen.add(nodeId)
    const binding = target.formal_binding && typeof target.formal_binding === "object" && !Array.isArray(target.formal_binding)
      ? target.formal_binding
      : {}
    return {
      nodeId,
      title: boundedText(target.title, `Target ${nodeId} title`, 200) || nodeId,
      objective: boundedText(target.natural_language_summary, `Target ${nodeId} natural_language_summary`, 4_000),
      category: boundedText(target.category, `Target ${nodeId} category`, 120),
      targetKind: boundedText(target.target_kind, `Target ${nodeId} target_kind`, 120),
      formalBindingStatus: boundedText(binding.status, `Target ${nodeId} formal binding status`, 120),
      theoremTargets: [],
      mandatoryControls: [],
    }
  })

  if (CLAIMABLE_GRAPH_KINDS.has(graphKind)) {
    for (const node of nodes) proofTaskResourceRef(graphId, node.nodeId, digest)
  }

  const relationIds = new Set()
  const edges = input.relations.map((relation, index) => {
    if (!relation || typeof relation !== "object" || Array.isArray(relation)) invalid(`Relation ${index + 1} must be an object`)
    const source = requireIdentifier(relation.prerequisite_target_id, `Relation ${index + 1} prerequisite_target_id`)
    const target = requireIdentifier(relation.dependent_target_id, `Relation ${index + 1} dependent_target_id`)
    if (!seen.has(source) || !seen.has(target)) invalid(`Relation ${index + 1} references a missing target`)
    if (source === target) invalid(`Relation ${index + 1} cannot be self-referential`)
    const id = boundedText(relation.relation_id, `Relation ${index + 1} relation_id`, 512, true)
    if (relationIds.has(id)) invalid(`Relation ${id} is duplicated`)
    relationIds.add(id)
    const relationType = boundedText(relation.relation_type, `Relation ${id} relation_type`, 120, true)
    if (!RELATION_TYPES.has(relationType)) invalid(`Relation ${id} relation_type is not supported`)
    return {
      id,
      source,
      target,
      relationType,
    }
  })
  const prerequisiteEdges = edges.filter((edge) => PREREQUISITE_RELATION_TYPES.has(edge.relationType))
  const layers = graphLayers(nodes, prerequisiteEdges)
  const prerequisiteIds = new Map(nodes.map((node) => [node.nodeId, []]))
  for (const edge of prerequisiteEdges) prerequisiteIds.get(edge.target).push(edge.source)

  return {
    schemaId: "galaxy.proof-dag.v1",
    graphId,
    graphKind,
    title: boundedText(input.title, "Proof DAG title", 200) || graphId,
    contentSha256: digest,
    taskResourceBinding: "content-hash",
    coordinationGraphRef: null,
    nodes: nodes.map((node) => ({
      ...node,
      layer: layers.get(node.nodeId),
      prerequisiteNodeIds: prerequisiteIds.get(node.nodeId),
    })),
    edges,
  }
}

function parseClaim(input, label) {
  if (input === null || input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object or null`)
  const nostrPubkey = typeof input.nostr_pubkey === "string" && NOSTR_PUBKEY.test(input.nostr_pubkey)
    ? input.nostr_pubkey
    : invalid(`${label}.nostr_pubkey must be a lowercase 64-character hex key`)
  const claimedAt = requireTimestamp(input.claimed_at, `${label}.claimed_at`)
  const expiresAt = requireTimestamp(input.expires_at, `${label}.expires_at`)
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) invalid(`${label}.expires_at must be after claimed_at`)
  return {
    claimId: requireIdentifier(input.claim_id, `${label}.claim_id`),
    nostrPubkey,
    claimedAt,
    expiresAt,
  }
}

function parseAuthority(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object`)
  if (typeof input.principal_id !== "string" || !UUID.test(input.principal_id)) invalid(`${label}.principal_id must be a UUID`)
  if (typeof input.nostr_pubkey !== "string" || !NOSTR_PUBKEY.test(input.nostr_pubkey)) {
    invalid(`${label}.nostr_pubkey must be a lowercase 64-character hex key`)
  }
  if (!["human", "agent", "service"].includes(input.principal_kind)) invalid(`${label}.principal_kind is invalid`)
  return {
    principalId: input.principal_id,
    nostrPubkey: input.nostr_pubkey,
    principalKind: input.principal_kind,
  }
}

function parseVerification(input, label) {
  if (input === null || input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object or null`)
  if (!["hyades-run", "lean-replay", "signed-report"].includes(input.method)) invalid(`${label}.method is invalid`)
  const hyades = input.hyades && typeof input.hyades === "object" && !Array.isArray(input.hyades) ? {
    workflowId: boundedText(input.hyades.workflow_id, `${label}.hyades.workflow_id`, 200, true),
    runId: boundedText(input.hyades.run_id, `${label}.hyades.run_id`, 200, true),
    status: boundedText(input.hyades.status, `${label}.hyades.status`, 80, true),
  } : null
  if (input.method === "hyades-run" && !hyades) invalid(`${label}.hyades is required for hyades-run`)
  if (input.method !== "hyades-run" && hyades) invalid(`${label}.hyades is invalid for ${input.method}`)
  const outcome = boundedText(input.outcome, `${label}.outcome`, 40, true)
  if (input.method === "hyades-run") {
    const terminalStatuses = outcome === "accepted" ? ["completed"] : ["completed", "failed"]
    if (!terminalStatuses.includes(hyades.status)) invalid(`${label}.hyades.status must be terminal for its outcome`)
  }
  return {
    method: input.method,
    authority: parseAuthority(input.authority, `${label}.authority`),
    receiptId: requireIdentifier(input.receipt_id, `${label}.receipt_id`),
    receiptSha256: requireSha256(input.receipt_sha256, `${label}.receipt_sha256`),
    outcome,
    solutionSha256: requireSha256(input.solution_sha256, `${label}.solution_sha256`),
    sourceCommit: requireGitOid(input.source_commit, `${label}.source_commit`),
    leanToolchain: boundedText(input.lean_toolchain, `${label}.lean_toolchain`, 200, true),
    mathlibRevision: requireGitOid(input.mathlib_revision, `${label}.mathlib_revision`),
    sorryFree: input.sorry_free === true,
    verifiedAt: requireTimestamp(input.verified_at, `${label}.verified_at`),
    hyades,
  }
}

function parseAttestation(input, label) {
  if (input === null || input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object or null`)
  if (input.method !== "external-attestation") invalid(`${label}.method must be external-attestation`)
  return {
    method: "external-attestation",
    authority: parseAuthority(input.authority, `${label}.authority`),
    statement: boundedText(input.statement, `${label}.statement`, 2_000, true),
    evidenceSha256: input.evidence_sha256 ? requireSha256(input.evidence_sha256, `${label}.evidence_sha256`) : null,
    attestedAt: requireTimestamp(input.attested_at, `${label}.attested_at`),
  }
}

function parseOverride(input, label) {
  if (input === null || input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object or null`)
  const authority = parseAuthority(input.authority, `${label}.authority`)
  if (authority.principalKind !== "human") invalid(`${label}.authority must be human`)
  return {
    authority,
    reason: boundedText(input.reason, `${label}.reason`, 2_000, true),
    evidenceSha256: input.evidence_sha256 ? requireSha256(input.evidence_sha256, `${label}.evidence_sha256`) : null,
    overriddenAt: requireTimestamp(input.overridden_at, `${label}.overridden_at`),
  }
}

function parseCandidateProvenance(input, label) {
  if (input === null || input === undefined) return null
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${label} must be an object or null`)
  return {
    sourceCommit: requireGitOid(input.source_commit, `${label}.source_commit`),
    leanToolchain: boundedText(input.lean_toolchain, `${label}.lean_toolchain`, 200, true),
    mathlibRevision: requireGitOid(input.mathlib_revision, `${label}.mathlib_revision`),
  }
}

export function parseProofWorkState(input, proofDag) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Proof work state must be a JSON object")
  rejectSensitiveFields(input)
  if (input.schema_id !== "galaxy.proof-work-state.v1") invalid("Proof work state must use galaxy.proof-work-state.v1")
  if (!input.graph_ref || typeof input.graph_ref !== "object" || Array.isArray(input.graph_ref)) invalid("Proof work state graph_ref is required")
  const graphId = requireIdentifier(input.graph_ref.graph_id, "Proof work state graph_ref.graph_id")
  const contentSha256 = requireSha256(input.graph_ref.content_sha256, "Proof work state graph_ref.content_sha256")
  const coordinationGraphRef = proofDag.coordinationGraphRef || {
    graphId: proofDag.graphId,
    contentSha256: proofDag.contentSha256,
  }
  if (graphId !== coordinationGraphRef.graphId || contentSha256 !== coordinationGraphRef.contentSha256) {
    invalid("Proof work state does not match the immutable proof DAG")
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) invalid("Proof work state version must be a positive integer")
  const updatedAt = requireTimestamp(input.updated_at, "Proof work state updated_at")
  if (!Array.isArray(input.items) || input.items.length > proofDag.nodes.length) invalid("Proof work state items exceed the proof DAG")
  const nodeIds = new Set(proofDag.nodes.map((node) => node.nodeId))
  const seen = new Set()
  const items = input.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid(`Work item ${index + 1} must be an object`)
    const nodeId = requireIdentifier(item.node_id, `Work item ${index + 1} node_id`)
    if (!nodeIds.has(nodeId)) invalid(`Work item ${nodeId} is not in the proof DAG`)
    if (seen.has(nodeId)) invalid(`Work item ${nodeId} is duplicated`)
    seen.add(nodeId)
    if (!Number.isSafeInteger(item.version) || item.version < 1) invalid(`Work item ${nodeId} version must be a positive integer`)
    const work = item.work && typeof item.work === "object" && !Array.isArray(item.work) ? item.work : {}
    const proof = item.proof && typeof item.proof === "object" && !Array.isArray(item.proof) ? item.proof : {}
    if (!WORK_STATUSES.has(work.status)) invalid(`Work item ${nodeId} has an invalid work status`)
    if (!PROOF_STATUSES.has(proof.status)) invalid(`Work item ${nodeId} has an invalid proof status`)
    const claim = parseClaim(work.claim, `Work item ${nodeId}.work.claim`)
    const hyades = work.hyades && typeof work.hyades === "object" && !Array.isArray(work.hyades) ? {
      workflowId: boundedText(work.hyades.workflow_id, `Work item ${nodeId}.work.hyades.workflow_id`, 200),
      runId: boundedText(work.hyades.run_id, `Work item ${nodeId}.work.hyades.run_id`, 200),
      status: boundedText(work.hyades.status, `Work item ${nodeId}.work.hyades.status`, 80),
    } : null
    const candidateSha256 = proof.candidate_sha256 === null || proof.candidate_sha256 === undefined
      ? null
      : requireSha256(proof.candidate_sha256, `Work item ${nodeId}.proof.candidate_sha256`)
    const verification = parseVerification(proof.verification, `Work item ${nodeId}.proof.verification`)
    const attestation = parseAttestation(proof.attestation, `Work item ${nodeId}.proof.attestation`)
    const override = parseOverride(proof.override, `Work item ${nodeId}.proof.override`)
    const candidateProvenance = parseCandidateProvenance(
      proof.candidate_provenance,
      `Work item ${nodeId}.proof.candidate_provenance`,
    )
    const candidateAuthority = proof.candidate_authority
      ? parseAuthority(proof.candidate_authority, `Work item ${nodeId}.proof.candidate_authority`)
      : null
    const candidateSubmittedAt = proof.candidate_submitted_at
      ? requireTimestamp(proof.candidate_submitted_at, `Work item ${nodeId}.proof.candidate_submitted_at`)
      : null
    if (work.status === "claimed" && !claim) invalid(`Work item ${nodeId} claimed status requires a claim lease`)
    if (work.status === "running" && !hyades?.runId) invalid(`Work item ${nodeId} running status requires a Hyades run`)
    if (verification && candidateSha256 !== verification.solutionSha256) {
      invalid(`Work item ${nodeId} verification does not match proof.candidate_sha256`)
    }
    if (proof.status === "verified" && !(
      verification?.outcome === "accepted" && verification.sorryFree === true
    )) invalid(`Work item ${nodeId} verified status requires an accepted sorry-free verifier receipt`)
    if (proof.status === "rejected" && verification?.outcome !== "rejected") {
      invalid(`Work item ${nodeId} rejected status requires a rejected verifier receipt`)
    }
    if (proof.status === "attested" && !attestation) invalid(`Work item ${nodeId} attested status requires an attestation`)
    if (proof.status === "overridden" && !override) invalid(`Work item ${nodeId} overridden status requires an owner override`)
    return {
      nodeId,
      version: item.version,
      work: {
        status: work.status,
        claim,
        hyades,
        blocker: boundedText(work.blocker, `Work item ${nodeId}.work.blocker`, 1_000),
        taskId: boundedText(work.task_id, `Work item ${nodeId}.work.task_id`, 200),
        linkedTaskCount: Number.isSafeInteger(work.linked_task_count) && work.linked_task_count >= 0 ? work.linked_task_count : 0,
      },
      proof: {
        status: proof.status,
        candidateSha256,
        candidateProvenance,
        candidateAuthority,
        candidateSubmittedAt,
        attestation,
        verification,
        override,
      },
      external: item.external && typeof item.external === "object" && !Array.isArray(item.external) ? item.external : {},
    }
  })
  return {
    schemaId: "galaxy.proof-work-state.v1",
    workspaceId: requireIdentifier(input.workspace_id, "Proof work state workspace_id"),
    graphRef: { graphId, contentSha256 },
    version: input.version,
    updatedAt,
    items,
  }
}

function isVerified(item) {
  const verification = item?.proof.verification
  return item?.proof.status === "verified"
    && verification?.authority?.principalKind === "agent"
    && verification.outcome === "accepted"
    && verification.sorryFree === true
    && item.proof.candidateSha256 === verification.solutionSha256
}

function isOwnerOverride(item) {
  return item?.proof.status === "overridden"
    && item?.proof.override?.authority?.principalKind === "human"
    && Boolean(item?.proof.candidateSha256)
}

function satisfiesPrerequisite(item) {
  return isVerified(item) || isOwnerOverride(item)
}

function activeRun(item) {
  return Boolean(item?.work.hyades?.runId && ["pending", "queued", "running", "verifying"].includes(item.work.hyades.status))
}

function activeClaim(item, snapshotAt) {
  return Boolean(item?.work.status === "claimed" && item.work.claim && Date.parse(item.work.claim.expiresAt) > Date.parse(snapshotAt))
}

export function projectProofTaskGraph(proofDag, workStateInput) {
  const workState = workStateInput.schemaId === "galaxy.proof-work-state.v1"
    ? workStateInput
    : parseProofWorkState(workStateInput, proofDag)
  const coordinationGraphRef = proofDag.coordinationGraphRef || {
    graphId: proofDag.graphId,
    contentSha256: proofDag.contentSha256,
  }
  if (workState.graphRef.graphId !== coordinationGraphRef.graphId || workState.graphRef.contentSha256 !== coordinationGraphRef.contentSha256) {
    invalid("Proof work state does not match the immutable proof DAG")
  }
  const itemByNode = new Map(workState.items.map((item) => [item.nodeId, item]))
  const claimableGraph = CLAIMABLE_GRAPH_KINDS.has(proofDag.graphKind)
  const nodeById = new Map()
  for (const node of proofDag.nodes) {
    const workItem = itemByNode.get(node.nodeId) || null
    const unmet = node.prerequisiteNodeIds.filter((id) => !satisfiesPrerequisite(itemByNode.get(id)))
    let state = claimableGraph ? "available" : "reference"
    let coordinationLabel = claimableGraph
      ? "Available to claim"
      : "Reference corpus; select an explicit mission to claim"
    // Repository fields and other passive graph kinds are navigable proof
    // corpora, not implicit missions. Ignore operational overlays until an
    // explicit campaign/mission binds the selected prerequisite closure.
    if (claimableGraph) {
      if (isVerified(workItem)) {
        state = "completed"
        coordinationLabel = {
          "hyades-run": "Lean verified by Hyades",
          "lean-replay": "Lean verified by an approved replay agent",
          "signed-report": "Lean verified by proofs.blah.dev (signed report)",
        }[workItem.proof.verification.method]
      } else if (isOwnerOverride(workItem)) {
        state = "overridden"
        coordinationLabel = "Accepted by explicit owner override"
      } else if (activeRun(workItem)) {
        state = "running"
        coordinationLabel = "Hyades verification running"
      } else if (activeClaim(workItem, workState.updatedAt)) {
        state = "claimed"
        coordinationLabel = "Active claim lease"
      } else if (workItem?.work.status === "blocked" || workItem?.work.blocker) {
        state = "blocked"
        coordinationLabel = workItem.work.blocker || "Work blocked"
      } else if (unmet.length) {
        state = "waiting"
        coordinationLabel = `Prerequisites: ${unmet.join(", ")}`
      } else if (workItem?.proof.status === "attested") {
        state = "attested"
        coordinationLabel = "External attestation recorded; verification pending"
      }
    }
    nodeById.set(node.nodeId, {
      ...node,
      packetId: node.nodeId,
      prerequisitePacketIds: node.prerequisiteNodeIds,
      workItem,
      state,
      coordinationLabel,
    })
  }
  return { programId: proofDag.graphId, proofDag, workState, nodes: [...nodeById.values()], edges: proofDag.edges }
}

export function proofDagFromHamManifest(manifest, contentSha256) {
  const graphRef = manifest.galaxyProofGraphRef
  const artifact = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: graphRef?.graphId || manifest.programId,
    graph_kind: "campaign",
    title: graphRef?.graphId || manifest.programId,
    targets: manifest.packets.map((packet) => ({
      target_id: packet.packetId,
      target_kind: "proof-packet",
      title: packet.title,
      natural_language_summary: packet.objective,
    })),
    relations: manifest.packets.flatMap((packet) => packet.prerequisitePacketIds.map((prerequisiteId) => ({
      relation_id: `${prerequisiteId}->${packet.packetId}`,
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: prerequisiteId,
      dependent_target_id: packet.packetId,
    }))),
  }
  // This is a deterministic projection of the HAM manifest, not the registered
  // Galaxy DAG bytes themselves. The caller-supplied digest identifies that
  // source manifest and stays separate from the exact graph revision that
  // authorizes proof-task coordination.
  const proofDag = parseProofDag(artifact, contentSha256)
  proofDag.taskResourceBinding = graphRef ? "content-hash" : "legacy-program"
  proofDag.coordinationGraphRef = graphRef
  const packetById = new Map(manifest.packets.map((packet) => [packet.packetId, packet]))
  proofDag.nodes = proofDag.nodes.map((node) => ({ ...node, ...packetById.get(node.nodeId) }))
  return proofDag
}

export function proofWorkStateFromHamTasks(proofDag, tasks = []) {
  const mapped = new Map()
  for (const task of tasks) {
    for (const resource of task.resources || []) {
      if (resource.redacted !== false || resource.mode !== "observe" || resource.status !== "active") continue
      const reference = parseProofTaskResourceRef(resource.resourceRef)
      if (!reference || reference.programId !== proofDag.graphId) continue
      if (proofDag.taskResourceBinding === "legacy-program") {
        if (reference.contentSha256 !== null) continue
      } else if (reference.contentSha256 !== (
        proofDag.coordinationGraphRef?.contentSha256 || proofDag.contentSha256
      )) continue
      mapped.set(reference.packetId, [...(mapped.get(reference.packetId) || []), task])
    }
  }
  const updatedAt = tasks.map((task) => task.updatedAt).filter(Boolean).sort().at(-1) || "1970-01-01T00:00:00Z"
  return {
    schemaId: "galaxy.proof-work-state.v1",
    workspaceId: proofDag.graphId,
    graphRef: {
      graphId: proofDag.coordinationGraphRef?.graphId || proofDag.graphId,
      contentSha256: proofDag.coordinationGraphRef?.contentSha256 || proofDag.contentSha256,
    },
    version: 1,
    updatedAt,
    items: [...mapped.entries()].map(([nodeId, matchingTasks]) => {
      const task = newestTask(matchingTasks)
      const run = task.activeRun
      const blocked = ["blocked", "failed", "stalled", "cancelled"].includes(task.state)
      return {
        nodeId,
        version: task.version || 1,
        work: {
          status: run ? "running" : blocked ? "blocked" : task.state === "completed" ? "closed" : "idle",
          claim: null,
          hyades: run ? { workflowId: "", runId: run.id, status: run.status } : null,
          blocker: blocked ? task.stage || "Task blocked" : "",
          taskId: task.id,
          linkedTaskCount: matchingTasks.length,
        },
        proof: { status: "open", candidateSha256: null, verification: null },
        external: {},
      }
    }),
  }
}

export async function sha256Text(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function parseProofTaskManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Manifest must be a JSON object")
  if (input.schema_id !== "ham.audit-program.v3") invalid("Manifest must use ham.audit-program.v3")
  const linkedProgram = input.galaxy_proof_graph_ref !== undefined && input.galaxy_proof_graph_ref !== null
  const programIdPattern = linkedProgram ? PROOF_GRAPH_IDENTIFIER : IDENTIFIER
  if (typeof input.program_id !== "string" || !programIdPattern.test(input.program_id)) invalid("Manifest program_id is invalid")
  if (!Array.isArray(input.packets) || input.packets.length === 0) invalid("Manifest must contain at least one packet")
  if (input.packets.length > 5_000) invalid("This graph view supports at most 5,000 packets")
  const galaxyProofGraphRef = parseGalaxyProofGraphRef(input.galaxy_proof_graph_ref, input.program_id)

  const ids = new Set()
  const packets = input.packets.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`Packet ${index + 1} must be an object`)
    const packetId = raw.packet_id
    if (typeof packetId !== "string" || !IDENTIFIER.test(packetId)) invalid(`Packet ${index + 1} packet_id is invalid`)
    if (ids.has(packetId)) invalid(`Packet ID ${packetId} is duplicated`)
    ids.add(packetId)
    const prerequisites = raw.prerequisite_packet_ids ?? []
    if (!Array.isArray(prerequisites) || prerequisites.length > 500) {
      invalid(`Packet ${packetId} prerequisite_packet_ids must contain at most 500 entries`)
    }
    const prerequisitePacketIds = prerequisites.map((value) => {
      if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`Packet ${packetId} has an invalid prerequisite ID`)
      return value
    })
    if (new Set(prerequisitePacketIds).size !== prerequisitePacketIds.length) {
      invalid(`Packet ${packetId} repeats a prerequisite`)
    }
    return {
      packetId,
      title: boundedText(raw.title, `Packet ${packetId} title`, 200) || packetId,
      objective: boundedText(raw.objective, `Packet ${packetId} objective`, 4_000, true),
      prerequisitePacketIds,
      theoremTargets: parseTextObjects(raw.theorem_targets, packetId, "theorem_targets", "statement", 50),
      mandatoryControls: parseTextObjects(raw.mandatory_controls, packetId, "mandatory_controls", "requirement", 50),
    }
  })

  for (const packet of packets) {
    for (const prerequisiteId of packet.prerequisitePacketIds) {
      if (!ids.has(prerequisiteId)) invalid(`Packet ${packet.packetId} depends on missing packet ${prerequisiteId}`)
      if (prerequisiteId === packet.packetId) invalid(`Packet ${packet.packetId} cannot depend on itself`)
    }
  }

  topologicalLayers(packets)

  return { schemaId: input.schema_id, programId: input.program_id, galaxyProofGraphRef, packets }
}

export function proofTaskResourceRef(programId, packetId, contentSha256 = null) {
  if (!TASK_RESOURCE_COMPONENT.test(programId) || !TASK_RESOURCE_COMPONENT.test(packetId)) {
    invalid("Proof program or packet ID cannot be represented as a HAM resource key")
  }
  if (contentSha256 !== null && contentSha256 !== undefined) {
    const digest = requireSha256(contentSha256, "Proof DAG content hash")
    const reference = `proof-packet:sha256:${digest}/${programId}/${packetId}`
    if (reference.length > TASK_RESOURCE_MAXIMUM) invalid("Proof packet reference exceeds the HAM resource key boundary")
    return reference
  }
  return `proof-packet:${programId}/${packetId}`
}

export function parseProofTaskResourceRef(value) {
  if (typeof value !== "string" || value.length > TASK_RESOURCE_MAXIMUM || !value.startsWith("proof-packet:")) return null
  const parts = value.slice("proof-packet:".length).split("/")
  if (parts.length === 2 && TASK_RESOURCE_COMPONENT.test(parts[0]) && TASK_RESOURCE_COMPONENT.test(parts[1])) {
    return { programId: parts[0], packetId: parts[1], contentSha256: null }
  }
  if (
    parts.length === 3
    && parts[0].startsWith("sha256:")
    && SHA256.test(parts[0].slice("sha256:".length))
    && TASK_RESOURCE_COMPONENT.test(parts[1])
    && TASK_RESOURCE_COMPONENT.test(parts[2])
  ) {
    return { programId: parts[1], packetId: parts[2], contentSha256: parts[0].slice("sha256:".length) }
  }
  return null
}

function newestTask(tasks) {
  return [...tasks].sort((left, right) => {
    const time = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
    return time || String(right.id).localeCompare(String(left.id))
  })[0]
}

export function buildProofTaskGraph(manifest, tasks = []) {
  const proofDag = proofDagFromHamManifest(manifest, "0".repeat(64))
  return projectProofTaskGraph(proofDag, proofWorkStateFromHamTasks(proofDag, tasks))
}
