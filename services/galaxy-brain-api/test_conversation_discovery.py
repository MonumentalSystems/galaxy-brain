import base64
import json
import unittest
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

from fastapi import HTTPException

from conversation_dag import (
    ConversationContractError,
    build_list_response,
    build_turn_resolution,
    decode_list_cursor,
    encode_list_cursor,
)
from server import IdentityContext, get_conversation_turn, list_conversations


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
CONVERSATION_ID = "30000000-0000-4000-8000-000000000001"
TURN_ID = "40000000-0000-4000-8000-000000000001"
OTHER_TURN_ID = "40000000-0000-4000-8000-000000000002"
INTRO_HASH = f"sha256:{'a' * 64}"
TURN_HASH = f"sha256:{'b' * 64}"
CONTAINING_HASH = f"sha256:{'c' * 64}"
SNAPSHOT = "100:200:101,102"
ISSUED_AT = datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
CURSOR_SECRET = "conversation-test-proxy-secret"


def reference(kind, identifier, revision):
    return f"gb:object:v1:{kind}:{identifier}:pinned:{revision.replace(':', '%3A')}"


class Cursor:
    def __init__(self, rows=None, turn=None):
        self.rows = rows or []
        self.turn = turn
        self.current = None
        self.executions = []

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if normalized.startswith("SELECT pg_current_snapshot()"):
            self.current = {"snapshot": SNAPSHOT, "issued_at": ISSUED_AT}
        elif "FROM gb_conversations AS conversation" in normalized and "turn.id AS turn_id" in normalized:
            self.current = self.turn
        else:
            self.current = None

    def fetchone(self):
        return self.current

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


@contextmanager
def transaction(connection):
    yield connection.cursor()


class ConversationDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "human")

    @staticmethod
    def summary_row(identifier=CONVERSATION_ID):
        return {
            "id": identifier,
            "workspace_id": "research",
            "title": "A bounded conversation",
            "goal": "Compare the two exact proof strategies.\nWithout returning transcript bodies.",
            "artifact_refs": [reference("artifact", "result", f"sha256:{'c' * 64}")],
            "created_at": "2026-09-24T00:00:00+00:00",
            "snapshot_version": 3,
            "snapshot_content_hash": INTRO_HASH,
            "snapshot_updated_at": "2026-09-25T00:00:00+00:00",
        }

    @staticmethod
    def turn_row(*, containing_version=5, containing_hash=CONTAINING_HASH):
        return {
            "id": CONVERSATION_ID,
            "workspace_id": "research",
            "turn_id": TURN_ID,
            "ordinal": 2,
            "introduced_in_version": 3,
            "role": "assistant",
            "content": "The exact bounded turn body.",
            "artifact_refs": [],
            "provenance": {"provider": "galaxy.conversation"},
            "content_hash": TURN_HASH,
            "created_at": "2026-09-25T00:00:00+00:00",
            "introducing_content_hash": INTRO_HASH,
            "containing_version": containing_version,
            "containing_content_hash": containing_hash,
        }

    def test_cursor_is_canonical_bounded_and_round_trips_snapshot(self):
        cursor = encode_list_cursor(
            SNAPSHOT, ISSUED_AT, CONVERSATION_ID, TENANT_ID, "research", CURSOR_SECRET,
        )
        decoded = decode_list_cursor(cursor, CURSOR_SECRET, now=ISSUED_AT)
        self.assertEqual(decoded["snapshot"], SNAPSHOT)
        self.assertEqual(decoded["issued_at_text"], ISSUED_AT)
        self.assertEqual(decoded["after_id"], CONVERSATION_ID)
        self.assertEqual(decoded["tenant_id"], TENANT_ID)
        self.assertEqual(decoded["workspace_id"], "research")
        for invalid in ("not-base64!", "e30", cursor + "="):
            with self.subTest(cursor=invalid), self.assertRaises(ConversationContractError):
                decode_list_cursor(invalid, CURSOR_SECRET, now=ISSUED_AT)
        oversized = "x" * 8_193
        with self.assertRaises(ConversationContractError):
            decode_list_cursor(oversized, CURSOR_SECRET, now=ISSUED_AT)

    def test_cursor_signature_is_verified_before_any_payload_field_is_trusted(self):
        cursor = encode_list_cursor(
            SNAPSHOT, ISSUED_AT, CONVERSATION_ID, TENANT_ID, "research", CURSOR_SECRET,
        )
        version, encoded, signature = cursor.split(".")
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        mutations = {
            "schemaId": "gb.conversation.cursor.v999",
            "snapshot": "1:2:",
            "issuedAt": "2000-01-01T00:00:00.000000Z",
            "afterId": OTHER_TURN_ID,
            "tenantId": "10000000-0000-4000-8000-000000000002",
            "workspaceId": "other-workspace",
        }
        for field, replacement in mutations.items():
            changed = {**payload, field: replacement}
            changed_encoded = base64.urlsafe_b64encode(
                json.dumps(changed, sort_keys=True, separators=(",", ":")).encode()
            ).decode().rstrip("=")
            with self.subTest(field=field), self.assertRaisesRegex(
                ConversationContractError, "cursor is invalid",
            ):
                decode_list_cursor(
                    f"{version}.{changed_encoded}.{signature}", CURSOR_SECRET, now=ISSUED_AT,
                )
        changed_signature = signature[:-1] + ("A" if signature[-1] != "A" else "B")
        with self.assertRaisesRegex(ConversationContractError, "cursor is invalid"):
            decode_list_cursor(
                f"{version}.{encoded}.{changed_signature}", CURSOR_SECRET, now=ISSUED_AT,
            )
        with self.assertRaisesRegex(ConversationContractError, "cursor is invalid"):
            decode_list_cursor(
                f"v999.{encoded}.{signature}", CURSOR_SECRET, now=ISSUED_AT,
            )

    def test_cursor_has_a_strict_fifteen_minute_ttl_and_future_skew(self):
        now = datetime(2026, 9, 25, 12, 30, tzinfo=UTC)
        valid_at = now - timedelta(seconds=900)
        expired_at = now - timedelta(seconds=901)
        future_at = now + timedelta(seconds=31)
        for issued_at, valid in ((valid_at, True), (expired_at, False), (future_at, False)):
            cursor = encode_list_cursor(
                SNAPSHOT, issued_at, CONVERSATION_ID, TENANT_ID, None, CURSOR_SECRET,
            )
            if valid:
                decode_list_cursor(cursor, CURSOR_SECRET, now=now)
            else:
                with self.assertRaisesRegex(ConversationContractError, "cursor has expired"):
                    decode_list_cursor(cursor, CURSOR_SECRET, now=now)

    def test_collection_summaries_exclude_transcript_bodies_and_pin_revisions(self):
        result = build_list_response(
            [self.summary_row()], snapshot=SNAPSHOT, issued_at=ISSUED_AT, tenant_id=TENANT_ID,
            workspace="research", cursor_secret=CURSOR_SECRET, limit=1, has_more=True,
        )
        self.assertEqual(result["schemaId"], "gb.conversation.collection.v1")
        self.assertEqual(result["conversations"][0]["version"], 3)
        self.assertEqual(result["conversations"][0]["turnCount"], 2)
        self.assertEqual(result["conversations"][0]["contentHash"], INTRO_HASH)
        self.assertNotIn("turns", json.dumps(result))
        self.assertNotIn("The exact bounded turn body", json.dumps(result))
        self.assertIsNotNone(result["continuation"]["cursor"])

    def test_discovery_query_is_tenant_scoped_snapshot_pinned_and_stably_ordered(self):
        cursor = Cursor(rows=[self.summary_row()])
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ), patch("server.PROXY_TOKEN", CURSOR_SECRET):
            result = list_conversations("research", None, 1, self.identity)
        self.assertFalse(result["continuation"]["hasMore"])
        query, parameters = next(
            execution for execution in cursor.executions
            if "WITH visible_creation_candidates" in execution[0]
        )
        self.assertIn("revision.tenant_id = %s", query)
        self.assertIn("pg_visible_in_snapshot", query)
        self.assertIn("revision.xmin::text::xid8", query)
        self.assertIn("WITH visible_creation_candidates AS MATERIALIZED", query)
        self.assertIn("JOIN LATERAL", query)
        self.assertIn("ORDER BY creation.conversation_id DESC", query)
        self.assertLess(query.index("LIMIT %s"), query.index("JOIN LATERAL"))
        self.assertIn("LIMIT 1", query)
        self.assertNotIn("revision.*", query)
        self.assertNotIn("FROM gb_conversations", query)
        self.assertEqual(parameters, (TENANT_ID, SNAPSHOT, "research", 2, TENANT_ID, SNAPSHOT))

    def test_continuation_reuses_opaque_snapshot_and_strict_uuid_cursor(self):
        encoded = encode_list_cursor(
            SNAPSHOT, ISSUED_AT, CONVERSATION_ID, TENANT_ID, None, CURSOR_SECRET,
        )
        cursor = Cursor(rows=[])
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._transaction", transaction,
        ), patch("server.PROXY_TOKEN", CURSOR_SECRET):
            result = list_conversations(None, encoded, 50, self.identity)
        self.assertEqual(result["snapshotAt"], ISSUED_AT)
        self.assertFalse(any("pg_current_snapshot" in query for query, _ in cursor.executions))
        query, parameters = cursor.executions[-1]
        self.assertIn("creation.conversation_id < %s::uuid", query)
        self.assertEqual(parameters[0], TENANT_ID)
        self.assertEqual(
            parameters,
            (TENANT_ID, SNAPSHOT, CONVERSATION_ID, 51, TENANT_ID, SNAPSHOT),
        )

    def test_continuation_cursor_cannot_cross_tenants_or_workspace_filters(self):
        other_tenant = "10000000-0000-4000-8000-000000000002"
        cases = (
            encode_list_cursor(
                SNAPSHOT, ISSUED_AT, CONVERSATION_ID, other_tenant, "research", CURSOR_SECRET,
            ),
            encode_list_cursor(
                SNAPSHOT, ISSUED_AT, CONVERSATION_ID, TENANT_ID, "other-workspace", CURSOR_SECRET,
            ),
        )
        for encoded in cases:
            with self.subTest(cursor=encoded), patch("server.get_conn") as get_conn, patch(
                "server.PROXY_TOKEN", CURSOR_SECRET,
            ):
                with self.assertRaises(HTTPException) as caught:
                    list_conversations("research", encoded, 50, self.identity)
                self.assertEqual(caught.exception.status_code, 422)
                get_conn.assert_not_called()

    def test_exact_turn_resolution_accepts_later_containing_snapshot_and_returns_introduction(self):
        cursor = Cursor(turn=self.turn_row())
        conversation_ref = reference("chat", CONVERSATION_ID, CONTAINING_HASH)
        introducing_ref = reference("chat", CONVERSATION_ID, INTRO_HASH)
        turn_ref = reference("turn", TURN_ID, TURN_HASH)
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = get_conversation_turn(
                CONVERSATION_ID, TURN_ID, conversation_ref, turn_ref, self.identity,
            )
        self.assertEqual(result["conversationRef"], conversation_ref)
        self.assertEqual(result["ref"], turn_ref)
        self.assertEqual(result["introducedIn"]["version"], 3)
        self.assertEqual(result["introducedIn"]["conversationRef"], introducing_ref)
        query, parameters = cursor.executions[-1]
        self.assertIn("conversation.tenant_id = %s", query)
        self.assertIn("introducing_revision.version = turn.introduced_in_version", query)
        self.assertIn("containing_revision.version >= turn.introduced_in_version", query)
        self.assertEqual(
            parameters,
            (CONTAINING_HASH, TENANT_ID, CONVERSATION_ID, TURN_ID),
        )

    def test_turn_resolution_rejects_cross_conversation_wrong_revision_or_too_old_snapshot(self):
        valid_turn = reference("turn", TURN_ID, TURN_HASH)
        cases = (
            (
                reference("chat", CONVERSATION_ID, f"sha256:{'d' * 64}"),
                valid_turn,
                self.turn_row(),
            ),
            (
                reference("chat", CONVERSATION_ID, CONTAINING_HASH),
                reference("turn", TURN_ID, f"sha256:{'e' * 64}"),
                self.turn_row(),
            ),
            (
                reference("chat", CONVERSATION_ID, CONTAINING_HASH),
                reference("turn", OTHER_TURN_ID, TURN_HASH),
                self.turn_row(),
            ),
            (
                reference("chat", CONVERSATION_ID, INTRO_HASH),
                valid_turn,
                self.turn_row(containing_version=2, containing_hash=INTRO_HASH),
            ),
        )
        for conversation_ref, turn_ref, row in cases:
            with self.subTest(conversation_ref=conversation_ref, turn_ref=turn_ref):
                cursor = Cursor(turn=row)
                with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
                    with self.assertRaises(HTTPException) as caught:
                        get_conversation_turn(
                            CONVERSATION_ID, TURN_ID, conversation_ref, turn_ref, self.identity,
                        )
                self.assertEqual(caught.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
