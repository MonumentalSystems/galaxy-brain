import base64
import hashlib
import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, Request

from proof_verification_set import (
    ProofVerificationSetError,
    parse_proof_verification_set_bytes,
)
from server import (
    IdentityContext,
    PROOF_VERIFIER_ADAPTERS,
    RegisteredProofVerifierAdapter,
    _expected_proof_subject,
    _run_proof_verifier_adapters,
    get_proof_verification_set,
    list_proof_verification_sets,
    register_proof_verification_set,
)
from test_proofs_blah_dev_adapter import (
    ADAPTER_KEY,
    COMMIT,
    DECLARATION,
    MATHLIB,
    REPORT_BYTES,
    REPOSITORY,
    SOLUTION_SHA256,
    TEST_ADAPTER,
    sign,
    signed_report,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
REGISTRATION = "30000000-0000-4000-8000-000000000001"
ARTIFACT = "40000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64
GRAPH_BYTES = b"{}"
GRAPH_HASH = hashlib.sha256(GRAPH_BYTES).hexdigest()


def empty_set_bytes():
    return json.dumps({
        "schema_id": "galaxy.proof-verification-set.v1",
        "graph_ref": {"graph_id": "leanproofs", "content_sha256": GRAPH_HASH},
        "items": [],
    }, indent=2).encode()


def raw_request(body):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/proof-verification-sets",
        "query_string": b"", "headers": [(b"content-type", b"application/json")],
    }, receive)


