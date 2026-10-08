import hashlib
import base64
import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException, Request

from server import IdentityContext, import_document


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
ARTIFACT_ID = "30000000-0000-4000-8000-000000000001"
SOURCE_ID = "40000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "50000000-0000-4000-8000-000000000001"
REVISION_ID = "60000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "70000000-0000-4000-8000-000000000001"
BYTES = b"# Field note\n\n$E=mc^2$\n"


def request(
    body=BYTES,
    idempotency_key="document-import-test-1",
    *,
    filename="random-β-string.md",
    media_type="text/markdown",
    source_kind="upload",
    raster_image=None,
    ingestion_plan=None,
    capture_intent_sha256=None,
):
    metadata_value = {
        "title": "β Field note",
        "filename": filename,
        "sourceKind": source_kind,
        "sourceUri": f"datasource://{TENANT_ID}/item" if source_kind == "datasource"
        else "https://example.invalid/image.png" if source_kind == "url" else None,
        "arxivId": None,
    }
    if ingestion_plan is not None:
        metadata_value["ingestionPlan"] = ingestion_plan
    if capture_intent_sha256 is not None:
        metadata_value["captureIntentSha256"] = capture_intent_sha256
    metadata = base64.urlsafe_b64encode(json.dumps(
        metadata_value, ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")).decode("ascii").rstrip("=")
    headers = {
        "content-type": media_type,
        "content-length": str(len(body)),
        "idempotency-key": idempotency_key,
        "x-gb-import-metadata": metadata,
    }
    if raster_image is not None:
        headers["x-gb-raster-image"] = base64.urlsafe_b64encode(json.dumps(
            raster_image, separators=(",", ":"),
        ).encode("utf-8")).decode("ascii").rstrip("=")
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": "/documents/import",
        "query_string": b"", "headers": [(key.encode(), value.encode()) for key, value in headers.items()],
    }, receive)


class ImportCursor:
    def __init__(self):
        self.current = None
        self.executions = []
        self.source_metadata = {}

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if "FROM gb_artifact_sources WHERE tenant_id" in normalized:
            self.current = None
        elif normalized.startswith("INSERT INTO gb_artifacts"):
            self.current = {"id": ARTIFACT_ID}
        elif normalized.startswith("INSERT INTO gb_artifact_sources"):
            self.source_metadata = parameters[5].adapted
            self.current = {"id": SOURCE_ID}
        elif normalized.startswith("INSERT INTO gb_documents"):
            self.current = {"id": DOCUMENT_ID}
        elif normalized.startswith("INSERT INTO gb_document_revisions"):
            self.current = {"id": REVISION_ID}
        elif normalized.startswith("INSERT INTO gb_document_representations"):
            self.current = {"id": REPRESENTATION_ID}
        elif normalized.startswith("SELECT d.id AS document_id"):
            self.current = {
                "document_id": DOCUMENT_ID, "title": "β Field note",
                "display_filename": f"β Field note [{hashlib.sha256(BYTES).hexdigest()[:12]}].md",
                "revision_id": REVISION_ID, "version": 1, "revision_sha256": "b" * 64,
                "artifact_id": ARTIFACT_ID, "content_sha256": hashlib.sha256(BYTES).hexdigest(),
                "byte_size": len(BYTES), "media_type": "text/markdown", "source_id": SOURCE_ID,
                "source_kind": "upload", "original_filename": "random-β-string.md", "source_uri": None,
                "idempotency_key": "document-import-test-1", "request_sha256": "c" * 64,
                "created_at": "2026-09-23T00:00:00Z",
                "source_metadata": self.source_metadata,
            }
        elif normalized.startswith("SELECT id FROM gb_document_representations"):
            self.current = {"id": REPRESENTATION_ID}
        else:
            self.current = None

    def fetchone(self):
        return self.current


