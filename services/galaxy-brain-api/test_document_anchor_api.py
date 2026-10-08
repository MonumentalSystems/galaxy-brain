import base64
import hashlib
import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException, Request

from document_anchors import create_document_anchor
from object_links import parse_canonical_reference
from server import (
    IdentityContext,
    _authorize_local_referent,
    _document_anchor_cursor,
    _document_anchor_representation,
    _parse_document_anchor_cursor,
    _read_document_anchor_json,
    create_document_anchor_record,
    get_document_anchor_by_id,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "30000000-0000-4000-8000-000000000001"
REVISION_ID = "40000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "50000000-0000-4000-8000-000000000001"
SOURCE_ID = "60000000-0000-4000-8000-000000000001"
CONTENT = "The exact evidence is here."
CONTENT_SHA = hashlib.sha256(CONTENT.encode()).hexdigest()
REVISION_SHA = "a" * 64


def raw_request(body):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http", "method": "POST", "path": f"/documents/{REVISION_ID}/anchors",
        "query_string": b"", "headers": [(b"content-type", b"application/json")],
    }, receive)


def request(value):
    return raw_request(json.dumps(value, separators=(",", ":")).encode())


class Cursor:
    def __init__(self, *, replay=False):
        self.current = None
        self.rows = []
        self.executions = []
        self.replay = replay
        self.anchor = create_document_anchor({**self.representation(), "content": CONTENT}, {
            "kind": "text-quote", "exact": "exact evidence",
        })

    @staticmethod
    def representation():
        return {
            "id": REPRESENTATION_ID, "kind": "markdown", "media_type": "text/markdown",
            "content_sha256": CONTENT_SHA, "artifact_id": None, "artifact_sha256": None,
            "content_json": None, "content_bytes": CONTENT.encode(),
            "document_revision_id": REVISION_ID, "document_id": DOCUMENT_ID,
            "document_revision_sha256": REVISION_SHA, "title": "Evidence",
            "display_filename": "Evidence.md", "source_id": SOURCE_ID,
            "source_kind": "upload", "source_uri": None,
        }

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        self.rows = []
        if normalized.startswith("SELECT representation.id"):
            self.current = self.representation()
        elif normalized.startswith("INSERT INTO gb_document_anchors"):
            self.current = None if self.replay else {"id": self.anchor["id"]}
        elif normalized.startswith("SELECT anchor.id"):
            self.current = {
                "id": self.anchor["id"], "document_revision_id": REVISION_ID,
                "representation_id": REPRESENTATION_ID, "representation_sha256": CONTENT_SHA,
                "selector_json": self.anchor["selector"], "selector_kind": "text-quote",
                "selector_sha256": self.anchor["selectorSha256"],
                "anchor_sha256": self.anchor["anchorSha256"], "created_at": "2026-09-23T00:00:00Z",
                "document_id": DOCUMENT_ID, "document_revision_sha256": REVISION_SHA,
                "title": "Evidence", "display_filename": "Evidence.md", "source_id": SOURCE_ID,
                "source_kind": "upload", "source_uri": None, "representation_kind": "markdown",
                "representation_media_type": "text/markdown",
            }
        elif normalized.startswith("SELECT id FROM gb_transform_receipts"):
            self.current = None
            self.rows = [{"id": "70000000-0000-4000-8000-000000000001"}]
        else:
            self.current = None

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class OriginalCursor(Cursor):
    @staticmethod
    def representation():
        return {
            "id": REPRESENTATION_ID, "kind": "original",
            "media_type": "text/x-python; charset=utf-8",
            "content_sha256": CONTENT_SHA,
            "artifact_id": "70000000-0000-4000-8000-000000000001",
            "artifact_sha256": CONTENT_SHA, "artifact_byte_size": len(CONTENT.encode()),
            "artifact_bytes": CONTENT.encode(),
            "content_json": None, "content_json_sha256": None, "content_bytes": None,
            "document_revision_id": REVISION_ID, "document_id": DOCUMENT_ID,
            "document_revision_sha256": REVISION_SHA, "title": "Evidence",
            "display_filename": "Evidence.py", "source_id": SOURCE_ID,
            "source_kind": "upload", "source_uri": None,
        }


