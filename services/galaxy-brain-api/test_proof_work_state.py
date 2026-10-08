import unittest
from datetime import datetime, timedelta, timezone

from proof_work_state import (
    ProofWorkStateConflict,
    ProofWorkStateError,
    apply_transition,
)


ACTOR_A = "a" * 64
ACTOR_B = "b" * 64
PRINCIPAL_A = "10000000-0000-4000-8000-000000000001"
NOW = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)
SOLUTION = "c" * 64


def apply(
    current,
    transition,
    actor=ACTOR_A,
    *,
    now=NOW,
    principal_kind="agent",
    role="agent",
):
    return apply_transition(
        current,
        transition,
        actor,
        actor_principal_id=PRINCIPAL_A,
        actor_principal_kind=principal_kind,
        actor_role=role,
        node_id="theorem-a",
        now=now,
        claim_id="claim-1",
    )


def candidate_item():
    return apply(None, {
        "type": "proof.candidate",
        "payload": {"candidate_sha256": SOLUTION},
    })


def verification(solution=SOLUTION, outcome="accepted", sorry_free=True, method="lean-replay"):
    return {
        "method": method,
        "receipt_id": "receipt-1",
        "receipt_sha256": "d" * 64,
        "outcome": outcome,
        "solution_sha256": solution,
        "source_commit": "e" * 40,
        "lean_toolchain": "leanprover/lean4:v4.30.0",
        "mathlib_revision": "f" * 40,
        "sorry_free": sorry_free,
        "verified_at": "2026-09-13T12:00:00Z",
        **({
            "hyades": {
                "workflow_id": "proof-workflow-v1",
                "run_id": "run-1",
                "status": "completed",
            },
        } if method == "hyades-run" else {}),
    }


