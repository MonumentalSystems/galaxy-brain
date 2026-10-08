import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  compileProofMission,
  PROOF_MISSION_COMPILER_LIMITS,
} from "../lib/proof-mission-compiler.js"
import { parseProofDag } from "../lib/proof-task-graph.js"

function digest(document) {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex")
}

function exactBytes(document) {
  return new TextEncoder().encode(JSON.stringify(document))
}

function repositoryField(overrides = {}) {
  return {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "leanproofs",
    graph_kind: "repository-field",
    title: "LeanProofs repository field",
    targets: [
      { target_id: "foundation", title: "Foundation", target_kind: "definition", natural_language_summary: "Set up the definitions.", category: "proved", formal_binding: { status: "mapped" } },
      { target_id: "bridge", title: "Bridge lemma", target_kind: "lemma", natural_language_summary: "Bridge the definitions.", category: "open", formal_binding: { status: "mapped" } },
      { target_id: "main", title: "Main theorem", target_kind: "theorem", natural_language_summary: "Prove the main theorem.", category: "open", formal_binding: { status: "unmapped" } },
      { target_id: "unrelated", title: "Unrelated theorem", target_kind: "theorem", natural_language_summary: "Not in this mission.", category: "proved", formal_binding: { status: "mapped" } },
    ],
    relations: [
      { relation_id: "r-foundation", relation_type: "USES", prerequisite_target_id: "foundation", dependent_target_id: "bridge" },
      { relation_id: "r-main", relation_type: "REDUCES_TO", prerequisite_target_id: "bridge", dependent_target_id: "main" },
      { relation_id: "r-milestone", relation_type: "MILESTONE_OF", prerequisite_target_id: "bridge", dependent_target_id: "main" },
      { relation_id: "r-promotion", relation_type: "PROMOTED_TO", prerequisite_target_id: "foundation", dependent_target_id: "bridge" },
    ],
    ...overrides,
  }
}

function compile(source = repositoryField(), overrides = {}) {
  return compileProofMission({
    sourceProofDagBytes: exactBytes(source),
    missionId: "prove-main-v1",
    mainTargetId: "main",
    milestoneTargetIds: ["bridge"],
    relationDirection: "prerequisite-to-dependent",
    ...overrides,
  })
}

test("deterministically compiles the exact prerequisite closure into an immutable mission", async () => {
  const source = repositoryField()
  const first = await compile(source)
  const second = await compile(source)
  const firstMission = first.mission_dag

  assert.deepEqual(first, second)
  assert.equal(first.schema_id, "galaxy.proof-mission-draft.v1")
  assert.equal(firstMission.graph_kind, "mission")
  assert.equal(first.selection.main_target_id, "main")
  assert.deepEqual(first.selection.curated_milestone_target_ids, ["bridge"])
  assert.equal(firstMission.mission.main_target_id, "main")
  assert.deepEqual(firstMission.targets.map((target) => target.target_id), ["bridge", "foundation", "main"])
  assert.deepEqual(firstMission.relations.map((relation) => relation.relation_id), [
    "r-foundation",
    "r-main",
    "r-milestone",
    "r-promotion",
  ])
  assert.deepEqual(first.source_graph, {
    graph_id: "leanproofs",
    graph_kind: "repository-field",
    content_sha256: digest(source),
  })

  assert.throws(
    () => parseProofDag(first, digest(first)),
    /must use galaxy\.proof-dag\.v1/u,
    "the generic proof registry parser must reject non-registerable draft bytes",
  )
  const parsed = parseProofDag(firstMission, digest(firstMission))
  assert.equal(parsed.graphKind, "mission")
  assert.deepEqual(parsed.nodes.find((node) => node.nodeId === "main").prerequisiteNodeIds, ["bridge"])
})

test("canonicalizes milestone permutations to the same mission document", async () => {
  const forward = await compile(repositoryField(), { milestoneTargetIds: ["foundation", "bridge"] })
  const reverse = await compile(repositoryField(), { milestoneTargetIds: ["bridge", "foundation"] })

  assert.deepEqual(forward, reverse)
  assert.deepEqual(forward.selection.curated_milestone_target_ids, ["bridge", "foundation"])
})

