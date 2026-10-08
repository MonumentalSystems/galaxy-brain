import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  PROOF_GRAPH_SELECTION_EVENT,
  createProofGraphSelection,
  encodeEmptyProofVerificationSet,
  normalizeProofGraphList,
  normalizeProofVerificationSetList,
  normalizeProofWorkspaceList,
  proofGraphSelectionFromUrl,
  proofGraphSelectionUrl,
  proofRegistryPresenterUrl,
  proofRegistryErrorMessage,
} from "../lib/proof-graph-registry-client.js"
import {
  MAX_PROOF_MISSION_INTENT_BYTES,
  createProofMissionIntent,
  encodeProofMissionActivationRequest,
  encodeProofMissionIntent,
  normalizeProofMissionActivationResult,
  normalizeProofMissionCandidate,
} from "../lib/proof-mission-contract-client.js"

const HASH = "a".repeat(64)
const OTHER_HASH = "b".repeat(64)

function summary(graphKind = "repository-field") {
  return {
    schemaId: "gb.proof-graph.summary.v1",
    registrationId: "registration-1",
    graphId: "leanproofs",
    graphKind,
    title: "LeanProofs",
    contentSha256: HASH,
    byteSize: 41,
    targetCount: 2,
    relationCount: 1,
    registeredByPrincipalId: "principal-1",
    registeredByNostrPubkey: "c".repeat(64),
    registeredAt: "2026-09-23T12:00:00Z",
  }
}

test("registry list accepts only bounded exact immutable summaries", () => {
  const value = normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [summary()],
    hasMore: true,
    nextOffset: 50,
  })
  assert.equal(value.graphs[0].contentSha256, HASH)
  assert.equal(value.nextOffset, 50)
  assert.throws(() => normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [summary(), summary()],
    hasMore: false,
    nextOffset: null,
  }), /duplicate immutable revisions/u)
  assert.throws(() => normalizeProofGraphList({
    schemaId: "gb.proof-graph.list.v1",
    graphs: [summary()],
    hasMore: true,
    nextOffset: null,
  }), /pagination state is inconsistent/u)
})

test("workspace discovery remains pinned to one exact graph", () => {
  const body = {
    schemaId: "galaxy.proof-workspace-summary-list.v1",
    graph_ref: { graph_id: "leanproofs", content_sha256: HASH },
    workspaces: [{
      workspace_id: "mission-one",
      version: 4,
      updated_at: "2026-09-23T12:00:00Z",
      item_count: 3,
    }],
    has_more: false,
    next_offset: null,
  }
  const value = normalizeProofWorkspaceList(body, { graphId: "leanproofs", contentSha256: HASH })
  assert.equal(value.workspaces[0].workspaceId, "mission-one")
  assert.throws(() => normalizeProofWorkspaceList(body, {
    graphId: "leanproofs",
    contentSha256: OTHER_HASH,
  }), /does not match the selected immutable graph/u)
})

test("verification baseline discovery is exact and empty registration carries no claims", () => {
  const list = normalizeProofVerificationSetList({
    schemaId: "gb.proof-verification-set.list.v1",
    verificationSets: [{
      schemaId: "gb.proof-verification-set.summary.v1",
      registrationId: "baseline-1",
      graphRef: { graph_id: "leanproofs", content_sha256: HASH },
      contentSha256: OTHER_HASH,
      byteSize: 150,
      itemCount: 0,
      registeredByPrincipalId: "principal-1",
      registeredByNostrPubkey: "c".repeat(64),
      registeredAt: "2026-09-23T12:00:00Z",
    }],
    hasMore: false,
    nextOffset: null,
  }, { graphId: "leanproofs", contentSha256: HASH })
  assert.equal(list.verificationSets[0].itemCount, 0)
  const { artifact, bytes } = encodeEmptyProofVerificationSet({
    graphId: "leanproofs",
    contentSha256: HASH,
  })
  assert.deepEqual(artifact.items, [])
  assert.doesNotMatch(new TextDecoder().decode(bytes), /verified|claim|status/u)
  assert.throws(() => normalizeProofVerificationSetList({
    ...list,
    verificationSets: [{
      ...list.verificationSets[0],
      graphRef: { graph_id: "leanproofs", content_sha256: OTHER_HASH },
    }],
  }, { graphId: "leanproofs", contentSha256: HASH }), /does not match/u)
})

