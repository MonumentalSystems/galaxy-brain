"""Pure bounded chunking and deterministic identity for gb.document-chunk.v1.

Chunks are derived indexing units.  Their ``sha256:`` identifiers are local
content addresses, not canonical Galaxy object references or capabilities.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

CHUNK_SCHEMA_ID = "gb.document-chunk.v1"
CHUNK_MANIFEST_SCHEMA_ID = "gb.document-chunk-manifest.v1"
CHUNKER_STRUCTURE_ID = "galaxy.document-structure-blocks"
CHUNKER_STRUCTURE_VERSION = "1"
CHUNKER_TEXT_ID = "galaxy.unicode-code-point-windows"
CHUNKER_TEXT_VERSION = "1"
DEFAULT_WINDOW_CODE_POINTS = 1_200
DEFAULT_OVERLAP_CODE_POINTS = 200
MAX_WINDOW_CODE_POINTS = 250_000
MAX_DOCUMENT_CHUNKS = 100_000
MAX_CHUNK_TEXT_BYTES = 1_048_576
MAX_TEXT_REPRESENTATION_BYTES = 16_777_216

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
CANONICAL_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")


class DocumentChunkContractError(ValueError):
    pass


def _plain_object(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise DocumentChunkContractError(f"{label} must be an object")
    return value


def _valid_unicode(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise DocumentChunkContractError(f"{label} must be valid Unicode")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise DocumentChunkContractError(f"{label} must be valid Unicode") from error
    return value


def canonical_chunk_json(value: Any) -> str:
    def normalize(item: Any) -> Any:
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, str):
            return _valid_unicode(item, "Canonical JSON string")
        if isinstance(item, int) and not isinstance(item, bool):
            if abs(item) > 9_007_199_254_740_991:
                raise DocumentChunkContractError("Canonical JSON numbers must be safe integers")
            return 0 if item == 0 else item
        if isinstance(item, float):
            if not math.isfinite(item) or not item.is_integer() or abs(item) > 9_007_199_254_740_991:
                raise DocumentChunkContractError("Canonical JSON numbers must be safe integers")
            return int(item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            if not all(isinstance(key, str) and CANONICAL_KEY.fullmatch(key) for key in item):
                raise DocumentChunkContractError(
                    "Canonical JSON object keys must be ASCII contract names"
                )
            return {key: normalize(item[key]) for key in sorted(item)}
        raise DocumentChunkContractError("Canonical JSON contains an unsupported value")

    return json.dumps(normalize(value), ensure_ascii=False, separators=(",", ":"))


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utf8_size(value: Any, label: str) -> int:
    return len(_valid_unicode(value, label).encode("utf-8"))


def _window_options(window_code_points: int, overlap_code_points: int) -> dict:
    if (
        not isinstance(window_code_points, int) or isinstance(window_code_points, bool)
        or not 1 <= window_code_points <= MAX_WINDOW_CODE_POINTS
    ):
        raise DocumentChunkContractError(
            f"window_code_points must be between 1 and {MAX_WINDOW_CODE_POINTS}"
        )
    if (
        not isinstance(overlap_code_points, int) or isinstance(overlap_code_points, bool)
        or overlap_code_points < 0 or overlap_code_points >= window_code_points
    ):
        raise DocumentChunkContractError(
            "overlap_code_points must be non-negative and smaller than window_code_points"
        )
    return {
        "windowCodePoints": window_code_points,
        "overlapCodePoints": overlap_code_points,
    }


def _chunker(identifier: str, version: str, config: dict) -> dict:
    return {
        "id": identifier,
        "version": version,
        "config": config,
        "configSha256": _sha256(canonical_chunk_json(config)),
    }


def current_document_chunker(
    kind: str,
    *,
    window_code_points: int = DEFAULT_WINDOW_CODE_POINTS,
    overlap_code_points: int = DEFAULT_OVERLAP_CODE_POINTS,
) -> dict:
    """Return the exact current descriptor used to select/reconcile chunk rows."""
    if kind == "document-structure":
        return _chunker(
            CHUNKER_STRUCTURE_ID,
            CHUNKER_STRUCTURE_VERSION,
            {"strategy": "declared-reading-order-json-pointer"},
        )
    if kind not in {"markdown", "text"}:
        raise DocumentChunkContractError("Representation kind cannot be chunked")
    options = _window_options(window_code_points, overlap_code_points)
    return _chunker(
        CHUNKER_TEXT_ID,
        CHUNKER_TEXT_VERSION,
        {"strategy": "unicode-code-point-window", **options},
    )


def _chunk_identity(representation_sha256: str, selector: dict, chunker: dict) -> dict:
    return {
        "schemaId": CHUNK_SCHEMA_ID,
        "representationSha256": representation_sha256,
        "selector": selector,
        "chunker": {
            "id": chunker["id"],
            "version": chunker["version"],
            "configSha256": chunker["configSha256"],
        },
    }


def _chunk(
    representation_id: str,
    representation_sha256: str,
    ordinal: int,
    selector: dict,
    text_content: str,
    chunker: dict,
) -> dict:
    byte_size = _utf8_size(text_content, "Chunk text")
    if not 1 <= byte_size <= MAX_CHUNK_TEXT_BYTES:
        raise DocumentChunkContractError(
            f"Chunk text must contain between 1 and {MAX_CHUNK_TEXT_BYTES} UTF-8 bytes"
        )
    selector_sha256 = _sha256(canonical_chunk_json(selector))
    chunk_sha256 = _sha256(canonical_chunk_json(
        _chunk_identity(representation_sha256, selector, chunker)
    ))
    return {
        "schemaId": CHUNK_SCHEMA_ID,
        "id": f"sha256:{chunk_sha256}",
        "chunkSha256": chunk_sha256,
        "representationId": representation_id,
        "representationSha256": representation_sha256,
        "ordinal": ordinal,
        "selector": selector,
        "selectorSha256": selector_sha256,
        "textContent": text_content,
        "contentSha256": _sha256(text_content),
        "chunkerId": chunker["id"],
        "chunkerVersion": chunker["version"],
        "chunkerConfigSha256": chunker["configSha256"],
    }


def _structure_chunks(
    representation_id: str, representation_sha256: str, content: Any
) -> tuple[dict, list[dict]]:
    structure = _plain_object(content, "Document structure")
    if structure.get("schemaId") != "gb.document-structure.v1":
        raise DocumentChunkContractError("Document structure schema is unsupported")
    blocks = structure.get("blocks")
    reading_order = structure.get("readingOrder")
    if not isinstance(blocks, list) or len(blocks) > MAX_DOCUMENT_CHUNKS:
        raise DocumentChunkContractError(
            "Document structure blocks are invalid or exceed the chunk limit"
        )
    if not isinstance(reading_order, list) or len(reading_order) != len(blocks):
        raise DocumentChunkContractError(
            "Document structure readingOrder must include every block exactly once"
        )
    block_index: dict[str, int] = {}
    for index, raw_block in enumerate(blocks):
        block = _plain_object(raw_block, f"Document block {index}")
        block_id = block.get("id")
        if (
            not isinstance(block_id, str) or not block_id or len(block_id) > 128
        ):
            raise DocumentChunkContractError("Document block id is invalid")
        _valid_unicode(block_id, "Document block id")
        if block_id in block_index:
            raise DocumentChunkContractError("Document block ids must be unique")
        block_index[block_id] = index
    chunker = current_document_chunker("document-structure")
    chunks = []
    seen: set[str] = set()
    for block_id in reading_order:
        if not isinstance(block_id, str) or block_id not in block_index or block_id in seen:
            raise DocumentChunkContractError(
                "Document structure readingOrder must include every block exactly once"
            )
        seen.add(block_id)
        index = block_index[block_id]
        block = blocks[index]
        text = block.get("text")
        latex = block.get("latex")
        if text is not None and not isinstance(text, str):
            raise DocumentChunkContractError("Document block text must be a string or null")
        if latex is not None and not isinstance(latex, str):
            raise DocumentChunkContractError("Document block LaTeX must be a string or null")
        parts = []
        if text:
            parts.append(text)
        if latex and latex != text:
            parts.append(latex)
        if not parts:
            continue
        chunks.append(_chunk(
            representation_id,
            representation_sha256,
            len(chunks),
            {"kind": "json-pointer", "pointer": f"/blocks/{index}"},
            "\n\n".join(parts),
            chunker,
        ))
    return chunker, chunks


def _text_chunks(
    representation_id: str,
    representation_sha256: str,
    kind: str,
    content: Any,
    window_code_points: int,
    overlap_code_points: int,
) -> tuple[dict, list[dict]]:
    text = _valid_unicode(content, "Text representation content")
    if len(text.encode("utf-8")) > MAX_TEXT_REPRESENTATION_BYTES:
        raise DocumentChunkContractError(
            f"Text representation exceeds {MAX_TEXT_REPRESENTATION_BYTES} UTF-8 bytes"
        )
    chunker = current_document_chunker(
        kind,
        window_code_points=window_code_points,
        overlap_code_points=overlap_code_points,
    )
    if not text:
        return chunker, []
    step = window_code_points - overlap_code_points
    chunk_count = math.ceil(max(0, len(text) - window_code_points) / step) + 1
    if chunk_count > MAX_DOCUMENT_CHUNKS:
        raise DocumentChunkContractError("Text representation would exceed the chunk limit")
    chunks = []
    start = 0
    ordinal = 0
    while start < len(text):
        end = min(start + window_code_points, len(text))
        chunks.append(_chunk(
            representation_id,
            representation_sha256,
            ordinal,
            {
                "kind": "text-position",
                "unit": "unicode-code-point",
                "start": start,
                "end": end,
                "overlap": 0 if ordinal == 0 else overlap_code_points,
            },
            text[start:end],
            chunker,
        ))
        if end == len(text):
            break
        start += step
        ordinal += 1
    return chunker, chunks


def materialize_document_chunks(
    representation_id: str,
    representation_sha256: str,
    kind: str,
    content: Any,
    *,
    window_code_points: int = DEFAULT_WINDOW_CODE_POINTS,
    overlap_code_points: int = DEFAULT_OVERLAP_CODE_POINTS,
) -> dict:
    """Materialize one complete, deterministic, bounded derived chunk manifest."""
    if not isinstance(representation_id, str) or not UUID.fullmatch(representation_id):
        raise DocumentChunkContractError("Representation id must be a UUID")
    if not isinstance(representation_sha256, str) or not SHA256.fullmatch(representation_sha256):
        raise DocumentChunkContractError(
            "Representation SHA-256 must be a lowercase digest"
        )
    representation_id = representation_id.lower()
    if kind == "document-structure":
        chunker, chunks = _structure_chunks(
            representation_id, representation_sha256, content
        )
    elif kind in {"markdown", "text"}:
        chunker, chunks = _text_chunks(
            representation_id,
            representation_sha256,
            kind,
            content,
            window_code_points,
            overlap_code_points,
        )
    else:
        raise DocumentChunkContractError("Representation kind cannot be chunked")
    return {
        "schemaId": CHUNK_MANIFEST_SCHEMA_ID,
        "canonicalObject": False,
        "representationId": representation_id,
        "representationSha256": representation_sha256,
        "representationKind": kind,
        "chunker": chunker,
        "chunkCount": len(chunks),
        "chunks": chunks,
    }
