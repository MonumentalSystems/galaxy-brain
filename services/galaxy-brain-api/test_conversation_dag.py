import unittest

from conversation_dag import (
    ConversationContractError,
    build_read_projection,
    next_content_hash,
    normalize_create,
    normalize_turn_operation,
)


TENANT = "10000000-0000-4000-8000-000000000001"
CONVERSATION = "30000000-0000-4000-8000-000000000001"
TURN_A = "40000000-0000-4000-8000-000000000001"
TURN_B = "40000000-0000-4000-8000-000000000002"
DIGEST_A = f"sha256:{'a' * 64}"
DIGEST_B = f"sha256:{'b' * 64}"


def create_payload(**overrides):
    return {
        "workspace_id": "research-main",
        "title": "Durable synthesis",
        "goal": "Reconcile the cited mechanisms.",
        "artifact_refs": [f"gb:object:v1:document:doc-1:pinned:sha256%3A{'c' * 64}"],
        "provenance": {"provider": "galaxy", "statement": "User-authored goal."},
        "idempotency_key": "conversation-create-1",
        **overrides,
    }


def mutation(**overrides):
    return {
        "expected_version": 1,
        "parent_turn_id": None,
        "message": {"role": "user", "content": "Compare the pinned evidence."},
        "artifact_refs": [],
        "provenance": {"provider": "galaxy"},
        "idempotency_key": "conversation-append-1",
        **overrides,
    }


