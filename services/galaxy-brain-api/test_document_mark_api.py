import hashlib
import json
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request

from document_marks import document_mark_content_hash, document_mark_request_hash
from object_links import parse_canonical_reference
from server import (
    IdentityContext,
    _authorize_local_referent,
    create_document_mark,
    get_document_revision,
    read_document_representation_content,
    update_document_mark,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
UPDATER_PRINCIPAL_ID = "20000000-0000-4000-8000-000000000002"
REVISION_ID = "40000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "50000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "30000000-0000-4000-8000-000000000001"
MARK_ID = "60000000-0000-4000-8000-000000000001"
MARK_REVISION_ID = "70000000-0000-4000-8000-000000000001"
ANCHOR_ID = "sha256:" + ("a" * 64)
REPRESENTATION_SHA = "b" * 64


def request(value, *, method="POST", headers=None):
    body = json.dumps(value, separators=(",", ":")).encode()
    delivered = False
    request_headers = {"X-GB-Human-Session": "v1"} if headers is None else headers

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": method, "path": "/", "query_string": b"",
        "headers": [(key.lower().encode(), value.encode()) for key, value in request_headers.items()],
    }, receive)


class Cursor:
    def __init__(self):
        self.current = None
        self.rows = []
        self.executions = []
        self.mark_id = MARK_ID
        self.mark_revision_id = MARK_REVISION_ID
        self.version = 1
        self.kind = "note"
        self.state = {
            "body_markdown": "Initial $x$", "color": "#6d7a68",
            "semantic_role": "note", "tags": ["vortex"], "state": "active",
        }
        self.content_hash = document_mark_content_hash(ANCHOR_ID, self.kind, self.state)

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        self.current = None
        self.rows = []
        if normalized.startswith("SELECT anchor.id"):
            self.current = {
                "id": ANCHOR_ID, "document_revision_id": REVISION_ID,
                "representation_id": REPRESENTATION_ID, "representation_sha256": REPRESENTATION_SHA,
                "selector_json": {"kind": "text-quote", "exact": "evidence"},
                "selector_kind": "text-quote", "selector_sha256": "c" * 64,
                "anchor_sha256": "a" * 64, "created_at": "2026-09-23T00:00:00Z",
                "document_id": "30000000-0000-4000-8000-000000000001",
                "document_revision_sha256": "d" * 64, "title": "Paper",
                "display_filename": "Paper.pdf", "source_id": "80000000-0000-4000-8000-000000000001",
                "source_kind": "upload", "source_uri": None,
                "representation_kind": "markdown", "representation_media_type": "text/markdown",
            }
        elif normalized.startswith("INSERT INTO gb_document_marks"):
            self.mark_id = str(parameters[0])
            self.mark_revision_id = str(parameters[5])
            self.kind = parameters[4]
            self.content_hash = parameters[6]
            self.state = {
                "body_markdown": parameters[7], "color": parameters[8],
                "semantic_role": parameters[9], "tags": list(parameters[10]),
                "state": parameters[11],
            }
            self.current = {"id": self.mark_id}
        elif normalized.startswith("INSERT INTO gb_document_mark_revisions"):
            self.current = None
        elif normalized.startswith("SELECT mark.id"):
            self.current = {
                "id": self.mark_id, "document_revision_id": REVISION_ID,
                "anchor_id": ANCHOR_ID, "kind": self.kind,
                "current_version": self.version, "current_revision_id": self.mark_revision_id,
                "current_content_hash": self.content_hash, **self.state,
                "created_by_principal_id": PRINCIPAL_ID,
                "created_at": "2026-09-23T00:00:00Z", "updated_at": "2026-09-23T00:00:00Z",
                "representation_sha256": REPRESENTATION_SHA,
            }
        elif normalized.startswith("SELECT id, mark_id, request_hash"):
            self.current = None
        elif normalized.startswith("SELECT id, document_revision_id"):
            self.current = {
                "id": self.mark_id, "document_revision_id": REVISION_ID,
                "anchor_id": ANCHOR_ID, "kind": self.kind,
                "current_version": self.version, **self.state,
            }
        elif normalized.startswith("UPDATE gb_document_marks"):
            self.version = int(parameters[0])
            self.mark_revision_id = str(parameters[1])
            self.content_hash = parameters[2]
            self.state = {
                "body_markdown": parameters[3], "color": parameters[4],
                "semantic_role": parameters[5], "tags": list(parameters[6]),
                "state": parameters[7],
            }
            self.current = {"id": self.mark_id}

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class DocumentMarkApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")

    async def test_mark_mutations_require_a_trusted_human_browser_session_before_body_read(self):
        payload_reader = AsyncMock(return_value={})
        denied = (
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "human"), request({}, headers={})),
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "human"), request({}, headers={
                "X-GB-Human-Session": "spoofed",
            })),
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "agent"), request({})),
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "service"), request({})),
        )
        with patch("server._read_document_mark_json", payload_reader):
            for identity, mark_request in denied:
                with self.subTest(principal_kind=identity.principal_kind), self.assertRaises(HTTPException) as caught:
                    await create_document_mark(REVISION_ID, ANCHOR_ID, mark_request, identity)
                self.assertEqual(caught.exception.status_code, 403)
            with self.assertRaises(HTTPException) as caught:
                await update_document_mark(
                    REVISION_ID, MARK_ID, request({}, method="PATCH", headers={}), self.identity,
                )
            self.assertEqual(caught.exception.status_code, 403)
        payload_reader.assert_not_awaited()

    async def test_create_and_update_append_revisions_with_optimistic_version(self):
        cursor = Cursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        create = {
            "kind": "note", "body_markdown": "Initial $x$", "color": "#6D7A68",
            "semantic_role": "note", "tags": ["vortex"], "state": "active",
            "idempotency_key": "reader-mark-create-1",
        }
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            created = await create_document_mark(REVISION_ID, ANCHOR_ID, request(create), self.identity)
            updated = await update_document_mark(
                REVISION_ID, created["id"],
                request({
                    "expected_version": 1, "body_markdown": "Revised $x^2$",
                    "state": "resolved", "idempotency_key": "reader-mark-update-1",
                }, method="PATCH"),
                self.identity,
            )
        self.assertEqual(created["version"], 1)
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["state"], "resolved")
        self.assertIn("document.mark", updated["ref"])
        revision_inserts = [sql for sql, _ in cursor.executions if sql.startswith("INSERT INTO gb_document_mark_revisions")]
        self.assertEqual(len(revision_inserts), 2)

    async def test_update_rejects_stale_expected_version(self):
        cursor = Cursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            with self.assertRaises(HTTPException) as caught:
                await update_document_mark(
                    REVISION_ID, MARK_ID,
                    request({
                        "expected_version": 2, "body_markdown": "stale",
                        "idempotency_key": "reader-mark-update-2",
                    }, method="PATCH"),
                    self.identity,
                )
        self.assertEqual(caught.exception.status_code, 409)

    async def test_manual_mark_json_rejects_non_text_enum_and_idempotency_types(self):
        base = {
            "kind": "note", "body_markdown": "Initial", "color": "#6d7a68",
            "semantic_role": "note", "tags": [], "state": "active",
            "idempotency_key": "reader-mark-invalid-1",
        }
        for changed in (
            {**base, "kind": []},
            {**base, "semantic_role": []},
            {**base, "state": {}},
            {**base, "idempotency_key": 42},
        ):
            with self.subTest(changed=changed), self.assertRaises(HTTPException) as caught:
                await create_document_mark(
                    REVISION_ID, ANCHOR_ID, request(changed), self.identity,
                )
            self.assertEqual(caught.exception.status_code, 422)

        with self.assertRaises(HTTPException) as caught:
            await update_document_mark(
                REVISION_ID, MARK_ID,
                request({
                    "expected_version": 1, "body_markdown": "updated",
                    "idempotency_key": ["not", "text"],
                }, method="PATCH"),
                self.identity,
            )
        self.assertEqual(caught.exception.status_code, 422)

    async def test_delayed_create_replay_returns_original_v1_acknowledgement(self):
        create = {
            "kind": "note", "body_markdown": "Original", "color": "#6D7A68",
            "semantic_role": "note", "tags": ["vortex"], "state": "active",
            "idempotency_key": "reader-mark-create-replay-1",
        }
        request_hash = document_mark_request_hash("create", {
            "document_revision_id": REVISION_ID,
            "anchor_id": ANCHOR_ID,
            "kind": "note",
            "body_markdown": "Original",
            "color": "#6d7a68",
            "semantic_role": "note",
            "tags": ["vortex"],
            "state": "active",
        })

        class CreateReplayCursor(Cursor):
            def execute(self, statement, parameters=None):
                normalized = " ".join(statement.split())
                self.executions.append((normalized, parameters))
                self.rows = []
                if normalized.startswith("SELECT anchor.id"):
                    self.current = {
                        "id": ANCHOR_ID, "document_revision_id": REVISION_ID,
                        "representation_id": REPRESENTATION_ID,
                        "representation_sha256": REPRESENTATION_SHA,
                        "selector_json": {"kind": "text-quote", "exact": "evidence"},
                        "selector_kind": "text-quote", "selector_sha256": "c" * 64,
                        "anchor_sha256": "a" * 64, "created_at": "2026-09-23T00:00:00Z",
                        "document_id": "30000000-0000-4000-8000-000000000001",
                        "document_revision_sha256": "d" * 64, "title": "Paper",
                        "display_filename": "Paper.pdf",
                        "source_id": "80000000-0000-4000-8000-000000000001",
                        "source_kind": "upload", "source_uri": None,
                        "representation_kind": "markdown",
                        "representation_media_type": "text/markdown",
                    }
                elif normalized.startswith("INSERT INTO gb_document_marks"):
                    self.current = None
                elif normalized.startswith("SELECT mark.id, mark.creation_request_hash"):
                    self.current = {
                        "id": MARK_ID, "creation_request_hash": request_hash,
                        "revision_id": MARK_REVISION_ID,
                    }
                elif normalized.startswith("SELECT mark.id") and "JOIN gb_document_mark_revisions" in normalized:
                    self.current = {
                        "id": MARK_ID, "document_revision_id": REVISION_ID,
                        "anchor_id": ANCHOR_ID, "kind": "note", "current_version": 1,
                        "current_revision_id": MARK_REVISION_ID,
                        "current_content_hash": "d" * 64,
                        "body_markdown": "Original", "color": "#6d7a68",
                        "semantic_role": "note", "tags": ["vortex"], "state": "active",
                        "created_by_principal_id": PRINCIPAL_ID,
                        "created_at": "2026-09-23T00:00:00Z",
                        "updated_at": "2026-09-23T00:00:00Z",
                        "representation_sha256": REPRESENTATION_SHA,
                    }
                else:
                    self.current = None

        cursor = CreateReplayCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_document_mark(
                REVISION_ID, ANCHOR_ID, request(create), self.identity,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["revision_id"], MARK_REVISION_ID)
        self.assertEqual(result["body_markdown"], "Original")

    async def test_update_rechecks_idempotency_after_lock_for_simultaneous_retry(self):
        payload = {
            "expected_version": 1, "body_markdown": "Acknowledged",
            "idempotency_key": "reader-mark-race-1",
        }
        request_hash = document_mark_request_hash("update", {
            "mark_id": MARK_ID,
            "expected_version": 1,
            "patch": {"body_markdown": "Acknowledged"},
        })

        class RaceCursor(Cursor):
            def __init__(self):
                super().__init__()
                self.replay_checks = 0

            def execute(self, statement, parameters=None):
                normalized = " ".join(statement.split())
                if normalized.startswith("SELECT id, mark_id, request_hash"):
                    self.executions.append((normalized, parameters))
                    self.replay_checks += 1
                    self.current = None if self.replay_checks == 1 else {
                        "id": MARK_REVISION_ID,
                        "mark_id": MARK_ID,
                        "request_hash": request_hash,
                    }
                    self.rows = []
                    return
                if normalized.startswith("SELECT id, document_revision_id"):
                    self.executions.append((normalized, parameters))
                    self.current = {
                        "id": MARK_ID, "document_revision_id": REVISION_ID,
                        "anchor_id": ANCHOR_ID, "kind": "note", "current_version": 2,
                        "body_markdown": "Acknowledged", "color": "#6d7a68",
                        "semantic_role": "note", "tags": ["vortex"], "state": "active",
                    }
                    self.rows = []
                    return
                if normalized.startswith("SELECT mark.id") and "JOIN gb_document_mark_revisions" in normalized:
                    self.executions.append((normalized, parameters))
                    self.current = {
                        "id": MARK_ID, "document_revision_id": REVISION_ID,
                        "anchor_id": ANCHOR_ID, "kind": "note", "current_version": 2,
                        "current_revision_id": MARK_REVISION_ID,
                        "current_content_hash": "f" * 64,
                        "body_markdown": "Acknowledged", "color": "#6d7a68",
                        "semantic_role": "note", "tags": ["vortex"], "state": "active",
                        "created_by_principal_id": PRINCIPAL_ID,
                        "created_at": "2026-09-23T00:00:00Z",
                        "updated_at": "2026-09-23T00:01:00Z",
                        "representation_sha256": REPRESENTATION_SHA,
                    }
                    self.rows = []
                    return
                super().execute(statement, parameters)

        cursor = RaceCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        updater = IdentityContext(TENANT_ID, UPDATER_PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await update_document_mark(
                REVISION_ID, MARK_ID, request(payload, method="PATCH"), updater,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["body_markdown"], "Acknowledged")
        statements = [statement for statement, _ in cursor.executions]
        self.assertEqual(sum(value.startswith("SELECT id, mark_id, request_hash") for value in statements), 2)
        lock_index = next(index for index, value in enumerate(statements) if "FOR UPDATE" in value)
        second_replay_index = max(
            index for index, value in enumerate(statements)
            if value.startswith("SELECT id, mark_id, request_hash")
        )
        self.assertGreater(second_replay_index, lock_index)
        self.assertFalse(any(value.startswith("INSERT INTO gb_document_mark_revisions") for value in statements))

    async def test_replay_after_later_edit_returns_original_acknowledged_revision(self):
        payload = {
            "expected_version": 1, "body_markdown": "Original acknowledgement",
            "idempotency_key": "reader-mark-replay-1",
        }
        request_hash = document_mark_request_hash("update", {
            "mark_id": MARK_ID,
            "expected_version": 1,
            "patch": {"body_markdown": "Original acknowledgement"},
        })

        class HistoricalReplayCursor(Cursor):
            def execute(self, statement, parameters=None):
                normalized = " ".join(statement.split())
                self.executions.append((normalized, parameters))
                self.rows = []
                if normalized.startswith("SELECT id, mark_id, request_hash"):
                    self.current = {
                        "id": MARK_REVISION_ID,
                        "mark_id": MARK_ID,
                        "request_hash": request_hash,
                    }
                elif normalized.startswith("SELECT mark.id") and "JOIN gb_document_mark_revisions" in normalized:
                    self.current = {
                        "id": MARK_ID, "document_revision_id": REVISION_ID,
                        "anchor_id": ANCHOR_ID, "kind": "note", "current_version": 2,
                        "current_revision_id": MARK_REVISION_ID,
                        "current_content_hash": "e" * 64,
                        "body_markdown": "Original acknowledgement", "color": "#6d7a68",
                        "semantic_role": "note", "tags": ["vortex"], "state": "active",
                        "created_by_principal_id": PRINCIPAL_ID,
                        "created_at": "2026-09-23T00:00:00Z",
                        "updated_at": "2026-09-23T00:01:00Z",
                        "representation_sha256": REPRESENTATION_SHA,
                    }
                else:
                    self.current = None

        cursor = HistoricalReplayCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        updater = IdentityContext(TENANT_ID, UPDATER_PRINCIPAL_ID, "human")
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await update_document_mark(
                REVISION_ID, MARK_ID, request(payload, method="PATCH"), updater,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["revision_id"], MARK_REVISION_ID)
        self.assertEqual(result["body_markdown"], "Original acknowledgement")
        self.assertEqual(result["created_by_principal_id"], PRINCIPAL_ID)
        revision_query = next(
            statement for statement, _ in cursor.executions
            if statement.startswith("SELECT mark.id")
        )
        self.assertIn("mark.created_by_principal_id", revision_query)
        self.assertFalse(any("FOR UPDATE" in statement for statement, _ in cursor.executions))

    def test_representation_content_is_exact_hash_bound_and_range_capable(self):
        content = b"%PDF-1.7\nprivate research"
        content_hash = hashlib.sha256(content).hexdigest()

        class ContentCursor:
            def execute(self, _statement, _parameters=None):
                self.current = {
                    "kind": "original", "media_type": "application/pdf",
                    "content_sha256": content_hash,
                    "artifact_id": "90000000-0000-4000-8000-000000000001",
                    "content_json_text": None, "content_bytes": None,
                    "artifact_bytes": content, "display_filename": "Exact Paper.pdf",
                }

            def fetchone(self):
                return self.current

        with patch("server.get_conn", return_value=Connection(ContentCursor())):
            response = read_document_representation_content(
                REVISION_ID, REPRESENTATION_ID,
                request({}, method="GET", headers={"range": "bytes=0-7"}), self.identity,
            )
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.body, content[:8])
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertEqual(response.headers["etag"], f'"sha256-{content_hash}"')
        self.assertEqual(response.headers["x-content-sha256"], content_hash)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertTrue(response.headers["content-disposition"].startswith("attachment;"))
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["content-security-policy"], "sandbox; default-src 'none'")

    def test_representation_content_can_bind_revision_uuid_to_canonical_document_revision(self):
        content = b'{"schemaId":"gb.ink-document.v1"}'
        content_hash = hashlib.sha256(content).hexdigest()
        revision_hash = "d" * 64

        class BoundContentCursor:
            def execute(self, statement, parameters=None):
                self.statement = " ".join(statement.split())
                self.parameters = parameters
                bound = parameters == (
                    TENANT_ID, REVISION_ID, REPRESENTATION_ID, DOCUMENT_ID, revision_hash,
                )
                self.current = {
                    "kind": "original", "media_type": "application/json",
                    "content_sha256": content_hash,
                    "artifact_id": "90000000-0000-4000-8000-000000000001",
                    "content_json_text": None, "content_bytes": None,
                    "artifact_bytes": content, "display_filename": "Ink.json",
                } if bound else None

            def fetchone(self):
                return self.current

        cursor = BoundContentCursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = read_document_representation_content(
                REVISION_ID, REPRESENTATION_ID, request({}, method="GET"), self.identity,
                document_id=DOCUMENT_ID, revision_sha256=revision_hash,
            )
        self.assertEqual(response.body, content)
        self.assertIn("revision.document_id = %s", cursor.statement)
        self.assertIn("revision.revision_sha256 = %s", cursor.statement)
        self.assertEqual(cursor.parameters[-2:], (DOCUMENT_ID, revision_hash))

        mismatches = (
            (REVISION_ID, REPRESENTATION_ID, "30000000-0000-4000-8000-000000000099"),
            ("40000000-0000-4000-8000-000000000099", REPRESENTATION_ID, DOCUMENT_ID),
            (REVISION_ID, "50000000-0000-4000-8000-000000000099", DOCUMENT_ID),
        )
        for wrong_revision, wrong_representation, wrong_document in mismatches:
            with self.subTest(
                revision=wrong_revision,
                representation=wrong_representation,
                document=wrong_document,
            ), patch("server.get_conn", return_value=Connection(BoundContentCursor())):
                with self.assertRaises(HTTPException) as caught:
                    read_document_representation_content(
                        wrong_revision, wrong_representation, request({}, method="GET"), self.identity,
                        document_id=wrong_document, revision_sha256=revision_hash,
                    )
                self.assertEqual(caught.exception.status_code, 404)

    def test_exact_revision_metadata_is_tenant_scoped_and_contains_no_bytes(self):
        class RevisionCursor:
            def __init__(self, missing=False):
                self.missing = missing
                self.current = None
                self.rows = []
                self.executions = []

            def execute(self, statement, parameters=None):
                normalized = " ".join(statement.split())
                self.executions.append((normalized, parameters))
                if normalized.startswith("SELECT revision.id"):
                    self.current = None if self.missing else {
                        "revision_id": REVISION_ID,
                        "document_id": "30000000-0000-4000-8000-000000000001",
                        "version": 1, "revision_sha256": "d" * 64,
                        "title": "Exact paper", "display_filename": "Exact paper.pdf",
                        "original_artifact_id": "90000000-0000-4000-8000-000000000001",
                        "source_id": "80000000-0000-4000-8000-000000000001",
                        "created_at": "2026-09-23T00:00:00Z",
                        "artifact_sha256": "e" * 64, "artifact_byte_size": 42,
                        "artifact_media_type": "application/pdf", "source_kind": "upload",
                        "source_uri": None, "original_filename": "random.pdf",
                    }
                    self.rows = []
                elif normalized.startswith("SELECT id, kind"):
                    self.current = None
                    self.rows = [{
                        "id": REPRESENTATION_ID, "kind": "original",
                        "media_type": "application/pdf", "content_sha256": "e" * 64,
                        "created_at": "2026-09-23T00:00:00Z",
                    }]

            def fetchone(self):
                return self.current

            def fetchall(self):
                return self.rows

        cursor = RevisionCursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = get_document_revision(REVISION_ID, self.identity)
        self.assertEqual(result["revision_id"], REVISION_ID)
        self.assertEqual(result["representations"][0]["content_sha256"], "e" * 64)
        self.assertNotIn("content", result["representations"][0])
        self.assertEqual(cursor.executions[0][1], (TENANT_ID, REVISION_ID))
        with patch("server.get_conn", return_value=Connection(RevisionCursor(missing=True))):
            with self.assertRaises(HTTPException) as caught:
                get_document_revision(REVISION_ID, self.identity)
        self.assertEqual(caught.exception.status_code, 404)

    def test_exact_raster_revision_exposes_only_its_trusted_manifest_and_representation_metadata(self):
        manifest = {
            "schemaId": "gb.raster-image.v1",
            "format": "png",
            "mediaType": "image/png",
            "width": 7,
            "height": 5,
            "channels": 4,
            "frameCount": 1,
            "byteSize": 42,
            "contentSha256": "e" * 64,
        }

        class RasterRevisionCursor:
            def __init__(self):
                self.current = None
                self.rows = []

            def execute(self, statement, parameters=None):
                normalized = " ".join(statement.split())
                if normalized.startswith("SELECT revision.id"):
                    self.current = {
                        "revision_id": REVISION_ID,
                        "document_id": "30000000-0000-4000-8000-000000000001",
                        "version": 1,
                        "revision_sha256": "d" * 64,
                        "title": "Exact image",
                        "display_filename": "Exact image [eeeeeeeeeeee].png",
                        "original_artifact_id": "90000000-0000-4000-8000-000000000001",
                        "source_id": "80000000-0000-4000-8000-000000000001",
                        "created_at": "2026-09-23T00:00:00Z",
                        "artifact_sha256": "e" * 64,
                        "artifact_byte_size": 42,
                        "artifact_media_type": "image/png",
                        "source_kind": "upload",
                        "source_uri": None,
                        "original_filename": "random.png",
                        "source_metadata": {"arxivId": None, "rasterImage": manifest},
                    }
                    self.rows = []
                elif normalized.startswith("SELECT id, kind"):
                    self.current = None
                    self.rows = [{
                        "id": REPRESENTATION_ID,
                        "kind": "original",
                        "media_type": "image/png",
                        "content_sha256": "e" * 64,
                        "created_at": "2026-09-23T00:00:00Z",
                    }]

            def fetchone(self):
                return self.current

            def fetchall(self):
                return self.rows

        with patch("server.get_conn", return_value=Connection(RasterRevisionCursor())):
            result = get_document_revision(REVISION_ID, self.identity)
        self.assertEqual(result["raster_image"], manifest)
        self.assertNotIn("content", result)
        self.assertNotIn("content_bytes", str(result))

    def test_pinned_mark_revisions_remain_authorizable_after_later_edits(self):
        historical_hash = "f" * 64

        class ReferentCursor:
            def execute(self, statement, parameters=None):
                self.statement = " ".join(statement.split())
                self.parameters = parameters
                self.current = {"content_hash": historical_hash}

            def fetchone(self):
                return self.current

        cursor = ReferentCursor()
        reference = (
            "gb:object:v1:document.mark:"
            f"{MARK_ID}:pinned:sha256%3A{historical_hash}"
        )
        access = _authorize_local_referent(
            cursor, parse_canonical_reference(reference), self.identity,
        )
        self.assertIsNotNone(access)
        self.assertIn("JOIN gb_document_mark_revisions", cursor.statement)
        self.assertEqual(cursor.parameters, (TENANT_ID, MARK_ID, historical_hash))


if __name__ == "__main__":
    unittest.main()