class RegistryCursor:
    def __init__(self, *, replay=False, missing_graph=False, missing_set=False, list_count=1):
        registration = parse_proof_verification_set_bytes(empty_set_bytes())
        self.content = registration.content_bytes
        self.digest = registration.content_sha256
        self.replay = replay
        self.missing_graph = missing_graph
        self.missing_set = missing_set
        self.list_count = list_count
        self.current = None
        self.rows = []
        self.executions = []

    def record(self, *, include_storage=False):
        value = {
            "id": REGISTRATION,
            "graph_id": "leanproofs",
            "graph_content_sha256": GRAPH_HASH,
            "content_sha256": self.digest,
            "byte_size": len(self.content),
            "item_count": 0,
            "registered_by_principal_id": PRINCIPAL,
            "registered_by_nostr_pubkey": PUBKEY,
            "registered_at": datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc),
        }
        if include_storage:
            value.update({
                "artifact_id": ARTIFACT,
                "node_ids": [],
                "content_bytes": self.content,
            })
        return value

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.executions.append((normalized, params))
        self.current = None
        self.rows = []
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            return
        if normalized.startswith("SELECT graph.graph_kind, artifact.content_bytes"):
            self.current = None if self.missing_graph else {
                "graph_kind": "repository-field",
                "content_bytes": GRAPH_BYTES,
            }
        elif normalized.startswith("SELECT graph_kind FROM gb_proof_graphs"):
            self.current = None if self.missing_graph else {"graph_kind": "repository-field"}
        elif normalized.startswith("INSERT INTO gb_artifacts"):
            self.current = None if self.replay else {"id": ARTIFACT}
        elif normalized.startswith("SELECT id, byte_size, media_type, content_bytes FROM gb_artifacts"):
            self.current = {
                "id": ARTIFACT,
                "byte_size": len(self.content),
                "media_type": "application/json",
                "content_bytes": self.content,
            }
        elif normalized.startswith("INSERT INTO gb_proof_verification_sets"):
            self.current = None if self.replay else {"id": REGISTRATION}
        elif normalized.startswith("SELECT id FROM gb_proof_verification_sets"):
            self.current = None if self.missing_set else {"id": REGISTRATION}
        elif normalized.startswith("SELECT verification_set.id, verification_set.graph_id"):
            if "verification_set.artifact_id, verification_set.content_sha256" in normalized:
                self.current = None if self.missing_set else self.record(include_storage=True)
            else:
                self.rows = [] if self.missing_set else [self.record() for _ in range(self.list_count)]
        elif normalized.startswith("SELECT verification_set.graph_id"):
            self.current = None if self.missing_set else self.record(include_storage=True)
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class ProofVerificationSetApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human", PUBKEY)

    async def test_explicit_empty_set_registers_canonical_exact_bytes_without_work_state(self):
        cursor = RegistryCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            result = await register_proof_verification_set(
                raw_request(empty_set_bytes()), self.identity,
            )

        self.assertEqual(result["contentSha256"], cursor.digest)
        self.assertEqual(result["itemCount"], 0)
        artifact_insert = next(
            entry for entry in cursor.executions if entry[0].startswith("INSERT INTO gb_artifacts")
        )
        self.assertEqual(artifact_insert[1][3].adapted, cursor.content)
        self.assertFalse(any("gb_proof_workspaces" in query for query, _ in cursor.executions))
        self.assertFalse(any("gb_proof_work_items" in query for query, _ in cursor.executions))
        self.assertFalse(any("gb_proof_work_transitions" in query for query, _ in cursor.executions))

    async def test_registration_requires_nostr_and_exact_passive_graph(self):
        with self.assertRaises(HTTPException) as unsigned:
            await register_proof_verification_set(
                raw_request(empty_set_bytes()), IdentityContext(TENANT, PRINCIPAL, "human"),
            )
        self.assertEqual(unsigned.exception.status_code, 403)

        cursor = RegistryCursor(missing_graph=True)

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            with self.assertRaises(HTTPException) as missing:
                await register_proof_verification_set(raw_request(empty_set_bytes()), self.identity)
        self.assertEqual(missing.exception.status_code, 404)
        graph_query = next(entry for entry in cursor.executions if entry[0].startswith(
            "SELECT graph.graph_kind, artifact.content_bytes"
        ))
        self.assertEqual(graph_query[1], (TENANT, "leanproofs", GRAPH_HASH))

    async def test_nonempty_sets_fail_closed_without_a_real_adapter(self):
        # Parsing and adapter dispatch are separate boundaries. Patch only the
        # structural parser result so this test cannot bless self-described
        # receipt claims as verification evidence.
        structural = type("Registration", (), {
            "artifact": {"items": [{
                "receipt": {"adapter_id": "hyades", "adapter_version": "v1"},
            }]},
            "items": (SimpleNamespace(adapter_id="hyades", adapter_version="v1"),),
            "graph_id": "leanproofs",
            "graph_content_sha256": GRAPH_HASH,
        })()
        cursor = RegistryCursor()
        with patch(
            "server._read_proof_verification_set_registration",
            return_value=structural,
        ), patch(
            "server.get_conn", return_value=Connection(cursor),
        ), self.assertRaises(HTTPException) as rejected:
            await register_proof_verification_set(raw_request(b"{}"), self.identity)
        self.assertEqual(rejected.exception.status_code, 422)
        self.assertIn("is not enabled", rejected.exception.detail)
        self.assertFalse(any(query.startswith("INSERT INTO") for query, _ in cursor.executions))

    def test_repository_correspondence_is_not_an_exact_verification_subject(self):
        registration = SimpleNamespace(
            graph_id="leanproofs", graph_content_sha256=GRAPH_HASH,
        )
        item = SimpleNamespace(node_id="target-a")
        graph = {
            "revision": {
                "repository": "MonumentalSystems/LeanProofs",
                "commit": "c" * 40,
                "lean_toolchain": "leanprover/lean4:v4.30.0",
                "mathlib_revision": "d" * 40,
            },
            "targets": [{
                "target_id": "target-a",
                "formal_binding": {
                    "binding_kind": "module-cohort",
                    "declaration_ids": ["LeanProofs.targetA"],
                    "declaration_equivalence_claimed": False,
                },
            }],
        }
        with self.assertRaisesRegex(
            ProofVerificationSetError, "unambiguous formal declaration bindings",
        ):
            _expected_proof_subject(registration, item, graph)

        graph["targets"][0]["formal_binding"] = {
            "binding_kind": "declaration",
            "declaration_ids": ["LeanProofs.targetA"],
            "declaration_equivalence_claimed": True,
        }
        expected = _expected_proof_subject(registration, item, graph)
        self.assertEqual(expected.declaration_ids, ("LeanProofs.targetA",))
        self.assertEqual(expected.source_repository, "MonumentalSystems/LeanProofs")

    def test_invalid_exact_subjects_fail_as_clean_422_responses(self):
        item = SimpleNamespace(
            node_id="target-a", adapter_id="test-adapter", adapter_version="1",
        )
        registration = SimpleNamespace(
            graph_id="leanproofs", graph_content_sha256=GRAPH_HASH, items=(item,),
        )
        base_graph = {
            "revision": {
                "repository": "MonumentalSystems/LeanProofs",
                "commit": "c" * 40,
                "lean_toolchain": "leanprover/lean4:v4.30.0",
                "mathlib_revision": "d" * 40,
            },
            "targets": [{
                "target_id": "target-a",
                "formal_binding": {
                    "binding_kind": "declaration",
                    "declaration_ids": ["LeanProofs.targetA"],
                    "declaration_equivalence_claimed": True,
                },
            }],
        }
        adapter = RegisteredProofVerifierAdapter("e" * 64, lambda _request: None)
        cases = []
        whitespace = json.loads(json.dumps(base_graph))
        whitespace["revision"]["repository"] = " MonumentalSystems/LeanProofs"
        cases.append(whitespace)
        unhashable = json.loads(json.dumps(base_graph))
        unhashable["targets"][0]["formal_binding"]["declaration_ids"] = [["nested"]]
        cases.append(unhashable)
        too_many = json.loads(json.dumps(base_graph))
        too_many["targets"][0]["formal_binding"]["declaration_ids"] = [
            f"LeanProofs.target{index}" for index in range(129)
        ]
        cases.append(too_many)
        too_large = json.loads(json.dumps(base_graph))
        too_large["targets"][0]["formal_binding"]["declaration_ids"] = [
            f"D{index:03d}" + "x" * 506 for index in range(120)
        ]
        cases.append(too_large)

        with patch.dict(
            PROOF_VERIFIER_ADAPTERS, {("test-adapter", "1"): adapter}, clear=True,
        ):
            for graph in cases:
                with self.subTest(graph=graph), self.assertRaises(HTTPException) as caught:
                    _run_proof_verifier_adapters(registration, graph)
                self.assertEqual(caught.exception.status_code, 422)

    def test_proofs_blah_dev_items_bind_signed_reports_and_fail_closed_without_origin(self):
        def registration(receipt):
            return parse_proof_verification_set_bytes(json.dumps({
                "schema_id": "galaxy.proof-verification-set.v1",
                "graph_ref": {"graph_id": "leanproofs", "content_sha256": GRAPH_HASH},
                "items": [{
                    "node_id": "zero-isExact2",
                    "candidate_sha256": SOLUTION_SHA256,
                    "receipt": {
                        "adapter_id": ADAPTER_KEY[0],
                        "adapter_version": ADAPTER_KEY[1],
                        "media_type": "application/vnd.proofs-blah-dev.verification-report+json",
                        "content_encoding": "base64",
                        "content_sha256": hashlib.sha256(receipt).hexdigest(),
                        "content_base64": base64.b64encode(receipt).decode("ascii"),
                    },
                }],
            }).encode())

        graph = {
            "revision": {
                "repository": REPOSITORY,
                "commit": COMMIT,
                "lean_toolchain": "leanprover/lean4:v4.33.1",
                "mathlib_revision": MATHLIB,
            },
            "targets": [{
                "target_id": "zero-isExact2",
                "formal_binding": {
                    "binding_kind": "declaration",
                    "declaration_ids": [DECLARATION],
                    "declaration_equivalence_claimed": True,
                },
            }],
        }
        with self.assertRaises(HTTPException) as caught:
            _run_proof_verifier_adapters(registration(REPORT_BYTES), graph)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("no recorded origin", caught.exception.detail)

        adapter = RegisteredProofVerifierAdapter("e" * 64, TEST_ADAPTER)
        with patch.dict(PROOF_VERIFIER_ADAPTERS, {ADAPTER_KEY: adapter}, clear=True):
            accepted = _run_proof_verifier_adapters(registration(sign(signed_report())), graph)
        (_, _, bound, _, _), = accepted
        self.assertEqual((bound.verifier_system, bound.method), ("proofs-blah-dev", "signed-report"))
        self.assertIsNone(bound.hyades)
        self.assertEqual(bound.subject_declaration_ids, (DECLARATION,))

    async def test_registration_replay_is_idempotent_and_never_reattributes(self):
        cursor = RegistryCursor(replay=True)

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            result = await register_proof_verification_set(
                raw_request(empty_set_bytes()), self.identity,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["registeredByPrincipalId"], PRINCIPAL)

    def test_list_is_bounded_and_exact_get_returns_canonical_set_bytes(self):
        cursor = RegistryCursor(list_count=3)
        with patch("server.get_conn", return_value=Connection(cursor)):
            listed = list_proof_verification_sets(
                graph_content_sha256=GRAPH_HASH,
                limit=2,
                offset=7,
                identity=self.identity,
            )
            response = get_proof_verification_set(cursor.digest, self.identity)

        self.assertEqual(len(listed["verificationSets"]), 2)
        self.assertTrue(listed["hasMore"])
        self.assertEqual(listed["nextOffset"], 9)
        list_query = cursor.executions[0]
        self.assertIn("verification_set.graph_content_sha256 = %s", list_query[0])
        self.assertEqual(list_query[1], (TENANT, GRAPH_HASH, 3, 7))
        self.assertEqual(response.body, cursor.content)
        self.assertEqual(response.headers["x-content-sha256"], cursor.digest)
        self.assertEqual(response.headers["x-proof-verification-graph-sha256"], GRAPH_HASH)

    def test_exact_get_is_tenant_scoped_and_detects_stored_corruption(self):
        missing = RegistryCursor(missing_set=True)
        with patch("server.get_conn", return_value=Connection(missing)):
            with self.assertRaises(HTTPException) as caught:
                get_proof_verification_set(missing.digest, self.identity)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(missing.executions[-1][1], (TENANT, missing.digest))

        corrupt = RegistryCursor()
        corrupt.content = b"{}"
        with patch("server.get_conn", return_value=Connection(corrupt)):
            with self.assertRaises(HTTPException) as caught:
                get_proof_verification_set(corrupt.digest, self.identity)
        self.assertEqual(caught.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
