"""Server-authoritative derivation of inactive proof mission candidates."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from proof_graph_registry import (
    PREREQUISITE_RELATION_TYPES,
    ProofGraphRegistration,
    ProofGraphRegistryError,
    parse_proof_graph_bytes,
)


MISSION_INTENT_SCHEMA = "galaxy.proof-mission-intent.v1"
MISSION_CANDIDATE_SCHEMA = "galaxy.proof-mission-candidate.v1"
MISSION_COMPILER = "galaxy.proof-mission-compiler.v1"
RELATION_DIRECTION = "prerequisite-to-dependent"
MAX_MISSION_INTENT_BYTES = 65_536
MAX_MISSION_TARGETS = 2_000
MAX_MISSION_RELATIONS = 10_000
MAX_MISSION_MILESTONES = 500
MAX_METADATA_ITEMS = 2_000
MISSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")


class ProofMissionContractError(ValueError):
    """The mission intent or its exact registered source is invalid."""


@dataclass(frozen=True)
class ProofMissionCandidate:
    envelope: dict[str, Any]
    mission_bytes: bytes
    mission_content_sha256: str


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProofMissionContractError(f"{label} must be an object")
    return value


def _exact_keys(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        name = sorted(unknown)[0]
        raise ProofMissionContractError(f"{label}.{name} is not supported")


def _text(value: Any, label: str, maximum: int, *, required: bool = False) -> str:
    if value is None:
        if required:
            raise ProofMissionContractError(f"{label} is required")
        return ""
    if not isinstance(value, str):
        raise ProofMissionContractError(f"{label} must be text")
    normalized = value.strip()
    if required and not normalized:
        raise ProofMissionContractError(f"{label} is required")
    try:
        utf16_length = len(normalized.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise ProofMissionContractError(f"{label} contains an unpaired surrogate") from error
    if utf16_length > maximum:
        raise ProofMissionContractError(f"{label} exceeds {maximum} characters")
    return normalized


def _text_array(value: Any, label: str, *, nullable: bool = False) -> list[str] | None:
    if value is None and nullable:
        return None
    if value is None:
        raise ProofMissionContractError(f"{label} must be an array")
    if not isinstance(value, list) or len(value) > MAX_METADATA_ITEMS:
        raise ProofMissionContractError(
            f"{label} must contain at most {MAX_METADATA_ITEMS} entries"
        )
    result: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        parsed = _text(item, f"{label}[{index}]", 512, required=True)
        if parsed in seen:
            raise ProofMissionContractError(f"{label} contains duplicate {parsed}")
        seen.add(parsed)
        result.append(parsed)
    return result


def _copy_target(target: dict[str, Any]) -> dict[str, Any]:
    target_id = target["target_id"].strip()
    copied: dict[str, Any] = {
        "target_id": target_id,
        "target_kind": _text(target.get("target_kind"), f"Target {target_id} target_kind", 120),
        "title": _text(target.get("title"), f"Target {target_id} title", 200) or target_id,
        "natural_language_summary": _text(
            target.get("natural_language_summary"),
            f"Target {target_id} natural_language_summary",
            4_000,
        ),
        "category": _text(target.get("category"), f"Target {target_id} category", 120),
    }
    for name, maximum in (("source_id", 512), ("source_label", 1_000)):
        if name in target:
            copied[name] = _text(
                target[name], f"Target {target_id} {name}", maximum, required=True
            )

    binding = target.get("formal_binding")
    source = {} if binding is None else _object(binding, f"Target {target_id} formal_binding")
    result: dict[str, Any] = {
        "status": _text(source.get("status"), f"Target {target_id} formal_binding.status", 120),
    }
    for name, maximum in (("binding_kind", 120), ("mapping_rule", 4_000)):
        if name in source:
            result[name] = _text(
                source[name], f"Target {target_id} formal_binding.{name}", maximum, required=True
            )
    for name in ("module_ids", "declaration_ids"):
        if name in source:
            result[name] = _text_array(
                source[name], f"Target {target_id} formal_binding.{name}"
            )
    if "declaration_equivalence_claimed" in source:
        claimed = source["declaration_equivalence_claimed"]
        if not isinstance(claimed, bool):
            raise ProofMissionContractError(
                f"Target {target_id} formal_binding.declaration_equivalence_claimed must be boolean"
            )
        result["declaration_equivalence_claimed"] = claimed
    copied["formal_binding"] = result
    return copied


def _copy_formal_correspondence(value: Any, label: str) -> dict[str, Any]:
    source = _object(value, label)
    result: dict[str, Any] = {
        "status": _text(source.get("status"), f"{label}.status", 120, required=True),
    }
    if "support_kind" not in source or "declaration_path" not in source or "dependency_kinds_by_step" not in source:
        raise ProofMissionContractError(f"{label} is missing required correspondence fields")
    result["support_kind"] = (
        None if source["support_kind"] is None
        else _text(source["support_kind"], f"{label}.support_kind", 120, required=True)
    )
    result["declaration_path"] = _text_array(
        source["declaration_path"], f"{label}.declaration_path", nullable=True
    )
    steps = source["dependency_kinds_by_step"]
    if not isinstance(steps, list) or len(steps) > MAX_METADATA_ITEMS:
        raise ProofMissionContractError(
            f"{label}.dependency_kinds_by_step must contain at most {MAX_METADATA_ITEMS} entries"
        )
    total = 0
    parsed_steps = []
    for index, step in enumerate(steps):
        parsed = _text_array(step, f"{label}.dependency_kinds_by_step[{index}]")
        total += len(parsed)
        if total > MAX_METADATA_ITEMS:
            raise ProofMissionContractError(
                f"{label}.dependency_kinds_by_step must contain at most "
                f"{MAX_METADATA_ITEMS} dependency kinds"
            )
        parsed_steps.append(parsed)
    result["dependency_kinds_by_step"] = parsed_steps
    return result


def _copy_relation(relation: dict[str, Any]) -> dict[str, Any]:
    relation_id = relation["relation_id"].strip()
    copied: dict[str, Any] = {
        "relation_id": relation_id,
        "relation_type": relation["relation_type"].strip(),
        "prerequisite_target_id": relation["prerequisite_target_id"].strip(),
        "dependent_target_id": relation["dependent_target_id"].strip(),
    }
    for name, maximum in (("source_edge_id", 512), ("assertion_level", 120)):
        if name in relation:
            copied[name] = _text(
                relation[name], f"Relation {relation_id} {name}", maximum, required=True
            )
    if "formal_correspondence" in relation:
        copied["formal_correspondence"] = _copy_formal_correspondence(
            relation["formal_correspondence"], f"Relation {relation_id} formal_correspondence"
        )
    nomination = relation.get("bridge_nomination")
    if nomination is not None:
        source = _object(nomination, f"Relation {relation_id} bridge_nomination")
        if not isinstance(source.get("nominated"), bool):
            raise ProofMissionContractError(
                f"Relation {relation_id} bridge_nomination.nominated must be boolean"
            )
        copied["bridge_nomination"] = {
            "nominated": source["nominated"],
            "reason": _text(
                source.get("reason"),
                f"Relation {relation_id} bridge_nomination.reason",
                4_000,
                required=True,
            ),
        }
    return copied


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProofMissionContractError("Duplicate mission intent fields are not allowed")
        result[key] = value
    return result


def _reject_non_json_number(value: str):
    raise ProofMissionContractError(f"Non-finite JSON number {value} is not allowed")


def _javascript_text_sort_key(value: str) -> bytes:
    """Match JavaScript's lexicographic UTF-16 code-unit ordering."""
    return value.encode("utf-16-be")


