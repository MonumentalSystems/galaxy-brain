import base64
import hashlib
import json
import unittest
from dataclasses import replace

from proof_verification_set import ExpectedProofSubject, VerifierAdapterEvidence
from trusted_proof_verification import (
    DISABLED_HYADES_ADAPTERS,
    HYADES_ADAPTER_ID,
    HYADES_ADAPTER_VERSION,
    MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES,
    TrustedProofVerificationError,
    parse_trusted_proof_verification_request_bytes,
    run_trusted_verifier_adapter,
)


GRAPH_HASH = "a" * 64
CANDIDATE_HASH = "b" * 64
RECEIPT_BYTES = b'{"provider":"hyades","receipt":"opaque"}'
ADAPTER_KEY = ("test-hyades", "1")


def request_artifact(*, adapter_key=ADAPTER_KEY):
    return {
        "schema_id": "galaxy.trusted-proof-verification-request.v1",
        "graph_ref": {
            "graph_id": "proof-mission",
            "content_sha256": GRAPH_HASH,
        },
        "node_id": "target-a",
        "candidate_sha256": CANDIDATE_HASH,
        "expected_workspace_version": 7,
        "expected_item_version": 2,
        "idempotency_key": "verify-target-a-0001",
        "receipt": {
            "adapter_id": adapter_key[0],
            "adapter_version": adapter_key[1],
            "media_type": "application/json",
            "content_encoding": "base64",
            "content_sha256": hashlib.sha256(RECEIPT_BYTES).hexdigest(),
            "content_base64": base64.b64encode(RECEIPT_BYTES).decode("ascii"),
        },
    }


def encode(value, *, indent=None):
    return json.dumps(value, ensure_ascii=False, indent=indent).encode("utf-8")


def subject(**changes):
    value = ExpectedProofSubject(
        graph_id="proof-mission",
        graph_content_sha256=GRAPH_HASH,
        node_id="target-a",
        declaration_ids=("LeanProofs.Main.theorem",),
        source_repository="MonumentalSystems/LeanProofs",
        source_commit="d" * 40,
        lean_toolchain="leanprover/lean4:v4.30.0",
        mathlib_revision="e" * 40,
    )
    return replace(value, **changes)


def evidence(adapter_request, **changes):
    value = VerifierAdapterEvidence(
        adapter_id=adapter_request.adapter_id,
        adapter_version=adapter_request.adapter_version,
        receipt_sha256=adapter_request.receipt_sha256,
        outcome="accepted",
        solution_sha256=adapter_request.candidate_sha256,
        sorry_free=True,
        verifier_system="hyades",
        method="hyades-run",
        subject_graph_id=adapter_request.graph_id,
        subject_graph_content_sha256=adapter_request.graph_content_sha256,
        subject_node_id=adapter_request.node_id,
        subject_declaration_ids=adapter_request.expected_subject.declaration_ids,
        source_repository=adapter_request.expected_subject.source_repository,
        source_commit=adapter_request.expected_subject.source_commit,
        lean_toolchain=adapter_request.expected_subject.lean_toolchain,
        mathlib_revision=adapter_request.expected_subject.mathlib_revision,
        verified_at="2026-09-13T12:00:00Z",
        hyades={
            "workflow_id": "proof-workflow-v1",
            "run_id": "run-1",
            "status": "completed",
        },
        safe_for_storage=True,
    )
    return replace(value, **changes)


def parse(value=None, *, allowed=(ADAPTER_KEY,), content=None, **kwargs):
    return parse_trusted_proof_verification_request_bytes(
        content if content is not None else encode(value or request_artifact()),
        allowed_adapters=allowed,
        **kwargs,
    )


