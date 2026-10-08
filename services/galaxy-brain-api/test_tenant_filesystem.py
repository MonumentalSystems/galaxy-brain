import os
import json
import tempfile
import unittest

from tenant_filesystem import (
    authorize_tenant_root,
    authorize_tenant_root_binding,
    parse_tenant_filesystem_roots,
    roots_for_tenant,
)


TENANT_A = "00000000-0000-4000-8000-000000000001"
TENANT_B = "00000000-0000-4000-8000-000000000002"


class TenantFilesystemConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.tenant_a_root = os.path.join(self.temporary_directory.name, "tenant-a")
        self.tenant_b_root = os.path.join(self.temporary_directory.name, "tenant-b")
        os.makedirs(self.tenant_a_root)
        os.makedirs(self.tenant_b_root)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def tenant_config(self):
        return json.dumps({
            TENANT_A: [self.tenant_a_root],
            TENANT_B: [self.tenant_b_root],
        })

    def test_roots_are_selected_only_for_the_exact_tenant(self):
        config = parse_tenant_filesystem_roots(self.tenant_config())
        self.assertEqual(roots_for_tenant(config, TENANT_A), (os.path.realpath(self.tenant_a_root),))
        self.assertEqual(roots_for_tenant(config, TENANT_B), (os.path.realpath(self.tenant_b_root),))
        self.assertEqual(
            roots_for_tenant(config, "00000000-0000-4000-8000-000000000003"),
            (),
        )

    def test_missing_configuration_disables_filesystem_access(self):
        self.assertEqual(parse_tenant_filesystem_roots(""), {})
        self.assertEqual(roots_for_tenant({}, TENANT_A), ())
        with self.assertRaises(PermissionError):
            authorize_tenant_root({}, TENANT_A, self.tenant_a_root)

    def test_one_tenant_cannot_select_another_tenants_allowed_path(self):
        config = parse_tenant_filesystem_roots(self.tenant_config())
        tenant_a_docs = os.path.join(self.tenant_a_root, "docs")
        self.assertEqual(
            authorize_tenant_root(config, TENANT_A, tenant_a_docs),
            os.path.realpath(tenant_a_docs),
        )
        with self.assertRaises(PermissionError):
            authorize_tenant_root(config, TENANT_B, tenant_a_docs)

    def test_authorization_preserves_the_exact_configured_anchor(self):
        nested_authority = os.path.join(self.tenant_a_root, "research")
        connection_root = os.path.join(nested_authority, "papers", "active")
        os.makedirs(connection_root)
        config = parse_tenant_filesystem_roots(json.dumps({
            TENANT_A: [self.tenant_a_root, nested_authority],
        }))
        binding = authorize_tenant_root_binding(config, TENANT_A, connection_root)
        self.assertEqual(binding.configured_root, os.path.realpath(nested_authority))
        self.assertEqual(binding.connection_root, os.path.realpath(connection_root))
        self.assertEqual(binding.relative_parts, ("papers", "active"))

    def test_invalid_or_overbroad_configuration_fails_closed(self):
        invalid_values = [
            "[]",
            json.dumps({"not-a-uuid": [self.tenant_a_root]}),
            json.dumps({TENANT_A: self.tenant_a_root}),
            json.dumps({TENANT_A: ["relative/path"]}),
            json.dumps({TENANT_A: [os.path.abspath(os.sep)]}),
        ]
        for raw in invalid_values:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    parse_tenant_filesystem_roots(raw)


if __name__ == "__main__":
    unittest.main()