test("repository fields can never carry a work overlay", () => {
  const bytes = new Uint8Array(41)
  const proofDag = { schema_id: "galaxy.proof-dag.v1", graph_id: "leanproofs", graph_kind: "repository-field" }
  const passive = createProofGraphSelection({ summary: summary(), proofDag, exactBytes: bytes })
  assert.equal(passive.coordinationActive, false)
  assert.throws(() => createProofGraphSelection({
    summary: summary(),
    proofDag,
    exactBytes: bytes,
    workspace: { workspaceId: "workspace-1", version: 1, updatedAt: "2026-09-23T12:00:00Z", itemCount: 0 },
    workState: {
      schema_id: "galaxy.proof-work-state.v1",
      workspace_id: "workspace-1",
      graph_ref: { graph_id: "leanproofs", content_sha256: HASH },
    },
  }), /passive/u)
})

test("campaign coordination requires one exact workspace and matching overlay", () => {
  const bytes = new Uint8Array(41)
  const proofDag = { schema_id: "galaxy.proof-dag.v1", graph_id: "leanproofs", graph_kind: "mission" }
  const workspace = { workspaceId: "workspace-1", version: 1, updatedAt: "2026-09-23T12:00:00Z", itemCount: 0 }
  const workState = {
    schema_id: "galaxy.proof-work-state.v1",
    workspace_id: "workspace-1",
    graph_ref: { graph_id: "leanproofs", content_sha256: HASH },
  }
  const active = createProofGraphSelection({
    summary: summary("mission"), proofDag, exactBytes: bytes, workspace, workState,
  })
  assert.equal(active.coordinationActive, true)
  assert.equal(active.workspace.workspaceId, "workspace-1")
  assert.throws(() => createProofGraphSelection({
    summary: summary("mission"),
    proofDag,
    exactBytes: bytes,
    workspace,
    workState: { ...workState, graph_ref: { ...workState.graph_ref, content_sha256: OTHER_HASH } },
  }), /not bound to the selected immutable graph/u)
})

test("URL contract selects an exact graph and at most one workspace", () => {
  assert.equal(PROOF_GRAPH_SELECTION_EVENT, "galaxy:proof-graph-selection-change")
  const selected = new URL(proofGraphSelectionUrl(
    "https://galaxy.example/graph?keep=1&proofWorkspace=old",
    { contentSha256: HASH, workspaceId: "mission one" },
  ))
  assert.equal(selected.searchParams.get("proofGraph"), HASH)
  assert.equal(selected.searchParams.get("proofWorkspace"), "mission one")
  assert.equal(selected.searchParams.get("keep"), "1")
  const passive = new URL(proofGraphSelectionUrl(selected.toString(), {
    contentSha256: HASH,
    workspaceId: null,
  }))
  assert.equal(passive.searchParams.get("proofGraph"), HASH)
  assert.equal(passive.searchParams.has("proofWorkspace"), false)
  const cleared = new URL(proofGraphSelectionUrl(passive.toString(), null))
  assert.equal(cleared.searchParams.has("proofGraph"), false)
  assert.equal(cleared.searchParams.has("proofWorkspace"), false)
})

test("URL contract discovers pinned deep links and clears stale proof selections", () => {
  const graphA = `gb:object:v1:proof.graph:graph-a:pinned:sha256%3A${HASH}`
  const nodeA = `gb:object:v1:proof.node:graph-a%23node-1:pinned:sha256%3A${HASH}`
  const graphB = `gb:object:v1:proof.graph:graph-b:pinned:sha256%3A${OTHER_HASH}`
  const pinned = proofGraphSelectionFromUrl(`https://galaxy.example/graph?ref=${encodeURIComponent(graphA)}`)
  assert.deepEqual(pinned, { graphHash: HASH, workspaceId: "" })
  assert.throws(
    () => proofGraphSelectionFromUrl(
      `https://galaxy.example/graph?ref=${encodeURIComponent(graphA)}&focus=${encodeURIComponent(graphB)}`,
    ),
    /references disagree/u,
  )

  const switched = new URL(proofGraphSelectionUrl(
    `https://galaxy.example/graph?proofGraph=${HASH}&ref=${encodeURIComponent(graphA)}&focus=${encodeURIComponent(nodeA)}`,
    { contentSha256: OTHER_HASH, workspaceId: null },
  ))
  assert.equal(switched.searchParams.get("proofGraph"), OTHER_HASH)
  assert.equal(switched.searchParams.has("ref"), false)
  assert.equal(switched.searchParams.has("focus"), false)

  const preserved = new URL(proofGraphSelectionUrl(
    `https://galaxy.example/graph?proofGraph=${HASH}&ref=${encodeURIComponent(graphA)}`,
    { contentSha256: HASH, workspaceId: "mission" },
  ))
  assert.equal(preserved.searchParams.get("ref"), graphA)
})

