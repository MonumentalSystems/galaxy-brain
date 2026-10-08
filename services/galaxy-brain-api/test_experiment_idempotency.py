import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import ExperimentCreate, IdentityContext, create_experiment


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"


class ExperimentCursor:
    def __init__(self, *, receipt_created=True, matching_replay=True, deleted=False, fail=False):
        self.receipt_created = receipt_created
        self.matching_replay = matching_replay
        self.deleted = deleted
        self.fail = fail
        self.next_row = None
        self.request_hash = None
        self.experiment_id = "experiment-1"
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append((normalized, params))
        if self.fail and normalized not in {"BEGIN", "ROLLBACK"}:
            raise RuntimeError("postgres://secret-host/private-detail")
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
            return
        if normalized.startswith("INSERT INTO gb_experiment_creation_receipts"):
            self.request_hash = params[2]
            if self.receipt_created:
                self.experiment_id = params[3]
            self.next_row = (
                {"experiment_id": self.experiment_id, "request_sha256": self.request_hash}
                if self.receipt_created else None
            )
            return
        if normalized.startswith("SELECT experiment_id, request_sha256"):
            self.next_row = {
                "experiment_id": self.experiment_id,
                "request_sha256": self.request_hash if self.matching_replay else "0" * 64,
            }
            return
        if normalized.startswith("INSERT INTO gb_experiments"):
            self.next_row = {"id": params[0]}
            return
        if normalized.startswith("SELECT * FROM gb_experiments"):
            self.next_row = None if self.deleted else {"id": self.experiment_id, "tenant_id": TENANT_ID}
            return
        raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class ExperimentIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id=TENANT_ID,
            principal_id=PRINCIPAL_ID,
            principal_kind="human",
        )
        self.request = ExperimentCreate(title="Vortex trial", tags=["vortex"])

    def test_create_binds_the_tenant_key_and_request_hash(self):
        cursor = ExperimentCursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = create_experiment(self.request, "experiment-create-1", self.identity)

        self.assertEqual(result["id"], cursor.experiment_id)
        receipt_insert, receipt_params = cursor.queries[1]
        self.assertIn("INSERT INTO gb_experiment_creation_receipts", receipt_insert)
        self.assertIn("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING", receipt_insert)
        self.assertEqual(receipt_params[1], "experiment-create-1")
        self.assertRegex(receipt_params[2], r"^[0-9a-f]{64}$")
        experiment_insert, experiment_params = cursor.queries[2]
        self.assertIn("INSERT INTO gb_experiments", experiment_insert)
        self.assertEqual(experiment_params[0], receipt_params[3])
        self.assertEqual(cursor.queries[-1][0], "COMMIT")

    def test_matching_replay_returns_the_original_experiment(self):
        cursor = ExperimentCursor(receipt_created=False)
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = create_experiment(self.request, "experiment-create-1", self.identity)

        self.assertTrue(result["replayed"])
        self.assertEqual(result["id"], "experiment-1")
        select, params = cursor.queries[2]
        self.assertIn("FROM gb_experiment_creation_receipts", select)
        self.assertEqual(params, (TENANT_ID, "experiment-create-1"))
        self.assertNotIn("FOR UPDATE", select)
        self.assertFalse(any(query.startswith("INSERT INTO gb_experiments") for query, _ in cursor.queries))
        self.assertEqual(cursor.queries[-1][0], "COMMIT")

    def test_reused_key_with_different_input_is_a_conflict(self):
        cursor = ExperimentCursor(receipt_created=False, matching_replay=False)
        with patch("server.get_conn", return_value=Connection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            create_experiment(self.request, "experiment-create-1", self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, "Idempotency key was reused with different input")
        self.assertEqual(cursor.queries[-1][0], "ROLLBACK")

    def test_create_delete_retry_is_a_permanent_tombstone_not_a_new_identity(self):
        cursor = ExperimentCursor(receipt_created=False, deleted=True)
        with patch("server.get_conn", return_value=Connection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            create_experiment(self.request, "experiment-create-1", self.identity)

        self.assertEqual(caught.exception.status_code, 410)
        self.assertEqual(caught.exception.detail, "The experiment created by this request was deleted")
        self.assertFalse(any(query.startswith("INSERT INTO gb_experiments") for query, _ in cursor.queries))
        self.assertEqual(cursor.queries[-1][0], "ROLLBACK")

    def test_omitted_and_explicit_defaults_have_one_canonical_hash(self):
        first = ExperimentCursor()
        second = ExperimentCursor()
        with patch("server.get_conn", return_value=Connection(first)):
            create_experiment(ExperimentCreate(title="Trial"), "experiment-create-1", self.identity)
        with patch("server.get_conn", return_value=Connection(second)):
            create_experiment(
                ExperimentCreate(
                    title="Trial",
                    status="hypothesis",
                    hypothesis="",
                    protocol="",
                    config_snapshot={},
                    results="",
                    interpretation="",
                    conclusion="",
                    domain="general",
                    tags=[],
                    linked_experiments=[],
                ),
                "experiment-create-2",
                self.identity,
            )

        self.assertEqual(first.request_hash, second.request_hash)

    def test_legacy_linked_papers_is_output_only(self):
        with self.assertRaises(Exception):
            ExperimentCreate.model_validate({"title": "Trial", "linked_papers": ["https://example.test"]})

    def test_database_details_are_not_disclosed(self):
        cursor = ExperimentCursor(fail=True)
        with patch("server.get_conn", return_value=Connection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            create_experiment(self.request, "experiment-create-1", self.identity)

        self.assertEqual(caught.exception.status_code, 500)
        self.assertEqual(caught.exception.detail, "Unable to create experiment")
        self.assertNotIn("secret-host", caught.exception.detail)

    def test_invalid_key_is_rejected_before_database_access(self):
        with patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
            create_experiment(self.request, "short", self.identity)

        self.assertEqual(caught.exception.status_code, 422)
        get_conn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
