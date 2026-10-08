import base64
import copy
import hashlib
import json
import re
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from proof_verification_set import ExpectedProofSubject, ProofVerificationSetError
from proofs_blah_dev_adapter import (
    MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES,
    PINNED_ATTESTATION_KEYS,
    PROOFS_BLAH_DEV_ADAPTER,
    PROOFS_BLAH_DEV_ADAPTER_ID,
    PROOFS_BLAH_DEV_ADAPTER_VERSION,
    PROOFS_BLAH_DEV_MEDIA_TYPE,
    ProofsBlahDevReportAdapter,
    _js_number,
    canonical_report_json,
    proofs_blah_dev_adapter_implementation_sha256,
)
from trusted_proof_verification import (
    TrustedProofVerificationError,
    parse_trusted_proof_verification_request_bytes,
    run_trusted_verifier_adapter,
)


SERVICE = Path(__file__).resolve().parent
FIXTURES = SERVICE / "contracts" / "fixtures"
REPORT_BYTES = (FIXTURES / "proofs-blah-dev.report.zero_isExact2.json").read_bytes()
SOLUTION_BYTES = (FIXTURES / "Solution.zero_isExact2.lean").read_bytes()
KEYS = json.loads(
    (FIXTURES / "proofs-blah-dev.attestation-keys.json").read_text(encoding="utf-8")
)
FIXTURE_REPORT_HASH = "ec589f440ff5417af435873a268f73a97516087cc1a8dbc6caf4ac7569f1f241"
SOLUTION_SHA256 = "dbb25c72f6187f1d6e6c578425a3e9ed90d79c9b448c859251f87847c65e1ec6"
ADAPTER_KEY = (PROOFS_BLAH_DEV_ADAPTER_ID, PROOFS_BLAH_DEV_ADAPTER_VERSION)
GRAPH_HASH = "a" * 64
COMMIT = "c" * 40
DECLARATION = "LeanProofsP2M.Rosetta.CellularMemory.Chain3.zero_isExact2"
REPOSITORY = "MonumentalSystems/LeanProofs"
MATHLIB = "0df444a360eaa60ab8c11dca51a86af692955474"

TEST_KEY = Ed25519PrivateKey.generate()
TEST_PEM = TEST_KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
).decode("ascii")
TEST_KEY_ID = "ed25519:" + hashlib.sha256(
    TEST_KEY.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
).hexdigest()[:16]
TEST_ADAPTER = ProofsBlahDevReportAdapter(attestation_keys={TEST_KEY_ID: TEST_PEM})


def subject(**changes):
    value = {
        "graph_id": "leanproofs-mission",
        "graph_content_sha256": GRAPH_HASH,
        "node_id": "zero-isExact2",
        "declaration_ids": (DECLARATION,),
        "source_repository": REPOSITORY,
        "source_commit": COMMIT,
        "lean_toolchain": "leanprover/lean4:v4.33.1",
        "mathlib_revision": MATHLIB,
    }
    value.update(changes)
    return ExpectedProofSubject(**value)


def origin(**changes):
    value = {
        "collection": "leanproofs",
        "repository": REPOSITORY,
        "revision": COMMIT,
        "path": "LeanProofsP2M/Rosetta/CellularMemory/Chain3.lean",
        "line_start": 31,
        "line_end": 34,
        "declaration": DECLARATION,
        "key": f"lean:{REPOSITORY}@{COMMIT}/{DECLARATION}",
    }
    value.update(changes)
    return value


def fixture_report():
    return copy.deepcopy(json.loads(REPORT_BYTES)["report"])


def signed_report(**changes):
    report = fixture_report()
    report["attestation_key_id"] = TEST_KEY_ID
    report["origin"] = origin()
    report.update(changes)
    return report


