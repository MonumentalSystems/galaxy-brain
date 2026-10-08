import hashlib
import json
import unittest

from proof_graph_registry import ProofGraphRegistryError, parse_proof_graph_bytes


def artifact(**overrides):
    value = {
        "schema_id": "galaxy.proof-dag.v1",
        "graph_id": "leanproofs",
        "graph_kind": "repository-field",
        "title": "LeanProofs",
        "targets": [
            {"target_id": "definition-1", "title": "Definition"},
            {"target_id": "theorem-1", "title": "Theorem"},
        ],
        "relations": [{
            "relation_id": "dependency-1",
            "prerequisite_target_id": "definition-1",
            "dependent_target_id": "theorem-1",
            "relation_type": "USES",
        }],
    }
    value.update(overrides)
    return value


class ProofGraphRegistryContractTests(unittest.TestCase):
    def test_digest_binds_exact_raw_utf8_bytes_without_canonicalizing(self):
        compact = json.dumps(artifact(), separators=(",", ":"), ensure_ascii=False).encode()
        spaced = json.dumps(artifact(), indent=2, ensure_ascii=False).encode()
        compact_result = parse_proof_graph_bytes(compact)
        spaced_result = parse_proof_graph_bytes(spaced)

        self.assertEqual(compact_result.content_bytes, compact)
        self.assertEqual(compact_result.content_sha256, hashlib.sha256(compact).hexdigest())
        self.assertNotEqual(compact_result.content_sha256, spaced_result.content_sha256)
        self.assertEqual(compact_result.artifact, spaced_result.artifact)
        self.assertEqual(compact_result.target_ids, ("definition-1", "theorem-1"))
        self.assertEqual(compact_result.node_ref_ids, (
            "leanproofs#definition-1", "leanproofs#theorem-1",
        ))

    def test_repository_field_is_valid_but_not_claimability_checked(self):
        value = artifact(
            graph_id="repository/field",
            targets=[{"target_id": "module/theorem"}],
            relations=[],
        )
        result = parse_proof_graph_bytes(json.dumps(value).encode())
        self.assertEqual(result.graph_kind, "repository-field")

    def test_rejects_non_registerable_mission_draft_envelope(self):
        draft = {
            "schema_id": "galaxy.proof-mission-draft.v1",
            "source_graph": {
                "graph_id": "leanproofs",
                "graph_kind": "repository-field",
                "content_sha256": "0" * 64,
            },
            "selection": {
                "mission_id": "prove-theorem-1",
                "main_target_id": "theorem-1",
                "curated_milestone_target_ids": [],
                "relation_direction": "prerequisite-to-dependent",
            },
            "mission_dag": artifact(graph_kind="mission"),
        }
        with self.assertRaisesRegex(ProofGraphRegistryError, "must use galaxy.proof-dag.v1"):
            parse_proof_graph_bytes(json.dumps(draft).encode())

    def test_active_graph_ids_must_fit_ham_resource_keys(self):
        value = artifact(
            graph_kind="mission",
            graph_id="mission/invalid",
            targets=[{"target_id": "node-1"}],
            relations=[],
        )
        with self.assertRaisesRegex(ProofGraphRegistryError, "HAM resource key"):
            parse_proof_graph_bytes(json.dumps(value).encode())

    def test_long_passive_node_identity_uses_the_adapter_opaque_mapping(self):
        graph_id = "g" * 400
        target_id = "t" * 400
        value = artifact(
            graph_id=graph_id,
            targets=[{"target_id": target_id}],
            relations=[],
        )
        result = parse_proof_graph_bytes(json.dumps(value, separators=(",", ":")).encode())
        self.assertEqual(
            result.node_ref_ids,
            (f"proof-node-{result.content_sha256}-0",),
        )

    def test_opaque_node_identity_uses_immutable_target_array_order(self):
        graph_id = "g" * 510
        value = artifact(
            graph_id=graph_id,
            targets=[
                {"target_id": "z-later-lexically"},
                {"target_id": "A-earlier-lexically"},
                {"target_id": "m-mixed_punctuation"},
            ],
            relations=[],
        )
        result = parse_proof_graph_bytes(json.dumps(value, separators=(",", ":")).encode())
        self.assertEqual(
            result.node_ref_ids,
            tuple(
                f"proof-node-{result.content_sha256}-{index}"
                for index in range(3)
            ),
        )

    def test_rejects_unknown_kind_missing_targets_and_dependency_cycles(self):
        with self.assertRaisesRegex(ProofGraphRegistryError, "graph_kind is not supported"):
            parse_proof_graph_bytes(json.dumps(artifact(graph_kind="workspace")).encode())
        with self.assertRaisesRegex(ProofGraphRegistryError, "targets must contain"):
            parse_proof_graph_bytes(json.dumps(artifact(targets=[])).encode())
        cyclic = artifact(relations=[
            {
                "relation_id": "one",
                "prerequisite_target_id": "definition-1",
                "dependent_target_id": "theorem-1",
                "relation_type": "DEPENDS_ON",
            },
            {
                "relation_id": "two",
                "prerequisite_target_id": "theorem-1",
                "dependent_target_id": "definition-1",
                "relation_type": "REDUCES_TO",
            },
        ])
        with self.assertRaisesRegex(ProofGraphRegistryError, "dependency cycle"):
            parse_proof_graph_bytes(json.dumps(cyclic).encode())

    def test_rejects_duplicate_fields_and_non_finite_numbers(self):
        duplicate = b'{"schema_id":"galaxy.proof-dag.v1","schema_id":"x"}'
        with self.assertRaisesRegex(ProofGraphRegistryError, "Duplicate JSON fields"):
            parse_proof_graph_bytes(duplicate)
        invalid_number = json.dumps(artifact()).replace('"title": "LeanProofs"', '"title": NaN').encode()
        with self.assertRaisesRegex(ProofGraphRegistryError, "Non-finite JSON number"):
            parse_proof_graph_bytes(invalid_number)


if __name__ == "__main__":
    unittest.main()