test("retains authoritative typed edges without turning milestones or promotion into prerequisites", async () => {
  const { mission_dag: mission } = await compile()
  const parsed = parseProofDag(mission, digest(mission))
  assert.deepEqual(parsed.nodes.find((node) => node.nodeId === "bridge").prerequisiteNodeIds, ["foundation"])
  assert.deepEqual(parsed.nodes.find((node) => node.nodeId === "main").prerequisiteNodeIds, ["bridge"])
  assert.equal(parsed.edges.find((edge) => edge.id === "r-milestone").relationType, "MILESTONE_OF")
  assert.equal(parsed.edges.find((edge) => edge.id === "r-promotion").relationType, "PROMOTED_TO")
})

test("materializes curated milestones as visible non-prerequisite edges with bounded collision-safe IDs", async () => {
  const source = repositoryField({
    relations: [
      { relation_id: "r-foundation", relation_type: "USES", prerequisite_target_id: "foundation", dependent_target_id: "bridge" },
      { relation_id: "r-main", relation_type: "REDUCES_TO", prerequisite_target_id: "bridge", dependent_target_id: "main" },
      { relation_id: "mission-milestone-000001", relation_type: "PROMOTED_TO", prerequisite_target_id: "foundation", dependent_target_id: "bridge" },
    ],
  })
  const { mission_dag: mission } = await compile(source)
  const milestone = mission.relations.find((relation) => (
    relation.relation_type === "MILESTONE_OF"
    && relation.prerequisite_target_id === "bridge"
    && relation.dependent_target_id === "main"
  ))

  assert.equal(milestone.relation_id, "mission-milestone-000002")
  assert.ok(milestone.relation_id.length <= 512)
  const parsed = parseProofDag(mission, digest(mission))
  assert.deepEqual(parsed.nodes.find((node) => node.nodeId === "main").prerequisiteNodeIds, ["bridge"])
})

test("copies only immutable structural fields and does not make provider identity canonical", async () => {
  const source = repositoryField()
  source.liveState = { main: { status: "claimed" } }
  source.claims = [{ node_id: "main" }]
  source.targets[2].work = { status: "running" }
  source.targets[2].external = { prove2me: { theorem_id: "remote-main", status: "claimed" } }
  source.relations[1].run = { run_id: "run-1" }
  source.relations[1].provider_status = "accepted"
  source.relations[1].unknown_metadata = { should_not: "survive" }

  const draft = await compile(source)
  const encoded = JSON.stringify(draft)
  assert.doesNotMatch(encoded, /liveState|claims|running|remote-main|prove2me|run-1|accepted|should_not/u)
  assert.equal(draft.mission_dag.provenance.compiler, "galaxy.proof-mission-compiler.v1")
})