test("client errors expose bounded validation details but not server failures", () => {
  assert.equal(proofRegistryErrorMessage(422, { detail: "Target is invalid" }, "fallback"), "Target is invalid")
  assert.equal(proofRegistryErrorMessage(500, { detail: "postgres host secret" }, "fallback"), "fallback")
  assert.equal(proofRegistryErrorMessage(422, { detail: "x".repeat(501) }, "fallback"), "fallback")
})

test("mission intent is bounded selection data without a client-authored DAG", () => {
  const input = {
    sourceGraphId: "leanproofs",
    sourceContentSha256: HASH,
    missionId: "mission-one",
    mainTargetId: "goal",
    milestoneTargetIds: ["lemma-b", "lemma-a"],
  }
  const { intent, bytes } = encodeProofMissionIntent(input)
  assert.deepEqual(intent, {
    schema_id: "galaxy.proof-mission-intent.v1",
    source_graph: {
      graph_id: "leanproofs",
      graph_kind: "repository-field",
      content_sha256: HASH,
    },
    mission_id: "mission-one",
    main_target_id: "goal",
    curated_milestone_target_ids: ["lemma-a", "lemma-b"],
    relation_direction: "prerequisite-to-dependent",
  })
  assert.ok(bytes.byteLength < MAX_PROOF_MISSION_INTENT_BYTES)
  assert.equal("mission_dag" in intent, false)
  assert.throws(() => createProofMissionIntent({
    ...input,
    milestoneTargetIds: ["goal"],
  }), /main target cannot also be a milestone/u)
  assert.throws(() => createProofMissionIntent({
    ...input,
    milestoneTargetIds: ["lemma-a", "lemma-a"],
  }), /duplicate identifiers/u)
})

test("mission candidate must be inactive and bound to the confirmed intent", () => {
  const input = {
    sourceGraphId: "leanproofs",
    sourceContentSha256: HASH,
    missionId: "mission-one",
    mainTargetId: "goal",
    milestoneTargetIds: ["lemma-a"],
  }
  const candidate = {
    schema_id: "galaxy.proof-mission-candidate.v1",
    activation_state: "inactive",
    registerable: false,
    source_graph: {
      graph_id: "leanproofs",
      graph_kind: "repository-field",
      content_sha256: HASH,
    },
    selection: {
      mission_id: "mission-one",
      main_target_id: "goal",
      curated_milestone_target_ids: ["lemma-a"],
      relation_direction: "prerequisite-to-dependent",
    },
    mission_content_sha256: OTHER_HASH,
    mission_dag: {
      schema_id: "galaxy.proof-dag.v1",
      graph_id: "mission-one",
      graph_kind: "mission",
      targets: [{ target_id: "goal" }],
      relations: [],
    },
  }
  const normalized = normalizeProofMissionCandidate(candidate, input)
  assert.equal(normalized.activationState, "inactive")
  assert.equal(normalized.registerable, false)
  assert.equal(normalized.missionContentSha256, OTHER_HASH)
  assert.throws(() => normalizeProofMissionCandidate({ ...candidate, registerable: true }, input), /inactive and non-registerable/u)
  assert.throws(() => normalizeProofMissionCandidate({
    ...candidate,
    source_graph: { ...candidate.source_graph, content_sha256: OTHER_HASH },
  }, input), /source does not match/u)
  assert.throws(() => normalizeProofMissionCandidate({
    ...candidate,
    selection: { ...candidate.selection, main_target_id: "other" },
  }, input), /selection does not match/u)
})

