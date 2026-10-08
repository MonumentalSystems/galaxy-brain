import copy
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from server import IdentityContext, _binding_projection
from surface_bindings import SurfaceBindingError, resolve_surface_bindings
from test_surface_contract import research_board


class SurfaceBindingTests(unittest.TestCase):
    def test_database_projection_uses_serialized_timestamp_rows(self):
        timestamp = datetime(2026, 9, 4, 7, 30, tzinfo=timezone.utc)

        class Cursor:
            def __init__(self, rows):
                self.rows = rows

            def execute(self, _query, _params):
                return None

            def fetchall(self):
                return self.rows

        class Connection:
            def __init__(self, rows):
                self.rows = rows

            def cursor(self):
                return Cursor(self.rows)

        identity = IdentityContext(
            tenant_id="00000000-0000-4000-8000-000000000001",
            principal_id="00000000-0000-4000-8000-000000000002",
            principal_kind="human",
        )
        cases = [
            (
                {"kind": "galaxy.eln.experiment", "query": {"aggregate": "status"}},
                [{"status": "running", "count": 1, "updated_at": timestamp}],
            ),
            (
                {"kind": "galaxy.eln.experiment", "query": {"limit": 1}},
                [{"id": "experiment-1", "title": "Bound", "status": "running", "updated_at": timestamp}],
            ),
        ]
        for source, rows in cases:
            with self.subTest(source=source), patch("server.get_conn", return_value=Connection(rows)):
                projected = _binding_projection("galaxy.eln.experiment", source, identity)
                self.assertEqual(projected["source_revisions"], [timestamp.isoformat()])

    def test_resource_binding_accepts_stable_text_ids(self):
        class Cursor:
            params = None

            def execute(self, _query, params):
                self.params = params

            def fetchall(self):
                return [{
                    "id": "legacy-experiment.1",
                    "title": "Imported legacy record",
                    "status": "complete",
                    "updated_at": datetime(2026, 9, 4, tzinfo=timezone.utc),
                }]

        class Connection:
            def __init__(self):
                self.value = Cursor()

            def cursor(self):
                return self.value

        identity = IdentityContext(
            tenant_id="00000000-0000-4000-8000-000000000001",
            principal_id="00000000-0000-4000-8000-000000000002",
            principal_kind="human",
        )
        connection = Connection()
        with patch("server.get_conn", return_value=connection):
            projected = _binding_projection(
                "galaxy.eln.experiment",
                {"kind": "galaxy.eln.experiment", "resourceId": "legacy-experiment.1"},
                identity,
            )
        self.assertEqual(projected["source_ids"], ["legacy-experiment.1"])
        self.assertIn("legacy-experiment.1", connection.value.params)

    def test_invalid_selector_fails_before_database_query(self):
        identity = IdentityContext(
            tenant_id="00000000-0000-4000-8000-000000000001",
            principal_id="00000000-0000-4000-8000-000000000002",
            principal_kind="human",
        )
        with patch(
            "server.get_conn",
            side_effect=AssertionError("invalid selectors must not reach PostgreSQL"),
        ), self.assertRaisesRegex(SurfaceBindingError, "Additional properties"):
            _binding_projection(
                "galaxy.eln.experiment",
                {"kind": "galaxy.eln.experiment", "query": {"bogus": True}},
                identity,
            )

    def test_materializes_rows_and_stats_without_mutating_definition(self):
        definition = research_board()
        original = copy.deepcopy(definition)

        def fetcher(_kind, source):
            if source.get("query", {}).get("aggregate") == "status":
                return {
                    "value": [{"key": "running", "label": "Running", "value": 2}],
                    "source_ids": ["experiment-1", "experiment-2"],
                    "source_revisions": ["2026-08-31T00:00:00Z"],
                }
            return {
                "value": [{"id": "experiment-1", "title": "Bound", "status": "running"}],
                "source_ids": ["experiment-1"],
                "source_revisions": ["2026-08-31T00:00:00Z"],
            }

        resolved = resolve_surface_bindings(
            definition,
            fetcher,
            resolved_at="2026-08-31T00:00:01Z",
        )
        self.assertEqual(definition, original)
        components = resolved["materialized_spec"]["surfaceUpdate"]["components"]
        self.assertEqual(components[3]["component"]["DataTable"]["data"]["rows"][0]["title"], "Bound")
        self.assertEqual(components[2]["component"]["StatsDisplay"]["stats"][0]["value"], 2)
        self.assertTrue(all(item["status"] == "resolved" for item in resolved["bindings"]))

    def test_failed_binding_preserves_last_valid_materialization(self):
        definition = research_board()

        def fetcher(_kind, source):
            if source.get("query", {}).get("aggregate") == "status":
                return {"value": {"not": "stats"}}
            return {"value": [{"title": "Still applied", "status": "running"}]}

        resolved = resolve_surface_bindings(definition, fetcher)
        self.assertEqual(resolved["bindings"][0]["status"], "resolved")
        self.assertEqual(resolved["bindings"][1]["status"], "error")
        components = resolved["materialized_spec"]["surfaceUpdate"]["components"]
        self.assertEqual(components[2]["component"]["StatsDisplay"]["stats"], definition["surfaceUpdate"]["components"][2]["component"]["StatsDisplay"]["stats"])

    def test_external_sources_fail_closed(self):
        resolved = resolve_surface_bindings(
            research_board(),
            lambda _kind, _source: (_ for _ in ()).throw(SurfaceBindingError("unavailable")),
        )
        self.assertTrue(all(item["status"] == "error" for item in resolved["bindings"]))


if __name__ == "__main__":
    unittest.main()
