"""Deterministic Markdown export for one authorized conversation snapshot.

This module accepts only the already-redacted, exact conversation payload
produced by ``share_bundle.redacted_conversation_payload``.  Database access,
tenant authorization, and historical-revision selection remain server
responsibilities; rendering is intentionally pure and testable.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Mapping


EXPORT_MANIFEST_SCHEMA = "gb.markdown-export-manifest.v1"
EXPORT_PROJECTOR_ID = "galaxy.conversation.markdown"
EXPORT_PROJECTOR_VERSION = "1.0.0"
MAX_MARKDOWN_EXPORT_BYTES = 16 * 1024 * 1024

_SHA256_REVISION = re.compile(r"^sha256:[0-9a-f]{64}$")
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}
_BIDI_CONTROLS = {
    "\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c",
    "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069",
}


class ConversationMarkdownExportError(ValueError):
    """The exact conversation cannot be represented by the v1 export."""


class ConversationMarkdownExportTooLarge(ConversationMarkdownExportError):
    """The complete export exceeds the all-or-nothing response bound."""


@dataclass(frozen=True)
class ConversationMarkdownExport:
    content: bytes
    content_sha256: str
    filename: str
    ascii_filename: str
    manifest: Mapping[str, Any]


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _safe_filename_component(value: object, *, ascii_only: bool) -> str:
    text = unicodedata.normalize("NFKC", str(value or "conversation"))
    if ascii_only:
        text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    characters: list[str] = []
    for character in text:
        if character in _BIDI_CONTROLS or unicodedata.category(character).startswith("C"):
            continue
        characters.append("-" if character in '<>:"/\\|?*' else character)
    text = re.sub(r"\s+", "-", "".join(characters)).strip(" .-")
    text = re.sub(r"-+", "-", text)[:96].rstrip(" .-")
    if not text:
        text = "conversation"
    if text.casefold() in _WINDOWS_RESERVED:
        text += "-export"
    return text


def _heading_text(value: object) -> str:
    return str(value).replace("\\", "\\\\").replace("#", "\\#").strip()


def _validate_payload(payload: Mapping[str, Any]) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    if payload.get("schemaId") != "gb.share-redacted-conversation.v1":
        raise ConversationMarkdownExportError("Conversation export requires the redacted exact snapshot schema")
    source_ref = payload.get("ref")
    content_hash = payload.get("contentHash")
    if not isinstance(source_ref, str) or ":chat:" not in source_ref or ":pinned:" not in source_ref:
        raise ConversationMarkdownExportError("Conversation export requires one canonical pinned chat reference")
    if not isinstance(content_hash, str) or not _SHA256_REVISION.fullmatch(content_hash):
        raise ConversationMarkdownExportError("Conversation export requires one exact SHA-256 revision")
    if not source_ref.endswith(content_hash.replace(":", "%3A")):
        raise ConversationMarkdownExportError("Conversation export reference and content hash disagree")
    version = payload.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ConversationMarkdownExportError("Conversation export requires one exact version")

    turns = payload.get("turns")
    edges = payload.get("edges")
    if not isinstance(turns, list) or len(turns) > 1000 or not isinstance(edges, list):
        raise ConversationMarkdownExportError("Conversation export exceeds the bounded snapshot contract")
    ordinals: set[int] = set()
    turn_ids: set[str] = set()
    for turn in turns:
        if not isinstance(turn, Mapping):
            raise ConversationMarkdownExportError("Conversation export contains an invalid turn")
        ordinal = turn.get("ordinal")
        turn_id = turn.get("turnId")
        role = turn.get("role")
        reference = turn.get("sourceRef")
        turn_hash = turn.get("sourceContentHash")
        publication = turn.get("publication")
        if (
            isinstance(ordinal, bool) or not isinstance(ordinal, int) or ordinal < 1
            or ordinal in ordinals or not isinstance(turn_id, str) or turn_id in turn_ids
            or role not in {"user", "assistant", "system", "tool"}
            or not isinstance(reference, str) or ":turn:" not in reference or ":pinned:" not in reference
            or not isinstance(turn_hash, str) or not _SHA256_REVISION.fullmatch(turn_hash)
            or not reference.endswith(turn_hash.replace(":", "%3A"))
            or not isinstance(publication, Mapping)
        ):
            raise ConversationMarkdownExportError("Conversation export contains inconsistent turn identity")
        if role in {"user", "assistant"}:
            content = publication.get("content")
            if (
                publication.get("status") != "published"
                or not isinstance(content, str)
                or not content
                or len(content.encode("utf-8")) > 65_536
            ):
                raise ConversationMarkdownExportError("Conversation export contains an invalid publishable turn")
            expected = f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"
            if publication.get("contentSha256") != expected:
                raise ConversationMarkdownExportError("Conversation export contains inconsistent published content")
        elif publication != {"status": "redacted", "reason": "role-excluded"}:
            raise ConversationMarkdownExportError("Conversation export contains an invalid redaction record")
        ordinals.add(ordinal)
        turn_ids.add(turn_id)

    ordered_ordinals = sorted(ordinals)
    if ordered_ordinals != list(range(1, version)):
        raise ConversationMarkdownExportError("Conversation export turn sequence is incomplete")
    turn_ordinal = {turn["turnId"]: turn["ordinal"] for turn in turns}
    incoming: dict[str, list[str]] = {turn_id: [] for turn_id in turn_ids}
    edge_ids: set[str] = set()
    edge_pairs: set[tuple[str, str]] = set()
    for edge in edges:
        if not isinstance(edge, Mapping):
            raise ConversationMarkdownExportError("Conversation export contains an invalid lineage edge")
        edge_pair = (edge.get("fromTurnId"), edge.get("toTurnId"))
        if (
            edge.get("kind") not in {"continues", "forks", "joins"}
            or not isinstance(edge.get("edgeId"), str)
            or edge.get("edgeId") in edge_ids
            or edge_pair in edge_pairs
            or edge.get("fromTurnId") not in turn_ids
            or edge.get("toTurnId") not in turn_ids
            or turn_ordinal[edge["fromTurnId"]] >= turn_ordinal[edge["toTurnId"]]
        ):
            raise ConversationMarkdownExportError("Conversation export contains an invalid lineage edge")
        edge_ids.add(edge["edgeId"])
        edge_pairs.add(edge_pair)
        incoming[edge["toTurnId"]].append(edge["kind"])
    for turn_id, ordinal in turn_ordinal.items():
        parent_kinds = incoming[turn_id]
        parent_count = len(parent_kinds)
        valid_lineage = (
            (ordinal == 1 and parent_count == 0)
            or (
                ordinal > 1
                and parent_count == 1
                and parent_kinds[0] in {"continues", "forks"}
            )
            or (
                ordinal > 1
                and 2 <= parent_count <= 8
                and set(parent_kinds) == {"joins"}
            )
        )
        if not valid_lineage:
            raise ConversationMarkdownExportError("Conversation export lineage is incomplete")
    return sorted(turns, key=lambda turn: turn["ordinal"]), sorted(
        edges,
        key=lambda edge: (edge["fromTurnId"], edge["toTurnId"], edge["kind"], edge["edgeId"]),
    )


def build_conversation_markdown_export(payload: Mapping[str, Any]) -> ConversationMarkdownExport:
    """Render one redacted exact snapshot as deterministic Markdown bytes."""
    turns, edges = _validate_payload(payload)
    turn_by_id = {turn["turnId"]: turn for turn in turns}
    representations = [{
        "kind": "conversation-turn",
        "ordinal": turn["ordinal"],
        "role": turn["role"],
        "ref": turn["sourceRef"],
        "revisionSha256": turn["sourceContentHash"],
        "publicationContentSha256": turn["publication"].get("contentSha256"),
        "publicationStatus": turn["publication"]["status"],
    } for turn in turns]
    relations = [{
        "id": edge["edgeId"],
        "fromRef": turn_by_id[edge["fromTurnId"]]["sourceRef"],
        "toRef": turn_by_id[edge["toTurnId"]]["sourceRef"],
        "kind": edge["kind"],
        "trustClass": "structural",
    } for edge in edges]
    manifest = {
        "schemaId": EXPORT_MANIFEST_SCHEMA,
        "source": {
            "kind": "chat",
            "ref": payload["ref"],
            "version": payload["version"],
            "contentSha256": payload["contentHash"],
        },
        "projector": {
            "id": EXPORT_PROJECTOR_ID,
            "version": EXPORT_PROJECTOR_VERSION,
        },
        "representations": representations,
        "relations": relations,
        "artifacts": [],
        "artifactPolicy": {
            "status": "excluded",
            "reason": "conversation-export-v1-redaction-boundary",
        },
        "redaction": {
            "excludedRoles": ["system", "tool"],
            "excludedFields": ["artifacts", "provenance", "runs", "logs", "liveState"],
        },
    }

    title = _heading_text(payload.get("title") or "Exact conversation")
    lines = [
        f"# {title}",
        "",
        f"Exact reference: `{payload['ref']}`  ",
        f"Revision: `{payload['contentHash']}`  ",
        f"Version: `{payload['version']}`",
    ]
    lines.extend([
        "",
        "## Pinned export manifest",
        "",
        "```json",
        _canonical_json(manifest),
        "```",
    ])
    goal = payload.get("goal")
    if isinstance(goal, str) and goal:
        lines.extend(["", "## Goal", "", goal])
    lines.extend(["", "## Conversation"])
    for turn in turns:
        role_label = str(turn["role"]).capitalize()
        lines.extend([
            "",
            f"### {turn['ordinal']}. {role_label}",
            "",
            f"Exact turn: `{turn['sourceRef']}`",
            "",
        ])
        publication = turn["publication"]
        if publication["status"] == "published":
            # Preserve authored Markdown and LaTeX exactly; never render through HTML.
            lines.append(publication["content"])
        else:
            lines.append(f"_[{role_label} content redacted: role excluded from portable export.]_")
    if relations:
        lines.extend(["", "## Lineage", ""])
        for relation in relations:
            lines.append(
                f"- `{relation['kind']}`: `{relation['fromRef']}` → `{relation['toRef']}`"
            )
    lines.append("")
    content = "\n".join(lines).encode("utf-8")
    if len(content) > MAX_MARKDOWN_EXPORT_BYTES:
        raise ConversationMarkdownExportTooLarge("Conversation Markdown export exceeds 16 MiB")
    digest = hashlib.sha256(content).hexdigest()
    revision_prefix = payload["contentHash"].removeprefix("sha256:")[:12]
    filename = f"{_safe_filename_component(payload.get('title'), ascii_only=False)}--{revision_prefix}.md"
    ascii_filename = f"{_safe_filename_component(payload.get('title'), ascii_only=True)}--{revision_prefix}.md"
    return ConversationMarkdownExport(
        content=content,
        content_sha256=digest,
        filename=filename,
        ascii_filename=ascii_filename,
        manifest=manifest,
    )
