"""Pure, bounded proposals for additive task-plan structure.

A proposal is an exact-base review artifact.  It never writes a task plan,
creates a HAM task, dispatches work, or promotes semantic relations.  The
caller may later apply the returned operations to an in-browser draft and use
the existing task-plan save path after human review.
"""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from typing import Any

from object_links import ObjectLinkError, parse_canonical_reference
from task_plan_contract import (
    APPROVED_NODE_KINDS,
    MAX_EDGES,
    MAX_NODES,
    TaskPlanContractError,
    validate_task_plan_spec,
)


TASK_PLAN_PROPOSAL_SCHEMA = "gb.task-plan-proposal.v1"
TASK_PLAN_PROPOSAL_ACTIONS = frozenset({
    "branch", "join", "compare", "challenge", "synthesize",
})
BRANCH_JOB_KINDS = APPROVED_NODE_KINDS - {"branch", "join", "context"}
MAX_SOURCE_JOBS = 16
MAX_BRANCH_JOBS = 8
MAX_INPUT_REFS = 64
MAX_PROPOSAL_BYTES = 65_536

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_HAM_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class TaskPlanProposalError(ValueError):
    """Raised when an intent or generated proposal is outside the contract."""


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise TaskPlanProposalError("task plan proposal must be finite JSON data") from error


def _text(value: Any, path: str, maximum: int, *, optional: bool = False) -> str | None:
    if optional and (value is None or value == ""):
        return None
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    ):
        raise TaskPlanProposalError(f"{path} is invalid")
    return value


