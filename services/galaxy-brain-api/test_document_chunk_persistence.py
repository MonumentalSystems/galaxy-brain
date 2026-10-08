import hashlib
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException

from document_chunks import (
    CHUNK_MANIFEST_SCHEMA_ID,
    CHUNK_SCHEMA_ID,
    canonical_chunk_json,
    current_document_chunker,
    materialize_document_chunks,
)
from server import (
    IdentityContext,
    _best_effort_materialize_transform_chunks,
    _document_local_index_status,
    _materialize_representation_chunks,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "70000000-0000-4000-8000-000000000001"
REPRESENTATION_SHA256 = "a" * 64
REVISION_ID = "60000000-0000-4000-8000-000000000001"
RECEIPT_ID = "80000000-0000-4000-8000-000000000001"
IDENTITY = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
STRUCTURE = {
    "schemaId": "gb.document-structure.v1",
    "blocks": [
        {"id": "heading", "text": "Heading", "latex": None},
        {"id": "empty", "text": "", "latex": None},
        {"id": "equation", "text": None, "latex": "E=mc^2"},
    ],
    "readingOrder": ["equation", "empty", "heading"],
}
REPRESENTATION = {
    "id": REPRESENTATION_ID,
    "kind": "document-structure",
    "content_sha256": REPRESENTATION_SHA256,
    "content": STRUCTURE,
}


def _json_value(value):
    return getattr(value, "adapted", value)


def _nested_keys(value):
    if isinstance(value, dict):
        keys = set(value)
        for child in value.values():
            keys.update(_nested_keys(child))
        return keys
    if isinstance(value, list):
        keys = set()
        for child in value:
            keys.update(_nested_keys(child))
        return keys
    return set()


class ChunkPersistenceCursor:
    """Small ON CONFLICT-aware model for the two append-only chunk tables."""

    def __init__(self):
        self.current = None
        self.rows = []
        self.chunks = {}
        self.manifests = {}
        self.executions = []

    def add_chunk_rows(self, rows):
        for values in rows:
            row = {
                "id": values[0],
                "tenant_id": values[1],
                "identity_version": values[2],
                "identity_canonical": values[3],
                "representation_id": values[4],
                "representation_sha256": values[5],
                "ordinal": values[6],
                "selector_json": _json_value(values[7]),
                "selector_canonical": values[8],
                "selector_sha256": values[9],
                "text_content": values[10],
                "content_sha256": values[11],
                "chunker": values[12],
                "chunker_version": values[13],
                "chunker_config_json": _json_value(values[14]),
                "chunker_config_canonical": values[15],
                "chunker_config_sha256": values[16],
                "created_by_principal_id": values[17],
            }
            self.chunks.setdefault(
                (row["tenant_id"], row["representation_id"], row["id"]), row,
            )

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        self.current = None
        self.rows = []
        if normalized.startswith("SELECT id, ordinal, selector_json"):
            (
                tenant_id, representation_id, representation_sha256,
                identity_version, chunker, chunker_version, config_sha256,
            ) = parameters
            matching = [
                row for row in self.chunks.values()
                if row["tenant_id"] == tenant_id
                and row["representation_id"] == representation_id
                and row["representation_sha256"] == representation_sha256
                and row["identity_version"] == identity_version
                and row["chunker"] == chunker
                and row["chunker_version"] == chunker_version
                and row["chunker_config_sha256"] == config_sha256
            ]
            self.rows = [{
                key: row[key]
                for key in (
                    "id", "ordinal", "selector_json", "selector_sha256",
                    "text_content", "content_sha256",
                )
            } for row in sorted(matching, key=lambda row: row["ordinal"])]
        elif normalized.startswith("INSERT INTO gb_document_chunk_manifests"):
            row = {
                "id": parameters[0],
                "tenant_id": parameters[1],
                "identity_version": parameters[2],
                "identity_canonical": parameters[3],
                "representation_id": parameters[4],
                "representation_sha256": parameters[5],
                "representation_kind": parameters[6],
                "chunker": parameters[7],
                "chunker_version": parameters[8],
                "chunker_config_json": _json_value(parameters[9]),
                "chunker_config_canonical": parameters[10],
                "chunker_config_sha256": parameters[11],
                "chunk_count": parameters[12],
                "chunks_sha256": parameters[13],
                "created_by_principal_id": parameters[14],
            }
            key = (row["tenant_id"], row["representation_id"], row["id"])
            if key not in self.manifests:
                self.manifests[key] = row
                self.current = {"id": row["id"]}
        elif normalized.startswith("SELECT id, representation_id, representation_sha256"):
            tenant_id, representation_id, manifest_id = parameters
            row = self.manifests.get((tenant_id, representation_id, manifest_id))
            if row is not None:
                self.current = {
                    key: row[key]
                    for key in (
                        "id", "representation_id", "representation_sha256",
                        "representation_kind", "chunker", "chunker_version",
                        "chunker_config_json", "chunker_config_sha256",
                        "chunk_count", "chunks_sha256",
                    )
                }
        else:
            raise AssertionError(f"Unexpected statement: {normalized}")

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class LocalIndexStatusCursor:
    def __init__(self, manifest=None, count=None):
        self.manifests = list(manifest) if isinstance(manifest, list) else [manifest]
        self.count = count
        self.current = None
        self.executions = []

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if "FROM gb_document_chunk_manifests" in normalized:
            self.current = self.manifests.pop(0) if self.manifests else None
        elif "FROM gb_document_chunks" in normalized:
            self.current = None if self.count is None else {"chunk_count": self.count}
        else:
            raise AssertionError(f"Unexpected statement: {normalized}")

    def fetchone(self):
        return self.current


class DocumentChunkPersistenceTests(unittest.TestCase):
    def persist(self, cursor):
        def execute_values(actual_cursor, statement, rows, page_size):
            self.assertIs(actual_cursor, cursor)
            self.assertIn("ON CONFLICT DO NOTHING", statement)
            self.assertEqual(page_size, 500)
            cursor.add_chunk_rows(rows)

        with patch("server.psycopg2.extras.execute_values", side_effect=execute_values):
            return _materialize_representation_chunks(cursor, IDENTITY, REPRESENTATION)

    def test_exact_manifest_reconciliation_and_idempotent_replay(self):
        cursor = ChunkPersistenceCursor()
        expected = materialize_document_chunks(
            REPRESENTATION_ID, REPRESENTATION_SHA256,
            "document-structure", STRUCTURE,
        )

        first = self.persist(cursor)
        second = self.persist(cursor)

        self.assertEqual(first, second)
        self.assertEqual(first["chunks"], expected["chunks"])
        self.assertEqual(len(cursor.chunks), 2)
        self.assertEqual(len(cursor.manifests), 1)
        stored_chunks = sorted(cursor.chunks.values(), key=lambda row: row["ordinal"])
        for stored, chunk in zip(stored_chunks, expected["chunks"]):
            self.assertEqual(stored["identity_version"], CHUNK_SCHEMA_ID)
            self.assertEqual(stored["identity_canonical"], canonical_chunk_json({
                "schemaId": CHUNK_SCHEMA_ID,
                "representationSha256": REPRESENTATION_SHA256,
                "selector": chunk["selector"],
                "chunker": {
                    "id": chunk["chunkerId"],
                    "version": chunk["chunkerVersion"],
                    "configSha256": chunk["chunkerConfigSha256"],
                },
            }))
            self.assertEqual(stored["selector_canonical"], canonical_chunk_json(chunk["selector"]))
            self.assertEqual(stored["text_content"], chunk["textContent"])
        stored_manifest = next(iter(cursor.manifests.values()))
        self.assertEqual(stored_manifest["identity_version"], CHUNK_MANIFEST_SCHEMA_ID)
        self.assertEqual(stored_manifest["chunk_count"], 2)
        self.assertEqual(first["id"], stored_manifest["id"])
        self.assertEqual(first["chunksSha256"], stored_manifest["chunks_sha256"])

    def test_replay_detects_a_conflicting_stored_chunk(self):
        cursor = ChunkPersistenceCursor()
        self.persist(cursor)
        next(iter(cursor.chunks.values()))["text_content"] = "tampered"

        with self.assertRaises(HTTPException) as caught:
            self.persist(cursor)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, "Stored document chunk identity conflicts")

    def test_identical_bytes_can_be_materialized_for_two_representation_rows(self):
        cursor = ChunkPersistenceCursor()
        first = self.persist(cursor)
        second_representation = {
            **REPRESENTATION,
            "id": "70000000-0000-4000-8000-000000000002",
        }

        def execute_values(actual_cursor, statement, rows, page_size):
            self.assertIs(actual_cursor, cursor)
            cursor.add_chunk_rows(rows)

        with patch(
            "server.psycopg2.extras.execute_values", side_effect=execute_values,
        ):
            second = _materialize_representation_chunks(
                cursor, IDENTITY, second_representation,
            )

        self.assertEqual(
            [chunk["id"] for chunk in first["chunks"]],
            [chunk["id"] for chunk in second["chunks"]],
        )
        self.assertEqual(len(cursor.chunks), 4)
        self.assertEqual(len(cursor.manifests), 2)
        self.assertEqual(first["id"], second["id"])

    def test_best_effort_materialization_failure_does_not_bubble(self):
        @contextmanager
        def transaction(_connection):
            yield object()

        response = {"representations": [REPRESENTATION]}
        with (
            patch("server.get_conn", return_value=object()),
            patch("server._transaction", side_effect=transaction),
            patch("server._document_transform_response", return_value=response),
            patch("server._materialize_representation_chunks", side_effect=RuntimeError("index offline")),
            patch("server.log.exception") as logged,
        ):
            result = _best_effort_materialize_transform_chunks(
                IDENTITY, REVISION_ID, RECEIPT_ID,
            )

        self.assertIsNone(result)
        logged.assert_called_once()

    def test_one_unindexable_representation_does_not_rollback_another(self):
        @contextmanager
        def transaction(_connection):
            yield object()

        markdown = {
            **REPRESENTATION,
            "id": "70000000-0000-4000-8000-000000000002",
            "kind": "markdown",
            "content": "# usable fallback",
        }
        response = {"representations": [REPRESENTATION, markdown]}
        with (
            patch("server.get_conn", return_value=object()),
            patch("server._transaction", side_effect=transaction),
            patch("server._document_transform_response", return_value=response),
            patch(
                "server._materialize_representation_chunks",
                side_effect=[RuntimeError("structure too large"), {"id": "manifest"}],
            ) as materialize,
            patch("server.log.exception") as logged,
        ):
            _best_effort_materialize_transform_chunks(
                IDENTITY, REVISION_ID, RECEIPT_ID,
            )

        self.assertEqual(materialize.call_count, 2)
        self.assertEqual(materialize.call_args_list[1].args[2], markdown)
        logged.assert_called_once()