def sign(report, *, key=TEST_KEY, key_id=TEST_KEY_ID, report_hash=None, signed_digest=None):
    digest = hashlib.sha256(canonical_report_json(report)).hexdigest()
    signature = key.sign(bytes.fromhex(signed_digest or digest))
    body = {
        "report_id": report["report_id"],
        "report": report,
        "report_hash": report_hash or f"sha256:{digest}",
        "attestation": {
            "key_id": key_id,
            "signature": base64.urlsafe_b64encode(signature).decode("ascii").rstrip("="),
            "algorithm": "ed25519 over the raw SHA-256 digest of the canonical report JSON",
        },
        "created_at": "2026-09-29T05:41:48.746Z",
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def parse(receipt_bytes, *, candidate=SOLUTION_SHA256, media_type=PROOFS_BLAH_DEV_MEDIA_TYPE):
    artifact = {
        "schema_id": "galaxy.trusted-proof-verification-request.v1",
        "graph_ref": {"graph_id": "leanproofs-mission", "content_sha256": GRAPH_HASH},
        "node_id": "zero-isExact2",
        "candidate_sha256": candidate,
        "expected_workspace_version": 3,
        "expected_item_version": 2,
        "idempotency_key": "verify-zero-isExact2-0001",
        "receipt": {
            "adapter_id": ADAPTER_KEY[0],
            "adapter_version": ADAPTER_KEY[1],
            "media_type": media_type,
            "content_encoding": "base64",
            "content_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "content_base64": base64.b64encode(receipt_bytes).decode("ascii"),
        },
    }
    return parse_trusted_proof_verification_request_bytes(
        json.dumps(artifact).encode("utf-8"), allowed_adapters=(ADAPTER_KEY,)
    )


def verify(receipt_bytes, *, adapter=TEST_ADAPTER, expected=None, **kwargs):
    return run_trusted_verifier_adapter(
        parse(receipt_bytes, **kwargs), expected or subject(), {ADAPTER_KEY: adapter}
    )


class ProofsBlahDevAdapterTests(unittest.TestCase):
    def assertRejected(self, receipt_bytes, message, **kwargs):
        with self.assertRaisesRegex(TrustedProofVerificationError, message):
            verify(receipt_bytes, **kwargs)

    def test_canonical_json_reproduces_the_real_report_hash(self):
        receipt = json.loads(REPORT_BYTES)
        digest = hashlib.sha256(canonical_report_json(receipt["report"])).hexdigest()
        self.assertEqual(digest, FIXTURE_REPORT_HASH)
        self.assertEqual(receipt["report_hash"], f"sha256:{FIXTURE_REPORT_HASH}")

    def test_fixture_source_is_the_signed_candidate(self):
        self.assertEqual(hashlib.sha256(SOLUTION_BYTES).hexdigest(), SOLUTION_SHA256)
        report = json.loads(REPORT_BYTES)["report"]
        self.assertEqual(report["source_hash"], f"sha256:{SOLUTION_SHA256}")
        self.assertEqual(report["input_manifest"]["source_sha256"], SOLUTION_SHA256)

    def test_pinned_key_is_the_published_key_and_names_its_spki_digest(self):
        self.assertEqual(
            dict(PINNED_ATTESTATION_KEYS),
            {key["key_id"]: key["public_key_pem"] for key in KEYS},
        )
        self.assertEqual(
            PROOFS_BLAH_DEV_ADAPTER.attestation_key_ids, {"ed25519:4d09a2be99b9a36d"}
        )
        public_key = serialization.load_pem_public_key(KEYS[0]["public_key_pem"].encode("ascii"))
        spki = public_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.assertTrue(hashlib.sha256(spki).hexdigest().startswith("4d09a2be99b9a36d"))

    def test_real_report_authenticates_then_fails_closed_without_origin(self):
        # Every hash and signature check precedes origin binding, so this
        # specific failure proves the production key accepted the real report.
        self.assertIsNone(json.loads(REPORT_BYTES)["report"].get("origin"))
        self.assertRejected(
            REPORT_BYTES, "no recorded origin", adapter=PROOFS_BLAH_DEV_ADAPTER
        )

    def test_real_report_with_tampered_signature_fails_before_origin(self):
        receipt = json.loads(REPORT_BYTES)
        signature = bytearray(
            base64.urlsafe_b64decode(receipt["attestation"]["signature"] + "==")
        )
        signature[0] ^= 1
        receipt["attestation"]["signature"] = (
            base64.urlsafe_b64encode(bytes(signature)).decode("ascii").rstrip("=")
        )
        self.assertRejected(
            json.dumps(receipt).encode("utf-8"),
            "signature is invalid",
            adapter=PROOFS_BLAH_DEV_ADAPTER,
        )

    def test_signed_report_with_origin_binds_subject_and_provenance(self):
        bound = verify(sign(signed_report()))
        self.assertEqual(bound.candidate_sha256, SOLUTION_SHA256)
        self.assertEqual(bound.verifier_system, "proofs-blah-dev")
        self.assertEqual(bound.method, "signed-report")
        self.assertIsNone(bound.hyades)
        self.assertEqual(bound.subject_declaration_ids, (DECLARATION,))
        self.assertEqual(bound.source_repository, REPOSITORY)
        self.assertEqual(bound.source_commit, COMMIT)
        self.assertEqual(bound.lean_toolchain, "leanprover/lean4:v4.33.1")
        self.assertEqual(bound.mathlib_revision, MATHLIB)
        self.assertEqual(bound.verified_at, "2026-09-29T05:41:48.738000Z")

    def test_origin_key_is_optional_but_must_match_when_present(self):
        report = signed_report()
        del report["origin"]["key"]
        self.assertEqual(verify(sign(report)).source_commit, COMMIT)
        for key in (
            f"lean:{REPOSITORY}@{'d' * 40}/{DECLARATION}",
            f"lean:{REPOSITORY}/{DECLARATION}",
            "",
        ):
            with self.subTest(key=key):
                self.assertRejected(
                    sign(signed_report(origin=origin(key=key))), "origin key does not name"
                )

    def test_production_adapter_cannot_use_the_test_key(self):
        self.assertRejected(
            sign(signed_report()), "not pinned", adapter=PROOFS_BLAH_DEV_ADAPTER
        )

    def test_tampered_report_fails_hash_or_signature(self):
        receipt = json.loads(sign(signed_report()))
        receipt["report"]["axioms"] = ["propext"]
        self.assertRejected(
            json.dumps(receipt).encode("utf-8"), "report_hash does not match"
        )
        stale_signature = json.loads(sign(signed_report()))["attestation"]["signature"]
        rehashed = json.loads(sign(signed_report(axioms=["propext"])))
        rehashed["attestation"]["signature"] = stale_signature
        self.assertRejected(json.dumps(rehashed).encode("utf-8"), "signature is invalid")

    def test_signature_must_cover_the_raw_digest_under_the_named_key(self):
        other_key = Ed25519PrivateKey.generate()
        self.assertRejected(sign(signed_report(), key=other_key), "signature is invalid")
        self.assertRejected(
            sign(signed_report(), signed_digest="0" * 64), "signature is invalid"
        )
        self.assertRejected(
            sign(signed_report(), key_id="ed25519:0000000000000000"),
            "attestation_key_id does not match|not pinned",
        )
        self.assertRejected(
            sign(signed_report(attestation_key_id="ed25519:0000000000000000")),
            "attestation_key_id does not match",
        )
        receipt = json.loads(sign(signed_report()))
        receipt["attestation"]["key_id"] = "4d09a2be99b9a36d"
        self.assertRejected(json.dumps(receipt).encode("utf-8"), "key_id is invalid")
        receipt = json.loads(sign(signed_report()))
        receipt["attestation"]["signature"] += "="
        self.assertRejected(json.dumps(receipt).encode("utf-8"), "canonical base64url")

    def test_key_ids_must_name_their_spki_digest(self):
        with self.assertRaisesRegex(ProofVerificationSetError, "does not match its SPKI digest"):
            ProofsBlahDevReportAdapter(
                attestation_keys={"ed25519:4d09a2be99b9a36d": TEST_PEM}
            )
        with self.assertRaisesRegex(ProofVerificationSetError, "does not match its SPKI digest"):
            ProofsBlahDevReportAdapter(
                attestation_keys={TEST_KEY_ID: PINNED_ATTESTATION_KEYS["ed25519:4d09a2be99b9a36d"]}
            )
        with self.assertRaisesRegex(ProofVerificationSetError, "key_id is invalid"):
            ProofsBlahDevReportAdapter(attestation_keys={"rsa:4d09a2be99b9a36d": TEST_PEM})

    def test_only_a_verified_prove_report_without_rejection_is_accepted(self):
        cases = (
            ({"outcome": "rejected"}, "outcome is not verified"),
            ({"intent": "disprove"}, "intent is not prove"),
            ({"rejection_code": "AXIOM_POLICY"}, "rejection_code must be null"),
            ({"schema_version": "proofs-verification-report/v2"}, "must use proofs-verification-report/v1"),
        )
        for changes, message in cases:
            with self.subTest(changes=changes):
                self.assertRejected(sign(signed_report(**changes)), message)
        report = signed_report()
        del report["rejection_code"]
        self.assertRejected(sign(report), "rejection_code must be null")

    def test_sorry_or_extra_axioms_are_rejected(self):
        for axioms in (
            ["propext", "sorryAx"],
            ["Classical.choice", "Classical.em"],
            ["propext", "propext"],
            "propext",
        ):
            with self.subTest(axioms=axioms):
                self.assertRejected(sign(signed_report(axioms=axioms)), "axiom")
        bound = verify(sign(signed_report(axioms=["Classical.choice", "Quot.sound", "propext"])))
        self.assertEqual(bound.method, "signed-report")

    def test_candidate_must_equal_the_signed_source_hash(self):
        self.assertRejected(
            sign(signed_report()), "does not match the Galaxy candidate", candidate="b" * 64
        )
        manifest = fixture_report()["input_manifest"]
        manifest["source_sha256"] = "b" * 64
        self.assertRejected(
            sign(signed_report(input_manifest=manifest)), "does not match its input manifest"
        )

    def test_theorem_revision_must_match_the_input_manifest(self):
        self.assertRejected(
            sign(signed_report(theorem_revision_id="01a0ea16-0000-7abc-a36c-ca0bc167d841")),
            "theorem_revision_id does not match",
        )

    def test_origin_must_match_the_graph_node(self):
        cases = (
            {"source_repository": "MonumentalSystems/OtherProofs"},
            {"source_commit": "d" * 40},
            {"declaration_ids": ("LeanProofsP2M.Other.theorem",)},
            {"declaration_ids": (DECLARATION, "LeanProofsP2M.Other.theorem")},
        )
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertRejected(
                    sign(signed_report()),
                    "origin does not match the Galaxy graph node",
                    expected=subject(**changes),
                )

    def test_signed_toolchain_must_match_the_graph_revision(self):
        self.assertRejected(
            sign(signed_report()),
            "provenance does not match",
            expected=subject(lean_toolchain="leanprover/lean4:v4.30.0"),
        )

    def test_null_absent_or_malformed_origin_fails_closed(self):
        report = signed_report()
        del report["origin"]
        self.assertRejected(sign(report), "no recorded origin")
        self.assertRejected(sign(signed_report(origin=None)), "no recorded origin")
        cases = (
            (origin(revision="C" * 40), "lowercase Git object ID"),
            (origin(revision="c" * 39), "lowercase Git object ID"),
            (origin(declaration=" padded"), "canonical non-empty text"),
            (origin(line_start=40, line_end=31), "line_start must not follow"),
            (origin(line_start=0), "positive integer"),
            ({**origin(), "verified": True}, "unknown field verified"),
            ({key: value for key, value in origin().items() if key != "repository"}, "origin.repository is required"),
            ("lean:MonumentalSystems/LeanProofs", "origin must be an object"),
        )
        for value, message in cases:
            with self.subTest(message=message):
                self.assertRejected(sign(signed_report(origin=value)), message)

    def test_receipt_size_and_media_type_are_bounded(self):
        report = signed_report(diagnostic_summary="x" * MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES)
        oversize = sign(report)
        self.assertGreater(len(oversize), MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES)
        self.assertRejected(oversize, "must contain 1 byte to")
        self.assertRejected(
            sign(signed_report()), "media type must be", media_type="application/json"
        )

    def test_receipt_envelope_is_exact_and_strict_json(self):
        receipt = json.loads(sign(signed_report()))
        receipt["verified"] = True
        self.assertRejected(json.dumps(receipt).encode("utf-8"), "fields are invalid")
        receipt = json.loads(sign(signed_report()))
        receipt["report_id"] = "01a0ebae-0000-7b43-ad5d-3497c2b171a6"
        self.assertRejected(json.dumps(receipt).encode("utf-8"), "report_id does not match")
        duplicate = sign(signed_report()).replace(
            b'{"report_id":', b'{"created_at":"x","report_id":', 1
        )
        self.assertRejected(duplicate, "Duplicate JSON")
        self.assertRejected(b"[]", "must be an object")

    def test_sensitive_fields_are_never_stored(self):
        self.assertRejected(
            sign(signed_report(resource_usage={"raw_log": "lean output"})),
            "credential or raw-log field",
        )

    def test_canonical_json_matches_javascript_formatting(self):
        self.assertEqual(
            canonical_report_json({"b": [1, 2.5, None, True], "a": {"z": "é \n", "y": 1e21}}),
            '{"a":{"y":1e+21,"z":"é \\n"},"b":[1,2.5,null,true]}'.encode("utf-8"),
        )
        # JavaScript compares UTF-16 code units, so U+FF61 sorts after U+1F600.
        self.assertEqual(
            canonical_report_json({"｡": 1, "\U0001f600": 2}),
            '{"\U0001f600":2,"｡":1}'.encode("utf-8"),
        )
        for value, expected in (
            (0.1, "0.1"), (1e-7, "1e-7"), (1e-6, "0.000001"), (1e16, "10000000000000000"),
            (1.5e300, "1.5e+300"), (-0.0, "0"), (2.0, "2"), (123.456, "123.456"),
            (5e-324, "5e-324"), (1e21, "1e+21"), (1.7976931348623157e308, "1.7976931348623157e+308"),
        ):
            with self.subTest(value=value):
                self.assertEqual(_js_number(value), expected)

    def test_numbers_and_keys_that_javascript_cannot_reproduce_fail_closed(self):
        report = signed_report()
        receipt = sign(report).replace(b'"attempt":1', b'"attempt":9007199254740993', 1)
        self.assertRejected(receipt, "JavaScript safe range")
        receipt = sign(report).replace(b'"attempt":1', b'"attempt":0.10000000000000000001', 1)
        self.assertRejected(receipt, "cannot be reproduced exactly")
        receipt = json.loads(sign(report))
        receipt["report"]["extra"] = {"10": 1, "9": 2}
        self.assertRejected(json.dumps(receipt).encode("utf-8"), "integer-like object key")
        lone = sign(report).replace(b'"intent":"prove"', b'"intent":"prove\\ud800"', 1)
        self.assertRejected(lone, "unpaired surrogate")

    def test_adapter_is_immutable_and_the_only_production_registration(self):
        with self.assertRaises(AttributeError):
            PROOFS_BLAH_DEV_ADAPTER._keys = {}
        import server

        registered = server.PROOF_VERIFIER_ADAPTERS[ADAPTER_KEY]
        self.assertIs(registered.verify, PROOFS_BLAH_DEV_ADAPTER)
        self.assertEqual(
            registered.implementation_sha256, proofs_blah_dev_adapter_implementation_sha256()
        )
        self.assertNotIn(("hyades", "1"), server.PROOF_VERIFIER_ADAPTERS)
        server_source = (SERVICE / "server.py").read_text(encoding="utf-8")
        self.assertNotIn("ProofsBlahDevReportAdapter", server_source)
        adapter_source = (SERVICE / "proofs_blah_dev_adapter.py").read_text(encoding="utf-8")
        self.assertNotRegex(adapter_source, r"os\.environ|urllib|requests|http\.client")

    def test_migration_registers_this_exact_implementation(self):
        migration = (
            SERVICE.parents[1] / "db" / "migrations" / "049_proofs_blah_dev_verifier_authority.sql"
        ).read_text(encoding="utf-8")
        match = re.search(
            r"'proofs-blah-dev', '1', '([0-9a-f]{64})', TRUE", migration
        )
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), proofs_blah_dev_adapter_implementation_sha256())
        source = (SERVICE / "proofs_blah_dev_adapter.py").read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(match.group(1), hashlib.sha256(source).hexdigest())


if __name__ == "__main__":
    unittest.main()
