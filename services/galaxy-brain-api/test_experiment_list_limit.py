import unittest
from unittest.mock import patch

from server import IdentityContext, list_experiments


class _Cursor:
    def __init__(self):
        self.query = None
        self.params = None

    def execute(self, query, params):
        self.query = query
        self.params = params

    def fetchall(self):
        return []


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class ExperimentListLimitTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="00000000-0000-4000-8000-000000000001",
            principal_id="00000000-0000-4000-8000-000000000002",
            principal_kind="user",
        )

    def test_applies_requested_limit_in_the_database_query(self):
        cursor = _Cursor()
        with patch("server.get_conn", return_value=_Connection(cursor)):
            self.assertEqual(list_experiments(limit=60, identity=self.identity), [])

        self.assertTrue(cursor.query.endswith("ORDER BY updated_at DESC LIMIT %s"))
        self.assertEqual(cursor.params, [self.identity.tenant_id, 60])

    def test_preserves_unbounded_legacy_callers_when_limit_is_omitted(self):
        cursor = _Cursor()
        with patch("server.get_conn", return_value=_Connection(cursor)):
            self.assertEqual(list_experiments(limit=None, identity=self.identity), [])

        self.assertNotIn("LIMIT", cursor.query)
        self.assertEqual(cursor.params, [self.identity.tenant_id])


if __name__ == "__main__":
    unittest.main()
