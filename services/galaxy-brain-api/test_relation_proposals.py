import hashlib
import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException, Request

from object_links import ObjectLinkError, ReferentAccess, parse_canonical_reference, validate_relation_proposal_payload
from server import IdentityContext, create_relation_proposal

TENANT = "30000000-0000-4000-8000-000000000001"
PRINCIPAL = "40000000-0000-4000-8000-000000000001"
SOURCE = "gb:object:v1:document:paper:pinned:sha256%3A" + "a" * 64
TARGET = "gb:object:v1:proof.node:lemma:pinned:sha256%3A" + "b" * 64

def payload():
    return {"fromRef": SOURCE, "toRef": TARGET, "relation": "corresponds_to", "rationale": "Same formal statement.", "idempotencyKey": "relation-proposal-1"}

def request(body, *, gateway=True):
    delivered = False
    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}
    headers = [(b"x-gb-agent-tool-gateway", b"v1")] if gateway else []
    return Request({"type": "http", "method": "POST", "path": "/relation-proposals", "query_string": b"", "headers": headers}, receive)

class Cursor:
    def __init__(self, responses):
        self.responses = list(responses); self.queries = []
    def execute(self, statement, parameters=None): self.queries.append((" ".join(statement.split()), parameters))
    def fetchone(self): return self.responses.pop(0)
class Connection:
    def __init__(self, cursor): self._cursor = cursor
    def cursor(self): return self._cursor

class RelationProposalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "agent")
        def allow(_cur, values, identity):
            return {value: ReferentAccess(value, identity.tenant_id, identity.principal_id, True, parse_canonical_reference(value).revision, "test") for value in values}
        self.auth = patch("server._authorize_object_references", side_effect=allow); self.auth.start()
    def tearDown(self): self.auth.stop()

    def test_contract_rejects_active_fields_unpinned_self_and_caps(self):
        self.assertEqual(validate_relation_proposal_payload(payload())["relation"], "corresponds_to")
        invalid = [
            {**payload(), "basis": "derived"}, {**payload(), "status": "active"},
            {**payload(), "toRef": SOURCE}, {**payload(), "relation": "supports"},
            {**payload(), "rationale": "é" * 2049},
            {**payload(), "idempotencyKey": "proposal/key"},
            {**payload(), "fromRef": "gb:object:v1:document:paper:latest"},
        ]
        for value in invalid:
            with self.assertRaises(ObjectLinkError): validate_relation_proposal_payload(value)

    async def test_insert_is_proposal_only_and_receipt_is_redacted(self):
        value = payload(); digest = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        row = {"id": "50000000-0000-4000-8000-000000000001", "from_ref": SOURCE, "to_ref": TARGET, "relation": "corresponds_to", "status": "pending", "request_sha256": digest, "created_at": datetime(2026, 9, 24, tzinfo=timezone.utc)}
        cursor = Cursor([row])
        @contextmanager
        def transaction(_conn): yield cursor
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_relation_proposal(request(json.dumps(value).encode()), self.identity)
        sql = " ".join(query for query, _ in cursor.queries)
        self.assertIn("INSERT INTO gb_object_link_proposals", sql)
        self.assertNotIn("INSERT INTO gb_object_links ", sql)
        self.assertEqual(cursor.queries[0][1][0], TENANT)
        self.assertEqual(result["status"], "pending")
        self.assertNotIn("rationale", result); self.assertNotIn("provenance", result)
        self.assertLessEqual(len(json.dumps(result).encode()), 8192)

    async def test_replay_and_collision_are_idempotent(self):
        value = payload(); digest = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        existing = {"id": "50000000-0000-4000-8000-000000000001", "from_ref": SOURCE, "to_ref": TARGET, "relation": "corresponds_to", "status": "pending", "request_sha256": digest, "created_at": datetime.now(timezone.utc)}
        for request_hash, expected in ((digest, True), ("f" * 64, False)):
            cursor = Cursor([None, {**existing, "request_sha256": request_hash}])
            @contextmanager
            def transaction(_conn): yield cursor
            with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
                if expected:
                    self.assertTrue((await create_relation_proposal(request(json.dumps(value).encode()), self.identity))["replayed"])
                else:
                    with self.assertRaises(HTTPException) as raised: await create_relation_proposal(request(json.dumps(value).encode()), self.identity)
                    self.assertEqual(raised.exception.status_code, 409)

    async def test_duplicate_fields_and_unreadable_fail_closed(self):
        duplicate = b'{"fromRef":"x","fromRef":"y"}'
        with self.assertRaises(HTTPException) as raised: await create_relation_proposal(request(duplicate), self.identity)
        self.assertEqual(raised.exception.status_code, 422)
        self.auth.stop(); self.auth = patch("server._authorize_object_references", return_value={SOURCE: None, TARGET: None}); self.auth.start()
        with patch("server.get_conn", return_value=Connection(Cursor([]))):
            with self.assertRaises(HTTPException) as denied: await create_relation_proposal(request(json.dumps(payload()).encode()), self.identity)
        self.assertEqual(denied.exception.status_code, 404)

    async def test_private_route_requires_the_agent_tool_gateway(self):
        with self.assertRaises(HTTPException) as hidden:
            await create_relation_proposal(
                request(json.dumps(payload()).encode(), gateway=False), self.identity,
            )
        self.assertEqual(hidden.exception.status_code, 404)

    async def test_only_agent_principals_can_create_agent_proposals(self):
        for kind in ("human", "service"):
            with self.assertRaises(HTTPException) as denied:
                await create_relation_proposal(
                    request(json.dumps(payload()).encode()),
                    IdentityContext(TENANT, PRINCIPAL, kind),
                )
            self.assertEqual(denied.exception.status_code, 403)

if __name__ == "__main__": unittest.main()
