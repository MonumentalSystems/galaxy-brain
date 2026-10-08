import unittest

from server import (
    PROOF_VERIFIER_AUTHORITY_TABLE_PRIVILEGES,
    RUNTIME_DML_FORBIDDEN,
    RUNTIME_DML_REQUIREMENTS,
    RUNTIME_IDENTITY_READ_TABLES,
    TENANT_RLS_TABLES,
    _verify_proof_verifier_authority,
    _verify_runtime_rls_role,
)


class RuntimeRoleCursor:
    def __init__(
        self, table_overrides=None, identity_overrides=None, registrar_overrides=None
    ):
        self.table_overrides = table_overrides or {}
        self.identity_overrides = identity_overrides or {}
        self.registrar_overrides = registrar_overrides or {}
        self.rows = []
        self.query_count = 0

    def execute(self, query, params=None):
        self.query_count += 1
        if self.query_count == 1:
            self.rows = []
            return
        if self.query_count == 3:
            row = {
                "registrar_exists": True,
                "can_execute_registrar": False,
                "verifier_authority_exists": True,
                "can_assume_verifier_authority": False,
            }
            row.update(self.registrar_overrides)
            self.rows = [row]
            return
        if self.query_count == 4:
            self.rows = []
            for table_name in RUNTIME_IDENTITY_READ_TABLES:
                row = {
                    "relname": table_name,
                    "can_select": True,
                    "can_insert": False,
                    "can_update": False,
                    "can_delete": False,
                }
                row.update(self.identity_overrides.get(table_name, {}))
                self.rows.append(row)
            return
        if self.query_count != 2:
            raise AssertionError("unexpected startup verifier query")

        self.rows = []
        for table_name in TENANT_RLS_TABLES:
            row = {
                "relname": table_name,
                "owner_name": "galaxy_brain_schema_owner",
                "relrowsecurity": True,
                "can_assume_owner": False,
                "can_select": "select" in RUNTIME_DML_REQUIREMENTS[table_name],
                "can_insert": "insert" in RUNTIME_DML_REQUIREMENTS[table_name],
                "can_update": "update" in RUNTIME_DML_REQUIREMENTS[table_name],
                "can_delete": "delete" in RUNTIME_DML_REQUIREMENTS[table_name],
                "can_truncate": False,
            }
            for privilege in RUNTIME_DML_FORBIDDEN.get(table_name, ()):
                row[f"can_{privilege}"] = False
            row.update(self.table_overrides.get(table_name, {}))
            self.rows.append(row)

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class VerifierAuthorityConnection:
    def __init__(self, login_overrides=None, table_overrides=None, can_execute_registrar=True):
        self.login = {
            "login_role": "galaxy_brain_verifier",
            "login_privileged": False,
            "can_assume_bypass": False,
            "authority_exists": True,
            "authority_unrestricted": False,
            "can_assume_authority": True,
        }
        self.login.update(login_overrides or {})
        self.table_overrides = table_overrides or {}
        self.can_execute_registrar = can_execute_registrar
        self.queries = []
        self.rows = []

    def cursor(self):
        return self

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        self.rows = []
        if normalized in {"BEGIN", "ROLLBACK", "SET LOCAL ROLE gb_proof_verifier"}:
            return
        if normalized.startswith("SELECT session_role.rolname"):
            self.rows = [self.login]
        elif normalized.startswith("SELECT CASE WHEN registrar.oid"):
            self.rows = [{"can_execute_registrar": self.can_execute_registrar}]
        elif normalized.startswith("SELECT tables.relname"):
            for table_name in TENANT_RLS_TABLES:
                expected = PROOF_VERIFIER_AUTHORITY_TABLE_PRIVILEGES.get(table_name, ())
                row = {"relname": table_name, "can_assume_owner": False}
                for privilege in ("select", "insert", "update", "delete", "truncate"):
                    row[f"can_{privilege}"] = privilege in expected
                row.update(self.table_overrides.get(table_name, {}))
                self.rows.append(row)
        else:
            raise AssertionError(f"unexpected verifier authority query: {normalized}")

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class VerifierAuthorityTests(unittest.TestCase):
    def test_accepts_a_separate_login_that_assumes_only_the_sealed_authority(self):
        connection = VerifierAuthorityConnection()
        _verify_proof_verifier_authority(connection, "galaxy_brain_api")
        self.assertIn("SET LOCAL ROLE gb_proof_verifier", connection.queries)
        self.assertEqual(connection.queries[-1], "ROLLBACK")

    def test_rejects_unsafe_verifier_logins(self):
        cases = (
            ({"login_role": "galaxy_brain_api"}, "distinct from the API runtime"),
            ({"login_privileged": True}, "bypass row-level security"),
            ({"can_assume_bypass": True}, "bypass row-level security"),
            ({"authority_unrestricted": True}, "restricted NOLOGIN role"),
            ({"authority_exists": False}, "restricted NOLOGIN role"),
            ({"can_assume_authority": False}, "not a member of gb_proof_verifier"),
        )
        for overrides, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(RuntimeError, message):
                _verify_proof_verifier_authority(
                    VerifierAuthorityConnection(login_overrides=overrides), "galaxy_brain_api"
                )

    def test_rejects_authority_without_registrar_or_with_direct_ledger_writes(self):
        with self.assertRaisesRegex(RuntimeError, "cannot execute the registrar"):
            _verify_proof_verifier_authority(
                VerifierAuthorityConnection(can_execute_registrar=False), "galaxy_brain_api"
            )
        for table_name, override in (
            ("gb_proof_work_verifications", {"can_insert": True}),
            ("gb_proof_work_transitions", {"can_update": True}),
            ("gb_experiments", {"can_select": True}),
            ("gb_proof_workspaces", {"can_assume_owner": True}),
        ):
            with self.subTest(table=table_name), self.assertRaisesRegex(
                RuntimeError, f"privileges do not match the contract: {table_name}"
            ):
                _verify_proof_verifier_authority(
                    VerifierAuthorityConnection(table_overrides={table_name: override}),
                    "galaxy_brain_api",
                )


