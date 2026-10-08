import hashlib
import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException, Request

from document_anchors import canonical_anchor_json, create_document_anchor
from server import (
    IdentityContext,
    _read_agent_anchor_create_json,
    create_agent_document_anchor,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "30000000-0000-4000-8000-000000000001"
REVISION_ID = "40000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "50000000-0000-4000-8000-000000000001"
SOURCE_ID = "60000000-0000-4000-8000-000000000001"
REVISION_SHA = "a" * 64
CONTENT = "The bounded evidence is here."
CONTENT_SHA = hashlib.sha256(CONTENT.encode()).hexdigest()
DOCUMENT_REF = (
    f"gb:object:v1:document:{DOCUMENT_ID}:pinned:sha256%3A{REVISION_SHA}"
)


def raw_request(body, *, gateway=True):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = [(b"content-type", b"application/json")]
    if gateway:
        headers.append((b"x-gb-agent-tool-gateway", b"v1"))
    return Request({
        "type": "http", "method": "POST", "path": "/agent-anchor-creations",
        "query_string": b"", "headers": headers,
    }, receive)


def payload(*, content_sha=CONTENT_SHA, key="anchor-operation-1"):
    return {
        "documentRef": DOCUMENT_REF,
        "representation": {"id": REPRESENTATION_ID, "contentSha256": content_sha},
        "selector": {"kind": "text-quote", "exact": "bounded evidence"},
        "idempotencyKey": key,
    }


def request(value, *, gateway=True):
    return raw_request(json.dumps(value, separators=(",", ":")).encode(), gateway=gateway)


class Cursor:
    def __init__(self, *, replay=False, reused=False, unreadable=False, anchor_collision=False):
        self.current = None
        self.executions = []
        self.replay = replay
        self.reused = reused
        self.unreadable = unreadable
        self.anchor_collision = anchor_collision
        self.anchor = create_document_anchor({**self.representation(), "content": CONTENT}, payload()["selector"])
        self.request_hash = hashlib.sha256(canonical_anchor_json({
            "schemaId": "gb.agent-anchor-create.v1",
            "documentRef": DOCUMENT_REF,
            "representation": {"id": REPRESENTATION_ID, "contentSha256": CONTENT_SHA},
            "selector": self.anchor["selector"],
        }).encode()).hexdigest()

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
        self.current = None
        if normalized.startswith("SELECT document.id AS document_id, revision.id"):
            self.current = None if self.unreadable else {
                "document_id": DOCUMENT_ID,
                "id": REVISION_ID,
                "revision_sha256": REVISION_SHA,
            }
        elif normalized.startswith("SELECT representation.id"):
            self.current = self.representation()
        elif normalized.startswith("INSERT INTO gb_document_anchors"):
            self.current = {"id": self.anchor["id"]}
        elif normalized.startswith("SELECT anchor.id"):
            self.current = {
                "id": self.anchor["id"], "document_revision_id": REVISION_ID,
                "representation_id": REPRESENTATION_ID, "representation_sha256": CONTENT_SHA,
                "selector_json": self.anchor["selector"], "selector_kind": "text-quote",
                "selector_sha256": (
                    "f" * 64 if self.anchor_collision else self.anchor["selectorSha256"]
                ),
                "anchor_sha256": self.anchor["anchorSha256"], "created_at": "2026-09-24T00:00:00Z",
                "document_id": DOCUMENT_ID, "document_revision_sha256": REVISION_SHA,
                "title": "Evidence", "display_filename": "Evidence.md", "source_id": SOURCE_ID,
                "source_kind": "upload", "source_uri": None, "representation_kind": "markdown",
                "representation_media_type": "text/markdown",
            }
        elif normalized.startswith("INSERT INTO gb_agent_anchor_requests"):
            self.current = None if self.replay or self.reused else {
                "id": "70000000-0000-4000-8000-000000000001",
            }
        elif normalized.startswith("SELECT request_hash"):
            self.current = {
                "request_hash": "f" * 64 if self.reused else self.request_hash,
                "document_ref": DOCUMENT_REF,
                "document_id": DOCUMENT_ID,
                "document_revision_id": REVISION_ID,
                "document_revision_sha256": REVISION_SHA,
                "representation_id": REPRESENTATION_ID,
                "representation_sha256": CONTENT_SHA,
                "anchor_id": self.anchor["id"],
            }

    def fetchone(self):
        return self.current


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class AgentAnchorCreateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "agent", "e" * 64)

    async def invoke(self, cursor, value=None):
        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ):
            return await create_agent_document_anchor(
                request(payload() if value is None else value), self.identity,
            )

    async def test_create_is_tenant_bound_and_returns_a_small_request_bound_receipt(self):
        cursor = Cursor()
        result = await self.invoke(cursor)
        self.assertEqual(result["schemaId"], "gb.anchor.create-receipt.v1")
        self.assertEqual(result["documentRef"], DOCUMENT_REF)
        self.assertEqual(result["anchorId"], cursor.anchor["id"])
        self.assertEqual(result["requestHash"], cursor.request_hash)
        self.assertFalse(result["replayed"])
        self.assertNotIn("documentRevisionId", result)
        self.assertLess(len(json.dumps(result).encode()), 8192)
        document_query = next(
            item for item in cursor.executions if item[0].startswith("SELECT document.id AS document_id, revision.id")
        )
        self.assertEqual(document_query[1], (TENANT_ID, DOCUMENT_ID, REVISION_SHA))
        representation_query = next(
            item for item in cursor.executions if item[0].startswith("SELECT representation.id")
        )
        self.assertEqual(representation_query[1], (TENANT_ID, REVISION_ID, REPRESENTATION_ID))
        request_insert = next(
            item for item in cursor.executions if item[0].startswith("INSERT INTO gb_agent_anchor_requests")
        )
        self.assertEqual(
            request_insert[1][4:7],
            (DOCUMENT_ID, REVISION_ID, REVISION_SHA),
        )

    async def test_exact_replay_and_idempotency_collision_are_distinct(self):
        replay = await self.invoke(Cursor(replay=True))
        self.assertTrue(replay["replayed"])
        with self.assertRaises(HTTPException) as reused:
            await self.invoke(Cursor(reused=True))
        self.assertEqual(reused.exception.status_code, 409)
        self.assertEqual(reused.exception.detail["code"], "idempotency_key_reused")

    async def test_unreadable_document_hash_mismatch_and_anchor_collision_fail_closed(self):
        with self.assertRaises(HTTPException) as unreadable:
            await self.invoke(Cursor(unreadable=True))
        self.assertEqual(unreadable.exception.status_code, 404)
        with self.assertRaises(HTTPException) as mismatch:
            await self.invoke(Cursor(), payload(content_sha="c" * 64))
        self.assertEqual(mismatch.exception.status_code, 404)
        with self.assertRaises(HTTPException) as collision:
            await self.invoke(Cursor(anchor_collision=True))
        self.assertEqual(collision.exception.status_code, 409)
        self.assertEqual(collision.exception.detail["code"], "anchor_hash_collision")

    async def test_private_gateway_header_and_stream_cap_are_enforced(self):
        with self.assertRaises(HTTPException) as hidden:
            await create_agent_document_anchor(request(payload(), gateway=False), self.identity)
        self.assertEqual(hidden.exception.status_code, 404)
        with self.assertRaises(HTTPException) as oversized:
            await _read_agent_anchor_create_json(raw_request(b"x" * 65_537))
        self.assertEqual(oversized.exception.status_code, 413)

    async def test_duplicate_nested_fields_and_unpinned_document_are_rejected(self):
        duplicate = (
            f'{{"documentRef":"{DOCUMENT_REF}","representation":'
            f'{{"id":"{REPRESENTATION_ID}","id":"{REPRESENTATION_ID}",'
            f'"contentSha256":"{CONTENT_SHA}"}},"selector":'
            '{"kind":"text-quote","exact":"bounded evidence"},'
            '"idempotencyKey":"anchor-operation-1"}'
        ).encode()
        with self.assertRaises(HTTPException) as duplicate_error:
            await _read_agent_anchor_create_json(raw_request(duplicate))
        self.assertEqual(duplicate_error.exception.status_code, 422)
        value = payload()
        value["documentRef"] = f"gb:object:v1:document:{DOCUMENT_ID}:latest"
        with self.assertRaises(HTTPException) as unpinned:
            await self.invoke(Cursor(), value)
        self.assertEqual(unpinned.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
