import hashlib
import json
import unittest
from copy import deepcopy
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException, Request

from server import (
    IdentityContext,
    get_formal_project_package,
    register_formal_project_package,
)
from test_formal_project_package import (
    conceptual_dag,
    correspondence,
    manifest,
    package_envelope,
    repository_field_dag,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64


def request_for(body):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/formal-project-packages",
        "query_string": b"", "headers": [(b"content-type", b"application/vnd.galaxy.formal-project-package")],
    }, receive)


def package_parts():
    raw = conceptual_dag()
    projected = repository_field_dag()
    mapping = correspondence()
    source = manifest(raw, projected, mapping)
    return source, raw, projected, mapping


def package_bytes():
    source, raw, projected, mapping = package_parts()
    return package_envelope(source, raw, projected, mapping), hashlib.sha256(source).hexdigest()


class PackageCursor:
    def __init__(self):
        self.artifacts = {}
        self.graphs = {}
        self.packages = {}
        self.current = None
        self.executions = []
        self.fail_on_package_insert = False

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.executions.append((normalized, params))
        self.current = None
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            return
        if normalized.startswith("INSERT INTO gb_artifacts"):
            digest, size, binary = params[1], params[2], params[3]
            if digest not in self.artifacts:
                artifact_id = str(uuid4())
                self.artifacts[digest] = {
                    "id": artifact_id, "byte_size": size, "media_type": "application/json",
                    "content_bytes": bytes(binary.adapted),
                }
                self.current = {"id": artifact_id}
            return
        if normalized.startswith("SELECT id, byte_size, media_type, content_bytes FROM gb_artifacts"):
            self.current = self.artifacts.get(params[1])
            return
        if normalized.startswith("INSERT INTO gb_proof_graphs"):
            digest = params[5]
            if digest not in self.graphs:
                self.graphs[digest] = {
                    "id": str(uuid4()), "artifact_id": params[4], "graph_id": params[1],
                    "graph_kind": params[2], "title": params[3], "content_sha256": digest,
                    "byte_size": len(bytes(params[6].adapted)), "target_ids": list(params[7]),
                    "node_ref_ids": list(params[8]), "target_count": params[9],
                    "relation_count": params[10], "registered_by_principal_id": params[11],
                    "registered_by_nostr_pubkey": params[12],
                    "registered_at": datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc),
                }
                self.current = {"id": self.graphs[digest]["id"]}
            return
        if normalized.startswith("SELECT graph.id, graph.graph_id"):
            self.current = self.graphs.get(params[1])
            return
        if normalized.startswith("INSERT INTO gb_formal_project_packages"):
            if self.fail_on_package_insert:
                raise RuntimeError("injected late package insert failure")
            digest = params[9]
            if digest not in self.packages:
                keys = [
                    "tenant_id", "project_id", "repository", "commit_oid", "tree_oid",
                    "lean_toolchain", "mathlib_revision", "conversion_profile",
                    "manifest_artifact_id", "manifest_sha256", "manifest_json",
                    "authored_dag_artifact_id", "authored_dag_sha256",
                    "repository_field_graph_id", "repository_field_dag_sha256",
                    "correspondence_artifact_id", "correspondence_sha256",
                    "formal_graph_sha256", "repository_graph_sha256",
                    "registered_by_principal_id", "registered_by_nostr_pubkey",
                ]
                record = dict(zip(keys, params))
                record.update({
                    "id": str(uuid4()),
                    "registered_at": datetime(2026, 9, 26, 12, 1, tzinfo=timezone.utc),
                })
                self.packages[digest] = record
                self.current = {"id": record["id"]}
            return
        if normalized.startswith("SELECT id, project_id, repository, commit_oid, tree_oid"):
            self.current = self.packages.get(params[1])
            return
        raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.current


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class FormalProjectPackageApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human", PUBKEY)

    async def test_import_is_atomic_exact_and_content_hash_idempotent(self):
        body, manifest_digest = package_bytes()
        cursor = PackageCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            created = await register_formal_project_package(request_for(body), self.identity)
            replayed = await register_formal_project_package(request_for(body), self.identity)

        self.assertEqual(created["manifestSha256"], manifest_digest)
        self.assertNotIn("replayed", created)
        self.assertTrue(replayed["replayed"])
        self.assertEqual(len(cursor.packages), 1)
        self.assertEqual(len(cursor.graphs), 1)
        self.assertEqual(len(cursor.artifacts), 4)
        source, raw, projected, mapping = package_parts()
        expected_artifacts = {
            hashlib.sha256(value).hexdigest(): value
            for value in (source, raw, projected, mapping)
        }
        self.assertEqual(
            {digest: artifact["content_bytes"] for digest, artifact in cursor.artifacts.items()},
            expected_artifacts,
        )
        self.assertEqual(created["proofGraphRef"]["graph_id"], "leanproofs")
        forbidden = ("gb_proof_workspaces", "gb_proof_work_items", "gb_proof_work_transitions")
        self.assertFalse(any(any(table in query for table in forbidden) for query, _ in cursor.executions))

    async def test_late_package_failure_rolls_back_all_materialized_artifacts(self):
        body, _ = package_bytes()
        cursor = PackageCursor()
        cursor.fail_on_package_insert = True

        @contextmanager
        def transaction(_connection):
            snapshots = tuple(deepcopy(value) for value in (
                cursor.artifacts, cursor.graphs, cursor.packages,
            ))
            try:
                yield cursor
            except BaseException:
                cursor.artifacts, cursor.graphs, cursor.packages = snapshots
                raise

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            with self.assertRaisesRegex(RuntimeError, "injected late package insert failure"):
                await register_formal_project_package(request_for(body), self.identity)

        self.assertEqual(cursor.artifacts, {})
        self.assertEqual(cursor.graphs, {})
        self.assertEqual(cursor.packages, {})

    async def test_import_requires_nostr_and_rejects_invalid_envelopes_before_persistence(self):
        body, _ = package_bytes()
        unsigned = IdentityContext(TENANT, PRINCIPAL, "human")
        with self.assertRaises(HTTPException) as denied:
            await register_formal_project_package(request_for(body), unsigned)
        self.assertEqual(denied.exception.status_code, 403)

        with self.assertRaises(HTTPException) as invalid:
            await register_formal_project_package(request_for(b"not-a-package"), self.identity)
        self.assertEqual(invalid.exception.status_code, 422)

    async def test_summary_read_is_tenant_scoped_and_never_implies_large_artifacts_materialized(self):
        body, manifest_digest = package_bytes()
        cursor = PackageCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            await register_formal_project_package(request_for(body), self.identity)
            summary = get_formal_project_package(manifest_digest, self.identity)

        self.assertFalse(summary["artifacts"]["formalGraph"]["materialized"])
        self.assertFalse(summary["artifacts"]["repositoryGraph"]["materialized"])
        self.assertTrue(summary["artifacts"]["authoredConceptualDag"]["materialized"])
        query, params = cursor.executions[-1]
        self.assertIn("WHERE tenant_id = %s AND manifest_sha256 = %s", query)
        self.assertEqual(params, (TENANT, manifest_digest))


if __name__ == "__main__":
    unittest.main()
