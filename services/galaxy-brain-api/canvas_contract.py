"""Galaxy-owned durable canvas contracts, independent of renderer operations."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any

import rfc8785

from object_links import ObjectLinkError, canonical_reference


SNAPSHOT_SCHEMA = "gb.canvas.snapshot.v1"
CHANGED_SCHEMA = "gb.canvas.changed.v1"
NODE_TYPES = frozenset({
    "galaxy.paper", "galaxy.note", "galaxy.document", "galaxy.media",
    "galaxy.eln-record", "galaxy.task", "galaxy.chat", "galaxy.proof", "galaxy.surface",
})
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
CONTENT_HASH = re.compile(r"sha256:[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")
MAX_COORDINATE = 10_000_000
MAX_DIMENSION = 2_400
MIN_FRAME_DIMENSION = 160
MAX_FRAME_DIMENSION = 10_000
FRAME_TONES = frozenset({"neutral", "sage", "amber", "plum"})
MAX_SAFE_INTEGER = 9_007_199_254_740_991
COMMAND_TYPES = frozenset({
    "item.place", "item.move", "item.resize", "item.remove", "item.reorder",
    "edge.connect", "edge.disconnect", "frame.create", "frame.move", "frame.resize", "frame.remove",
})


class CanvasContractError(ValueError):
    pass


def _object(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise CanvasContractError(f"{label} must be an object")
    return value


def _exact_keys(value: dict, keys: set[str], label: str) -> None:
    extra = set(value) - keys
    if extra:
        raise CanvasContractError(f"{label}.{sorted(extra)[0]} is not supported")


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise CanvasContractError(f"{label} must be a stable identifier")
    return value


def _identifier_list(value: Any, label: str, maximum: int) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise CanvasContractError(f"{label} must be a bounded array")
    normalized = sorted(_identifier(entry, f"{label}[{index}]") for index, entry in enumerate(value))
    if len(set(normalized)) != len(normalized):
        raise CanvasContractError(f"{label} must not contain duplicates")
    return normalized


def _text(value: Any, label: str, maximum: int, *, optional: bool = False) -> str | None:
    if optional and value in (None, ""):
        return None
    if (not isinstance(value, str) or not value or value != value.strip()
            or LONE_SURROGATE.search(value)):
        raise CanvasContractError(f"{label} must be bounded text without lone surrogates")
    # JavaScript String#length counts UTF-16 code units. Keep the Python
    # authority on the same unit so astral text cannot be accepted here and
    # later poison a browser or agent snapshot reader.
    if len(value.encode("utf-16-le")) // 2 > maximum:
        raise CanvasContractError(f"{label} must be bounded text without lone surrogates")
    return value


def _number(value: Any, label: str, minimum: float, maximum: float) -> int | float:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < minimum or value > maximum):
        raise CanvasContractError(f"{label} must be a finite number between {minimum} and {maximum}")
    if isinstance(value, int) and abs(value) > MAX_SAFE_INTEGER:
        raise CanvasContractError(f"{label} must be exactly representable")
    return 0 if value == 0 else value


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    normalized = _number(value, label, minimum, maximum)
    if not isinstance(normalized, int) and not (
        isinstance(normalized, float) and normalized.is_integer()
    ):
        raise CanvasContractError(f"{label} must be an integer")
    return int(normalized)


def _reference(value: Any, label: str) -> str:
    try:
        return canonical_reference(value)
    except ObjectLinkError as error:
        raise CanvasContractError(f"{label} must be a canonical Galaxy object reference") from error


def _json_value(value: Any, label: str, depth: int = 0) -> Any:
    if depth > 8:
        raise CanvasContractError(f"{label} is too deeply nested")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        if len(value) > 2_000 or LONE_SURROGATE.search(value):
            raise CanvasContractError(f"{label} contains invalid text")
        return value
    if isinstance(value, (int, float)):
        return _number(value, label, -MAX_COORDINATE, MAX_COORDINATE)
    if isinstance(value, list):
        if len(value) > 32:
            raise CanvasContractError(f"{label} contains too many values")
        return [_json_value(entry, f"{label}[{index}]", depth + 1) for index, entry in enumerate(value)]
    if not isinstance(value, dict):
        raise CanvasContractError(f"{label} must contain JSON values")
    if len(value) > 32:
        raise CanvasContractError(f"{label} contains too many properties")
    normalized = {}
    for key in sorted(value):
        _text(key, f"{label} key", 80)
        normalized[key] = _json_value(value[key], f"{label}.{key}", depth + 1)
    return normalized


def _item(value: Any, index: int) -> dict:
    label = f"items[{index}]"
    source = _object(value, label)
    _exact_keys(source, {
        "id", "subjectRef", "nodeType", "x", "y", "width", "height", "angle",
        "zIndex", "displayMode", "collapsed", "style",
    }, label)
    node_type = source.get("nodeType")
    if node_type not in NODE_TYPES:
        raise CanvasContractError(f"{label}.nodeType is not registered")
    if not isinstance(source.get("collapsed"), bool):
        raise CanvasContractError(f"{label}.collapsed must be boolean")
    return {
        "id": _identifier(source.get("id"), f"{label}.id"),
        "subjectRef": _reference(source.get("subjectRef"), f"{label}.subjectRef"),
        "nodeType": node_type,
        "x": _number(source.get("x"), f"{label}.x", -MAX_COORDINATE, MAX_COORDINATE),
        "y": _number(source.get("y"), f"{label}.y", -MAX_COORDINATE, MAX_COORDINATE),
        "width": _number(source.get("width"), f"{label}.width", 80, MAX_DIMENSION),
        "height": _number(source.get("height"), f"{label}.height", 80, MAX_DIMENSION),
        "angle": _number(source.get("angle"), f"{label}.angle", -360, 360),
        "zIndex": _integer(source.get("zIndex"), f"{label}.zIndex", -1_000_000, 1_000_000),
        "displayMode": _text(source.get("displayMode"), f"{label}.displayMode", 80),
        "collapsed": source["collapsed"],
        "style": _json_value(_object(source.get("style"), f"{label}.style"), f"{label}.style"),
    }


def _edge(value: Any, index: int, item_ids: set[str]) -> dict:
    label = f"edges[{index}]"
    source = _object(value, label)
    _exact_keys(source, {
        "id", "sourceItemId", "targetItemId", "edgeKind", "label", "semanticRef", "style",
    }, label)
    source_id = _identifier(source.get("sourceItemId"), f"{label}.sourceItemId")
    target_id = _identifier(source.get("targetItemId"), f"{label}.targetItemId")
    if source_id not in item_ids or target_id not in item_ids:
        raise CanvasContractError(f"{label} endpoints must exist")
    if source_id == target_id:
        raise CanvasContractError(f"{label} cannot connect an item to itself")
    normalized = {
        "id": _identifier(source.get("id"), f"{label}.id"),
        "sourceItemId": source_id,
        "targetItemId": target_id,
        "edgeKind": _text(source.get("edgeKind"), f"{label}.edgeKind", 80),
        "style": _json_value(_object(source.get("style"), f"{label}.style"), f"{label}.style"),
    }
    label_value = _text(source.get("label"), f"{label}.label", 240, optional=True)
    if label_value is not None:
        normalized["label"] = label_value
    semantic = source.get("semanticRef")
    if semantic not in (None, ""):
        normalized["semanticRef"] = _reference(semantic, f"{label}.semanticRef")
    return normalized


def _frame(value: Any, index: int) -> dict:
    label = f"frames[{index}]"
    source = _object(value, label)
    _exact_keys(source, {"id", "title", "x", "y", "width", "height", "tone"}, label)
    tone = source.get("tone")
    if not isinstance(tone, str) or tone not in FRAME_TONES:
        raise CanvasContractError(f"{label}.tone is not registered")
    return {
        "id": _identifier(source.get("id"), f"{label}.id"),
        "title": _text(source.get("title"), f"{label}.title", 120),
        "x": _number(source.get("x"), f"{label}.x", -MAX_COORDINATE, MAX_COORDINATE),
        "y": _number(source.get("y"), f"{label}.y", -MAX_COORDINATE, MAX_COORDINATE),
        "width": _number(source.get("width"), f"{label}.width", MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
        "height": _number(source.get("height"), f"{label}.height", MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
        "tone": tone,
    }


def normalize_snapshot(value: Any) -> dict:
    source = _object(value, "content")
    _exact_keys(source, {"schemaId", "items", "edges", "frames", "removedItemIds", "removedEdgeIds"}, "content")
    if source.get("schemaId") != SNAPSHOT_SCHEMA:
        raise CanvasContractError(f"schemaId must equal {SNAPSHOT_SCHEMA}")
    raw_items = source.get("items")
    raw_edges = source.get("edges")
    if not isinstance(raw_items, list) or len(raw_items) > 2_000:
        raise CanvasContractError("items must be a bounded array")
    if not isinstance(raw_edges, list) or len(raw_edges) > 4_000:
        raise CanvasContractError("edges must be a bounded array")
    raw_frames = source.get("frames", [])
    if not isinstance(raw_frames, list) or len(raw_frames) > 100:
        raise CanvasContractError("frames must be a bounded array")
    items = sorted((_item(entry, index) for index, entry in enumerate(raw_items)), key=lambda entry: entry["id"])
    item_ids = {entry["id"] for entry in items}
    if len(item_ids) != len(items):
        raise CanvasContractError("duplicate item id")
    edges = sorted(
        (_edge(entry, index, item_ids) for index, entry in enumerate(raw_edges)),
        key=lambda entry: entry["id"],
    )
    if len({entry["id"] for entry in edges}) != len(edges):
        raise CanvasContractError("duplicate edge id")
    frames = sorted((_frame(entry, index) for index, entry in enumerate(raw_frames)), key=lambda entry: entry["id"])
    if len({entry["id"] for entry in frames}) != len(frames):
        raise CanvasContractError("duplicate frame id")
    removed_item_ids = _identifier_list(source.get("removedItemIds", []), "removedItemIds", 2_000)
    removed_edge_ids = _identifier_list(source.get("removedEdgeIds", []), "removedEdgeIds", 4_000)
    if any(item_id in item_ids for item_id in removed_item_ids):
        raise CanvasContractError("an item cannot also be removed")
    edge_ids = {entry["id"] for entry in edges}
    if any(edge_id in edge_ids for edge_id in removed_edge_ids):
        raise CanvasContractError("an edge cannot also be removed")
    normalized = {
        "schemaId": SNAPSHOT_SCHEMA,
        "items": items,
        "edges": edges,
        "removedItemIds": removed_item_ids,
        "removedEdgeIds": removed_edge_ids,
    }
    if frames:
        normalized["frames"] = frames
    return normalized


def serialize_snapshot(value: Any) -> bytes:
    try:
        return rfc8785.dumps(normalize_snapshot(value))
    except (rfc8785.CanonicalizationError, UnicodeError) as error:
        raise CanvasContractError("snapshot cannot be canonically serialized") from error


def snapshot_hash(value: Any) -> str:
    return f"sha256:{hashlib.sha256(serialize_snapshot(value)).hexdigest()}"


def canonical_hash(value: Any) -> str:
    try:
        encoded = rfc8785.dumps(value)
    except (rfc8785.CanonicalizationError, UnicodeError, TypeError) as error:
        raise CanvasContractError("value cannot be canonically serialized") from error
    return hashlib.sha256(encoded).hexdigest()


def _position(value: Any, label: str) -> dict:
    source = _object(value, label)
    _exact_keys(source, {"x", "y"}, label)
    return {
        "x": _number(source.get("x"), f"{label}.x", -MAX_COORDINATE, MAX_COORDINATE),
        "y": _number(source.get("y"), f"{label}.y", -MAX_COORDINATE, MAX_COORDINATE),
    }


def _size(value: Any, label: str) -> dict:
    source = _object(value, label)
    _exact_keys(source, {"width", "height"}, label)
    return {
        "width": _number(source.get("width"), f"{label}.width", 80, MAX_DIMENSION),
        "height": _number(source.get("height"), f"{label}.height", 80, MAX_DIMENSION),
    }


def normalize_commands(value: Any) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= 64:
        raise CanvasContractError("commands must contain 1 to 64 entries")
    normalized = []
    for index, command_value in enumerate(value):
        label = f"commands[{index}]"
        command = _object(command_value, label)
        command_type = command.get("type")
        if command_type not in COMMAND_TYPES:
            raise CanvasContractError(f"{label}.type is not supported")
        if command_type == "item.place":
            _exact_keys(command, {"type", "item"}, label)
            item_value = _item(command.get("item"), index)
            normalized.append({"type": command_type, "item": item_value})
        elif command_type == "item.move":
            _exact_keys(command, {"type", "itemId", "position"}, label)
            normalized.append({
                "type": command_type,
                "itemId": _identifier(command.get("itemId"), f"{label}.itemId"),
                "position": _position(command.get("position"), f"{label}.position"),
            })
        elif command_type == "item.resize":
            _exact_keys(command, {"type", "itemId", "size"}, label)
            normalized.append({
                "type": command_type,
                "itemId": _identifier(command.get("itemId"), f"{label}.itemId"),
                "size": _size(command.get("size"), f"{label}.size"),
            })
        elif command_type == "item.reorder":
            _exact_keys(command, {"type", "itemId", "zIndex"}, label)
            normalized.append({
                "type": command_type,
                "itemId": _identifier(command.get("itemId"), f"{label}.itemId"),
                "zIndex": _integer(command.get("zIndex"), f"{label}.zIndex", -1_000_000, 1_000_000),
            })
        elif command_type == "item.remove":
            _exact_keys(command, {"type", "itemId"}, label)
            normalized.append({
                "type": command_type,
                "itemId": _identifier(command.get("itemId"), f"{label}.itemId"),
            })
        elif command_type == "frame.create":
            _exact_keys(command, {"type", "frame"}, label)
            normalized.append({"type": command_type, "frame": _frame(command.get("frame"), index)})
        elif command_type == "frame.move":
            _exact_keys(command, {"type", "frameId", "position"}, label)
            normalized.append({
                "type": command_type,
                "frameId": _identifier(command.get("frameId"), f"{label}.frameId"),
                "position": _position(command.get("position"), f"{label}.position"),
            })
        elif command_type == "frame.resize":
            _exact_keys(command, {"type", "frameId", "size"}, label)
            size = _object(command.get("size"), f"{label}.size")
            _exact_keys(size, {"width", "height"}, f"{label}.size")
            normalized.append({
                "type": command_type,
                "frameId": _identifier(command.get("frameId"), f"{label}.frameId"),
                "size": {
                    "width": _number(size.get("width"), f"{label}.size.width", MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
                    "height": _number(size.get("height"), f"{label}.size.height", MIN_FRAME_DIMENSION, MAX_FRAME_DIMENSION),
                },
            })
        elif command_type == "frame.remove":
            _exact_keys(command, {"type", "frameId"}, label)
            normalized.append({
                "type": command_type,
                "frameId": _identifier(command.get("frameId"), f"{label}.frameId"),
            })
        elif command_type == "edge.connect":
            _exact_keys(command, {"type", "edge"}, label)
            edge_source = _object(command.get("edge"), f"{label}.edge")
            if edge_source.get("semanticRef") not in (None, ""):
                raise CanvasContractError("semantic canvas edges require a separately authorized assertion")
            # Endpoint existence is checked while applying the command.
            temporary_ids = {
                _identifier(edge_source.get("sourceItemId"), f"{label}.edge.sourceItemId"),
                _identifier(edge_source.get("targetItemId"), f"{label}.edge.targetItemId"),
            }
            normalized.append({"type": command_type, "edge": _edge(edge_source, index, temporary_ids)})
        else:
            _exact_keys(command, {"type", "edgeId"}, label)
            normalized.append({
                "type": command_type,
                "edgeId": _identifier(command.get("edgeId"), f"{label}.edgeId"),
            })
    return normalized


def apply_commands(snapshot: Any, command_values: Any) -> dict:
    current = normalize_snapshot(snapshot)
    commands = normalize_commands(command_values)
    items = {entry["id"]: dict(entry) for entry in current["items"]}
    edges = {entry["id"]: dict(entry) for entry in current["edges"]}
    frames = {entry["id"]: dict(entry) for entry in current.get("frames", [])}
    removed_item_ids = set(current["removedItemIds"])
    removed_edge_ids = set(current["removedEdgeIds"])

    for command in commands:
        command_type = command["type"]
        if command_type == "item.place":
            item_value = command["item"]
            if item_value["id"] in items:
                raise CanvasContractError(f"item {item_value['id']} already exists")
            removed_item_ids.discard(item_value["id"])
            items[item_value["id"]] = item_value
        elif command_type in {"item.move", "item.resize", "item.reorder", "item.remove"}:
            item_id = command["itemId"]
            if item_id not in items and command_type != "item.remove":
                raise CanvasContractError(f"item {item_id} does not exist")
            if command_type == "item.move":
                items[item_id].update(command["position"])
            elif command_type == "item.resize":
                items[item_id].update(command["size"])
            elif command_type == "item.reorder":
                items[item_id]["zIndex"] = command["zIndex"]
            else:
                items.pop(item_id, None)
                removed_item_ids.add(item_id)
                incident_edge_ids = {
                    edge_id for edge_id, edge in edges.items()
                    if item_id in {edge["sourceItemId"], edge["targetItemId"]}
                }
                removed_edge_ids.update(incident_edge_ids)
                edges = {edge_id: edge for edge_id, edge in edges.items() if edge_id not in incident_edge_ids}
        elif command_type == "edge.connect":
            edge_value = command["edge"]
            if edge_value["id"] in edges:
                raise CanvasContractError(f"edge {edge_value['id']} already exists")
            if edge_value["sourceItemId"] not in items or edge_value["targetItemId"] not in items:
                raise CanvasContractError("edge endpoints must exist")
            removed_edge_ids.discard(edge_value["id"])
            edges[edge_value["id"]] = edge_value
        elif command_type == "edge.disconnect":
            edge_id = command["edgeId"]
            edges.pop(edge_id, None)
            removed_edge_ids.add(edge_id)
        elif command_type == "frame.create":
            frame_value = command["frame"]
            if frame_value["id"] in frames:
                raise CanvasContractError(f"frame {frame_value['id']} already exists")
            if len(frames) >= 100:
                raise CanvasContractError("frames must be a bounded array")
            frames[frame_value["id"]] = frame_value
        else:
            frame_id = command["frameId"]
            if frame_id not in frames and command_type != "frame.remove":
                raise CanvasContractError(f"frame {frame_id} does not exist")
            if command_type == "frame.move":
                frames[frame_id].update(command["position"])
            elif command_type == "frame.resize":
                frames[frame_id].update(command["size"])
            else:
                frames.pop(frame_id, None)

    next_snapshot = {
        "schemaId": SNAPSHOT_SCHEMA,
        "items": list(items.values()),
        "edges": list(edges.values()),
        "removedItemIds": sorted(removed_item_ids),
        "removedEdgeIds": sorted(removed_edge_ids),
    }
    if frames:
        next_snapshot["frames"] = list(frames.values())
    return normalize_snapshot(next_snapshot)


def normalize_change_event(value: Any) -> dict:
    event = _object(value, "event")
    _exact_keys(event, {"schemaId", "canvasId", "version", "contentHash", "mutationId"}, "event")
    if event.get("schemaId") != CHANGED_SCHEMA:
        raise CanvasContractError(f"event.schemaId must equal {CHANGED_SCHEMA}")
    canvas_id = event.get("canvasId")
    if not isinstance(canvas_id, str) or not UUID.fullmatch(canvas_id):
        raise CanvasContractError("event.canvasId is invalid")
    content_hash = event.get("contentHash")
    if not isinstance(content_hash, str) or not CONTENT_HASH.fullmatch(content_hash):
        raise CanvasContractError("event.contentHash is invalid")
    return {
        "schemaId": CHANGED_SCHEMA,
        "canvasId": canvas_id,
        "version": _integer(event.get("version"), "event.version", 1, MAX_SAFE_INTEGER),
        "contentHash": content_hash,
        "mutationId": _identifier(event.get("mutationId"), "event.mutationId"),
    }
