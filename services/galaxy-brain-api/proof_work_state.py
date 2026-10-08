"""Validation and deterministic transitions for Galaxy proof work state."""

from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID


WORK_STATE_SCHEMA = "galaxy.proof-work-state.v1"
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$")
WORKSPACE_KEY = IDENTIFIER
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
NOSTR_PUBKEY = re.compile(r"^[0-9a-f]{64}$")
WORK_STATUSES = {"idle", "claimed", "running", "submitted", "blocked", "closed"}
ACTIVE_HYADES_STATUSES = {"pending", "queued", "running", "verifying"}
HYADES_STATUSES = ACTIVE_HYADES_STATUSES | {"completed", "failed", "cancelled"}
TRANSITION_TYPES = {
    "claim.acquire",
    "claim.release",
    "work.set",
    "proof.candidate",
    "proof.attest",
    "proof.verify",
    "proof.reject",
    "proof.supersede",
    "proof.override",
    "external.set",
    "coordination.task.bind",
}
VERIFICATION_METHODS = {"hyades-run", "lean-replay", "signed-report"}
SENSITIVE_FIELD = re.compile(
    r"^(?:api_?key|password|authorization|access_?token|refresh_?token|raw_?(?:logs?|output)|credentials?|tokens?|private_?key|secret)$",
    re.I,
)
EXTERNAL_VALUE_FIELDS = {
    "rosetta": {"node_id", "submission_id", "status", "updated_at", "message", "evidence_sha256"},
    "prove2me": {"theorem_id", "submission_id", "status", "updated_at", "message", "evidence_sha256"},
}
COORDINATION_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")
COORDINATION_STATES = {"dispatched", "reused"}


class ProofWorkStateError(ValueError):
    """The requested state or transition violates the public contract."""


class ProofWorkStateConflict(ProofWorkStateError):
    """The transition is well formed but conflicts with current state."""


def _text(value: Any, label: str, maximum: int, *, required: bool = False) -> str:
    if value is None:
        if required:
            raise ProofWorkStateError(f"{label} is required")
        return ""
    if not isinstance(value, str):
        raise ProofWorkStateError(f"{label} must be text")
    normalized = value.strip()
    if required and not normalized:
        raise ProofWorkStateError(f"{label} is required")
    if len(normalized) > maximum:
        raise ProofWorkStateError(f"{label} exceeds {maximum} characters")
    return normalized


def identifier(value: Any, label: str, *, workspace: bool = False) -> str:
    pattern = WORKSPACE_KEY if workspace else IDENTIFIER
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ProofWorkStateError(f"{label} is invalid")
    return value


def sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ProofWorkStateError(f"{label} must be a lowercase SHA-256 digest")
    return value


def idempotency_key(value: Any) -> str:
    normalized = _text(value, "idempotency_key", 200, required=True)
    if len(normalized) < 8:
        raise ProofWorkStateError("idempotency_key must contain 8-200 characters")
    return normalized


