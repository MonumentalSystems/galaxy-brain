import base64
import hashlib
import json
import unittest
from dataclasses import replace

from proof_mission_activation import (
    ProofMissionActivationError,
    compile_proof_mission_activation,
)
from proof_verification_set import (
    BoundProofVerification,
    parse_proof_verification_set_bytes,
)


def repository_field():
    return {
        "schema_id": "galaxy.proof-dag.v1",
        "graph_id": "leanproofs",
        "graph_kind": "repository-field",
        "title": "LeanProofs",
        "revision": {
            "repository": "MonumentalSystems/LeanProofs",
            "commit": "a" * 40,
            "lean_toolchain": "leanprover/lean4:v4.30.0",
            "mathlib_revision": "b" * 40,
        },
        "targets": [
            {
                "target_id": "foundation",
                "title": "Foundation",
                "formal_binding": {
                    "status": "mapped",
                    "binding_kind": "declaration",
                    "declaration_ids": ["LeanProofs.Foundation.base"],
                    "declaration_equivalence_claimed": True,
                },
            },
            {
                "target_id": "bridge",
                "title": "Bridge",
                "formal_binding": {"status": "unmapped"},
            },
            {
                "target_id": "main",
                "title": "Main theorem",
                "formal_binding": {"status": "unmapped"},
            },
            {
                "target_id": "unrelated",
                "title": "Unrelated theorem",
                "formal_binding": {
                    "status": "mapped",
                    "binding_kind": "declaration",
                    "declaration_ids": ["LeanProofs.Unrelated.theorem"],
                    "declaration_equivalence_claimed": True,
                },
            },
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
            },
        ],
    }


def json_bytes(value, *, pretty=False):
    return json.dumps(
        value,
        ensure_ascii=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    ).encode("utf-8")


def intent(graph_hash):
    return {
        "schema_id": "galaxy.proof-mission-intent.v1",
        "source_graph": {
            "graph_id": "leanproofs",
            "graph_kind": "repository-field",
            "content_sha256": graph_hash,
        },
        "mission_id": "prove-main-v1",
        "main_target_id": "main",
        "curated_milestone_target_ids": ["bridge"],
        "relation_direction": "prerequisite-to-dependent",
    }


