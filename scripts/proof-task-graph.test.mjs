import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

import { projectHamTaskPageForBrowser } from "../lib/ham-task-browser-projection.js"
import {
  forceLayoutProofGraph,
  proofCampaignNodeId,
  proofGraphNodeId,
} from "../lib/proof-force-layout.js"
import {
  buildProofTaskGraph,
  parseProofDag,
  parseProofTaskManifest,
  parseProofWorkState,
  parseProofTaskResourceRef,
  projectProofTaskGraph,
  proofDagFromHamManifest,
  proofTaskResourceRef,
  proofWorkStateFromHamTasks,
} from "../lib/proof-task-graph.js"

const GRAPH_HASH = "8ed0eb08bb39435ed4220945ab9e76c348e1475cb802b08e468472d89c09e9cc"
const RECEIPT_HASH = "14e3709fd83a1fc8649b31eec16e6116d70e6f56b9f2b518a91e17fa4b855847"
const SOLUTION_HASH = "8aa173d933692f25f05c423f742d76184ea6ac60c62f17d86cbf97495d8bd90d"
const VERIFIER_PUBKEY = "a".repeat(64)
const VERIFIER_PRINCIPAL_ID = "10000000-0000-4000-8000-000000000001"

async function retiredProofTaskRoute(user) {
  const source = await readFile(new URL("../app/api/proof-tasks/route.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  class NextResponse extends Response {
    static json(body, init) { return Response.json(body, init) }
  }
  const sandbox = {
    exports: {}, Response,
    require(name) {
      if (name === "next/server") return { NextResponse }
      if (name === "@/lib/auth") return { getCurrentUser: async () => user }
      throw new Error(`Retired proof-task route unexpectedly imported ${name}`)
    },
  }
  vm.runInNewContext(compiled, sandbox)
  return sandbox.exports.POST
}

const rawManifest = {
  schema_id: "ham.audit-program.v3",
  program_id: "vortex-proof-v1",
  packets: [
    {
      packet_id: "derive-helicity",
      title: "Derive helicity invariant",
      objective: "Derive the invariant under the frozen assumptions.",
      prerequisite_packet_ids: [],
      theorem_targets: [{ target_id: "T1", statement: "Prove helicity is conserved." }],
      mandatory_controls: [{ control_id: "C1", kind: "review", requirement: "Record every additional assumption." }],
    },
    {
      packet_id: "vortex-corollary",
      title: "Establish vortex corollary",
      objective: "Use the invariant to establish the scoped corollary.",
      prerequisite_packet_ids: ["derive-helicity"],
    },
  ],
}

function task(id, state, resourceRef, updatedAt = "2026-09-12T12:00:00Z") {
  return {
    id,
    title: id,
    goal: "goal",
    why: "why",
    state,
    lifecyclePhase: state === "completed" ? "terminal" : state === "claimed" ? "claimed" : "requested",
    stage: `Task ${state}`,
    riskMode: "test",
    expectedEffects: [],
    resources: [{ id: `${id}-resource`, resourceRef, redacted: false, mode: "observe", status: "active" }],
    conflicts: [],
    updatedAt,
    projectionSource: "ham",
  }
}

test("a locally valid campaign exposes only its initial ready frontier", () => {
  const manifest = parseProofTaskManifest(rawManifest)
  const graph = buildProofTaskGraph(manifest, [])
  assert.equal(manifest.galaxyProofGraphRef, null)
  assert.equal(graph.proofDag.taskResourceBinding, "legacy-program")
  assert.deepEqual(graph.edges, [{ id: "derive-helicity->vortex-corollary", source: "derive-helicity", target: "vortex-corollary", relationType: "DEPENDS_ON" }])
  assert.equal(graph.nodes.find((node) => node.packetId === "derive-helicity").state, "available")
  assert.equal(graph.nodes.find((node) => node.packetId === "vortex-corollary").state, "waiting")
  assert.equal(graph.nodes.find((node) => node.packetId === "vortex-corollary").layer, 1)
})

test("HAM v3 Galaxy provenance binds overlays to the exact registered DAG revision", () => {
  const manifest = parseProofTaskManifest({
    ...rawManifest,
    galaxy_proof_graph_ref: {
      schema_id: "galaxy.proof-graph-ref.v1",
      graph_id: rawManifest.program_id,
      content_sha256: GRAPH_HASH,
    },
  })
  assert.deepEqual(manifest.galaxyProofGraphRef, {
    schemaId: "galaxy.proof-graph-ref.v1",
    graphId: rawManifest.program_id,
    contentSha256: GRAPH_HASH,
  })

  const hamManifestHash = "b".repeat(64)
  const proofDag = proofDagFromHamManifest(manifest, hamManifestHash)
  assert.equal(proofDag.graphId, rawManifest.program_id)
  assert.equal(proofDag.contentSha256, hamManifestHash)
  assert.deepEqual(proofDag.coordinationGraphRef, {
    schemaId: "galaxy.proof-graph-ref.v1",
    graphId: rawManifest.program_id,
    contentSha256: GRAPH_HASH,
  })
  assert.equal(proofDag.taskResourceBinding, "content-hash")

  const exactResource = proofTaskResourceRef(proofDag.graphId, "derive-helicity", GRAPH_HASH)
  const manifestHashResource = proofTaskResourceRef(proofDag.graphId, "derive-helicity", hamManifestHash)
  assert.equal(proofWorkStateFromHamTasks(proofDag, [task("task-exact", "pending", exactResource)]).items.length, 1)
  assert.equal(proofWorkStateFromHamTasks(proofDag, [task("task-wrong", "pending", manifestHashResource)]).items.length, 0)

  const released = task("task-released", "completed", exactResource)
  released.resources[0].status = "released"
  const writable = task("task-write", "pending", exactResource)
  writable.resources[0].mode = "write"
  const redacted = task("task-redacted", "pending", exactResource)
  redacted.resources[0].redacted = true
  const missingDisclosure = task("task-missing-disclosure", "pending", exactResource)
  delete missingDisclosure.resources[0].redacted
  const malformedDisclosure = task("task-malformed-disclosure", "pending", exactResource)
  malformedDisclosure.resources[0].redacted = "false"
  assert.equal(proofWorkStateFromHamTasks(
    proofDag,
    [released, writable, redacted, missingDisclosure, malformedDisclosure],
  ).items.length, 0)
})

test("HAM v3 Galaxy provenance fails closed on schema, identity, and digest drift", () => {
  const graphRef = {
    schema_id: "galaxy.proof-graph-ref.v1",
    graph_id: rawManifest.program_id,
    content_sha256: GRAPH_HASH,
  }
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    galaxy_proof_graph_ref: { ...graphRef, schema_id: "galaxy.proof-graph-ref.v2" },
  }), /galaxy\.proof-graph-ref\.v1/)
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    galaxy_proof_graph_ref: { ...graphRef, graph_id: "another-program" },
  }), /must match program_id/)
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    galaxy_proof_graph_ref: { ...graphRef, content_sha256: GRAPH_HASH.toUpperCase() },
  }), /lowercase SHA-256/)
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    galaxy_proof_graph_ref: { ...graphRef, provider: "galaxy" },
  }), /unsupported field provider/)
  const namespaced = parseProofTaskManifest({
    ...rawManifest,
    program_id: "winding:prototime",
    galaxy_proof_graph_ref: { ...graphRef, graph_id: "winding:prototime" },
  })
  assert.equal(namespaced.programId, "winding:prototime")
  assert.equal(parseProofTaskManifest({ ...rawManifest, galaxy_proof_graph_ref: null }).galaxyProofGraphRef, null)
})

