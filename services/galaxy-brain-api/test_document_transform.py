import hashlib
import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException, Request

from server import (
    IdentityContext,
    TRANSFORM_LEASE_SECONDS,
    _request_identity,
    _run_document_transform_attempt,
    list_document_representations,
    transform_document_revision,
)
from document_transform_adapters import (
    DOCLING_ASYNC_TIMEOUT_SECONDS,
    DOCLING_IMPLEMENTATION_ID,
    MARKITDOWN_IMPLEMENTATION_ID,
    PLAIN_TEXT_IMPLEMENTATION_ID,
    TRANSFORM_TIMEOUT_SECONDS,
    DocumentTransformResult,
    document_transform_adapter_fingerprint,
    document_transform_adapter_config,
    resolve_document_transform_adapter,
)
from durable_ingestion import normalize_docling_document, transform_request_hash
from ingestion_plan_registry import resolve_ingestion_plan_claim


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
ARTIFACT_ID = "30000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "50000000-0000-4000-8000-000000000001"
REVISION_ID = "60000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "70000000-0000-4000-8000-000000000001"
RECEIPT_IDS = [
    "80000000-0000-4000-8000-000000000001",
    "80000000-0000-4000-8000-000000000002",
]
ATTEMPT_ID = "90000000-0000-4000-8000-000000000001"
PDF_BYTES = b"%PDF-1.7\nfixture\n%%EOF"


def adapter_result(
    implementation_id,
    *,
    status,
    diagnostic_code=None,
    structure=None,
    markdown=None,
    engine_version=None,
):
    adapter = resolve_document_transform_adapter(implementation_id)
    if structure is not None and structure.get("schemaId") is None:
        structure = normalize_docling_document({
            "status": "success",
            "document": structure,
        })
    if engine_version is None:
        engine_version = {
            DOCLING_IMPLEMENTATION_ID: "2.52.0",
            MARKITDOWN_IMPLEMENTATION_ID: "0.1.8",
            PLAIN_TEXT_IMPLEMENTATION_ID: "unicode-15",
        }[implementation_id]
    return DocumentTransformResult(
        implementation_id=implementation_id,
        plugin_id=adapter.plugin_id,
        plugin_version=adapter.plugin_version,
        engine=adapter.engine,
        engine_version=engine_version,
        config=document_transform_adapter_config(
            implementation_id,
            "document-structure" if implementation_id == DOCLING_IMPLEMENTATION_ID else "markdown",
            engine_version=engine_version,
        ),
        status=status,
        diagnostic_code=diagnostic_code,
        structure=structure,
        markdown=markdown,
    )


def request(key="document-transform-test-1", mode=None):
    headers = [(b"idempotency-key", key.encode("ascii"))]
    if mode is not None:
        headers.append((b"x-gb-transform-mode", mode.encode("ascii")))
    return Request({
        "type": "http",
        "method": "POST",
        "path": f"/documents/{REVISION_ID}/transform",
        "query_string": b"",
        "headers": headers,
    })


