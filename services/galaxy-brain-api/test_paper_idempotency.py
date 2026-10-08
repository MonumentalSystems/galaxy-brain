import unittest
from unittest.mock import patch
from uuid import UUID

from fastapi import HTTPException

from server import (
    IdentityContext,
    PaperAnnotationCreate,
    PaperClaimCreate,
    PaperTaskLinkCreate,
    create_paper_annotation,
    create_paper_claim,
    create_paper_task_link,
)


PAPER_ID = "10000000-0000-4000-8000-000000000001"
REVISION_ID = "20000000-0000-4000-8000-000000000001"
ANNOTATION_ID = "50000000-0000-4000-8000-000000000001"


class ConflictCursor:
    def __init__(self, table, matching):
        self.table = table
        self.matching = matching
        self.next_row = None
        self.request_hash = None
        self.insert_sql = ""
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif "FROM gb_papers WHERE id" in normalized:
            self.next_row = {"id": PAPER_ID}
        elif "SELECT 1 FROM gb_paper_revisions" in normalized:
            self.next_row = {"exists": 1}
        elif "SELECT 1 FROM gb_paper_annotations" in normalized:
            self.next_row = {"exists": 1}
        elif normalized.startswith(f"INSERT INTO {self.table}"):
            self.insert_sql = normalized
            self.request_hash = params[-1]
            self.next_row = None
        elif normalized.startswith(f"SELECT * FROM {self.table}"):
            self.next_row = {
                "id": "existing",
                "paper_id": PAPER_ID,
                "request_hash": self.request_hash if self.matching else "0" * 64,
            }
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class ConflictConnection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class TaskLinkConflictCursor:
    def __init__(self, matching):
        self.matching = matching
        self.next_row = None
        self.insert_sql = ""
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif "FROM gb_papers WHERE id" in normalized:
            self.next_row = {"id": PAPER_ID}
        elif "SELECT 1 FROM gb_paper_annotations" in normalized:
            self.next_row = {"exists": 1}
        elif normalized.startswith("INSERT INTO gb_paper_task_links"):
            self.insert_sql = normalized
            self.next_row = None
        elif normalized.startswith("SELECT * FROM gb_paper_task_links"):
            self.next_row = {
                "id": "existing-link",
                "paper_id": UUID(PAPER_ID),
                "annotation_id": UUID(ANNOTATION_ID) if self.matching else None,
                "claim_id": None,
                "ham_task_id": "ham-task-1",
                "parent_ham_task_id": "ham-parent-1",
                "relation": "subtask",
                "title_snapshot": "Audit evidence",
            }
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class PaperIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="30000000-0000-4000-8000-000000000001",
            principal_id="40000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )

    def annotation_request(self):
        return PaperAnnotationCreate(
            paper_revision_id=REVISION_ID,
            kind="highlight",
            page_number=1,
            anchor={"type": "text", "quote": "evidence", "startOffset": 0, "endOffset": 8},
            tags=["audit"],
            idempotency_key="annotation-key",
        )

    def test_annotation_conflict_replays_only_the_same_hashed_request(self):
        for matching in (True, False):
            cursor = ConflictCursor("gb_paper_annotations", matching)
            with self.subTest(matching=matching), patch(
                "server.get_conn", return_value=ConflictConnection(cursor)
            ):
                if matching:
                    result = create_paper_annotation(PAPER_ID, self.annotation_request(), self.identity)
                    self.assertTrue(result["replayed"])
                else:
                    with self.assertRaises(HTTPException) as caught:
                        create_paper_annotation(PAPER_ID, self.annotation_request(), self.identity)
                    self.assertEqual(caught.exception.status_code, 409)
                self.assertIn(
                    "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING",
                    cursor.insert_sql,
                )

    def test_claim_conflict_replays_only_the_same_hashed_request(self):
        request = PaperClaimCreate(
            source_annotation_id=ANNOTATION_ID,
            statement="A bounded claim",
            tags=["proof"],
            idempotency_key="claim-key",
        )
        for matching in (True, False):
            cursor = ConflictCursor("gb_paper_claims", matching)
            with self.subTest(matching=matching), patch(
                "server.get_conn", return_value=ConflictConnection(cursor)
            ):
                if matching:
                    result = create_paper_claim(PAPER_ID, request, self.identity)
                    self.assertTrue(result["replayed"])
                else:
                    with self.assertRaises(HTTPException) as caught:
                        create_paper_claim(PAPER_ID, request, self.identity)
                    self.assertEqual(caught.exception.status_code, 409)
                self.assertIn(
                    "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING",
                    cursor.insert_sql,
                )
                self.assertTrue(any("FOR UPDATE" in query for query in cursor.queries))

    def test_task_link_conflict_replays_only_the_same_evidence_coordinates(self):
        request = PaperTaskLinkCreate(
            ham_task_id="ham-task-1",
            parent_ham_task_id="ham-parent-1",
            relation="subtask",
            title_snapshot="Audit evidence",
            annotation_id=ANNOTATION_ID,
        )
        for matching in (True, False):
            cursor = TaskLinkConflictCursor(matching)
            with self.subTest(matching=matching), patch(
                "server.get_conn", return_value=ConflictConnection(cursor)
            ):
                if matching:
                    result = create_paper_task_link(PAPER_ID, request, self.identity)
                    self.assertTrue(result["replayed"])
                else:
                    with self.assertRaises(HTTPException) as caught:
                        create_paper_task_link(PAPER_ID, request, self.identity)
                    self.assertEqual(caught.exception.status_code, 409)
                self.assertIn(
                    "ON CONFLICT (tenant_id, ham_task_id) DO NOTHING",
                    cursor.insert_sql,
                )
                self.assertNotIn("DO UPDATE", cursor.insert_sql)
                self.assertTrue(any("FOR UPDATE" in query for query in cursor.queries))


if __name__ == "__main__":
    unittest.main()