class ConversationDagContractTests(unittest.TestCase):
    def test_create_is_strict_bounded_and_deterministically_hashed(self):
        first = normalize_create(create_payload())
        second = normalize_create(create_payload())
        self.assertEqual(first, second)
        self.assertRegex(first["request_hash"], r"^[0-9a-f]{64}$")
        self.assertRegex(first["content_hash"], r"^sha256:[0-9a-f]{64}$")

        for invalid in [
            create_payload(extra=True),
            create_payload(workspace_id="../other"),
            create_payload(goal=""),
            create_payload(provenance={"rawLog": "private trace"}),
            create_payload(artifact_refs=["https://example.test/not-canonical"]),
            create_payload(artifact_refs=["gb:object:v1:document:doc-1:latest"]),
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ConversationContractError):
                normalize_create(invalid)

    def test_append_fork_and_join_enforce_explicit_parent_shapes(self):
        root = normalize_turn_operation("continues", mutation())
        self.assertEqual(root["parent_turn_ids"], [])

        fork = normalize_turn_operation("forks", {
            **mutation(),
            "parent_turn_id": TURN_A,
            "idempotency_key": "conversation-fork-1",
        })
        self.assertEqual(fork["parent_turn_ids"], [TURN_A])

        join_payload = mutation()
        join_payload.pop("parent_turn_id")
        join_payload.update({
            "expected_version": 3,
            "parent_turn_ids": [TURN_A, TURN_B],
            "idempotency_key": "conversation-join-1",
        })
        join = normalize_turn_operation("joins", join_payload)
        self.assertEqual(join["parent_turn_ids"], [TURN_A, TURN_B])

        for edge_kind, invalid in [
            ("forks", mutation()),
            ("joins", {**join_payload, "parent_turn_ids": [TURN_A]}),
            ("joins", {**join_payload, "parent_turn_ids": [TURN_A, TURN_A]}),
            ("continues", mutation(message={"role": "user", "content": "ok", "hidden": True})),
            ("continues", mutation(expected_version=True)),
        ]:
            with self.subTest(edge_kind=edge_kind), self.assertRaises(ConversationContractError):
                normalize_turn_operation(edge_kind, invalid)

    def test_revision_hash_chains_the_previous_aggregate_state(self):
        operation = {"turnId": TURN_A, "parentTurnIds": [], "message": {"role": "user", "content": "Start"}}
        first = next_content_hash(DIGEST_A, 2, "append", operation)
        self.assertNotEqual(first, next_content_hash(DIGEST_B, 2, "append", operation))
        self.assertNotEqual(first, next_content_hash(DIGEST_A, 3, "append", operation))

    def test_read_projection_is_bounded_and_unified_graph_ready(self):
        conversation = {
            "id": CONVERSATION,
            "tenant_id": TENANT,
            "workspace_id": "research-main",
            "title": "Durable synthesis",
            "goal": "Reconcile the mechanisms.",
            "current_version": 3,
            "current_content_hash": DIGEST_A,
            "artifact_refs": [],
            "provenance": {"provider": "galaxy"},
        }
        turns = [
            {
                "id": TURN_A, "ordinal": 1, "role": "user", "content": "Start",
                "artifact_refs": [], "provenance": {}, "content_hash": DIGEST_A,
                "created_at": "2026-09-25T12:00:00Z",
            },
            {
                "id": TURN_B, "ordinal": 2, "role": "assistant", "content": "Continue",
                "artifact_refs": [], "provenance": {}, "content_hash": DIGEST_B,
                "created_at": "2026-09-25T12:01:00Z",
            },
        ]
        edges = [{
            "id": "50000000-0000-4000-8000-000000000001",
            "from_turn_id": TURN_A,
            "to_turn_id": TURN_B,
            "edge_kind": "continues",
            "created_at": "2026-09-25T12:01:00Z",
        }]
        result = build_read_projection(
            conversation, turns, edges, after_ordinal=0, limit=2, has_more=True,
        )
        graph = result["graphProjectionInput"]
        self.assertEqual(graph["query"]["mode"], "conversation")
        self.assertEqual([item["projection"]["kind"] for item in graph["objects"]], ["chat", "turn", "turn"])
        self.assertEqual([item["relation"]["relation"] for item in graph["relations"]], [
            "contains", "contains", "continues",
        ])
        self.assertEqual(result["continuation"]["nextAfterOrdinal"], 2)
        self.assertEqual(result["continuation"]["version"], 3)
        self.assertEqual(result["continuation"]["contentHash"], DIGEST_A)
        self.assertNotIn("logs", str(result).lower())

    def test_cross_page_parent_and_edge_are_preserved_with_child_page(self):
        conversation = {
            "id": CONVERSATION,
            "tenant_id": TENANT,
            "workspace_id": "research-main",
            "title": "Durable synthesis",
            "goal": "Reconcile the mechanisms.",
            "current_version": 3,
            "current_content_hash": DIGEST_A,
            "artifact_refs": [],
            "provenance": {},
        }
        parent = {
            "id": TURN_A, "ordinal": 1, "role": "user", "content": "Start",
            "artifact_refs": [], "provenance": {}, "content_hash": DIGEST_A,
            "created_at": "2026-09-25T12:00:00Z",
        }
        child = {
            "id": TURN_B, "ordinal": 2, "role": "assistant", "content": "Continue",
            "artifact_refs": [], "provenance": {}, "content_hash": DIGEST_B,
            "created_at": "2026-09-25T12:01:00Z",
        }
        edge = {
            "id": "50000000-0000-4000-8000-000000000001",
            "from_turn_id": TURN_A, "to_turn_id": TURN_B, "edge_kind": "continues",
            "created_at": "2026-09-25T12:01:00Z",
        }
        result = build_read_projection(
            conversation, [child], [edge], parent_turns=[parent],
            after_ordinal=1, limit=1, has_more=False,
        )
        self.assertEqual([turn["turnId"] for turn in result["turns"]], [TURN_B])
        self.assertEqual([turn["turnId"] for turn in result["contextTurns"]], [TURN_A])
        self.assertEqual(result["edges"][0]["fromTurnId"], TURN_A)
        self.assertIn(
            "continues",
            [relation["relation"]["relation"] for relation in result["graphProjectionInput"]["relations"]],
        )


if __name__ == "__main__":
    unittest.main()