def _timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise ProofWorkStateError(f"{label} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProofWorkStateError(f"{label} must be an ISO timestamp") from error
    if parsed.tzinfo is None:
        raise ProofWorkStateError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _reject_sensitive(value: Any, path: str = "transition") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if SENSITIVE_FIELD.fullmatch(str(key)):
                raise ProofWorkStateError(f"{path}.{key} is not permitted")
            _reject_sensitive(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_sensitive(child, f"{path}[{index}]")


def _exact_object(
    value: Any,
    label: str,
    allowed: set[str],
    *,
    required: set[str] | None = None,
) -> dict:
    if not isinstance(value, dict):
        raise ProofWorkStateError(f"{label} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ProofWorkStateError(f"{label} contains unknown field {unknown[0]}")
    missing = sorted((required or set()) - set(value))
    if missing:
        raise ProofWorkStateError(f"{label}.{missing[0]} is required")
    return value


def _principal_id(value: Any) -> str:
    if not isinstance(value, str):
        raise ProofWorkStateError("actor principal_id is invalid")
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise ProofWorkStateError("actor principal_id is invalid") from error
    if str(parsed) != value.lower():
        raise ProofWorkStateError("actor principal_id is invalid")
    return str(parsed)


def _authority(principal_id: str, nostr_pubkey: str, principal_kind: str) -> dict:
    if principal_kind not in {"human", "agent", "service"}:
        raise ProofWorkStateError("actor principal kind is invalid")
    return {
        "principal_id": _principal_id(principal_id),
        "nostr_pubkey": nostr_pubkey,
        "principal_kind": principal_kind,
    }


def empty_work_item(node_id: str) -> dict:
    return {
        "node_id": identifier(node_id, "node_id"),
        "version": 0,
        "work": {
            "status": "idle",
            "claim": None,
            "hyades": None,
            "blocker": "",
            "task_id": "",
            "linked_task_count": 0,
        },
        "proof": {
            "status": "open",
            "candidate_sha256": None,
            "candidate_provenance": None,
            "candidate_authority": None,
            "candidate_submitted_at": None,
            "attestation": None,
            "verification": None,
            "override": None,
        },
        "external": {},
    }


def _hyades(value: Any) -> dict | None:
    if value is None:
        return None
    value = _exact_object(
        value,
        "work.hyades",
        {"workflow_id", "run_id", "status"},
        required={"workflow_id", "run_id", "status"},
    )
    status = _text(value.get("status"), "work.hyades.status", 80, required=True)
    if status not in HYADES_STATUSES:
        raise ProofWorkStateError("work.hyades.status is invalid")
    return {
        "workflow_id": _text(value.get("workflow_id"), "work.hyades.workflow_id", 200, required=True),
        "run_id": _text(value.get("run_id"), "work.hyades.run_id", 200, required=True),
        "status": status,
    }


def _provenance(value: Any) -> dict | None:
    if value is None:
        return None
    value = _exact_object(
        value,
        "proof candidate provenance",
        {"source_commit", "lean_toolchain", "mathlib_revision"},
        required={"source_commit", "lean_toolchain", "mathlib_revision"},
    )
    source_commit = value.get("source_commit")
    mathlib_revision = value.get("mathlib_revision")
    if not isinstance(source_commit, str) or not GIT_OID.fullmatch(source_commit):
        raise ProofWorkStateError("proof candidate provenance source_commit is invalid")
    if not isinstance(mathlib_revision, str) or not GIT_OID.fullmatch(mathlib_revision):
        raise ProofWorkStateError("proof candidate provenance mathlib_revision is invalid")
    return {
        "source_commit": source_commit,
        "lean_toolchain": _text(
            value.get("lean_toolchain"),
            "proof candidate provenance lean_toolchain",
            200,
            required=True,
        ),
        "mathlib_revision": mathlib_revision,
    }


def _verification_receipt(value: Any, *, outcome: str) -> dict:
    value = _exact_object(
        value,
        "proof verification",
        {
            "method", "receipt_id", "receipt_sha256", "outcome", "solution_sha256",
            "source_commit", "lean_toolchain", "mathlib_revision", "sorry_free",
            "verified_at", "hyades",
        },
        required={
            "method", "receipt_id", "receipt_sha256", "outcome", "solution_sha256",
            "source_commit", "lean_toolchain", "mathlib_revision", "sorry_free",
            "verified_at",
        },
    )
    method = value.get("method")
    if method not in VERIFICATION_METHODS:
        raise ProofWorkStateError("proof verification method is invalid")
    if value.get("outcome") != outcome:
        raise ProofWorkStateError(f"proof verification outcome must be {outcome}")
    sorry_free = value.get("sorry_free")
    if not isinstance(sorry_free, bool):
        raise ProofWorkStateError("proof verification sorry_free must be boolean")
    if outcome == "accepted" and not sorry_free:
        raise ProofWorkStateError("accepted proof verification must be sorry-free")
    source_commit = value.get("source_commit")
    mathlib_revision = value.get("mathlib_revision")
    if not isinstance(source_commit, str) or not GIT_OID.fullmatch(source_commit):
        raise ProofWorkStateError("proof verification source_commit is invalid")
    if not isinstance(mathlib_revision, str) or not GIT_OID.fullmatch(mathlib_revision):
        raise ProofWorkStateError("proof verification mathlib_revision is invalid")
    verified_at = _timestamp(value.get("verified_at"), "proof verification verified_at")
    hyades = value.get("hyades")
    if method == "hyades-run":
        hyades = _hyades(hyades)
        if not hyades:
            raise ProofWorkStateError("hyades-run verification requires a Hyades run reference")
        permitted_statuses = {"completed"} if outcome == "accepted" else {"completed", "failed"}
        if hyades["status"] not in permitted_statuses:
            raise ProofWorkStateError("hyades-run verification requires a terminal Hyades status")
    elif hyades is not None:
        raise ProofWorkStateError(f"{method} verification cannot claim a Hyades run")
    return {
        "method": method,
        "receipt_id": identifier(value.get("receipt_id"), "proof verification receipt_id"),
        "receipt_sha256": sha256(value.get("receipt_sha256"), "proof verification receipt_sha256"),
        "outcome": outcome,
        "solution_sha256": sha256(value.get("solution_sha256"), "proof verification solution_sha256"),
        "source_commit": source_commit,
        "lean_toolchain": _text(value.get("lean_toolchain"), "proof verification lean_toolchain", 200, required=True),
        "mathlib_revision": mathlib_revision,
        "sorry_free": sorry_free,
        "verified_at": _iso(verified_at),
        "hyades": hyades,
    }


def _external_value(system: str, value: Any) -> dict:
    allowed = EXTERNAL_VALUE_FIELDS[system]
    value = _exact_object(value, f"external.{system}", allowed)
    if not value:
        raise ProofWorkStateError(f"external.{system} must contain at least one status field")
    normalized = {}
    identifier_field = "node_id" if system == "rosetta" else "theorem_id"
    for key in [identifier_field, "submission_id"]:
        if key in value:
            normalized[key] = _text(value[key], f"external.{system}.{key}", 200, required=True)
    if "status" in value:
        normalized["status"] = _text(value["status"], f"external.{system}.status", 80, required=True)
    if "updated_at" in value:
        normalized["updated_at"] = _iso(_timestamp(value["updated_at"], f"external.{system}.updated_at"))
    if "message" in value:
        normalized["message"] = _text(value["message"], f"external.{system}.message", 1_000)
    if "evidence_sha256" in value:
        normalized["evidence_sha256"] = sha256(value["evidence_sha256"], f"external.{system}.evidence_sha256")
    if len(json.dumps(normalized, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > 8_192:
        raise ProofWorkStateError("external value exceeds 8 KiB")
    return normalized


def _coordination_component(value: Any, label: str) -> str:
    if not isinstance(value, str) or not COORDINATION_COMPONENT.fullmatch(value):
        raise ProofWorkStateError(f"{label} must use the route-safe proof coordination grammar")
    return value


def _hyades_task_binding(value: Any) -> dict:
    value = _exact_object(
        value,
        "transition payload binding",
        {
            "program_id", "packet_id", "task_id", "resource_ref",
            "assignment_sha256", "transition_sha256", "state", "dispatch_id",
            "dispatch_sequence", "directive_sha256", "projection_sha256",
        },
        required={
            "program_id", "packet_id", "task_id", "resource_ref",
            "assignment_sha256", "transition_sha256", "state", "dispatch_id",
            "dispatch_sequence", "directive_sha256", "projection_sha256",
        },
    )
    sequence = value.get("dispatch_sequence")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        raise ProofWorkStateError("transition payload binding dispatch_sequence must be a positive integer")
    state = _text(value.get("state"), "transition payload binding state", 80, required=True)
    if state not in COORDINATION_STATES:
        raise ProofWorkStateError("transition payload binding state is invalid")
    return {
        "program_id": _coordination_component(value.get("program_id"), "transition payload binding program_id"),
        "packet_id": _coordination_component(value.get("packet_id"), "transition payload binding packet_id"),
        "task_id": identifier(value.get("task_id"), "transition payload binding task_id"),
        "resource_ref": _text(
            value.get("resource_ref"), "transition payload binding resource_ref", 1_024, required=True
        ),
        "assignment_sha256": sha256(value.get("assignment_sha256"), "transition payload binding assignment_sha256"),
        "transition_sha256": sha256(value.get("transition_sha256"), "transition payload binding transition_sha256"),
        "state": state,
        "dispatch_id": identifier(value.get("dispatch_id"), "transition payload binding dispatch_id"),
        "dispatch_sequence": sequence,
        "directive_sha256": sha256(value.get("directive_sha256"), "transition payload binding directive_sha256"),
        "projection_sha256": sha256(value.get("projection_sha256"), "transition payload binding projection_sha256"),
    }


def same_hyades_task_binding(left: Any, right: Any) -> bool:
    """Compare one dispatch binding; a surrounding projection digest is not its identity."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return {
        key: value for key, value in left.items() if key != "projection_sha256"
    } == {
        key: value for key, value in right.items() if key != "projection_sha256"
    }


def _normalized_payload(transition_type: str, payload: Any) -> dict:
    if transition_type == "claim.acquire":
        payload = _exact_object(payload, "transition payload", {"lease_seconds"}, required={"lease_seconds"})
        lease_seconds = payload["lease_seconds"]
        if not isinstance(lease_seconds, int) or isinstance(lease_seconds, bool) or not 60 <= lease_seconds <= 86_400:
            raise ProofWorkStateError("claim lease_seconds must be an integer from 60 to 86400")
        return {"lease_seconds": lease_seconds}
    if transition_type in {"claim.release", "proof.supersede"}:
        _exact_object(payload, "transition payload", set())
        return {}
    if transition_type == "work.set":
        payload = _exact_object(
            payload,
            "transition payload",
            {"status", "hyades", "blocker", "task_id", "linked_task_count"},
            required={"status"},
        )
        status = payload["status"]
        if status not in WORK_STATUSES - {"claimed"}:
            raise ProofWorkStateError("work.set status is invalid; claims use claim.acquire")
        normalized = {
            "status": status,
            "hyades": _hyades(payload.get("hyades")),
            "blocker": _text(payload.get("blocker"), "work blocker", 1_000),
            "task_id": _text(payload.get("task_id"), "work task_id", 200),
        }
        if "linked_task_count" in payload:
            count = payload["linked_task_count"]
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise ProofWorkStateError("work linked_task_count must be a non-negative integer")
            normalized["linked_task_count"] = count
        return normalized
    if transition_type == "proof.candidate":
        payload = _exact_object(
            payload,
            "transition payload",
            {"candidate_sha256", "provenance"},
            required={"candidate_sha256"},
        )
        return {
            "candidate_sha256": sha256(payload["candidate_sha256"], "proof candidate_sha256"),
            "provenance": _provenance(payload.get("provenance")),
        }
    if transition_type in {"proof.verify", "proof.reject"}:
        payload = _exact_object(payload, "transition payload", {"verification"}, required={"verification"})
        outcome = "accepted" if transition_type == "proof.verify" else "rejected"
        return {"verification": _verification_receipt(payload["verification"], outcome=outcome)}
    if transition_type == "proof.attest":
        payload = _exact_object(
            payload,
            "transition payload",
            {"statement", "evidence_sha256"},
            required={"statement"},
        )
        return {
            "statement": _text(payload["statement"], "proof attestation statement", 2_000, required=True),
            "evidence_sha256": (
                sha256(payload["evidence_sha256"], "proof attestation evidence_sha256")
                if "evidence_sha256" in payload else None
            ),
        }
    if transition_type == "proof.override":
        payload = _exact_object(
            payload,
            "transition payload",
            {"reason", "evidence_sha256"},
            required={"reason"},
        )
        return {
            "reason": _text(payload["reason"], "proof override reason", 2_000, required=True),
            "evidence_sha256": (
                sha256(payload["evidence_sha256"], "proof override evidence_sha256")
                if "evidence_sha256" in payload else None
            ),
        }
    if transition_type == "coordination.task.bind":
        payload = _exact_object(payload, "transition payload", {"binding"}, required={"binding"})
        return {"binding": _hyades_task_binding(payload["binding"])}
    payload = _exact_object(payload, "transition payload", {"system", "value"}, required={"system", "value"})
    system = payload["system"]
    if system not in EXTERNAL_VALUE_FIELDS:
        raise ProofWorkStateError("external system must be prove2me or rosetta")
    return {"system": system, "value": _external_value(system, payload["value"])}


def validate_transition(value: Any) -> dict:
    value = _exact_object(value, "transition", {"type", "payload"}, required={"type", "payload"})
    _reject_sensitive(value)
    if len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > 32_768:
        raise ProofWorkStateError("transition exceeds 32 KiB")
    transition_type = value.get("type")
    if transition_type not in TRANSITION_TYPES:
        raise ProofWorkStateError("transition type is invalid")
    return {"type": transition_type, "payload": _normalized_payload(transition_type, value["payload"])}


def _active_claim(item: dict, now: datetime) -> dict | None:
    claim = item["work"].get("claim")
    if not isinstance(claim, dict):
        return None
    return claim if _timestamp(claim.get("expires_at"), "claim expires_at") > now else None


def apply_transition(
    current_item: dict | None,
    transition_input: Any,
    actor_nostr_pubkey: str,
    *,
    actor_principal_id: str,
    actor_principal_kind: str,
    actor_role: str | None,
    node_id: str,
    now: datetime,
    claim_id: str,
) -> dict:
    """Apply one validated transition without mutating the supplied snapshot."""
    if not NOSTR_PUBKEY.fullmatch(actor_nostr_pubkey):
        raise ProofWorkStateError("a verified Nostr actor is required")
    authority = _authority(actor_principal_id, actor_nostr_pubkey, actor_principal_kind)
    transition = validate_transition(transition_input)
    payload = transition["payload"]
    normalized_node_id = identifier(node_id, "node_id")
    if current_item is None:
        item = empty_work_item(normalized_node_id)
    else:
        item = copy.deepcopy(current_item)
        if identifier(item.get("node_id"), "stored node_id") != normalized_node_id:
            raise ProofWorkStateError("stored work item does not match node_id")
    kind = transition["type"]

    if kind == "claim.acquire":
        lease_seconds = payload.get("lease_seconds")
        stored_claim = item["work"].get("claim")
        active = _active_claim(item, now)
        if active and active.get("nostr_pubkey") != actor_nostr_pubkey:
            raise ProofWorkStateConflict("proof node has an active claim owned by another identity")
        if item["proof"].get("status") in {"verified", "overridden"}:
            raise ProofWorkStateConflict("a completed proof must be superseded before it can be claimed")
        if (
            item["work"].get("status") == "running"
            and (not stored_claim or stored_claim.get("nostr_pubkey") != actor_nostr_pubkey)
        ):
            raise ProofWorkStateConflict("only the existing claim owner can renew a running proof node")
        if item["work"].get("status") != "running":
            item["work"]["status"] = "claimed"
        item["work"]["claim"] = {
            "claim_id": identifier(claim_id, "claim_id"),
            "nostr_pubkey": actor_nostr_pubkey,
            "claimed_at": _iso(now),
            "expires_at": _iso(now + timedelta(seconds=lease_seconds)),
        }
    elif kind == "claim.release":
        claim = item["work"].get("claim")
        if not claim or claim.get("nostr_pubkey") != actor_nostr_pubkey:
            raise ProofWorkStateConflict("only the claim owner can release this proof node")
        if item["work"].get("status") == "running":
            raise ProofWorkStateConflict("running work must leave the running state before releasing its claim")
        item["work"]["claim"] = None
        if item["work"].get("status") == "claimed":
            item["work"]["status"] = "idle"
    elif kind == "work.set":
        active = _active_claim(item, now)
        if active and active.get("nostr_pubkey") != actor_nostr_pubkey:
            raise ProofWorkStateConflict("only the active claim owner can update proof work")
        status = payload["status"]
        hyades = payload.get("hyades")
        if status == "running" and (not hyades or hyades["status"] not in ACTIVE_HYADES_STATUSES):
            raise ProofWorkStateError("running work requires an active Hyades run")
        item["work"].update({
            "status": status,
            "hyades": hyades,
            "blocker": payload["blocker"],
            "task_id": payload["task_id"],
            "linked_task_count": payload.get("linked_task_count", item["work"].get("linked_task_count", 0)),
        })
        if status == "closed":
            item["work"]["claim"] = None
    elif kind == "coordination.task.bind":
        binding = payload["binding"]
        prior_binding = item.get("external", {}).get("hyades_task_binding")
        if isinstance(prior_binding, dict):
            prior_sequence = prior_binding.get("dispatch_sequence")
            if not isinstance(prior_sequence, int):
                raise ProofWorkStateConflict("stored Hyades task binding is invalid")
            if binding["dispatch_sequence"] < prior_sequence:
                raise ProofWorkStateConflict("Hyades task binding dispatch_sequence is stale")
            if binding["dispatch_sequence"] == prior_sequence:
                if not same_hyades_task_binding(binding, prior_binding):
                    raise ProofWorkStateConflict(
                        "Hyades task binding dispatch_sequence already names a different binding"
                    )
                return item
        previous_task_id = item["work"].get("task_id", "")
        item["work"]["task_id"] = binding["task_id"]
        if previous_task_id != binding["task_id"]:
            item["work"]["linked_task_count"] = item["work"].get("linked_task_count", 0) + 1
        item.setdefault("external", {})["hyades_task_binding"] = binding
    elif kind == "proof.candidate":
        active = _active_claim(item, now)
        if active and active.get("nostr_pubkey") != actor_nostr_pubkey:
            raise ProofWorkStateConflict("only the active claim owner can record a proof candidate")
        if item["proof"].get("status") in {"verified", "overridden"}:
            raise ProofWorkStateConflict("a completed proof must be superseded before recording a new candidate")
        item["proof"].update({
            "status": "candidate",
            "candidate_sha256": payload["candidate_sha256"],
            "candidate_provenance": payload.get("provenance"),
            "candidate_authority": authority,
            "candidate_submitted_at": _iso(now),
            "attestation": None,
            "verification": None,
            "override": None,
        })
    elif kind == "proof.attest":
        if item["proof"].get("status") not in {"candidate", "attested"} or not item["proof"].get("candidate_sha256"):
            raise ProofWorkStateConflict("proof attestation requires the current candidate")
        item["proof"]["status"] = "attested"
        item["proof"]["attestation"] = {
            "authority": authority,
            "method": "external-attestation",
            "statement": payload["statement"],
            "evidence_sha256": payload.get("evidence_sha256"),
            "attested_at": _iso(now),
        }
    elif kind in {"proof.verify", "proof.reject"}:
        candidate = item["proof"].get("candidate_sha256")
        if item["proof"].get("status") not in {"candidate", "attested"} or not candidate:
            raise ProofWorkStateConflict("proof verification requires the current candidate")
        outcome = "accepted" if kind == "proof.verify" else "rejected"
        verification = {**payload["verification"], "authority": authority}
        if verification["solution_sha256"] != candidate:
            raise ProofWorkStateConflict("verifier receipt solution hash does not match the current proof candidate")
        if verification["method"] == "hyades-run":
            current_run = item["work"].get("hyades")
            receipt_run = verification["hyades"]
            if (
                not current_run
                or current_run.get("workflow_id") != receipt_run["workflow_id"]
                or current_run.get("run_id") != receipt_run["run_id"]
            ):
                raise ProofWorkStateConflict("Hyades verification receipt does not match the bound work run")
            item["work"]["hyades"] = receipt_run
        item["proof"].update({
            "status": "verified" if outcome == "accepted" else "rejected",
            "verification": verification,
            "override": None,
        })
        if outcome == "accepted":
            item["work"]["status"] = "closed"
            item["work"]["claim"] = None
    elif kind == "proof.supersede":
        if item["proof"].get("status") == "open":
            raise ProofWorkStateConflict("an open proof has no candidate or verification to supersede")
        item["proof"]["status"] = "superseded"
    elif kind == "proof.override":
        if actor_principal_kind != "human" or actor_role != "owner":
            raise ProofWorkStateError("proof override requires the tenant owner")
        if item["proof"].get("status") not in {"candidate", "attested", "rejected"} or not item["proof"].get("candidate_sha256"):
            raise ProofWorkStateConflict("proof override requires a current candidate")
        item["proof"]["status"] = "overridden"
        item["proof"]["override"] = {
            "authority": authority,
            "reason": payload["reason"],
            "evidence_sha256": payload.get("evidence_sha256"),
            "overridden_at": _iso(now),
        }
        item["work"]["status"] = "closed"
        item["work"]["claim"] = None
    elif kind == "external.set":
        system = payload["system"]
        item["external"][system] = copy.deepcopy(payload["value"])

    return item
