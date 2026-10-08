import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import (
    IdentityContext,
    TaskPlanCreate,
    TaskPlanUpdate,
    create_task_plan,
    update_task_plan,
)
from test_task_plan_contract import valid_plan


class TaskPlanCreateCursor:
    def __init__(self, *, current_row=None, existing_matches=True, revision_row=None):
        self.current_row = current_row
        self.existing_matches = existing_matches
        self.revision_row = revision_row
        self.next_row = None
        self.request_hash = None
        self.idempotency_key = None
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif normalized.startswith("INSERT INTO gb_task_plans"):
            self.idempotency_key = params[-2]
            self.request_hash = params[-1]
            self.next_row = self.current_row
        elif normalized.startswith("SELECT * FROM gb_task_plans"):
            self.next_row = {
                "id": "30000000-0000-4000-8000-000000000001",
                "creation_idempotency_key": self.idempotency_key,
                "creation_request_hash": self.request_hash if self.existing_matches else "0" * 64,
            }
        elif normalized.startswith("INSERT INTO gb_task_plan_revisions"):
            self.next_row = self.revision_row
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class TaskPlanCreateConnection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class TaskPlanUpdateCursor:
    request_hash = "a" * 64

    def __init__(self, *, current_version, replay_after_lock, revision_conflict=False):
        self.current_version = current_version
        self.replay_after_lock = replay_after_lock
        self.revision_row = None if revision_conflict else {"id": "revision"}
        self.replay_lookups = 0
        self.next_row = None
        self.queries = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.next_row = None
        elif normalized.startswith("SELECT task_plan_id, request_hash FROM gb_task_plan_revisions"):
            self.replay_lookups += 1
            if self.replay_after_lock and self.replay_lookups == 2:
                self.next_row = {
                    "task_plan_id": "30000000-0000-4000-8000-000000000001",
                    "request_hash": self.request_hash,
                }
            else:
                self.next_row = None
        elif normalized.startswith("SELECT * FROM gb_task_plans"):
            self.next_row = {
                "id": "30000000-0000-4000-8000-000000000001",
                "current_version": self.current_version,
                "current_content_hash": "b" * 64,
                "ham_task_id": "task-42",
                "title": "Research plan",
            }
        elif normalized.startswith("UPDATE gb_task_plans"):
            self.next_row = {
                "id": "30000000-0000-4000-8000-000000000001",
                "current_version": self.current_version + 1,
            }
        elif normalized.startswith("INSERT INTO gb_task_plan_revisions"):
            self.next_row = self.revision_row
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row


class TaskPlanIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="10000000-0000-4000-8000-000000000001",
            principal_id="20000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )
        self.request = TaskPlanCreate(
            ham_task_id="task-42",
            title="Research plan",
            spec=valid_plan(),
            idempotency_key="task-plan-create-key",
        )

    def test_concurrent_create_conflict_replays_the_matching_request(self):
        cursor = TaskPlanCreateCursor(existing_matches=True)
        with patch("server.get_conn", return_value=TaskPlanCreateConnection(cursor)):
            result = create_task_plan(self.request, self.identity)

        self.assertTrue(result["replayed"])
        self.assertIn("ON CONFLICT DO NOTHING", cursor.queries[1])
        self.assertIn("FOR UPDATE", cursor.queries[2])
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_concurrent_create_conflict_rejects_different_input(self):
        cursor = TaskPlanCreateCursor(existing_matches=False)
        with patch("server.get_conn", return_value=TaskPlanCreateConnection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            create_task_plan(self.request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_revision_idempotency_collision_rolls_back_the_new_plan(self):
        cursor = TaskPlanCreateCursor(
            current_row={"id": "30000000-0000-4000-8000-000000000001"},
            revision_row=None,
        )
        with patch("server.get_conn", return_value=TaskPlanCreateConnection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            create_task_plan(self.request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("ON CONFLICT DO NOTHING", cursor.queries[2])
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_concurrent_update_retry_rechecks_replay_after_the_plan_lock(self):
        cursor = TaskPlanUpdateCursor(current_version=2, replay_after_lock=True)
        request = TaskPlanUpdate(
            base_version=1,
            spec=valid_plan(),
            idempotency_key="task-plan-update-key",
        )
        with patch("server.get_conn", return_value=TaskPlanCreateConnection(cursor)), patch(
            "server._surface_request_hash", return_value=cursor.request_hash
        ):
            result = update_task_plan(
                "30000000-0000-4000-8000-000000000001", request, self.identity
            )

        self.assertTrue(result["replayed"])
        self.assertEqual(cursor.replay_lookups, 2)
        self.assertFalse(any(query.startswith("UPDATE gb_task_plans") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_update_revision_key_collision_rolls_back_the_plan_update(self):
        cursor = TaskPlanUpdateCursor(
            current_version=1,
            replay_after_lock=False,
            revision_conflict=True,
        )
        request = TaskPlanUpdate(
            base_version=1,
            spec=valid_plan(),
            idempotency_key="task-plan-update-key",
        )
        with patch("server.get_conn", return_value=TaskPlanCreateConnection(cursor)), patch(
            "server._surface_request_hash", return_value=cursor.request_hash
        ), self.assertRaises(HTTPException) as caught:
            update_task_plan(
                "30000000-0000-4000-8000-000000000001", request, self.identity
            )

        self.assertEqual(caught.exception.status_code, 409)
        revision_insert = next(
            query for query in cursor.queries if query.startswith("INSERT INTO gb_task_plan_revisions")
        )
        self.assertIn("ON CONFLICT DO NOTHING", revision_insert)
        self.assertEqual(cursor.queries[-1], "ROLLBACK")


if __name__ == "__main__":
    unittest.main()