def parse_mission_intent_bytes(content: bytes) -> dict[str, Any]:
    if not isinstance(content, bytes) or not 1 <= len(content) <= MAX_MISSION_INTENT_BYTES:
        raise ProofMissionContractError("Mission intent must contain 1 byte to 64 KiB")
    try:
        intent = json.loads(
            content.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
        )
    except ProofMissionContractError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProofMissionContractError("Mission intent must be valid UTF-8 JSON") from error
    return _object(intent, "Mission intent")


def derive_proof_mission(
    source: ProofGraphRegistration,
    intent_value: dict[str, Any],
) -> ProofMissionCandidate:
    """Recompute a deterministic, inactive mission from one exact passive source."""
    intent = _object(intent_value, "Mission intent")
    _exact_keys(intent, {
        "schema_id", "source_graph", "mission_id", "main_target_id",
        "curated_milestone_target_ids", "relation_direction",
    }, "Mission intent")
    if intent.get("schema_id") != MISSION_INTENT_SCHEMA:
        raise ProofMissionContractError(f"Mission intent must use {MISSION_INTENT_SCHEMA}")
    if source.graph_kind != "repository-field":
        raise ProofMissionContractError("Mission source must be a passive repository-field proof DAG")

    source_ref = _object(intent.get("source_graph"), "Mission intent source_graph")
    _exact_keys(
        source_ref, {"graph_id", "graph_kind", "content_sha256"},
        "Mission intent source_graph",
    )
    if source_ref.get("graph_id") != source.graph_id:
        raise ProofMissionContractError("Mission source graph_id does not match the registered graph")
    if source_ref.get("content_sha256") != source.content_sha256:
        raise ProofMissionContractError("Mission source content_sha256 does not match the registered graph")
    if source_ref.get("graph_kind") != "repository-field":
        raise ProofMissionContractError("Mission source graph_kind must be repository-field")
    if intent.get("relation_direction") != RELATION_DIRECTION:
        raise ProofMissionContractError(
            f"Mission relation_direction must be {RELATION_DIRECTION}"
        )

    mission_id = _text(intent.get("mission_id"), "Mission intent mission_id", 120, required=True)
    if not MISSION_ID.fullmatch(mission_id):
        raise ProofMissionContractError("Mission intent mission_id is invalid")
    main_target_id = _text(
        intent.get("main_target_id"), "Mission intent main_target_id", 512, required=True
    )
    milestones_value = intent.get("curated_milestone_target_ids")
    if not isinstance(milestones_value, list) or len(milestones_value) > MAX_MISSION_MILESTONES:
        raise ProofMissionContractError(
            f"Mission milestones must contain at most {MAX_MISSION_MILESTONES} entries"
        )
    milestones: list[str] = []
    seen_milestones: set[str] = set()
    for index, value in enumerate(milestones_value):
        milestone = _text(value, f"Mission milestone {index}", 512, required=True)
        if milestone == main_target_id:
            raise ProofMissionContractError("The main target cannot also be a curated milestone")
        if milestone in seen_milestones:
            raise ProofMissionContractError(f"Mission milestone {milestone} is duplicated")
        seen_milestones.add(milestone)
        milestones.append(milestone)
    milestones.sort()

    artifact = source.artifact
    targets = {target["target_id"].strip(): target for target in artifact["targets"]}
    if main_target_id not in targets:
        raise ProofMissionContractError("Mission main_target_id is absent from the registered source")
    for milestone in milestones:
        if milestone not in targets:
            raise ProofMissionContractError(f"Mission milestone {milestone} is absent from the source")

    prerequisite_relations = [
        relation for relation in artifact["relations"]
        if relation["relation_type"].strip() in PREREQUISITE_RELATION_TYPES
    ]
    incoming: dict[str, list[str]] = {target_id: [] for target_id in targets}
    for relation in prerequisite_relations:
        incoming[relation["dependent_target_id"].strip()].append(
            relation["prerequisite_target_id"].strip()
        )
    selected: set[str] = set()
    pending = [main_target_id]
    while pending:
        target_id = pending.pop()
        if target_id in selected:
            continue
        selected.add(target_id)
        if len(selected) > MAX_MISSION_TARGETS:
            raise ProofMissionContractError(
                f"Mission prerequisite closure exceeds {MAX_MISSION_TARGETS} targets"
            )
        pending.extend(incoming[target_id])
    for milestone in milestones:
        if milestone not in selected:
            raise ProofMissionContractError(
                f"Mission milestone {milestone} is outside the main target prerequisite closure"
            )

    selected_relations = [
        relation for relation in artifact["relations"]
        if relation["prerequisite_target_id"].strip() in selected
        and relation["dependent_target_id"].strip() in selected
    ]
    if len(selected_relations) > MAX_MISSION_RELATIONS:
        raise ProofMissionContractError(
            f"Mission relations exceed {MAX_MISSION_RELATIONS}"
        )
    relation_ids = {relation["relation_id"].strip() for relation in selected_relations}
    visible_milestone_edges = {
        (
            relation["prerequisite_target_id"].strip(),
            relation["dependent_target_id"].strip(),
        )
        for relation in selected_relations
        if relation["relation_type"].strip() == "MILESTONE_OF"
    }
    generated_index = 1
    for milestone in milestones:
        if (milestone, main_target_id) in visible_milestone_edges:
            continue
        while True:
            relation_id = f"mission-milestone-{generated_index:06d}"
            generated_index += 1
            if relation_id not in relation_ids:
                break
        relation_ids.add(relation_id)
        selected_relations.append({
            "relation_id": relation_id,
            "relation_type": "MILESTONE_OF",
            "prerequisite_target_id": milestone,
            "dependent_target_id": main_target_id,
        })
    if len(selected_relations) > MAX_MISSION_RELATIONS:
        raise ProofMissionContractError(
            f"Mission relations exceed {MAX_MISSION_RELATIONS}"
        )

    main_target = targets[main_target_id]
    mission = {
        "schema_id": "galaxy.proof-dag.v1",
        "graph_id": mission_id,
        "graph_kind": "mission",
        "title": _text(main_target.get("title"), "Mission title", 200) or main_target_id,
        "mission": {
            "main_target_id": main_target_id,
            "curated_milestone_target_ids": milestones,
        },
        "provenance": {
            "source_graph": {
                "graph_id": source.graph_id,
                "graph_kind": "repository-field",
                "content_sha256": source.content_sha256,
            },
            "compiler": MISSION_COMPILER,
        },
        "targets": [_copy_target(targets[target_id]) for target_id in sorted(selected)],
        "relations": [
            _copy_relation(relation)
            for relation in sorted(
                selected_relations,
                key=lambda item: _javascript_text_sort_key(item["relation_id"].strip()),
            )
        ],
    }
    mission_bytes = json.dumps(
        mission, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")
    try:
        parsed_mission = parse_proof_graph_bytes(mission_bytes)
    except ProofGraphRegistryError as error:
        raise ProofMissionContractError(str(error)) from error
    mission_digest = hashlib.sha256(mission_bytes).hexdigest()
    envelope = {
        "schema_id": MISSION_CANDIDATE_SCHEMA,
        "activation_state": "inactive",
        "registerable": False,
        "source_graph": {
            "graph_id": source.graph_id,
            "graph_kind": "repository-field",
            "content_sha256": source.content_sha256,
        },
        "selection": {
            "mission_id": mission_id,
            "main_target_id": main_target_id,
            "curated_milestone_target_ids": milestones,
            "relation_direction": RELATION_DIRECTION,
        },
        "mission_content_sha256": mission_digest,
        "mission_dag": parsed_mission.artifact,
    }
    return ProofMissionCandidate(envelope, mission_bytes, mission_digest)