class TransformCursor:
    def __init__(self, filename="Paper.pdf", source_metadata=None):
        self.filename = filename
        self.source_metadata = source_metadata or {}
        self.current = None
        self.rows = []
        self.representations = []
        self.receipts = []
        self.attempts = []
        self.request_keys = []
        self.executions = []
        self.transactional_executions = []
        self.rowcount = 0
        self.in_transaction = False

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if self.in_transaction:
            self.transactional_executions.append((normalized, parameters))
        self.current = None
        self.rows = []
        self.rowcount = 0
        if normalized.startswith("SELECT r.id AS revision_id"):
            self.current = {
                "revision_id": REVISION_ID,
                "document_id": DOCUMENT_ID,
                "original_artifact_id": ARTIFACT_ID,
                "display_filename": self.filename,
                "content_sha256": hashlib.sha256(PDF_BYTES).hexdigest(),
                "byte_size": len(PDF_BYTES),
                "media_type": (
                    "application/pdf" if self.filename.endswith(".pdf")
                    else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    if self.filename.endswith(".docx") else "text/markdown"
                ),
                "source_metadata": self.source_metadata,
                "content_bytes": PDF_BYTES,
            }
            if "a.content_bytes" not in normalized:
                self.current.pop("content_bytes")
        elif normalized.startswith("INSERT INTO gb_transform_request_keys"):
            match = next((row for row in self.request_keys if row["idempotency_key"] == parameters[1]), None)
            if match is None:
                self.request_keys.append({
                    "idempotency_key": parameters[1], "request_sha256": parameters[2],
                    "document_revision_id": parameters[3],
                })
        elif normalized.startswith("SELECT request_sha256 FROM gb_transform_request_keys"):
            self.current = next(
                (row for row in self.request_keys if row["idempotency_key"] == parameters[1]),
                None,
            )
        elif normalized.startswith("INSERT INTO gb_transform_attempts"):
            match = next((row for row in self.attempts if row["idempotency_key"] == parameters[4]), None)
            if match is None:
                attempt = {
                    "id": f"90000000-0000-4000-8000-{len(self.attempts) + 1:012d}",
                    "request_sha256": parameters[5],
                    "state": "running",
                    "lease_token": parameters[6],
                    "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
                    "primary_receipt_id": None,
                    "idempotency_key": parameters[4],
                    "attempt_count": 1,
                }
                self.attempts.append(attempt)
                self.current = {"id": attempt["id"]}
                self.rowcount = 1
        elif normalized.startswith("SELECT id, idempotency_key, request_sha256"):
            if "idempotency_key = %s" in normalized:
                attempt = next(
                    (row for row in self.attempts if row["idempotency_key"] == parameters[1]),
                    None,
                )
            else:
                attempt = next(
                    (row for row in self.attempts if row["request_sha256"] == parameters[1]),
                    None,
                )
            self.current = None if attempt is None else {
                **attempt,
                "lease_is_active": (
                    attempt["lease_expires_at"] is not None
                    and attempt["lease_expires_at"] > datetime.now(timezone.utc)
                ),
            }
        elif normalized.startswith("SELECT state, lease_token FROM gb_transform_attempts"):
            self.current = next((row for row in self.attempts if row["id"] == parameters[1]), None)
        elif normalized.startswith("UPDATE gb_transform_attempts SET lease_token"):
            attempt = next((row for row in self.attempts if row["id"] == parameters[3]), None)
            if attempt:
                attempt["lease_token"] = parameters[0]
                attempt["lease_expires_at"] = datetime.now(timezone.utc) + timedelta(minutes=5)
                attempt["attempt_count"] += 1
                self.rowcount = 1
        elif normalized.startswith("UPDATE gb_transform_attempts SET state = 'finished'"):
            attempt = next((row for row in self.attempts if row["id"] == parameters[2]), None)
            if attempt and attempt["lease_token"] == parameters[3]:
                attempt["state"] = "finished"
                attempt["primary_receipt_id"] = parameters[0]
                attempt["lease_token"] = None
                attempt["lease_expires_at"] = None
                self.rowcount = 1
        elif normalized.startswith("UPDATE gb_transform_attempts SET lease_expires_at = now()"):
            attempt = next((row for row in self.attempts if row["id"] == parameters[1]), None)
            if attempt and attempt["lease_token"] == parameters[2]:
                attempt["lease_expires_at"] = datetime.now(timezone.utc)
                self.rowcount = 1
        elif normalized.startswith("INSERT INTO gb_document_representations"):
            representation_id = f"70000000-0000-4000-8000-{len(self.representations) + 1:012d}"
            representation = {
                "id": representation_id,
                "kind": parameters[2],
                "media_type": parameters[3],
                "content_sha256": parameters[4],
                "artifact_id": None,
                "content_json": None,
                "content_bytes": parameters[5].adapted if parameters[5] is not None else None,
                "artifact_sha256": None,
                "created_at": "2026-09-23T00:00:00Z",
            }
            match = next((
                row for row in self.representations
                if row["kind"] == parameters[2] and row["content_sha256"] == parameters[4]
            ), None)
            if match is None:
                self.representations.append(representation)
                self.current = {"id": representation_id}
        elif normalized.startswith("SELECT id FROM gb_document_representations"):
            match = next((
                row for row in self.representations
                if row["kind"] == parameters[2] and row["content_sha256"] == parameters[3]
            ), None)
            self.current = None if match is None else {"id": match["id"]}
        elif normalized.startswith("INSERT INTO gb_transform_receipts"):
            receipt_id = RECEIPT_IDS[len(self.receipts)]
            receipt = {
                "id": receipt_id,
                "plugin_id": parameters[3],
                "plugin_version": parameters[4],
                "engine": parameters[5],
                "engine_version": parameters[6],
                "config_sha256": hashlib.sha256(b"config").hexdigest(),
                "input_sha256": parameters[9],
                "output_representation_id": parameters[10],
                "output_sha256": parameters[11],
                "status": parameters[12],
                "diagnostic_code": parameters[13],
                "output_manifest": parameters[14].adapted,
                "fallback_receipt_id": parameters[15],
                "idempotency_key": parameters[16],
                "request_sha256": parameters[17],
                "created_at": "2026-09-23T00:00:00Z",
            }
            self.receipts.append(receipt)
            self.current = {
                "id": receipt_id,
                "config_sha256": receipt["config_sha256"],
                "created_at": receipt["created_at"],
            }
        elif "FROM gb_transform_receipts WHERE id = %s" in normalized:
            self.current = next((row for row in self.receipts if row["id"] == parameters[0]), None)
        elif normalized.startswith("SELECT representation.id"):
            if self.in_transaction:
                raise AssertionError("representation materialization must happen after commit")
            self.rows = list(self.representations)
        elif "FROM gb_transform_receipts" in normalized and "ORDER BY created_at" in normalized:
            self.rows = list(reversed(self.receipts)) if "DESC" in normalized else list(self.receipts)

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class TransformConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class DocumentTransformTests(unittest.TestCase):
    def test_docx_uses_existing_docling_primary_and_markitdown_fallback(self):
        cursor = TransformCursor(filename="Paper.docx")
        calls = []

        def service(implementation_id, **kwargs):
            calls.append((implementation_id, kwargs["filename"], kwargs["media_type"]))
            if implementation_id == DOCLING_IMPLEMENTATION_ID:
                return adapter_result(
                    implementation_id, status="failed", diagnostic_code="docling.unavailable",
                )
            return adapter_result(
                implementation_id, status="success", markdown="# DOCX fallback",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=service),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-docx"), self.identity,
            )

        expected_media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        self.assertEqual(calls, [
            (DOCLING_IMPLEMENTATION_ID, "Paper.docx", expected_media),
            (MARKITDOWN_IMPLEMENTATION_ID, "Paper.docx", expected_media),
        ])
        self.assertEqual(result["receipt"]["plugin_id"], "docling")
        self.assertEqual(result["fallbackReceipt"]["plugin_id"], "markitdown")
        self.assertEqual(result["representations"][0]["content"], "# DOCX fallback")

    def test_attempt_lease_covers_primary_fallback_and_persistence(self):
        self.assertGreaterEqual(
            TRANSFORM_LEASE_SECONDS,
            DOCLING_ASYNC_TIMEOUT_SECONDS + TRANSFORM_TIMEOUT_SECONDS * 2,
        )

    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")
        # Chunk materialization is deliberately a separate, best-effort
        # post-commit transaction.  These tests exercise the immutable
        # transform transaction itself; chunk persistence has focused tests of
        # its own and must not weaken the transform cursor invariants here.
        self.chunk_materializer = patch(
            "server._best_effort_materialize_transform_chunks",
        )
        self.chunk_materializer.start()
        self.addCleanup(self.chunk_materializer.stop)
        self.engine_environment = patch.dict(
            "os.environ", {"DOCLING_ENGINE_VERSION": "2.52.0"}, clear=False,
        )
        self.engine_environment.start()
        self.addCleanup(self.engine_environment.stop)

    def transaction(self, cursor):
        @contextmanager
        def use_transaction(_connection):
            self.assertFalse(cursor.in_transaction)
            cursor.in_transaction = True
            try:
                yield cursor
            finally:
                cursor.in_transaction = False
        return use_transaction

    def test_docling_success_persists_hash_bound_structure_receipt_and_replays(self):
        cursor = TransformCursor()
        calls = []
        source_hashes = []

        def docling(implementation_id, **kwargs):
            self.assertFalse(cursor.in_transaction)
            calls.append((implementation_id, kwargs))
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.markdown_unavailable",
                structure={"pages": [{"number": 1}], "blocks": [{
                "id": "eq-1", "kind": "formula", "latex": "E=mc^2", "page": 1,
                }]},
            )

        def hash_bytes(value):
            if value == PDF_BYTES:
                self.assertFalse(cursor.in_transaction)
                source_hashes.append(value)
            return hashlib.sha256(value).hexdigest()

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
            patch("server.sha256_bytes", side_effect=hash_bytes),
        ):
            first = transform_document_revision(REVISION_ID, request(), self.identity)
            first_executions = list(cursor.transactional_executions)
            cursor.executions.clear()
            cursor.transactional_executions.clear()
            later_markdown = b"# Later unrelated transform"
            cursor.representations.append({
                "id": "70000000-0000-4000-8000-000000000099",
                "kind": "markdown", "media_type": "text/markdown; charset=utf-8",
                "content_sha256": hashlib.sha256(later_markdown).hexdigest(),
                "artifact_id": None, "content_json": None, "content_bytes": later_markdown,
                "artifact_sha256": None, "created_at": "2026-09-24T00:00:00Z",
            })
            replay = transform_document_revision(REVISION_ID, request(), self.identity)
            replay_executions = list(cursor.transactional_executions)
            cursor.executions.clear()
            cursor.transactional_executions.clear()
            with self.assertRaises(HTTPException) as conflict:
                transform_document_revision(
                    "60000000-0000-4000-8000-000000000002", request(), self.identity,
                )
            conflict_executions = list(cursor.transactional_executions)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], DOCLING_IMPLEMENTATION_ID)
        self.assertEqual(calls[0][1]["content"], PDF_BYTES)
        self.assertEqual(first["receipt"]["plugin_id"], "docling")
        self.assertEqual(first["receipt"]["plugin_version"], "1.0.2")
        self.assertEqual(first["receipt"]["status"], "partial")
        self.assertEqual(first["receipt"]["diagnostic_code"], "docling.markdown_unavailable")
        self.assertEqual(first["representations"][0]["kind"], "document-structure")
        self.assertEqual(
            first["receipt"]["output_sha256"],
            first["representations"][0]["content_sha256"],
        )
        manifest = first["receipt"]["output_manifest"]["representations"][0]
        self.assertEqual(manifest["contentSha256"], first["receipt"]["output_sha256"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt"]["id"], first["receipt"]["id"])
        self.assertEqual(conflict.exception.status_code, 409)
        self.assertEqual(source_hashes, [PDF_BYTES])
        self.assertTrue(any(
            "a.content_bytes" in statement
            for statement, _parameters in first_executions
        ))
        self.assertFalse(any(
            "a.content_bytes" in statement
            for statement, _parameters in replay_executions
        ))
        self.assertFalse(any(
            "a.content_bytes" in statement
            for statement, _parameters in conflict_executions
        ))
        self.assertTrue(any(
            "SELECT r.id AS revision_id, r.original_artifact_id" in statement
            and "a.content_bytes" not in statement
            for statement, _parameters in first_executions
        ))
        self.assertFalse(any(
            statement.startswith("SELECT representation.id")
            for statement, _parameters in first_executions
        ))

    def test_http_request_returns_running_before_background_converter_execution(self):
        cursor = TransformCursor()
        calls = []
        scheduled = []

        def docling(implementation_id, **_kwargs):
            calls.append(implementation_id)
            return adapter_result(
                implementation_id,
                status="success",
                structure={
                    "pages": [{"number": 1}],
                    "blocks": [{"id": "title-1", "kind": "title", "text": "Exact title"}],
                },
                markdown="# Exact title",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
            patch(
                "server._schedule_document_transform_attempt",
                side_effect=lambda **execution: scheduled.append(execution),
            ),
        ):
            response = transform_document_revision(
                REVISION_ID,
                request("document-transform-background"),
                self.identity,
                BackgroundTasks(),
            )
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.headers["retry-after"], "2")
            self.assertEqual(json.loads(response.body)["status"], "running")
            self.assertEqual(calls, [])
            self.assertEqual(len(scheduled), 1)

            result = transform_document_revision.__globals__["_execute_document_transform_attempt"](
                **scheduled[0],
            )

        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID])
        self.assertEqual(result["receipt"]["status"], "success")
        self.assertEqual(
            [item["kind"] for item in result["representations"]],
            ["document-structure", "markdown"],
        )

    def test_independent_background_worker_owns_and_releases_capacity(self):
        events = []

        class Capacity:
            def acquire(self, *, blocking):
                events.append(("acquire", blocking))
                return True

            def release(self):
                events.append(("release",))

        execution = {
            "identity": self.identity,
            "attempt_id": ATTEMPT_ID,
            "lease_token": "lease-token",
        }
        with (
            patch("server._TRANSFORM_SEMAPHORE", Capacity()),
            patch(
                "server._execute_document_transform_attempt",
                side_effect=lambda **_execution: events.append(
                    ("execute", _request_identity.get()),
                ),
            ),
        ):
            self.assertIsNone(_request_identity.get())
            _run_document_transform_attempt(**execution)

        self.assertEqual(events, [
            ("acquire", False),
            ("execute", self.identity),
            ("release",),
        ])
        self.assertIsNone(_request_identity.get())

    def test_background_worker_releases_lease_when_capacity_is_full(self):
        class FullCapacity:
            def acquire(self, *, blocking):
                assert blocking is False
                return False

        execution = {
            "identity": self.identity,
            "attempt_id": ATTEMPT_ID,
            "lease_token": "lease-token",
        }
        with (
            patch("server._TRANSFORM_SEMAPHORE", FullCapacity()),
            patch("server._release_transform_attempt") as release_attempt,
            patch("server._execute_document_transform_attempt") as execute_attempt,
        ):
            _run_document_transform_attempt(**execution)

        release_attempt.assert_called_once_with(self.identity, ATTEMPT_ID, "lease-token")
        execute_attempt.assert_not_called()

    def test_official_docling_success_persists_structure_and_markdown_in_one_manifest(self):
        cursor = TransformCursor()
        calls = []

        def docling(implementation_id, **kwargs):
            calls.append((implementation_id, kwargs))
            return adapter_result(
                implementation_id,
                status="success",
                structure={
                    "pages": [{"number": 1}],
                    "blocks": [{"id": "eq-1", "kind": "formula", "latex": "E=mc^2"}],
                },
                markdown="# Converted\n\n$$E=mc^2$$",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-official"), self.identity,
            )

        self.assertEqual(calls[0][0], DOCLING_IMPLEMENTATION_ID)
        self.assertEqual(calls[0][1]["filename"], "Paper.pdf")
        self.assertEqual(calls[0][1]["media_type"], "application/pdf")
        self.assertEqual(result["receipt"]["engine_version"], "2.52.0")
        self.assertEqual(
            [item["kind"] for item in result["representations"]],
            ["document-structure", "markdown"],
        )
        manifest = result["receipt"]["output_manifest"]["representations"]
        self.assertEqual([item["kind"] for item in manifest], ["document-structure", "markdown"])
        self.assertEqual(result["receipt"]["output_representation_id"], manifest[0]["id"])

    def test_official_docling_markdown_only_partial_is_persisted_without_lossy_fallback(self):
        cursor = TransformCursor()
        calls = []

        def docling(implementation_id, **_kwargs):
            calls.append(implementation_id)
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.structure_unavailable",
                markdown="# Partial but exact\n\n$$E=mc^2$$",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-markdown-partial"), self.identity,
            )

        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID])
        self.assertEqual(result["receipt"]["status"], "partial")
        self.assertEqual(result["receipt"]["diagnostic_code"], "docling.structure_unavailable")
        self.assertEqual([item["kind"] for item in result["representations"]], ["markdown"])
        self.assertIsNone(result["fallbackReceipt"])

    def test_official_docling_both_output_partial_remains_partial_without_fallback(self):
        cursor = TransformCursor()
        calls = []

        def docling(implementation_id, **_kwargs):
            calls.append(implementation_id)
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.partial_success",
                structure={
                    "pages": [{"number": 1}],
                    "blocks": [{"id": "text-1", "kind": "text", "text": "Usable partial"}],
                },
                markdown="# Usable partial",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-both-output-partial"), self.identity,
            )

        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID])
        self.assertEqual(result["receipt"]["status"], "partial")
        self.assertEqual(result["receipt"]["diagnostic_code"], "docling.partial_success")
        self.assertNotIn("redacted", json.dumps(result["receipt"]))
        self.assertEqual(
            [item["kind"] for item in result["representations"]],
            ["document-structure", "markdown"],
        )
        self.assertIsNone(result["fallbackReceipt"])

    def test_missing_docling_status_fails_closed_and_uses_declared_fallback(self):
        cursor = TransformCursor()
        calls = []

        def service(implementation_id, **_kwargs):
            calls.append(implementation_id)
            if implementation_id == DOCLING_IMPLEMENTATION_ID:
                return adapter_result(
                    implementation_id,
                    status="failed",
                    diagnostic_code="docling.invalid_response",
                    engine_version="2.52.0",
                )
            return adapter_result(
                implementation_id,
                status="success",
                markdown="# Safe fallback",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=service),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-missing-status"), self.identity,
            )

        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID, MARKITDOWN_IMPLEMENTATION_ID])
        self.assertEqual(result["receipt"]["status"], "failed")
        self.assertEqual(result["receipt"]["diagnostic_code"], "docling.invalid_response")
        self.assertEqual(result["fallbackReceipt"]["status"], "fallback")
        self.assertEqual(result["representations"][0]["content"], "# Safe fallback")

    def test_fresh_idempotency_key_replays_same_canonical_transform(self):
        cursor = TransformCursor()
        calls = []

        def docling(implementation_id, **kwargs):
            calls.append((implementation_id, kwargs))
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.markdown_unavailable",
                structure={"pages": [], "blocks": []},
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
        ):
            first = transform_document_revision(
                REVISION_ID, request("document-transform-canonical-a"), self.identity,
            )
            replay = transform_document_revision(
                REVISION_ID, request("document-transform-canonical-b"), self.identity,
            )
            with self.assertRaises(HTTPException) as reused:
                transform_document_revision(
                    "60000000-0000-4000-8000-000000000002",
                    request("document-transform-canonical-b"), self.identity,
                )

        self.assertEqual(len(calls), 1)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["receipt"]["id"], first["receipt"]["id"])
        self.assertEqual([item["id"] for item in replay["representations"]], [REPRESENTATION_ID])
        self.assertEqual(len(cursor.attempts), 1)
        self.assertEqual(len(cursor.request_keys), 2)
        self.assertEqual(reused.exception.status_code, 409)

    def test_explicit_reprocess_creates_a_fresh_bounded_attempt(self):
        cursor = TransformCursor()
        calls = []

        def docling(implementation_id, **kwargs):
            calls.append((implementation_id, kwargs))
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.structure_invalid",
                markdown="# Diagram retry",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=docling),
        ):
            first = transform_document_revision(
                REVISION_ID, request("document-transform-reprocess-a"), self.identity,
            )
            retried = transform_document_revision(
                REVISION_ID,
                request("document-transform-reprocess-b", "reprocess"),
                self.identity,
            )

        self.assertEqual(len(calls), 2)
        self.assertFalse(first["replayed"])
        self.assertFalse(retried["replayed"])
        self.assertNotEqual(cursor.attempts[0]["request_sha256"], cursor.attempts[1]["request_sha256"])

    def test_transform_rejects_unknown_reprocess_mode(self):
        with self.assertRaises(HTTPException) as rejected:
            transform_document_revision(
                REVISION_ID,
                request("document-transform-bad-mode", "force"),
                self.identity,
            )
        self.assertEqual(rejected.exception.status_code, 422)

    def test_plan_governed_transform_identity_binds_persisted_plan_digest(self):
        claim = {
            "id": "document.upload-default",
            "version": "1.0.0",
            "contentSha256": "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
        }
        plan = resolve_ingestion_plan_claim(claim)
        cursor = TransformCursor(source_metadata={"ingestionPlan": plan})

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", return_value=adapter_result(
                DOCLING_IMPLEMENTATION_ID,
                status="partial",
                diagnostic_code="docling.markdown_unavailable",
                structure={"pages": [], "blocks": []},
            )),
        ):
            transform_document_revision(
                REVISION_ID, request("document-transform-plan-bound"), self.identity,
            )

        expected = transform_request_hash(
            REVISION_ID,
            hashlib.sha256(PDF_BYTES).hexdigest(),
            document_transform_adapter_fingerprint(),
            plan["contentSha256"],
        )
        self.assertEqual(cursor.request_keys[0]["request_sha256"], expected)

    def test_docling_failure_uses_declared_markitdown_fallback_and_links_receipts(self):
        cursor = TransformCursor()
        calls = []

        def service(implementation_id, **_kwargs):
            self.assertFalse(cursor.in_transaction)
            calls.append(implementation_id)
            if implementation_id == DOCLING_IMPLEMENTATION_ID:
                return adapter_result(
                    implementation_id,
                    status="failed",
                    diagnostic_code="docling.unavailable",
                )
            self.assertEqual(implementation_id, MARKITDOWN_IMPLEMENTATION_ID)
            return adapter_result(
                implementation_id,
                status="success",
                markdown="# Converted\n\n$E=mc^2$",
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=service),
        ):
            result = transform_document_revision(REVISION_ID, request("document-transform-test-2"), self.identity)
            replay = transform_document_revision(REVISION_ID, request("document-transform-test-2"), self.identity)

        self.assertEqual(result["receipt"]["plugin_id"], "docling")
        self.assertEqual(result["receipt"]["status"], "failed")
        self.assertEqual(result["receipt"]["diagnostic_code"], "docling.unavailable")
        self.assertEqual(result["fallbackReceipt"]["plugin_id"], "markitdown")
        self.assertEqual(result["fallbackReceipt"]["status"], "fallback")
        self.assertEqual(result["fallbackReceipt"]["engine_version"], "0.1.8")
        self.assertEqual(result["receipt"]["fallback_receipt_id"], result["fallbackReceipt"]["id"])
        self.assertEqual(result["representations"][0]["content"], "# Converted\n\n$E=mc^2$")
        self.assertNotIn("url", result["receipt"]["output_manifest"])
        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID, MARKITDOWN_IMPLEMENTATION_ID])
        self.assertTrue(replay["replayed"])

    def test_docling_transport_failures_remain_exact_on_primary_fallback_receipt(self):
        for index, diagnostic in enumerate((
            "docling.timeout", "docling.output_too_large",
            "docling.redirected", "docling.invalid_response",
        )):
            with self.subTest(diagnostic=diagnostic):
                cursor = TransformCursor()

                def service(implementation_id, **_kwargs):
                    if implementation_id == DOCLING_IMPLEMENTATION_ID:
                        return adapter_result(
                            implementation_id,
                            status="failed",
                            diagnostic_code=diagnostic,
                        )
                    return adapter_result(
                        implementation_id,
                        status="success",
                        markdown="# Safe fallback",
                    )

                with (
                    patch("server.get_conn", return_value=TransformConnection(cursor)),
                    patch("server._transaction", self.transaction(cursor)),
                    patch("server.execute_document_transform_adapter", side_effect=service),
                ):
                    result = transform_document_revision(
                        REVISION_ID, request(f"document-transform-failure-{index}"), self.identity,
                    )

                self.assertEqual(result["receipt"]["status"], "failed")
                self.assertEqual(result["receipt"]["diagnostic_code"], diagnostic)
                self.assertEqual(result["fallbackReceipt"]["status"], "fallback")
                self.assertEqual(
                    result["receipt"]["fallback_receipt_id"], result["fallbackReceipt"]["id"],
                )

    def test_missing_docling_engine_version_falls_back_with_fixed_diagnostic(self):
        cursor = TransformCursor()
        calls = []

        def service(implementation_id, **_kwargs):
            calls.append(implementation_id)
            if implementation_id == DOCLING_IMPLEMENTATION_ID:
                return adapter_result(
                    implementation_id,
                    status="failed",
                    diagnostic_code="docling.engine_version_not_configured",
                    engine_version="unknown",
                )
            self.assertEqual(implementation_id, MARKITDOWN_IMPLEMENTATION_ID)
            return adapter_result(
                implementation_id,
                status="success",
                markdown="# Safe fallback",
            )

        with (
            patch.dict("os.environ", {"DOCLING_ENGINE_VERSION": ""}, clear=False),
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=service),
        ):
            result = transform_document_revision(
                REVISION_ID, request("document-transform-no-engine-version"), self.identity,
            )

        self.assertEqual(calls, [DOCLING_IMPLEMENTATION_ID, MARKITDOWN_IMPLEMENTATION_ID])
        self.assertEqual(result["receipt"]["diagnostic_code"], "docling.engine_version_not_configured")
        self.assertEqual(result["receipt"]["engine_version"], "unknown")
        self.assertEqual(result["fallbackReceipt"]["engine_version"], "0.1.8")

    def test_representation_listing_retains_receipts_across_representation_query(self):
        cursor = TransformCursor()
        markdown = b"# Converted"
        cursor.representations.append({
            "id": REPRESENTATION_ID,
            "kind": "markdown",
            "media_type": "text/markdown; charset=utf-8",
            "content_sha256": hashlib.sha256(markdown).hexdigest(),
            "artifact_id": None,
            "content_json": None,
            "content_bytes": markdown,
            "artifact_sha256": None,
            "created_at": "2026-09-23T00:00:00Z",
        })
        cursor.receipts.append({
            "id": RECEIPT_IDS[0],
            "plugin_id": "markitdown",
            "plugin_version": "1.0.0",
            "engine": "markitdown",
            "engine_version": "service-0.1.0",
            "config_sha256": hashlib.sha256(b"config").hexdigest(),
            "input_sha256": hashlib.sha256(PDF_BYTES).hexdigest(),
            "output_representation_id": REPRESENTATION_ID,
            "output_sha256": hashlib.sha256(markdown).hexdigest(),
            "status": "fallback",
            "diagnostic_code": None,
            "output_manifest": {"representations": []},
            "fallback_receipt_id": None,
            "created_at": "2026-09-23T00:00:00Z",
        })
        connection = type("Connection", (), {"cursor": lambda _self: cursor})()

        with patch("server.get_conn", return_value=connection):
            result = list_document_representations(REVISION_ID, self.identity)

        self.assertEqual(result["representations"][0]["id"], REPRESENTATION_ID)
        self.assertEqual(result["receipts"][0]["id"], RECEIPT_IDS[0])
        self.assertEqual(result["receipts"][0]["plugin_id"], "markitdown")
        self.assertFalse(any("a.content_bytes" in statement for statement, _ in cursor.executions))

    def test_representation_listing_projects_only_latest_receipt_outputs(self):
        cursor = TransformCursor()
        old_markdown = b"# Stale"
        cursor.representations.append({
            "id": REPRESENTATION_ID,
            "kind": "markdown",
            "media_type": "text/markdown; charset=utf-8",
            "content_sha256": hashlib.sha256(old_markdown).hexdigest(),
            "artifact_id": None,
            "content_json": None,
            "content_bytes": old_markdown,
            "artifact_sha256": None,
            "created_at": "2026-09-22T00:00:00Z",
        })
        base = {
            "plugin_id": "docling", "plugin_version": "1.0.0",
            "engine": "docling", "engine_version": "2.52.0",
            "config_sha256": hashlib.sha256(b"config").hexdigest(),
            "input_sha256": hashlib.sha256(PDF_BYTES).hexdigest(),
            "fallback_receipt_id": None,
        }
        cursor.receipts.extend([
            {
                **base, "id": RECEIPT_IDS[0], "status": "success",
                "output_representation_id": REPRESENTATION_ID,
                "output_sha256": hashlib.sha256(old_markdown).hexdigest(),
                "diagnostic_code": None,
                "output_manifest": {"representations": [{
                    "id": REPRESENTATION_ID, "kind": "markdown",
                    "mediaType": "text/markdown; charset=utf-8",
                    "contentSha256": hashlib.sha256(old_markdown).hexdigest(),
                }]},
                "created_at": "2026-09-22T00:00:01Z",
            },
            {
                **base, "id": RECEIPT_IDS[1], "status": "failed",
                "output_representation_id": None, "output_sha256": None,
                "diagnostic_code": "docling.invalid_response",
                "output_manifest": {"representations": []},
                "created_at": "2026-09-23T00:00:01Z",
            },
        ])
        connection = type("Connection", (), {"cursor": lambda _self: cursor})()

        with patch("server.get_conn", return_value=connection):
            result = list_document_representations(REVISION_ID, self.identity)

        self.assertEqual([receipt["id"] for receipt in result["receipts"]], [RECEIPT_IDS[1]])
        self.assertEqual(result["representations"], [])

    def test_running_attempt_returns_202_without_provider_or_database_hold(self):
        cursor = TransformCursor()
        cursor.attempts.append({
            "id": ATTEMPT_ID,
            "request_sha256": transform_request_hash(
                REVISION_ID, hashlib.sha256(PDF_BYTES).hexdigest(),
                document_transform_adapter_fingerprint(),
            ),
            "state": "running",
            "lease_token": "a0000000-0000-4000-8000-000000000001",
            "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5),
            "primary_receipt_id": None,
            "idempotency_key": "document-transform-test-3",
            "attempt_count": 1,
        })
        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter") as service,
            patch("server.sha256_bytes") as hash_bytes,
        ):
            response = transform_document_revision(
                REVISION_ID, request("document-transform-test-3"), self.identity,
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(json.loads(response.body)["status"], "running")
        self.assertEqual(response.headers["retry-after"], "5")
        self.assertTrue(any(
            "lease_expires_at > now() AS lease_is_active" in statement
            for statement, _parameters in cursor.executions
        ))
        service.assert_not_called()
        hash_bytes.assert_not_called()
        self.assertFalse(any(
            "a.content_bytes" in statement
            for statement, _parameters in cursor.executions
        ))

    def test_capacity_rejection_releases_lease_without_loading_or_hashing_source(self):
        cursor = TransformCursor()
        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server._TRANSFORM_SEMAPHORE.acquire", return_value=False),
            patch("server.execute_document_transform_adapter") as service,
            patch("server.sha256_bytes") as hash_bytes,
            self.assertRaises(HTTPException) as caught,
        ):
            transform_document_revision(
                REVISION_ID, request("document-transform-test-capacity"), self.identity,
            )

        self.assertEqual(caught.exception.status_code, 503)
        self.assertLessEqual(cursor.attempts[0]["lease_expires_at"], datetime.now(timezone.utc))
        service.assert_not_called()
        hash_bytes.assert_not_called()
        self.assertFalse(any(
            "a.content_bytes" in statement
            for statement, _parameters in cursor.executions
        ))

    def test_source_hash_failure_releases_owned_lease(self):
        cursor = TransformCursor()
        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.sha256_bytes", return_value="0" * 64),
            patch("server.execute_document_transform_adapter") as service,
            self.assertRaises(HTTPException) as caught,
        ):
            transform_document_revision(
                REVISION_ID, request("document-transform-test-bad-hash"), self.identity,
            )

        self.assertEqual(caught.exception.status_code, 409)
        self.assertLessEqual(cursor.attempts[0]["lease_expires_at"], datetime.now(timezone.utc))
        self.assertTrue(any(
            "a.content_bytes" in statement
            for statement, _parameters in cursor.executions
        ))
        service.assert_not_called()

    def test_expired_attempt_is_reclaimed_and_stale_worker_cannot_finalize(self):
        cursor = TransformCursor()
        cursor.attempts.append({
            "id": ATTEMPT_ID,
            "request_sha256": transform_request_hash(
                REVISION_ID, hashlib.sha256(PDF_BYTES).hexdigest(),
                document_transform_adapter_fingerprint(),
            ),
            "state": "running",
            "lease_token": "a0000000-0000-4000-8000-000000000001",
            "lease_expires_at": datetime.now(timezone.utc) - timedelta(seconds=1),
            "primary_receipt_id": None,
            "idempotency_key": "document-transform-test-4",
            "attempt_count": 1,
        })

        def supersede_after_provider(implementation_id, **_kwargs):
            self.assertFalse(cursor.in_transaction)
            cursor.attempts[0]["lease_token"] = "b0000000-0000-4000-8000-000000000002"
            return adapter_result(
                implementation_id,
                status="partial",
                diagnostic_code="docling.markdown_unavailable",
                structure={"pages": [], "blocks": []},
            )

        with (
            patch("server.get_conn", return_value=TransformConnection(cursor)),
            patch("server._transaction", self.transaction(cursor)),
            patch("server.execute_document_transform_adapter", side_effect=supersede_after_provider),
            self.assertRaises(HTTPException) as caught,
        ):
            transform_document_revision(
                REVISION_ID, request("document-transform-test-4"), self.identity,
            )

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(cursor.attempts[0]["attempt_count"], 2)
        self.assertEqual(cursor.receipts, [])
        self.assertEqual(cursor.representations, [])


if __name__ == "__main__":
    unittest.main()