test("HAM task state overlays the proof DAG without becoming proof truth", () => {
  const manifest = parseProofTaskManifest(rawManifest)
  const firstRef = proofTaskResourceRef(manifest.programId, "derive-helicity")
  const graph = buildProofTaskGraph(manifest, [task("task-1", "completed", firstRef)])
  assert.equal(graph.nodes.find((node) => node.packetId === "derive-helicity").workItem.work.status, "closed")
  assert.equal(graph.nodes.find((node) => node.packetId === "derive-helicity").state, "available")
  assert.equal(graph.nodes.find((node) => node.packetId === "vortex-corollary").state, "waiting")
})

test("the compatibility adapter preserves task linkage without inventing signed claim leases", () => {
  const manifest = parseProofTaskManifest(rawManifest)
  const ref = proofTaskResourceRef(manifest.programId, "derive-helicity")
  const older = task("task-old", "pending", ref, "2026-09-12T11:00:00Z")
  const newer = { ...task("task-new", "claimed", ref), owner: { principalId: "agent:rosetta", label: "agent:rosetta" } }
  const node = buildProofTaskGraph(manifest, [older, newer]).nodes[0]
  assert.equal(node.workItem.work.taskId, "task-new")
  assert.equal(node.workItem.work.claim, null)
  assert.equal(node.state, "available")
  assert.equal(node.workItem.work.linkedTaskCount, 2)
  const completedNewer = { ...newer, state: "completed" }
  const graph = buildProofTaskGraph(manifest, [older, completedNewer])
  assert.equal(graph.nodes.find((item) => item.packetId === "vortex-corollary").state, "waiting")
})

