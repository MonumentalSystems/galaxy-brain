import unittest
import hashlib
import json
from copy import deepcopy
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from object_links import ReferentAccess, parse_canonical_reference
from server import (
    IdentityContext,
    TaskPlanProposalCreate,
    propose_task_plan_structure,
)
from task_plan_proposal import (
    TaskPlanProposalError,
    build_task_plan_proposal,
    validate_task_plan_proposal_intent,
)
from test_task_plan_contract import valid_plan


PLAN_ID = "30000000-0000-4000-8000-000000000001"
TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
PINNED_REF = f"gb:object:v1:paper:paper-1:pinned:sha256%3A{'a' * 64}"


def route_request(gateway=True):
    headers = [(b"x-gb-agent-tool-gateway", b"v1")] if gateway else []
    return Request({
        "type": "http", "method": "POST",
        "path": f"/task-plans/{PLAN_ID}/proposals",
        "query_string": b"", "headers": headers,
    })


def proposal_refs(count, offset=0):
    return [
        f"gb:object:v1:paper:proposal-paper-{offset + index}:pinned:sha256%3A{offset + index + 1:064x}"
        for index in range(count)
    ]


def plan():
    return {
        "id": PLAN_ID,
        "tenant_id": TENANT_ID,
        "ham_task_id": "task-42",
        "current_version": 4,
        "current_content_hash": "b" * 64,
        "current_spec": valid_plan(),
    }


def intent(action="compare"):
    sources = ["context", "challenge"] if action in {"join", "compare", "synthesize"} else ["challenge"]
    branches = []
    if action == "branch":
        sources = ["artifact"]
        branches = [
            {
                "kind": "research", "title": "Branch A", "goal": "Research A.",
                "instruction": None, "inputRefs": [PINNED_REF],
            },
            {
                "kind": "challenge", "title": "Branch B", "goal": "Challenge B.",
                "instruction": "Find counterevidence.", "inputRefs": [],
            },
        ]
    return {
        "action": action,
        "expectedVersion": 4,
        "expectedContentHash": "b" * 64,
        "expectedHamTaskId": "task-42",
        "expectedHamTaskVersion": 3,
        "sourceJobIds": sources,
        "title": action.title(),
        "goal": f"Propose {action} work.",
        "instruction": None,
        "inputRefs": [PINNED_REF],
        "branches": branches,
    }


