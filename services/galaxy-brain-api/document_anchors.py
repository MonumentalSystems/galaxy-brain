"""Pure validation and deterministic identity for gb.anchor.v1."""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

DOCUMENT_ANCHOR_SCHEMA_ID = "gb.anchor.v1"
MAX_ANCHOR_SELECTOR_BYTES = 32_768
MAX_TEXT_QUOTE_CHARS = 16_000
MAX_TEXT_CONTEXT_CHARS = 2_000

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MEDIA_TYPE = re.compile(r"^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")
SELECTOR_KEYS = {
    "page-region": {"kind", "page", "coordinateSpace", "polygon", "quoteHash"},
    "text-quote": {"kind", "exact", "prefix", "suffix", "page"},
    "json-pointer": {"kind", "pointer"},
}


class DocumentAnchorContractError(ValueError):
    pass


def _plain_object(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise DocumentAnchorContractError(f"{label} must be an object")
    return value


def _aliased_field(value: dict, snake_case: str, camel_case: str, fallback: Any = None) -> Any:
    has_snake_case = snake_case in value
    has_camel_case = camel_case in value
    if has_snake_case and has_camel_case:
        raise DocumentAnchorContractError(
            f"Representation cannot contain both {snake_case} and {camel_case}"
        )
    if has_snake_case:
        return value[snake_case]
    if has_camel_case:
        return value[camel_case]
    return fallback


def canonical_anchor_json(value: Any) -> str:
    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, int):
            if abs(item) > 9_007_199_254_740_991:
                raise DocumentAnchorContractError("Canonical JSON integer exceeds the safe range")
            return str(item)
        if isinstance(item, float):
            if not math.isfinite(item):
                raise DocumentAnchorContractError("Canonical JSON cannot contain a non-finite number")
            if item.is_integer():
                integer = int(item)
                if abs(integer) > 9_007_199_254_740_991:
                    raise DocumentAnchorContractError("Canonical JSON integer exceeds the safe range")
                return str(integer)
            if item < 0 or item > 1:
                raise DocumentAnchorContractError("Canonical decimal numbers must be normalized")
            return f"{item:.6f}".rstrip("0").rstrip(".")
        if isinstance(item, list):
            return "[" + ",".join(encode(child) for child in item) + "]"
        if isinstance(item, dict):
            if not all(isinstance(key, str) for key in item):
                raise DocumentAnchorContractError("Canonical JSON object keys must be strings")
            return "{" + ",".join(
                f"{json.dumps(key, ensure_ascii=False)}:{encode(item[key])}" for key in sorted(item)
            ) + "}"
        raise DocumentAnchorContractError("Canonical JSON contains an unsupported value")

    return encode(value)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_representation(value: Any) -> dict:
    source = _plain_object(value, "Representation")
    identifier = source.get("id")
    kind = source.get("kind")
    media_type = _aliased_field(source, "media_type", "mediaType", "")
    content_sha256 = _aliased_field(source, "content_sha256", "contentSha256")
    if not isinstance(identifier, str) or not UUID.fullmatch(identifier):
        raise DocumentAnchorContractError("Representation id must be a UUID")
    if kind not in {"original", "document-structure", "markdown", "text"}:
        raise DocumentAnchorContractError("Representation kind cannot be anchored")
    if not isinstance(media_type, str) or len(media_type) > 200:
        raise DocumentAnchorContractError("Representation media type is invalid")
    if not isinstance(content_sha256, str) or not SHA256.fullmatch(content_sha256):
        raise DocumentAnchorContractError("Representation content SHA-256 is invalid")
    return {
        "id": identifier.lower(),
        "kind": kind,
        "mediaType": media_type.lower().split(";", 1)[0].strip(),
        "contentSha256": content_sha256,
        "content": source.get("content"),
        "pageCount": _aliased_field(source, "page_count", "pageCount"),
    }


