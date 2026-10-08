import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { compileProofMission } from "../lib/proof-mission-compiler.js"


const source = {
  schema_id: "galaxy.proof-dag.v1",
  graph_id: "leanproofs",
  graph_kind: "repository-field",
  title: "  LeanProofs field  ",
  targets: [
    {
      target_id: "foundation",
      title: "  Foundation  ",
      target_kind: "definition",
      natural_language_summary: "  Establish the base.  ",
      category: "proved",
      source_id: "concept:foundation",
      source_label: "  Foundation cohort  ",
      formal_binding: {
        status: "mapped",
        binding_kind: "module-cohort",
        mapping_rule: "  Map the declaration cohort.  ",
        module_ids: ["LeanProofs.Foundation"],
        declaration_ids: ["LeanProofs.Foundation.base"],
        declaration_equivalence_claimed: false,
        ignored_provider_status: "accepted",
      },
      ignored_work: { status: "complete" },
    },
    { target_id: "bridge", title: "Bridge" },
    { target_id: "main", title: "Main theorem" },
    { target_id: "unrelated", title: "Unrelated" },
  ],
  relations: [
    {
      relation_id: "r-foundation",
      relation_type: "USES",
      prerequisite_target_id: "foundation",
      dependent_target_id: "bridge",
    },
    {
      relation_id: "r-main",
      relation_type: "REDUCES_TO",
      prerequisite_target_id: "bridge",
      dependent_target_id: "main",
      source_edge_id: "authored:bridge-main",
      assertion_level: "bridge-candidate",
      formal_correspondence: {
        status: "bridge-candidate",
        support_kind: null,
        declaration_path: null,
        dependency_kinds_by_step: [["uses"], ["imports", "reduces-to"]],
        ignored_receipt: "receipt-1",
      },
      bridge_nomination: {
        nominated: true,
        reason: "  No direct declaration edge exists.  ",
        ignored_provider_status: "accepted",
      },
    },
    {
      relation_id: "\u{10000}",
      relation_type: "PROMOTED_TO",
      prerequisite_target_id: "foundation",
      dependent_target_id: "main",
    },
    {
      relation_id: "\uE000",
      relation_type: "PROMOTED_TO",
      prerequisite_target_id: "foundation",
      dependent_target_id: "main",
    },
  ],
  liveState: { main: { status: "claimed" } },
}

const sourceBytes = new TextEncoder().encode(JSON.stringify(source))
const browserInput = {
  sourceProofDagBytes: sourceBytes,
  missionId: "prove-main-v1",
  mainTargetId: "main",
  milestoneTargetIds: ["foundation", "bridge"],
  relationDirection: "prerequisite-to-dependent",
}

const pythonProgram = String.raw`
import base64, json, sys
sys.path.insert(0, sys.argv[1])
from proof_graph_registry import parse_proof_graph_bytes
from proof_mission_contract import derive_proof_mission
payload = json.load(sys.stdin)
source = parse_proof_graph_bytes(base64.b64decode(payload["source_base64"]))
candidate = derive_proof_mission(source, payload["intent"])
json.dump(candidate.envelope, sys.stdout, ensure_ascii=True, separators=(",", ":"))
`

test("server mission derivation has golden structural parity with the browser preview compiler", async () => {
  const browser = await compileProofMission(browserInput)
  const serviceDirectory = fileURLToPath(new URL("../services/galaxy-brain-api/", import.meta.url))
  const execution = spawnSync("python", ["-c", pythonProgram, serviceDirectory], {
    encoding: "utf8",
    input: JSON.stringify({
      source_base64: Buffer.from(sourceBytes).toString("base64"),
      intent: {
        schema_id: "galaxy.proof-mission-intent.v1",
        source_graph: browser.source_graph,
        mission_id: browser.selection.mission_id,
        main_target_id: browser.selection.main_target_id,
        curated_milestone_target_ids: [...browser.selection.curated_milestone_target_ids].reverse(),
        relation_direction: browser.selection.relation_direction,
      },
    }),
  })
  assert.equal(execution.status, 0, execution.stderr)
  const server = JSON.parse(execution.stdout)

  assert.deepEqual(server.mission_dag, browser.mission_dag)
  assert.deepEqual(
    server.mission_dag.relations.slice(-2).map((relation) => relation.relation_id),
    ["\u{10000}", "\uE000"],
    "server ordering must match JavaScript UTF-16 code units",
  )
  assert.equal(server.activation_state, "inactive")
  assert.equal(server.registerable, false)
  assert.doesNotMatch(JSON.stringify(server), /liveState|ignored_|receipt-1/u)
})