test("mission activation signs only exact intent, reviewed digest, baseline, and workspace", () => {
  const input = {
    sourceGraphId: "leanproofs",
    sourceContentSha256: HASH,
    missionId: "mission-one",
    mainTargetId: "goal",
    milestoneTargetIds: ["lemma-a"],
    expectedMissionContentSha256: OTHER_HASH,
    verificationSetContentSha256: "c".repeat(64),
    workspaceId: "mission-one",
    idempotencyKey: `activate-${"d".repeat(64)}`,
  }
  const encoded = encodeProofMissionActivationRequest(input)
  assert.ok(encoded.bytes.byteLength < 131_072)
  assert.equal("mission_dag" in encoded.request, false)
  assert.equal("node_ids" in encoded.request, false)
  assert.equal(encoded.request.expected_mission_content_sha256, OTHER_HASH)

  const result = normalizeProofMissionActivationResult({
    schema_id: "galaxy.proof-mission-activation-result.v1",
    activation_id: "10000000-0000-4000-8000-000000000001",
    activation_state: "active",
    source_graph_ref: { graph_id: "leanproofs", content_sha256: HASH },
    mission_intent_ref: { content_sha256: "e".repeat(64) },
    verification_set_ref: { content_sha256: "c".repeat(64) },
    mission_graph: {
      graph_id: "mission-one",
      content_sha256: OTHER_HASH,
      title: "Mission one",
      target_count: 2,
      relation_count: 1,
    },
    workspace: {
      workspace_id: "mission-one",
      graph_ref: { graph_id: "mission-one", content_sha256: OTHER_HASH },
      version: 1,
      updated_at: "2026-09-23T12:00:00Z",
      item_count: 0,
    },
    inherited_verified_node_ids: [],
    initial_frontier_node_ids: ["lemma-a"],
    activated_at: "2026-09-23T12:00:00Z",
  }, input)
  assert.equal(result.missionGraph.contentSha256, OTHER_HASH)
  assert.deepEqual(result.inheritedVerifiedNodeIds, [])
  assert.deepEqual(result.initialFrontierNodeIds, ["lemma-a"])

  assert.throws(() => normalizeProofMissionActivationResult({
    schema_id: "galaxy.proof-mission-activation-result.v1",
    activation_id: "10000000-0000-4000-8000-000000000001",
    activation_state: "active",
    source_graph_ref: { graph_id: "leanproofs", content_sha256: HASH },
    mission_intent_ref: { content_sha256: "e".repeat(64) },
    verification_set_ref: { content_sha256: "c".repeat(64) },
    mission_graph: {
      graph_id: "mission-one", content_sha256: "f".repeat(64), title: "Stale",
      target_count: 1, relation_count: 0,
    },
    workspace: {
      workspace_id: "mission-one",
      graph_ref: { graph_id: "mission-one", content_sha256: "f".repeat(64) },
      version: 1, updated_at: "2026-09-23T12:00:00Z", item_count: 0,
    },
    inherited_verified_node_ids: [], initial_frontier_node_ids: [],
    activated_at: "2026-09-23T12:00:00Z",
  }, input), /reviewed candidate/u)
})

