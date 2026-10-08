import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from server import (
    ExperimentAttachmentCreate,
    ExperimentUpdate,
    IdentityContext,
    create_experiment_attachment,
    update_experiment,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "30000000-0000-4000-8000-000000000001"
REVISION_ID = "40000000-0000-4000-8000-000000000001"
DIGEST = "a" * 64
ARTIFACT_DIGEST = "b" * 64
REF = f"gb:object:v1:document:{DOCUMENT_ID}:pinned:sha256%3A{DIGEST}"


class Cursor:
    def __init__(self, *, prior_hash=None, count=0, request_count=0, same_revision=False):
        self.prior_hash = prior_hash
        self.count = count
        self.request_count = request_count
        self.same_revision = same_revision
        self.next_row = None
        self.rows = []
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(str(query).split())
        self.queries.append((normalized, params))
        self.rows = []
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif normalized.startswith("SELECT id FROM gb_experiments"):
            self.next_row = {"id": "experiment-1"}
        elif normalized.startswith("SELECT * FROM gb_experiments"):
            self.next_row = {"id": "experiment-1", "title": "After"}
        elif "UPDATE gb_experiments SET" in normalized:
            self.next_row = {"id": "experiment-1", "title": "After"}
        elif normalized.startswith("SELECT document.id AS document_id"):
            self.next_row = {"document_id": DOCUMENT_ID, "revision_id": REVISION_ID}
        elif normalized.startswith("SELECT request.attachment_id AS id"):
            self.next_row = ({
                "id": "50000000-0000-4000-8000-000000000001",
                "document_id": DOCUMENT_ID,
                "document_revision_id": REVISION_ID,
                "document_revision_sha256": DIGEST,
                "request_sha256": self.prior_hash,
            } if self.prior_hash else None)
        elif normalized.startswith("SELECT id FROM gb_experiment_attachments"):
            self.next_row = ({"id": "50000000-0000-4000-8000-000000000001"}
                             if self.same_revision else None)
        elif normalized.startswith("SELECT count(*) AS count"):
            self.next_row = {
                "count": self.request_count
                if "gb_experiment_attachment_requests" in normalized
                else self.count
            }
        elif normalized.startswith("INSERT INTO gb_experiment_attachments"):
            self.next_row = {"id": "50000000-0000-4000-8000-000000000001"}
        elif normalized.startswith("INSERT INTO gb_experiment_attachment_requests"):
            self.next_row = None
        elif normalized.startswith("SELECT attachment.id"):
            self.next_row = None
            self.rows = [{
                "id": "50000000-0000-4000-8000-000000000001",
                "document_id": DOCUMENT_ID,
                "document_revision_id": REVISION_ID,
                "document_revision_sha256": DIGEST,
                "created_at": "2026-09-25T00:00:00Z",
                "title": "Exact notes",
                "display_filename": "notes.md",
                "media_type": "text/markdown",
                "artifact_content_sha256": ARTIFACT_DIGEST,
            }]
        elif normalized.startswith("SELECT observation.id, observation.experiment_id"):
            self.next_row = None
            self.rows = []
        else:
            raise AssertionError(normalized)

    def fetchone(self):
        return self.next_row

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor): self._cursor = cursor
    def cursor(self): return self._cursor


class ExperimentAttachmentTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id=TENANT_ID, principal_id=PRINCIPAL_ID, principal_kind="human"
        )
        self.request = ExperimentAttachmentCreate(
            schemaId="gb.eln-attachment-create.v1", documentRef=REF
        )

    def invoke(self, cursor):
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_reference"
        ) as authorize:
            result = create_experiment_attachment(
                "experiment-1", self.request, "eln.attachment.operation-1", self.identity
            )
        authorize.assert_called_once_with(cursor, REF, self.identity)
        return result

    def test_create_locks_before_authorizing_and_returns_exact_receipt(self):
        cursor = Cursor()
        result = self.invoke(cursor)
        self.assertEqual(result["attachment"]["ref"], REF)
        self.assertEqual(result["attachment"]["documentRevisionId"], REVISION_ID)
        self.assertEqual(result["attachment"]["revisionSha256"], DIGEST)
        self.assertEqual(result["attachment"]["contentSha256"], ARTIFACT_DIGEST)
        self.assertFalse(result["replayed"])
        self.assertIn("FOR UPDATE", cursor.queries[1][0])
        self.assertEqual(cursor.queries[-1][0], "COMMIT")

    def test_same_key_different_request_is_conflict(self):
        cursor = Cursor(prior_hash="0" * 64)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_reference"
        ), self.assertRaises(HTTPException) as caught:
            create_experiment_attachment(
                "experiment-1", self.request, "eln.attachment.operation-1", self.identity
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(cursor.queries[-1][0], "ROLLBACK")

    def test_same_key_and_request_replays_the_original_row(self):
        first = self.invoke(Cursor())
        replay = self.invoke(Cursor(prior_hash=first["requestSha256"]))
        self.assertTrue(replay["replayed"])
        self.assertFalse(replay["deduplicated"])

    def test_new_key_for_the_same_exact_revision_deduplicates(self):
        cursor = Cursor(same_revision=True)
        result = self.invoke(cursor)
        self.assertFalse(result["replayed"])
        self.assertTrue(result["deduplicated"])
        receipt_queries = [
            (query, params) for query, params in cursor.queries
            if query.startswith("INSERT INTO gb_experiment_attachment_requests")
        ]
        self.assertEqual(len(receipt_queries), 1)
        self.assertEqual(receipt_queries[0][1][2], "eln.attachment.operation-1")
        self.assertEqual(receipt_queries[0][1][3], result["requestSha256"])

    def test_cap_is_checked_under_the_experiment_lock(self):
        cursor = Cursor(count=64)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_reference"
        ), self.assertRaises(HTTPException) as caught:
            create_experiment_attachment(
                "experiment-1", self.request, "eln.attachment.operation-1", self.identity
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, "Experiment attachment limit reached")

    def test_request_receipt_aliases_are_bounded_under_the_experiment_lock(self):
        cursor = Cursor(request_count=256, same_revision=True)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_reference"
        ), self.assertRaises(HTTPException) as caught:
            create_experiment_attachment(
                "experiment-1", self.request, "eln.attachment.operation-1", self.identity
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, "Experiment attachment request limit reached")
        self.assertEqual(cursor.queries[-1][0], "ROLLBACK")

    def test_patch_response_rehydrates_exact_attachment_descriptors(self):
        cursor = Cursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = update_experiment(
                "experiment-1", ExperimentUpdate(title="After"), self.identity
            )
        self.assertEqual(result["title"], "After")
        self.assertEqual(result["attachment_count"], 1)
        self.assertEqual(result["attachment_refs"][0]["revisionSha256"], DIGEST)
        self.assertEqual(result["attachment_refs"][0]["contentSha256"], ARTIFACT_DIGEST)

    def test_unpinned_wrong_kind_and_extra_fields_fail_closed(self):
        bad_refs = [
            f"gb:object:v1:document:{DOCUMENT_ID}:latest",
            f"gb:object:v1:paper:{DOCUMENT_ID}:pinned:sha256%3A{DIGEST}",
        ]
        for value in bad_refs:
            with self.assertRaises(HTTPException):
                create_experiment_attachment(
                    "experiment-1",
                    ExperimentAttachmentCreate(schemaId="gb.eln-attachment-create.v1", documentRef=value),
                    "eln.attachment.operation-1",
                    self.identity,
                )
        with self.assertRaises(ValidationError):
            ExperimentAttachmentCreate.model_validate({
                "schemaId": "gb.eln-attachment-create.v1", "documentRef": REF, "linked_papers": []
            })
        with self.assertRaises(ValidationError):
            ExperimentAttachmentCreate(
                schemaId="gb.eln-attachment-create.v1", documentRef="x" * 801
            )


if __name__ == "__main__":
    unittest.main()