test("preserves LeanProofs target bindings and edge correspondence metadata", async () => {
  const source = repositoryField()
  Object.assign(source.targets[1], {
    source_id: "concept:periodic-principal-flux",
    source_label: "Periodic principal flux interpolation",
    formal_binding: {
      status: "mapped",
      module_ids: ["LeanProofs.Winding.ProtoTime"],
      declaration_ids: [
        "LeanProofs.Winding.periodicPrincipalFlux",
        "LeanProofs.Winding.periodicPrincipalFlux_interpolation",
      ],
      binding_kind: "module-cohort",
      mapping_rule: "Every declaration in the authored cohort corresponds to this conceptual target.",
      declaration_equivalence_claimed: false,
      provider_status: "accepted",
      run: { run_id: "formal-binding-run" },
    },
  })
  Object.assign(source.relations[1], {
    source_edge_id: "authored:bridge->main",
    assertion_level: "bridge-candidate",
    formal_correspondence: {
      status: "bridge-candidate",
      support_kind: null,
      declaration_path: null,
      dependency_kinds_by_step: [["uses", "imports"], ["reduces-to"]],
      provider: "prove2me",
      receipt: { id: "receipt-should-not-survive" },
      secret: "should-not-survive",
    },
    bridge_nomination: {
      nominated: true,
      reason: "No direct declaration dependency was authored.",
      provider_status: "accepted",
      receipt: "receipt-should-not-survive",
    },
  })

  const { mission_dag: mission } = await compile(source)
  const bridge = mission.targets.find((target) => target.target_id === "bridge")
  assert.deepEqual(bridge, {
    target_id: "bridge",
    target_kind: "lemma",
    title: "Bridge lemma",
    natural_language_summary: "Bridge the definitions.",
    category: "open",
    source_id: "concept:periodic-principal-flux",
    source_label: "Periodic principal flux interpolation",
    formal_binding: {
      status: "mapped",
      module_ids: ["LeanProofs.Winding.ProtoTime"],
      declaration_ids: [
        "LeanProofs.Winding.periodicPrincipalFlux",
        "LeanProofs.Winding.periodicPrincipalFlux_interpolation",
      ],
      binding_kind: "module-cohort",
      mapping_rule: "Every declaration in the authored cohort corresponds to this conceptual target.",
      declaration_equivalence_claimed: false,
    },
  })
  const relation = mission.relations.find((candidate) => candidate.relation_id === "r-main")
  assert.equal(relation.source_edge_id, "authored:bridge->main")
  assert.equal(relation.assertion_level, "bridge-candidate")
  assert.deepEqual(relation.formal_correspondence, {
    status: "bridge-candidate",
    support_kind: null,
    declaration_path: null,
    dependency_kinds_by_step: [["uses", "imports"], ["reduces-to"]],
  })
  assert.deepEqual(relation.bridge_nomination, {
    nominated: true,
    reason: "No direct declaration dependency was authored.",
  })
  assert.doesNotMatch(JSON.stringify(relation), /prove2me|receipt|secret|accepted/u)
})

test("treats LeanProofs null bridge nominations as absent", async () => {
  const source = repositoryField()
  source.relations[1].bridge_nomination = null

  const { mission_dag: mission } = await compile(source)
  const relation = mission.relations.find((candidate) => candidate.relation_id === "r-main")
  assert.equal(Object.hasOwn(relation, "bridge_nomination"), false)
})

test("retains relation metadata after canonical relation-id whitespace normalization", async () => {
  const source = repositoryField()
  source.relations[1] = {
    ...source.relations[1],
    relation_id: "  r-main  ",
    source_edge_id: "authored:bridge->main",
    assertion_level: "directly-supported",
    formal_correspondence: {
      status: "supported",
      support_kind: "kernel",
      declaration_path: ["LeanProofs.Winding.bridge", "LeanProofs.Winding.main"],
      dependency_kinds_by_step: [["uses"]],
    },
    bridge_nomination: null,
  }

  const { mission_dag: mission } = await compile(source)
  const relation = mission.relations.find((candidate) => candidate.relation_id === "r-main")
  assert.equal(relation.source_edge_id, "authored:bridge->main")
  assert.equal(relation.assertion_level, "directly-supported")
  assert.deepEqual(relation.formal_correspondence, {
    status: "supported",
    support_kind: "kernel",
    declaration_path: ["LeanProofs.Winding.bridge", "LeanProofs.Winding.main"],
    dependency_kinds_by_step: [["uses"]],
  })
  assert.equal(Object.hasOwn(relation, "bridge_nomination"), false)
})

test("validates actual LeanProofs formal binding fields without generic passthrough", async () => {
  const wrongBoolean = repositoryField()
  wrongBoolean.targets[1].formal_binding = {
    status: "mapped",
    declaration_equivalence_claimed: "false",
  }
  await assert.rejects(
    () => compile(wrongBoolean),
    /declaration_equivalence_claimed must be boolean/u,
  )

  const oversizedRule = repositoryField()
  oversizedRule.targets[1].formal_binding = {
    status: "mapped",
    mapping_rule: "x".repeat(4_001),
  }
  await assert.rejects(
    () => compile(oversizedRule),
    /mapping_rule exceeds 4000 characters/u,
  )
})