test("failed HAM tasks do not rewrite proof prerequisites", () => {
  const manifest = parseProofTaskManifest(rawManifest)
  const ref = proofTaskResourceRef(manifest.programId, "derive-helicity")
  const graph = buildProofTaskGraph(manifest, [task("task-failed", "failed", ref)])
  const dependent = graph.nodes.find((node) => node.packetId === "vortex-corollary")
  assert.equal(graph.nodes.find((node) => node.packetId === "derive-helicity").state, "blocked")
  assert.equal(dependent.state, "waiting")
  assert.match(dependent.coordinationLabel, /derive-helicity/)
})

function nativeProofDag() {
  return parseProofDag({
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "vortex-proof-v1",
    graph_kind: "campaign",
    title: "Vortex proof",
    targets: [
      { target_id: "derive-helicity", title: "Derive helicity", natural_language_summary: "Derive the invariant." },
      { target_id: "vortex-corollary", title: "Vortex corollary", natural_language_summary: "Prove the corollary." },
    ],
    relations: [{
      relation_id: "derive-helicity->vortex-corollary",
      relation_type: "DEPENDS_ON",
      prerequisite_target_id: "derive-helicity",
      dependent_target_id: "vortex-corollary",
    }],
  }, GRAPH_HASH)
}

function nativeWorkState(proofDag, items, updatedAt = "2026-09-13T12:00:00Z") {
  return parseProofWorkState({
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: proofDag.graphId,
    graph_ref: { graph_id: proofDag.graphId, content_sha256: proofDag.contentSha256 },
    version: 1,
    updated_at: updatedAt,
    items,
  }, proofDag)
}

test("only an accepted sorry-free approved-verifier receipt verifies a proof and releases dependents", () => {
  const proofDag = nativeProofDag()
  const baseItem = {
    node_id: "derive-helicity",
    version: 3,
    work: { status: "closed", claim: null, hyades: null, blocker: null },
    proof: { status: "verified", candidate_sha256: SOLUTION_HASH, verification: {
      method: "hyades-run",
      authority: {
        principal_id: VERIFIER_PRINCIPAL_ID,
        nostr_pubkey: VERIFIER_PUBKEY,
        principal_kind: "agent",
      },
      receipt_id: "receipt-1",
      receipt_sha256: RECEIPT_HASH,
      outcome: "accepted",
      solution_sha256: SOLUTION_HASH,
      source_commit: "943394fca50273759c1d977938fffd58924004fd",
      lean_toolchain: "leanprover/lean4:v4.30.0",
      mathlib_revision: "95a9a85a904221c248d27b378420f7e1812375b1",
      sorry_free: true,
      verified_at: "2026-09-13T11:00:00Z",
      hyades: { workflow_id: "proof-workflow-v1", run_id: "run-1", status: "completed" },
    } },
    external: { prove2me: { status: null }, rosetta: { status: "registered" } },
  }
  const graph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [baseItem]))
  assert.equal(graph.nodes[0].state, "completed")
  assert.equal(graph.nodes[1].state, "available")

  const notAccepted = structuredClone(baseItem)
  notAccepted.proof.verification.outcome = "rejected"
  assert.throws(() => nativeWorkState(proofDag, [notAccepted]), /accepted sorry-free verifier receipt/)

  const mismatchedCandidate = structuredClone(baseItem)
  mismatchedCandidate.proof.candidate_sha256 = "0".repeat(64)
  assert.throws(() => nativeWorkState(proofDag, [mismatchedCandidate]), /does not match proof\.candidate_sha256/)
})

