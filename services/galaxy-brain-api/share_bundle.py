"""Strict construction helpers for immutable authenticated share bundles."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping
from urllib.parse import quote

from object_links import ObjectLinkError, parse_canonical_reference


BUNDLE_SCHEMA_V1 = "gb.share-bundle.v1"
BUNDLE_SCHEMA_V2 = "gb.share-bundle.v2"
BUNDLE_SCHEMAS = frozenset({BUNDLE_SCHEMA_V1, BUNDLE_SCHEMA_V2})
OBJECT_PAYLOAD_SCHEMA = "gb.share-object.v1"
CANVAS_PAYLOAD_SCHEMA = "gb.share-canvas.v1"
CONVERSATION_PAYLOAD_SCHEMA = "gb.share-redacted-conversation.v1"
CANVAS_CONVERSATION_PAYLOAD_SCHEMA = "gb.share-canvas-redacted-conversation.v1"
V1_MODES = frozenset({"object-only", "canvas-only"})
V2_MODES = frozenset({"canvas-plus-conversation"})
MODES = V1_MODES | V2_MODES
MAX_OBJECT_PAYLOAD_BYTES = 65_536
MAX_CANVAS_PAYLOAD_BYTES = 8_388_608
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_CONTENT_CONTROL = re.compile(r"[\x00\ud800-\udfff]")
_SHA256_REVISION = re.compile(r"sha256:[0-9a-f]{64}")
_SAFE_COMPONENT = "~!*'()-._"


class ShareBundleError(ValueError):
    pass


def canonical_json(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise ShareBundleError("Share bundle contains non-canonical data") from error


def content_hash(value: object) -> str:
    return f"sha256:{hashlib.sha256(canonical_json(value)).hexdigest()}"


def request_hash(mode: str, selector: object) -> str:
    return hashlib.sha256(canonical_json({"mode": mode, "selector": selector})).hexdigest()


def validate_create_request(value: object) -> tuple[str, dict[str, Any], str]:
    if not isinstance(value, dict) or set(value) != {"schemaId", "mode", "selector", "idempotencyKey"}:
        raise ShareBundleError("Share bundle request contains unknown or missing fields")
    schema_id = value["schemaId"]
    if schema_id not in BUNDLE_SCHEMAS:
        raise ShareBundleError("Unsupported share bundle schema")
    mode = value["mode"]
    if mode not in MODES:
        raise ShareBundleError("Unsupported share bundle mode")
    if (schema_id == BUNDLE_SCHEMA_V1 and mode not in V1_MODES) or (
        schema_id == BUNDLE_SCHEMA_V2 and mode not in V2_MODES
    ):
        raise ShareBundleError("Share bundle mode does not belong to the requested schema")
    selector = value["selector"]
    if not isinstance(selector, dict):
        raise ShareBundleError("Share bundle selector must be an object")
    idempotency_key = value["idempotencyKey"]
    if (
        not isinstance(idempotency_key, str)
        or not re.fullmatch(r"[A-Za-z0-9._:-]{8,200}", idempotency_key)
    ):
        raise ShareBundleError("Invalid share bundle idempotency key")

    if mode == "canvas-only":
        if set(selector) != {"canvasId", "version", "contentHash"}:
            raise ShareBundleError("Canvas shares require only canvasId, version, and contentHash")
        if isinstance(selector["version"], bool) or not isinstance(selector["version"], int) or selector["version"] < 1:
            raise ShareBundleError("Canvas shares require a positive exact version")
        if not isinstance(selector["contentHash"], str) or not _SHA256_REVISION.fullmatch(selector["contentHash"]):
            raise ShareBundleError("Canvas shares require an exact SHA-256 content hash")
        _bounded_text(selector["canvasId"], 128, "canvasId")
    elif mode == "canvas-plus-conversation":
        if set(selector) != {"canvasId", "version", "contentHash", "conversationRef"}:
            raise ShareBundleError(
                "Canvas plus conversation shares require only canvasId, version, contentHash, and conversationRef"
            )
        if isinstance(selector["version"], bool) or not isinstance(selector["version"], int) or selector["version"] < 1:
            raise ShareBundleError("Canvas plus conversation shares require a positive exact canvas version")
        if not isinstance(selector["contentHash"], str) or not _SHA256_REVISION.fullmatch(selector["contentHash"]):
            raise ShareBundleError("Canvas plus conversation shares require an exact canvas SHA-256 content hash")
        _bounded_text(selector["canvasId"], 128, "canvasId")
        try:
            reference = parse_canonical_reference(selector["conversationRef"])
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Canvas plus conversation shares require one canonical pinned chat reference") from error
        if reference.kind != "chat" or reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
            raise ShareBundleError("Canvas plus conversation shares require one pinned SHA-256 chat reference")
    elif set(selector) == {"nodeId", "revisionId"}:
        _bounded_text(selector["nodeId"], 512, "nodeId")
        _bounded_text(selector["revisionId"], 512, "revisionId")
    elif set(selector) == {"objectRef"}:
        try:
            reference = parse_canonical_reference(selector["objectRef"])
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Object shares require a canonical pinned object reference") from error
        if reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
            raise ShareBundleError("Object shares require a pinned SHA-256 object reference")
        if reference.kind in {"chat", "run", "turn"}:
            raise ShareBundleError("Object-only shares exclude conversation, run, and turn records")
    else:
        raise ShareBundleError("Object shares require one exact object or node revision selector")
    return mode, selector, idempotency_key


def _bounded_text(value: object, maximum: int, label: str, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value or value != value.strip():
        raise ShareBundleError(f"Invalid {label}")
    if len(value) > maximum or _CONTROL.search(value):
        raise ShareBundleError(f"Invalid {label}")
    return value


def _bounded_tags(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 32:
        raise ShareBundleError("Invalid object tags")
    tags = [_bounded_text(item, 80, "object tag") for item in value]
    if len(set(tags)) != len(tags):
        raise ShareBundleError("Object tags must be unique")
    return tags


def _bounded_content(value: object, maximum_bytes: int, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > maximum_bytes
        or _CONTENT_CONTROL.search(value)
    ):
        raise ShareBundleError(f"Invalid {label}")
    return value


def build_node_bundle(node_id: str, revision_id: str, snapshot: object) -> dict[str, Any]:
    if not isinstance(snapshot, dict):
        raise ShareBundleError("Pinned node revision is invalid")
    title = _bounded_text(snapshot.get("title"), 240, "object title")
    kind = _bounded_text(snapshot.get("type"), 120, "object kind")
    content = snapshot.get("content")
    if not isinstance(content, str) or len(content.encode("utf-8")) > 65_536 or _CONTENT_CONTROL.search(content):
        raise ShareBundleError("Object content is outside the share-safe bound")
    version = snapshot.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ShareBundleError("Pinned node revision has no exact version")
    safe = {
        "schemaId": OBJECT_PAYLOAD_SCHEMA,
        "kind": kind,
        "title": title,
        "content": content,
        "tags": _bounded_tags(snapshot.get("tags")),
        "version": version,
    }
    revision_hash = content_hash(safe)
    ref = (
        "gb:object:v1:artifact:"
        f"{quote(node_id, safe=_SAFE_COMPONENT)}:pinned:{quote(revision_hash, safe=_SAFE_COMPONENT)}"
    )
    payload = {**safe, "ref": ref, "revision": revision_hash}
    return _bundle(
        "object-only",
        {"kind": "node", "nodeId": node_id, "revisionId": revision_id, "contentHash": revision_hash},
        payload,
        target_id=node_id,
    )


def build_object_bundle(object_ref: str, resolution: object) -> dict[str, Any]:
    if not isinstance(resolution, dict) or set(resolution) != {
        "requestedRef", "status", "resolvedRef", "provider", "sourceKind", "source"
    }:
        raise ShareBundleError("Object projection source did not return an exact resolved object")
    if resolution["requestedRef"] != object_ref or resolution["status"] != "resolved":
        raise ShareBundleError("Object referent was not found or is not readable")
    try:
        reference = parse_canonical_reference(resolution["resolvedRef"])
    except (ObjectLinkError, TypeError) as error:
        raise ShareBundleError("Object projection source returned an invalid reference") from error
    if reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
        raise ShareBundleError("Object projection source did not pin an exact SHA-256 revision")
    if reference.kind in {"chat", "run", "turn"}:
        raise ShareBundleError("Object-only shares exclude conversation, run, and turn records")
    if resolution["resolvedRef"] != object_ref:
        raise ShareBundleError("Pinned object resolution changed the requested identity")
    provider = _bounded_text(resolution["provider"], 120, "object provider")
    source_kind = _bounded_text(resolution["sourceKind"], 120, "object source kind")
    if source_kind != reference.kind or not isinstance(resolution["source"], dict):
        raise ShareBundleError("Object projection source returned inconsistent identity")
    title = _object_title(resolution["source"])
    payload = {
        "schemaId": OBJECT_PAYLOAD_SCHEMA,
        "ref": reference.wire,
        "kind": reference.kind,
        "revision": reference.revision,
        "title": title,
        "provider": provider,
        "source": resolution["source"],
    }
    if len(canonical_json(payload)) > MAX_OBJECT_PAYLOAD_BYTES:
        raise ShareBundleError("Object share payload exceeds 64 KiB")
    return _bundle(
        "object-only",
        {"kind": "canonical-object", "objectRef": reference.wire, "contentHash": reference.revision},
        payload,
        target_id=reference.wire,
    )


def _object_title(source: Mapping[str, Any]) -> str:
    candidates = [source.get("title"), source.get("displayFilename")]
    paper = source.get("paper")
    if isinstance(paper, dict):
        candidates.insert(0, paper.get("title"))
    for candidate in candidates:
        if isinstance(candidate, str):
            try:
                return _bounded_text(candidate, 240, "object title") or ""
            except ShareBundleError:
                continue
    raise ShareBundleError("Object projection source has no bounded title")


def build_canvas_bundle(
    canvas: Mapping[str, Any],
    revision: Mapping[str, Any],
    *,
    allow_conversation_reference: bool = False,
) -> dict[str, Any]:
    snapshot = revision.get("snapshot_json")
    if not isinstance(snapshot, dict) or snapshot.get("schemaId") != "gb.canvas.snapshot.v1":
        raise ShareBundleError("Pinned canvas revision is invalid")
    _require_pinned_canvas_references(
        snapshot,
        allow_conversation_reference=allow_conversation_reference,
    )
    canvas_id = str(canvas["id"])
    version = revision["version"]
    source_hash = revision["content_hash"]
    payload = {
        "schemaId": CANVAS_PAYLOAD_SCHEMA,
        "canvasId": canvas_id,
        "title": _bounded_text(canvas["title"], 240, "canvas title"),
        "version": version,
        "contentHash": source_hash,
        "snapshot": snapshot,
    }
    if len(canonical_json(payload)) > MAX_CANVAS_PAYLOAD_BYTES:
        raise ShareBundleError("Canvas share payload exceeds 8 MiB")
    return _bundle(
        "canvas-only",
        {"canvasId": canvas_id, "version": version, "contentHash": source_hash},
        payload,
        target_id=canvas_id,
    )


def build_canvas_conversation_bundle(
    canvas: Mapping[str, Any],
    revision: Mapping[str, Any],
    conversation: Mapping[str, Any],
) -> dict[str, Any]:
    """Freeze one exact canvas and a redacted transcript of its exact chat.

    Conversation artifacts, provenance, projections, live state, runs, and logs
    are deliberately outside this first explicit combined-share boundary.
    """
    canvas_bundle = build_canvas_bundle(canvas, revision, allow_conversation_reference=True)
    canvas_payload = canvas_bundle["snapshot_json"]["payload"]
    snapshot = canvas_payload["snapshot"]
    conversation_ref = _conversation_reference(conversation)
    _require_exact_canvas_conversation(snapshot, conversation_ref)
    conversation_payload = redacted_conversation_payload(conversation)
    payload = {
        "schemaId": CANVAS_CONVERSATION_PAYLOAD_SCHEMA,
        "canvas": canvas_payload,
        "conversation": conversation_payload,
    }
    if len(canonical_json(payload)) > MAX_CANVAS_PAYLOAD_BYTES:
        raise ShareBundleError("Canvas plus conversation share payload exceeds 8 MiB")
    return _bundle(
        "canvas-plus-conversation",
        {
            "canvasId": canvas_payload["canvasId"],
            "version": canvas_payload["version"],
            "contentHash": canvas_payload["contentHash"],
            "conversationRef": conversation_ref,
        },
        payload,
        target_id=f'{canvas_payload["canvasId"]}:{conversation["conversationId"]}',
    )


def _conversation_reference(conversation: Mapping[str, Any]) -> str:
    value = conversation.get("ref")
    try:
        reference = parse_canonical_reference(value)
    except (ObjectLinkError, TypeError) as error:
        raise ShareBundleError("Conversation share source returned an invalid reference") from error
    if reference.kind != "chat" or reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
        raise ShareBundleError("Conversation share source did not pin an exact SHA-256 chat revision")
    if reference.identifier.lower() != str(conversation.get("conversationId")).lower():
        raise ShareBundleError("Conversation share source returned inconsistent identity")
    if reference.revision != conversation.get("contentHash"):
        raise ShareBundleError("Conversation share source returned inconsistent revision identity")
    return reference.wire


def _require_exact_canvas_conversation(snapshot: Mapping[str, Any], conversation_ref: str) -> None:
    try:
        selected_reference = parse_canonical_reference(conversation_ref)
    except (ObjectLinkError, TypeError) as error:
        raise ShareBundleError("Canvas plus conversation shares require one exact pinned chat") from error

    def is_selected(reference: Any) -> bool:
        return (
            reference.kind == "chat"
            and reference.identifier.lower() == selected_reference.identifier.lower()
            and reference.revision == selected_reference.revision
        )

    selected_item_count = 0
    conversation_references: list[Any] = []
    for item in snapshot.get("items", []):
        if not isinstance(item, dict):
            continue
        try:
            reference = parse_canonical_reference(item.get("subjectRef"))
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Canvas plus conversation shares require canonical pinned object references") from error
        if reference.kind in {"chat", "run", "turn"}:
            if reference.kind != "chat" or reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
                raise ShareBundleError("Canvas plus conversation shares reject run, turn, and unpinned chat references")
            conversation_references.append(reference)
            if is_selected(reference):
                selected_item_count += 1
    for edge in snapshot.get("edges", []):
        if not isinstance(edge, dict) or edge.get("semanticRef") is None:
            continue
        try:
            reference = parse_canonical_reference(edge.get("semanticRef"))
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Canvas plus conversation shares require canonical pinned object references") from error
        if reference.kind in {"chat", "run", "turn"}:
            if reference.kind != "chat" or reference.revision is None or not _SHA256_REVISION.fullmatch(reference.revision):
                raise ShareBundleError("Canvas plus conversation shares reject run, turn, and unpinned chat references")
            conversation_references.append(reference)
    if selected_item_count != 1 or any(not is_selected(value) for value in conversation_references):
        raise ShareBundleError("Canvas plus conversation shares require exactly the selected pinned chat placement")


def redacted_conversation_payload(conversation: Mapping[str, Any]) -> dict[str, Any]:
    """Return the bounded portable conversation boundary shared by exports.

    This is deliberately public so every portable representation applies the
    same role redaction and exact-reference checks. It does not authorize or
    load a conversation; callers must do both before invoking it.
    """
    conversation_ref = _conversation_reference(conversation)
    version = conversation.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ShareBundleError("Conversation share source has no exact version")
    turns = conversation.get("turns")
    edges = conversation.get("edges")
    if not isinstance(turns, list) or len(turns) > 1000 or not isinstance(edges, list):
        raise ShareBundleError("Conversation share source exceeds the 1000-turn bound")
    safe_turns = []
    for turn in turns:
        if not isinstance(turn, dict):
            raise ShareBundleError("Conversation share source contains an invalid turn")
        ordinal = turn.get("ordinal")
        role = turn.get("role")
        if isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 1:
            raise ShareBundleError("Conversation share source contains an invalid turn")
        if role not in {"user", "assistant", "system", "tool"}:
            raise ShareBundleError("Conversation share source contains an invalid turn")
        turn_id = _bounded_text(turn.get("turnId"), 128, "turnId")
        turn_hash = _bounded_text(turn.get("contentHash"), 71, "turn content hash")
        if turn_hash is None or not _SHA256_REVISION.fullmatch(turn_hash):
            raise ShareBundleError("Conversation share source contains an invalid turn hash")
        try:
            turn_reference = parse_canonical_reference(turn.get("ref"))
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Conversation share source contains an invalid turn reference") from error
        if (
            turn_reference.kind != "turn"
            or turn_reference.identifier != turn_id
            or turn_reference.revision != turn_hash
        ):
            raise ShareBundleError("Conversation share source contains inconsistent turn identity")
        safe_turn = {
            "turnId": turn_id,
            "ordinal": ordinal,
            "role": role,
            "sourceRef": turn_reference.wire,
            "sourceContentHash": turn_hash,
        }
        content = turn.get("content")
        if role in {"user", "assistant"}:
            if (
                not isinstance(content, str)
                or not content
                or len(content.encode("utf-8")) > 65_536
                or _CONTENT_CONTROL.search(content)
            ):
                raise ShareBundleError("Conversation share source contains an invalid publishable turn")
            safe_turn["publication"] = {
                "status": "published",
                "content": content,
                "contentSha256": f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}",
            }
        else:
            if content is not None:
                raise ShareBundleError("System and tool turn bodies must be redacted before bundle construction")
            safe_turn["publication"] = {
                "status": "redacted",
                "reason": "role-excluded",
            }
        safe_turns.append(safe_turn)
    safe_edges = []
    turn_ids = {turn["turnId"] for turn in safe_turns}
    for edge in edges:
        if not isinstance(edge, dict) or edge.get("kind") not in {"continues", "forks", "joins"}:
            raise ShareBundleError("Conversation share source contains an invalid edge")
        from_id = _bounded_text(edge.get("fromTurnId"), 128, "edge fromTurnId")
        to_id = _bounded_text(edge.get("toTurnId"), 128, "edge toTurnId")
        if from_id not in turn_ids or to_id not in turn_ids:
            raise ShareBundleError("Conversation share source contains an out-of-scope edge")
        safe_edges.append({
            "edgeId": _bounded_text(edge.get("edgeId"), 128, "edgeId"),
            "fromTurnId": from_id,
            "toTurnId": to_id,
            "kind": edge["kind"],
        })
    return {
        "schemaId": CONVERSATION_PAYLOAD_SCHEMA,
        "conversationId": _bounded_text(conversation.get("conversationId"), 128, "conversationId"),
        "ref": conversation_ref,
        "title": _bounded_text(conversation.get("title"), 240, "conversation title"),
        "goal": _bounded_content(conversation.get("goal"), 16_384, "conversation goal"),
        "version": version,
        "contentHash": conversation["contentHash"],
        "turns": safe_turns,
        "edges": safe_edges,
    }


def _require_pinned_canvas_references(
    snapshot: Mapping[str, Any],
    *,
    allow_conversation_reference: bool = False,
) -> None:
    items = snapshot.get("items")
    edges = snapshot.get("edges")
    if not isinstance(items, list) or not isinstance(edges, list):
        raise ShareBundleError("Pinned canvas snapshot is invalid")
    values: list[object] = [item.get("subjectRef") for item in items if isinstance(item, dict)]
    values.extend(edge.get("semanticRef") for edge in edges if isinstance(edge, dict) and edge.get("semanticRef") is not None)
    for value in values:
        try:
            reference = parse_canonical_reference(value)
        except (ObjectLinkError, TypeError) as error:
            raise ShareBundleError("Canvas shares require canonical pinned object references") from error
        if reference.revision is None:
            raise ShareBundleError("Canvas shares reject follow-latest object references")
        if reference.kind in {"chat", "run", "turn"} and not allow_conversation_reference:
            raise ShareBundleError("Canvas-only shares exclude conversation, run, and turn references")


def _bundle(mode: str, source: dict[str, Any], payload: dict[str, Any], *, target_id: str) -> dict[str, Any]:
    schema_id = BUNDLE_SCHEMA_V2 if mode in V2_MODES else BUNDLE_SCHEMA_V1
    core = {"schemaId": schema_id, "mode": mode, "source": source, "payload": payload}
    return {
        "target_type": mode,
        "target_id": target_id,
        "snapshot_json": core,
        "content_hash": content_hash(core),
    }
