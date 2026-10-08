import hashlib
import json
import unittest

from agent_result_contract import (
    AgentResultContractError,
    parse_agent_result_decision,
    parse_agent_result_lookup,
    terminal_task_reference,
)


EVIDENCE = "gb:object:v1:document:source-1:pinned:sha256%3A" + "a" * 64


def decision_payload(**updates):
    candidate = {
        "schemaId": "gb.paper-agent-result-candidate.v1",
        "taskId": "task_42",
        "taskVersion": 7,
        "eventId": "91",
        "runId": "run_3",
        "performedByRef": "ham.agent:researcher",
        "occurredAt": "2026-10-03T16:17:18Z",
        "summary": "## Finding\n\nThe evidence supports the result.",
        "evidenceRefs": [EVIDENCE],
    }
    candidate.update({
        key: value for key, value in updates.items()
        if key in candidate
    })
    digest = hashlib.sha256(json.dumps(
        candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")).hexdigest()
    payload = {
        **candidate,
        "schemaId": "gb.paper-agent-result-decision.v1",
        "resultHash": f"sha256:{digest}",
        "action": "accept",
        "idempotencyKey": "agent-result-decision-42",
    }
    payload.update({
        key: value for key, value in updates.items()
        if key not in candidate
    })
    return payload


class AgentResultContractTests(unittest.TestCase):
    def test_parses_the_exact_terminal_candidate_hash_and_preserves_markdown(self):
        parsed = parse_agent_result_decision(decision_payload())

        self.assertEqual(parsed["summary"], "## Finding\n\nThe evidence supports the result.")
        self.assertEqual(parsed["event_id"], "91")
        self.assertEqual(parsed["result_hash_ref"], f"sha256:{parsed['candidate_sha256']}")
        self.assertEqual(
            parsed["terminal_task_ref"],
            terminal_task_reference("task_42", 7),
        )
        self.assertEqual(parsed["occurred_at"], "2026-10-03T16:17:18+00:00")

    def test_rejects_a_tampered_summary_even_when_the_digest_shape_is_valid(self):
        payload = decision_payload()
        payload["summary"] = "Different result"
        with self.assertRaisesRegex(AgentResultContractError, "does not match"):
            parse_agent_result_decision(payload)

    def test_rejects_unpinned_and_duplicate_evidence(self):
        for evidence, message in (
            (["gb:object:v1:document:source-1:latest"], "only pinned"),
            ([EVIDENCE, EVIDENCE], "duplicate"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(
                AgentResultContractError, message,
            ):
                parse_agent_result_decision(decision_payload(evidenceRefs=evidence))

    def test_requires_a_timezone_bearing_completion_timestamp(self):
        with self.assertRaisesRegex(AgentResultContractError, "ISO timestamp"):
            parse_agent_result_decision(decision_payload(occurredAt="2026-10-03T16:17:18"))

    def test_lookup_requires_the_wire_sha256_prefix(self):
        digest = "b" * 64
        parsed = parse_agent_result_lookup("7", "91", f"sha256:{digest}")
        self.assertEqual(parsed["result_sha256"], digest)
        with self.assertRaisesRegex(AgentResultContractError, "sha256 reference"):
            parse_agent_result_lookup("7", "91", digest)


if __name__ == "__main__":
    unittest.main()
