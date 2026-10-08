import hashlib
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException, Request
from pydantic import ValidationError

from server import (
    ExperimentObservationCreate,
    IdentityContext,
    _observation_timestamp,
    create_experiment_observation,
)


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
EXPERIMENT_ID = "30000000-0000-4000-8000-000000000001"
OBSERVATION_ID = "40000000-0000-4000-8000-000000000001"
OPERATION_ID = "50000000-0000-4000-8000-000000000001"
KEY = f"eln-observation:{OPERATION_ID}"
OBSERVED_AT = "2026-09-28T16:30:00.000000Z"


class Cursor:
    def __init__(self, *, receipt=None, observation=True, count=0):
        self.receipt = receipt
        self.observation = observation
        self.count = count
        self.next_row = None
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(str(query).split())
        self.queries.append((normalized, params))
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif normalized.startswith("SELECT experiment_id, observation_id, request_sha256"):
            self.next_row = self.receipt
        elif normalized.startswith("SELECT id FROM gb_experiments"):
            self.next_row = {"id": EXPERIMENT_ID}
        elif normalized.startswith("SELECT count(*) AS count FROM gb_eln_observations"):
            self.next_row = {"count": self.count}
        elif normalized.startswith("INSERT INTO gb_eln_observation_create_receipts"):
            self.next_row = {"observation_id": OBSERVATION_ID}
        elif normalized.startswith("INSERT INTO gb_eln_observations"):
            self.next_row = None
        elif normalized.startswith("INSERT INTO gb_eln_observation_revisions"):
            self.next_row = None
        elif normalized.startswith("SELECT observation.id, observation.experiment_id"):
            self.next_row = ({
                "id": OBSERVATION_ID,
                "experiment_id": EXPERIMENT_ID,
                "created_by_principal_id": PRINCIPAL_ID,
                "created_at": "2026-09-28T16:30:01+00:00",
                "version": 1,
                "body": "Stable reading",
                "observed_at": "2026-09-28T16:30:00+00:00",
                "revision_sha256": hashlib.sha256(json.dumps({
                    "body": "Stable reading", "observedAt": OBSERVED_AT,
                }, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            } if self.observation else None)
        else:
            raise AssertionError(normalized)

    def fetchone(self):
        return self.next_row


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class ExperimentObservationTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id=TENANT_ID, principal_id=PRINCIPAL_ID, principal_kind="human",
        )
        self.request = ExperimentObservationCreate(
            schemaId="gb.eln-observation-create.v1",
            body="  Stable reading  ",
            observedAt=OBSERVED_AT,
        )
        self.browser_request = Request({
            "type": "http",
            "method": "POST",
            "path": f"/experiments/{EXPERIMENT_ID}/observations",
            "query_string": b"",
            "headers": [(b"x-gb-human-session", b"v1")],
        })

    def invoke(self, cursor, *, identity=None, request=None):
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server.uuid4", return_value=OBSERVATION_ID,
        ):
            return create_experiment_observation(
                EXPERIMENT_ID,
                self.request,
                request or self.browser_request,
                KEY,
                identity or self.identity,
            )

    def test_creation_locks_parent_before_cap_and_returns_exact_pinned_receipt(self):
        cursor = Cursor()
        result = self.invoke(cursor)
        self.assertEqual(result["schemaId"], "gb.eln-observation-create-receipt.v1")
        self.assertEqual(result["observation"]["body"], "Stable reading")
        self.assertEqual(result["observation"]["observedAt"], OBSERVED_AT)
        self.assertEqual(
            result["observation"]["ref"],
            f"gb:object:v1:eln.observation:{OBSERVATION_ID}:pinned:sha256%3A{result['observation']['revisionSha256']}",
        )
        self.assertFalse(result["replayed"])
        lock_index = next(index for index, item in enumerate(cursor.queries) if "FOR UPDATE" in item[0])
        cap_index = next(index for index, item in enumerate(cursor.queries) if "count(*)" in item[0])
        self.assertLess(lock_index, cap_index)

    def test_same_key_replays_and_deleted_identity_returns_tombstone_410(self):
        created = self.invoke(Cursor())
        receipt = {
            "experiment_id": EXPERIMENT_ID,
            "observation_id": OBSERVATION_ID,
            "request_sha256": created["requestSha256"],
        }
        replay = self.invoke(Cursor(receipt=receipt))
        self.assertTrue(replay["replayed"])
        with self.assertRaises(HTTPException) as caught:
            self.invoke(Cursor(receipt=receipt, observation=False))
        self.assertEqual(caught.exception.status_code, 410)

    def test_key_reuse_and_cap_fail_without_mutating(self):
        with self.assertRaises(HTTPException) as caught:
            self.invoke(Cursor(receipt={
                "experiment_id": EXPERIMENT_ID,
                "observation_id": OBSERVATION_ID,
                "request_sha256": "0" * 64,
            }))
        self.assertEqual(caught.exception.status_code, 409)
        with self.assertRaises(HTTPException) as caught:
            self.invoke(Cursor(count=256))
        self.assertEqual(caught.exception.status_code, 409)

    def test_schema_body_timestamp_and_operation_key_are_strict(self):
        with self.assertRaises(ValidationError):
            ExperimentObservationCreate.model_validate({
                "schemaId": "gb.eln-observation-create.v1", "body": "ok", "extra": True,
            })
        with self.assertRaises(ValidationError):
            ExperimentObservationCreate(schemaId="gb.eln-observation-create.v1", body=" ")
        with self.assertRaises(HTTPException):
            create_experiment_observation(
                EXPERIMENT_ID, self.request, self.browser_request,
                "observation:loose", self.identity,
            )

    def test_rfc3339_timestamp_normalization_is_strict_and_overflow_safe(self):
        normalized, wire = _observation_timestamp("2026-09-28T18:00:00.123456789+01:30")
        self.assertEqual(wire, "2026-09-28T16:30:00.123456Z")
        self.assertEqual(normalized.isoformat(), "2026-09-28T16:30:00.123456+00:00")
        for invalid in (
            "20260928T163000Z",
            "2026-W40-1T16:30:00Z",
            "2026-09-28 16:30:00Z",
            "2026-09-28T16:30Z",
            "2026-09-28T16:30:00",
            "2026-09-28T16:30:00z",
            "2026-02-30T16:30:00Z",
            "2026-09-28T24:00:00Z",
            "2026-09-28T16:30:60Z",
            "2026-09-28T16:30:00+24:00",
            "0001-01-01T00:00:00+14:00",
            "9999-12-31T23:59:59-12:00",
        ):
            with self.subTest(value=invalid), self.assertRaises(HTTPException) as caught:
                _observation_timestamp(invalid)
            self.assertEqual(caught.exception.status_code, 422)

    def test_creation_and_replay_require_human_browser_authority(self):
        missing_header = Request({
            "type": "http", "method": "POST", "path": "/", "query_string": b"", "headers": [],
        })
        for identity, request in (
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "agent"), self.browser_request),
            (IdentityContext(TENANT_ID, PRINCIPAL_ID, "service"), self.browser_request),
            (self.identity, missing_header),
        ):
            cursor = Cursor(receipt={
                "experiment_id": EXPERIMENT_ID,
                "observation_id": OBSERVATION_ID,
                "request_sha256": "0" * 64,
            })
            with self.subTest(kind=identity.principal_kind, headers=request.headers), self.assertRaises(HTTPException) as caught:
                self.invoke(cursor, identity=identity, request=request)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(cursor.queries, [])


if __name__ == "__main__":
    unittest.main()
