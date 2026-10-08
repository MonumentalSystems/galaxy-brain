"""Strict contract for reviewing one terminal HAM research result.

The browser-facing BFF supplies an exact terminal snapshot.  This module only
normalizes bounded data and canonical references; authorization and persistence
remain server concerns.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote

from object_links import ObjectLinkError, parse_canonical_reference


SCHEMA_ID = "gb.paper-agent-result-decision.v1"
MAX_BODY_BYTES = 1_200_000
MAX_SUMMARY_BYTES = 65_536
MAX_EVIDENCE_REFS = 50
_TASK_ID = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?")
_ACTOR_REF = re.compile(r"[A-Za-z0-9._:-]{1,200}")
_IDEMPOTENCY_KEY = re.compile(r"[A-Za-z0-9._:-]{8,200}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_SUMMARY_CONTROL = re.compile(r"[\x00\ud800-\udfff]")
_ISO_TIMESTAMP = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})"
    r"(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))"
)
_SAFE_COMPONENT = "~!*'()-._"


class AgentResultContractError(ValueError):
    pass


def _bounded_text(value: object, label: str, maximum: int, *, required: bool = True) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or value != value.strip() or _CONTROL.search(value):
        raise AgentResultContractError(f"{label} must be bounded text")
    if len(value.encode("utf-8")) > maximum:
        raise AgentResultContractError(f"{label} exceeds its allowed size")
    return value


def _bounded_summary(value: object) -> str:
    if not isinstance(value, str):
        raise AgentResultContractError("summary must be bounded text")
    normalized = value.strip()
    if not normalized or _SUMMARY_CONTROL.search(normalized):
        raise AgentResultContractError("summary must be bounded text")
    if len(normalized.encode("utf-8")) > MAX_SUMMARY_BYTES:
        raise AgentResultContractError("summary exceeds its allowed size")
    return normalized


def _event_id(value: object) -> str:
    if type(value) is int and 0 < value <= 9_007_199_254_740_991:
        return str(value)
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", value):
        raise AgentResultContractError("eventId is invalid")
    parsed = int(value)
    if parsed > 9_007_199_254_740_991 or str(parsed) != value:
        raise AgentResultContractError("eventId is invalid")
    return value


def terminal_task_reference(task_id: str, task_version: int) -> str:
    return (
        "gb:object:v1:ham.task:"
        f"{quote(task_id, safe=_SAFE_COMPONENT)}:pinned:"
        f"{quote(f'version:{task_version}', safe=_SAFE_COMPONENT)}"
    )


def pinned_document_reference(document_id: str, revision_sha256: str) -> str:
    return (
        "gb:object:v1:document:"
        f"{quote(document_id, safe=_SAFE_COMPONENT)}:pinned:"
        f"{quote(f'sha256:{revision_sha256}', safe=_SAFE_COMPONENT)}"
    )


def pinned_anchor_reference(anchor_id: str, representation_sha256: str) -> str:
    return (
        "gb:object:v1:document.anchor:"
        f"{quote(anchor_id, safe=_SAFE_COMPONENT)}:pinned:"
        f"{quote(f'sha256:{representation_sha256}', safe=_SAFE_COMPONENT)}"
    )


def parse_agent_result_decision(payload: object) -> dict[str, Any]:
    required = {
        "schemaId", "taskId", "taskVersion", "eventId", "occurredAt", "resultHash",
        "summary", "evidenceRefs", "action", "idempotencyKey",
    }
    optional = {"runId", "performedByRef"}
    if not isinstance(payload, dict) or set(payload) - required - optional or not required <= set(payload):
        raise AgentResultContractError("Agent result decision has unsupported or missing fields")
    if payload["schemaId"] != SCHEMA_ID:
        raise AgentResultContractError("Agent result decision schema is unsupported")
    task_id = payload["taskId"]
    if not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
        raise AgentResultContractError("taskId is invalid")
    task_version = payload["taskVersion"]
    if type(task_version) is not int or not 1 <= task_version <= 9_007_199_254_740_991:
        raise AgentResultContractError("taskVersion must be a positive safe integer")
    event_id = _event_id(payload["eventId"])
    occurred_at = normalize_completed_at(payload["occurredAt"])
    result_hash = payload["resultHash"]
    if not isinstance(result_hash, str) or not result_hash.startswith("sha256:") or not _SHA256.fullmatch(result_hash[7:]):
        raise AgentResultContractError("resultHash must be a sha256 reference")
    summary = _bounded_summary(payload["summary"])
    evidence = payload["evidenceRefs"]
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= MAX_EVIDENCE_REFS:
        raise AgentResultContractError("evidenceRefs must contain between 1 and 50 exact references")
    normalized_evidence: list[str] = []
    seen: set[str] = set()
    for value in evidence:
        try:
            parsed = parse_canonical_reference(value)
        except ObjectLinkError as error:
            raise AgentResultContractError("evidenceRefs contains an invalid canonical reference") from error
        if parsed.revision is None:
            raise AgentResultContractError("evidenceRefs must contain only pinned references")
        if len(parsed.wire) > 500:
            raise AgentResultContractError("evidenceRefs contains an oversized reference")
        if parsed.wire in seen:
            raise AgentResultContractError("evidenceRefs contains a duplicate reference")
        seen.add(parsed.wire)
        normalized_evidence.append(parsed.wire)
    action = payload["action"]
    if action not in {"accept", "reject"}:
        raise AgentResultContractError("action must be accept or reject")
    key = payload["idempotencyKey"]
    if not isinstance(key, str) or not _IDEMPOTENCY_KEY.fullmatch(key):
        raise AgentResultContractError("idempotencyKey is invalid")
    run_id = _bounded_text(payload.get("runId"), "runId", 100, required=False)
    if run_id is not None and not _TASK_ID.fullmatch(run_id):
        raise AgentResultContractError("runId is invalid")
    performed_by = _bounded_text(
        payload.get("performedByRef"), "performedByRef", 200, required=False,
    )
    if performed_by is not None and not _ACTOR_REF.fullmatch(performed_by):
        raise AgentResultContractError("performedByRef is invalid")
    hash_input = {
        "schemaId": "gb.paper-agent-result-candidate.v1",
        "taskId": task_id,
        "taskVersion": task_version,
        "eventId": event_id,
        "runId": run_id,
        "performedByRef": performed_by,
        "occurredAt": payload["occurredAt"],
        "summary": summary,
        "evidenceRefs": normalized_evidence,
    }
    candidate_json = json.dumps(
        hash_input, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    actual_hash = hashlib.sha256(candidate_json.encode("utf-8")).hexdigest()
    if actual_hash != result_hash[7:]:
        raise AgentResultContractError("resultHash does not match the terminal candidate snapshot")
    normalized = {
        "schema_id": SCHEMA_ID,
        "task_id": task_id,
        "task_version": task_version,
        "terminal_task_ref": terminal_task_reference(task_id, task_version),
        "event_id": event_id,
        "occurred_at": occurred_at,
        "result_hash_ref": result_hash,
        "result_sha256": result_hash[7:],
        "summary": summary,
        "evidence_refs": normalized_evidence,
        "run_id": run_id,
        "performed_by_ref": performed_by,
        "action": action,
        "idempotency_key": key,
    }
    normalized["candidate_sha256"] = actual_hash
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_BODY_BYTES:
        raise AgentResultContractError("Agent result decision body is too large")
    normalized["request_sha256"] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return normalized


def parse_agent_result_lookup(task_version: object, event_id: object, result_sha256: object) -> dict[str, Any]:
    try:
        version = int(task_version)
    except (TypeError, ValueError) as error:
        raise AgentResultContractError("task_version must be a positive safe integer") from error
    if isinstance(task_version, bool) or not 1 <= version <= 9_007_199_254_740_991 or str(version) != str(task_version):
        raise AgentResultContractError("task_version must be a positive safe integer")
    normalized_event = _event_id(event_id)
    if not isinstance(result_sha256, str) or not result_sha256.startswith("sha256:") or not _SHA256.fullmatch(result_sha256[7:]):
        raise AgentResultContractError("result_sha256 must be a sha256 reference")
    return {
        "task_version": version,
        "event_id": normalized_event,
        "result_hash_ref": result_sha256,
        "result_sha256": result_sha256[7:],
    }


def normalize_completed_at(value: object) -> str | None:
    """Validate the exact bounded ISO timestamp shape accepted by the HAM BFF."""
    match = _ISO_TIMESTAMP.fullmatch(value) if isinstance(value, str) and len(value) <= 64 else None
    if match is None:
        raise AgentResultContractError("occurredAt must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise AgentResultContractError("occurredAt must be an ISO timestamp") from error
    if parsed.tzinfo is None:
        raise AgentResultContractError("occurredAt must include a timezone")
    return parsed.isoformat()