class ProofWorkStateTests(unittest.TestCase):
    def test_coordination_binding_only_updates_task_projection(self):
        current = candidate_item()
        current["work"].update({
            "status": "blocked",
            "blocker": "Waiting for a source lemma",
            "hyades": None,
        })
        before_work = dict(current["work"])
        before_proof = dict(current["proof"])
        binding = {
            "program_id": "program-a",
            "packet_id": "theorem-a",
            "task_id": "task-1",
            "resource_ref": f"proof-packet:sha256:{'1' * 64}/program-a/theorem-a",
            "assignment_sha256": "2" * 64,
            "transition_sha256": "3" * 64,
            "state": "dispatched",
            "dispatch_id": "dispatch-1",
            "dispatch_sequence": 1,
            "directive_sha256": "4" * 64,
            "projection_sha256": "5" * 64,
        }
        result = apply(current, {
            "type": "coordination.task.bind",
            "payload": {"binding": binding},
        })
        self.assertEqual(result["work"]["task_id"], "task-1")
        self.assertEqual(result["work"]["linked_task_count"], 1)
        for field in ("status", "claim", "hyades", "blocker"):
            self.assertEqual(result["work"][field], before_work[field])
        self.assertEqual(result["proof"], before_proof)
        self.assertEqual(result["external"]["hyades_task_binding"], binding)

        self.assertEqual(apply(result, {
            "type": "coordination.task.bind",
            "payload": {"binding": binding},
        }), result)
        refreshed_projection = {**binding, "projection_sha256": "6" * 64}
        self.assertEqual(apply(result, {
            "type": "coordination.task.bind",
            "payload": {"binding": refreshed_projection},
        }), result)
        changed = {**binding, "task_id": "task-2"}
        with self.assertRaisesRegex(ProofWorkStateConflict, "different binding"):
            apply(result, {
                "type": "coordination.task.bind",
                "payload": {"binding": changed},
            })
        higher = {**binding, "task_id": "task-2", "dispatch_sequence": 2}
        advanced = apply(result, {
            "type": "coordination.task.bind",
            "payload": {"binding": higher},
        })
        self.assertEqual(advanced["work"]["linked_task_count"], 2)
        with self.assertRaisesRegex(ProofWorkStateConflict, "stale"):
            apply(advanced, {
                "type": "coordination.task.bind",
                "payload": {"binding": binding},
            })

    def test_coordination_identifiers_match_hyades_colon_grammar_and_bound(self):
        component = "p:" + ("a" * 118)
        binding = {
            "program_id": component,
            "packet_id": component,
            "task_id": "task-1",
            "resource_ref": f"proof-packet:sha256:{'1' * 64}/{component}/{component}",
            "assignment_sha256": "2" * 64,
            "transition_sha256": "3" * 64,
            "state": "dispatched",
            "dispatch_id": "dispatch-1",
            "dispatch_sequence": 1,
            "directive_sha256": "4" * 64,
            "projection_sha256": "5" * 64,
        }
        result = apply(None, {
            "type": "coordination.task.bind",
            "payload": {"binding": binding},
        })
        self.assertEqual(result["external"]["hyades_task_binding"]["program_id"], component)
        for invalid in (component + "x", "bad/slash"):
            with self.subTest(invalid=invalid), self.assertRaises(ProofWorkStateError):
                apply(None, {
                    "type": "coordination.task.bind",
                    "payload": {"binding": {**binding, "program_id": invalid}},
                })

    def test_claims_are_actor_bound_and_expire(self):
        claimed = apply(None, {
            "type": "claim.acquire",
            "payload": {"lease_seconds": 300},
        })
        self.assertEqual(claimed["work"]["claim"]["nostr_pubkey"], ACTOR_A)
        self.assertEqual(claimed["work"]["claim"]["expires_at"], "2026-09-13T12:05:00Z")

        with self.assertRaises(ProofWorkStateConflict):
            apply(claimed, {
                "type": "claim.acquire",
                "payload": {"lease_seconds": 300},
            }, ACTOR_B)

        reclaimed = apply(
            claimed,
            {"type": "claim.acquire", "payload": {"lease_seconds": 300}},
            ACTOR_B,
            now=NOW + timedelta(minutes=6),
        )
        self.assertEqual(reclaimed["work"]["claim"]["nostr_pubkey"], ACTOR_B)

    def test_only_claim_owner_can_release(self):
        claimed = apply(None, {
            "type": "claim.acquire",
            "payload": {"lease_seconds": 300},
        })
        with self.assertRaises(ProofWorkStateConflict):
            apply(claimed, {"type": "claim.release", "payload": {}}, ACTOR_B)
        released = apply(claimed, {"type": "claim.release", "payload": {}})
        self.assertEqual(released["work"]["status"], "idle")
        self.assertIsNone(released["work"]["claim"])

    def test_active_claim_guards_execution_and_candidate_mutations(self):
        claimed = apply(None, {
            "type": "claim.acquire",
            "payload": {"lease_seconds": 300},
        })
        for transition in [
            {"type": "work.set", "payload": {"status": "blocked"}},
            {"type": "proof.candidate", "payload": {"candidate_sha256": SOLUTION}},
        ]:
            with self.assertRaisesRegex(ProofWorkStateConflict, "claim owner"):
                apply(claimed, transition, ACTOR_B)

    def test_running_claim_can_only_be_renewed_by_its_owner(self):
        claimed = apply(None, {
            "type": "claim.acquire",
            "payload": {"lease_seconds": 300},
        })
        running = apply(claimed, {
            "type": "work.set",
            "payload": {
                "status": "running",
                "hyades": {
                    "workflow_id": "proof-workflow-v1",
                    "run_id": "run-1",
                    "status": "running",
                },
            },
        })
        with self.assertRaisesRegex(ProofWorkStateConflict, "existing claim owner"):
            apply(
                running,
                {"type": "claim.acquire", "payload": {"lease_seconds": 300}},
                ACTOR_B,
                now=NOW + timedelta(minutes=6),
            )
        renewed = apply(
            running,
            {"type": "claim.acquire", "payload": {"lease_seconds": 300}},
            now=NOW + timedelta(minutes=6),
        )
        self.assertEqual(renewed["work"]["status"], "running")
        self.assertEqual(renewed["work"]["claim"]["nostr_pubkey"], ACTOR_A)
        with self.assertRaisesRegex(ProofWorkStateConflict, "running state"):
            apply(renewed, {"type": "claim.release", "payload": {}}, now=NOW + timedelta(minutes=6))

    def test_running_work_requires_a_bounded_hyades_run(self):
        with self.assertRaises(ProofWorkStateError):
            apply(None, {"type": "work.set", "payload": {"status": "running"}})
        running = apply(None, {
            "type": "work.set",
            "payload": {
                "status": "running",
                "hyades": {
                    "workflow_id": "proof-workflow-v1",
                    "run_id": "run-1",
                    "status": "running",
                },
            },
        })
        self.assertEqual(running["work"]["hyades"]["run_id"], "run-1")

    def test_verification_must_bind_to_the_current_candidate(self):
        item = candidate_item()
        with self.assertRaisesRegex(ProofWorkStateConflict, "does not match"):
            apply(item, {
                "type": "proof.verify",
                "payload": {"verification": verification("0" * 64)},
            })
        verified = apply(item, {
            "type": "proof.verify",
            "payload": {"verification": verification()},
        })
        self.assertEqual(verified["proof"]["status"], "verified")
        self.assertEqual(verified["work"]["status"], "closed")
        self.assertEqual(verified["proof"]["verification"]["method"], "lean-replay")
        self.assertEqual(verified["proof"]["verification"]["authority"]["nostr_pubkey"], ACTOR_A)

    def test_candidate_preserves_replay_provenance_and_server_authority(self):
        provenance = {
            "source_commit": "e" * 40,
            "lean_toolchain": "leanprover/lean4:v4.30.0",
            "mathlib_revision": "f" * 40,
        }
        item = apply(None, {
            "type": "proof.candidate",
            "payload": {
                "candidate_sha256": SOLUTION,
                "provenance": provenance,
            },
        })
        self.assertEqual(item["proof"]["candidate_provenance"], provenance)
        self.assertEqual(item["proof"]["candidate_authority"]["principal_id"], PRINCIPAL_A)
        self.assertEqual(item["proof"]["candidate_submitted_at"], "2026-09-13T12:00:00Z")

    def test_hyades_verification_must_bind_to_the_current_work_run(self):
        running = apply(candidate_item(), {
            "type": "work.set",
            "payload": {
                "status": "running",
                "hyades": {
                    "workflow_id": "proof-workflow-v1",
                    "run_id": "run-1",
                    "status": "running",
                },
            },
        })
        verified = apply(running, {
            "type": "proof.verify",
            "payload": {"verification": verification(method="hyades-run")},
        })
        self.assertEqual(verified["proof"]["verification"]["method"], "hyades-run")
        self.assertEqual(verified["work"]["hyades"]["status"], "completed")

        mismatched = verification(method="hyades-run")
        mismatched["hyades"]["run_id"] = "different-run"
        with self.assertRaisesRegex(ProofWorkStateConflict, "bound work run"):
            apply(running, {
                "type": "proof.verify",
                "payload": {"verification": mismatched},
            })

        nonterminal = verification(method="hyades-run")
        nonterminal["hyades"]["status"] = "running"
        with self.assertRaisesRegex(ProofWorkStateError, "terminal Hyades status"):
            apply(running, {
                "type": "proof.verify",
                "payload": {"verification": nonterminal},
            })

    def test_verification_authority_is_server_derived_for_any_tenant_identity(self):
        item = candidate_item()
        forged = verification()
        forged["verifier"] = "hyades"
        with self.assertRaisesRegex(ProofWorkStateError, "unknown field verifier"):
            apply(item, {"type": "proof.verify", "payload": {"verification": forged}})
        verified = apply(
            item,
            {"type": "proof.verify", "payload": {"verification": verification()}},
            principal_kind="human",
            role="member",
        )
        authority = verified["proof"]["verification"]["authority"]
        self.assertEqual(authority["principal_kind"], "human")
        self.assertEqual(authority["principal_id"], PRINCIPAL_A)
        self.assertEqual(authority["nostr_pubkey"], ACTOR_A)

    def test_external_attestation_and_owner_override_are_distinct(self):
        item = candidate_item()
        attested = apply(item, {
            "type": "proof.attest",
            "payload": {
                "statement": "Checked independently against the cited source.",
                "evidence_sha256": "1" * 64,
            },
        })
        self.assertEqual(attested["proof"]["status"], "attested")
        self.assertEqual(attested["proof"]["attestation"]["method"], "external-attestation")
        with self.assertRaisesRegex(ProofWorkStateError, "tenant owner"):
            apply(
                attested,
                {"type": "proof.override", "payload": {"reason": "Accepted for this campaign."}},
                principal_kind="human",
                role="member",
            )
        overridden = apply(
            attested,
            {"type": "proof.override", "payload": {"reason": "Accepted for this campaign."}},
            principal_kind="human",
            role="owner",
        )
        self.assertEqual(overridden["proof"]["status"], "overridden")
        self.assertIsNone(overridden["proof"]["verification"])
        self.assertEqual(overridden["proof"]["override"]["authority"]["principal_kind"], "human")
        with self.assertRaisesRegex(ProofWorkStateConflict, "must be superseded"):
            apply(
                overridden,
                {"type": "claim.acquire", "payload": {"lease_seconds": 300}},
                principal_kind="human",
                role="owner",
            )
        with self.assertRaisesRegex(ProofWorkStateConflict, "must be superseded"):
            apply(
                overridden,
                {"type": "proof.candidate", "payload": {"candidate_sha256": "2" * 64}},
                principal_kind="human",
                role="owner",
            )
        superseded = apply(
            overridden,
            {"type": "proof.supersede", "payload": {}},
            principal_kind="human",
            role="owner",
        )
        replacement = apply(
            superseded,
            {"type": "proof.candidate", "payload": {"candidate_sha256": "2" * 64}},
            principal_kind="human",
            role="owner",
        )
        self.assertEqual(replacement["proof"]["status"], "candidate")

    def test_accepted_receipts_must_be_sorry_free(self):
        with self.assertRaisesRegex(ProofWorkStateError, "sorry-free"):
            apply(candidate_item(), {
                "type": "proof.verify",
                "payload": {"verification": verification(sorry_free=False)},
            })

    def test_external_state_rejects_sensitive_fields(self):
        for field in [
            "token", "api_key", "password", "authorization", "access_token", "raw_output",
        ]:
            with self.subTest(field=field), self.assertRaises(ProofWorkStateError):
                apply(None, {
                    "type": "external.set",
                    "payload": {"system": "rosetta", "value": {field: "do-not-store"}},
                })

    def test_transition_payloads_reject_unknown_fields_before_ledger_storage(self):
        with self.assertRaisesRegex(ProofWorkStateError, "unknown field note"):
            apply(None, {
                "type": "claim.acquire",
                "payload": {"lease_seconds": 300, "note": "ignored before"},
            })
        with self.assertRaisesRegex(ProofWorkStateError, "unknown field extra"):
            apply(None, {
                "type": "external.set",
                "payload": {
                    "system": "rosetta",
                    "value": {"status": "pending_review", "extra": "not durable"},
                },
            })


if __name__ == "__main__":
    unittest.main()