class TrustedProofVerificationTests(unittest.TestCase):
    def test_request_binds_exact_bytes_hash_graph_candidate_and_receipt(self):
        content = encode(request_artifact(), indent=2)
        parsed = parse(content=content, expected_graph_id="proof-mission", expected_graph_sha256=GRAPH_HASH)
        self.assertEqual(parsed.content_bytes, content)
        self.assertEqual(parsed.request_sha256, hashlib.sha256(content).hexdigest())
        self.assertEqual(parsed.item.candidate_sha256, CANDIDATE_HASH)
        self.assertEqual(parsed.item.receipt_bytes, RECEIPT_BYTES)
        self.assertEqual(parsed.item.receipt_sha256, hashlib.sha256(RECEIPT_BYTES).hexdigest())
        self.assertEqual(parsed.adapter_key, ADAPTER_KEY)
        self.assertEqual(parsed.expected_workspace_version, 7)
        self.assertEqual(parsed.expected_item_version, 2)
        self.assertEqual(parsed.idempotency_key, "verify-target-a-0001")

    def test_concurrency_and_replay_controls_are_required_and_bounded(self):
        for field in (
            "expected_workspace_version",
            "expected_item_version",
            "idempotency_key",
        ):
            with self.subTest(missing=field):
                artifact = request_artifact()
                del artifact[field]
                with self.assertRaisesRegex(
                    TrustedProofVerificationError, f"{field} is required"
                ):
                    parse(artifact)

        invalid_versions = (
            ("expected_workspace_version", 0, "positive integer"),
            ("expected_workspace_version", True, "positive integer"),
            ("expected_item_version", -1, "non-negative integer"),
            ("expected_item_version", False, "non-negative integer"),
        )
        for field, value, message in invalid_versions:
            with self.subTest(field=field, value=value):
                artifact = request_artifact()
                artifact[field] = value
                with self.assertRaisesRegex(TrustedProofVerificationError, message):
                    parse(artifact)

        for key in ("short", "x" * 201):
            with self.subTest(idempotency_key=key[:10]):
                artifact = request_artifact()
                artifact["idempotency_key"] = key
                with self.assertRaisesRegex(
                    TrustedProofVerificationError,
                    "8-200 characters|exceeds 200 characters",
                ):
                    parse(artifact)

    def test_idempotency_key_uses_proof_work_normalization_but_hashes_exact_bytes(self):
        artifact = request_artifact()
        artifact["idempotency_key"] = "  verify-target-a-0001  "
        content = encode(artifact, indent=2)
        parsed = parse(content=content)
        self.assertEqual(parsed.idempotency_key, "verify-target-a-0001")
        self.assertEqual(parsed.artifact["idempotency_key"], "verify-target-a-0001")
        self.assertEqual(parsed.content_bytes, content)
        self.assertEqual(parsed.request_sha256, hashlib.sha256(content).hexdigest())

    def test_exact_request_hash_can_be_required(self):
        content = encode(request_artifact())
        digest = hashlib.sha256(content).hexdigest()
        self.assertEqual(
            parse(content=content, expected_request_sha256=digest).request_sha256,
            digest,
        )
        with self.assertRaisesRegex(TrustedProofVerificationError, "do not match request_sha256"):
            parse(content=content, expected_request_sha256="0" * 64)

    def test_request_is_bounded_and_strict_json(self):
        with self.assertRaisesRegex(TrustedProofVerificationError, "1 byte to 2 MiB"):
            parse_trusted_proof_verification_request_bytes(
                b"x" * (MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES + 1),
                allowed_adapters=(ADAPTER_KEY,),
            )
        duplicate = b'{"schema_id":"x","schema_id":"y"}'
        with self.assertRaisesRegex(TrustedProofVerificationError, "Duplicate JSON"):
            parse(content=duplicate)

    def test_caller_cannot_submit_authoritative_verification_fields(self):
        for field, value in (
            ("outcome", "accepted"),
            ("verifier", "hyades"),
            ("solution_sha256", CANDIDATE_HASH),
            ("status", "verified"),
        ):
            with self.subTest(field=field):
                artifact = request_artifact()
                artifact[field] = value
                with self.assertRaisesRegex(
                    TrustedProofVerificationError, f"unknown field {field}"
                ):
                    parse(artifact)

        nested = request_artifact()
        nested["receipt"]["outcome"] = "accepted"
        with self.assertRaisesRegex(TrustedProofVerificationError, "unknown field outcome"):
            parse(nested)

    def test_receipt_and_graph_hashes_are_not_advisory(self):
        artifact = request_artifact()
        artifact["receipt"]["content_sha256"] = "0" * 64
        with self.assertRaisesRegex(TrustedProofVerificationError, "exact receipt bytes"):
            parse(artifact)
        with self.assertRaisesRegex(TrustedProofVerificationError, "graph_id does not match"):
            parse(request_artifact(), expected_graph_id="another-graph")

    def test_adapter_selection_must_be_exactly_allowlisted(self):
        with self.assertRaisesRegex(TrustedProofVerificationError, "not allowlisted"):
            parse(request_artifact(), allowed=((ADAPTER_KEY[0], "2"),))
        with self.assertRaisesRegex(TrustedProofVerificationError, "invalid id/version"):
            parse(request_artifact(), allowed=(("Bad Adapter", "1"),))

    def test_typed_code_owned_adapter_output_is_bound(self):
        parsed = parse()
        observed = []

        def adapter(adapter_request):
            observed.append(adapter_request)
            return evidence(adapter_request)

        bound = run_trusted_verifier_adapter(
            parsed, subject(), {ADAPTER_KEY: adapter}
        )
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0].receipt_bytes, RECEIPT_BYTES)
        self.assertEqual(bound.candidate_sha256, CANDIDATE_HASH)
        self.assertEqual(bound.verifier_system, "hyades")
        self.assertEqual(bound.hyades["run_id"], "run-1")

    def test_adapter_output_must_bind_candidate_receipt_and_subject(self):
        parsed = parse()
        cases = (
            ({"solution_sha256": "0" * 64}, "adapter-derived solution"),
            ({"receipt_sha256": "0" * 64}, "exact receipt bytes"),
            ({"subject_graph_content_sha256": "0" * 64}, "graph digest"),
            ({"outcome": "rejected"}, "accepted and sorry-free"),
            ({"sorry_free": False}, "accepted and sorry-free"),
            ({"hyades": {"workflow_id": "w", "run_id": "r", "status": "running"}}, "completed run"),
        )
        for changes, message in cases:
            with self.subTest(changes=changes):
                def adapter(adapter_request, changes=changes):
                    return evidence(adapter_request, **changes)

                with self.assertRaisesRegex(TrustedProofVerificationError, message):
                    run_trusted_verifier_adapter(
                        parsed, subject(), {ADAPTER_KEY: adapter}
                    )

    def test_untyped_or_raising_adapters_fail_closed(self):
        parsed = parse()
        with self.assertRaisesRegex(TrustedProofVerificationError, "unsupported evidence"):
            run_trusted_verifier_adapter(
                parsed, subject(), {ADAPTER_KEY: lambda _request: {"outcome": "accepted"}}
            )

        def broken(_request):
            raise RuntimeError("provider secret detail")

        with self.assertRaisesRegex(TrustedProofVerificationError, "failed closed") as caught:
            run_trusted_verifier_adapter(parsed, subject(), {ADAPTER_KEY: broken})
        self.assertNotIn("provider secret detail", str(caught.exception))

    def test_hyades_is_present_only_as_a_disabled_fail_closed_adapter(self):
        artifact = request_artifact(
            adapter_key=(HYADES_ADAPTER_ID, HYADES_ADAPTER_VERSION)
        )
        parsed = parse(
            artifact,
            allowed=((HYADES_ADAPTER_ID, HYADES_ADAPTER_VERSION),),
        )
        with self.assertRaisesRegex(TrustedProofVerificationError, "disabled"):
            run_trusted_verifier_adapter(
                parsed, subject(), DISABLED_HYADES_ADAPTERS
            )


if __name__ == "__main__":
    unittest.main()