class ReplayCursor(ImportCursor):
    def __init__(self, request_sha256="c" * 64):
        super().__init__()
        self.request_sha256 = request_sha256

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if "FROM gb_artifact_sources WHERE tenant_id" in normalized:
            self.current = {"id": SOURCE_ID, "request_sha256": self.request_sha256}
        elif normalized.startswith("SELECT d.id AS document_id"):
            self.current = {
                "document_id": DOCUMENT_ID, "title": "β Field note",
                "display_filename": f"β Field note [{hashlib.sha256(BYTES).hexdigest()[:12]}].md",
                "revision_id": REVISION_ID, "version": 1, "revision_sha256": "b" * 64,
                "artifact_id": ARTIFACT_ID, "content_sha256": hashlib.sha256(BYTES).hexdigest(),
                "byte_size": len(BYTES), "media_type": "text/markdown", "source_id": SOURCE_ID,
                "source_kind": "upload", "original_filename": "random-β-string.md", "source_uri": None,
                "idempotency_key": "document-import-test-1", "request_sha256": self.request_sha256,
                "created_at": "2026-09-23T00:00:00Z",
                "source_metadata": self.source_metadata,
            }
        elif normalized.startswith("SELECT id FROM gb_document_representations"):
            self.current = {"id": REPRESENTATION_ID}
        else:
            self.current = None