class RepresentationCursor:
    def __init__(self, row):
        self.row = row
        self.executions = []

    def execute(self, statement, parameters=None):
        self.executions.append((" ".join(statement.split()), parameters))

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class DocumentAnchorApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")

    async def test_create_binds_exact_representation_and_returns_pinned_references(self):
        cursor = Cursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        payload = {"representation_id": REPRESENTATION_ID, "selector": {
            "kind": "text-quote", "exact": "exact evidence",
        }}
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_document_anchor_record(REVISION_ID, request(payload), self.identity)

        self.assertFalse(result["replayed"])
        self.assertEqual(result["id"], cursor.anchor["id"])
        self.assertEqual(result["representation_sha256"], CONTENT_SHA)
        self.assertIn("document.anchor", result["ref"])
        self.assertIn("sha256%3A", result["ref"])
        insert = next(item for item in cursor.executions if item[0].startswith("INSERT INTO gb_document_anchors"))
        self.assertIn("ON CONFLICT (tenant_id, id) DO NOTHING", insert[0])
        self.assertEqual(insert[1][0], cursor.anchor["id"])
        receipt_query = next(
            item for item in cursor.executions if item[0].startswith("SELECT id FROM gb_transform_receipts")
        )
        self.assertNotIn("identity_version", receipt_query[0])
        self.assertIn("jsonb_array_elements", receipt_query[0])
        self.assertEqual(receipt_query[1][-2:], (REPRESENTATION_ID, CONTENT_SHA))

    async def test_deterministic_replay_does_not_duplicate_anchor(self):
        cursor = Cursor(replay=True)

        @contextmanager
        def transaction(_connection):
            yield cursor

        payload = {"representation_id": REPRESENTATION_ID, "selector": {
            "kind": "text-quote", "exact": "exact evidence",
        }}
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_document_anchor_record(REVISION_ID, request(payload), self.identity)
        self.assertTrue(result["replayed"])

    async def test_create_text_quote_loads_and_binds_the_exact_original_artifact(self):
        cursor = OriginalCursor()

        @contextmanager
        def transaction(_connection):
            yield cursor

        payload = {"representation_id": REPRESENTATION_ID, "selector": {
            "kind": "text-quote", "exact": "exact evidence",
        }}
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_document_anchor_record(REVISION_ID, request(payload), self.identity)

        self.assertEqual(result["id"], cursor.anchor["id"])
        representation_query = next(
            item for item in cursor.executions if item[0].startswith("SELECT representation.id")
        )
        self.assertIn("CASE WHEN representation.kind = 'original'", representation_query[0])
        self.assertIn("artifact.byte_size <= 2097152", representation_query[0])
        self.assertIn("THEN artifact.content_bytes", representation_query[0])

    def test_textual_original_loader_bounds_hashes_and_strictly_decodes_artifact_bytes(self):
        base = OriginalCursor.representation()
        loaded = _document_anchor_representation(
            RepresentationCursor(base), self.identity, REVISION_ID, REPRESENTATION_ID,
        )
        self.assertEqual(loaded["content"], CONTENT)

        cases = (
            ({**base, "artifact_bytes": CONTENT.encode() + b"!"}, 409, "hash mismatch"),
            ({
                **base,
                "content_sha256": hashlib.sha256(b"\xff").hexdigest(),
                "artifact_sha256": hashlib.sha256(b"\xff").hexdigest(),
                "artifact_byte_size": 1,
                "artifact_bytes": b"\xff",
            }, 409, "invalid UTF-8"),
            ({
                **base,
                "content_sha256": hashlib.sha256(b"x" * (2 * 1024 * 1024 + 1)).hexdigest(),
                "artifact_sha256": hashlib.sha256(b"x" * (2 * 1024 * 1024 + 1)).hexdigest(),
                "artifact_byte_size": 2 * 1024 * 1024 + 1,
                "artifact_bytes": None,
            }, 422, "exceeds the anchor limit"),
        )
        for row, status, detail in cases:
            with self.subTest(detail=detail), self.assertRaises(HTTPException) as caught:
                _document_anchor_representation(
                    RepresentationCursor(row), self.identity, REVISION_ID, REPRESENTATION_ID,
                )
            self.assertEqual(caught.exception.status_code, status)
            self.assertIn(detail, caught.exception.detail)

        binary = _document_anchor_representation(
            RepresentationCursor({**base, "media_type": "application/pdf", "artifact_bytes": None}),
            self.identity, REVISION_ID, REPRESENTATION_ID,
        )
        self.assertIsNone(binary["content"])

    async def test_invalid_or_duplicate_request_fields_fail_closed(self):
        with self.assertRaises(HTTPException) as caught:
            await create_document_anchor_record(
                REVISION_ID,
                request({"representation_id": REPRESENTATION_ID, "selector": {}, "extra": True}),
                self.identity,
            )
        self.assertEqual(caught.exception.status_code, 422)

    async def test_request_envelope_accepts_a_valid_maximal_unicode_selector(self):
        exact = "😀" * 8_184
        parsed = await _read_document_anchor_json(request({
            "representation_id": REPRESENTATION_ID,
            "selector": {"kind": "text-quote", "exact": exact},
        }))
        self.assertEqual(parsed["selector"]["exact"], exact)

    async def test_deeply_nested_bounded_json_fails_as_422(self):
        body = (
            f'{{"representation_id":"{REPRESENTATION_ID}","selector":'.encode()
            + (b"[" * 10_000) + b"0" + (b"]" * 10_000) + b"}"
        )
        with self.assertRaises(HTTPException) as caught:
            await _read_document_anchor_json(raw_request(body))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail, "Document anchor body is not valid bounded JSON")

    def test_anchor_cursor_round_trips_and_rejects_tampering(self):
        anchor_id = f"sha256:{'b' * 64}"
        cursor = _document_anchor_cursor("2026-09-23T12:34:56Z", anchor_id, REVISION_ID)
        self.assertEqual(
            _parse_document_anchor_cursor(cursor, REVISION_ID),
            ("2026-09-23T12:34:56Z", anchor_id),
        )
        with self.assertRaises(HTTPException) as wrong_revision:
            _parse_document_anchor_cursor(cursor, DOCUMENT_ID)
        self.assertEqual(wrong_revision.exception.status_code, 422)
        for invalid in ("not-base64!", "e30", "W10"):
            with self.subTest(cursor=invalid), self.assertRaises(HTTPException) as caught:
                _parse_document_anchor_cursor(invalid, REVISION_ID)
            self.assertEqual(caught.exception.status_code, 422)

    def test_anchor_cursor_rejects_datetime_normalization_overflow(self):
        payload = json.dumps({
            "schema_id": "gb.anchor.cursor.v1",
            "document_revision_id": REVISION_ID,
            "created_at": "0001-01-01T00:00:00+23:59",
            "id": f"sha256:{'b' * 64}",
        }, separators=(",", ":")).encode()
        cursor = base64.urlsafe_b64encode(payload).decode().rstrip("=")
        with self.assertRaises(HTTPException) as caught:
            _parse_document_anchor_cursor(cursor, REVISION_ID)
        self.assertEqual(caught.exception.status_code, 422)

    def test_document_and_anchor_refs_are_locally_authorized(self):
        class AuthorizationCursor:
            def __init__(self):
                self.current = None

            def execute(self, statement, parameters=None):
                if "FROM gb_document_anchors AS anchor" in statement:
                    self.current = {"representation_sha256": CONTENT_SHA}
                elif "FROM gb_documents AS document" in statement:
                    self.current = {"revision_sha256": REVISION_SHA}
                else:
                    self.current = None

            def fetchone(self):
                return self.current

        cursor = AuthorizationCursor()
        document = parse_canonical_reference(
            f"gb:object:v1:document:{DOCUMENT_ID}:pinned:sha256%3A{REVISION_SHA}"
        )
        anchor_id = f"sha256:{'b' * 64}"
        anchor = parse_canonical_reference(
            f"gb:object:v1:document.anchor:sha256%3A{'b' * 64}:pinned:sha256%3A{CONTENT_SHA}"
        )
        self.assertEqual(
            _authorize_local_referent(cursor, document, self.identity).resolved_revision,
            f"sha256:{REVISION_SHA}",
        )
        self.assertEqual(anchor.identifier, anchor_id)
        self.assertEqual(
            _authorize_local_referent(cursor, anchor, self.identity).resolved_revision,
            f"sha256:{CONTENT_SHA}",
        )

    def test_canonical_anchor_locator_is_tenant_scoped_and_fails_closed(self):
        cursor = Cursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = get_document_anchor_by_id(cursor.anchor["id"], self.identity)
        self.assertEqual(result["id"], cursor.anchor["id"])
        anchor_query = next(
            item for item in cursor.executions if item[0].startswith("SELECT anchor.id")
        )
        self.assertEqual(anchor_query[1], (TENANT_ID, cursor.anchor["id"]))

        cursor = Cursor()
        cursor.anchor["id"] = f"sha256:{'f' * 64}"
        original_execute = cursor.execute

        def missing(statement, parameters=None):
            original_execute(statement, parameters)
            if "SELECT anchor.id" in " ".join(statement.split()):
                cursor.current = None

        cursor.execute = missing
        with patch("server.get_conn", return_value=Connection(cursor)):
            with self.assertRaises(HTTPException) as absent:
                get_document_anchor_by_id(cursor.anchor["id"], self.identity)
        self.assertEqual(absent.exception.status_code, 404)
        with self.assertRaises(HTTPException) as malformed:
            get_document_anchor_by_id("not-an-anchor", self.identity)
        self.assertEqual(malformed.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
