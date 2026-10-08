import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import (
    IdentityContext,
    SurfaceCreate,
    SurfaceUpdate,
    _replayed_surface,
    create_surface,
    list_surface_revisions,
    update_surface,
)
from test_surface_contract import research_board


class SurfaceUpdateReplayTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="10000000-0000-4000-8000-000000000001",
            principal_id="20000000-0000-4000-8000-000000000001",
            principal_kind="human",
        )

    def test_full_and_title_only_retries_replay_before_stale_version_lookup(self):
        requests = [
            SurfaceUpdate(
                base_version=1,
                spec=research_board(),
                idempotency_key="surface-retry-full",
            ),
            SurfaceUpdate(
                base_version=1,
                title="Retitled surface",
                idempotency_key="surface-retry-title",
            ),
        ]
        replayed = {"id": "30000000-0000-4000-8000-000000000001", "replayed": True}
        for request in requests:
            with self.subTest(request=request), patch(
                "server._replayed_surface", return_value=replayed
            ) as replay_lookup, patch(
                "server._get_surface_or_404",
                side_effect=AssertionError("stale current surface must not be read before replay"),
            ):
                self.assertEqual(
                    update_surface(replayed["id"], request, self.identity),
                    replayed,
                )
                replay_lookup.assert_called_once()

    def test_create_checks_the_global_revision_key_before_inserting(self):
        request = SurfaceCreate(
            title="Research Board",
            spec=research_board(),
            idempotency_key="surface-key-from-update",
        )
        replayed = {"id": "30000000-0000-4000-8000-000000000001", "replayed": True}
        with patch("server._replayed_surface", return_value=replayed) as replay_lookup, patch(
            "server.get_conn",
            side_effect=AssertionError("a known revision key must not reach surface insertion"),
        ):
            self.assertEqual(create_surface(request, self.identity), replayed)
            replay_lookup.assert_called_once()

        with patch(
            "server._replayed_surface",
            side_effect=HTTPException(status_code=409, detail="different input"),
        ), patch(
            "server.get_conn",
            side_effect=AssertionError("a conflicting revision key must not reach surface insertion"),
        ), self.assertRaises(HTTPException) as caught:
            create_surface(request, self.identity)
        self.assertEqual(caught.exception.status_code, 409)

    def test_replay_receipt_stays_bound_to_the_original_revision_after_many_updates(self):
        revision = {
            "id": "40000000-0000-4000-8000-000000000001",
            "tenant_id": self.identity.tenant_id,
            "surface_id": "30000000-0000-4000-8000-000000000001",
            "version": 1,
            "title": "Research Board",
            "status": "draft",
            "content_hash": "a" * 64,
            "schema_digest": "c" * 64,
            "catalog_digest": "d" * 64,
            "renderer_version": "surface-renderer-v1",
            "spec": research_board(),
            "provenance": {"source": "agent-tool:surface.draft.create"},
            "idempotency_key": "surface-create-original",
            "request_hash": "b" * 64,
        }
        current = {
            "id": revision["surface_id"],
            "current_version": 250,
            "current_content_hash": "c" * 64,
            "status": "promoted",
        }

        class Cursor:
            def execute(self, query, params):
                self.query = query
                self.params = params

            def fetchone(self):
                return revision

        class Connection:
            def cursor(self):
                return Cursor()

        with patch("server.get_conn", return_value=Connection()), patch(
            "server._get_surface_or_404", return_value=current
        ):
            replayed = _replayed_surface(revision["idempotency_key"], revision["request_hash"])

        self.assertEqual(replayed["current_version"], 250)
        self.assertNotIn("id", replayed["replayed_revision"])
        self.assertEqual(replayed["replayed_revision"]["version"], 1)
        self.assertEqual(replayed["replayed_revision"]["content_hash"], "a" * 64)
        self.assertEqual(replayed["replayed_revision"]["schema_digest"], "c" * 64)
        self.assertEqual(replayed["replayed_revision"]["catalog_digest"], "d" * 64)
        self.assertEqual(replayed["replayed_revision"]["renderer_version"], "surface-renderer-v1")

    def test_exact_revision_lookup_does_not_scan_a_bounded_history_page(self):
        surface_id = "30000000-0000-4000-8000-000000000001"
        revision = {
            "surface_id": surface_id,
            "version": 1,
            "status": "draft",
            "content_hash": "a" * 64,
        }

        class Cursor:
            def __init__(self):
                self.query = None
                self.params = None

            def execute(self, query, params):
                self.query = query
                self.params = params

            def fetchone(self):
                return revision

        class Connection:
            def __init__(self):
                self.value = Cursor()

            def cursor(self):
                return self.value

        connection = Connection()
        with patch("server.get_conn", return_value=connection), patch(
            "server._get_surface_or_404", return_value={"id": surface_id, "current_version": 250}
        ):
            result = list_surface_revisions(
                surface_id,
                limit=1,
                version=1,
                identity=self.identity,
            )

        self.assertEqual(result, [revision])
        self.assertIn("surface_id = %s AND version = %s", connection.value.query)
        self.assertEqual(connection.value.params, (surface_id, 1))

    def test_title_only_update_preserves_legacy_contract_identity(self):
        legacy_identity = {
            "schema_digest": "a" * 64,
            "catalog_digest": "b" * 64,
            "renderer_version": "legacy-renderer",
        }
        current = {
            "id": "30000000-0000-4000-8000-000000000001",
            "title": "Legacy title",
            "status": "draft",
            "current_version": 1,
            "current_content_hash": "c" * 64,
            "current_spec": {"legacy": True},
            **legacy_identity,
        }

        class Cursor:
            def __init__(self):
                self.params = None

            def execute(self, query, params):
                self.params = params

            def fetchone(self):
                return {**current, "title": "Retitled", "current_version": 2}

        class Connection:
            def __init__(self):
                self.value = Cursor()

            def cursor(self):
                return self.value

        connection = Connection()
        request = SurfaceUpdate(
            base_version=1,
            title="Retitled",
            idempotency_key="surface-title-legacy",
        )
        with patch("server._replayed_surface", return_value=None), patch(
            "server._get_surface_or_404", return_value=current
        ), patch("server.get_conn", return_value=connection):
            result = update_surface(current["id"], request, self.identity)

        self.assertEqual(result["title"], "Retitled")
        self.assertEqual(connection.value.params[4:7], (
            legacy_identity["schema_digest"],
            legacy_identity["catalog_digest"],
            legacy_identity["renderer_version"],
        ))


if __name__ == "__main__":
    unittest.main()
