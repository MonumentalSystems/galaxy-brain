import json
import unittest
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi import HTTPException, Request

from graph_window import CLUSTER_SPECS, cluster_id, parse_request
from server import IdentityContext, _build_graph_window, read_graph_window


TENANT = "30000000-0000-4000-8000-000000000001"
PRINCIPAL = "40000000-0000-4000-8000-000000000001"
PROOF_FOCUS = f"gb:object:v1:proof.graph:winding-prototime:pinned:sha256%3A{'a' * 64}"


def request_value(**updates):
    body = {
        "schemaId": "gb.graph-window-request.v1",
        "workspaceId": "tenant-catalog",
        "mode": "mixed",
        "lens": "explore",
        "scale": "corpus",
        "viewport": None,
        "filters": {"kinds": [], "relations": []},
        "rootRef": None,
        "expandClusterId": None,
        "cursor": None,
    }
    body.update(updates)
    return parse_request(json.dumps(body).encode())


class Cursor:
    def __init__(self, member_rows=None, fail_count_table=None):
        self.queries = []
        self.member_rows = member_rows or []
        self.fail_count_table = fail_count_table

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.queries.append((normalized, parameters))
        if self.fail_count_table and "count(*) AS count" in normalized and self.fail_count_table in normalized:
            raise TimeoutError("bounded count timed out")

    def fetchone(self):
        statement = self.queries[-1][0]
        if "count(*) AS count" in statement:
            if "gb_documents" in statement:
                return {"count": 12}
            if "gb_papers" in statement:
                return {"count": 8}
            if "gb_experiments" in statement:
                return {"count": 5}
            if "gb_surfaces" in statement:
                return {"count": 2}
        return None

    def fetchall(self):
        return self.member_rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class GraphWindowApiTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human")

    def test_corpus_window_uses_constant_aggregate_queries_and_no_member_scan(self):
        cursor = Cursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = _build_graph_window(request_value(), self.identity)
        self.assertEqual([cluster["count"] for cluster in response["clusters"]], [12, 8, 5, 2])
        self.assertEqual(response["members"], [])
        self.assertEqual(response["edges"], [])
        count_queries = [statement for statement, _ in cursor.queries if "count(*) AS count" in statement]
        self.assertEqual(len(count_queries), 4)
        self.assertTrue(all(cluster["countStatus"] == "exact" for cluster in response["clusters"]))
        self.assertIn("SET LOCAL statement_timeout = '750ms'", [statement for statement, _ in cursor.queries])
        self.assertEqual(response["providers"][-1]["status"], "partial")

    def test_authorized_exact_focus_is_echoed_without_expanding_the_corpus(self):
        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._authorize_object_references", return_value={PROOF_FOCUS: {"authorized": True}}),
        ):
            response = _build_graph_window(request_value(rootRef=PROOF_FOCUS), self.identity)
        self.assertEqual(response["focus"], {"ref": PROOF_FOCUS})
        self.assertEqual(response["members"], [])
        self.assertEqual(response["edges"], [])

    def test_unauthorized_exact_focus_fails_closed_before_returning_aggregates(self):
        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._authorize_object_references", return_value={}),
        ):
            with self.assertRaises(HTTPException) as error:
                _build_graph_window(request_value(rootRef=PROOF_FOCUS), self.identity)
        self.assertEqual(error.exception.status_code, 404)

    def test_expansion_is_exact_pinned_bounded_and_replace_paged(self):
        now = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)
        rows = [{
            "id": f"50000000-0000-4000-8000-{index:012d}",
            "title": f"Document {index}",
            "updated_at": now - timedelta(seconds=index),
            "digest": f"{index:064x}",
        } for index in range(201)]
        cursor = Cursor(rows)
        document_cluster = cluster_id(CLUSTER_SPECS[0], TENANT)
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server.PROXY_TOKEN", "graph-window-test-secret"),
        ):
            response = _build_graph_window(
                request_value(expandClusterId=document_cluster), self.identity,
            )
        self.assertEqual(len(response["members"]), 200)
        self.assertTrue(all(":document:" in member["ref"] and ":pinned:" in member["ref"] for member in response["members"]))
        self.assertTrue(response["continuation"]["hasMore"])
        self.assertEqual(response["continuation"]["model"], "replace-page")
        member_query, parameters = next(
            (statement, values)
            for statement, values in cursor.queries
            if "LIMIT %s" in statement
        )
        self.assertIn("LIMIT %s", member_query)
        self.assertEqual(parameters[-1], 201)

    def test_one_slow_count_degrades_only_that_provider(self):
        cursor = Cursor(fail_count_table="gb_papers")
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = _build_graph_window(request_value(), self.identity)
        paper = next(cluster for cluster in response["clusters"] if cluster["kind"] == "paper")
        paper_provider = next(provider for provider in response["providers"] if provider["provider"] == "galaxy.paper")
        self.assertIsNone(paper["count"])
        self.assertEqual(paper["countStatus"], "unavailable")
        self.assertEqual(paper_provider["status"], "unavailable")
        self.assertTrue(any("ROLLBACK TO SAVEPOINT" in statement for statement, _ in cursor.queries))
        self.assertEqual(next(cluster for cluster in response["clusters"] if cluster["kind"] == "document")["count"], 12)

    def test_mutable_eln_cluster_is_deliberately_not_expandable(self):
        cursor = Cursor()
        experiment_cluster = cluster_id(CLUSTER_SPECS[2], TENANT)
        with patch("server.get_conn", return_value=Connection(cursor)):
            with self.assertRaisesRegex(Exception, "no immutable member page"):
                _build_graph_window(request_value(expandClusterId=experiment_cluster), self.identity)

    async def test_private_api_requires_the_dedicated_gateway_header(self):
        request = Request({
            "type": "http", "method": "POST", "path": "/graph/window",
            "query_string": b"", "headers": [],
        })
        with self.assertRaises(HTTPException) as error:
            await read_graph_window(request, self.identity)
        self.assertEqual(error.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
