import hashlib
import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException, Request

from server import (
    IdentityContext,
    _authorize_proof_referent,
    derive_proof_mission_candidate,
    get_proof_graph,
    list_proof_graphs,
    register_proof_graph,
)
from object_links import parse_canonical_reference


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
REGISTRATION = "30000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64


def artifact_bytes():
    return json.dumps({
        "schema_id": "galaxy.proof-dag.v1",
        "graph_id": "leanproofs",
        "graph_kind": "repository-field",
        "title": "LeanProofs",
        "targets": [{"target_id": "theorem-1", "title": "Theorem"}],
        "relations": [],
    }, separators=(",", ":")).encode()


def raw_request(body):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/proof-graphs",
        "query_string": b"", "headers": [(b"content-type", b"application/json")],
    }, receive)


class RegistryCursor:
    def __init__(self, *, replay=False, missing=False, content=None, list_count=1):
        self.content = content or artifact_bytes()
        self.digest = hashlib.sha256(self.content).hexdigest()
        self.replay = replay
        self.missing = missing
        self.list_count = list_count
        self.current = None
        self.rows = []
        self.executions = []

    def record(self, *, include_content=False):
        value = {
            "id": REGISTRATION,
            "artifact_id": "40000000-0000-4000-8000-000000000001",
            "graph_id": "leanproofs",
            "graph_kind": "repository-field",
            "title": "LeanProofs",
            "content_sha256": self.digest,
            "byte_size": len(self.content),
            "target_count": 1,
            "relation_count": 0,
            "registered_by_principal_id": PRINCIPAL,
            "registered_by_nostr_pubkey": PUBKEY,
            "registered_at": datetime(2026, 9, 23, 12, 0, tzinfo=timezone.utc),
        }
        if include_content:
            value.update({
                "content_bytes": self.content,
                "graph_json": json.loads(self.content),
                "target_ids": ["theorem-1"],
                "node_ref_ids": ["leanproofs#theorem-1"],
            })
        return value

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.executions.append((normalized, params))
        self.current = None
        self.rows = []
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            return
        if normalized.startswith("INSERT INTO gb_artifacts"):
            self.current = None if self.replay else {"id": self.record()["artifact_id"]}
        elif normalized.startswith("SELECT id, byte_size, media_type, content_bytes FROM gb_artifacts"):
            self.current = None if self.missing else {
                "id": self.record()["artifact_id"],
                "byte_size": len(self.content),
                "media_type": "application/json",
                "content_bytes": self.content,
            }
        elif normalized.startswith("INSERT INTO gb_proof_graphs"):
            self.current = None if self.replay else {"id": REGISTRATION}
        elif normalized.startswith("SELECT graph.id, graph.graph_id") and "graph.target_ids" in normalized:
            self.current = None if self.missing else self.record(include_content=True)
        elif normalized.startswith("SELECT graph.id, graph.graph_id"):
            self.rows = [] if self.missing else [self.record() for _ in range(self.list_count)]
        elif normalized.startswith("SELECT graph.graph_id, graph.graph_kind, graph.content_sha256"):
            self.current = None if self.missing else {
                "graph_id": "leanproofs",
                "graph_kind": "repository-field",
                "content_sha256": self.digest,
                "content_bytes": self.content,
            }
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


class ProofGraphApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human", PUBKEY)

    async def test_registration_hashes_and_stores_the_exact_raw_bytes(self):
        content = artifact_bytes()
        cursor = RegistryCursor(content=content)

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            result = await register_proof_graph(raw_request(content), self.identity)

        self.assertEqual(result["contentSha256"], hashlib.sha256(content).hexdigest())
        self.assertNotIn("artifact", result)
        self.assertFalse(any("gb_proof_workspaces" in query for query, _ in cursor.executions))
        artifact_insert = next(query for query in cursor.executions if query[0].startswith("INSERT INTO gb_artifacts"))
        graph_insert = next(query for query in cursor.executions if query[0].startswith("INSERT INTO gb_proof_graphs"))
        self.assertIn("convert_from(%s, 'UTF8')::jsonb", graph_insert[0])
        self.assertEqual(artifact_insert[1][3].adapted, content)
        self.assertEqual(graph_insert[1][6].adapted, content)
        self.assertEqual(graph_insert[1][7], ["theorem-1"])
        self.assertEqual(graph_insert[1][8], ["leanproofs#theorem-1"])
        self.assertFalse(any("FOR SHARE" in query for query, _ in cursor.executions))

    async def test_content_hash_replay_is_idempotent_and_never_reattributes(self):
        content = artifact_bytes()
        cursor = RegistryCursor(replay=True, content=content)

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            result = await register_proof_graph(raw_request(content), self.identity)

        self.assertTrue(result["replayed"])
        self.assertEqual(result["registeredByPrincipalId"], PRINCIPAL)

    async def test_registration_requires_verified_nostr_and_enforces_body_bound(self):
        with self.assertRaises(HTTPException) as unsigned:
            await register_proof_graph(
                raw_request(artifact_bytes()), IdentityContext(TENANT, PRINCIPAL, "human"),
            )
        self.assertEqual(unsigned.exception.status_code, 403)

        with self.assertRaises(HTTPException) as oversized:
            await register_proof_graph(raw_request(b"x" * 16_777_217), self.identity)
        self.assertEqual(oversized.exception.status_code, 413)

    async def test_generic_registration_rejects_claimable_graphs(self):
        value = json.loads(artifact_bytes())
        value["graph_kind"] = "mission"
        with self.assertRaises(HTTPException) as rejected:
            await register_proof_graph(
                raw_request(json.dumps(value, separators=(",", ":")).encode()),
                self.identity,
            )
        self.assertEqual(rejected.exception.status_code, 422)
        self.assertIn("server-authoritative activation", rejected.exception.detail)

    async def test_mission_candidate_is_derived_from_exact_tenant_registered_bytes(self):
        content = json.dumps({
            "schema_id": "galaxy.proof-dag.v1",
            "graph_id": "leanproofs",
            "graph_kind": "repository-field",
            "title": "LeanProofs",
            "targets": [
                {"target_id": "foundation", "title": "Foundation"},
                {"target_id": "theorem-1", "title": "Theorem"},
            ],
            "relations": [{
                "relation_id": "r-1",
                "relation_type": "USES",
                "prerequisite_target_id": "foundation",
                "dependent_target_id": "theorem-1",
            }],
        }, separators=(",", ":")).encode()
        cursor = RegistryCursor(content=content)
        body = json.dumps({
            "schema_id": "galaxy.proof-mission-intent.v1",
            "source_graph": {
                "graph_id": "leanproofs",
                "graph_kind": "repository-field",
                "content_sha256": cursor.digest,
            },
            "mission_id": "prove-theorem-1",
            "main_target_id": "theorem-1",
            "curated_milestone_target_ids": ["foundation"],
            "relation_direction": "prerequisite-to-dependent",
        }, separators=(",", ":")).encode()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = await derive_proof_mission_candidate(
                cursor.digest, raw_request(body), self.identity,
            )

        self.assertEqual(result["schema_id"], "galaxy.proof-mission-candidate.v1")
        self.assertEqual(result["activation_state"], "inactive")
        self.assertFalse(result["registerable"])
        self.assertEqual(
            [target["target_id"] for target in result["mission_dag"]["targets"]],
            ["foundation", "theorem-1"],
        )
        query, params = cursor.executions[-1]
        self.assertIn("WHERE graph.tenant_id = %s AND graph.content_sha256 = %s", query)
        self.assertEqual(params, (TENANT, cursor.digest))

    def test_list_is_bounded_metadata_and_exact_get_returns_original_bytes(self):
        content = artifact_bytes()
        cursor = RegistryCursor(content=content)
        with patch("server.get_conn", return_value=Connection(cursor)):
            listed = list_proof_graphs(limit=50, offset=0, identity=self.identity)
            response = get_proof_graph(cursor.digest, self.identity)

        self.assertEqual(listed["graphs"][0]["targetCount"], 1)
        self.assertNotIn("artifact", listed["graphs"][0])
        self.assertEqual(response.body, content)
        self.assertEqual(response.headers["x-content-sha256"], cursor.digest)

    def test_list_exposes_deterministic_bounded_pagination(self):
        cursor = RegistryCursor(list_count=3)
        with patch("server.get_conn", return_value=Connection(cursor)):
            listed = list_proof_graphs(limit=2, offset=7, identity=self.identity)
        self.assertEqual(len(listed["graphs"]), 2)
        self.assertTrue(listed["hasMore"])
        self.assertEqual(listed["nextOffset"], 9)
        query, params = cursor.executions[-1]
        self.assertIn("ORDER BY graph.registered_at DESC, graph.content_sha256", query)
        self.assertEqual(params, (TENANT, 3, 7))

    def test_exact_get_is_tenant_scoped_and_rejects_unknown_hash(self):
        cursor = RegistryCursor(missing=True)
        with patch("server.get_conn", return_value=Connection(cursor)):
            with self.assertRaises(HTTPException) as missing:
                get_proof_graph(cursor.digest, self.identity)
        self.assertEqual(missing.exception.status_code, 404)
        exact_query = cursor.executions[-1]
        self.assertEqual(exact_query[1], (TENANT, cursor.digest))

    def test_proof_referents_require_a_pinned_registered_graph(self):
        digest = hashlib.sha256(artifact_bytes()).hexdigest()

        class ReferentCursor:
            def __init__(self):
                self.params = []
                self.current = None

            def execute(self, query, params=None):
                self.params.append(params)
                self.current = {"content_sha256": digest}

            def fetchone(self):
                return self.current

        cursor = ReferentCursor()
        latest = parse_canonical_reference("gb:object:v1:proof.graph:leanproofs:latest")
        pinned = parse_canonical_reference(
            f"gb:object:v1:proof.graph:leanproofs:pinned:sha256%3A{digest}"
        )
        node = parse_canonical_reference(
            f"gb:object:v1:proof.node:leanproofs%23theorem-1:pinned:sha256%3A{digest}"
        )
        self.assertIsNone(_authorize_proof_referent(cursor, latest, self.identity))
        graph_access = _authorize_proof_referent(cursor, pinned, self.identity)
        node_access = _authorize_proof_referent(cursor, node, self.identity)
        self.assertEqual(graph_access.provider, "galaxy.proof-dag")
        self.assertEqual(node_access.resolved_revision, f"sha256:{digest}")
        self.assertEqual(cursor.params[0], (TENANT, "leanproofs", digest))
        self.assertEqual(cursor.params[1], (TENANT, "leanproofs#theorem-1", digest))


if __name__ == "__main__":
    unittest.main()