class DocumentImportTests(unittest.IsolatedAsyncioTestCase):
    async def test_import_resolves_and_persists_authoritative_ingestion_plan_evidence(self):
        plan_claim = {
            "id": "document.upload-default", "version": "1.0.0",
            "contentSha256": "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
        }
        cursor = ImportCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=object()), patch("server._transaction", transaction):
            result = await import_document(request(ingestion_plan=plan_claim), identity)

        evidence = result["ingestion_plan"]
        self.assertEqual(evidence["schemaId"], "gb.ingestion-plan.v1")
        self.assertEqual(evidence["owner"], {"pluginId": "documents", "pluginVersion": "1.0.0"})
        self.assertEqual(evidence["implementationId"], "builtin.ingestion-plan.document-upload-default")
        source_insert = next(
            parameters for sql, parameters in cursor.executions
            if sql.startswith("INSERT INTO gb_artifact_sources")
        )
        self.assertEqual(source_insert[5].adapted["ingestionPlan"], evidence)

    async def test_import_rejects_ingestion_plan_drift_before_persistence(self):
        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with self.assertRaises(HTTPException) as captured:
            await import_document(request(ingestion_plan={
                "id": "document.upload-default", "version": "2.0.0",
                "contentSha256": "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
            }), identity)
        self.assertEqual(captured.exception.status_code, 422)
        self.assertIn("not registered", captured.exception.detail)

    async def test_import_rejects_ingestion_plan_for_another_source_kind(self):
        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        mismatches = [
            ("datasource", {
                "id": "document.upload-default",
                "version": "1.0.0",
                "contentSha256": "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
            }),
            ("upload", {
                "id": "datasource.file-default",
                "version": "1.0.0",
                "contentSha256": "e3f23ff9cfc350e5a29d3efb897b96bee480bae0375dba83bea1d15cfc5b68d3",
            }),
        ]
        for source_kind, plan in mismatches:
            with self.subTest(source_kind=source_kind), self.assertRaises(HTTPException) as captured:
                await import_document(request(source_kind=source_kind, ingestion_plan=plan), identity)
            self.assertEqual(captured.exception.status_code, 422)
            self.assertEqual(captured.exception.detail, "Ingestion plan does not authorize this source kind")

    async def test_import_persists_exact_bytes_before_creating_derived_state(self):
        cursor = ImportCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=object()), patch("server._transaction", transaction):
            result = await import_document(request(), identity)

        self.assertTrue(result["persisted"])
        self.assertFalse(result["replayed"])
        self.assertEqual(
            result["ref"],
            f"gb:object:v1:document:{DOCUMENT_ID}:pinned:sha256%3A{'b' * 64}",
        )
        self.assertNotIn("request_sha256", result)
        self.assertNotIn("idempotency_key", result)
        artifact_index = next(i for i, (sql, _) in enumerate(cursor.executions) if sql.startswith("INSERT INTO gb_artifacts"))
        representation_index = next(i for i, (sql, _) in enumerate(cursor.executions) if sql.startswith("INSERT INTO gb_document_representations"))
        self.assertLess(artifact_index, representation_index)
        artifact_parameters = cursor.executions[artifact_index][1]
        self.assertEqual(artifact_parameters[4].adapted, BYTES)
        self.assertEqual(artifact_parameters[1], hashlib.sha256(BYTES).hexdigest())

    async def test_url_capture_persists_intent_digest_in_request_and_source_metadata(self):
        digest = "d" * 64
        cursor = ImportCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=object()), patch("server._transaction", transaction):
            await import_document(request(
                source_kind="url",
                capture_intent_sha256=digest,
                idempotency_key="web-capture:test-1",
            ), identity)

        source_insert = next(
            parameters for sql, parameters in cursor.executions
            if sql.startswith("INSERT INTO gb_artifact_sources")
        )
        self.assertEqual(source_insert[5].adapted["captureIntentSha256"], digest)
        request_hash = source_insert[7]

        changed_cursor = ImportCursor()

        @contextmanager
        def changed_transaction(_connection):
            yield changed_cursor

        with patch("server.get_conn", return_value=object()), patch("server._transaction", changed_transaction):
            await import_document(request(
                source_kind="url",
                capture_intent_sha256="e" * 64,
                idempotency_key="web-capture:test-2",
            ), identity)
        changed_insert = next(
            parameters for sql, parameters in changed_cursor.executions
            if sql.startswith("INSERT INTO gb_artifact_sources")
        )
        self.assertNotEqual(request_hash, changed_insert[7])

    async def test_import_rejects_keys_that_the_durable_table_cannot_store(self):
        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with self.assertRaises(HTTPException) as captured:
            await import_document(request(idempotency_key="document/import/1"), identity)
        self.assertEqual(captured.exception.status_code, 422)
        self.assertEqual(captured.exception.detail, "Invalid document import idempotency key")

    async def test_replay_returns_the_same_reference_without_new_inserts(self):
        cursor = ReplayCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with (
            patch("server.get_conn", return_value=object()),
            patch("server._transaction", transaction),
            patch("server.import_request_hash", return_value="c" * 64),
        ):
            result = await import_document(request(), identity)

        self.assertTrue(result["replayed"])
        self.assertTrue(result["deduplicatedArtifact"])
        self.assertEqual(
            result["ref"],
            f"gb:object:v1:document:{DOCUMENT_ID}:pinned:sha256%3A{'b' * 64}",
        )
        self.assertFalse(any(sql.startswith("INSERT") for sql, _ in cursor.executions))

    async def test_reused_key_with_different_request_hash_conflicts(self):
        cursor = ReplayCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with (
            patch("server.get_conn", return_value=object()),
            patch("server._transaction", transaction),
            patch("server.import_request_hash", return_value="d" * 64),
        ):
            with self.assertRaises(HTTPException) as captured:
                await import_document(request(), identity)
        self.assertEqual(captured.exception.status_code, 409)
        self.assertEqual(captured.exception.detail, "Document import idempotency key was reused")

    async def test_raster_manifest_is_digest_bound_and_persisted_in_existing_source_metadata(self):
        raster_bytes = b"\x89PNG\r\n\x1a\ntrusted-static-image"
        digest = hashlib.sha256(raster_bytes).hexdigest()
        manifest = {
            "schemaId": "gb.raster-image.v1",
            "format": "png",
            "mediaType": "image/png",
            "width": 8,
            "height": 4,
            "channels": 4,
            "frameCount": 1,
            "byteSize": len(raster_bytes),
            "contentSha256": digest,
        }
        cursor = ImportCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=object()), patch("server._transaction", transaction):
            await import_document(request(
                raster_bytes,
                filename="figure.png",
                media_type="image/png",
                raster_image=manifest,
            ), identity)

        source_insert = next(
            parameters for sql, parameters in cursor.executions
            if sql.startswith("INSERT INTO gb_artifact_sources")
        )
        self.assertEqual(source_insert[5].adapted, {"arxivId": None, "rasterImage": manifest})
        revision_insert = next(
            parameters for sql, parameters in cursor.executions
            if sql.startswith("INSERT INTO gb_document_revisions")
        )
        self.assertNotEqual(revision_insert[6], "b" * 64)

        for invalid_request in [
            request(raster_bytes, filename="figure.png", media_type="image/png"),
            request(raster_bytes, filename="figure.jpg", media_type="image/png", raster_image=manifest),
            request(raster_bytes, filename="figure.png", media_type="image/png", raster_image={
                **manifest, "contentSha256": "b" * 64,
            }),
            request(raster_bytes, filename="figure.png", media_type="image/png", source_kind="url", raster_image=manifest),
            request(b"audio", filename="audio.mp3", media_type="audio/mpeg"),
        ]:
            with self.assertRaises(HTTPException) as captured:
                await import_document(invalid_request, identity)
            self.assertEqual(captured.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
