"""Small, bounded RFC 6902 implementation for durable surface updates."""

from __future__ import annotations

import copy
import json
from typing import Any

MAX_PATCH_OPERATIONS = 128
MAX_PATCH_BYTES = 131_072
MAX_POINTER_LENGTH = 2_048
MAX_POINTER_SEGMENTS = 64


class JsonPatchError(ValueError):
    """Raised when a JSON Patch document is invalid or cannot be applied."""


def _pointer_segments(pointer: Any, field: str) -> list[str]:
    if not isinstance(pointer, str):
        raise JsonPatchError(f"{field} must be a JSON Pointer string")
    if len(pointer) > MAX_POINTER_LENGTH:
        raise JsonPatchError(f"{field} exceeds the maximum length")
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise JsonPatchError(f"{field} must be an RFC 6901 JSON Pointer")

    segments: list[str] = []
    for raw_segment in pointer[1:].split("/"):
        index = 0
        decoded: list[str] = []
        while index < len(raw_segment):
            char = raw_segment[index]
            if char != "~":
                decoded.append(char)
                index += 1
                continue
            if index + 1 >= len(raw_segment) or raw_segment[index + 1] not in {"0", "1"}:
                raise JsonPatchError(f"{field} contains an invalid JSON Pointer escape")
            decoded.append("~" if raw_segment[index + 1] == "0" else "/")
            index += 2
        segments.append("".join(decoded))

    if len(segments) > MAX_POINTER_SEGMENTS:
        raise JsonPatchError(f"{field} contains too many segments")
    return segments


def _list_index(segment: str, length: int, field: str, *, allow_end: bool = False) -> int:
    if segment == "-":
        if allow_end:
            return length
        raise JsonPatchError(f"{field} uses '-' outside an add destination")
    if not segment.isdigit() or (len(segment) > 1 and segment.startswith("0")):
        raise JsonPatchError(f"{field} contains an invalid array index")
    index = int(segment)
    maximum = length if allow_end else length - 1
    if index > maximum:
        raise JsonPatchError(f"{field} array index is out of bounds")
    return index


def _resolve_parent(document: Any, segments: list[str], field: str) -> tuple[Any, str]:
    if not segments:
        raise JsonPatchError(f"{field} points to the document root")
    current = document
    for segment in segments[:-1]:
        if isinstance(current, dict):
            if segment not in current:
                raise JsonPatchError(f"{field} does not exist")
            current = current[segment]
        elif isinstance(current, list):
            current = current[_list_index(segment, len(current), field)]
        else:
            raise JsonPatchError(f"{field} traverses a scalar value")
    return current, segments[-1]


def _get(document: Any, segments: list[str], field: str) -> Any:
    current = document
    for segment in segments:
        if isinstance(current, dict):
            if segment not in current:
                raise JsonPatchError(f"{field} does not exist")
            current = current[segment]
        elif isinstance(current, list):
            current = current[_list_index(segment, len(current), field)]
        else:
            raise JsonPatchError(f"{field} traverses a scalar value")
    return current


def _add(document: Any, segments: list[str], value: Any, field: str) -> Any:
    value = copy.deepcopy(value)
    if not segments:
        return value
    parent, key = _resolve_parent(document, segments, field)
    if isinstance(parent, dict):
        parent[key] = value
    elif isinstance(parent, list):
        parent.insert(_list_index(key, len(parent), field, allow_end=True), value)
    else:
        raise JsonPatchError(f"{field} targets a scalar value")
    return document


def _remove(document: Any, segments: list[str], field: str) -> tuple[Any, Any]:
    if not segments:
        return None, document
    parent, key = _resolve_parent(document, segments, field)
    if isinstance(parent, dict):
        if key not in parent:
            raise JsonPatchError(f"{field} does not exist")
        removed = parent.pop(key)
    elif isinstance(parent, list):
        removed = parent.pop(_list_index(key, len(parent), field))
    else:
        raise JsonPatchError(f"{field} targets a scalar value")
    return document, removed


def _replace(document: Any, segments: list[str], value: Any, field: str) -> Any:
    if not segments:
        return copy.deepcopy(value)
    parent, key = _resolve_parent(document, segments, field)
    if isinstance(parent, dict):
        if key not in parent:
            raise JsonPatchError(f"{field} does not exist")
        parent[key] = copy.deepcopy(value)
    elif isinstance(parent, list):
        parent[_list_index(key, len(parent), field)] = copy.deepcopy(value)
    else:
        raise JsonPatchError(f"{field} targets a scalar value")
    return document