class TaskPlanProposalContractTests(unittest.TestCase):
    def test_request_hash_matches_the_javascript_canonical_fixture(self):
        reference = f"gb:object:v1:paper:paper-1:pinned:sha256%3A{'c' * 64}"
        parity_intent = {
            "action": "compare",
            "expectedVersion": 3,
            "expectedContentHash": "a" * 64,
            "expectedHamTaskId": "ham-task-1",
            "expectedHamTaskVersion": 7,
            "sourceJobIds": ["research", "challenge"],
            "title": "Compare",
            "goal": "Compare the evidence.",
            "instruction": None,
            "inputRefs": [reference],
            "branches": [],
        }
        normalized = validate_task_plan_proposal_intent(parity_intent)
        encoded = json.dumps(
            normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        ).encode("utf-8")
        self.assertEqual(
            hashlib.sha256(encoded).hexdigest(),
            "4195dc5e42219ac876dd78c8ddae997c92651a4e29387a343a0511a8ca2f5ccb",
        )

    def test_builds_every_action_as_a_deterministic_additive_proposal(self):
        for action in ("branch", "join", "compare", "challenge", "synthesize"):
            first = build_task_plan_proposal(PLAN_ID, plan(), intent(action))
            second = build_task_plan_proposal(PLAN_ID, plan(), intent(action))
            self.assertEqual(first, second)
            self.assertEqual(first["effect"], "proposal")
            self.assertEqual(first["scope"], "task-local-work")
            self.assertTrue(all(operation["op"] in {"node.add", "edge.add"} for operation in first["operations"]))
            self.assertEqual(first["base"]["hamTaskVersion"], 3)
            self.assertRegex(first["proposalHash"], r"^sha256:[0-9a-f]{64}$")

    def test_branch_has_explicit_branch_node_and_bounded_arms(self):
        proposal = build_task_plan_proposal(PLAN_ID, plan(), intent("branch"))
        nodes = [operation["node"] for operation in proposal["operations"] if operation["op"] == "node.add"]
        edges = [operation["edge"] for operation in proposal["operations"] if operation["op"] == "edge.add"]
        self.assertEqual(nodes[0]["kind"], "branch")
        self.assertEqual([node["kind"] for node in nodes[1:]], ["research", "challenge"])
        self.assertEqual([edge["kind"] for edge in edges], ["control", "branch", "branch"])

    def test_requires_exact_base_and_pinned_inputs(self):
        stale = intent()
        stale["expectedVersion"] = 3
        with self.assertRaisesRegex(TaskPlanProposalError, "stale"):
            build_task_plan_proposal(PLAN_ID, plan(), stale)

        latest = intent()
        latest["inputRefs"] = ["gb:object:v1:paper:paper-1:latest"]
        with self.assertRaisesRegex(TaskPlanProposalError, "pin an exact revision"):
            validate_task_plan_proposal_intent(latest)

    def test_caps_aggregate_distinct_input_refs_across_branch_arms(self):
        references = proposal_refs(65)
        bounded = intent("branch")
        bounded["inputRefs"] = references[:20]
        bounded["branches"][0]["inputRefs"] = references[20:42]
        bounded["branches"][1]["inputRefs"] = references[42:64]
        normalized = validate_task_plan_proposal_intent(bounded)
        self.assertEqual(len(build_task_plan_proposal(PLAN_ID, plan(), normalized)["inputRefs"]), 64)

        oversized = deepcopy(bounded)
        oversized["branches"][1]["inputRefs"] = references[42:65]
        with self.assertRaisesRegex(TaskPlanProposalError, "64 distinct"):
            validate_task_plan_proposal_intent(oversized)

        duplicate_heavy = deepcopy(bounded)
        duplicate_heavy["inputRefs"] = references[:32]
        duplicate_heavy["branches"][0]["inputRefs"] = references[:64]
        duplicate_heavy["branches"][1]["inputRefs"] = references[32:64]
        normalized = validate_task_plan_proposal_intent(duplicate_heavy)
        self.assertEqual(len(build_task_plan_proposal(PLAN_ID, plan(), normalized)["inputRefs"]), 64)

        duplicate_list = deepcopy(bounded)
        duplicate_list["inputRefs"] = [references[0], references[0]]
        with self.assertRaisesRegex(TaskPlanProposalError, "duplicate"):
            validate_task_plan_proposal_intent(duplicate_list)

    def test_rejects_unknown_sources_and_final_graph_overflow(self):
        missing = intent("challenge")
        missing["sourceJobIds"] = ["missing"]
        with self.assertRaisesRegex(TaskPlanProposalError, "unknown"):
            build_task_plan_proposal(PLAN_ID, plan(), missing)

        full = plan()
        template = valid_plan()["nodes"][0]
        full["current_spec"]["nodes"] = []
        full["current_spec"]["edges"] = []
        for index in range(128):
            node = deepcopy(template)
            node["id"] = f"node-{index}"
            full["current_spec"]["nodes"].append(node)
        oversized = intent("challenge")
        oversized["sourceJobIds"] = ["node-0"]
        with self.assertRaisesRegex(TaskPlanProposalError, "1-128|invalid task plan"):
            build_task_plan_proposal(PLAN_ID, full, oversized)


class Cursor:
    def __init__(self, row):
        self.row = row
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append((" ".join(query.split()), params))

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


class TaskPlanProposalRouteTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT_ID, PRINCIPAL_ID, "agent", "f" * 64)

    def test_route_authorizes_refs_and_never_writes(self):
        cursor = Cursor(plan())

        def authorize(_cur, values, identity):
            return {
                value: ReferentAccess(
                    value, identity.tenant_id, identity.principal_id, True,
                    parse_canonical_reference(value).revision, "test",
                )
                for value in values
            }

        request = TaskPlanProposalCreate(**intent("compare"))
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_references", side_effect=authorize,
        ):
            result = propose_task_plan_structure(PLAN_ID, request, route_request(), self.identity)

        self.assertEqual(result["action"], "compare")
        self.assertEqual(len(cursor.queries), 1)
        self.assertTrue(cursor.queries[0][0].startswith("SELECT * FROM gb_task_plans"))
        self.assertFalse(any("INSERT" in query or "UPDATE" in query or "DELETE" in query for query, _ in cursor.queries))

    def test_route_fails_closed_when_a_reference_is_not_readable(self):
        cursor = Cursor(plan())
        request = TaskPlanProposalCreate(**intent("challenge"))
        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_object_references", return_value={PINNED_REF: None},
        ), self.assertRaises(HTTPException) as caught:
            propose_task_plan_structure(PLAN_ID, request, route_request(), self.identity)
        self.assertEqual(caught.exception.status_code, 404)

    def test_route_requires_the_shared_agent_tool_gateway(self):
        request = TaskPlanProposalCreate(**intent("challenge"))
        with self.assertRaises(HTTPException) as hidden:
            propose_task_plan_structure(PLAN_ID, request, route_request(False), self.identity)
        self.assertEqual(hidden.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