test("drops unknown correspondence fields and rejects malformed allowlisted fields", async () => {
  const source = repositoryField()
  source.relations[1].formal_correspondence = {
    status: "supported",
    support_kind: "kernel",
    declaration_path: ["LeanProofs.Winding.bridge", "LeanProofs.Winding.main"],
    dependency_kinds_by_step: [["uses"]],
    live_state: { work: "claimed" },
  }
  const { mission_dag: mission } = await compile(source)
  const relation = mission.relations.find((candidate) => candidate.relation_id === "r-main")
  assert.doesNotMatch(JSON.stringify(relation), /live_state|claimed/u)

  source.relations[1].formal_correspondence.dependency_kinds_by_step = ["uses"]
  await assert.rejects(
    () => compile(source),
    /dependency_kinds_by_step\[0\] must contain/u,
  )
})

test("fails closed for active sources, dangling identifiers, cycles, and unknown relation types", async () => {
  await assert.rejects(
    () => compile(repositoryField({ graph_kind: "mission" })),
    /passive repository-field/u,
  )
  await assert.rejects(
    () => compile(repositoryField({
      relations: [{ relation_id: "dangling", relation_type: "DEPENDS_ON", prerequisite_target_id: "missing", dependent_target_id: "main" }],
    })),
    /missing target/u,
  )
  await assert.rejects(
    () => compile(repositoryField({
      relations: [
        { relation_id: "forward", relation_type: "DEPENDS_ON", prerequisite_target_id: "bridge", dependent_target_id: "main" },
        { relation_id: "back", relation_type: "DEPENDS_ON", prerequisite_target_id: "main", dependent_target_id: "bridge" },
      ],
    })),
    /dependency cycle/u,
  )
  await assert.rejects(
    () => compile(repositoryField({
      relations: [{ relation_id: "typo", relation_type: "DEPEND_ON", prerequisite_target_id: "bridge", dependent_target_id: "main" }],
    })),
    /relation_type is not supported/u,
  )
})

test("makes edge direction explicit while allowing reusable and foundational targets", async () => {
  await assert.rejects(
    () => compile(repositoryField(), { relationDirection: "dependent-to-prerequisite" }),
    /must explicitly be prerequisite-to-dependent/u,
  )
  await assert.rejects(
    () => compile(repositoryField(), { mainTargetId: "missing", milestoneTargetIds: [] }),
    /not in the source proof DAG/u,
  )

  const reusableIntermediate = await compile(repositoryField(), {
    mainTargetId: "bridge",
    milestoneTargetIds: [],
    missionId: "prove-bridge-v1",
  })
  assert.deepEqual(
    reusableIntermediate.mission_dag.targets.map((target) => target.target_id),
    ["bridge", "foundation"],
    "an explicit theorem with prerequisites can be a mission target even when another theorem reuses it",
  )

  const foundationMission = await compile(repositoryField(), {
    mainTargetId: "foundation",
    milestoneTargetIds: [],
    missionId: "prove-foundation-v1",
  })
  assert.deepEqual(foundationMission.mission_dag.targets.map((target) => target.target_id), ["foundation"])
})

test("requires curated milestones to be unique members of the selected closure", async () => {
  await assert.rejects(
    () => compile(repositoryField(), { milestoneTargetIds: ["unrelated"] }),
    /outside the main target prerequisite closure/u,
  )
  await assert.rejects(
    () => compile(repositoryField(), { milestoneTargetIds: ["bridge", "bridge"] }),
    /is duplicated/u,
  )
  await assert.rejects(
    () => compile(repositoryField(), { milestoneTargetIds: ["main"] }),
    /cannot also be a curated milestone/u,
  )
})