def is_document_anchor_text_media_type(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    media_type = value.lower().split(";", 1)[0].strip()
    if MEDIA_TYPE.fullmatch(media_type) is None:
        return False
    return media_type.startswith("text/") or media_type in {"application/json", "application/xml"}


def _bounded_string(value: Any, label: str, maximum: int, required: bool = False) -> Any:
    if value is None and not required:
        return None
    try:
        valid_utf8 = isinstance(value, str) and value.encode("utf-8") is not None
    except UnicodeEncodeError:
        valid_utf8 = False
    if not valid_utf8 or (required and not value) or len(value) > maximum:
        raise DocumentAnchorContractError(f"{label} is invalid or exceeds {maximum} characters")
    return value


def _page_number(value: Any, representation: dict, label: str = "Selector page") -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise DocumentAnchorContractError(f"{label} must be a 1-based page number")
    page_count = representation["pageCount"]
    if representation["kind"] == "document-structure":
        structure = _plain_object(representation["content"], "Document structure")
        if structure.get("schemaId") != "gb.document-structure.v1" or not isinstance(structure.get("pages"), list):
            raise DocumentAnchorContractError("Document structure content is invalid")
        page_count = len(structure["pages"])
    if page_count is None:
        raise DocumentAnchorContractError(f"{label} requires representation page metadata")
    if (
        not isinstance(page_count, int) or isinstance(page_count, bool) or page_count < 1 or value > page_count
    ):
        raise DocumentAnchorContractError(f"{label} is outside the representation page range")
    return value


def _page_region(selector: dict, representation: dict) -> dict:
    if representation["kind"] != "document-structure":
        raise DocumentAnchorContractError(
            "Page-region selectors require a page-aware document structure representation"
        )
    if selector.get("coordinateSpace") != "normalized-page":
        raise DocumentAnchorContractError("Page-region coordinateSpace must be normalized-page")
    polygon = selector.get("polygon")
    if not isinstance(polygon, list) or len(polygon) < 8 or len(polygon) > 128 or len(polygon) % 2:
        raise DocumentAnchorContractError("Page-region polygon must contain 4 to 64 coordinate pairs")
    normalized_polygon = []
    for coordinate in polygon:
        if (
            not isinstance(coordinate, (int, float)) or isinstance(coordinate, bool)
            or not math.isfinite(coordinate) or coordinate < 0 or coordinate > 1
        ):
            raise DocumentAnchorContractError("Page-region polygon coordinates must be finite normalized numbers")
        numeric = math.floor((float(coordinate) * 1_000_000) + 0.5) / 1_000_000
        normalized_polygon.append(int(numeric) if numeric.is_integer() else numeric)
    twice_area = 0.0
    for index in range(0, len(normalized_polygon), 2):
        next_index = (index + 2) % len(normalized_polygon)
        twice_area += (
            normalized_polygon[index] * normalized_polygon[next_index + 1]
            - normalized_polygon[next_index] * normalized_polygon[index + 1]
        )
    if abs(twice_area) <= math.ulp(1.0):
        raise DocumentAnchorContractError("Page-region polygon must enclose a non-zero area")
    normalized = {
        "kind": "page-region",
        "page": _page_number(selector.get("page"), representation),
        "coordinateSpace": "normalized-page",
        "polygon": normalized_polygon,
    }
    if "quoteHash" in selector:
        quote_hash = selector["quoteHash"]
        if not isinstance(quote_hash, str) or not SHA256.fullmatch(quote_hash):
            raise DocumentAnchorContractError("Page-region quoteHash must be a lowercase SHA-256 digest")
        normalized["quoteHash"] = quote_hash
    return normalized


def _text_quote(selector: dict, representation: dict) -> dict:
    is_derived_text = representation["kind"] in {"markdown", "text"}
    is_textual_original = (
        representation["kind"] == "original"
        and is_document_anchor_text_media_type(representation["mediaType"])
    )
    if (not is_derived_text and not is_textual_original) or not isinstance(representation["content"], str):
        raise DocumentAnchorContractError(
            "Text-quote selectors require a flat text representation or textual original"
        )
    for optional in ("prefix", "suffix"):
        if optional in selector and not isinstance(selector[optional], str):
            raise DocumentAnchorContractError(f"Text-quote {optional} must be a string when present")
    exact = _bounded_string(selector.get("exact"), "Text-quote exact", MAX_TEXT_QUOTE_CHARS, True)
    prefix = _bounded_string(selector.get("prefix"), "Text-quote prefix", MAX_TEXT_CONTEXT_CHARS)
    suffix = _bounded_string(selector.get("suffix"), "Text-quote suffix", MAX_TEXT_CONTEXT_CHARS)
    content = representation["content"]
    needle = f"{prefix or ''}{exact}{suffix or ''}"
    first_match = content.find(needle)
    if first_match < 0:
        raise DocumentAnchorContractError("Text-quote selector does not identify content in the representation")
    if content.find(needle, first_match + 1) >= 0:
        raise DocumentAnchorContractError("Text-quote selector is ambiguous in the representation")
    normalized = {"kind": "text-quote", "exact": exact}
    if prefix is not None:
        normalized["prefix"] = prefix
    if suffix is not None:
        normalized["suffix"] = suffix
    if "page" in selector:
        if representation["pageCount"] is None:
            raise DocumentAnchorContractError("Text-quote page requires representation page metadata")
        normalized["page"] = _page_number(selector["page"], representation)
    return normalized


def _json_pointer(selector: dict, representation: dict) -> dict:
    if representation["kind"] != "document-structure":
        raise DocumentAnchorContractError("JSON-pointer selectors require a document structure representation")
    structure = _plain_object(representation["content"], "Document structure")
    blocks = structure.get("blocks")
    if structure.get("schemaId") != "gb.document-structure.v1" or not isinstance(blocks, list):
        raise DocumentAnchorContractError("Document structure content is invalid")
    pointer = _bounded_string(selector.get("pointer"), "JSON pointer", 128, True)
    match = re.fullmatch(r"/blocks/(0|[1-9]\d*)", pointer)
    if match is None or int(match.group(1)) >= len(blocks):
        raise DocumentAnchorContractError("JSON pointer must identify an existing /blocks/<index> item")
    return {"kind": "json-pointer", "pointer": pointer}


def normalize_document_anchor_selector(selector_value: Any, representation_value: Any) -> dict:
    selector = _plain_object(selector_value, "Anchor selector")
    representation = _normalize_representation(representation_value)
    kind = selector.get("kind")
    permitted = SELECTOR_KEYS.get(kind)
    if permitted is None:
        raise DocumentAnchorContractError("Anchor selector kind is unsupported")
    unknown = sorted(set(selector) - permitted)
    if unknown:
        raise DocumentAnchorContractError(f"Anchor selector has unknown fields: {', '.join(unknown)}")
    if kind == "page-region":
        normalized = _page_region(selector, representation)
    elif kind == "text-quote":
        normalized = _text_quote(selector, representation)
    else:
        normalized = _json_pointer(selector, representation)
    if len(canonical_anchor_json(normalized).encode("utf-8")) > MAX_ANCHOR_SELECTOR_BYTES:
        raise DocumentAnchorContractError("Anchor selector exceeds 32768 UTF-8 bytes")
    return normalized


def _anchor_identity(representation: dict, selector: dict) -> dict:
    return {
        "representationId": representation["id"],
        "representationSha256": representation["contentSha256"],
        "selector": selector,
    }


def create_document_anchor(representation_value: Any, selector_value: Any) -> dict:
    representation = _normalize_representation(representation_value)
    selector = normalize_document_anchor_selector(selector_value, representation_value)
    selector_sha256 = _sha256(canonical_anchor_json(selector))
    anchor_sha256 = _sha256(canonical_anchor_json(_anchor_identity(representation, selector)))
    return {
        "schemaId": DOCUMENT_ANCHOR_SCHEMA_ID,
        "id": f"sha256:{anchor_sha256}",
        "representationId": representation["id"],
        "representationSha256": representation["contentSha256"],
        "selector": selector,
        "selectorSha256": selector_sha256,
        "anchorSha256": anchor_sha256,
    }


def document_anchor_request_hash(representation_value: Any, selector_value: Any) -> str:
    representation = _normalize_representation(representation_value)
    selector = normalize_document_anchor_selector(selector_value, representation_value)
    request = {
        "schemaId": "gb.anchor.create.v1",
        **_anchor_identity(representation, selector),
    }
    return _sha256(canonical_anchor_json(request))