def receipt(node_id):
    content = f"verified:{node_id}".encode("utf-8")
    return {
        "adapter_id": "lean-replay",
        "adapter_version": "1",
        "media_type": "application/octet-stream",
        "content_encoding": "base64",
        "content_sha256": hashlib.sha256(content).hexdigest(),
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


def verification_set(graph_hash, node_ids=()):
    value = {
        "schema_id": "galaxy.proof-verification-set.v1",
        "graph_ref": {
            "graph_id": "leanproofs",
            "content_sha256": graph_hash,
        },
        "items": [
            {
                "node_id": node_id,
                "candidate_sha256": hashlib.sha256(
                    f"candidate:{node_id}".encode("utf-8")
                ).hexdigest(),
                "receipt": receipt(node_id),
            }
            for node_id in node_ids
        ],
    }
    return parse_proof_verification_set_bytes(json_bytes(value, pretty=True))


def bound_record(parsed_set, node_id):
    item = next(item for item in parsed_set.items if item.node_id == node_id)
    declaration = {
        "foundation": "LeanProofs.Foundation.base",
        "unrelated": "LeanProofs.Unrelated.theorem",
    }[node_id]
    return BoundProofVerification(
        node_id=node_id,
        candidate_sha256=item.candidate_sha256,
        receipt_sha256=item.receipt_sha256,
        adapter_id=item.adapter_id,
        adapter_version=item.adapter_version,
        verifier_system="lean-replay",
        method="lean-replay",
        subject_declaration_ids=(declaration,),
        source_repository="MonumentalSystems/LeanProofs",
        source_commit="a" * 40,
        lean_toolchain="leanprover/lean4:v4.30.0",
        mathlib_revision="b" * 40,
        verified_at="2026-09-13T12:00:00Z",
        hyades=None,
    )


def inputs(node_ids=()):
    graph_bytes = json_bytes(repository_field(), pretty=True)
    graph_hash = hashlib.sha256(graph_bytes).hexdigest()
    intent_bytes = json_bytes(intent(graph_hash), pretty=True)
    parsed_set = verification_set(graph_hash, node_ids)
    return {
        "source_graph_bytes": graph_bytes,
        "source_graph_sha256": graph_hash,
        "mission_intent_bytes": intent_bytes,
        "mission_intent_sha256": hashlib.sha256(intent_bytes).hexdigest(),
        "verification_set_bytes": parsed_set.content_bytes,
        "verification_set_sha256": parsed_set.content_sha256,
        "verification_records": tuple(
            bound_record(parsed_set, node_id) for node_id in node_ids
        ),
    }, parsed_set


class ProofMissionActivationTests(unittest.TestCase):
    def test_empty_explicit_baseline_compiles_deterministic_transaction_data(self):
        arguments, _ = inputs()
        first = compile_proof_mission_activation(**arguments)
        second = compile_proof_mission_activation(**arguments)

        self.assertEqual(first, second)
        self.assertEqual(
            first.content_sha256, hashlib.sha256(first.content_bytes).hexdigest()
        )
        self.assertEqual(
            first.envelope["workspace_seed"]["node_ids"],
            ["bridge", "foundation", "main"],
        )
        self.assertEqual(
            first.envelope["mission_graph"]["artifact"]["mission"],
            {
                "main_target_id": "main",
                "curated_milestone_target_ids": ["bridge"],
            },
        )
        self.assertEqual(first.inherited_verifications, ())
        self.assertEqual(
            first.envelope["workspace_seed"]["inherited_verified_node_ids"], []
        )
        encoded = first.content_bytes.decode("utf-8")
        self.assertNotIn('"work"', encoded)
        self.assertNotIn('"liveState"', encoded)
        self.assertNotIn('"ham_task"', encoded)

    def test_only_normalized_verified_records_inside_rederived_closure_are_inherited(self):
        arguments, _ = inputs(("unrelated", "foundation"))
        result = compile_proof_mission_activation(**arguments)

        self.assertEqual(
            [record.node_id for record in result.inherited_verifications],
            ["foundation"],
        )
        self.assertEqual(
            result.envelope["workspace_seed"]["inherited_verified_node_ids"],
            ["foundation"],
        )
        self.assertEqual(
            [item["node_id"] for item in result.envelope["inherited_verifications"]],
            ["foundation"],
        )

    def test_all_three_immutable_artifact_hashes_are_exact(self):
        arguments, _ = inputs()
        for field in (
            "source_graph_sha256",
            "mission_intent_sha256",
            "verification_set_sha256",
        ):
            changed = dict(arguments)
            changed[field] = "0" * 64
            with self.subTest(field=field), self.assertRaisesRegex(
                ProofMissionActivationError, "registered content_sha256"
            ):
                compile_proof_mission_activation(**changed)

    def test_passive_graph_alone_cannot_become_a_claimable_mission(self):
        arguments, _ = inputs()
        arguments["verification_set_bytes"] = arguments["source_graph_bytes"]
        arguments["verification_set_sha256"] = arguments["source_graph_sha256"]
        with self.assertRaisesRegex(
            ProofMissionActivationError, "Proof verification set"
        ):
            compile_proof_mission_activation(**arguments)

    def test_verification_set_must_be_its_exact_canonical_registered_bytes(self):
        arguments, parsed_set = inputs()
        alternate = json_bytes(parsed_set.artifact, pretty=True)
        arguments["verification_set_bytes"] = alternate
        arguments["verification_set_sha256"] = hashlib.sha256(alternate).hexdigest()
        with self.assertRaisesRegex(
            ProofMissionActivationError, "exact canonical registered artifact"
        ):
            compile_proof_mission_activation(**arguments)

    def test_normalized_records_must_exactly_cover_and_match_the_set(self):
        arguments, _ = inputs(("foundation",))
        missing = dict(arguments)
        missing["verification_records"] = ()
        with self.assertRaisesRegex(ProofMissionActivationError, "exactly cover"):
            compile_proof_mission_activation(**missing)

        mismatched = dict(arguments)
        mismatched["verification_records"] = (
            replace(arguments["verification_records"][0], candidate_sha256="0" * 64),
        )
        with self.assertRaisesRegex(ProofMissionActivationError, "exact set item"):
            compile_proof_mission_activation(**mismatched)

    def test_normalized_record_subject_is_rebound_to_source_graph(self):
        arguments, _ = inputs(("foundation",))
        changed = dict(arguments)
        changed["verification_records"] = (
            replace(
                arguments["verification_records"][0],
                source_commit="c" * 40,
            ),
        )
        with self.assertRaisesRegex(ProofMissionActivationError, "provenance"):
            compile_proof_mission_activation(**changed)

    def test_intent_source_and_set_must_bind_the_same_exact_repository_field(self):
        arguments, parsed_set = inputs()
        wrong_set = dict(parsed_set.artifact)
        wrong_set["graph_ref"] = {
            "graph_id": "leanproofs",
            "content_sha256": "f" * 64,
        }
        canonical = parse_proof_verification_set_bytes(json_bytes(wrong_set)).content_bytes
        arguments["verification_set_bytes"] = canonical
        arguments["verification_set_sha256"] = hashlib.sha256(canonical).hexdigest()
        with self.assertRaisesRegex(ProofMissionActivationError, "does not match the graph"):
            compile_proof_mission_activation(**arguments)


if __name__ == "__main__":
    unittest.main()