test("approved Lean replay and explicit owner override are distinct completion authorities", () => {
  const proofDag = nativeProofDag()
  const verified = {
    node_id: "derive-helicity",
    version: 2,
    work: { status: "closed", claim: null, hyades: null, blocker: null },
    proof: {
      status: "verified",
      candidate_sha256: SOLUTION_HASH,
      verification: {
        method: "lean-replay",
        authority: {
          principal_id: VERIFIER_PRINCIPAL_ID,
          nostr_pubkey: VERIFIER_PUBKEY,
          principal_kind: "agent",
        },
        receipt_id: "receipt-replay-1",
        receipt_sha256: RECEIPT_HASH,
        outcome: "accepted",
        solution_sha256: SOLUTION_HASH,
        source_commit: "943394fca50273759c1d977938fffd58924004fd",
        lean_toolchain: "leanprover/lean4:v4.30.0",
        mathlib_revision: "95a9a85a904221c248d27b378420f7e1812375b1",
        sorry_free: true,
        verified_at: "2026-09-13T11:00:00Z",
        hyades: null,
      },
      override: null,
    },
    external: {},
  }
  const replayGraph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [verified]))
  assert.equal(replayGraph.nodes[0].state, "completed")
  assert.match(replayGraph.nodes[0].coordinationLabel, /approved replay agent/)
  assert.equal(replayGraph.nodes[1].state, "available")

  const signed = structuredClone(verified)
  signed.proof.verification.method = "signed-report"
  const signedGraph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [signed]))
  assert.equal(signedGraph.nodes[0].state, "completed")
  assert.match(signedGraph.nodes[0].coordinationLabel, /proofs\.blah\.dev \(signed report\)/)
  assert.equal(signedGraph.nodes[1].state, "available")
  const signedWithRun = structuredClone(signed)
  signedWithRun.proof.verification.hyades = { workflow_id: "w", run_id: "r", status: "completed" }
  assert.throws(() => nativeWorkState(proofDag, [signedWithRun]), /hyades is invalid for signed-report/)

  const overridden = structuredClone(verified)
  overridden.proof.status = "overridden"
  overridden.proof.verification = null
  overridden.proof.override = {
    authority: {
      principal_id: VERIFIER_PRINCIPAL_ID,
      nostr_pubkey: VERIFIER_PUBKEY,
      principal_kind: "human",
    },
    reason: "Accepted for this campaign with independent evidence.",
    evidence_sha256: RECEIPT_HASH,
    overridden_at: "2026-09-13T11:00:00Z",
  }
  const overrideGraph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [overridden]))
  assert.equal(overrideGraph.nodes[0].state, "overridden")
  assert.equal(overrideGraph.nodes[1].state, "available")
})

test("external attestation remains visibly pending and does not release dependents", () => {
  const proofDag = nativeProofDag()
  const attested = {
    node_id: "derive-helicity",
    version: 2,
    work: { status: "submitted", claim: null, hyades: null, blocker: null },
    proof: {
      status: "attested",
      candidate_sha256: SOLUTION_HASH,
      verification: null,
      attestation: {
        method: "external-attestation",
        authority: {
          principal_id: VERIFIER_PRINCIPAL_ID,
          nostr_pubkey: VERIFIER_PUBKEY,
          principal_kind: "agent",
        },
        statement: "Independent source attests this candidate.",
        evidence_sha256: RECEIPT_HASH,
        attested_at: "2026-09-13T11:00:00Z",
      },
      override: null,
    },
    external: {},
  }
  const graph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [attested]))
  assert.equal(graph.nodes[0].state, "attested")
  assert.equal(graph.nodes[1].state, "waiting")
})

test("passive repository fields never become claimable mission frontiers", () => {
  const campaign = nativeProofDag()
  const repositoryField = { ...campaign, graphKind: "repository-field" }
  const graph = projectProofTaskGraph(repositoryField, nativeWorkState(repositoryField, []))
  assert.deepEqual(graph.nodes.map((node) => node.state), ["reference", "reference"])
  assert.match(graph.nodes[0].coordinationLabel, /explicit mission/)
})

