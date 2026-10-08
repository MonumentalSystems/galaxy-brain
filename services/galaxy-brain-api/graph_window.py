"""Bounded, tenant-scoped graph-window request and cursor contracts.

The corpus view is an aggregate read model.  It never turns an aggregate into
a Galaxy object reference and it never requires the browser to materialize the
tenant catalog.  Member pages contain exact, pinned references only.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Mapping

from object_links import ObjectLinkError, parse_canonical_reference


REQUEST_SCHEMA = "gb.graph-window-request.v1"
RESPONSE_SCHEMA = "gb.graph-window.v1"
MAX_REQUEST_BYTES = 32_768
MAX_MEMBERS = 200
CURSOR_TTL_SECONDS = 900
CURSOR_VERSION = "gw1"
WORKSPACE_ID = "tenant-catalog"
SUPPORTED_MODES = frozenset({"mixed"})
SUPPORTED_KINDS = frozenset({"document", "paper", "eln.experiment", "surface"})
SUPPORTED_RELATIONS = frozenset({"related", "cites", "part_of", "derived_from", "context_for"})
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_CLUSTER_ID = re.compile(r"^gwc:[0-9a-f]{64}$")
_CURSOR = re.compile(r"^[A-Za-z0-9_.-]{1,8192}$")


class GraphWindowError(ValueError):
    def __init__(self, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ClusterSpec:
    provider: str
    kind: str
    label: str
    expandable: bool
    x: int
    y: int
    width: int = 240
    height: int = 150


CLUSTER_SPECS = (
    ClusterSpec("galaxy.document", "document", "Documents", True, -390, -115),
    ClusterSpec("galaxy.paper", "paper", "Papers", True, -120, 135),
    ClusterSpec("galaxy.eln", "eln.experiment", "Experiments", False, 150, -95),
    ClusterSpec("galaxy.surface", "surface", "Surfaces", True, 405, 140),
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _text(value: Any, field: str, maximum: int) -> str:
    if not isinstance(value, str) or value != value.strip() or not value or _CONTROL.search(value):
        raise GraphWindowError(f"{field} must be bounded text")
    if len(value.encode("utf-8")) > maximum:
        raise GraphWindowError(f"{field} exceeds its byte limit")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise GraphWindowError("Graph window request contains duplicate fields")
        result[key] = value
    return result


def _bounded_set(value: Any, field: str, supported: frozenset[str]) -> list[str]:
    if not isinstance(value, list) or len(value) > len(supported):
        raise GraphWindowError(f"{field} must be a bounded array")
    result = [_text(item, f"{field}[]", 80) for item in value]
    if len(result) != len(set(result)) or any(item not in supported for item in result):
        raise GraphWindowError(f"{field} contains an unsupported or duplicate value")
    return sorted(result)


def _viewport(value: Any) -> dict[str, float] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}:
        raise GraphWindowError("viewport must contain x, y, width, and height")
    result: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        number = value[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)):
            raise GraphWindowError(f"viewport.{key} must be finite")
        number = float(number)
        if not -1_000_000 <= number <= 1_000_000:
            raise GraphWindowError(f"viewport.{key} is outside the supported field")
        result[key] = number
    if result["width"] <= 0 or result["height"] <= 0:
        raise GraphWindowError("viewport dimensions must be positive")
    return result


def parse_request(encoded: bytes) -> dict[str, Any]:
    if not isinstance(encoded, bytes) or not encoded:
        raise GraphWindowError("Graph window request must be UTF-8 JSON")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise GraphWindowError("Graph window request is too large", status_code=413)
    try:
        value = json.loads(encoded.decode("utf-8", "strict"), object_pairs_hook=_unique_object)
    except GraphWindowError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise GraphWindowError("Graph window request must be UTF-8 JSON") from error
    expected = {
        "schemaId", "workspaceId", "mode", "lens", "scale", "viewport",
        "filters", "rootRef", "expandClusterId", "cursor",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise GraphWindowError("Graph window request fields are invalid")
    if value["schemaId"] != REQUEST_SCHEMA:
        raise GraphWindowError("Graph window request schema is unsupported")
    workspace_id = _text(value["workspaceId"], "workspaceId", 128)
    if workspace_id != WORKSPACE_ID:
        raise GraphWindowError("Graph window workspace is unsupported")
    mode = _text(value["mode"], "mode", 32)
    if mode not in SUPPORTED_MODES:
        raise GraphWindowError("Graph window mode is unsupported")
    if value["lens"] != "explore" or value["scale"] != "corpus":
        raise GraphWindowError("This graph window only supports the corpus explore view")
    filters = value["filters"]
    if not isinstance(filters, dict) or set(filters) != {"kinds", "relations"}:
        raise GraphWindowError("Graph window filters are invalid")
    kinds = _bounded_set(filters["kinds"], "filters.kinds", SUPPORTED_KINDS)
    relations = _bounded_set(filters["relations"], "filters.relations", SUPPORTED_RELATIONS)
    root_ref = value["rootRef"]
    if root_ref is not None:
        try:
            parsed = parse_canonical_reference(root_ref)
        except ObjectLinkError as error:
            raise GraphWindowError("rootRef must be a canonical Galaxy reference") from error
        if parsed.wire != root_ref:
            raise GraphWindowError("rootRef must use canonical encoding")
        root_ref = parsed.wire
    cluster_id = value["expandClusterId"]
    if cluster_id is not None and (not isinstance(cluster_id, str) or not _CLUSTER_ID.fullmatch(cluster_id)):
        raise GraphWindowError("expandClusterId is invalid")
    cursor = value["cursor"]
    if cursor is not None and (not isinstance(cursor, str) or not _CURSOR.fullmatch(cursor)):
        raise GraphWindowError("cursor is invalid")
    if cursor is not None and cluster_id is None:
        raise GraphWindowError("cursor requires an expanded cluster")
    return {
        "schemaId": REQUEST_SCHEMA,
        "workspaceId": workspace_id,
        "mode": mode,
        "lens": "explore",
        "scale": "corpus",
        "viewport": _viewport(value["viewport"]),
        "filters": {"kinds": kinds, "relations": relations},
        "rootRef": root_ref,
        "expandClusterId": cluster_id,
        "cursor": cursor,
    }


def cluster_id(spec: ClusterSpec, tenant_id: str, workspace_id: str = WORKSPACE_ID) -> str:
    material = {
        "schemaId": RESPONSE_SCHEMA,
        "tenantId": tenant_id,
        "workspaceId": workspace_id,
        "provider": spec.provider,
        "kind": spec.kind,
    }
    return f"gwc:{hashlib.sha256(canonical_json(material).encode('utf-8')).hexdigest()}"


def cluster_for_id(value: str, *, tenant_id: str, workspace_id: str) -> ClusterSpec | None:
    return next((spec for spec in CLUSTER_SPECS if cluster_id(spec, tenant_id, workspace_id) == value), None)


def cluster_intersects(spec: ClusterSpec, viewport: Mapping[str, float] | None) -> bool:
    if viewport is None:
        return True
    left, top = spec.x - spec.width / 2, spec.y - spec.height / 2
    right, bottom = left + spec.width, top + spec.height
    view_right = viewport["x"] + viewport["width"]
    view_bottom = viewport["y"] + viewport["height"]
    return not (right < viewport["x"] or left > view_right or bottom < viewport["y"] or top > view_bottom)


def request_fingerprint(request: Mapping[str, Any]) -> str:
    bound = {key: value for key, value in request.items() if key != "cursor"}
    return hashlib.sha256(canonical_json(bound).encode("utf-8")).hexdigest()


def encode_cursor(
    *, secret: str, tenant_id: str, principal_id: str, request: Mapping[str, Any],
    updated_at: str, member_id: str, now: int | None = None,
) -> str:
    if not secret:
        raise GraphWindowError("Graph window cursor signing is unavailable", status_code=503)
    payload = {
        "v": CURSOR_VERSION,
        "tenant": tenant_id,
        "principal": principal_id,
        "request": request_fingerprint(request),
        "updatedAt": updated_at,
        "memberId": member_id,
        "issuedAt": int(time.time() if now is None else now),
    }
    encoded = base64.urlsafe_b64encode(canonical_json(payload).encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    return f"{encoded}.{encoded_signature}"


def decode_cursor(
    value: str, *, secret: str, tenant_id: str, principal_id: str,
    request: Mapping[str, Any], now: int | None = None,
) -> dict[str, str]:
    if not secret:
        raise GraphWindowError("Graph window cursor signing is unavailable", status_code=503)
    try:
        encoded, encoded_signature = value.split(".", 1)
        signature = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        expected = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise GraphWindowError("Graph window cursor is invalid")
        payload = json.loads(
            base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8", "strict")
        )
    except GraphWindowError:
        raise
    except (ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise GraphWindowError("Graph window cursor is invalid") from error
    expected_keys = {"v", "tenant", "principal", "request", "updatedAt", "memberId", "issuedAt"}
    if not isinstance(payload, dict) or set(payload) != expected_keys:
        raise GraphWindowError("Graph window cursor is invalid")
    current = int(time.time() if now is None else now)
    issued_at = payload["issuedAt"]
    if isinstance(issued_at, bool) or not isinstance(issued_at, int) or issued_at > current + 30:
        raise GraphWindowError("Graph window cursor is invalid")
    if current - issued_at > CURSOR_TTL_SECONDS:
        raise GraphWindowError("Graph window cursor expired", status_code=409)
    if (
        payload["v"] != CURSOR_VERSION
        or payload["tenant"] != tenant_id
        or payload["principal"] != principal_id
        or payload["request"] != request_fingerprint(request)
    ):
        raise GraphWindowError("Graph window cursor does not belong to this query")
    return {
        "updatedAt": _text(payload["updatedAt"], "cursor.updatedAt", 80),
        "memberId": _text(payload["memberId"], "cursor.memberId", 80),
    }
