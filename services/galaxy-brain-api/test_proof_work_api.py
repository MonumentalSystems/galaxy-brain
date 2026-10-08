import asyncio
import base64
import hashlib
import inspect
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import HTTPException, Request
from pydantic import ValidationError

from server import (
    IdentityContext,
    ProofCoordinationTaskBindingBulk,
    ProofCoordinationTaskBindingItem,
    ProofWorkspaceCreate,
    ProofWorkTransition,
    create_proof_workspace,
    list_proof_workspaces,
    _proof_state_response,
    _proof_workspace_or_404,
    bind_proof_coordination_tasks,
    transition_proof_work_item,
    verify_proof_work_item,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
WORKSPACE_DB_ID = "30000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64
GRAPH_HASH = "b" * 64
REQUEST_HASH = "c" * 64


def workspace(version=1):
    return {
        "id": WORKSPACE_DB_ID,
        "tenant_id": TENANT,
        "workspace_key": "workspace-1",
        "graph_id": "graph-1",
        "graph_content_sha256": GRAPH_HASH,
        "node_ids": ["node-1"],
        "current_version": version,
        "updated_at": datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc),
    }


class ProofTransitionCursor:
    def __init__(
        self, *, current_workspace_version=1, replay=False,
        activation_backed=False, claimable=True,
    ):
        self.workspace = workspace(current_workspace_version)
        self.replay = replay
        self.next_row = None
        self.rows = []
        self.item_state = None
        self.item_rows = {}
        self.queries = []
        self.activation_backed = activation_backed
        self.claimable = claimable

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        self.next_row = None
        self.rows = []
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            return
        if normalized.startswith("SELECT * FROM gb_proof_workspaces"):
            self.next_row = self.workspace.copy()
        elif normalized.startswith("SELECT workspace_id, request_hash"):
            self.next_row = (
                {"workspace_id": WORKSPACE_DB_ID, "request_hash": REQUEST_HASH}
                if self.replay else None
            )
        elif normalized.startswith("SELECT * FROM gb_proof_work_items"):
            self.next_row = self.item_rows.get(params[1])
            if self.next_row is None and self.item_state is not None:
                self.next_row = {
                    "current_version": self.item_state.get("version", 1),
                    "state": self.item_state,
                }
        elif normalized.startswith("SELECT activation.id AS activation_id"):
            self.next_row = ({
                "activation_id": "activation-1",
                "node_id": "node-1",
                "claimable": self.claimable,
            } if self.activation_backed else None)
        elif normalized.startswith("INSERT INTO gb_proof_work_items"):
            self.item_state = params[4].adapted
            self.item_rows[params[2]] = {
                "current_version": params[3],
                "state": self.item_state,
            }
            self.next_row = {"id": "item-1"}
        elif normalized.startswith("UPDATE gb_proof_workspaces"):
            self.workspace["current_version"] = params[0]
            self.workspace["updated_at"] = datetime(2026, 9, 13, 12, 1, tzinfo=timezone.utc)
            self.next_row = self.workspace.copy()
        elif normalized.startswith("INSERT INTO gb_proof_work_transitions"):
            self.next_row = {"id": "transition-1"}
        elif normalized.startswith("SELECT item.state,"):
            self.rows = ([{
                "state": self.item_state,
                "trusted_verification": False,
            }] if self.item_state else [])
        else:
            raise AssertionError(f"unexpected SQL: {normalized}")

    def fetchone(self):
        return self.next_row

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class WorkspaceListCursor:
    def __init__(self, count=3):
        self.count = count
        self.rows = []
        self.parameters = None
        self.query = ""

    def execute(self, query, params=None):
        self.query = " ".join(query.split())
        self.parameters = params
        self.rows = [{
            "workspace_key": f"workspace-{index}",
            "current_version": index + 1,
            "updated_at": datetime(2026, 9, 23, 12, index, tzinfo=timezone.utc),
            "item_count": index,
        } for index in range(self.count)]

    def fetchone(self):
        return None

    def fetchall(self):
        return self.rows


class ProofWorkApiTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "agent", PUBKEY)
        self.request = ProofWorkTransition(
            graph_ref={"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            node_id="node-1",
            expected_version=1,
            expected_item_version=0,
            transition={"type": "claim.acquire", "payload": {"lease_seconds": 300}},
            idempotency_key="claim-node-1-request",
        )

    def _coordination_binding(self, **updates):
        value = {
            "program_id": "graph-1",
            "packet_id": "node-1",
            "task_id": "task-1",
            "resource_ref": f"proof-packet:sha256:{GRAPH_HASH}/graph-1/node-1",
            "assignment_sha256": "1" * 64,
            "transition_sha256": "2" * 64,
            "state": "dispatched",
            "dispatch_id": "dispatch-1",
            "dispatch_sequence": 1,
            "directive_sha256": "3" * 64,
            "projection_sha256": "4" * 64,
        }
        value.update(updates)
        return value

    def _bulk_request(self, *bindings, expected_version=1):
        return ProofCoordinationTaskBindingBulk(
            graph_ref={"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            expected_version=expected_version,
            bindings=[
                ProofCoordinationTaskBindingItem(
                    node_id=binding["packet_id"],
                    expected_item_version=0,
                    binding=binding,
                )
                for binding in bindings
            ],
            idempotency_key="bind-complete-projection-request",
        )

    def test_dedicated_coordination_binding_appends_without_changing_work_truth(self):
        cursor = ProofTransitionCursor()
        request = ProofCoordinationTaskBindingBulk(
            graph_ref={"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            expected_version=1,
            bindings=[ProofCoordinationTaskBindingItem(
                node_id="node-1",
                expected_item_version=0,
                binding=self._coordination_binding(),
            )],
            idempotency_key="bind-node-1-request",
        )
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ):
            result = bind_proof_coordination_tasks("workspace-1", request, self.identity)

        item = result["items"][0]
        self.assertEqual(result["version"], 2)
        self.assertEqual(item["work"]["task_id"], "task-1")
        self.assertEqual(item["work"]["linked_task_count"], 1)
        self.assertEqual(item["work"]["status"], "idle")
        self.assertIsNone(item["work"]["claim"])
        self.assertIsNone(item["work"]["hyades"])
        self.assertEqual(item["proof"]["status"], "open")
        self.assertEqual(item["external"]["hyades_task_binding"]["dispatch_sequence"], 1)
        self.assertEqual(result["applied_count"], 1)
        self.assertEqual(result["replayed_count"], 0)

    def test_bulk_binding_replay_is_write_free_even_after_workspace_version_advances(self):
        binding = self._coordination_binding()
        cursor = ProofTransitionCursor(current_workspace_version=2)
        cursor.item_rows["node-1"] = {
            "current_version": 1,
            "state": {
                "node_id": "node-1",
                "version": 1,
                "work": {
                    "status": "idle", "claim": None, "hyades": None, "blocker": None,
                    "task_id": "task-1", "linked_task_count": 1,
                },
                "proof": {"status": "open", "candidate_sha256": None, "verification": None},
                "external": {"hyades_task_binding": binding},
            },
        }
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = bind_proof_coordination_tasks(
                "workspace-1", self._bulk_request(binding), self.identity,
            )
        self.assertTrue(result["replayed"])
        self.assertEqual(result["applied_count"], 0)
        self.assertEqual(result["replayed_count"], 1)
        self.assertFalse(any(query.startswith("INSERT INTO") for query in cursor.queries))

    def test_bulk_binding_preflight_rolls_back_every_item_on_late_cas_failure(self):
        first = self._coordination_binding()
        second = self._coordination_binding(
            packet_id="node-2",
            task_id="task-2",
            resource_ref=f"proof-packet:sha256:{GRAPH_HASH}/graph-1/node-2",
            dispatch_sequence=2,
        )
        cursor = ProofTransitionCursor()
        cursor.workspace["node_ids"] = ["node-1", "node-2"]
        cursor.item_rows["node-2"] = {
            "current_version": 1,
            "state": {
                "node_id": "node-2", "version": 1,
                "work": {"status": "idle", "claim": None, "hyades": None, "blocker": None},
                "proof": {"status": "open", "candidate_sha256": None, "verification": None},
                "external": {},
            },
        }
        with patch("server.get_conn", return_value=Connection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            bind_proof_coordination_tasks(
                "workspace-1", self._bulk_request(first, second), self.identity,
            )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(any(query.startswith("INSERT INTO") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_bulk_binding_rejects_unknown_workspace_membership_before_item_writes(self):
        binding = self._coordination_binding(
            packet_id="node-2",
            task_id="task-2",
            resource_ref=f"proof-packet:sha256:{GRAPH_HASH}/graph-1/node-2",
        )
        cursor = ProofTransitionCursor()
        with patch("server.get_conn", return_value=Connection(cursor)), self.assertRaises(
            HTTPException
        ) as caught:
            bind_proof_coordination_tasks(
                "workspace-1", self._bulk_request(binding), self.identity,
            )
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(any(query.startswith("INSERT INTO") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_bulk_binding_rejects_1001_items_before_opening_a_transaction(self):
        binding = self._coordination_binding()
        request = ProofCoordinationTaskBindingBulk(
            graph_ref={"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            expected_version=1,
            bindings=[ProofCoordinationTaskBindingItem(
                node_id="node-1",
                expected_item_version=0,
                binding=binding,
            ) for _ in range(1_001)],
            idempotency_key="bind-oversized-projection",
        )
        with self.assertRaises(HTTPException) as caught:
            bind_proof_coordination_tasks("workspace-1", request, self.identity)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("1-1000", caught.exception.detail)

    def test_workspace_lookup_is_tenant_scoped(self):
        cursor = ProofTransitionCursor()
        result = _proof_workspace_or_404("workspace-1", TENANT, cur=cursor, for_update=True)
        self.assertEqual(result["tenant_id"], TENANT)
        query = cursor.queries[0]
        self.assertIn("tenant_id = %s AND workspace_key = %s", query)

    def test_transition_locks_versions_and_appends_before_returning_snapshot(self):
        cursor = ProofTransitionCursor(activation_backed=True)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ):
            result = transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertEqual(result["version"], 2)
        self.assertEqual(result["items"][0]["version"], 1)
        self.assertEqual(result["items"][0]["work"]["claim"]["nostr_pubkey"], PUBKEY)
        self.assertIn("FOR UPDATE", cursor.queries[1])
        transition_insert = next(
            query for query in cursor.queries if query.startswith("INSERT INTO gb_proof_work_transitions")
        )
        self.assertIn("prior_state", transition_insert)
        self.assertIn("next_state", transition_insert)
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_claim_rejects_workspace_without_mission_activation(self):
        cursor = ProofTransitionCursor(activation_backed=False)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ), self.assertRaises(HTTPException) as caught:
            transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("activated proof mission", caught.exception.detail)
        self.assertFalse(any(query.startswith("INSERT INTO") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_transition_request_rejects_unknown_fields(self):
        payload = self.request.model_dump()
        payload["actor_nostr_pubkey"] = "f" * 64
        with self.assertRaises(ValidationError):
            ProofWorkTransition(**payload)
        payload = self.request.model_dump()
        payload["graph_ref"]["actor_nostr_pubkey"] = "f" * 64
        with self.assertRaises(ValidationError):
            ProofWorkTransition(**payload)

    def test_stale_workspace_version_rolls_back_without_item_write(self):
        cursor = ProofTransitionCursor(current_workspace_version=2)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ), self.assertRaises(HTTPException) as caught:
            transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse(any(query.startswith("INSERT INTO gb_proof_work_items") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_activation_backed_claim_requires_verified_prerequisites(self):
        cursor = ProofTransitionCursor(activation_backed=True, claimable=False)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ), self.assertRaises(HTTPException) as caught:
            transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("prerequisites", caught.exception.detail)
        self.assertFalse(any(
            query.startswith("INSERT INTO gb_proof_work_items")
            for query in cursor.queries
        ))
        self.assertEqual(cursor.queries[-1], "ROLLBACK")

    def test_activation_backed_frontier_node_can_be_claimed(self):
        cursor = ProofTransitionCursor(activation_backed=True, claimable=True)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ):
            result = transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertEqual(result["items"][0]["work"]["status"], "claimed")

    def test_explicit_override_releases_activation_backed_dependents(self):
        source = inspect.getsource(transition_proof_work_item)
        self.assertIn(
            "FROM gb_proof_work_verifications AS verification",
            source,
        )
        self.assertIn("initial_proof_status <> 'verified'", source)
        self.assertIn("<> 'overridden'", source)

    def test_unledgered_legacy_verification_is_quarantined_from_projection(self):
        state = {
            "node_id": "node-1",
            "version": 1,
            "work": {"status": "closed"},
            "proof": {
                "status": "verified",
                "candidate_sha256": "e" * 64,
                "verification": {"outcome": "accepted", "solution_sha256": "e" * 64},
            },
            "external": {},
        }

        class ProjectionCursor:
            def __init__(self, trusted):
                self.trusted = trusted

            def execute(self, query, params=None):
                self.query = " ".join(query.split())

            def fetchall(self):
                return [{"state": state, "trusted_verification": self.trusted}]

        quarantined = _proof_state_response(workspace(), cur=ProjectionCursor(False))
        self.assertEqual(quarantined["items"][0]["proof"]["status"], "candidate")
        self.assertIsNone(quarantined["items"][0]["proof"]["verification"])
        self.assertEqual(quarantined["items"][0]["work"]["status"], "blocked")
        self.assertIn("supersede", quarantined["items"][0]["work"]["blocker"])
        trusted = _proof_state_response(workspace(), cur=ProjectionCursor(True))
        self.assertEqual(trusted["items"][0]["proof"]["status"], "verified")

    def test_exact_idempotent_replay_performs_no_write(self):
        cursor = ProofTransitionCursor(replay=True)
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._surface_request_hash", return_value=REQUEST_HASH
        ):
            result = transition_proof_work_item("workspace-1", self.request, self.identity)

        self.assertTrue(result["replayed"])
        self.assertFalse(any(query.startswith("INSERT INTO gb_proof_work_items") for query in cursor.queries))
        self.assertEqual(cursor.queries[-1], "COMMIT")

    def test_mutation_rejects_identity_without_nostr_proof(self):
        identity = IdentityContext(TENANT, PRINCIPAL, "human", None)
        with self.assertRaises(HTTPException) as caught:
            transition_proof_work_item("workspace-1", self.request, identity)
        self.assertEqual(caught.exception.status_code, 403)

    def test_generic_transition_cannot_establish_or_reject_proof_truth(self):
        verification = {
            "method": "lean-replay",
            "receipt_id": "receipt-1",
            "receipt_sha256": "d" * 64,
            "outcome": "accepted",
            "solution_sha256": "e" * 64,
            "source_commit": "f" * 40,
            "lean_toolchain": "leanprover/lean4:v4.30.0",
            "mathlib_revision": "a" * 40,
            "sorry_free": True,
            "verified_at": "2026-09-13T12:00:00Z",
        }
        for transition_type, outcome in (
            ("proof.verify", "accepted"),
            ("proof.reject", "rejected"),
        ):
            request = self.request.model_copy(update={
                "transition": {
                    "type": transition_type,
                    "payload": {"verification": {**verification, "outcome": outcome}},
                },
            })
            with patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
                transition_proof_work_item("workspace-1", request, self.identity)
            self.assertEqual(caught.exception.status_code, 422)
            self.assertIn("trusted verifier endpoint", caught.exception.detail)
            get_conn.assert_not_called()

    def test_generic_transition_cannot_bind_coordination_tasks(self):
        request = self.request.model_copy(update={
            "transition": {
                "type": "coordination.task.bind",
                "payload": {"binding": self._coordination_binding()},
            },
        })
        with patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
            transition_proof_work_item("workspace-1", request, self.identity)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("dedicated trusted endpoint", caught.exception.detail)
        get_conn.assert_not_called()

    def _verification_request(self, *, node_id="node-1", extra=None):
        receipt = b'{"provider":"hyades","receipt":"opaque"}'
        body = {
            "schema_id": "galaxy.trusted-proof-verification-request.v1",
            "graph_ref": {"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            "node_id": node_id,
            "candidate_sha256": "e" * 64,
            "expected_workspace_version": 1,
            "expected_item_version": 0,
            "idempotency_key": "verify-node-1-request",
            "receipt": {
                "adapter_id": "hyades",
                "adapter_version": "1",
                "media_type": "application/json",
                "content_encoding": "base64",
                "content_sha256": hashlib.sha256(receipt).hexdigest(),
                "content_base64": base64.b64encode(receipt).decode("ascii"),
            },
        }
        body.update(extra or {})
        content = json.dumps(body, separators=(",", ":")).encode("utf-8")
        delivered = False

        async def receive():
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": content, "more_body": False}

        return Request({"type": "http", "method": "POST", "path": "/"}, receive)

    def test_trusted_verifier_endpoint_is_explicit_and_fail_closed_without_adapter(self):
        with patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
            asyncio.run(verify_proof_work_item(
                "workspace-1", "node-1", self._verification_request(), self.identity,
            ))
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("disabled", caught.exception.detail)
        self.assertEqual(caught.exception.headers, {"Retry-After": "60"})
        get_conn.assert_not_called()

    def test_trusted_verifier_endpoint_rejects_caller_authored_truth_and_path_mismatch(self):
        cases = (
            (self._verification_request(extra={"outcome": "accepted"}), "node-1", "unknown field"),
            (self._verification_request(node_id="node-2"), "node-1", "does not match"),
        )
        for request, route_node_id, message in cases:
            with self.subTest(message=message), patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
                asyncio.run(verify_proof_work_item(
                    "workspace-1", route_node_id, request, self.identity,
                ))
            self.assertEqual(caught.exception.status_code, 422)
            self.assertIn(message, caught.exception.detail)
            get_conn.assert_not_called()

    def _create_request(self, node_ids=None):
        return ProofWorkspaceCreate(
            workspace_id="workspace-new",
            graph_ref={"graph_id": "graph-1", "content_sha256": GRAPH_HASH},
            node_ids=node_ids or ["node-1"],
            idempotency_key="workspace-create-request",
        )

    def test_workspace_activation_fails_closed_until_a_baseline_is_bound(self):
        with patch("server.get_conn") as get_conn, self.assertRaises(HTTPException) as caught:
            create_proof_workspace(self._create_request(), self.identity)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("explicit accepted proof baseline", caught.exception.detail)
        self.assertIn("inactive", caught.exception.detail)
        get_conn.assert_not_called()

    def test_workspace_summary_discovery_is_exact_bounded_and_does_not_merge(self):
        cursor = WorkspaceListCursor()
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = list_proof_workspaces(
                "graph-1", GRAPH_HASH, limit=2, offset=5, identity=self.identity,
            )
        self.assertEqual([item["workspace_id"] for item in result["workspaces"]], [
            "workspace-0", "workspace-1",
        ])
        self.assertTrue(result["has_more"])
        self.assertEqual(result["next_offset"], 7)
        self.assertIn("JOIN gb_proof_graphs AS graph", cursor.query)
        self.assertEqual(cursor.parameters, (TENANT, "graph-1", GRAPH_HASH, 3, 5))


if __name__ == "__main__":
    unittest.main()
