"""Bounded durable conversation and turn-DAG contracts.

The database owns immutable aggregate revisions, turn revisions, and typed
lineage edges.  This module keeps request hashing and the graph read projection
deterministic without storing provider transcripts, execution logs, or secrets.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
from datetime import UTC, datetime
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import quote

from object_links import ObjectLinkError, parse_canonical_reference


CONVERSATION_SCHEMA = "gb.conversation.v1"
GRAPH_INPUT_SCHEMA = "gb.graph-projection-input.v1"
OBJECT_PROJECTION_SCHEMA = "gb.object-projection.v1"
EDGE_KINDS = frozenset({"continues", "forks", "joins"})
MESSAGE_ROLES = frozenset({"user", "assistant", "system", "tool"})
MAX_ARTIFACT_REFS = 32
MAX_JOIN_PARENTS = 8
MAX_LIST_CURSOR_BYTES = 8_192
MAX_SNAPSHOT_BYTES = 4_096
CURSOR_TTL_SECONDS = 900
CURSOR_FUTURE_SKEW_SECONDS = 30
CURSOR_WIRE_VERSION = "v2"
_IDEMPOTENCY = re.compile(r"^[A-Za-z0-9._:-]{8,200}$")
_WORKSPACE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]")
_PG_SNAPSHOT = re.compile(r"^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$")
_BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_PROVENANCE_FIELDS = {
    "provider": 120,
    "sourceRef": 1024,
    "model": 200,
    "statement": 500,
}
_SAFE_COMPONENT = "~!*'()-._"


class ConversationContractError(ValueError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def content_hash(value: Any) -> str:
    return f"sha256:{sha256(value)}"


def _text(value: Any, field: str, maximum_bytes: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or value != value.strip() or _CONTROL.search(value):
        raise ConversationContractError(f"{field} must be bounded UTF-8 text")
    if not allow_empty and not value:
        raise ConversationContractError(f"{field} must not be empty")
    if len(value.encode("utf-8")) > maximum_bytes:
        raise ConversationContractError(f"{field} exceeds its byte limit")
    return value


def idempotency_key(value: Any) -> str:
    if not isinstance(value, str) or not _IDEMPOTENCY.fullmatch(value):
        raise ConversationContractError("idempotency_key is invalid")
    return value


def workspace_id(value: Any) -> str:
    if not isinstance(value, str) or not _WORKSPACE.fullmatch(value):
        raise ConversationContractError("workspace_id is invalid")
    return value


def uuid_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ConversationContractError(f"{field} must be a UUID")
    return value.lower()


def artifact_refs(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_ARTIFACT_REFS:
        raise ConversationContractError("artifact_refs must be a bounded array")
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        try:
            reference = parse_canonical_reference(item)
        except ObjectLinkError as error:
            raise ConversationContractError("artifact_refs must contain canonical Galaxy references") from error
        if reference.revision is None:
            raise ConversationContractError("artifact_refs must pin exact revisions")
        if reference.wire in seen:
            raise ConversationContractError("artifact_refs must not contain duplicates")
        seen.add(reference.wire)
        normalized.append(reference.wire)
    return normalized


def provenance(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ConversationContractError("provenance must be an object")
    unknown = set(value) - set(_PROVENANCE_FIELDS)
    if unknown:
        raise ConversationContractError(f"provenance contains unsupported field {sorted(unknown)[0]}")
    normalized: dict[str, str] = {}
    for field, maximum in _PROVENANCE_FIELDS.items():
        if field in value:
            normalized[field] = _text(value[field], f"provenance.{field}", maximum)
    return normalized


def message(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"role", "content"}:
        raise ConversationContractError("message requires exactly role and content")
    role = _text(value["role"], "message.role", 20)
    if role not in MESSAGE_ROLES:
        raise ConversationContractError("message.role is unsupported")
    return {
        "role": role,
        "content": _text(value["content"], "message.content", 65_536),
    }


def normalize_create(value: Mapping[str, Any]) -> dict[str, Any]:
    expected = {"workspace_id", "title", "goal", "artifact_refs", "provenance", "idempotency_key"}
    if set(value) != expected:
        raise ConversationContractError("conversation create fields are invalid")
    normalized = {
        "workspace_id": workspace_id(value["workspace_id"]),
        "title": _text(value["title"], "title", 240),
        "goal": _text(value["goal"], "goal", 16_384),
        "artifact_refs": artifact_refs(value["artifact_refs"]),
        "provenance": provenance(value["provenance"]),
        "idempotency_key": idempotency_key(value["idempotency_key"]),
    }
    request = {key: normalized[key] for key in expected - {"idempotency_key"}}
    normalized["request_hash"] = sha256(request)
    normalized["content_hash"] = content_hash({
        "schemaId": "gb.conversation.revision.v1",
        "version": 1,
        "operation": {"kind": "create", **request},
    })
    return normalized


def normalize_turn_operation(kind: str, value: Mapping[str, Any]) -> dict[str, Any]:
    if kind not in EDGE_KINDS:
        raise ConversationContractError("conversation operation is unsupported")
    parent_field = "parent_turn_ids" if kind == "joins" else "parent_turn_id"
    expected = {
        "expected_version", parent_field, "message", "artifact_refs", "provenance", "idempotency_key",
    }
    if set(value) != expected:
        raise ConversationContractError(f"{kind} fields are invalid")
    version = value["expected_version"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ConversationContractError("expected_version must be a positive integer")
    if kind == "joins":
        raw_parents = value[parent_field]
        if not isinstance(raw_parents, list) or not 2 <= len(raw_parents) <= MAX_JOIN_PARENTS:
            raise ConversationContractError("join requires two to eight parent turns")
        parents = [uuid_text(parent, f"{parent_field}[]") for parent in raw_parents]
        if len(set(parents)) != len(parents):
            raise ConversationContractError("join parent turns must be distinct")
    else:
        parent = value[parent_field]
        parents = [] if parent is None else [uuid_text(parent, parent_field)]
        if kind == "forks" and not parents:
            raise ConversationContractError("fork requires a parent turn")
    normalized = {
        "expected_version": version,
        "parent_turn_ids": parents,
        "message": message(value["message"]),
        "artifact_refs": artifact_refs(value["artifact_refs"]),
        "provenance": provenance(value["provenance"]),
        "idempotency_key": idempotency_key(value["idempotency_key"]),
    }
    request = {key: normalized[key] for key in normalized if key != "idempotency_key"}
    normalized["request_hash"] = sha256({"kind": kind, **request})
    return normalized


def next_content_hash(previous_content_hash: str, next_version: int, kind: str, operation: Mapping[str, Any]) -> str:
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", previous_content_hash):
        raise ConversationContractError("previous content hash is invalid")
    return content_hash({
        "schemaId": "gb.conversation.revision.v1",
        "version": next_version,
        "previousContentHash": previous_content_hash,
        "operation": {"kind": kind, **operation},
    })


def _reference(kind: str, identifier: str, revision: str) -> str:
    return ":".join((
        "gb", "object", "v1", kind,
        quote(identifier, safe=_SAFE_COMPONENT),
        "pinned",
        quote(revision, safe=_SAFE_COMPONENT),
    ))


def _timestamp(value: Any, field: str) -> tuple[datetime, str]:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and len(value) <= 40:
        try:
            parsed = datetime.fromisoformat(value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else ""))
        except ValueError as error:
            raise ConversationContractError(f"{field} is invalid") from error
    else:
        raise ConversationContractError(f"{field} is invalid")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ConversationContractError(f"{field} must include a timezone")
    try:
        utc_value = parsed.astimezone(UTC)
    except (OverflowError, ValueError) as error:
        raise ConversationContractError(f"{field} is invalid") from error
    canonical = utc_value.isoformat(timespec="microseconds").replace("+00:00", "Z")
    return utc_value, canonical


def _cursor_secret(value: Any) -> bytes:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 4_096:
        raise ConversationContractError("conversation cursor signing secret is unavailable")
    return value.encode("utf-8")


def _snapshot(value: Any) -> str:
    if (not isinstance(value, str) or not value or len(value.encode("ascii", "ignore")) > MAX_SNAPSHOT_BYTES
            or not _PG_SNAPSHOT.fullmatch(value)):
        raise ConversationContractError("conversation snapshot is invalid")
    return value


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def encode_list_cursor(
    snapshot: Any,
    issued_at: Any,
    after_id: Any,
    tenant_id: Any,
    workspace: Any,
    secret: Any,
) -> str:
    _, timestamp = _timestamp(issued_at, "cursor.issuedAt")
    normalized_workspace = None if workspace is None else workspace_id(workspace)
    payload = canonical_json({
        "afterId": uuid_text(str(after_id), "cursor.afterId"),
        "issuedAt": timestamp,
        "schemaId": "gb.conversation.cursor.v2",
        "snapshot": _snapshot(snapshot),
        "tenantId": uuid_text(str(tenant_id), "cursor.tenantId"),
        "workspaceId": normalized_workspace,
    }).encode("utf-8")
    encoded = _base64url(payload)
    signed = f"{CURSOR_WIRE_VERSION}.{encoded}"
    signature = _base64url(hmac.digest(_cursor_secret(secret), signed.encode("ascii"), "sha256"))
    cursor = f"{signed}.{signature}"
    if len(cursor) > MAX_LIST_CURSOR_BYTES:
        raise ConversationContractError("conversation cursor exceeds its byte limit")
    return cursor


def decode_list_cursor(value: Any, secret: Any, *, now: Any = None) -> dict[str, Any]:
    if not isinstance(value, str) or not value or len(value) > MAX_LIST_CURSOR_BYTES:
        raise ConversationContractError("conversation cursor is invalid")
    segments = value.split(".")
    if (len(segments) != 3 or segments[0] != CURSOR_WIRE_VERSION
            or not _BASE64URL.fullmatch(segments[1]) or len(segments[2]) != 43
            or not _BASE64URL.fullmatch(segments[2])):
        raise ConversationContractError("conversation cursor is invalid")
    signed = f"{segments[0]}.{segments[1]}"
    expected_signature = _base64url(
        hmac.digest(_cursor_secret(secret), signed.encode("ascii"), "sha256")
    )
    if not hmac.compare_digest(expected_signature, segments[2]):
        raise ConversationContractError("conversation cursor is invalid")
    try:
        padded = segments[1] + "=" * (-len(segments[1]) % 4)
        payload = base64.b64decode(padded, altchars=b"-_", validate=True)
        if _base64url(payload) != segments[1]:
            raise ValueError("non-canonical base64url")
        decoded = json.loads(payload.decode("utf-8"))
    except (binascii.Error, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise ConversationContractError("conversation cursor is invalid") from error
    if not isinstance(decoded, dict) or set(decoded) != {
        "schemaId", "snapshot", "issuedAt", "afterId", "tenantId", "workspaceId",
    }:
        raise ConversationContractError("conversation cursor is invalid")
    if decoded["schemaId"] != "gb.conversation.cursor.v2":
        raise ConversationContractError("conversation cursor is unsupported")
    parsed_timestamp, canonical_timestamp = _timestamp(decoded["issuedAt"], "cursor.issuedAt")
    if decoded["issuedAt"] != canonical_timestamp:
        raise ConversationContractError("conversation cursor is not canonical")
    current, _ = _timestamp(now if now is not None else datetime.now(UTC), "cursor.now")
    age = (current - parsed_timestamp).total_seconds()
    if age < -CURSOR_FUTURE_SKEW_SECONDS or age > CURSOR_TTL_SECONDS:
        raise ConversationContractError("conversation cursor has expired")
    return {
        "snapshot": _snapshot(decoded["snapshot"]),
        "issued_at": parsed_timestamp,
        "issued_at_text": canonical_timestamp,
        "after_id": uuid_text(decoded["afterId"], "cursor.afterId"),
        "tenant_id": uuid_text(decoded["tenantId"], "cursor.tenantId"),
        "workspace_id": None if decoded["workspaceId"] is None else workspace_id(decoded["workspaceId"]),
    }


def exact_reference(value: Any, kind: str, identifier: str, field: str) -> Any:
    try:
        reference = parse_canonical_reference(value)
    except ObjectLinkError as error:
        raise ConversationContractError(f"{field} must be a canonical pinned {kind} reference") from error
    if (reference.kind != kind or reference.identifier.lower() != identifier.lower()
            or reference.revision is None or not re.fullmatch(r"sha256:[0-9a-f]{64}", reference.revision)):
        raise ConversationContractError(f"{field} must be a canonical pinned {kind} reference")
    return reference


def _display(value: str, maximum: int) -> str:
    collapsed = re.sub(r"[\x00-\x20\x7f-\x9f]+", " ", value).strip()
    return collapsed[:maximum].rstrip() or "Conversation turn"


def build_list_response(
    rows: Iterable[Mapping[str, Any]],
    *,
    snapshot: Any,
    issued_at: Any,
    tenant_id: Any,
    workspace: Any,
    cursor_secret: Any,
    limit: int,
    has_more: bool,
) -> dict[str, Any]:
    _, issued_at_text = _timestamp(issued_at, "snapshotAt")
    values = []
    for row in rows:
        conversation_id = str(row["id"])
        revision = str(row["snapshot_content_hash"])
        values.append({
            "schemaId": "gb.conversation.summary.v1",
            "conversationId": conversation_id,
            "workspaceId": row["workspace_id"],
            "ref": _reference("chat", conversation_id, revision),
            "title": row["title"],
            "goalSummary": _display(row["goal"], 512),
            "version": row["snapshot_version"],
            "contentHash": revision,
            "turnCount": max(0, int(row["snapshot_version"]) - 1),
            "artifactCount": len(row.get("artifact_refs") or []),
            "createdAt": row.get("created_at"),
            "updatedAt": row.get("snapshot_updated_at"),
        })
    normalized_tenant = uuid_text(str(tenant_id), "tenantId")
    normalized_workspace = None if workspace is None else workspace_id(workspace)
    cursor = (
        encode_list_cursor(
            snapshot, issued_at_text, values[-1]["conversationId"], normalized_tenant,
            normalized_workspace, cursor_secret,
        )
        if has_more and values else None
    )
    return {
        "schemaId": "gb.conversation.collection.v1",
        "snapshotAt": issued_at_text,
        "scope": {"tenantId": normalized_tenant, "workspaceId": normalized_workspace},
        "conversations": values,
        "continuation": {
            "limit": limit,
            "hasMore": has_more,
            "cursor": cursor,
        },
    }


def build_turn_resolution(
    conversation: Mapping[str, Any],
    turn: Mapping[str, Any],
    *,
    conversation_reference: Any,
    turn_reference: Any,
) -> dict[str, Any]:
    conversation_id = str(conversation["id"])
    turn_id = str(turn["id"])
    parsed_conversation = exact_reference(
        conversation_reference, "chat", conversation_id, "conversation_ref",
    )
    parsed_turn = exact_reference(turn_reference, "turn", turn_id, "turn_ref")
    if parsed_conversation.revision != turn["containing_content_hash"]:
        raise ConversationContractError(
            "conversation_ref does not pin the requested containing conversation revision"
        )
    containing_version = turn["containing_version"]
    introduced_in_version = turn["introduced_in_version"]
    if (isinstance(containing_version, bool) or not isinstance(containing_version, int)
            or containing_version < introduced_in_version):
        raise ConversationContractError("conversation_ref does not contain the requested turn")
    if parsed_turn.revision != turn["content_hash"]:
        raise ConversationContractError("turn_ref does not pin the stored turn revision")
    introducing_reference = _reference(
        "chat", conversation_id, turn["introducing_content_hash"],
    )
    return {
        "schemaId": "gb.conversation.turn.v1",
        "conversationId": conversation_id,
        "conversationRef": parsed_conversation.wire,
        "turnId": turn_id,
        "ref": parsed_turn.wire,
        "introducedIn": {
            "version": introduced_in_version,
            "contentHash": turn["introducing_content_hash"],
            "conversationRef": introducing_reference,
        },
        "ordinal": turn["ordinal"],
        "role": turn["role"],
        "content": turn["content"],
        "artifactRefs": list(turn.get("artifact_refs") or []),
        "provenance": dict(turn.get("provenance") or {}),
        "contentHash": turn["content_hash"],
        "createdAt": turn.get("created_at"),
    }


def _projection(*, reference: str, kind: str, revision: str, digest: str,
                title: str, summary: str, source_id: str, capabilities: Sequence[str]) -> dict[str, Any]:
    return {
        "schemaId": OBJECT_PROJECTION_SCHEMA,
        "ref": reference,
        "kind": kind,
        "revision": {"policy": "pinned", "id": revision, "contentHash": digest},
        "title": _display(title, 240),
        "summary": _display(summary, 4000),
        "mediaType": "application/vnd.galaxy.conversation+json" if kind == "chat"
        else "application/vnd.galaxy.conversation-turn+json",
        "representations": [],
        "provenance": {
            "provider": "galaxy.conversation",
            "sourceId": source_id,
            "sourceRevision": revision,
            "statement": "Immutable tenant-scoped conversation state.",
        },
        "capabilities": list(capabilities),
    }


def build_read_projection(
    conversation: Mapping[str, Any],
    turns: Iterable[Mapping[str, Any]],
    edges: Iterable[Mapping[str, Any]],
    *,
    parent_turns: Iterable[Mapping[str, Any]] = (),
    after_ordinal: int,
    limit: int,
    has_more: bool,
) -> dict[str, Any]:
    conversation_id = str(conversation["id"])
    revision = str(conversation["current_content_hash"])
    digest = revision.removeprefix("sha256:")
    conversation_ref = _reference("chat", conversation_id, revision)
    scope = {"tenantId": str(conversation["tenant_id"]), "workspaceId": conversation["workspace_id"]}
    objects = [{
        "scope": scope,
        "projection": _projection(
            reference=conversation_ref,
            kind="chat",
            revision=revision,
            digest=digest,
            title=conversation["title"],
            summary=conversation["goal"],
            source_id=conversation_id,
            capabilities=("open", "place", "branch", "cite", "inspect", "relate"),
        ),
    }]
    turn_refs: dict[str, str] = {}
    turn_values: list[dict[str, Any]] = []
    context_turn_values: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []

    def add_turn(row: Mapping[str, Any], *, context: bool) -> None:
        turn_id = str(row["id"])
        if turn_id in turn_refs:
            return
        turn_revision = str(row["content_hash"])
        turn_digest = turn_revision.removeprefix("sha256:")
        turn_ref = _reference("turn", turn_id, turn_revision)
        turn_refs[turn_id] = turn_ref
        value = {
            "turnId": turn_id,
            "ordinal": row["ordinal"],
            "role": row["role"],
            "content": row["content"],
            "artifactRefs": list(row.get("artifact_refs") or []),
            "provenance": dict(row.get("provenance") or {}),
            "ref": turn_ref,
            "contentHash": turn_revision,
            "createdAt": row.get("created_at"),
        }
        (context_turn_values if context else turn_values).append(value)
        objects.append({
            "scope": scope,
            "projection": _projection(
                reference=turn_ref,
                kind="turn",
                revision=turn_revision,
                digest=turn_digest,
                title=f"{row['role'].capitalize()} turn {row['ordinal']}",
                summary=row["content"],
                source_id=turn_id,
                capabilities=("open", "branch", "cite", "inspect", "relate"),
            ),
        })
        relations.append({
            "scope": scope,
            "relation": {
                "fromRef": conversation_ref,
                "toRef": turn_ref,
                "relation": "contains",
                "trust": "structure",
                "source": {"provider": "galaxy.conversation", "recordId": f"turn:{turn_id}"},
            },
        })

    for row in parent_turns:
        add_turn(row, context=True)
    for row in turns:
        add_turn(row, context=False)
    edge_values: list[dict[str, Any]] = []
    for row in edges:
        from_id, to_id = str(row["from_turn_id"]), str(row["to_turn_id"])
        if from_id not in turn_refs or to_id not in turn_refs:
            continue
        edge_id = str(row["id"])
        kind = row["edge_kind"]
        edge_values.append({
            "edgeId": edge_id,
            "fromTurnId": from_id,
            "toTurnId": to_id,
            "kind": kind,
            "createdAt": row.get("created_at"),
        })
        relations.append({
            "scope": scope,
            "relation": {
                "fromRef": turn_refs[from_id],
                "toRef": turn_refs[to_id],
                "relation": kind,
                "trust": "structure",
                "source": {"provider": "galaxy.conversation", "recordId": edge_id},
            },
        })
    next_after = turn_values[-1]["ordinal"] if has_more and turn_values else None
    return {
        "schemaId": CONVERSATION_SCHEMA,
        "conversationId": conversation_id,
        "workspaceId": conversation["workspace_id"],
        "ref": conversation_ref,
        "title": conversation["title"],
        "goal": conversation["goal"],
        "version": conversation["current_version"],
        "contentHash": revision,
        "artifactRefs": list(conversation.get("artifact_refs") or []),
        "provenance": dict(conversation.get("provenance") or {}),
        "turns": turn_values,
        "contextTurns": context_turn_values,
        "edges": edge_values,
        "continuation": {
            "afterOrdinal": after_ordinal,
            "limit": limit,
            "hasMore": has_more,
            "nextAfterOrdinal": next_after,
            "version": conversation["current_version"],
            "contentHash": revision,
        },
        "graphProjectionInput": {
            "schemaId": GRAPH_INPUT_SCHEMA,
            "scope": scope,
            "query": {
                "rootRef": conversation_ref,
                "mode": "conversation",
                "lens": "explore",
                "scale": "task",
                "viewport": None,
                "filters": {},
                "validAt": None,
                "knownAt": None,
                "cursor": None,
            },
            "objects": objects,
            "external": [],
            "links": [],
            "relations": relations,
            "proofContexts": [],
            "providers": [{"scope": scope, "provider": "galaxy.conversation", "status": "ready", "snapshot": revision}],
        },
    }
