import math
import unittest

from task_plan_contract import TaskPlanContractError, validate_task_plan_spec


def valid_plan():
    return {
        "schema": "gb.task-plan.v1",
        "task": {"kind": "galaxy.ham.task", "id": "task-42", "version": 3},
        "goal": "Compare the evidence, challenge the premise, and synthesize a durable artifact.",
        "nodes": [
            {
                "id": "context",
                "kind": "context",
                "title": "Source context",
                "goal": "Collect bounded references.",
                "position": {"x": 0, "y": 0},
                "config": {"inputRefs": ["paper:123"]},
            },
            {
                "id": "challenge",
                "kind": "challenge",
                "title": "Challenge assumptions",
                "goal": "Look for disconfirming evidence.",
                "position": {"x": 320, "y": 0},
                "config": {"requiresApproval": True, "capabilities": ["web:read"]},
            },
            {
                "id": "artifact",
                "kind": "artifact",
                "title": "Research brief",
                "goal": "Create a cited Markdown brief.",
                "position": {"x": 640, "y": 0},
                "config": {"artifactType": "text/markdown"},
            },
        ],
        "edges": [
            {"id": "context-challenge", "source": "context", "target": "challenge", "kind": "evidence"},
            {"id": "challenge-artifact", "source": "challenge", "target": "artifact", "kind": "control"},
        ],
    }


class TaskPlanContractTests(unittest.TestCase):
    def test_accepts_provider_neutral_dag(self):
        candidate = valid_plan()
        self.assertEqual(validate_task_plan_spec(candidate), candidate)

    def test_rejects_provider_code_and_unknown_config(self):
        candidate = valid_plan()
        candidate["nodes"][0]["config"]["javascript"] = "fetch('https://example.com')"
        with self.assertRaisesRegex(TaskPlanContractError, "unsupported properties"):
            validate_task_plan_spec(candidate)

    def test_rejects_cycles_and_unknown_references(self):
        cyclic = valid_plan()
        cyclic["edges"].append({
            "id": "artifact-context",
            "source": "artifact",
            "target": "context",
            "kind": "control",
        })
        with self.assertRaisesRegex(TaskPlanContractError, "acyclic"):
            validate_task_plan_spec(cyclic)

        missing = valid_plan()
        missing["edges"][0]["target"] = "missing"
        with self.assertRaisesRegex(TaskPlanContractError, "unknown node"):
            validate_task_plan_spec(missing)

    def test_rejects_non_finite_positions_and_unbounded_graphs(self):
        candidate = valid_plan()
        candidate["nodes"][0]["position"]["x"] = math.inf
        with self.assertRaisesRegex(TaskPlanContractError, "finite JSON"):
            validate_task_plan_spec(candidate)

        candidate = valid_plan()
        candidate["nodes"] = candidate["nodes"] * 50
        with self.assertRaisesRegex(TaskPlanContractError, "1-128"):
            validate_task_plan_spec(candidate)

    def test_executor_profile_honors_200_character_boundary(self):
        boundary = valid_plan()
        boundary["nodes"][0]["config"]["executorProfile"] = "x" * 200
        self.assertEqual(validate_task_plan_spec(boundary), boundary)

        oversized = valid_plan()
        oversized["nodes"][0]["config"]["executorProfile"] = "x" * 201
        with self.assertRaisesRegex(TaskPlanContractError, "0-200"):
            validate_task_plan_spec(oversized)


if __name__ == "__main__":
    unittest.main()
