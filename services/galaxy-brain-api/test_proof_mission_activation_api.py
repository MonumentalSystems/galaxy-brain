import hashlib
import inspect
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request

from server import (
    IdentityContext,
    _activate_proof_mission,
    activate_proof_mission,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64


def raw_request(body: bytes):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": "/proof-graphs/source/mission-activations",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json")],
    }, receive)


def activation_body(source_hash: str, expected_hash: str, set_hash: str):
    return json.dumps({
        "schema_id": "galaxy.proof-mission-activation-request.v1",
        "mission_intent": {
            "schema_id": "galaxy.proof-mission-intent.v1",
            "source_graph": {
                "graph_id": "leanproofs",
                "graph_kind": "repository-field",
                "content_sha256": source_hash,
            },
            "mission_id": "prove-main-v1",
            "main_target_id": "main",
            "curated_milestone_target_ids": [],
            "relation_direction": "prerequisite-to-dependent",
        },
        "expected_mission_content_sha256": expected_hash,
        "verification_set_ref": {
            "graph_id": "leanproofs",
            "graph_content_sha256": source_hash,
            "content_sha256": set_hash,
        },
        "workspace_id": "prove-main-v1",
        "idempotency_key": "activate-prove-main-v1",
    }, separators=(",", ":")).encode()


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class NonemptyCursor:
    def __init__(self, source_bytes: bytes, set_bytes: bytes, source_hash: str, set_hash: str):
        self.source_bytes = source_bytes
        self.set_bytes = set_bytes
        self.source_hash = source_hash
        self.set_hash = set_hash
        self.current = None

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        if normalized.startswith("SELECT graph.id, graph.graph_id"):
            self.current = {
                "id": "30000000-0000-4000-8000-000000000001",
                "graph_id": "leanproofs",
                "graph_kind": "repository-field",
                "content_sha256": self.source_hash,
                "content_bytes": self.source_bytes,
            }
        elif normalized.startswith("SELECT verification_set.id"):
            self.current = {
                "id": "40000000-0000-4000-8000-000000000001",
                "graph_id": "leanproofs",
                "graph_content_sha256": self.source_hash,
                "content_sha256": self.set_hash,
                "item_count": 1,
                "content_bytes": self.set_bytes,
            }
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.current


class ProofMissionActivationApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human", PUBKEY)
        self.source_hash = "a" * 64
        self.expected_hash = "b" * 64
        self.set_hash = "c" * 64

    async def test_route_requires_nostr_and_passes_only_normalized_exact_request(self):
        body = activation_body(self.source_hash, self.expected_hash, self.set_hash)
        with self.assertRaises(HTTPException) as unsigned:
            await activate_proof_mission(
                self.source_hash,
                raw_request(body),
                IdentityContext(TENANT, PRINCIPAL, "human"),
            )
        self.assertEqual(unsigned.exception.status_code, 403)

        captured = {}

        def activate(source_digest, request_value, identity):
            captured.update({
                "source_digest": source_digest,
                "request": request_value,
                "identity": identity,
            })
            return {"schema_id": "galaxy.proof-mission-activation-result.v1"}

        with patch("server._activate_proof_mission", side_effect=activate):
            result = await activate_proof_mission(
                self.source_hash, raw_request(body), self.identity,
            )

        self.assertEqual(result["schema_id"], "galaxy.proof-mission-activation-result.v1")
        self.assertEqual(captured["source_digest"], self.source_hash)
        self.assertEqual(captured["request"]["exact_bytes"], body)
        self.assertEqual(
            captured["request"]["expected_mission_content_sha256"],
            self.expected_hash,
        )
        self.assertEqual(captured["identity"].nostr_pubkey, PUBKEY)

    async def test_request_is_measured_strict_json_and_bounded(self):
        with self.assertRaises(HTTPException) as oversized:
            await activate_proof_mission(
                self.source_hash,
                raw_request(b"x" * 131_073),
                self.identity,
            )
        self.assertEqual(oversized.exception.status_code, 413)

        duplicate = (
            b'{"schema_id":"galaxy.proof-mission-activation-request.v1",'
            b'"schema_id":"galaxy.proof-mission-activation-request.v1"}'
        )
        with self.assertRaises(HTTPException) as invalid:
            await activate_proof_mission(
                self.source_hash, raw_request(duplicate), self.identity,
            )
        self.assertEqual(invalid.exception.status_code, 422)
        self.assertIn("Duplicate", invalid.exception.detail)

    def test_nonempty_baseline_is_rejected_before_any_activation_write(self):
        source_bytes = b"{}"
        source_hash = hashlib.sha256(source_bytes).hexdigest()
        set_bytes = b"{}"
        set_hash = hashlib.sha256(set_bytes).hexdigest()
        cursor = NonemptyCursor(source_bytes, set_bytes, source_hash, set_hash)
        request_value = {
            "verification_set_ref": {
                "graph_id": "leanproofs",
                "graph_content_sha256": source_hash,
                "content_sha256": set_hash,
            }
        }
        with patch("server.get_conn", return_value=Connection(cursor)):
            with self.assertRaises(HTTPException) as rejected:
                _activate_proof_mission(source_hash, request_value, self.identity)
        self.assertEqual(rejected.exception.status_code, 422)
        self.assertIn("Non-empty", rejected.exception.detail)

    def test_activation_replay_reports_current_workspace_item_count(self):
        source = inspect.getsource(_activate_proof_mission)
        self.assertIn("FROM gb_proof_work_items AS item", source)
        self.assertIn("item.workspace_id = activation.workspace_id", source)
        self.assertIn('"item_count": record["item_count"]', source)
        self.assertNotIn('"item_count": 0', source)


if __name__ == "__main__":
    unittest.main()
