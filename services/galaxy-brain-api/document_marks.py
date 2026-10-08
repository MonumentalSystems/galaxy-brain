"""Bounded canonical reader marks attached to immutable document anchors."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from document_anchors import canonical_anchor_json


DOCUMENT_MARK_SCHEMA_ID = "gb.document-mark.v1"
MAX_MARK_BODY_BYTES = 65_536
MAX_TAGS = 64
MAX_TAG_CHARACTERS = 100
MARK_KINDS = frozenset({"highlight", "note", "ink"})
MARK_ROLES = frozenset({"note", "claim", "evidence", "question"})
MARK_STATES = frozenset({"active", "resolved", "deleted"})
_ANCHOR_ID = re.compile(r"sha256:[0-9a-f]{64}")
_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


class DocumentMarkContractError(ValueError):
    pass


def _text(value: Any, label: str, *, maximum_bytes: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise DocumentMarkContractError(f"{label} must be text")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeError as error:
        raise DocumentMarkContractError(f"{label} contains invalid Unicode") from error
    if b"\x00" in encoded or len(encoded) > maximum_bytes or (not allow_empty and not value):
        raise DocumentMarkContractError(f"{label} is outside its bounded size")
    return value


def normalize_tags(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        raise DocumentMarkContractError("tags must be a bounded list")
    normalized = []
    seen = set()
    for item in value:
        tag = _text(item, "tag", maximum_bytes=400).strip()
        if not tag or len(tag) > MAX_TAG_CHARACTERS:
            raise DocumentMarkContractError("tag is outside its bounded size")
        if tag not in seen:
            seen.add(tag)
            normalized.append(tag)
    return normalized


def normalize_document_mark_state(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) != {
        "body_markdown", "color", "semantic_role", "tags", "state",
    }:
        raise DocumentMarkContractError("document mark state has invalid fields")
    body = _text(
        value["body_markdown"], "body_markdown",
        maximum_bytes=MAX_MARK_BODY_BYTES, allow_empty=True,
    )
    color = value["color"]
    if not isinstance(color, str) or not _COLOR.fullmatch(color):
        raise DocumentMarkContractError("color must be a six-digit hex color")
    role = value["semantic_role"]
    if not isinstance(role, str) or role not in MARK_ROLES:
        raise DocumentMarkContractError("semantic_role is invalid")
    state = value["state"]
    if not isinstance(state, str) or state not in MARK_STATES:
        raise DocumentMarkContractError("state is invalid")
    return {
        "body_markdown": body,
        "color": color.lower(),
        "semantic_role": role,
        "tags": normalize_tags(value["tags"]),
        "state": state,
    }


def document_mark_content_hash(anchor_id: str, kind: str, state: dict) -> str:
    if not isinstance(anchor_id, str) or not _ANCHOR_ID.fullmatch(anchor_id):
        raise DocumentMarkContractError("anchor_id is invalid")
    if not isinstance(kind, str) or kind not in MARK_KINDS:
        raise DocumentMarkContractError("kind is invalid")
    normalized = normalize_document_mark_state(state)
    value = {
        "schemaId": DOCUMENT_MARK_SCHEMA_ID,
        "anchorId": anchor_id,
        "kind": kind,
        "bodyMarkdown": normalized["body_markdown"],
        "color": normalized["color"],
        "semanticRole": normalized["semantic_role"],
        "tags": normalized["tags"],
        "state": normalized["state"],
    }
    return hashlib.sha256(canonical_anchor_json(value).encode("utf-8")).hexdigest()


def document_mark_request_hash(operation: str, value: dict) -> str:
    if operation not in {"create", "update"}:
        raise DocumentMarkContractError("document mark operation is invalid")
    return hashlib.sha256(canonical_anchor_json({
        "schemaId": f"gb.document-mark.{operation}.v1",
        "value": value,
    }).encode("utf-8")).hexdigest()