test("fails rather than truncating a closure beyond the mission target bound", async () => {
  const targetCount = PROOF_MISSION_COMPILER_LIMITS.targets + 1
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    target_id: `target-${index}`,
    title: `Target ${index}`,
  }))
  const relations = Array.from({ length: targetCount - 1 }, (_, index) => ({
    relation_id: `relation-${index}`,
    relation_type: "DEPENDS_ON",
    prerequisite_target_id: `target-${index}`,
    dependent_target_id: `target-${index + 1}`,
  }))
  const source = repositoryField({ targets, relations })

  await assert.rejects(
    () => compile(source, {
      mainTargetId: `target-${targetCount - 1}`,
      milestoneTargetIds: [],
    }),
    /closure exceeds 2000 targets/u,
  )
})

test("fails rather than truncating milestone or relation bounds", async () => {
  await assert.rejects(
    () => compile(repositoryField(), {
      milestoneTargetIds: Array(PROOF_MISSION_COMPILER_LIMITS.milestones + 1).fill("bridge"),
    }),
    /milestones exceed 500/u,
  )

  const relations = Array.from({ length: PROOF_MISSION_COMPILER_LIMITS.relations + 1 }, (_, index) => ({
    relation_id: `relation-${index}`,
    relation_type: "DEPENDS_ON",
    prerequisite_target_id: "foundation",
    dependent_target_id: "main",
  }))
  await assert.rejects(
    () => compile(repositoryField({ relations }), { milestoneTargetIds: [] }),
    /relations exceed 10000/u,
  )
})

test("binds provenance to an internal digest of the exact snapshotted source bytes", async () => {
  const source = repositoryField()
  const sourceBytes = exactBytes(source)
  const expectedDigest = createHash("sha256").update(sourceBytes).digest("hex")
  const compiling = compileProofMission({
    sourceProofDagBytes: sourceBytes,
    missionId: "prove-main-v1",
    mainTargetId: "main",
    milestoneTargetIds: ["bridge"],
    relationDirection: "prerequisite-to-dependent",
  })
  sourceBytes.fill(0)

  const mission = await compiling
  assert.equal(mission.source_graph.content_sha256, expectedDigest)

  const changedSource = repositoryField({ title: "One byte-distinct repository field" })
  const changedMission = await compile(changedSource)
  assert.equal(
    changedMission.source_graph.content_sha256,
    createHash("sha256").update(exactBytes(changedSource)).digest("hex"),
  )
  assert.notEqual(changedMission.source_graph.content_sha256, expectedDigest)
})

test("rejects non-bytes, invalid UTF-8 JSON, empty input, and oversized source artifacts", async () => {
  const base = {
    missionId: "prove-main-v1",
    mainTargetId: "main",
    milestoneTargetIds: [],
    relationDirection: "prerequisite-to-dependent",
  }
  await assert.rejects(
    () => compileProofMission({ ...base, sourceProofDagBytes: repositoryField() }),
    /must be exact UTF-8 bytes/u,
  )
  await assert.rejects(
    () => compileProofMission({ ...base, sourceProofDagBytes: new Uint8Array() }),
    /must contain 1 to/u,
  )
  await assert.rejects(
    () => compileProofMission({ ...base, sourceProofDagBytes: new Uint8Array([0xff]) }),
    /valid UTF-8 galaxy\.proof-dag\.v1 JSON/u,
  )
  await assert.rejects(
    () => compileProofMission({
      ...base,
      sourceProofDagBytes: new Uint8Array(PROOF_MISSION_COMPILER_LIMITS.sourceBytes + 1),
    }),
    /must contain 1 to/u,
  )
})

test("rejects unsupported compiler options instead of silently changing policy", async () => {
  const source = repositoryField()
  await assert.rejects(
    () => compileProofMission({
      sourceProofDagBytes: exactBytes(source),
      missionId: "prove-main-v1",
      mainTargetId: "main",
      milestoneTargetIds: [],
      relationDirection: "prerequisite-to-dependent",
      activateClaims: true,
    }),
    /activateClaims is not supported/u,
  )
})