class DocumentLocalIndexStatusTests(unittest.TestCase):
    def test_no_chunkable_representation_is_not_built_without_querying(self):
        cursor = LocalIndexStatusCursor()
        status = _document_local_index_status(cursor, IDENTITY, [{
            "id": REPRESENTATION_ID,
            "kind": "original",
            "content_sha256": REPRESENTATION_SHA256,
        }])
        self.assertEqual(status, {
            "schemaId": "gb.document-local-index-status.v1",
            "status": "not-built",
        })
        self.assertEqual(cursor.executions, [])

    def test_missing_current_manifest_is_not_built_and_binds_current_descriptor(self):
        cursor = LocalIndexStatusCursor()
        latest_id = "70000000-0000-4000-8000-000000000003"
        latest_hash = "c" * 64
        status = _document_local_index_status(cursor, IDENTITY, [
            {"id": REPRESENTATION_ID, "kind": "document-structure", "content_sha256": REPRESENTATION_SHA256},
            {"id": "70000000-0000-4000-8000-000000000002", "kind": "markdown", "content_sha256": "b" * 64},
            {"id": latest_id, "kind": "document-structure", "content_sha256": latest_hash},
        ])

        self.assertEqual(status["status"], "not-built")
        self.assertEqual(len(cursor.executions), 3)
        descriptor = current_document_chunker("document-structure")
        parameters = cursor.executions[0][1]
        self.assertEqual(parameters, (
            TENANT_ID, latest_id, latest_hash, CHUNK_MANIFEST_SCHEMA_ID,
            descriptor["id"], descriptor["version"], descriptor["configSha256"],
        ))

    def test_zero_count_manifest_is_ready_without_exposing_chunk_text(self):
        descriptor = current_document_chunker("text")
        chunks_sha256 = hashlib.sha256(b"[]").hexdigest()
        manifest = {
            "id": "sha256:" + "d" * 64,
            "representation_id": REPRESENTATION_ID,
            "representation_sha256": REPRESENTATION_SHA256,
            "representation_kind": "text",
            "chunker": descriptor["id"],
            "chunker_version": descriptor["version"],
            "chunker_config_sha256": descriptor["configSha256"],
            "chunk_count": 0,
            "chunks_sha256": chunks_sha256,
        }
        cursor = LocalIndexStatusCursor(manifest=manifest, count=0)
        status = _document_local_index_status(cursor, IDENTITY, [{
            "id": REPRESENTATION_ID,
            "kind": "text",
            "content_sha256": REPRESENTATION_SHA256,
        }])

        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["chunk_count"], 0)
        self.assertEqual(status["chunks_sha256"], chunks_sha256)
        self.assertEqual(status["source"]["representation_id"], REPRESENTATION_ID)
        self.assertEqual(status["source"]["chunker_config_sha256"], descriptor["configSha256"])
        self.assertNotIn("chunks", status)
        self.assertTrue({"text", "textContent", "text_content"}.isdisjoint(_nested_keys(status)))
        self.assertTrue(all(
            "text_content" not in statement
            for statement, _parameters in cursor.executions
        ))

    def test_manifest_count_mismatch_fails_closed(self):
        descriptor = current_document_chunker("markdown")
        manifest = {
            "id": "sha256:" + "d" * 64,
            "representation_id": REPRESENTATION_ID,
            "representation_sha256": REPRESENTATION_SHA256,
            "representation_kind": "markdown",
            "chunker": descriptor["id"],
            "chunker_version": descriptor["version"],
            "chunker_config_sha256": descriptor["configSha256"],
            "chunk_count": 2,
            "chunks_sha256": "e" * 64,
        }
        cursor = LocalIndexStatusCursor(manifest=manifest, count=1)
        with self.assertRaises(HTTPException) as caught:
            _document_local_index_status(cursor, IDENTITY, [{
                "id": REPRESENTATION_ID,
                "kind": "markdown",
                "content_sha256": REPRESENTATION_SHA256,
            }])
        self.assertEqual(caught.exception.status_code, 409)

    def test_highest_priority_completed_manifest_wins_after_structure_failure(self):
        descriptor = current_document_chunker("markdown")
        markdown_id = "70000000-0000-4000-8000-000000000002"
        markdown_hash = "b" * 64
        manifest = {
            "id": "sha256:" + "d" * 64,
            "representation_id": markdown_id,
            "representation_sha256": markdown_hash,
            "representation_kind": "markdown",
            "chunker": descriptor["id"],
            "chunker_version": descriptor["version"],
            "chunker_config_sha256": descriptor["configSha256"],
            "chunk_count": 2,
            "chunks_sha256": "e" * 64,
        }
        cursor = LocalIndexStatusCursor(manifest=[None, manifest], count=2)
        status = _document_local_index_status(cursor, IDENTITY, [
            {
                "id": REPRESENTATION_ID,
                "kind": "document-structure",
                "content_sha256": REPRESENTATION_SHA256,
            },
            {
                "id": markdown_id,
                "kind": "markdown",
                "content_sha256": markdown_hash,
            },
        ])

        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["source"]["representation_id"], markdown_id)
        self.assertEqual(status["source"]["representation_kind"], "markdown")
        self.assertEqual(len(cursor.executions), 3)


if __name__ == "__main__":
    unittest.main()
