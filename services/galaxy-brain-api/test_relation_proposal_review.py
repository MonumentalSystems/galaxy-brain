import hashlib
import json
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException, Request

from object_links import (
    ObjectLinkError,
    ReferentAccess,
    parse_canonical_reference,
    validate_relation_proposal_decision_payload,
    validate_relation_proposal_payload,
)
from server import (
    IdentityContext,
    _parse_relation_review_cursor,
    _relation_review_cursor,
    create_object_link,
    decide_relation_proposal,
    list_relation_proposals,
    retract_object_link,
)

TENANT = "30000000-0000-4000-8000-000000000001"
HUMAN = "40000000-0000-4000-8000-000000000001"
PROPOSAL = "50000000-0000-4000-8000-000000000001"
LINK = "60000000-0000-4000-8000-000000000001"
DECISION = "70000000-0000-4000-8000-000000000001"
SOURCE = "gb:object:v1:paper:paper-1:pinned:rev%3A1"
TARGET = "gb:object:v1:proof.node:graph%23lemma:pinned:sha256%3A" + "b" * 64
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)


def request(body=b"", *, gateway=True, human_session=False, path="/relation-proposals"):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = []
    if gateway:
        headers.append((b"x-gb-relation-review-gateway", b"v1"))
    if human_session:
        headers.append((b"x-gb-human-session", b"v1"))
    return Request({
        "type": "http", "method": "POST" if body else "GET", "path": path,
        "query_string": b"", "headers": headers,
    }, receive)


class Cursor:
    def __init__(self, responses=(), rows=()):
        self.responses = list(responses)
        self.rows = list(rows)
        self.queries = []

    def execute(self, statement, parameters=None):
        self.queries.append((" ".join(statement.split()), parameters))

    def fetchone(self):
        return self.responses.pop(0)

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


def proposal_row(**updates):
    return {
        "id": PROPOSAL, "from_ref": SOURCE, "to_ref": TARGET,
        "relation": "corresponds_to", "rationale": "Same formal statement.",
        "provenance": {"source": "agent-tool", "tool": "relations.propose"},
        "created_at": NOW, **updates,
    }


def decision_body(decision="accept", key="review-decision-1"):
    return {
        "decision": decision, "expected_version": 1,
        "reason": "Reviewed exact endpoints.", "idempotency_key": key,
    }


class RelationProposalReviewTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, HUMAN, "human")

        def allow(_cur, values, identity):
            return {
                value: ReferentAccess(
                    value, identity.tenant_id, identity.principal_id, True,
                    parse_canonical_reference(value).revision, "test",
                ) for value in values
            }

        self.authorization = patch("server._authorize_object_references", side_effect=allow)
        self.authorize_mock = self.authorization.start()

    def tearDown(self):
        self.authorization.stop()

    def test_new_proposals_require_exact_pins_but_legacy_decisions_can_reject(self):
        with self.assertRaisesRegex(ObjectLinkError, "exact pinned"):
            validate_relation_proposal_payload({
                "fromRef": "gb:object:v1:paper:paper-1:latest",
                "toRef": TARGET, "relation": "corresponds_to",
                "rationale": "Legacy follow-latest proposal.",
                "idempotencyKey": "proposal-latest-1",
            })
        self.assertEqual(
            validate_relation_proposal_decision_payload(decision_body("reject"))["decision"],
            "reject",
        )

    def test_bounded_queue_exposes_legacy_reject_only_rows_and_cursor_scope(self):
        rows = []
        for index in range(21):
            row = proposal_row(
                id=f"50000000-0000-4000-8000-{index + 1:012d}",
                created_at=NOW.replace(microsecond=index),
            )
            if index == 0:
                row["from_ref"] = "gb:object:v1:paper:legacy:latest"
            rows.append(row)
        cursor = Cursor(rows=rows)
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = list_relation_proposals(request(), 20, None, self.identity)
        self.assertEqual(len(result["items"]), 20)
        self.assertFalse(result["items"][0]["acceptEligible"])
        self.assertTrue(result["bounded"])
        self.assertIsNotNone(result["nextCursor"])
        self.assertLessEqual(len(self.authorize_mock.call_args.args[1]), 42)
        with self.assertRaises(HTTPException) as wrong_tenant:
            _parse_relation_review_cursor(
                result["nextCursor"],
                IdentityContext("30000000-0000-4000-8000-000000000002", HUMAN, "human"),
            )
        self.assertEqual(wrong_tenant.exception.status_code, 422)

    async def test_accept_transactionally_creates_authored_link_and_decision(self):
        link_row = {
            "id": LINK, "from_ref": SOURCE, "to_ref": TARGET,
            "relation": "corresponds_to", "basis": "authored",
            "provenance": {"source": "manual", "source_system": "galaxy.relation-review.v1"},
            "created_by_principal_id": HUMAN, "created_at": NOW,
        }
        decision_row = {
            "id": DECISION, "proposal_id": PROPOSAL, "decision_version": 2,
            "decision": "accepted", "object_link_id": LINK,
            "request_sha256": "a" * 64, "created_at": NOW,
        }
        body = decision_body()
        decision_row["request_sha256"] = hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":")).encode(),
        ).hexdigest()
        cursor = Cursor([proposal_row(), None, None, None, link_row, decision_row])

        @contextmanager
        def transaction(_conn):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await decide_relation_proposal(
                PROPOSAL,
                request(json.dumps(body).encode(), path=f"/relation-proposals/{PROPOSAL}/decisions"),
                self.identity,
            )
        sql = " ".join(statement for statement, _ in cursor.queries)
        self.assertIn("FOR UPDATE", sql)
        self.assertIn("INSERT INTO gb_object_links", sql)
        self.assertIn("INSERT INTO gb_object_link_proposal_decisions", sql)
        self.assertNotIn("proof.verify", sql)
        self.assertEqual(result["decision"], "accepted")
        self.assertEqual(result["objectLinkId"], LINK)

    async def test_reject_writes_only_the_append_only_decision(self):
        body = decision_body("reject")
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        decision_row = {
            "id": DECISION, "proposal_id": PROPOSAL, "decision_version": 2,
            "decision": "rejected", "object_link_id": None,
            "request_sha256": digest, "created_at": NOW,
        }
        cursor = Cursor([
            proposal_row(from_ref="gb:object:v1:paper:legacy:latest"),
            None, None, decision_row,
        ])

        @contextmanager
        def transaction(_conn):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await decide_relation_proposal(
                PROPOSAL, request(json.dumps(body).encode()), self.identity,
            )
        sql = " ".join(statement for statement, _ in cursor.queries)
        self.assertNotIn("INSERT INTO gb_object_links", sql)
        self.assertEqual(result["decision"], "rejected")
        self.assertIsNone(result["objectLinkId"])

    async def test_accept_reuses_an_existing_active_authored_tuple(self):
        body = decision_body()
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        decision_row = {
            "id": DECISION, "proposal_id": PROPOSAL, "decision_version": 2,
            "decision": "accepted", "object_link_id": LINK,
            "request_sha256": digest, "created_at": NOW,
        }
        cursor = Cursor([proposal_row(), None, None, {"id": LINK}, decision_row])

        @contextmanager
        def transaction(_conn):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await decide_relation_proposal(PROPOSAL, request(json.dumps(body).encode()), self.identity)
        sql = " ".join(statement for statement, _ in cursor.queries)
        self.assertIn("pg_advisory_xact_lock", sql)
        self.assertNotIn("INSERT INTO gb_object_links", sql)
        self.assertEqual(result["objectLinkId"], LINK)

    async def test_idempotency_insert_race_fetches_and_replays_exact_decision(self):
        body = decision_body("reject", "race-decision-1")
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        replay = {
            "id": DECISION, "proposal_id": PROPOSAL, "decision_version": 2,
            "decision": "rejected", "object_link_id": None,
            "request_sha256": digest, "created_at": NOW,
        }
        cursor = Cursor([proposal_row(), None, None, None, replay])

        @contextmanager
        def transaction(_conn):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await decide_relation_proposal(PROPOSAL, request(json.dumps(body).encode()), self.identity)
        self.assertTrue(result["replayed"])
        self.assertIn("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING", cursor.queries[-2][0])

    async def test_decision_replay_is_exact_and_cross_proposal_collision_fails(self):
        body = decision_body("reject")
        digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        replay = {
            "id": DECISION, "proposal_id": PROPOSAL, "decision_version": 2,
            "decision": "rejected", "object_link_id": None,
            "request_sha256": digest, "created_at": NOW,
        }
        for existing, status in (
            (replay, None),
            ({**replay, "proposal_id": "50000000-0000-4000-8000-000000000002"}, 409),
        ):
            cursor = Cursor([proposal_row(), existing])

            @contextmanager
            def transaction(_conn):
                yield cursor

            with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
                if status is None:
                    result = await decide_relation_proposal(PROPOSAL, request(json.dumps(body).encode()), self.identity)
                    self.assertTrue(result["replayed"])
                else:
                    with self.assertRaises(HTTPException) as raised:
                        await decide_relation_proposal(PROPOSAL, request(json.dumps(body).encode()), self.identity)
                    self.assertEqual(raised.exception.status_code, status)

    async def test_review_requires_private_gateway_and_human_identity(self):
        with self.assertRaises(HTTPException) as hidden:
            await decide_relation_proposal(PROPOSAL, request(b"{}", gateway=False), self.identity)
        self.assertEqual(hidden.exception.status_code, 404)
        for kind in ("agent", "service"):
            with self.assertRaises(HTTPException) as denied:
                await decide_relation_proposal(
                    PROPOSAL, request(b"{}"), IdentityContext(TENANT, HUMAN, kind),
                )
            self.assertEqual(denied.exception.status_code, 403)

    async def test_active_link_mutations_reject_non_session_callers(self):
        link_payload = {
            "from_ref": SOURCE, "to_ref": TARGET, "relation": "related",
            "basis": "authored",
            "provenance": {"source": "manual", "source_system": "galaxy"},
            "idempotency_key": "manual-link-1",
        }
        for kind in ("human", "agent", "service"):
            identity = IdentityContext(TENANT, HUMAN, kind)
            with self.assertRaises(HTTPException) as create_denied:
                await create_object_link(request(json.dumps(link_payload).encode(), gateway=False), identity)
            self.assertEqual(create_denied.exception.status_code, 403)
            with self.assertRaises(HTTPException) as retract_denied:
                await retract_object_link(LINK, request(json.dumps({
                    "expected_version": 1, "reason": "Wrong relation.",
                    "idempotency_key": "retract-link-1",
                }).encode(), gateway=False), identity)
            self.assertEqual(retract_denied.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
