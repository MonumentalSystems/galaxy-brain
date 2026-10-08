import hashlib
import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException, Request

from agent_result_contract import parse_agent_result_decision, terminal_task_reference
from server import IdentityContext, decide_paper_agent_result, get_paper_agent_result_review


TENANT = "30000000-0000-4000-8000-000000000001"
HUMAN = "40000000-0000-4000-8000-000000000001"
REVISION = "50000000-0000-4000-8000-000000000001"
ANCHOR = "anchor-1"
TASK = "task_42"
REPRESENTATION_SHA = "c" * 64
EVIDENCE = "gb:object:v1:document:source-1:pinned:sha256%3A" + "a" * 64
CANDIDATE_ID = "60000000-0000-4000-8000-000000000001"
DECISION_ID = "70000000-0000-4000-8000-000000000001"


def body(**updates):
    candidate = {
        "schemaId": "gb.paper-agent-result-candidate.v1",
        "taskId": TASK,
        "taskVersion": 7,
        "eventId": "91",
        "runId": "run_3",
        "performedByRef": "ham.agent:researcher",
        "occurredAt": "2026-10-03T16:17:18Z",
        "summary": "## Finding\n\nThe evidence supports the result.",
        "evidenceRefs": [EVIDENCE],
    }
    digest = hashlib.sha256(json.dumps(
        candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    result = {
        **candidate,
        "schemaId": "gb.paper-agent-result-decision.v1",
        "resultHash": f"sha256:{digest}",
        "action": "reject",
        "idempotencyKey": "agent-result-decision-42",
    }
    result.update(updates)
    return result


def request(payload):
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": encoded, "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": f"/documents/{REVISION}/anchors/{ANCHOR}/agent-results/{TASK}",
        "query_string": b"",
        "headers": [
            (b"x-gb-paper-agent-result-gateway", b"v1"),
            (b"x-gb-human-session", b"v1"),
        ],
    }, receive)


def get_request():
    return Request({
        "type": "http",
        "method": "GET",
        "path": f"/documents/{REVISION}/anchors/{ANCHOR}/agent-results/{TASK}",
        "query_string": b"",
        "headers": [(b"x-gb-paper-agent-result-gateway", b"v1")],
    })


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class RejectCursor:
    def __init__(self, normalized, *, colliding_candidate=None):
        self.normalized = normalized
        self.colliding_candidate = colliding_candidate
        self.next_one = None
        self.next_all = []
        self.queries = []

    def execute(self, statement, parameters=None):
        query = " ".join(statement.split())
        self.queries.append((query, parameters))
        self.next_one = None
        self.next_all = []
        if "SELECT anchor.representation_sha256" in query:
            self.next_one = {"representation_sha256": REPRESENTATION_SHA}
        elif "SELECT link.from_ref, link.to_ref, link.provenance" in query:
            self.next_all = [{
                "from_ref": "gb:object:v1:ham.task:task_42:latest",
                "to_ref": f"gb:object:v1:document.anchor:{ANCHOR}:pinned:sha256%3A{REPRESENTATION_SHA}",
                "provenance": {"source_ref": terminal_task_reference(TASK, 3)},
            }]
        elif "FROM gb_agent_result_candidates" in query and "idempotency_key" not in query:
            self.next_one = None
        elif "FROM gb_agent_result_candidates" in query and "idempotency_key" in query:
            self.next_one = self.colliding_candidate
        elif "INSERT INTO gb_agent_result_candidates" in query:
            self.next_one = {
                "id": CANDIDATE_ID,
                "anchor_ref": parameters[3],
                "created_task_ref": parameters[5],
                "terminal_task_ref": parameters[7],
                "terminal_task_version": parameters[6],
                "terminal_event_id": parameters[8],
                "occurred_at": parameters[9],
                "run_id": parameters[10],
                "performed_by_ref": parameters[11],
                "result_sha256": parameters[12],
                "summary_markdown": parameters[13],
                "evidence_refs": self.normalized["evidence_refs"],
                "request_sha256": parameters[-1],
            }
        elif "FROM gb_agent_result_decisions" in query:
            self.next_one = None
        elif "INSERT INTO gb_agent_result_decisions" in query:
            self.next_one = {
                "id": DECISION_ID,
                "decision": "rejected",
                "document_id": None,
                "document_revision_id": None,
                "document_revision_sha256": None,
                "request_sha256": parameters[-1],
            }

    def fetchone(self):
        return self.next_one

    def fetchall(self):
        return self.next_all


class AgentResultApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, HUMAN, "human")

    async def test_reject_persists_only_candidate_and_decision_and_returns_a_receipt(self):
        payload = body()
        normalized = parse_agent_result_decision(payload)
        cursor = RejectCursor(normalized)

        @contextmanager
        def transaction(_connection):
            yield cursor

        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._transaction", transaction),
            patch("server._authorize_object_references", side_effect=lambda _c, refs, _i: {ref: object() for ref in refs}),
            patch("server._persist_document_import") as persist_document,
            patch("server._persist_object_link") as persist_link,
        ):
            receipt = await decide_paper_agent_result(
                REVISION, ANCHOR, TASK, request(payload), self.identity,
            )

        sql = " ".join(query for query, _ in cursor.queries)
        self.assertIn("INSERT INTO gb_agent_result_candidates", sql)
        self.assertIn("INSERT INTO gb_agent_result_decisions", sql)
        persist_document.assert_not_called()
        persist_link.assert_not_called()
        self.assertEqual(receipt, {
            "schemaId": "gb.paper-agent-result-review.v1",
            "reviewState": "rejected",
            "taskVersion": 7,
            "eventId": "91",
            "resultHash": payload["resultHash"],
            "resultRef": None,
        })

    def test_get_returns_an_explicit_unreviewed_envelope_without_writing_a_candidate(self):
        payload = body()
        normalized = parse_agent_result_decision(payload)
        cursor = RejectCursor(normalized)
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = get_paper_agent_result_review(
                REVISION,
                ANCHOR,
                TASK,
                get_request(),
                "7",
                "91",
                payload["resultHash"],
                self.identity,
            )

        self.assertEqual(response, {
            "schemaId": "gb.paper-agent-result-review.v1",
            "reviewState": "unreviewed",
            "taskVersion": 7,
            "eventId": "91",
            "resultHash": payload["resultHash"],
            "resultRef": None,
        })
        self.assertNotIn("INSERT", " ".join(query for query, _ in cursor.queries))

    async def test_candidate_idempotency_collision_fails_before_any_materialization(self):
        payload = body()
        normalized = parse_agent_result_decision(payload)
        cursor = RejectCursor(normalized, colliding_candidate={
            "id": "80000000-0000-4000-8000-000000000001",
            "request_sha256": "d" * 64,
        })

        @contextmanager
        def transaction(_connection):
            yield cursor

        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._transaction", transaction),
            patch("server._authorize_object_references", side_effect=lambda _c, refs, _i: {ref: object() for ref in refs}),
            patch("server._persist_document_import") as persist_document,
            patch("server._persist_object_link") as persist_link,
        ):
            with self.assertRaises(HTTPException) as raised:
                await decide_paper_agent_result(
                    REVISION, ANCHOR, TASK, request(payload), self.identity,
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("Idempotency key", raised.exception.detail)
        persist_document.assert_not_called()
        persist_link.assert_not_called()
        self.assertNotIn(
            "INSERT INTO gb_agent_result_candidates",
            " ".join(query for query, _ in cursor.queries),
        )


if __name__ == "__main__":
    unittest.main()