class StartupPermissionTests(unittest.TestCase):
    def test_agent_result_ledgers_are_runtime_append_only(self):
        for table_name in ("gb_agent_result_candidates", "gb_agent_result_decisions"):
            with self.subTest(table=table_name):
                self.assertIn(table_name, TENANT_RLS_TABLES)
                self.assertEqual(
                    RUNTIME_DML_REQUIREMENTS[table_name],
                    frozenset(("select", "insert")),
                )
                self.assertEqual(
                    RUNTIME_DML_FORBIDDEN[table_name],
                    frozenset(("update", "delete", "truncate")),
                )

    def test_accepts_proof_work_least_privilege_contract(self):
        _verify_runtime_rls_role(RuntimeRoleCursor())

    def test_rejects_missing_required_transition_insert(self):
        cursor = RuntimeRoleCursor(
            {"gb_proof_work_transitions": {"can_insert": False}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"lacks required DML privileges: gb_proof_work_transitions \(insert\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_forbidden_transition_mutation_privilege(self):
        cursor = RuntimeRoleCursor(
            {"gb_proof_work_transitions": {"can_update": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_proof_work_transitions \(update\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_canvas_revision_mutation_privilege(self):
        cursor = RuntimeRoleCursor(
            {"gb_canvas_revisions": {"can_update": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_canvas_revisions \(update\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_share_snapshot_mutation_privilege(self):
        cursor = RuntimeRoleCursor(
            {"gb_share_snapshots": {"can_delete": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_share_snapshots \(delete\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_runtime_access_to_trusted_verification_registrar(self):
        cursor = RuntimeRoleCursor(
            registrar_overrides={"can_execute_registrar": True}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "forbidden trusted proof verification registrar access",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_runtime_membership_in_the_verifier_authority(self):
        with self.assertRaisesRegex(
            RuntimeError, "can assume the trusted proof verifier authority"
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor(
                registrar_overrides={"can_assume_verifier_authority": True}
            ))
        with self.assertRaisesRegex(
            RuntimeError, "trusted proof verifier authority role is missing"
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor(
                registrar_overrides={"verifier_authority_exists": False}
            ))

    def test_rejects_missing_artifact_insert_or_mutation_privilege(self):
        with self.assertRaisesRegex(
            RuntimeError,
            r"lacks required DML privileges: gb_artifacts \(insert\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({"gb_artifacts": {"can_insert": False}}))

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_artifacts \(update\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({"gb_artifacts": {"can_update": True}}))

    def test_rejects_mutating_an_immutable_paper_document(self):
        cursor = RuntimeRoleCursor(
            {"gb_paper_documents": {"can_update": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_paper_documents \(update\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_mutating_an_experiment_creation_receipt(self):
        cursor = RuntimeRoleCursor(
            {"gb_experiment_creation_receipts": {"can_delete": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_experiment_creation_receipts \(delete\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_missing_insert_or_mutation_privilege_for_proof_graph_registry(self):
        with self.assertRaisesRegex(
            RuntimeError,
            r"lacks required DML privileges: gb_proof_graphs \(insert\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({"gb_proof_graphs": {"can_insert": False}}))

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_proof_graphs \(update\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({"gb_proof_graphs": {"can_update": True}}))

    def test_rejects_truncate_privilege_for_formal_project_packages(self):
        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_formal_project_packages \(truncate\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({
                "gb_formal_project_packages": {"can_truncate": True},
            }))

    def test_rejects_mutating_an_object_link_assertion(self):
        cursor = RuntimeRoleCursor(
            {"gb_object_links": {"can_update": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_object_links \(update\)",
        ):
            _verify_runtime_rls_role(cursor)

    def test_relation_proposals_require_insert_but_forbid_mutation(self):
        with self.assertRaisesRegex(
            RuntimeError,
            r"lacks required DML privileges: gb_object_link_proposals \(insert\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({
                "gb_object_link_proposals": {"can_insert": False},
            }))

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden DML privileges: gb_object_link_proposals \(update\)",
        ):
            _verify_runtime_rls_role(RuntimeRoleCursor({
                "gb_object_link_proposals": {"can_update": True},
            }))

    def test_rejects_missing_agent_identity_read_privilege(self):
        cursor = RuntimeRoleCursor(
            identity_overrides={"app_agents": {"can_select": False}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"lacks required identity read privileges: app_agents",
        ):
            _verify_runtime_rls_role(cursor)

    def test_rejects_identity_write_privilege(self):
        cursor = RuntimeRoleCursor(
            identity_overrides={"app_agents": {"can_update": True}}
        )

        with self.assertRaisesRegex(
            RuntimeError,
            r"has forbidden identity write privileges: app_agents \(update\)",
        ):
            _verify_runtime_rls_role(cursor)


if __name__ == "__main__":
    unittest.main()
