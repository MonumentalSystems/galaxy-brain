import unittest

import psycopg2
from fastapi import HTTPException
from unittest.mock import patch

from document_search import (
    DocumentSearchContractError,
    bounded_search_result_text,
    bounded_search_selector,
    normalize_document_search_limit,
    normalize_document_search_query,
    plain_search_snippet,
)
from server import IdentityContext, search_documents


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
DOCUMENT = "30000000-0000-4000-8000-000000000001"
REVISION = "40000000-0000-4000-8000-000000000001"
REPRESENTATION = "50000000-0000-4000-8000-000000000001"
REVISION_SHA = "a" * 64
REPRESENTATION_SHA = "b" * 64
CHUNK_SHA = "c" * 64
MANIFEST = "sha256:" + "d" * 64


class Cursor:
    def __init__(self, rows=None, *, timeout=False):
        self.rows = rows or []
        self.timeout = timeout
        self.executions = []

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if self.timeout and normalized.startswith("WITH required_chunker"):
            raise psycopg2.errors.QueryCanceled("statement timeout")

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


def hit(**changes):
    value = {
        "document_id": DOCUMENT,
        "document_revision_id": REVISION,
        "revision_sha256": REVISION_SHA,
        "title": "Vortex transport",
        "display_filename": "vortex.md",
        "headline": "A __GB_START__vortex__GB_STOP__ transports helicity.",
        "match_source": "content",
        "manifest_id": MANIFEST,
        "representation_id": REPRESENTATION,
        "representation_sha256": REPRESENTATION_SHA,
        "representation_kind": "markdown",
        "chunk_content_sha256": CHUNK_SHA,
        "selector_json": {
            "kind": "text-position", "unit": "unicode-code-point",
            "start": 20, "end": 60, "overlap": 0,
        },
    }
    value.update(changes)
    return value


class DocumentSearchContractTests(unittest.TestCase):
    def test_query_and_limit_bounds_are_strict(self):
        self.assertEqual(normalize_document_search_query("  vortex   helicity  "), "vortex   helicity")
        self.assertEqual(normalize_document_search_query("é" * 500), "é" * 500)
        for value in ("", " ", "x" * 501, "vortex\nhelicity"):
            with self.subTest(value=value[:20]), self.assertRaises(DocumentSearchContractError):
                normalize_document_search_query(value)
        for value in (0, 21, True, "8"):
            with self.subTest(value=value), self.assertRaises(DocumentSearchContractError):
                normalize_document_search_limit(value)

    def test_snippets_and_selectors_are_bounded_plain_values(self):
        snippet = plain_search_snippet("A __GB_START__match__GB_STOP__ " + "x" * 400)
        self.assertNotIn("__GB_", snippet)
        self.assertLessEqual(len(snippet), 320)
        selector = {
            "kind": "text-position", "unit": "unicode-code-point",
            "start": 0, "end": 10, "overlap": 0,
        }
        self.assertEqual(bounded_search_selector(selector), selector)
        self.assertIsNone(bounded_search_selector(None))
        with self.assertRaises(DocumentSearchContractError):
            bounded_search_selector({"value": "x" * 2_000})
        self.assertEqual(
            bounded_search_result_text("paper.md", "filename", maximum_characters=512, maximum_bytes=2_048),
            "paper.md",
        )
        with self.assertRaises(DocumentSearchContractError):
            bounded_search_result_text(" paper.md", "filename", maximum_characters=512, maximum_bytes=2_048)


class DocumentSearchApiTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human")

    def test_search_is_tenant_scoped_current_complete_prioritized_and_deduped(self):
        cursor = Cursor([hit(), hit(document_id="30000000-0000-4000-8000-000000000002")])
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = search_documents(q="vortex", limit=1, identity=self.identity)

        self.assertEqual(response["schemaId"], "gb.document-corpus-search.v1")
        self.assertEqual(response["query"], "vortex")
        self.assertTrue(response["continuation"]["hasMore"])
        self.assertEqual(len(response["items"]), 1)
        item = response["items"][0]
        self.assertIn(":document:", item["documentRef"])
        self.assertIn(":pinned:sha256%3A", item["documentRef"])
        self.assertEqual(item["snippet"], "A vortex transports helicity.")
        self.assertEqual(item["source"]["chunkContentSha256"], CHUNK_SHA)
        self.assertNotIn("chunkId", item["source"])
        self.assertNotIn("textContent", item)

        statement, parameters = next(
            execution for execution in cursor.executions
            if execution[0].startswith("WITH required_chunker")
        )
        self.assertIn("chunk.tenant_id = %s", statement)
        self.assertEqual(parameters.count(TENANT), 1)
        self.assertIn("document.current_revision_id = revision.id", statement)
        self.assertIn("document.current_version = revision.version", statement)
        self.assertIn("document.deleted_at IS NULL", statement)
        self.assertIn("preferred_manifest.chunk_count = ( SELECT count(*)::integer", statement)
        self.assertIn("PARTITION BY candidate.document_id", statement)
        self.assertIn("required.config_sha256 = chunk.chunker_config_sha256", statement)
        self.assertIn("ORDER BY candidate.representation_priority", statement)
        self.assertIn("SELECT DISTINCT ON (document.id, representation.id)", statement)
        self.assertIn("JOIN LATERAL", statement)
        self.assertIn("ORDER BY preferred_required.priority", statement)
        self.assertIn("preferred.representation_id = candidate.representation_id", statement)
        self.assertEqual(parameters[-1], 2)
        self.assertIn("SET LOCAL statement_timeout = '2s'", [query for query, _ in cursor.executions])

    def test_indexed_content_candidates_precede_complete_manifest_validation(self):
        cursor = Cursor([hit()])
        with patch("server.get_conn", return_value=Connection(cursor)):
            response = search_documents(q="vortex", limit=8, identity=self.identity)

        statement, _ = next(
            execution for execution in cursor.executions
            if execution[0].startswith("WITH required_chunker")
        )
        candidate_start = statement.index("indexed_content_candidates AS MATERIALIZED")
        candidate_source = statement.index("FROM gb_document_chunks AS chunk", candidate_start)
        indexed_predicate = statement.index(
            "to_tsvector('simple'::regconfig, chunk.text_content) @@ search_query.value",
            candidate_source,
        )
        completeness_start = statement.index("complete_content_candidates AS", indexed_predicate)
        completeness_check = statement.index("preferred_manifest.chunk_count =", completeness_start)
        self.assertLess(candidate_start, candidate_source)
        self.assertLess(candidate_source, indexed_predicate)
        self.assertLess(indexed_predicate, completeness_start)
        self.assertLess(completeness_start, completeness_check)
        self.assertIn(
            "FROM indexed_content_candidates AS candidate JOIN LATERAL",
            statement[completeness_start:],
        )
        self.assertNotIn("eligible_manifests", statement)
        self.assertNotIn("title_matches", statement)
        self.assertEqual(response["items"][0]["matchSource"], "content")

    def test_invalid_inputs_fail_before_query(self):
        for query, limit in (("", 8), ("x", 0), ("x", 21)):
            with self.subTest(query=query, limit=limit), self.assertRaises(HTTPException) as caught:
                search_documents(q=query, limit=limit, identity=self.identity)
            self.assertEqual(caught.exception.status_code, 422)

    def test_statement_timeout_is_a_bounded_service_failure(self):
        cursor = Cursor(timeout=True)
        with patch("server.get_conn", return_value=Connection(cursor)):
            with self.assertRaises(HTTPException) as caught:
                search_documents(q="vortex", limit=8, identity=self.identity)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, "Document search timed out")
        self.assertIn("ROLLBACK", [query for query, _ in cursor.executions])


if __name__ == "__main__":
    unittest.main()
