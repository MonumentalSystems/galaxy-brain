import hashlib
import json
import unittest

from proof_graph_registry import parse_proof_graph_bytes
from proof_mission_contract import (
    ProofMissionContractError,
    derive_proof_mission,
    parse_mission_intent_bytes,
)


def repository_field():
    return {
        "schema_id": "galaxy.proof-dag.v1",
        "graph_id": "leanproofs",
        "graph_kind": "repository-field",
        "title": "LeanProofs",
        "targets": [
            {
                "target_id": "foundation",
                "title": "Foundation",
                "formal_binding": {
                    "status": "mapped",
                    "module_ids": ["LeanProofs.Foundation"],
                    "declaration_ids": ["LeanProofs.Foundation.base"],
                    "provider_status": "accepted",
                },
                "work": {"status": "complete"},
            },
            {"target_id": "bridge", "title": "Bridge"},
            {"target_id": "main", "title": "Main theorem"},
            {"target_id": "unrelated", "title": "Unrelated"},
        ],
        "relations": [
            {
                "relation_id": "r-foundation",
                "relation_type": "USES",
                "prerequisite_target_id": "foundation",
                "dependent_target_id": "bridge",
            },
            {
                "relation_id": "r-main",
                "relation_type": "REDUCES_TO",
                "prerequisite_target_id": "bridge",
                "dependent_target_id": "main",
                "formal_correspondence": {
                    "status": "bridge-candidate",
                    "support_kind": None,
                    "declaration_path": None,
                    "dependency_kinds_by_step": [["uses"]],
                    "receipt": "must-not-survive",
                },
            },
        ],
        "liveState": {"main": {"status": "claimed"}},
    }


def source_registration(document=None):
    raw = json.dumps(
        document or repository_field(), ensure_ascii=False, separators=(",", ":")
    ).encode()
    return parse_proof_graph_bytes(raw)


def intent(source, **overrides):
    value = {
        "schema_id": "galaxy.proof-mission-intent.v1",
        "source_graph": {
            "graph_id": source.graph_id,
            "graph_kind": "repository-field",
            "content_sha256": source.content_sha256,
        },
        "mission_id": "prove-main-v1",
        "main_target_id": "main",
        "curated_milestone_target_ids": ["bridge"],
        "relation_direction": "prerequisite-to-dependent",
    }
    value.update(overrides)
    return value


class ProofMissionContractTests(unittest.TestCase):
    def test_server_recomputes_exact_closure_and_returns_inactive_candidate(self):
        source = source_registration()
        first = derive_proof_mission(source, intent(source))
        second = derive_proof_mission(source, intent(source))

        self.assertEqual(first, second)
        self.assertEqual(first.envelope["schema_id"], "galaxy.proof-mission-candidate.v1")
        self.assertEqual(first.envelope["activation_state"], "inactive")
        self.assertFalse(first.envelope["registerable"])
        self.assertEqual(
            first.envelope["mission_content_sha256"],
            hashlib.sha256(first.mission_bytes).hexdigest(),
        )
        mission = first.envelope["mission_dag"]
        self.assertEqual(mission["graph_kind"], "mission")
        self.assertEqual(
            [target["target_id"] for target in mission["targets"]],
            ["bridge", "foundation", "main"],
        )
        self.assertEqual(
            [relation["relation_id"] for relation in mission["relations"]],
            ["mission-milestone-000001", "r-foundation", "r-main"],
        )
        encoded = json.dumps(first.envelope)
        self.assertNotIn("liveState", encoded)
        self.assertNotIn("provider_status", encoded)
        self.assertNotIn("must-not-survive", encoded)
        self.assertNotIn('"work"', encoded)
        self.assertEqual(
            mission["targets"][1]["formal_binding"]["module_ids"],
            ["LeanProofs.Foundation"],
        )

    def test_milestone_order_is_canonical_and_cannot_widen_the_closure(self):
        source = source_registration()
        with self.assertRaisesRegex(ProofMissionContractError, "outside"):
            derive_proof_mission(
                source,
                intent(source, curated_milestone_target_ids=["unrelated"]),
            )
        one = derive_proof_mission(
            source, intent(source, curated_milestone_target_ids=["foundation", "bridge"])
        )
        two = derive_proof_mission(
            source, intent(source, curated_milestone_target_ids=["bridge", "foundation"])
        )
        self.assertEqual(one, two)

    def test_requires_exact_passive_registered_source_identity(self):
        source = source_registration()
        for changed, message in (
            ({"source_graph": {"graph_id": "other", "graph_kind": "repository-field", "content_sha256": source.content_sha256}}, "graph_id"),
            ({"source_graph": {"graph_id": source.graph_id, "graph_kind": "repository-field", "content_sha256": "0" * 64}}, "content_sha256"),
            ({"relation_direction": "dependent-to-prerequisite"}, "relation_direction"),
        ):
            with self.assertRaisesRegex(ProofMissionContractError, message):
                derive_proof_mission(source, intent(source, **changed))

        mission_document = repository_field()
        mission_document["graph_kind"] = "mission"
        active = source_registration(mission_document)
        with self.assertRaisesRegex(ProofMissionContractError, "passive repository-field"):
            derive_proof_mission(active, intent(active))

    def test_intent_parser_is_bounded_and_rejects_duplicate_fields(self):
        with self.assertRaisesRegex(ProofMissionContractError, "Duplicate"):
            parse_mission_intent_bytes(b'{"schema_id":"a","schema_id":"b"}')
        with self.assertRaisesRegex(ProofMissionContractError, "64 KiB"):
            parse_mission_intent_bytes(b"x" * 65_537)
        source = source_registration()
        surrogate = parse_mission_intent_bytes(
            b'{"schema_id":"galaxy.proof-mission-intent.v1",'
            b'"source_graph":{"graph_id":"leanproofs","graph_kind":"repository-field",'
            b'"content_sha256":"' + source.content_sha256.encode() + b'"},'
            b'"mission_id":"bad\\ud800","main_target_id":"main",'
            b'"curated_milestone_target_ids":[],"relation_direction":"prerequisite-to-dependent"}'
        )
        with self.assertRaisesRegex(ProofMissionContractError, "unpaired surrogate"):
            derive_proof_mission(source, surrogate)

    def test_formal_correspondence_has_one_aggregate_dependency_kind_bound(self):
        document = repository_field()
        document["relations"][1]["formal_correspondence"] = {
            "status": "bridge-candidate",
            "support_kind": None,
            "declaration_path": None,
            "dependency_kinds_by_step": [[f"kind-{index}", f"other-{index}"] for index in range(1_001)],
        }
        source = source_registration(document)
        with self.assertRaisesRegex(ProofMissionContractError, "2000 dependency kinds"):
            derive_proof_mission(source, intent(source))


if __name__ == "__main__":
    unittest.main()