def _json_equal(left: Any, right: Any) -> bool:
    return json.dumps(
        left, sort_keys=True, separators=(",", ":"), allow_nan=False
    ) == json.dumps(right, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _stable_array_target(segments: list[str]) -> tuple[str, str] | None:
    if len(segments) < 2:
        return None
    if segments[0] == "surfaceUpdate" and segments[1] == "components":
        if len(segments) >= 3 and segments[2] != "-":
            return ("component", segments[2])
    if segments[0] == "bindings" and len(segments) >= 2 and segments[1] != "-":
        return ("binding", segments[1])
    return None


def _stable_array_id(document: Any, target: tuple[str, str], field: str) -> str:
    kind, index_segment = target
    if kind == "component":
        values = _get(document, ["surfaceUpdate", "components"], field)
    else:
        values = _get(document, ["bindings"], field)
    if not isinstance(values, list):
        raise JsonPatchError(f"{field} stable target is not an array")
    value = values[_list_index(index_segment, len(values), field)]
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        raise JsonPatchError(f"{field} stable target has no string id")
    return value["id"]


def _validate_surface_mutation_path(segments: list[str], field: str) -> None:
    component_path = len(segments) >= 3 and segments[:2] == [
        "surfaceUpdate",
        "components",
    ]
    binding_path = len(segments) >= 2 and segments[0] == "bindings"
    if not component_path and not binding_path:
        raise JsonPatchError(
            f"{field} may mutate only an indexed component, binding, or '-' append target"
        )


def apply_json_patch(document: Any, patch: Any) -> Any:
    """Apply one bounded JSON Patch document and return a detached result."""
    try:
        encoded = json.dumps(
            patch,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise JsonPatchError("patch must be JSON serializable") from error
    if len(encoded.encode("utf-8")) > MAX_PATCH_BYTES:
        raise JsonPatchError("patch exceeds the maximum encoded size")
    if not isinstance(patch, list) or not 1 <= len(patch) <= MAX_PATCH_OPERATIONS:
        raise JsonPatchError(f"patch must contain 1-{MAX_PATCH_OPERATIONS} operations")

    result = copy.deepcopy(document)
    stable_guards: dict[tuple[str, str], str] = {}
    for index, operation in enumerate(patch):
        field = f"patch[{index}]"
        if not isinstance(operation, dict) or not isinstance(operation.get("op"), str):
            raise JsonPatchError(f"{field} must be an operation object")
        op = operation["op"]
        expected_keys = {
            "add": {"op", "path", "value"},
            "remove": {"op", "path"},
            "replace": {"op", "path", "value"},
            "test": {"op", "path", "value"},
        }.get(op)
        if expected_keys is None:
            raise JsonPatchError(f"{field}.op is not supported")
        if set(operation) != expected_keys:
            raise JsonPatchError(f"{field} has invalid properties for {op}")

        path = _pointer_segments(operation["path"], f"{field}.path")
        if op != "test":
            _validate_surface_mutation_path(path, f"{field}.path")
        stable_target = _stable_array_target(path)
        if op != "test" and stable_target is not None:
            expected_id = stable_guards.get(stable_target)
            if (
                expected_id is None
                or _stable_array_id(result, stable_target, f"{field}.path") != expected_id
            ):
                raise JsonPatchError(
                    f"{field} requires a preceding test of the current target's stable id"
                )
        if op == "add":
            result = _add(result, path, operation["value"], f"{field}.path")
        elif op == "remove":
            result, _ = _remove(result, path, f"{field}.path")
        elif op == "replace":
            result = _replace(result, path, operation["value"], f"{field}.path")
        elif op == "test":
            actual = _get(result, path, f"{field}.path")
            try:
                matches = _json_equal(actual, operation["value"])
            except (TypeError, ValueError) as error:
                raise JsonPatchError(f"{field}.value is not valid JSON") from error
            if not matches:
                raise JsonPatchError(f"{field} test operation failed")
            if (
                len(path) == 4
                and path[:2] == ["surfaceUpdate", "components"]
                and path[3] == "id"
                and isinstance(operation["value"], str)
            ):
                stable_guards[("component", path[2])] = operation["value"]
            elif (
                len(path) == 3
                and path[0] == "bindings"
                and path[2] == "id"
                and isinstance(operation["value"], str)
            ):
                stable_guards[("binding", path[1])] = operation["value"]

    return result
