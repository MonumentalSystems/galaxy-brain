import pathlib
import unittest


MIGRATION = pathlib.Path(__file__).parents[2] / "db" / "migrations" / "050_agent_result_return_path.sql"
LOCAL_ROLE_PROVISIONER = pathlib.Path(__file__).parents[2] / "scripts" / "provision-local-runtime-roles.mjs"


class AgentResultMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.provisioner = LOCAL_ROLE_PROVISIONER.read_text(encoding="utf-8")

    def test_candidate_anchor_is_bound_to_the_same_document_revision(self):
        self.assertIn(
            "FOREIGN KEY (tenant_id, document_revision_id, anchor_id)\n"
            "    REFERENCES gb_document_anchors(tenant_id, document_revision_id, id)",
            self.sql,
        )

    def test_candidate_and_decision_are_forced_rls_append_only_tables(self):
        for table in ("gb_agent_result_candidates", "gb_agent_result_decisions"):
            with self.subTest(table=table):
                self.assertIn(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY", self.sql)
                self.assertIn(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY", self.sql)
                self.assertIn(f"CREATE POLICY {table}_tenant_isolation", self.sql)
                self.assertIn(f"CREATE TRIGGER {table}_append_only", self.sql)
        self.assertIn("REVOKE UPDATE, DELETE, TRUNCATE", self.sql)

    def test_rejection_cannot_reference_materialized_knowledge(self):
        self.assertIn(
            "decision = 'rejected' AND document_id IS NULL AND document_revision_id IS NULL",
            self.sql,
        )

    def test_only_a_human_tenant_member_can_write_a_decision(self):
        self.assertIn("principal.kind = 'human'", self.sql)
        self.assertIn("membership.tenant_id = NEW.tenant_id", self.sql)
        self.assertIn("gb_agent_result_decisions_actor_guard", self.sql)

    def test_fresh_local_api_role_receives_only_immutable_insert_access(self):
        for table in ("gb_agent_result_candidates", "gb_agent_result_decisions"):
            with self.subTest(table=table):
                self.assertIn(f'"{table}"', self.provisioner)
        self.assertIn("apiImmutableInsertTables", self.provisioner)


if __name__ == "__main__":
    unittest.main()
