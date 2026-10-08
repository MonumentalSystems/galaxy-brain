import hashlib
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from server import (
    ConversationAppend,
    IdentityContext,
    _conversation_read,
    _exact_conversation_snapshot,
    _mutate_conversation,
    export_conversation_markdown,
    get_conversation,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
CONVERSATION = "30000000-0000-4000-8000-000000000001"
REVISION = "50000000-0000-4000-8000-000000000001"
HASH = f"sha256:{'a' * 64}"


class Cursor:
    def __init__(self, rows=()):
        self.rows = iter(rows)
        self.current = None
        self.statements = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.statements.append((normalized, params))
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.current = None
        else:
            self.current = next(self.rows, None)

    def fetchone(self):
        return self.current

    def fetchall(self):
        if self.current is None:
            return []
        return self.current if isinstance(self.current, list) else [self.current]


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class ConversationApiTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human", role="member")
        self.conversation = {
            "id": CONVERSATION,
            "tenant_id": TENANT,
            "workspace_id": "research-main",
            "title": "Synthesis",
            "goal": "Compare evidence",
            "artifact_refs": [],
            "provenance": {},
            "current_version": 1,
            "current_content_hash": HASH,
        }
        self.request = ConversationAppend(
            expected_version=1,
            parent_turn_id=None,
            message={"role": "user", "content": "Start from the pinned source."},
            artifact_refs=[],
            provenance={"provider": "galaxy"},
            idempotency_key="conversation-append-1",
        )

    def test_stale_write_exposes_current_version_and_hash(self):
        stale = {**self.conversation, "current_version": 2}
        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value=stale),
            patch("server._conversation_replay", return_value=None),
            self.assertRaises(HTTPException) as caught,
        ):
            _mutate_conversation(CONVERSATION, "continues", self.request.model_dump(), self.identity)
        self.assertEqual(caught.exception.detail["code"], "stale_conversation")
        self.assertEqual(caught.exception.detail["currentVersion"], 2)
        self.assertEqual(caught.exception.detail["currentContentHash"], HASH)
        self.assertEqual(cursor.statements[-1][0], "ROLLBACK")

    def test_exact_retry_returns_original_receipt_before_version_check(self):
        replay = {
            "id": REVISION,
            "version": 2,
            "content_hash": f"sha256:{'b' * 64}",
            "mutation_kind": "append",
            "mutation_json": {"turnId": "40000000-0000-4000-8000-000000000001"},
            "request_hash": "bound-by-helper",
        }
        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value={**self.conversation, "current_version": 9}),
            patch("server._conversation_replay", return_value=replay),
        ):
            result = _mutate_conversation(CONVERSATION, "continues", self.request.model_dump(), self.identity)
        self.assertTrue(result["replayed"])
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["turnId"], replay["mutation_json"]["turnId"])
        self.assertEqual([statement for statement, _ in cursor.statements], ["BEGIN", "COMMIT"])

    def test_root_append_writes_one_turn_revision_and_one_aggregate_revision(self):
        updated = {**self.conversation, "current_version": 2, "current_content_hash": f"sha256:{'b' * 64}"}
        revision = {
            "id": REVISION,
            "version": 2,
            "content_hash": updated["current_content_hash"],
            "mutation_kind": "append",
            "mutation_json": {"turnId": "filled-by-server"},
            "request_hash": "request",
        }
        cursor = Cursor([None, None, None, updated, revision])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value=self.conversation),
            patch("server._conversation_replay", return_value=None),
        ):
            result = _mutate_conversation(CONVERSATION, "continues", self.request.model_dump(), self.identity)
        self.assertEqual(result["version"], 2)
        statements = "\n".join(statement for statement, _ in cursor.statements)
        self.assertIn("INSERT INTO gb_conversation_turns", statements)
        self.assertIn("INSERT INTO gb_conversation_turn_revisions", statements)
        self.assertIn("UPDATE gb_conversations", statements)
        self.assertIn("INSERT INTO gb_conversation_revisions", statements)
        self.assertNotIn("INSERT INTO gb_conversation_edges", statements)

    def test_join_writes_one_turn_two_parent_edges_and_one_aggregate_revision(self):
        parents = [
            "40000000-0000-4000-8000-000000000001",
            "40000000-0000-4000-8000-000000000002",
        ]
        updated = {
            **self.conversation,
            "current_version": 2,
            "current_content_hash": f"sha256:{'b' * 64}",
        }
        revision = {
            "id": REVISION,
            "version": 2,
            "content_hash": updated["current_content_hash"],
            "mutation_kind": "join",
            "mutation_json": {"turnId": "filled-by-server"},
            "request_hash": "request",
        }
        cursor = Cursor([
            [{"id": parent_id, "is_tip": True} for parent_id in parents],
            None,
            None,
            None,
            None,
            updated,
            revision,
        ])
        request = {
            "expected_version": 1,
            "parent_turn_ids": parents,
            "message": {"role": "user", "content": "Synthesize both exact branches."},
            "artifact_refs": [],
            "provenance": {"provider": "galaxy.graph"},
            "idempotency_key": "conversation-join-1",
        }
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value=self.conversation),
            patch("server._conversation_replay", return_value=None),
        ):
            result = _mutate_conversation(CONVERSATION, "joins", request, self.identity)
        self.assertEqual(result["operation"], "join")
        edge_writes = [
            params for statement, params in cursor.statements
            if statement.startswith("INSERT INTO gb_conversation_edges")
        ]
        self.assertEqual(len(edge_writes), 2)
        self.assertEqual([params[2] for params in edge_writes], parents)
        self.assertEqual(len({params[3] for params in edge_writes}), 1)
        self.assertTrue(all(params[5] == "joins" for params in edge_writes))
        aggregate_writes = [
            params for statement, params in cursor.statements
            if statement.startswith("INSERT INTO gb_conversation_revisions")
        ]
        self.assertEqual(len(aggregate_writes), 1)
        self.assertEqual(aggregate_writes[0][5], "join")

    def test_cross_page_edges_are_selected_by_child_and_load_parent_context(self):
        turn = {
            "id": "40000000-0000-4000-8000-000000000002", "ordinal": 2,
            "role": "assistant", "content": "Continue", "artifact_refs": [],
            "provenance": {}, "content_hash": f"sha256:{'b' * 64}", "created_at": None,
        }
        edge = {
            "id": "50000000-0000-4000-8000-000000000001",
            "from_turn_id": "40000000-0000-4000-8000-000000000001",
            "to_turn_id": turn["id"], "edge_kind": "continues", "created_at": None,
        }
        parent = {
            "id": edge["from_turn_id"], "ordinal": 1, "role": "user", "content": "Start",
            "artifact_refs": [], "provenance": {}, "content_hash": HASH, "created_at": None,
        }
        cursor = Cursor([[turn], [edge], [parent]])
        result = _conversation_read(cursor, {**self.conversation, "current_version": 3}, after_ordinal=1, limit=1)
        edge_query = cursor.statements[1][0]
        self.assertIn("to_turn_id = ANY", edge_query)
        self.assertNotIn("from_turn_id = ANY", edge_query)
        self.assertEqual(result["contextTurns"][0]["turnId"], parent["id"])
        self.assertEqual(result["edges"][0]["fromTurnId"], parent["id"])

    def test_continuation_requires_and_enforces_snapshot_fence_under_share_lock(self):
        with self.assertRaises(HTTPException) as missing:
            get_conversation(CONVERSATION, 1, 1, None, None, self.identity)
        self.assertEqual(missing.exception.detail["code"], "continuation_snapshot_required")

        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value={**self.conversation, "current_version": 2}) as load,
            self.assertRaises(HTTPException) as stale,
        ):
            get_conversation(CONVERSATION, 1, 1, 1, HASH, self.identity)
        self.assertEqual(stale.exception.detail["code"], "stale_conversation_snapshot")
        self.assertTrue(load.call_args.kwargs["for_share"])
        self.assertEqual([statement for statement, _ in cursor.statements], ["BEGIN", "ROLLBACK"])

    def test_exact_markdown_export_reuses_tenant_lock_and_returns_integrity_headers(self):
        turn_id = "40000000-0000-4000-8000-000000000001"
        turn_hash = f"sha256:{'b' * 64}"
        conversation_ref = (
            f"gb:object:v1:chat:{CONVERSATION}:pinned:sha256%3A{'a' * 64}"
        )
        frozen = {
            "conversationId": CONVERSATION,
            "workspaceId": "research-main",
            "ref": conversation_ref,
            "title": "Exact synthesis",
            "goal": "Preserve the branch.",
            "version": 2,
            "contentHash": HASH,
            "turns": [{
                "turnId": turn_id,
                "ordinal": 1,
                "role": "assistant",
                "content": "Exact $\\LaTeX$ and Markdown.",
                "ref": f"gb:object:v1:turn:{turn_id}:pinned:sha256%3A{'b' * 64}",
                "contentHash": turn_hash,
            }],
            "edges": [],
        }
        cursor = Cursor()
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._conversation_or_404", return_value=self.conversation) as load,
            patch("server._exact_conversation_snapshot", return_value=frozen) as snapshot,
        ):
            response = export_conversation_markdown(CONVERSATION, conversation_ref, self.identity)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.media_type, "text/markdown; charset=utf-8")
        self.assertIn(b"Exact $\\LaTeX$ and Markdown.", response.body)
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertRegex(response.headers["x-content-sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(response.headers["x-content-sha256"], hashlib.sha256(response.body).hexdigest())
        self.assertEqual(response.headers["etag"], f'"sha256-{response.headers["x-content-sha256"]}"')
        self.assertEqual(int(response.headers["content-length"]), len(response.body))
        self.assertIn("Exact-synthesis--aaaaaaaaaaaa.md", response.headers["content-disposition"])
        self.assertTrue(load.call_args.kwargs["for_share"])
        self.assertEqual(snapshot.call_args.args[2].wire, conversation_ref)
        self.assertEqual([statement for statement, _ in cursor.statements], ["BEGIN", "COMMIT"])

    def test_exact_historical_loader_normalizes_uuid_case_and_proves_complete_prefix(self):
        lowercase_id = "3abcdef0-0000-4000-8000-000000000001"
        uppercase_id = lowercase_id.upper()
        conversation_ref = (
            f"gb:object:v1:chat:{uppercase_id}:pinned:sha256%3A{'a' * 64}"
        )
        turn_id = "40000000-0000-4000-8000-000000000001"
        cursor = Cursor([
            {"version": 2, "content_hash": HASH},
            {"turn_count": 1, "published_bytes": 7},
            [{
                "id": turn_id,
                "ordinal": 1,
                "role": "user",
                "content": "Exact.",
                "content_hash": f"sha256:{'b' * 64}",
            }],
            [],
        ])
        from conversation_dag import exact_reference
        parsed = exact_reference(conversation_ref, "chat", lowercase_id, "conversation_ref")
        result = _exact_conversation_snapshot(cursor, {**self.conversation, "id": lowercase_id}, parsed)
        self.assertEqual(result["ref"], conversation_ref)
        self.assertEqual(result["version"], 2)
        statements = "\n".join(statement for statement, _ in cursor.statements)
        self.assertIn("COUNT(*) AS turn_count", statements)
        self.assertIn("octet_length(revision.content)", statements)


if __name__ == "__main__":
    unittest.main()
