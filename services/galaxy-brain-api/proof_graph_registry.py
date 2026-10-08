"""Validation for immutable, exact-byte Galaxy proof DAG registrations."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any


PROOF_DAG_SCHEMA = "galaxy.proof-dag.v1"
MAX_PROOF_GRAPH_BYTES = 16_777_216
GRAPH_NODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$")
TASK_RESOURCE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$")
RELATION_TYPES = {
    "MILESTONE_OF",
    "DEPENDS_ON",
    "REDUCES_TO",
    "USES",
    "PROMOTED_TO",
    "AUTHORED_PREREQUISITE",
}
PREREQUISITE_RELATION_TYPES = {
    "DEPENDS_ON", "REDUCES_TO", "USES", "AUTHORED_PREREQUISITE",
}
CLAIMABLE_GRAPH_KINDS = {"campaign", "mission"}
GRAPH_KINDS = CLAIMABLE_GRAPH_KINDS | {"repository-field"}


class ProofGraphRegistryError(ValueError):
    """The submitted immutable proof graph violates galaxy.proof-dag.v1."""


@dataclass(frozen=True)
class ProofGraphRegistration:
    content_bytes: bytes
    content_sha256: str
    artifact: dict[str, Any]
    graph_id: str
    graph_kind: str
    title: str
    target_ids: tuple[str, ...]
    node_ref_ids: tuple[str, ...]
    relation_count: int


def _bounded_text(value: Any, label: str, maximum: int, *, required: bool = False) -> str:
    if value is None:
        if required:
            raise ProofGraphRegistryError(f"{label} is required")
        return ""
    if not isinstance(value, str):
        raise ProofGraphRegistryError(f"{label} must be text")
    normalized = value.strip()
    if required and not normalized:
        raise ProofGraphRegistryError(f"{label} is required")
    # JavaScript's canonical parser bounds strings in UTF-16 code units.
    if len(normalized.encode("utf-16-le")) // 2 > maximum:
        raise ProofGraphRegistryError(f"{label} exceeds {maximum} characters")
    return normalized


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not GRAPH_NODE_ID.fullmatch(value):
        raise ProofGraphRegistryError(f"{label} is invalid")
    return value


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ProofGraphRegistryError("Duplicate JSON fields are not allowed")
        value[key] = item
    return value


def _reject_non_json_number(value: str):
    raise ProofGraphRegistryError(f"Non-finite JSON number {value} is not allowed")


def _topological_check(target_ids: tuple[str, ...], edges: list[tuple[str, str]]) -> None:
    indegree = {target_id: 0 for target_id in target_ids}
    dependents = {target_id: [] for target_id in target_ids}
    for source, target in edges:
        indegree[target] += 1
        dependents[source].append(target)
    queue = [target_id for target_id in target_ids if indegree[target_id] == 0]
    cursor = 0
    while cursor < len(queue):
        source = queue[cursor]
        cursor += 1
        for target in dependents[source]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if len(queue) != len(target_ids):
        cycle_target = next(target_id for target_id in target_ids if indegree[target_id] > 0)
        raise ProofGraphRegistryError(f"Proof DAG dependency cycle includes {cycle_target}")


def parse_proof_graph_bytes(content_bytes: bytes) -> ProofGraphRegistration:
    """Validate exact UTF-8 JSON bytes without canonicalizing their digest."""
    if not isinstance(content_bytes, bytes):
        raise ProofGraphRegistryError("Proof DAG content must be bytes")
    if not 1 <= len(content_bytes) <= MAX_PROOF_GRAPH_BYTES:
        raise ProofGraphRegistryError("Proof DAG must contain 1 byte to 16 MiB")
    try:
        artifact = json.loads(
            content_bytes.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
        )
    except ProofGraphRegistryError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProofGraphRegistryError("Proof DAG is not valid bounded UTF-8 JSON") from error
    if not isinstance(artifact, dict):
        raise ProofGraphRegistryError("Proof DAG must be a JSON object")
    if artifact.get("schema_id") != PROOF_DAG_SCHEMA:
        raise ProofGraphRegistryError(f"Proof DAG must use {PROOF_DAG_SCHEMA}")

    graph_id = _identifier(artifact.get("graph_id"), "Proof DAG graph_id")
    graph_kind = _bounded_text(artifact.get("graph_kind"), "Proof DAG graph_kind", 120)
    if graph_kind not in GRAPH_KINDS:
        raise ProofGraphRegistryError("Proof DAG graph_kind is not supported")
    title = _bounded_text(artifact.get("title"), "Proof DAG title", 200) or graph_id
    targets = artifact.get("targets")
    relations = artifact.get("relations")
    if not isinstance(targets, list) or not 1 <= len(targets) <= 10_000:
        raise ProofGraphRegistryError("Proof DAG targets must contain 1 to 10,000 entries")
    if not isinstance(relations, list) or len(relations) > 50_000:
        raise ProofGraphRegistryError("Proof DAG relations must contain at most 50,000 entries")

    target_ids: list[str] = []
    target_set: set[str] = set()
    for index, target in enumerate(targets, start=1):
        if not isinstance(target, dict):
            raise ProofGraphRegistryError(f"Target {index} must be an object")
        target_id = _identifier(target.get("target_id"), f"Target {index} target_id")
        if target_id in target_set:
            raise ProofGraphRegistryError(f"Target {target_id} is duplicated")
        target_set.add(target_id)
        target_ids.append(target_id)
        _bounded_text(target.get("title"), f"Target {target_id} title", 200)
        _bounded_text(
            target.get("natural_language_summary"),
            f"Target {target_id} natural_language_summary",
            4_000,
        )
        _bounded_text(target.get("category"), f"Target {target_id} category", 120)
        _bounded_text(target.get("target_kind"), f"Target {target_id} target_kind", 120)
        binding = target.get("formal_binding")
        if binding is not None and not isinstance(binding, dict):
            raise ProofGraphRegistryError(f"Target {target_id} formal_binding must be an object")
        if isinstance(binding, dict):
            _bounded_text(binding.get("status"), f"Target {target_id} formal binding status", 120)

    relation_ids: set[str] = set()
    prerequisite_edges: list[tuple[str, str]] = []
    for index, relation in enumerate(relations, start=1):
        if not isinstance(relation, dict):
            raise ProofGraphRegistryError(f"Relation {index} must be an object")
        source = _identifier(
            relation.get("prerequisite_target_id"),
            f"Relation {index} prerequisite_target_id",
        )
        target = _identifier(
            relation.get("dependent_target_id"),
            f"Relation {index} dependent_target_id",
        )
        if source not in target_set or target not in target_set:
            raise ProofGraphRegistryError(f"Relation {index} references a missing target")
        if source == target:
            raise ProofGraphRegistryError(f"Relation {index} cannot be self-referential")
        relation_id = _bounded_text(
            relation.get("relation_id"), f"Relation {index} relation_id", 512, required=True,
        )
        if relation_id in relation_ids:
            raise ProofGraphRegistryError(f"Relation {relation_id} is duplicated")
        relation_ids.add(relation_id)
        relation_type = _bounded_text(
            relation.get("relation_type"),
            f"Relation {relation_id} relation_type",
            120,
            required=True,
        )
        if relation_type not in RELATION_TYPES:
            raise ProofGraphRegistryError(
                f"Relation {relation_id} relation_type is not supported"
            )
        if relation_type in PREREQUISITE_RELATION_TYPES:
            prerequisite_edges.append((source, target))

    ordered_target_ids = tuple(target_ids)
    _topological_check(ordered_target_ids, prerequisite_edges)
    content_sha256 = hashlib.sha256(content_bytes).hexdigest()
    target_indexes = {
        target_id: index for index, target_id in enumerate(ordered_target_ids)
    }
    node_ref_ids = tuple(
        readable if len(readable := f"{graph_id}#{target_id}") <= 512
        else f"proof-node-{content_sha256}-{target_indexes[target_id]}"
        for target_id in ordered_target_ids
    )
    if len(set(node_ref_ids)) != len(node_ref_ids):
        raise ProofGraphRegistryError("Proof DAG node reference identifiers collide")
    if graph_kind in CLAIMABLE_GRAPH_KINDS:
        for target_id in ordered_target_ids:
            if (
                not TASK_RESOURCE_COMPONENT.fullmatch(graph_id)
                or not TASK_RESOURCE_COMPONENT.fullmatch(target_id)
            ):
                raise ProofGraphRegistryError(
                    "Proof program or target ID cannot be represented as a HAM resource key"
                )
            resource_ref = f"proof-packet:sha256:{content_sha256}/{graph_id}/{target_id}"
            if len(resource_ref) > 500:
                raise ProofGraphRegistryError(
                    "Proof target reference exceeds the HAM resource key boundary"
                )
    return ProofGraphRegistration(
        content_bytes=content_bytes,
        content_sha256=content_sha256,
        artifact=artifact,
        graph_id=graph_id,
        graph_kind=graph_kind,
        title=title,
        target_ids=ordered_target_ids,
        node_ref_ids=node_ref_ids,
        relation_count=len(relations),
    )