test("proof-linked HAM active runs are projected only as Hyades-backed execution", () => {
  const manifest = parseProofTaskManifest(rawManifest)
  const ref = proofTaskResourceRef(manifest.programId, "derive-helicity")
  const runningTask = {
    ...task("task-running", "running", ref),
    activeRun: { id: "hyades-run-1", status: "running", stage: "Lean verification" },
  }
  const node = buildProofTaskGraph(manifest, [runningTask]).nodes[0]
  assert.deepEqual(node.workItem.work.hyades, {
    workflowId: "",
    runId: "hyades-run-1",
    status: "running",
  })
  assert.equal(node.state, "running")
  assert.equal(node.coordinationLabel, "Hyades verification running")
})

test("card state precedence uses Hyades run, live claim lease, then prerequisites", () => {
  const proofDag = nativeProofDag()
  const claim = {
    node_id: "derive-helicity",
    version: 1,
    work: { status: "claimed", claim: { claim_id: "claim-1", nostr_pubkey: "a".repeat(64), claimed_at: "2026-09-13T11:00:00Z", expires_at: "2026-09-13T13:00:00Z" }, hyades: null, blocker: null },
    proof: { status: "open", candidate_sha256: null, verification: null },
    external: {},
  }
  assert.equal(projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [claim])).nodes[0].state, "claimed")
  assert.equal(projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [claim], "2026-09-13T14:00:00Z")).nodes[0].state, "available")

  const running = structuredClone(claim)
  running.work.hyades = { workflow_id: "proof-workflow-v1", run_id: "run-1", status: "running" }
  assert.equal(projectProofTaskGraph(proofDag, nativeWorkState(proofDag, [running])).nodes[0].state, "running")
})

test("work overlays fail closed across graph hashes and reject sensitive payloads", () => {
  const proofDag = nativeProofDag()
  const state = {
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: "vortex-proof-v1",
    graph_ref: { graph_id: proofDag.graphId, content_sha256: "0".repeat(64) },
    version: 1,
    updated_at: "2026-09-13T12:00:00Z",
    items: [],
  }
  assert.throws(() => parseProofWorkState(state, proofDag), /does not match/)
  assert.throws(() => parseProofWorkState({ ...state, graph_ref: { graph_id: proofDag.graphId, content_sha256: GRAPH_HASH }, raw_logs: [] }, proofDag), /not permitted/)
})

test("proof resource references are strict and browser-disclosable", () => {
  const ref = proofTaskResourceRef("vortex-proof-v1", "derive-helicity")
  assert.equal(ref, "proof-packet:vortex-proof-v1/derive-helicity")
  assert.deepEqual(parseProofTaskResourceRef(ref), { programId: "vortex-proof-v1", packetId: "derive-helicity", contentSha256: null })
  assert.equal(parseProofTaskResourceRef("proof-packet:vortex-proof-v1/../private"), null)
  const formalRef = proofTaskResourceRef("winding-prototime:v1", "lean:FiniteTorus.main")
  assert.equal(formalRef, "proof-packet:winding-prototime:v1/lean:FiniteTorus.main")
  assert.deepEqual(parseProofTaskResourceRef(formalRef), {
    programId: "winding-prototime:v1",
    packetId: "lean:FiniteTorus.main",
    contentSha256: null,
  })
  const contentBoundRef = proofTaskResourceRef("winding-prototime:v1", "lean:FiniteTorus.main", GRAPH_HASH)
  assert.equal(contentBoundRef, `proof-packet:sha256:${GRAPH_HASH}/winding-prototime:v1/lean:FiniteTorus.main`)
  assert.deepEqual(parseProofTaskResourceRef(contentBoundRef), {
    programId: "winding-prototime:v1",
    packetId: "lean:FiniteTorus.main",
    contentSha256: GRAPH_HASH,
  })
  assert.throws(() => proofTaskResourceRef("winding/prototime:v1", "lean:FiniteTorus.main"), /HAM resource key/)
  assert.throws(() => proofTaskResourceRef(`p${"x".repeat(239)}`, `n${"x".repeat(239)}`, GRAPH_HASH), /HAM resource key boundary/)
  const projected = projectHamTaskPageForBrowser({
    items: [{
      task_id: "task-proof-1",
      project: "galaxy-brain",
      title: "Proof packet",
      goal: "Coordinate it",
      status: "pending",
      resources: [{ key: formalRef, mode: "observe" }, { key: contentBoundRef, mode: "observe" }],
    }],
  })
  assert.equal(projected.tasks[0].resources[0].resourceRef, formalRef)
  assert.equal(projected.tasks[0].resources[0].redacted, false)
  assert.equal(projected.tasks[0].resources[1].resourceRef, contentBoundRef)
  assert.equal(projected.tasks[0].resources[1].redacted, false)
})

