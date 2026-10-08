import unittest
from unittest.mock import patch

from server import IdentityContext, PaperImport, import_paper


class PaperImportCursor:
    def __init__(self, concurrent_replay=False):
        self.query = ""
        self.params = ()
        self.queries = []
        self.concurrent_replay = concurrent_replay

    def execute(self, query, params):
        self.query = " ".join(query.split())
        self.params = params
        self.queries.append((self.query, params))

    def fetchone(self):
        if self.query.startswith("SELECT id AS imported_revision_id"):
            return {
                "imported_revision_id": "40000000-0000-4000-8000-000000000001",
                "imported_revision_metadata_hash": self.params[-1],
                "imported_revision_arxiv_version": 1,
            }
        return {
            "id": "10000000-0000-4000-8000-000000000001",
            "arxiv_id": "2401.00001",
            "arxiv_version": 7,
            "title": "Current paper",
            "imported_revision_id": None if self.concurrent_replay else "40000000-0000-4000-8000-000000000001",
            "imported_revision_metadata_hash": None if self.concurrent_replay else "a" * 64,
            "imported_revision_arxiv_version": None if self.concurrent_replay else 1,
        }


class PaperImportConnection:
    def __init__(self, concurrent_replay=False):
        self.value = PaperImportCursor(concurrent_replay)

    def cursor(self):
        return self.value


class PaperImportTests(unittest.TestCase):
    def test_older_revision_is_inserted_without_rewinding_current_paper(self):
        metadata = {
            "arxiv_id": "2401.00001",
            "arxiv_version": 1,
            "title": "Original paper",
            "abstract": "First revision",
            "authors": [{"name": "Researcher"}],
            "categories": ["cs.AI"],
            "published_at": "2024-01-01T00:00:00Z",
            "source_updated_at": "2024-01-01T00:00:00Z",
            "abs_url": "https://arxiv.org/abs/2401.00001v1",
            "pdf_url": "https://arxiv.org/pdf/2401.00001v1",
            "doi": None,
            "journal_ref": None,
            "license_url": None,
        }
        connection = PaperImportConnection()
        identity = IdentityContext(
            tenant_id="20000000-0000-4000-8000-000000000001",
            principal_id="30000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )
        with patch("server.get_arxiv_paper", return_value=metadata), patch(
            "server.get_conn", return_value=connection
        ):
            result = import_paper(PaperImport(arxiv_id="2401.00001v1"), identity)

        self.assertEqual(result["arxiv_version"], 7)
        self.assertEqual(result["imported_revision_arxiv_version"], 1)
        self.assertEqual(result["imported_revision_metadata_hash"], "a" * 64)
        self.assertIn("paper AS", connection.value.query)
        self.assertIn("revision_insert AS", connection.value.query)
        self.assertIn("SELECT tenant_id, id, %s, %s, %s, %s FROM paper", connection.value.query)
        self.assertIn("revision.id AS imported_revision_id", connection.value.query)
        self.assertIn("LEFT JOIN revision ON revision.paper_id = paper.id", connection.value.query)
        self.assertEqual(connection.value.params[-5], 1)
        self.assertEqual(connection.value.params[-1], connection.value.params[-4])

    def test_concurrent_first_import_resolves_exact_receipt_in_new_statement(self):
        metadata = {
            "arxiv_id": "2401.00001",
            "arxiv_version": 1,
            "title": "Original paper",
            "abstract": "First revision",
            "authors": [{"name": "Researcher"}],
            "categories": ["cs.AI"],
            "published_at": "2024-01-01T00:00:00Z",
            "source_updated_at": "2024-01-01T00:00:00Z",
            "abs_url": "https://arxiv.org/abs/2401.00001v1",
            "pdf_url": "https://arxiv.org/pdf/2401.00001v1",
            "doi": None,
            "journal_ref": None,
            "license_url": None,
        }
        connection = PaperImportConnection(concurrent_replay=True)
        identity = IdentityContext(
            tenant_id="20000000-0000-4000-8000-000000000001",
            principal_id="30000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )
        with patch("server.get_arxiv_paper", return_value=metadata), patch(
            "server.get_conn", return_value=connection
        ):
            result = import_paper(PaperImport(arxiv_id="2401.00001v1"), identity)

        self.assertEqual(result["imported_revision_id"], "40000000-0000-4000-8000-000000000001")
        self.assertEqual(result["imported_revision_arxiv_version"], 1)
        self.assertEqual(len(connection.value.queries), 2)
        self.assertTrue(connection.value.queries[1][0].startswith("SELECT id AS imported_revision_id"))
        self.assertEqual(connection.value.queries[1][1][1], result["id"])


if __name__ == "__main__":
    unittest.main()
