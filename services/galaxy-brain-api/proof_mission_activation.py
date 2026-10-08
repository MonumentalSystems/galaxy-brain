"""Pure compiler for one explicit proof-mission activation transaction.

The compiler accepts three exact immutable artifacts and normalized proof
verification records.  It never creates work state or HAM tasks.  In
particular, a passive ``repository-field`` graph is not sufficient input: an
exact mission intent and an exact proof-verification set are both required.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Iterable

from proof_graph_registry import (
    ProofGraphRegistration,
    ProofGraphRegistryError,
    parse_proof_graph_bytes,
)
from proof_mission_contract import (
    MISSION_INTENT_SCHEMA,
    ProofMissionContractError,
    derive_proof_mission,
    parse_mission_intent_bytes,
)
from proof_verification_set import (
    PROOF_VERIFICATION_SET_SCHEMA,
    BoundProofVerification,
    ProofVerificationSetError,
    ProofVerificationSetRegistration,
    parse_proof_verification_set_bytes,
)


PROOF_MISSION_ACTIVATION_SCHEMA = "galaxy.proof-mission-activation-plan.v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ProofMissionActivationError(ValueError):
    """The immutable inputs cannot form one authoritative activation plan."""


@dataclass(frozen=True)
class ProofMissionActivationPlan:
    """Deterministic data that a caller may persist in one transaction."""

    envelope: dict
    content_bytes: bytes
    content_sha256: str
    source_graph: ProofGraphRegistration
    verification_set: ProofVerificationSetRegistration
    mission_bytes: bytes
    mission_content_sha256: str
    inherited_verifications: tuple[BoundProofVerification, ...]


def _bind_exact_bytes(content: bytes, expected_sha256: str, label: str) -> str:
    if not isinstance(content, bytes):
        raise ProofMissionActivationError(f"{label} content must be bytes")
    if not isinstance(expected_sha256, str) or not SHA256.fullmatch(expected_sha256):
        raise ProofMissionActivationError(
            f"{label} content_sha256 must be a lowercase SHA-256 digest"
        )
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected_sha256:
        raise ProofMissionActivationError(
            f"{label} bytes do not match the registered content_sha256"
        )
    return actual


def _target_index(source: ProofGraphRegistration) -> dict[str, dict]:
    return {
        target["target_id"].strip(): target
        for target in source.artifact["targets"]
    }


def _validate_record_subject(
    source: ProofGraphRegistration,
    record: BoundProofVerification,
    targets: dict[str, dict],
) -> None:
    target = targets.get(record.node_id)
    if target is None:
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} is absent from the source graph"
        )
    binding = target.get("formal_binding")
    if not isinstance(binding, dict):
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} has no formal binding"
        )
    if binding.get("binding_kind") not in {"declaration", "declaration-bundle"}:
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} is not declaration-bound"
        )
    if binding.get("declaration_equivalence_claimed") is not True:
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} has no declaration equivalence claim"
        )
    declaration_ids = binding.get("declaration_ids")
    if (
        not isinstance(declaration_ids, list)
        or tuple(declaration_ids) != record.subject_declaration_ids
    ):
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} declarations do not match the source graph"
        )

    revision = source.artifact.get("revision")
    if not isinstance(revision, dict):
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} has no source revision"
        )
    expected = (
        revision.get("repository"),
        revision.get("commit"),
        revision.get("lean_toolchain"),
        revision.get("mathlib_revision"),
    )
    observed = (
        record.source_repository,
        record.source_commit,
        record.lean_toolchain,
        record.mathlib_revision,
    )
    if expected != observed:
        raise ProofMissionActivationError(
            f"Verification record node {record.node_id} provenance does not match the source graph"
        )


def _normalize_verification_records(
    source: ProofGraphRegistration,
    verification_set: ProofVerificationSetRegistration,
    records: Iterable[BoundProofVerification],
) -> tuple[BoundProofVerification, ...]:
    try:
        values = tuple(records)
    except TypeError as error:
        raise ProofMissionActivationError(
            "Normalized verification records must be iterable"
        ) from error
    by_node: dict[str, BoundProofVerification] = {}
    for record in values:
        if not isinstance(record, BoundProofVerification):
            raise ProofMissionActivationError(
                "Normalized verification records must be BoundProofVerification values"
            )
        if record.node_id in by_node:
            raise ProofMissionActivationError(
                f"Verification record node {record.node_id} is duplicated"
            )
        by_node[record.node_id] = record

    set_items = {item.node_id: item for item in verification_set.items}
    if set(by_node) != set(set_items):
        raise ProofMissionActivationError(
            "Normalized verification records must exactly cover the verification set"
        )

    targets = _target_index(source)
    for node_id, record in by_node.items():
        item = set_items[node_id]
        if (
            record.candidate_sha256 != item.candidate_sha256
            or record.receipt_sha256 != item.receipt_sha256
            or record.adapter_id != item.adapter_id
            or record.adapter_version != item.adapter_version
        ):
            raise ProofMissionActivationError(
                f"Verification record node {node_id} does not match its exact set item"
            )
        _validate_record_subject(source, record, targets)
    return tuple(by_node[node_id] for node_id in sorted(by_node))


def _record_json(record: BoundProofVerification) -> dict:
    value = {
        "node_id": record.node_id,
        "candidate_sha256": record.candidate_sha256,
        "receipt_sha256": record.receipt_sha256,
        "adapter_id": record.adapter_id,
        "adapter_version": record.adapter_version,
        "verifier_system": record.verifier_system,
        "method": record.method,
        "subject_declaration_ids": list(record.subject_declaration_ids),
        "source_repository": record.source_repository,
        "source_commit": record.source_commit,
        "lean_toolchain": record.lean_toolchain,
        "mathlib_revision": record.mathlib_revision,
        "verified_at": record.verified_at,
    }
    if record.hyades is not None:
        value["hyades"] = {
            key: record.hyades[key] for key in sorted(record.hyades)
        }
    return value


def compile_proof_mission_activation(
    *,
    source_graph_bytes: bytes,
    source_graph_sha256: str,
    mission_intent_bytes: bytes,
    mission_intent_sha256: str,
    verification_set_bytes: bytes,
    verification_set_sha256: str,
    verification_records: Iterable[BoundProofVerification],
) -> ProofMissionActivationPlan:
    """Re-derive a mission and bind it to one exact accepted baseline.

    The returned plan contains immutable structure only.  A service layer may
    add actor, idempotency, and workspace identifiers while persisting it, but
    must not treat this compiler as mutable work state or as a HAM task writer.
    """
    _bind_exact_bytes(source_graph_bytes, source_graph_sha256, "Source graph")
    _bind_exact_bytes(mission_intent_bytes, mission_intent_sha256, "Mission intent")
    _bind_exact_bytes(
        verification_set_bytes, verification_set_sha256, "Proof verification set"
    )
    try:
        source = parse_proof_graph_bytes(source_graph_bytes)
        intent = parse_mission_intent_bytes(mission_intent_bytes)
        candidate = derive_proof_mission(source, intent)
        verification_set = parse_proof_verification_set_bytes(
            verification_set_bytes,
            expected_graph_id=source.graph_id,
            expected_graph_sha256=source.content_sha256,
        )
    except (
        ProofGraphRegistryError,
        ProofMissionContractError,
        ProofVerificationSetError,
    ) as error:
        raise ProofMissionActivationError(str(error)) from error

    # The verification registry stores canonical set bytes.  Accepting a
    # semantically equivalent alternate serialization would break the exact
    # artifact/hash binding required for activation.
    if (
        verification_set.content_bytes != verification_set_bytes
        or verification_set.content_sha256 != verification_set_sha256
    ):
        raise ProofMissionActivationError(
            "Proof verification set is not the exact canonical registered artifact"
        )

    normalized_records = _normalize_verification_records(
        source, verification_set, verification_records
    )
    # Derive membership from the recompiled mission, never from caller-supplied
    # node lists or a downloaded candidate envelope.
    selected_nodes = frozenset(
        target["target_id"] for target in candidate.envelope["mission_dag"]["targets"]
    )
    inherited = tuple(
        record for record in normalized_records if record.node_id in selected_nodes
    )
    mission_registration = parse_proof_graph_bytes(candidate.mission_bytes)

    envelope = {
        "schema_id": PROOF_MISSION_ACTIVATION_SCHEMA,
        "source_graph_ref": {
            "graph_id": source.graph_id,
            "graph_kind": "repository-field",
            "content_sha256": source.content_sha256,
        },
        "mission_intent_ref": {
            "schema_id": MISSION_INTENT_SCHEMA,
            "content_sha256": mission_intent_sha256,
        },
        "verification_set_ref": {
            "schema_id": PROOF_VERIFICATION_SET_SCHEMA,
            "content_sha256": verification_set.content_sha256,
            "graph_id": verification_set.graph_id,
            "graph_content_sha256": verification_set.graph_content_sha256,
        },
        "mission_graph": {
            "content_sha256": candidate.mission_content_sha256,
            "artifact": mission_registration.artifact,
        },
        "workspace_seed": {
            "graph_id": mission_registration.graph_id,
            "graph_content_sha256": mission_registration.content_sha256,
            "node_ids": list(mission_registration.target_ids),
            "inherited_verified_node_ids": [record.node_id for record in inherited],
        },
        "inherited_verifications": [_record_json(record) for record in inherited],
    }
    content_bytes = json.dumps(
        envelope, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return ProofMissionActivationPlan(
        envelope=envelope,
        content_bytes=content_bytes,
        content_sha256=hashlib.sha256(content_bytes).hexdigest(),
        source_graph=source,
        verification_set=verification_set,
        mission_bytes=candidate.mission_bytes,
        mission_content_sha256=candidate.mission_content_sha256,
        inherited_verifications=inherited,
    )
