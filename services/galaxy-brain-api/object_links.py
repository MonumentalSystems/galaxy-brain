"""Bounded, store-neutral assertions between canonical Galaxy references.

An object link says that an authenticated principal asserted a relation. A
reference never grants access: callers must resolve both endpoints through the
tenant/principal-bound authorization seam before storing or projecting it. A
link also does not establish proof verification.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Callable, Mapping
from urllib.parse import quote, unquote_to_bytes


KINDS = frozenset({
    "paper", "document", "document.anchor", "document.mark", "eln.experiment", "eln.observation", "eln.hypothesis", "ham.task", "ham.memory",
    "task-plan", "surface", "chat", "run", "turn", "claim", "artifact",
    "code.repo", "code.commit", "code.file", "code.symbol", "code.graph",
    "proof.graph", "proof.node",
})
RELATIONS = frozenset({
    "related", "cites", "part_of", "derived_from", "context_for",
    "formalized_by", "defined_in", "implements", "depends_on", "documents",
    "corresponds_to",
})
BASES = frozenset({"authored", "imported", "derived"})
PINNED_KINDS = frozenset({
    "document", "document.anchor", "document.mark", "eln.observation", "chat",
    "code.repo", "code.commit", "code.file", "code.symbol", "code.graph",
    "proof.graph", "proof.node",
})
MAX_BODY_BYTES = 32_768
MAX_PROPOSAL_BODY_BYTES = 8_192
MAX_PROPOSAL_RATIONALE_BYTES = 4_096
MAX_PROPOSAL_DECISION_BODY_BYTES = 8_192
MAX_REFERENCE_BYTES = 16_384
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_SAFE_COMPONENT = "~!*'()-._"
_SOURCE_SNAPSHOT = re.compile(r"sha256:[0-9a-f]{64}")
_CODE_REVISION = re.compile(
    r"git:(?:[0-9a-f]{40}|[0-9a-f]{64});snapshot:sha256:[0-9a-f]{64}"
)
_SHA256_REVISION = re.compile(r"sha256:[0-9a-f]{64}")


class ObjectLinkError(ValueError):
    pass


class ReferentAccessError(RuntimeError):
    """A referent could not be proven readable by the current principal."""

    def __init__(self, message: str, *, unavailable: bool = False):
        super().__init__(message)
        self.unavailable = unavailable


@dataclass(frozen=True)
class CanonicalReference:
    wire: str
    kind: str
    identifier: str
    revision: str | None


@dataclass(frozen=True)
class ReferentAccess:
    reference: str
    tenant_id: str
    principal_id: str
    readable: bool
    resolved_revision: str | None = None
    provider: str | None = None


ReferentAuthorizer = Callable[[CanonicalReference, object], ReferentAccess | Mapping[str, object] | None]


def parse_canonical_reference(value: object) -> CanonicalReference:
    if not isinstance(value, str) or not value:
        raise ObjectLinkError("A bounded canonical Galaxy reference is required")
    try:
        byte_length = len(value.encode("utf-8"))
    except UnicodeError as error:
        raise ObjectLinkError("Reference contains invalid UTF-8") from error
    if byte_length > MAX_REFERENCE_BYTES:
        raise ObjectLinkError("A bounded canonical Galaxy reference is required")
    segments = value.split(":")
    if len(segments) not in {6, 7} or segments[:3] != ["gb", "object", "v1"]:
        raise ObjectLinkError("Only canonical Galaxy object references are allowed")
    _, _, _, kind, encoded_id, selector, *remainder = segments
    if kind not in KINDS:
        raise ObjectLinkError("Unsupported Galaxy object kind")
    if selector == "latest" and remainder:
        raise ObjectLinkError("Invalid revision selector")
    if selector == "pinned" and len(remainder) != 1:
        raise ObjectLinkError("Invalid revision selector")
    if selector not in {"latest", "pinned"}:
        raise ObjectLinkError("Invalid revision selector")

    def component(encoded: str, maximum: int) -> str:
        try:
            decoded = unquote_to_bytes(encoded).decode("utf-8", "strict")
        except UnicodeError as error:
            raise ObjectLinkError("Reference contains invalid UTF-8") from error
        if not decoded or decoded != decoded.strip() or len(decoded) > maximum or _CONTROL.search(decoded):
            raise ObjectLinkError("Reference component is invalid or too long")
        if quote(decoded, safe=_SAFE_COMPONENT) != encoded:
            raise ObjectLinkError("Reference is not canonical")
        return decoded

    identifier = component(encoded_id, 512)
    revision = None
    if remainder:
        revision = component(remainder[0], 256)
    return CanonicalReference(value, kind, identifier, revision)


def canonical_reference(value: object) -> str:
    return parse_canonical_reference(value).wire


def _bounded_provenance_text(provenance: dict, field: str, maximum: int, *, required: bool) -> str | None:
    value = provenance.get(field)
    if value is None and not required:
        return None
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum or _CONTROL.search(value)):
        raise ObjectLinkError(f"Invalid provenance {field}")
    return value


def _validate_provenance(value: object, basis: str) -> dict:
    allowed = {
        "source", "source_system", "source_ref", "source_snapshot",
        "extractor_version", "confidence",
    }
    if not isinstance(value, dict) or set(value) - allowed:
        raise ObjectLinkError("Provenance contains unsupported fields")
    expected_source = {"authored": "manual", "imported": "import", "derived": "derivation"}[basis]
    if value.get("source") != expected_source:
        raise ObjectLinkError("Provenance source does not match link basis")
    normalized = dict(value)
    normalized["source_system"] = _bounded_provenance_text(
        value, "source_system", 128, required=True,
    )
    machine_generated = basis in {"imported", "derived"}
    source_ref = _bounded_provenance_text(value, "source_ref", 512, required=machine_generated)
    source_snapshot = _bounded_provenance_text(
        value, "source_snapshot", 71, required=machine_generated,
    )
    extractor_version = _bounded_provenance_text(
        value, "extractor_version", 128, required=machine_generated,
    )
    if source_snapshot is not None and not _SOURCE_SNAPSHOT.fullmatch(source_snapshot):
        raise ObjectLinkError("Provenance source_snapshot must be a pinned sha256 digest")
    confidence = value.get("confidence")
    if confidence is not None and (
        isinstance(confidence, bool) or not isinstance(confidence, (int, float))
        or not math.isfinite(confidence) or confidence < 0 or confidence > 1
    ):
        raise ObjectLinkError("Provenance confidence must be between 0 and 1")
    if basis == "authored" and any(
        item is not None for item in (source_snapshot, extractor_version, confidence)
    ):
        raise ObjectLinkError("Authored provenance cannot claim extractor evidence")
    if source_ref is None:
        normalized.pop("source_ref", None)
    return normalized


def _validate_durable_selector(reference: CanonicalReference) -> None:
    if reference.kind not in PINNED_KINDS:
        return
    if reference.revision is None:
        raise ObjectLinkError(f"Durable {reference.kind} links require a pinned revision")
    grammar = _CODE_REVISION if reference.kind.startswith("code.") else _SHA256_REVISION
    if not grammar.fullmatch(reference.revision):
        raise ObjectLinkError(f"Invalid pinned revision for {reference.kind}")


def validate_link_payload(payload: object) -> dict:
    if not isinstance(payload, dict) or set(payload) != {
        "from_ref", "to_ref", "relation", "basis", "provenance", "idempotency_key",
    }:
        raise ObjectLinkError("Link requires from_ref, to_ref, relation, basis, provenance, and idempotency_key")
    parsed_from = parse_canonical_reference(payload["from_ref"])
    parsed_to = parse_canonical_reference(payload["to_ref"])
    _validate_durable_selector(parsed_from)
    _validate_durable_selector(parsed_to)
    from_ref = parsed_from.wire
    to_ref = parsed_to.wire
    if from_ref == to_ref:
        raise ObjectLinkError("A link must connect distinct references")
    relation = payload["relation"]
    basis = payload["basis"]
    if not isinstance(relation, str) or relation not in RELATIONS:
        raise ObjectLinkError("Unsupported relation")
    if not isinstance(basis, str) or basis not in BASES:
        raise ObjectLinkError("Unsupported link basis")
    provenance = _validate_provenance(payload["provenance"], basis)
    key = payload["idempotency_key"]
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise ObjectLinkError("Invalid idempotency_key")
    normalized = {
        "from_ref": from_ref, "to_ref": to_ref, "relation": relation,
        "basis": basis, "provenance": provenance, "idempotency_key": key,
    }
    if len(json.dumps(normalized, ensure_ascii=False).encode("utf-8")) > MAX_BODY_BYTES:
        raise ObjectLinkError("Link body is too large")
    return normalized


def validate_relation_proposal_payload(payload: object) -> dict:
    """Validate the deliberately narrow, non-active agent proposal contract."""
    required = {"fromRef", "toRef", "relation", "rationale", "idempotencyKey"}
    if not isinstance(payload, dict) or set(payload) != required:
        raise ObjectLinkError("Relation proposal requires exactly fromRef, toRef, relation, rationale, and idempotencyKey")
    parsed_from = parse_canonical_reference(payload["fromRef"])
    parsed_to = parse_canonical_reference(payload["toRef"])
    _validate_durable_selector(parsed_from)
    _validate_durable_selector(parsed_to)
    if parsed_from.revision is None or parsed_to.revision is None:
        raise ObjectLinkError("Relation proposals require exact pinned references")
    if parsed_from.wire == parsed_to.wire:
        raise ObjectLinkError("A relation proposal must connect distinct references")
    relation = payload["relation"]
    if not isinstance(relation, str) or relation not in RELATIONS:
        raise ObjectLinkError("Unsupported relation")
    rationale = payload["rationale"]
    if (not isinstance(rationale, str) or not rationale or rationale != rationale.strip()
            or _CONTROL.search(rationale)):
        raise ObjectLinkError("Rationale must be bounded text")
    try:
        rationale_bytes = len(rationale.encode("utf-8"))
    except UnicodeError as error:
        raise ObjectLinkError("Rationale contains invalid UTF-8") from error
    if rationale_bytes > MAX_PROPOSAL_RATIONALE_BYTES:
        raise ObjectLinkError("Rationale exceeds 4 KiB")
    key = payload["idempotencyKey"]
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise ObjectLinkError("Invalid idempotencyKey")
    normalized = {
        "fromRef": parsed_from.wire,
        "toRef": parsed_to.wire,
        "relation": relation,
        "rationale": rationale,
        "idempotencyKey": key,
    }
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_PROPOSAL_BODY_BYTES:
        raise ObjectLinkError("Relation proposal body is too large")
    return normalized


def validate_relation_proposal_decision_payload(payload: object) -> dict:
    """Validate a terminal human review decision without widening semantics."""
    required = {"decision", "expected_version", "reason", "idempotency_key"}
    if not isinstance(payload, dict) or set(payload) != required:
        raise ObjectLinkError(
            "Proposal decision requires exactly decision, expected_version, reason, and idempotency_key"
        )
    decision = payload["decision"]
    if decision not in {"accept", "reject"}:
        raise ObjectLinkError("Proposal decision must be accept or reject")
    expected_version = payload["expected_version"]
    if type(expected_version) is not int or expected_version != 1:
        raise ObjectLinkError("Pending relation proposals have expected_version 1")
    reason = payload["reason"]
    if (not isinstance(reason, str) or not reason or reason != reason.strip()
            or _CONTROL.search(reason)):
        raise ObjectLinkError("Proposal decision requires a bounded, nonempty reason")
    try:
        reason_bytes = len(reason.encode("utf-8"))
    except UnicodeError as error:
        raise ObjectLinkError("Proposal decision reason contains invalid UTF-8") from error
    if reason_bytes > MAX_PROPOSAL_RATIONALE_BYTES:
        raise ObjectLinkError("Proposal decision reason exceeds 4 KiB")
    key = payload["idempotency_key"]
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise ObjectLinkError("Invalid idempotency_key")
    normalized = {
        "decision": decision,
        "expected_version": expected_version,
        "reason": reason,
        "idempotency_key": key,
    }
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_PROPOSAL_DECISION_BODY_BYTES:
        raise ObjectLinkError("Proposal decision body is too large")
    return normalized


def authorize_referent(
    value: object,
    identity: object,
    authorizers: Mapping[str, ReferentAuthorizer],
) -> ReferentAccess:
    """Resolve and authorize a reference without treating it as a capability.

    The selected adapter must bind its decision to the exact authenticated
    tenant, principal, and canonical wire reference. Missing adapters and
    malformed decisions fail closed. Not-found and denied decisions are kept
    deliberately indistinguishable to callers.
    """
    reference = parse_canonical_reference(value)
    authorizer = authorizers.get(reference.kind)
    if not callable(authorizer):
        raise ReferentAccessError("Referent authorization provider is unavailable", unavailable=True)
    decision = authorizer(reference, identity)
    if isinstance(decision, Mapping):
        try:
            decision = ReferentAccess(
                reference=str(decision["reference"]),
                tenant_id=str(decision["tenant_id"]),
                principal_id=str(decision["principal_id"]),
                readable=decision["readable"] is True,
                resolved_revision=(
                    str(decision["resolved_revision"])
                    if decision.get("resolved_revision") is not None else None
                ),
                provider=str(decision["provider"]) if decision.get("provider") is not None else None,
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ReferentAccessError("Referent authorization provider returned an invalid decision", unavailable=True) from error
    tenant_id = getattr(identity, "tenant_id", None)
    principal_id = getattr(identity, "principal_id", None)
    if not isinstance(decision, ReferentAccess):
        raise ReferentAccessError("Referent is not readable")
    if (
        decision.reference != reference.wire
        or decision.tenant_id != tenant_id
        or decision.principal_id != principal_id
        or decision.readable is not True
    ):
        raise ReferentAccessError("Referent is not readable")
    if reference.revision is not None and decision.resolved_revision != reference.revision:
        raise ReferentAccessError("Pinned referent revision is not readable")
    return decision


def validate_retraction_payload(payload: object) -> dict:
    if not isinstance(payload, dict) or set(payload) != {
        "expected_version", "reason", "idempotency_key",
    }:
        raise ObjectLinkError("Retraction requires expected_version, reason, and idempotency_key")
    version = payload["expected_version"]
    if type(version) is not int or version < 1:
        raise ObjectLinkError("expected_version must be a positive integer")
    reason = payload["reason"]
    if (not isinstance(reason, str) or not reason or reason != reason.strip()
            or len(reason) > 1024 or _CONTROL.search(reason)):
        raise ObjectLinkError("Retraction requires a bounded, nonempty reason")
    key = payload["idempotency_key"]
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", key):
        raise ObjectLinkError("Invalid idempotency_key")
    return {"expected_version": version, "reason": reason, "idempotency_key": key}