test("invalid dependency topology fails closed", () => {
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    packets: [{ ...rawManifest.packets[0], prerequisite_packet_ids: ["missing"] }],
  }), /missing packet/)
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    packets: [
      { ...rawManifest.packets[0], prerequisite_packet_ids: ["vortex-corollary"] },
      rawManifest.packets[1],
    ],
  }), /dependency cycle/)
})

test("proof packet fields remain bounded at the graph parsing boundary", () => {
  assert.throws(() => parseProofTaskManifest({
    ...rawManifest,
    packets: [{ ...rawManifest.packets[0], objective: "x".repeat(4_001) }],
  }), /exceeds 4000/)
})

test("curated milestone and promotion edges remain visible without blocking the proof frontier", () => {
  const proofDag = parseProofDag({
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "typed-edge-mission-v1",
    graph_kind: "mission",
    title: "Typed edge mission",
    targets: [
      { target_id: "milestone", title: "Milestone" },
      { target_id: "theorem", title: "Theorem" },
      { target_id: "library", title: "Library object" },
    ],
    relations: [
      { relation_id: "curated", relation_type: "MILESTONE_OF", prerequisite_target_id: "milestone", dependent_target_id: "theorem" },
      { relation_id: "promotion", relation_type: "PROMOTED_TO", prerequisite_target_id: "theorem", dependent_target_id: "library" },
    ],
  }, GRAPH_HASH)
  const graph = projectProofTaskGraph(proofDag, nativeWorkState(proofDag, []))
  assert.equal(graph.edges.length, 2)
  assert.deepEqual(graph.nodes.map((node) => node.prerequisiteNodeIds), [[], [], []])
  assert.deepEqual(graph.nodes.map((node) => node.state), ["available", "available", "available"])
})

test("unknown relation types fail closed instead of silently releasing dependents", () => {
  const artifact = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "typed-edge-mission-v1",
    graph_kind: "mission",
    title: "Typed edge mission",
    targets: [
      { target_id: "premise", title: "Premise" },
      { target_id: "theorem", title: "Theorem" },
    ],
    relations: [{
      relation_id: "typo",
      relation_type: "DEPEND_ON",
      prerequisite_target_id: "premise",
      dependent_target_id: "theorem",
    }],
  }
  assert.throws(() => parseProofDag(artifact, GRAPH_HASH), /relation_type is not supported/)

  artifact.graph_kind = "repository-field"
  artifact.relations[0].relation_type = "AUTHORED_PREREQUISITE"
  const repositoryField = parseProofDag(artifact, GRAPH_HASH)
  assert.deepEqual(repositoryField.nodes.map((node) => node.prerequisiteNodeIds), [[], ["premise"]])
})

test("native task overlays are bound to the exact DAG content hash", () => {
  const proofDag = nativeProofDag()
  const revisedDag = { ...proofDag, contentSha256: "b".repeat(64) }
  const ref = proofTaskResourceRef(proofDag.graphId, proofDag.nodes[0].nodeId, proofDag.contentSha256)
  const linkedTask = task("task-native", "pending", ref)
  assert.equal(proofWorkStateFromHamTasks(proofDag, [linkedTask]).items.length, 1)
  assert.equal(proofWorkStateFromHamTasks(revisedDag, [linkedTask]).items.length, 0)

  const legacyRef = proofTaskResourceRef(proofDag.graphId, proofDag.nodes[0].nodeId)
  assert.equal(proofWorkStateFromHamTasks(proofDag, [task("task-legacy", "pending", legacyRef)]).items.length, 0)
})

