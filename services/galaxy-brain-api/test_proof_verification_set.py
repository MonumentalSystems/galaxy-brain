import base64
import hashlib
import json
import unittest
from dataclasses import replace

from proof_verification_set import (
    MAX_PROOF_VERIFICATION_SET_BYTES,
    ExpectedProofSubject,
    ProofVerificationSetError,
    VerifierAdapterEvidence,
    bind_verifier_adapter_evidence,
    parse_proof_verification_set_bytes,
    run_verifier_adapter,
)


GRAPH_HASH = "a" * 64
SOLUTION = "b" * 64


def receipt_artifact(
    content=b'{ "provider": "hyades", "nativeFormat": true }',
    *,
    adapter_id="hyades-receipt",
    adapter_version="1",
    media_type="application/json",
):
    return {
        "adapter_id": adapter_id,
        "adapter_version": adapter_version,
        "media_type": media_type,
        "content_encoding": "base64",
        "content_sha256": hashlib.sha256(content).hexdigest(),
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


def item(node_id="target-a", candidate=SOLUTION, content=None):
    return {
        "node_id": node_id,
        "candidate_sha256": candidate,
        "receipt": receipt_artifact(content) if content is not None else receipt_artifact(),
    }


def verification_set(items=None):
    return {
        "schema_id": "galaxy.proof-verification-set.v1",
        "graph_ref": {"graph_id": "proof-mission", "content_sha256": GRAPH_HASH},
        "items": items or [],
    }


def parse(value, **kwargs):
    return parse_proof_verification_set_bytes(
        json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"), **kwargs
    )


def adapter_evidence(parsed_item, **changes):
    base = VerifierAdapterEvidence(
        adapter_id=parsed_item.adapter_id,
        adapter_version=parsed_item.adapter_version,
        receipt_sha256=parsed_item.receipt_sha256,
        outcome="accepted",
        solution_sha256=parsed_item.candidate_sha256,
        sorry_free=True,
        verifier_system="hyades",
        method="hyades-run",
        subject_graph_id="proof-mission",
        subject_graph_content_sha256=GRAPH_HASH,
        subject_node_id=parsed_item.node_id,
        subject_declaration_ids=("LeanProofs.Main.theorem",),
        source_repository="MonumentalSystems/LeanProofs",
        source_commit="d" * 40,
        lean_toolchain="leanprover/lean4:v4.30.0",
        mathlib_revision="e" * 40,
        verified_at="2026-09-13T12:00:00Z",
        hyades={"workflow_id": "proof-workflow-v1", "run_id": "run-1", "status": "completed"},
        safe_for_storage=True,
    )
    return replace(base, **changes)


def expected_subject(**changes):
    base = ExpectedProofSubject(
        graph_id="proof-mission",
        graph_content_sha256=GRAPH_HASH,
        node_id="target-a",
        declaration_ids=("LeanProofs.Main.theorem",),
        source_repository="MonumentalSystems/LeanProofs",
        source_commit="d" * 40,
        lean_toolchain="leanprover/lean4:v4.30.0",
        mathlib_revision="e" * 40,
    )
    return replace(base, **changes)


class ProofVerificationSetTests(unittest.TestCase):
    def test_empty_set_is_an_explicit_deterministic_baseline(self):
        first = parse(verification_set())
        second = parse_proof_verification_set_bytes(first.content_bytes)
        self.assertEqual(first.items, ())
        self.assertEqual(first.content_bytes, second.content_bytes)
        self.assertEqual(first.content_sha256, second.content_sha256)
        self.assertEqual(first.content_sha256, hashlib.sha256(first.content_bytes).hexdigest())

    def test_provider_receipts_remain_exact_opaque_bytes(self):
        native = b"\x00provider-native\xff\nnot canonical JSON"
        result = parse(verification_set([item("zeta"), item("alpha", content=native)]))
        self.assertEqual([entry.node_id for entry in result.items], ["alpha", "zeta"])
        self.assertEqual(result.items[0].receipt_bytes, native)
        self.assertEqual(
            result.items[0].receipt_sha256, hashlib.sha256(native).hexdigest()
        )
        self.assertNotIn("outcome", result.artifact["items"][0])

    def test_graph_reference_can_be_bound_to_an_exact_registered_graph(self):
        result = parse(
            verification_set(),
            expected_graph_id="proof-mission",
            expected_graph_sha256=GRAPH_HASH,
        )
        self.assertEqual(result.graph_id, "proof-mission")
        self.assertEqual(result.graph_content_sha256, GRAPH_HASH)
        with self.assertRaisesRegex(ProofVerificationSetError, "graph_id does not match"):
            parse(verification_set(), expected_graph_id="another-graph")
        with self.assertRaisesRegex(ProofVerificationSetError, "content_sha256 does not match"):
            parse(verification_set(), expected_graph_sha256="0" * 64)

    def test_nodes_are_unique_and_receipt_hash_is_exact(self):
        with self.assertRaisesRegex(ProofVerificationSetError, "target-a is duplicated"):
            parse(verification_set([item(), item()]))
        with self.assertRaisesRegex(ProofVerificationSetError, "receipt .* is duplicated"):
            parse(verification_set([item("target-a"), item("target-b")]))
        tampered = item()
        tampered["receipt"]["content_sha256"] = "0" * 64
        with self.assertRaisesRegex(ProofVerificationSetError, "exact receipt bytes"):
            parse(verification_set([tampered]))

    def test_outer_contract_rejects_unknown_sensitive_and_unpaired_fields(self):
        extra = verification_set()
        extra["raw_logs"] = []
        with self.assertRaisesRegex(ProofVerificationSetError, "unknown field raw_logs"):
            parse(extra)
        secret = item()
        secret["receipt"]["credentials"] = "never"
        with self.assertRaisesRegex(ProofVerificationSetError, "unknown field credentials"):
            parse(verification_set([secret]))
        broken = item()
        broken["receipt"]["media_type"] = "application/\ud800"
        with self.assertRaisesRegex(ProofVerificationSetError, "unpaired surrogate"):
            parse_proof_verification_set_bytes(
                json.dumps(verification_set([broken]), ensure_ascii=True).encode("utf-8")
            )

    def test_strong_top_level_and_receipt_bounds(self):
        with self.assertRaisesRegex(ProofVerificationSetError, "1 byte to 16 MiB"):
            parse_proof_verification_set_bytes(b"x" * (MAX_PROOF_VERIFICATION_SET_BYTES + 1))
        oversized = item(content=b"x" * 1_048_577)
        with self.assertRaisesRegex(ProofVerificationSetError, "1048576 bytes"):
            parse(verification_set([oversized]))
        too_many = verification_set([{}] * 10_001)
        with self.assertRaisesRegex(ProofVerificationSetError, "at most 10000"):
            parse(too_many)

    def test_adapter_binding_requires_exact_receipt_candidate_and_subject(self):
        registration = parse(verification_set([item()]))
        parsed_item = registration.items[0]
        bound = bind_verifier_adapter_evidence(
            registration, parsed_item, expected_subject(), adapter_evidence(parsed_item)
        )
        self.assertEqual(bound.candidate_sha256, SOLUTION)
        self.assertEqual(bound.subject_declaration_ids, ("LeanProofs.Main.theorem",))

        cases = [
            ("receipt_sha256", "0" * 64, "exact receipt bytes"),
            ("solution_sha256", "0" * 64, "adapter-derived solution"),
            ("subject_graph_id", "other", "graph_id"),
            ("subject_graph_content_sha256", "0" * 64, "graph digest"),
            ("subject_node_id", "other", "subject node"),
            ("adapter_version", "2", "requested adapter"),
        ]
        for field, value, message in cases:
            with self.subTest(field=field), self.assertRaisesRegex(
                ProofVerificationSetError, message
            ):
                bind_verifier_adapter_evidence(
                    registration,
                    parsed_item,
                    expected_subject(),
                    adapter_evidence(parsed_item, **{field: value}),
                )

        for subject, message in [
            (expected_subject(declaration_ids=("LeanProofs.Other",)), "declarations"),
            (expected_subject(source_commit="f" * 40), "provenance"),
        ]:
            with self.subTest(subject=subject), self.assertRaisesRegex(
                ProofVerificationSetError, message
            ):
                bind_verifier_adapter_evidence(
                    registration, parsed_item, subject, adapter_evidence(parsed_item)
                )

    def test_adapter_binding_requires_accepted_safe_sorry_free_evidence(self):
        registration = parse(verification_set([item()]))
        parsed_item = registration.items[0]
        for field, value, message in [
            ("outcome", "rejected", "accepted and sorry-free"),
            ("sorry_free", False, "accepted and sorry-free"),
            ("safe_for_storage", False, "credentials and raw logs"),
        ]:
            with self.subTest(field=field), self.assertRaisesRegex(
                ProofVerificationSetError, message
            ):
                bind_verifier_adapter_evidence(
                    registration,
                    parsed_item,
                    expected_subject(),
                    adapter_evidence(parsed_item, **{field: value}),
                )

    def test_adapter_binding_keeps_hyades_and_lean_replay_distinct(self):
        registration = parse(verification_set([item()]))
        parsed_item = registration.items[0]
        running = adapter_evidence(
            parsed_item,
            hyades={"workflow_id": "workflow", "run_id": "run", "status": "running"},
        )
        with self.assertRaisesRegex(ProofVerificationSetError, "completed run"):
            bind_verifier_adapter_evidence(
                registration, parsed_item, expected_subject(), running
            )

        replay = adapter_evidence(
            parsed_item,
            verifier_system="lean-replay",
            method="lean-replay",
            hyades=None,
        )
        bound = bind_verifier_adapter_evidence(
            registration, parsed_item, expected_subject(), replay
        )
        self.assertEqual(bound.method, "lean-replay")
        with self.assertRaisesRegex(ProofVerificationSetError, "cannot claim a Hyades run"):
            bind_verifier_adapter_evidence(
                registration,
                parsed_item,
                expected_subject(),
                replace(replay, hyades={"status": "completed"}),
            )

    def test_adapter_runner_supplies_exact_context_and_rejects_dummy_entries(self):
        registration = parse(verification_set([item()]))
        parsed_item = registration.items[0]
        requests = []

        def adapter(request):
            requests.append(request)
            return adapter_evidence(parsed_item)

        bound = run_verifier_adapter(
            registration, parsed_item, expected_subject(), adapter
        )
        self.assertEqual(bound.receipt_sha256, parsed_item.receipt_sha256)
        self.assertEqual(requests[0].receipt_bytes, parsed_item.receipt_bytes)
        self.assertEqual(requests[0].graph_content_sha256, GRAPH_HASH)
        self.assertEqual(requests[0].node_id, "target-a")
        self.assertEqual(requests[0].candidate_sha256, SOLUTION)
        self.assertEqual(
            requests[0].expected_subject.declaration_ids,
            ("LeanProofs.Main.theorem",),
        )

        for invalid in [None, {}, "configured", lambda request: {}]:
            with self.subTest(invalid=invalid), self.assertRaises(
                ProofVerificationSetError
            ):
                run_verifier_adapter(
                    registration, parsed_item, expected_subject(), invalid
                )

    def test_adapter_runner_rejects_malformed_provenance_before_invocation(self):
        registration = parse(verification_set([item()]))
        parsed_item = registration.items[0]
        calls = []

        def adapter(request):
            calls.append(request)
            return adapter_evidence(parsed_item)

        for subject in [
            expected_subject(source_commit="not-a-git-oid"),
            expected_subject(mathlib_revision="also-invalid"),
        ]:
            with self.subTest(subject=subject), self.assertRaisesRegex(
                ProofVerificationSetError, "lowercase Git object ID"
            ):
                run_verifier_adapter(registration, parsed_item, subject, adapter)

        self.assertEqual(calls, [])

    def test_duplicate_json_fields_and_nonfinite_numbers_are_rejected(self):
        with self.assertRaisesRegex(ProofVerificationSetError, "Duplicate JSON fields"):
            parse_proof_verification_set_bytes(
                b'{"schema_id":"galaxy.proof-verification-set.v1","schema_id":"x"}'
            )
        with self.assertRaisesRegex(ProofVerificationSetError, "Non-finite"):
            parse_proof_verification_set_bytes(
                b'{"schema_id":"galaxy.proof-verification-set.v1","graph_ref":{},"items":NaN}'
            )


if __name__ == "__main__":
    unittest.main()