test("registration signs the server-provided canonical target and preserves exact bytes", async () => {
  const [signer, targetRoute, panel] = await Promise.all([
    readFile(new URL("../lib/nostr-browser.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/nostr/request-target/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url), "utf8"),
  ])
  assert.match(targetRoute, /const origin = getAuthOrigin\(\)/u)
  assert.match(targetRoute, /const target = new URL\(path, origin\)/u)
  assert.match(targetRoute, /user\.authMethod !== "nostr"/u)
  assert.doesNotMatch(signer, /window\.location\.origin/u)
  assert.match(signer, /\["payload", payload\]/u)
  assert.match(panel, /body: importBytes\.slice\(\)\.buffer/u)
  assert.match(panel, /source\.schema_id !== "galaxy\.proof-dag\.v1"/u)
  assert.match(panel, /parsed\.graphKind !== "repository-field"/u)
  assert.match(panel, /Only passive repository-field proof DAGs can be registered directly/u)
})

test("panel is URL-driven and delegates exact work-state loading to the graph provider", async () => {
  const panel = await readFile(
    new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url),
    "utf8",
  )
  assert.match(panel, /proofGraph/u)
  assert.match(panel, /proofWorkspace/u)
  assert.match(panel, /proofGraphSelectionFromUrl/u)
  assert.match(panel, /window\.history\.pushState/u)
  assert.match(panel, /refresh: true/u)
  assert.match(panel, /Live state is loaded by the graph provider/u)
  assert.doesNotMatch(panel, /proof-workspaces\/\$\{encodeURIComponent/u)
  assert.match(panel, /Repository fields remain visible and traversable, but never become claimable frontiers/u)
})

test("presenter marker survives exact selection and only explicit close removes it", () => {
  const opened = proofRegistryPresenterUrl("https://galaxy.example/graph?keep=1", true)
  assert.equal(new URL(opened).searchParams.get("proofRegistry"), "open")
  const selected = proofGraphSelectionUrl(opened, { contentSha256: HASH, workspaceId: "mission-one" })
  assert.equal(new URL(selected).searchParams.get("proofRegistry"), "open")
  assert.equal(new URL(selected).searchParams.get("proofGraph"), HASH)
  assert.equal(new URL(selected).searchParams.get("proofWorkspace"), "mission-one")
  const closed = new URL(proofRegistryPresenterUrl(selected, false))
  assert.equal(closed.searchParams.has("proofRegistry"), false)
  assert.equal(closed.searchParams.get("proofGraph"), HASH)
  assert.equal(closed.searchParams.get("proofWorkspace"), "mission-one")
  assert.equal(closed.searchParams.get("keep"), "1")
})

test("proof registry is an explicit Tasks command and mounts only inside its Graph presenter", async () => {
  const [dialog, panel, missionSelector, graphClient, atlasClient] = await Promise.all([
    readFile(new URL("../components/graph/proof-graph-registry-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/graph/proof-mission-selector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/graph/graph-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  ])
  assert.match(dialog, /<Dialog open=\{open\} onOpenChange=\{requestOpenChange\}>/u)
  assert.match(dialog, /open \? \([\s\S]*<ProofGraphRegistryPanel/u)
  assert.match(dialog, /Passive repository fields remain traversable and never become claimable automatically/u)
  assert.match(dialog, /onOpenAutoFocus/u)
  assert.match(dialog, /min-h-11 w-full/u)
  assert.match(dialog, /Close while the signed request is unresolved\?/u)
  assert.match(dialog, /Close and recheck later/u)
  assert.match(dialog, /Discard staged proof-registry work\?/u)
  assert.match(dialog, /onMutationPendingChange=\{setMutationPending\}/u)
  assert.match(dialog, /onDiscardRiskChange=\{setDiscardRisk\}/u)
  assert.match(panel, /onDiscardRiskChange=\{setMissionDraftDiscardRisk\}/u)
  assert.match(missionSelector, /onDiscardRiskChange\?\.\(hasDiscardRisk\)/u)
  assert.match(panel, /acknowledgedSelection=\{missionCandidate \? \{/u)
  assert.match(missionSelector, /acknowledgedSelection\?: Pick<ProofMissionSelection/u)
  assert.doesNotMatch(missionSelector, /setConfirmedDraftKey/u)
  assert.match(dialog, /mission-selection draft/u)
  assert.match(dialog, /DialogDescription className="graph-surface__muted"/u)
  assert.match(dialog, /AlertDialogDescription className="graph-surface__muted"/u)
  assert.match(dialog, /max-h-\[calc\(100dvh-1rem\)\] w-\[calc\(100vw-1rem\)\] max-w-lg/u)
  assert.doesNotMatch(dialog, /FormalProjectPackageImport/u)
  assert.doesNotMatch(graphClient, /FormalProjectPackageImport/u)
  assert.doesNotMatch(panel, /#[0-9a-f]{3,8}|rgba?\(/iu)
  assert.doesNotMatch(missionSelector, /#[0-9a-f]{3,8}|rgba?\(/iu)
  assert.match(missionSelector, /graph-surface__control/u)
  assert.match(missionSelector, /graph-surface__warning/u)
  assert.match(panel, /graph-surface__muted min-w-0 break-all text-xs/u)
  assert.match(panel, /break-words rounded-lg border p-3 text-sm \[overflow-wrap:anywhere\]/u)
  assert.match(panel, /min-h-5 break-words text-xs \[overflow-wrap:anywhere\]/u)
  assert.doesNotMatch(graphClient, /<ProofGraphRegistryPanel/u)
  assert.match(graphClient, /<ProofGraphRegistryDialog open=\{proofRegistryOpen\}/u)
  assert.match(graphClient, /routeSearchParams\.get\("proofRegistry"\) === "open"/u)
  assert.match(graphClient, /proofRegistryPresenterUrl\(window\.location\.href, nextOpen\)/u)
  assert.doesNotMatch(graphClient, /setProofRegistryOpen\(new URLSearchParams\(routeSearch\)/u)
  assert.match(atlasClient, /commandId === "proof\.registry\.open"/u)
  assert.match(atlasClient, /window\.location\.assign\("\/graph\?proofRegistry=open"\)/u)
  assert.match(atlasClient, /const proofHudCommand = atlasCommands\.find\([\s\S]*command\.id === "proof\.registry\.open" && command\.enabled/u)
  assert.match(atlasClient, /label=\{proofHudCommand\.title\}[\s\S]*icon=\{<Network \/>\}[\s\S]*aria-haspopup="dialog"/u)
  assert.match(atlasClient, /executeSelectedAtlasCommand\(proofHudCommand\.id, proofHudTriggerRef\.current\)/u)
  assert.doesNotMatch(atlasClient, /label="Browse proof graphs"[\s\S]{0,300}window\.location\.assign/u)
})

test("panel sends only bounded mission intent and displays the inactive server candidate", async () => {
  const panel = await readFile(
    new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url),
    "utf8",
  )
  assert.match(panel, /parseProofDag\(exact\.proofDag, selection\.graphHash\)/u)
  assert.match(panel, /encodeProofMissionIntent\(expected\)/u)
  assert.match(panel, /proof-graphs\/\$\{selectedSummary\.contentSha256\}\/mission-candidates/u)
  assert.match(panel, /body: intentBytes\.slice\(\)\.buffer/u)
  assert.match(panel, /normalizeProofMissionCandidate\(body, expected\)/u)
  assert.match(panel, /parseProofDag\(candidate\.missionDag, candidate\.missionContentSha256\)/u)
  assert.match(panel, /<ProofMissionSelector/u)
  assert.match(panel, /Inactive server-derived mission candidate/u)
  assert.match(panel, /remains inactive and non-registerable/u)
  assert.doesNotMatch(panel, /compileProofMission/u)
  assert.doesNotMatch(panel, /proof-workspaces[\s\S]{0,500}missionCandidate/u)
})

test("mission candidate completion is bound to the selected graph and latest request", async () => {
  const panel = await readFile(
    new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url),
    "utf8",
  )
  assert.match(panel, /const missionCandidateGeneration = useRef\(0\)/u)
  assert.match(panel, /missionCandidateGeneration\.current \+= 1/u)
  assert.match(panel, /const candidateGeneration = \+\+missionCandidateGeneration\.current/u)
  assert.match(panel, /const graphGeneration = syncGeneration\.current/u)
  assert.match(panel, /candidateGeneration !== missionCandidateGeneration\.current[\s\S]*graphGeneration !== syncGeneration\.current/u)
  assert.match(panel, /const invalidateMissionCandidate = useCallback/u)
  assert.match(panel, /missionCandidateGeneration\.current \+= 1[\s\S]*setMissionCandidate\(null\)/u)
  assert.match(panel, /onDraftInvalidated=\{invalidateMissionCandidate\}/u)
})

test("nested baseline and workspace loads cannot overwrite a newer graph selection", async () => {
  const panel = await readFile(
    new URL("../components/graph/proof-graph-registry-panel.tsx", import.meta.url),
    "utf8",
  )
  assert.match(panel, /expectedGeneration = syncGeneration\.current/u)
  assert.match(panel, /expectedGeneration === syncGeneration\.current/u)
  assert.match(panel, /loadVerificationSets\(summary, "", signal, generation\)/u)
  assert.match(panel, /loadWorkspacePage\(summary, 0, false, signal, generation\)/u)
  assert.match(panel, /loadVerificationSets\(selectedSummary, registeredHash, undefined, generation\)/u)
})
