import unittest

from fastapi import HTTPException

from server import IdentityContext, _surface_provenance


class SurfaceProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id="00000000-0000-4000-8000-000000000001",
            principal_id="00000000-0000-4000-8000-000000000002",
            principal_kind="agent",
        )

    def test_accepts_non_sensitive_actor_reference(self):
        value = _surface_provenance(
            {"source": "generous.canvas", "actor_ref": f"clerk:sha256:{'a' * 64}"},
            self.identity,
            "created",
        )
        self.assertEqual(value["actor_ref"], f"clerk:sha256:{'a' * 64}")
        self.assertEqual(value["galaxy"]["principal_id"], self.identity.principal_id)

    def test_rejects_raw_or_malformed_actor_reference(self):
        for actor_ref in ("user", "contains a space", "x" * 201, 42):
            with self.subTest(actor_ref=actor_ref), self.assertRaises(HTTPException) as caught:
                _surface_provenance(
                    {"source": "generous.canvas", "actor_ref": actor_ref},
                    self.identity,
                    "created",
                )
            self.assertEqual(caught.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
