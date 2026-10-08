"""Bounded, provider-neutral task-plan contract for Galaxy Brain.

Task plans describe how a canonical HAM task may be carried out. They are
versioned construction artifacts, not executable Python or provider-specific
LangChain graphs. The validator deliberately accepts only finite JSON data and
an acyclic graph of approved job kinds.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any


TASK_PLAN_SCHEMA = "gb.task-plan.v1"
MAX_NODES = 128
MAX_EDGES = 512
MAX_JSON_BYTES = 512_000
MAX_STRING_LENGTH = 20_000

APPROVED_NODE_KINDS = frozenset({
    "context",
    "research",
    "transform",
    "compare",
    "challenge",
    "synthesize",
    "branch",
    "join",
    "checkpoint",
    "artifact",
})
APPROVED_EDGE_KINDS = frozenset({"control", "data", "evidence", "branch", "join"})
APPROVED_CONFIG_KEYS = frozenset({
    "instruction",
    "inputRefs",
    "outputRefs",
    "capabilities",
    "executorProfile",
    "requiresApproval",
    "artifactType",
})

IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
TASK_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")


class TaskPlanContractError(ValueError):
    """Raised when a proposed plan falls outside the bounded contract."""


def _identifier(value: Any, path: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.fullmatch(value):
        raise TaskPlanContractError(f"{path} must be a stable identifier")
    return value


def _string(value: Any, path: str, *, minimum: int = 0, maximum: int = MAX_STRING_LENGTH) -> str:
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise TaskPlanContractError(f"{path} must contain {minimum}-{maximum} characters")
    return value


def _string_list(value: Any, path: str, *, maximum_items: int = 64) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise TaskPlanContractError(f"{path} must be an array of at most {maximum_items} strings")
    result: list[str] = []
    for index, item in enumerate(value):
        normalized = _string(item, f"{path}[{index}]", minimum=1, maximum=500).strip()
        if normalized not in result:
            result.append(normalized)
    return result


def _assert_acyclic(node_ids: set[str], edges: list[dict]) -> None:
    outgoing = {node_id: [] for node_id in node_ids}
    indegree = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        outgoing[edge["source"]].append(edge["target"])
        indegree[edge["target"]] += 1
    queue = [node_id for node_id, degree in indegree.items() if degree == 0]
    visited = 0
    while queue:
        node_id = queue.pop()
        visited += 1
        for target in outgoing[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(node_ids):
        raise TaskPlanContractError("task plan graph must be acyclic")


def validate_task_plan_spec(value: Any) -> dict:
    """Validate and return a detached JSON-compatible task-plan specification."""
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise TaskPlanContractError("task plan must be finite JSON data") from error
    if len(encoded.encode("utf-8")) > MAX_JSON_BYTES:
        raise TaskPlanContractError("task plan exceeds the maximum encoded size")
    if not isinstance(value, dict) or set(value) != {"schema", "task", "goal", "nodes", "edges"}:
        raise TaskPlanContractError("task plan must contain exactly schema, task, goal, nodes, and edges")
    if value.get("schema") != TASK_PLAN_SCHEMA:
        raise TaskPlanContractError(f"task plan schema must be {TASK_PLAN_SCHEMA}")

    task = value.get("task")
    if not isinstance(task, dict) or not {"kind", "id"} <= set(task) <= {"kind", "id", "version"}:
        raise TaskPlanContractError("task reference is invalid")
    if task.get("kind") != "galaxy.ham.task":
        raise TaskPlanContractError("task reference kind must be galaxy.ham.task")
    if not isinstance(task.get("id"), str) or not TASK_REF_PATTERN.fullmatch(task["id"]):
        raise TaskPlanContractError("task.id is invalid")
    if "version" in task and (
        not isinstance(task["version"], int)
        or isinstance(task["version"], bool)
        or task["version"] < 1
    ):
        raise TaskPlanContractError("task.version must be a positive integer")

    _string(value.get("goal"), "goal", minimum=1, maximum=20_000)
    nodes = value.get("nodes")
    edges = value.get("edges")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODES:
        raise TaskPlanContractError(f"task plan must contain 1-{MAX_NODES} nodes")
    if not isinstance(edges, list) or len(edges) > MAX_EDGES:
        raise TaskPlanContractError(f"task plan may contain at most {MAX_EDGES} edges")

    node_ids: set[str] = set()
    for index, node in enumerate(nodes):
        path = f"nodes[{index}]"
        if not isinstance(node, dict) or set(node) != {"id", "kind", "title", "goal", "position", "config"}:
            raise TaskPlanContractError(f"{path} has an invalid shape")
        node_id = _identifier(node.get("id"), f"{path}.id")
        if node_id in node_ids:
            raise TaskPlanContractError(f"duplicate node id: {node_id}")
        node_ids.add(node_id)
        if node.get("kind") not in APPROVED_NODE_KINDS:
            raise TaskPlanContractError(f"{path}.kind is not approved")
        _string(node.get("title"), f"{path}.title", minimum=1, maximum=200)
        _string(node.get("goal"), f"{path}.goal", maximum=4_000)
        position = node.get("position")
        if not isinstance(position, dict) or set(position) != {"x", "y"}:
            raise TaskPlanContractError(f"{path}.position is invalid")
        for axis in ("x", "y"):
            coordinate = position.get(axis)
            if (
                not isinstance(coordinate, (int, float))
                or isinstance(coordinate, bool)
                or not math.isfinite(coordinate)
                or abs(coordinate) > 1_000_000
            ):
                raise TaskPlanContractError(f"{path}.position.{axis} is invalid")
        config = node.get("config")
        if not isinstance(config, dict) or set(config) - APPROVED_CONFIG_KEYS:
            raise TaskPlanContractError(f"{path}.config contains unsupported properties")
        for key in ("instruction", "executorProfile", "artifactType"):
            if key in config:
                _string(config[key], f"{path}.config.{key}", maximum=20_000 if key == "instruction" else 200)
        for key in ("inputRefs", "outputRefs", "capabilities"):
            if key in config:
                _string_list(config[key], f"{path}.config.{key}")
        if "requiresApproval" in config and not isinstance(config["requiresApproval"], bool):
            raise TaskPlanContractError(f"{path}.config.requiresApproval must be boolean")

    edge_ids: set[str] = set()
    normalized_edges: list[dict] = []
    for index, edge in enumerate(edges):
        path = f"edges[{index}]"
        if not isinstance(edge, dict) or not {"id", "source", "target", "kind"} <= set(edge) <= {"id", "source", "target", "kind", "label"}:
            raise TaskPlanContractError(f"{path} has an invalid shape")
        edge_id = _identifier(edge.get("id"), f"{path}.id")
        if edge_id in edge_ids:
            raise TaskPlanContractError(f"duplicate edge id: {edge_id}")
        edge_ids.add(edge_id)
        source = _identifier(edge.get("source"), f"{path}.source")
        target = _identifier(edge.get("target"), f"{path}.target")
        if source not in node_ids or target not in node_ids:
            raise TaskPlanContractError(f"{path} references an unknown node")
        if source == target:
            raise TaskPlanContractError(f"{path} may not connect a node to itself")
        if edge.get("kind") not in APPROVED_EDGE_KINDS:
            raise TaskPlanContractError(f"{path}.kind is not approved")
        if "label" in edge:
            _string(edge["label"], f"{path}.label", maximum=200)
        normalized_edges.append(edge)

    _assert_acyclic(node_ids, normalized_edges)
    return json.loads(encoded)
