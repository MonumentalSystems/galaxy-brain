"""Bounded contracts for tenant-local search over derived document chunks.

Search hits always identify the owning immutable document revision.  Chunk
rows remain local indexing evidence and are never exposed as Galaxy objects.
"""

from __future__ import annotations

import re
from typing import Any


SEARCH_SCHEMA_ID = "gb.document-corpus-search.v1"
MAX_QUERY_CHARACTERS = 500
MAX_QUERY_BYTES = 2_048
DEFAULT_LIMIT = 8
MAX_LIMIT = 20
MAX_SNIPPET_CHARACTERS = 320
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_WHITESPACE = re.compile(r"\s+")


class DocumentSearchContractError(ValueError):
    pass


def normalize_document_search_query(value: Any) -> str:
    if not isinstance(value, str):
        raise DocumentSearchContractError("Search query must be text")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise DocumentSearchContractError("Search query must be valid UTF-8") from error
    if not 1 <= len(value) <= MAX_QUERY_CHARACTERS or len(encoded) > MAX_QUERY_BYTES:
        raise DocumentSearchContractError(
            f"Search query must contain 1 to {MAX_QUERY_CHARACTERS} characters and at most {MAX_QUERY_BYTES} UTF-8 bytes"
        )
    if _CONTROL.search(value):
        raise DocumentSearchContractError("Search query contains control characters")
    normalized = value.strip()
    if not normalized:
        raise DocumentSearchContractError("Search query must not be blank")
    return normalized


def normalize_document_search_limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_LIMIT:
        raise DocumentSearchContractError(f"Search limit must be between 1 and {MAX_LIMIT}")
    return value


def plain_search_snippet(value: Any) -> str:
    """Return a single bounded plain-text excerpt, never markup we supplied."""
    if not isinstance(value, str):
        raise DocumentSearchContractError("Stored search excerpt is invalid")
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise DocumentSearchContractError("Stored search excerpt is invalid") from error
    normalized = value.replace("__GB_START__", "").replace("__GB_STOP__", "")
    normalized = _WHITESPACE.sub(" ", _CONTROL.sub(" ", normalized)).strip()
    if len(normalized) <= MAX_SNIPPET_CHARACTERS:
        return normalized
    return normalized[: MAX_SNIPPET_CHARACTERS - 1].rstrip() + "…"


def bounded_search_result_text(
    value: Any, label: str, *, maximum_characters: int, maximum_bytes: int,
) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or _CONTROL.search(value):
        raise DocumentSearchContractError(f"Stored search {label} is invalid")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise DocumentSearchContractError(f"Stored search {label} is invalid") from error
    if len(value) > maximum_characters or len(encoded) > maximum_bytes:
        raise DocumentSearchContractError(f"Stored search {label} is invalid")
    return value


def bounded_search_selector(value: Any) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise DocumentSearchContractError("Stored search selector is invalid")
    if set(value) == {"kind", "pointer"} and value.get("kind") == "json-pointer":
        pointer = value.get("pointer")
        if isinstance(pointer, str) and re.fullmatch(r"/blocks/(?:0|[1-9][0-9]{0,5})", pointer):
            return value
    if set(value) == {"kind", "unit", "start", "end", "overlap"}:
        start, end, overlap = value.get("start"), value.get("end"), value.get("overlap")
        if (
            value.get("kind") == "text-position"
            and value.get("unit") == "unicode-code-point"
            and all(isinstance(item, int) and not isinstance(item, bool) for item in (start, end, overlap))
            and 0 <= start < end <= 100_000_000
            and 0 <= overlap < end - start
        ):
            return value
    raise DocumentSearchContractError("Stored search selector is invalid")