test("claimable DAG identifiers must fit the exact HAM task resource boundary", () => {
  const artifact = {
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "campaign/v1",
    graph_kind: "campaign",
    title: "Slash-bearing campaign",
    targets: [{ target_id: "lean/Foo.bar", title: "Formal target" }],
    relations: [],
  }
  assert.throws(() => parseProofDag(artifact, GRAPH_HASH), /cannot be represented as a HAM resource key/)

  const oversizedReference = {
    ...artifact,
    graph_id: `g${"x".repeat(239)}`,
    targets: [{ target_id: `n${"x".repeat(239)}`, title: "Long formal target" }],
  }
  assert.throws(() => parseProofDag(oversizedReference, GRAPH_HASH), /HAM resource key boundary/)

  artifact.graph_kind = "repository-field"
  const passive = parseProofDag(artifact, GRAPH_HASH)
  assert.equal(passive.graphId, "campaign/v1")
  assert.equal(passive.nodes[0].nodeId, "lean/Foo.bar")
})

test("large native campaigns retain every target and derived frontier", () => {
  const targets = Array.from({ length: 2_000 }, (_, index) => ({
    target_id: `target-${index}`,
    title: `Target ${index}`,
    natural_language_summary: `Prove target ${index}.`,
  }))
  const relations = targets.slice(1).map((target, index) => ({
    relation_id: `edge-${index}`,
    relation_type: "DEPENDS_ON",
    prerequisite_target_id: targets[Math.floor(index / 2)].target_id,
    dependent_target_id: target.target_id,
  }))
  const proofDag = parseProofDag({
    schema_id: "galaxy.proof-dag.v1",
    graph_id: "large-campaign-v1",
    graph_kind: "campaign",
    title: "Large campaign",
    targets,
    relations,
  }, GRAPH_HASH)
  const graph = projectProofTaskGraph(proofDag, {
    schemaId: "galaxy.proof-work-state.v1",
    workspaceId: proofDag.graphId,
    graphRef: { graphId: proofDag.graphId, contentSha256: proofDag.contentSha256 },
    version: 1,
    updatedAt: "2026-09-13T12:00:00Z",
    items: [],
  })
  assert.equal(graph.nodes.length, 2_000)
  assert.equal(graph.edges.length, 1_999)
  assert.equal(graph.nodes.filter((node) => node.state === "available").length, 1)
})

test("force-directed proof placement is deterministic, finite, and topology-aware", () => {
  const nodes = [
    { id: "root", layer: 0 },
    { id: "left", layer: 1 },
    { id: "right", layer: 1 },
    { id: "leaf", layer: 2 },
  ]
  const edges = [
    { source: "root", target: "left" },
    { source: "root", target: "right" },
    { source: "right", target: "leaf" },
  ]
  const first = forceLayoutProofGraph(nodes, edges, { seed: 17, iterations: 80 })
  const second = forceLayoutProofGraph(nodes, edges, { seed: 17, iterations: 80 })
  assert.deepEqual(first, second)
  assert.deepEqual(Object.keys(first).sort(), nodes.map((node) => node.id).sort())
  assert.equal(Object.values(first).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)), true)
  assert.equal(first.root.x < first.leaf.x, true)
  assert.notDeepEqual(first.left, first.right)
})

test("large proof fields use a bounded linear layout before React render", () => {
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({
    id: `target-${index}`,
    layer: index % 37,
  }))
  const edges = nodes.slice(1).map((node, index) => ({ source: nodes[index].id, target: node.id }))
  const startedAt = performance.now()
  const positions = forceLayoutProofGraph(nodes, edges)
  const elapsed = performance.now() - startedAt
  assert.equal(Object.keys(positions).length, 10_000)
  assert.equal(Object.values(positions).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)), true)
  assert.ok(elapsed < 2_000, `10,000-node fallback took ${elapsed.toFixed(1)}ms`)
})

test("ReactFlow identities are injective across campaign, packet, and synthetic nodes", () => {
  const ids = [
    proofGraphNodeId("alpha", "beta:gamma"),
    proofGraphNodeId("alpha:beta", "gamma"),
    proofGraphNodeId("alpha", "campaign"),
    proofCampaignNodeId("alpha"),
  ]
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(proofGraphNodeId("a", "bc"), "proof:1:a2:bc")
})