def _positive_integer(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise TaskPlanProposalError(f"{path} must be a positive integer")
    return value


def _identifier(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise TaskPlanProposalError(f"{path} must be a stable identifier")
    return value


def _input_refs(value: Any, path: str) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_INPUT_REFS:
        raise TaskPlanProposalError(f"{path} must contain at most {MAX_INPUT_REFS} references")
    result: list[str] = []
    for index, item in enumerate(value):
        try:
            parsed = parse_canonical_reference(item)
        except ObjectLinkError as error:
            raise TaskPlanProposalError(f"{path}[{index}] is not a canonical reference") from error
        if parsed.revision is None:
            raise TaskPlanProposalError(f"{path}[{index}] must pin an exact revision")
        if len(parsed.wire) > 500:
            raise TaskPlanProposalError(f"{path}[{index}] exceeds the task-plan reference limit")
        if parsed.wire in result:
            raise TaskPlanProposalError(f"{path} contains a duplicate reference")
        result.append(parsed.wire)
    return result


def _branch_job(value: Any, index: int) -> dict:
    path = f"branches[{index}]"
    if not isinstance(value, dict) or not set(value) == {
        "kind", "title", "goal", "instruction", "inputRefs",
    }:
        raise TaskPlanProposalError(f"{path} has an invalid shape")
    kind = value.get("kind")
    if kind not in BRANCH_JOB_KINDS:
        raise TaskPlanProposalError(f"{path}.kind is not approved for a branch arm")
    return {
        "kind": kind,
        "title": _text(value.get("title"), f"{path}.title", 200),
        "goal": _text(value.get("goal"), f"{path}.goal", 4_000),
        "instruction": _text(value.get("instruction"), f"{path}.instruction", 20_000, optional=True),
        "inputRefs": _input_refs(value.get("inputRefs"), f"{path}.inputRefs"),
    }


def _aggregate_input_refs(input_refs: list[str], branches: list[dict]) -> list[str]:
    result: list[str] = []
    for reference in input_refs:
        if reference not in result:
            result.append(reference)
    for branch in branches:
        for reference in branch["inputRefs"]:
            if reference not in result:
                result.append(reference)
            if len(result) > MAX_INPUT_REFS:
                raise TaskPlanProposalError(
                    f"task plan proposal must contain at most {MAX_INPUT_REFS} distinct input references"
                )
    return result


def validate_task_plan_proposal_intent(value: Any) -> dict:
    """Validate the normalized request supplied by the trusted agent gateway."""
    if not isinstance(value, dict) or set(value) != {
        "action", "expectedVersion", "expectedContentHash", "expectedHamTaskId",
        "expectedHamTaskVersion", "sourceJobIds", "title", "goal", "instruction",
        "inputRefs", "branches",
    }:
        raise TaskPlanProposalError("task plan proposal intent has an invalid shape")
    if len(_canonical_json(value)) > MAX_PROPOSAL_BYTES:
        raise TaskPlanProposalError("task plan proposal intent exceeds 64 KiB")

    action = value.get("action")
    if action not in TASK_PLAN_PROPOSAL_ACTIONS:
        raise TaskPlanProposalError("action is not approved")
    content_hash = value.get("expectedContentHash")
    if not isinstance(content_hash, str) or not _SHA256.fullmatch(content_hash):
        raise TaskPlanProposalError("expectedContentHash must be a lowercase SHA-256 digest")
    ham_task_id = value.get("expectedHamTaskId")
    if not isinstance(ham_task_id, str) or not _HAM_TASK_ID.fullmatch(ham_task_id):
        raise TaskPlanProposalError("expectedHamTaskId is invalid")

    sources = value.get("sourceJobIds")
    if not isinstance(sources, list) or not sources or len(sources) > MAX_SOURCE_JOBS:
        raise TaskPlanProposalError(f"sourceJobIds must contain 1-{MAX_SOURCE_JOBS} identifiers")
    normalized_sources: list[str] = []
    for index, item in enumerate(sources):
        item = _identifier(item, f"sourceJobIds[{index}]")
        if item in normalized_sources:
            raise TaskPlanProposalError("sourceJobIds contains a duplicate identifier")
        normalized_sources.append(item)

    if action == "branch" and len(normalized_sources) != 1:
        raise TaskPlanProposalError("branch proposals require exactly one source job")
    if action in {"join", "compare", "synthesize"} and len(normalized_sources) < 2:
        raise TaskPlanProposalError(f"{action} proposals require at least two source jobs")

    branches = value.get("branches")
    if not isinstance(branches, list):
        raise TaskPlanProposalError("branches must be an array")
    if action == "branch":
        if not 2 <= len(branches) <= MAX_BRANCH_JOBS:
            raise TaskPlanProposalError(f"branch proposals require 2-{MAX_BRANCH_JOBS} branch jobs")
    elif branches:
        raise TaskPlanProposalError("only branch proposals may contain branch jobs")

    input_refs = _input_refs(value.get("inputRefs"), "inputRefs")
    normalized_branches = [_branch_job(item, index) for index, item in enumerate(branches)]
    _aggregate_input_refs(input_refs, normalized_branches)
    return {
        "action": action,
        "expectedVersion": _positive_integer(value.get("expectedVersion"), "expectedVersion"),
        "expectedContentHash": content_hash,
        "expectedHamTaskId": ham_task_id,
        "expectedHamTaskVersion": _positive_integer(
            value.get("expectedHamTaskVersion"), "expectedHamTaskVersion",
        ),
        "sourceJobIds": normalized_sources,
        "title": _text(value.get("title"), "title", 200),
        "goal": _text(value.get("goal"), "goal", 4_000),
        "instruction": _text(value.get("instruction"), "instruction", 20_000, optional=True),
        "inputRefs": input_refs,
        "branches": normalized_branches,
    }


def proposal_input_references(intent: dict) -> list[str]:
    return _aggregate_input_refs(intent["inputRefs"], intent["branches"])


def _available_id(existing: set[str], candidate: str) -> str:
    if candidate not in existing:
        existing.add(candidate)
        return candidate
    for counter in range(1, 10_000):
        suffixed = f"{candidate}-{counter}"
        if len(suffixed) <= 128 and suffixed not in existing:
            existing.add(suffixed)
            return suffixed
    raise TaskPlanProposalError("a collision-safe proposal identifier could not be generated")


def _clamp_coordinate(value: float) -> int:
    return int(max(-999_000, min(999_000, round(value))))


def _node_config(instruction: str | None, input_refs: list[str]) -> dict:
    return {
        **({"instruction": instruction} if instruction is not None else {}),
        **({"inputRefs": list(input_refs)} if input_refs else {}),
    }


def build_task_plan_proposal(task_plan_id: str, plan: dict, raw_intent: Any) -> dict:
    """Build and validate an additive proposal without mutating ``plan`` or storage."""
    intent = validate_task_plan_proposal_intent(raw_intent)
    try:
        normalized_spec = validate_task_plan_spec(plan.get("current_spec"))
    except TaskPlanContractError as error:
        raise TaskPlanProposalError("stored task plan does not satisfy the active contract") from error

    if plan.get("id") != task_plan_id:
        raise TaskPlanProposalError("stored task plan identity does not match the route")
    if plan.get("current_version") != intent["expectedVersion"]:
        raise TaskPlanProposalError("task plan base version is stale")
    if plan.get("current_content_hash") != intent["expectedContentHash"]:
        raise TaskPlanProposalError("task plan base content hash is stale")
    if plan.get("ham_task_id") != intent["expectedHamTaskId"]:
        raise TaskPlanProposalError("HAM task identity does not match the task plan")
    task = normalized_spec["task"]
    if task.get("id") != intent["expectedHamTaskId"] or task.get("version") != intent["expectedHamTaskVersion"]:
        raise TaskPlanProposalError("HAM task version does not match the saved task plan")

    nodes_by_id = {node["id"]: node for node in normalized_spec["nodes"]}
    if any(source not in nodes_by_id for source in intent["sourceJobIds"]):
        raise TaskPlanProposalError("sourceJobIds references an unknown task-plan job")

    seed = hashlib.sha256(_canonical_json({
        "schemaId": TASK_PLAN_PROPOSAL_SCHEMA,
        "taskPlanId": task_plan_id,
        "intent": intent,
    })).hexdigest()
    token = seed[:16]
    node_ids = set(nodes_by_id)
    edge_ids = {edge["id"] for edge in normalized_spec["edges"]}
    operations: list[dict] = []

    source_nodes = [nodes_by_id[source] for source in intent["sourceJobIds"]]
    source_x = max(float(node["position"]["x"]) for node in source_nodes)
    source_y = sum(float(node["position"]["y"]) for node in source_nodes) / len(source_nodes)

    primary_id = _available_id(node_ids, f"proposal-{intent['action']}-{token}")
    primary_node = {
        "id": primary_id,
        "kind": intent["action"],
        "title": intent["title"],
        "goal": intent["goal"],
        "position": {
            "x": _clamp_coordinate(source_x + 290),
            "y": _clamp_coordinate(source_y),
        },
        "config": _node_config(intent["instruction"], intent["inputRefs"]),
    }
    operations.append({"op": "node.add", "node": primary_node})

    incoming_kind = {
        "branch": "control",
        "join": "join",
        "compare": "evidence",
        "challenge": "evidence",
        "synthesize": "data",
    }[intent["action"]]
    for index, source in enumerate(intent["sourceJobIds"]):
        edge_id = _available_id(edge_ids, f"proposal-edge-{token}-in-{index + 1}")
        operations.append({
            "op": "edge.add",
            "edge": {"id": edge_id, "source": source, "target": primary_id, "kind": incoming_kind},
        })

    if intent["action"] == "branch":
        count = len(intent["branches"])
        for index, branch in enumerate(intent["branches"]):
            arm_id = _available_id(node_ids, f"proposal-{branch['kind']}-{token}-arm-{index + 1}")
            arm_node = {
                "id": arm_id,
                "kind": branch["kind"],
                "title": branch["title"],
                "goal": branch["goal"],
                "position": {
                    "x": _clamp_coordinate(source_x + 580),
                    "y": _clamp_coordinate(source_y + (index - (count - 1) / 2) * 190),
                },
                "config": _node_config(branch["instruction"], branch["inputRefs"]),
            }
            operations.append({"op": "node.add", "node": arm_node})
            edge_id = _available_id(edge_ids, f"proposal-edge-{token}-arm-{index + 1}")
            operations.append({
                "op": "edge.add",
                "edge": {"id": edge_id, "source": primary_id, "target": arm_id, "kind": "branch"},
            })

    candidate = deepcopy(normalized_spec)
    for operation in operations:
        if operation["op"] == "node.add":
            candidate["nodes"].append(deepcopy(operation["node"]))
        else:
            candidate["edges"].append(deepcopy(operation["edge"]))
    try:
        validate_task_plan_spec(candidate)
    except TaskPlanContractError as error:
        raise TaskPlanProposalError(f"proposal would create an invalid task plan: {error}") from error
    if len(candidate["nodes"]) > MAX_NODES or len(candidate["edges"]) > MAX_EDGES:
        raise TaskPlanProposalError("proposal exceeds task plan graph limits")

    proposal = {
        "schemaId": TASK_PLAN_PROPOSAL_SCHEMA,
        "requestHash": f"sha256:{hashlib.sha256(_canonical_json(intent)).hexdigest()}",
        "scope": "task-local-work",
        "effect": "proposal",
        "action": intent["action"],
        "base": {
            "taskPlanId": task_plan_id,
            "taskPlanVersion": intent["expectedVersion"],
            "taskPlanContentHash": intent["expectedContentHash"],
            "hamTaskId": intent["expectedHamTaskId"],
            "hamTaskVersion": intent["expectedHamTaskVersion"],
        },
        "sourceJobIds": list(intent["sourceJobIds"]),
        "inputRefs": proposal_input_references(intent),
        "operations": operations,
        "summary": f"Proposed {intent['action']} structure with {len(operations)} additive operations.",
    }
    proposal_hash = hashlib.sha256(_canonical_json(proposal)).hexdigest()
    result = {**proposal, "proposalHash": f"sha256:{proposal_hash}"}
    if len(_canonical_json(result)) > MAX_PROPOSAL_BYTES:
        raise TaskPlanProposalError("generated task plan proposal exceeds 64 KiB")
    return result
