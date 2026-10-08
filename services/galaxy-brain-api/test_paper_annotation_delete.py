import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import ClaimEvidenceCreate, IdentityContext, delete_paper_annotation, link_claim_evidence


PAPER_ID = "10000000-0000-4000-8000-000000000001"
ANNOTATION_ID = "50000000-0000-4000-8000-000000000001"
CLAIM_ID = "60000000-0000-4000-8000-000000000001"


class DeleteCursor:
    def __init__(self, outcome):
        self.outcome = outcome
        self.next_row = None
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif "FROM gb_papers WHERE id" in normalized:
            self.next_row = {"id": PAPER_ID}
        elif normalized.startswith("SELECT id FROM gb_paper_annotations"):
            self.next_row = {"id": ANNOTATION_ID} if self.outcome != "missing" else None
        elif normalized.startswith("SELECT EXISTS"):
            self.next_row = {"is_referenced": self.outcome == "referenced"}
        elif normalized.startswith("UPDATE gb_paper_annotations"):
            self.next_row = {"id": ANNOTATION_ID} if self.outcome == "deleted" else None
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class DeleteConnection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class EvidenceCursor:
    def __init__(self, existing=None):
        self.existing = existing
        self.next_row = None
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif "FROM gb_papers WHERE id" in normalized:
            self.next_row = {"id": PAPER_ID}
        elif normalized.startswith("SELECT 1 FROM gb_paper_claims"):
            self.next_row = {"exists": 1}
        elif normalized.startswith("INSERT INTO gb_claim_evidence_links"):
            self.next_row = None if self.existing else {
                "claim_id": CLAIM_ID,
                "annotation_id": ANNOTATION_ID,
                "relation": params[3],
            }
        elif normalized.startswith("SELECT * FROM gb_claim_evidence_links"):
            self.next_row = self.existing
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class PaperAnnotationDeleteTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="30000000-0000-4000-8000-000000000001",
            principal_id="40000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )

    def test_deletes_only_when_no_durable_reference_exists(self):
        cursor = DeleteCursor("deleted")
        with patch("server.get_conn", return_value=DeleteConnection(cursor)):
            result = delete_paper_annotation(PAPER_ID, ANNOTATION_ID, self.identity)
        self.assertEqual(result, {"deleted": ANNOTATION_ID})
        self.assertIn("FOR UPDATE", cursor.queries[2])
        reference_query = cursor.queries[3]
        for table in ("gb_paper_claims", "gb_claim_evidence_links", "gb_paper_task_links"):
            self.assertIn(table, reference_query)
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_rejects_deleting_a_referenced_annotation(self):
        cursor = DeleteCursor("referenced")
        with patch("server.get_conn", return_value=DeleteConnection(cursor)), self.assertRaises(HTTPException) as caught:
            delete_paper_annotation(PAPER_ID, ANNOTATION_ID, self.identity)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_missing_annotation_is_still_404(self):
        cursor = DeleteCursor("missing")
        with patch("server.get_conn", return_value=DeleteConnection(cursor)), self.assertRaises(HTTPException) as caught:
            delete_paper_annotation(PAPER_ID, ANNOTATION_ID, self.identity)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_evidence_link_locks_the_active_annotation_through_insert(self):
        cursor = EvidenceCursor()
        with patch("server.get_conn", return_value=DeleteConnection(cursor)):
            result = link_claim_evidence(
                PAPER_ID,
                CLAIM_ID,
                ClaimEvidenceCreate(annotation_id=ANNOTATION_ID, relation="supports"),
                self.identity,
            )
        self.assertEqual(result["annotation_id"], ANNOTATION_ID)
        lock_index = next(index for index, query in enumerate(cursor.queries) if "FOR UPDATE OF annotation" in query)
        insert_index = next(index for index, query in enumerate(cursor.queries) if query.startswith("INSERT INTO"))
        self.assertLess(lock_index, insert_index)
        self.assertIn("DO NOTHING", cursor.queries[insert_index])
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_evidence_relation_replays_without_rewriting_attribution(self):
        cursor = EvidenceCursor({
            "claim_id": CLAIM_ID,
            "annotation_id": ANNOTATION_ID,
            "relation": "supports",
            "created_by_principal_id": "original-author",
        })
        with patch("server.get_conn", return_value=DeleteConnection(cursor)):
            result = link_claim_evidence(
                PAPER_ID,
                CLAIM_ID,
                ClaimEvidenceCreate(annotation_id=ANNOTATION_ID, relation="supports"),
                self.identity,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["created_by_principal_id"], "original-author")
        self.assertFalse(any("DO UPDATE" in query for query in cursor.queries))

    def test_evidence_relation_rejects_an_attribution_erasing_change(self):
        cursor = EvidenceCursor({
            "claim_id": CLAIM_ID,
            "annotation_id": ANNOTATION_ID,
            "relation": "supports",
            "created_by_principal_id": "original-author",
        })
        with patch("server.get_conn", return_value=DeleteConnection(cursor)), self.assertRaises(HTTPException) as caught:
            link_claim_evidence(
                PAPER_ID,
                CLAIM_ID,
                ClaimEvidenceCreate(annotation_id=ANNOTATION_ID, relation="refutes"),
                self.identity,
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(cursor.queries[-1], "ROLLBACK")


if __name__ == "__main__":
    unittest.main()