test("the visual graph virtualizes offscreen nodes and keeps proof targets keyboard selectable", async () => {
  const source = await readFile(new URL("../components/tasks/proof-task-graph.tsx", import.meta.url), "utf8")
  assert.match(source, /onlyRenderVisibleElements/)
  assert.match(source, /nodesFocusable/)
  assert.match(source, /elementsSelectable/)
  assert.match(source, /forceLayoutProofGraph/)
  assert.match(source, /proofGraphNodeId/)
  assert.match(source, /proofCampaignNodeId/)
  assert.match(source, /onNodeClick/)
  assert.match(source, /proof-detail-inspector/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /aria-controls="proof-detail-inspector"/)
})

test("the proof receipt UI distinguishes accepted verification from rejected evidence", async () => {
  const source = await readFile(new URL("../components/tasks/proof-task-graph.tsx", import.meta.url), "utf8")
  assert.match(source, /outcome === "accepted"[\s\S]*Accepted verification provenance[\s\S]*icon: ShieldCheck/)
  assert.match(source, /outcome === "rejected"[\s\S]*Rejected proof evidence[\s\S]*icon: TriangleAlert/)
  assert.match(source, /return \{ heading: "Proof receipt evidence", summary: "Proof evidence", icon: CircleDot \}/)
  assert.match(source, /<DetailValue label="Outcome" value=\{verification\.outcome\} \/>/)
  assert.doesNotMatch(source, /outcome === "rejected"[^}]*icon: ShieldCheck/)
})

test("the browser graph never claims work on an agent's behalf", async () => {
  const source = await readFile(new URL("../components/tasks/proof-campaign-launcher.tsx", import.meta.url), "utf8")
  assert.match(source, /Agents still claim and run them with their own scoped identities/)
  assert.doesNotMatch(source, /\/claim["'`]/)
})

test("the campaign launcher accepts canonical Galaxy DAGs while keeping Hyades registration on HAM v3", async () => {
  const source = await readFile(new URL("../components/tasks/proof-campaign-launcher.tsx", import.meta.url), "utf8")
  assert.match(source, /parseProofDag\(artifactView, artifactSha256\)/)
  assert.match(source, /Galaxy DAGs render a read-only derived frontier/)
  assert.match(source, /This browser view never publishes its locally derived frontier/)
  assert.match(source, /artifactKind !== "ham"/)
  assert.match(source, /Passive repository fields remain reference-only/)
  assert.doesNotMatch(source, /createProofTask|publishReadyTasks|Publish ready to HAM/)
})

test("the retired direct proof task boundary fails closed", async () => {
  const route = await readFile(new URL("../app/api/proof-tasks/route.ts", import.meta.url), "utf8")
  assert.match(route, /getCurrentUser\(\)/)
  assert.match(route, /Unauthorized.*status: 401/s)
  assert.match(route, /Direct proof-task materialization is retired/)
  assert.match(route, /status: 410/)
  assert.doesNotMatch(route, /fetchHamTask|createHumanTaskPayload|proofTaskResourceRef|proofTaskIdempotencyKey/)
})

test("the retired proof task route returns 401 or 410 without a HAM mutation dependency", async () => {
  const unauthenticated = await retiredProofTaskRoute(null)
  const unauthorizedResponse = await unauthenticated()
  assert.equal(unauthorizedResponse.status, 401)

  const authenticated = await retiredProofTaskRoute({ id: "owner" })
  const retiredResponse = await authenticated()
  assert.equal(retiredResponse.status, 410)
  assert.match((await retiredResponse.json()).error, /dispatch the exact compiled directive through Hyades/)
})

test("proof preview stays development-only and has no browser publication function", async () => {
  const preview = await readFile(new URL("../app/dev/proof-dag-preview/page.tsx", import.meta.url), "utf8")
  assert.match(preview, /devPreviewsEnabled\(\)/)
  assert.match(preview, /notFound\(\)/)

  const launcher = await readFile(new URL("../components/tasks/proof-campaign-launcher.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(launcher, /publishReadyTasks|Promise\.allSettled/)
  assert.match(launcher, /dispatchProofCampaign\(programId, currentDirectiveSha256\)/)
})

test("direct proof materialization cannot reach HAM even for an authenticated user", async () => {
  const route = await readFile(new URL("../app/api/proof-tasks/route.ts", import.meta.url), "utf8")
  assert.match(route, /getCurrentUser\(\)/)
  assert.match(route, /status: 410/)
  assert.doesNotMatch(route, /fetchHamTask\("create"/)
})
