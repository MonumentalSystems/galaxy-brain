"""Pure structure and adapter-output binding for immutable proof verification sets.

Parsing preserves exact provider receipt bytes and never authenticates them. A
registry must dispatch each non-empty item to an allowlisted, versioned verifier
adapter, then pass that trusted adapter output to ``bind_verifier_adapter_evidence``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol


PROOF_VERIFICATION_SET_SCHEMA = "galaxy.proof-verification-set.v1"
MAX_PROOF_VERIFICATION_SET_BYTES = 16_777_216
MAX_VERIFICATION_ITEMS = 10_000
MAX_RECEIPT_BYTES = 1_048_576
MAX_TOTAL_RECEIPT_BYTES = 10_485_760

IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$")
ADAPTER_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
ADAPTER_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
BASE64 = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")
MEDIA_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")
VERIFIER_METHODS = {
    "hyades": "hyades-run",
    "lean-replay": "lean-replay",
    "proofs-blah-dev": "signed-report",
}


class ProofVerificationSetError(ValueError):
    """The set structure or trusted adapter output violates the contract."""


@dataclass(frozen=True)
class ProofVerificationItem:
    """An unverified node binding plus exact opaque receipt bytes."""

    node_id: str
    candidate_sha256: str
    adapter_id: str
    adapter_version: str
    receipt_media_type: str
    receipt_bytes: bytes
    receipt_sha256: str


@dataclass(frozen=True)
class ProofVerificationSetRegistration:
    """Canonical structure only; verifier adapters establish authenticity."""

    content_bytes: bytes
    content_sha256: str
    artifact: dict[str, Any]
    graph_id: str
    graph_content_sha256: str
    items: tuple[ProofVerificationItem, ...]


@dataclass(frozen=True)
class VerifierAdapterEvidence:
    """Claims returned by a trusted adapter after authenticating/replaying bytes."""

    adapter_id: str
    adapter_version: str
    receipt_sha256: str
    outcome: str
    solution_sha256: str
    sorry_free: bool
    verifier_system: str
    method: str
    subject_graph_id: str
    subject_graph_content_sha256: str
    subject_node_id: str
    subject_declaration_ids: tuple[str, ...]
    source_repository: str
    source_commit: str
    lean_toolchain: str
    mathlib_revision: str
    verified_at: str
    hyades: dict[str, str] | None
    safe_for_storage: bool


@dataclass(frozen=True)
class ExpectedProofSubject:
    """Proof subject derived by the server from one exact registered graph target."""

    graph_id: str
    graph_content_sha256: str
    node_id: str
    declaration_ids: tuple[str, ...]
    source_repository: str
    source_commit: str
    lean_toolchain: str
    mathlib_revision: str


@dataclass(frozen=True)
class VerifierAdapterRequest:
    """Exact immutable context supplied to one server-owned verifier adapter."""

    adapter_id: str
    adapter_version: str
    receipt_media_type: str
    receipt_bytes: bytes
    receipt_sha256: str
    graph_id: str
    graph_content_sha256: str
    node_id: str
    candidate_sha256: str
    expected_subject: ExpectedProofSubject


class ProofReceiptVerifierAdapter(Protocol):
    """A server-owned adapter that authenticates or replays one exact receipt."""

    def __call__(self, request: VerifierAdapterRequest) -> VerifierAdapterEvidence: ...


@dataclass(frozen=True)
class BoundProofVerification:
    """Validated binding of trusted adapter evidence to one exact set item."""

    node_id: str
    candidate_sha256: str
    receipt_sha256: str
    adapter_id: str
    adapter_version: str
    verifier_system: str
    method: str
    subject_declaration_ids: tuple[str, ...]
    source_repository: str
    source_commit: str
    lean_toolchain: str
    mathlib_revision: str
    verified_at: str
    hyades: dict[str, str] | None


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProofVerificationSetError(f"{label} must be an object")
    return value


def _exact_object(
    value: Any,
    label: str,
    allowed: set[str],
    *,
    required: set[str] | None = None,
) -> dict[str, Any]:
    result = _object(value, label)
    unknown = sorted(set(result) - allowed)
    if unknown:
        raise ProofVerificationSetError(f"{label} contains unknown field {unknown[0]}")
    missing = sorted((required or set()) - set(result))
    if missing:
        raise ProofVerificationSetError(f"{label}.{missing[0]} is required")
    return result


def _text(value: Any, label: str, maximum: int, *, required: bool = False) -> str:
    if value is None:
        if required:
            raise ProofVerificationSetError(f"{label} is required")
        return ""
    if not isinstance(value, str):
        raise ProofVerificationSetError(f"{label} must be text")
    normalized = value.strip()
    if required and not normalized:
        raise ProofVerificationSetError(f"{label} is required")
    try:
        utf16_length = len(normalized.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise ProofVerificationSetError(f"{label} contains an unpaired surrogate") from error
    if utf16_length > maximum:
        raise ProofVerificationSetError(f"{label} exceeds {maximum} characters")
    return normalized


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ProofVerificationSetError(f"{label} is invalid")
    return value


def _adapter_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not ADAPTER_ID.fullmatch(value):
        raise ProofVerificationSetError(f"{label} is invalid")
    return value


def _adapter_version(value: Any, label: str) -> str:
    if not isinstance(value, str) or not ADAPTER_VERSION.fullmatch(value):
        raise ProofVerificationSetError(f"{label} is invalid")
    return value


def _sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ProofVerificationSetError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _git_oid(value: Any, label: str) -> str:
    if not isinstance(value, str) or not GIT_OID.fullmatch(value):
        raise ProofVerificationSetError(f"{label} must be a lowercase Git object ID")
    return value


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ProofVerificationSetError(f"{label} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProofVerificationSetError(f"{label} must be an ISO timestamp") from error
    if parsed.tzinfo is None:
        raise ProofVerificationSetError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProofVerificationSetError("Duplicate JSON fields are not allowed")
        result[key] = value
    return result


def _reject_non_json_number(value: str):
    raise ProofVerificationSetError(f"Non-finite JSON number {value} is not allowed")


def _load_json(content: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            content.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
        )
    except ProofVerificationSetError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProofVerificationSetError(f"{label} must be valid UTF-8 JSON") from error
    return _object(value, label)


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProofVerificationSetError("Verification set contains an unpaired surrogate") from error


def _decode_receipt(value: Any, label: str) -> tuple[dict[str, Any], bytes, str]:
    receipt = _exact_object(
        value,
        label,
        {
            "adapter_id",
            "adapter_version",
            "media_type",
            "content_encoding",
            "content_sha256",
            "content_base64",
        },
        required={
            "adapter_id",
            "adapter_version",
            "media_type",
            "content_encoding",
            "content_sha256",
            "content_base64",
        },
    )
    adapter_id = _adapter_id(receipt["adapter_id"], f"{label}.adapter_id")
    adapter_version = _adapter_version(
        receipt["adapter_version"], f"{label}.adapter_version"
    )
    media_type = _text(receipt["media_type"], f"{label}.media_type", 200, required=True)
    if not MEDIA_TYPE.fullmatch(media_type):
        raise ProofVerificationSetError(f"{label}.media_type is invalid")
    if receipt["content_encoding"] != "base64":
        raise ProofVerificationSetError(f"{label}.content_encoding must be base64")
    encoded = receipt["content_base64"]
    if not isinstance(encoded, str) or not BASE64.fullmatch(encoded):
        raise ProofVerificationSetError(f"{label}.content_base64 must be canonical base64")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProofVerificationSetError(
            f"{label}.content_base64 must be canonical base64"
        ) from error
    if base64.b64encode(content).decode("ascii") != encoded:
        raise ProofVerificationSetError(f"{label}.content_base64 must be canonical base64")
    if not 1 <= len(content) <= MAX_RECEIPT_BYTES:
        raise ProofVerificationSetError(
            f"{label} bytes must contain 1 byte to {MAX_RECEIPT_BYTES} bytes"
        )
    digest = hashlib.sha256(content).hexdigest()
    if _sha256(receipt["content_sha256"], f"{label}.content_sha256") != digest:
        raise ProofVerificationSetError(
            f"{label}.content_sha256 does not match the exact receipt bytes"
        )
    return ({
        "adapter_id": adapter_id,
        "adapter_version": adapter_version,
        "media_type": media_type,
        "content_encoding": "base64",
        "content_sha256": digest,
        "content_base64": encoded,
    }, content, digest)


def parse_proof_verification_set_bytes(
    content_bytes: bytes,
    *,
    expected_graph_id: str | None = None,
    expected_graph_sha256: str | None = None,
) -> ProofVerificationSetRegistration:
    """Decode/hash-bind exact bytes; this function does not verify a receipt."""
    if not isinstance(content_bytes, bytes):
        raise ProofVerificationSetError("Proof verification set content must be bytes")
    if not 1 <= len(content_bytes) <= MAX_PROOF_VERIFICATION_SET_BYTES:
        raise ProofVerificationSetError("Proof verification set must contain 1 byte to 16 MiB")
    source = _exact_object(
        _load_json(content_bytes, "Proof verification set"),
        "Proof verification set",
        {"schema_id", "graph_ref", "items"},
        required={"schema_id", "graph_ref", "items"},
    )
    if source["schema_id"] != PROOF_VERIFICATION_SET_SCHEMA:
        raise ProofVerificationSetError(
            f"Proof verification set must use {PROOF_VERIFICATION_SET_SCHEMA}"
        )
    graph_ref = _exact_object(
        source["graph_ref"],
        "Proof verification set graph_ref",
        {"graph_id", "content_sha256"},
        required={"graph_id", "content_sha256"},
    )
    graph_id = _identifier(graph_ref["graph_id"], "Proof verification set graph_ref.graph_id")
    graph_sha256 = _sha256(
        graph_ref["content_sha256"], "Proof verification set graph_ref.content_sha256"
    )
    if expected_graph_id is not None and graph_id != expected_graph_id:
        raise ProofVerificationSetError("Proof verification set graph_id does not match the graph")
    if expected_graph_sha256 is not None and graph_sha256 != expected_graph_sha256:
        raise ProofVerificationSetError(
            "Proof verification set content_sha256 does not match the graph"
        )

    source_items = source["items"]
    if not isinstance(source_items, list) or len(source_items) > MAX_VERIFICATION_ITEMS:
        raise ProofVerificationSetError(
            f"Proof verification set items must contain at most {MAX_VERIFICATION_ITEMS} entries"
        )
    normalized_items: list[dict[str, Any]] = []
    parsed_items: list[ProofVerificationItem] = []
    seen_nodes: set[str] = set()
    seen_receipt_sha256s: set[str] = set()
    total_receipt_bytes = 0
    for index, source_item in enumerate(source_items):
        label = f"Proof verification set item {index}"
        item = _exact_object(
            source_item,
            label,
            {"node_id", "candidate_sha256", "receipt"},
            required={"node_id", "candidate_sha256", "receipt"},
        )
        node_id = _identifier(item["node_id"], f"{label}.node_id")
        if node_id in seen_nodes:
            raise ProofVerificationSetError(f"Proof verification node {node_id} is duplicated")
        seen_nodes.add(node_id)
        candidate = _sha256(item["candidate_sha256"], f"{label}.candidate_sha256")
        normalized_receipt, receipt_bytes, receipt_sha256 = _decode_receipt(
            item["receipt"], f"{label}.receipt"
        )
        if receipt_sha256 in seen_receipt_sha256s:
            raise ProofVerificationSetError(
                f"Proof verification receipt {receipt_sha256} is duplicated"
            )
        seen_receipt_sha256s.add(receipt_sha256)
        total_receipt_bytes += len(receipt_bytes)
        if total_receipt_bytes > MAX_TOTAL_RECEIPT_BYTES:
            raise ProofVerificationSetError(
                "Proof verification set receipts exceed the 10 MiB aggregate limit"
            )
        normalized_items.append({
            "node_id": node_id,
            "candidate_sha256": candidate,
            "receipt": normalized_receipt,
        })
        parsed_items.append(ProofVerificationItem(
            node_id=node_id,
            candidate_sha256=candidate,
            adapter_id=normalized_receipt["adapter_id"],
            adapter_version=normalized_receipt["adapter_version"],
            receipt_media_type=normalized_receipt["media_type"],
            receipt_bytes=receipt_bytes,
            receipt_sha256=receipt_sha256,
        ))

    order = sorted(range(len(parsed_items)), key=lambda index: parsed_items[index].node_id)
    normalized_items = [normalized_items[index] for index in order]
    parsed_items = [parsed_items[index] for index in order]
    artifact = {
        "schema_id": PROOF_VERIFICATION_SET_SCHEMA,
        "graph_ref": {"graph_id": graph_id, "content_sha256": graph_sha256},
        "items": normalized_items,
    }
    canonical_bytes = _canonical_json(artifact)
    if len(canonical_bytes) > MAX_PROOF_VERIFICATION_SET_BYTES:
        raise ProofVerificationSetError("Canonical proof verification set exceeds 16 MiB")
    return ProofVerificationSetRegistration(
        content_bytes=canonical_bytes,
        content_sha256=hashlib.sha256(canonical_bytes).hexdigest(),
        artifact=artifact,
        graph_id=graph_id,
        graph_content_sha256=graph_sha256,
        items=tuple(parsed_items),
    )


def bind_verifier_adapter_evidence(
    registration: ProofVerificationSetRegistration,
    item: ProofVerificationItem,
    expected_subject: ExpectedProofSubject,
    evidence: VerifierAdapterEvidence,
) -> BoundProofVerification:
    """Bind already-authenticated/replayed adapter output to exact graph/item bytes.

    This consistency check does not authenticate a receipt and must only receive
    evidence constructed by an allowlisted server adapter.
    """
    expected_subject = _validate_expected_subject(
        registration, item, expected_subject
    )
    declaration_ids = expected_subject.declaration_ids
    repository = expected_subject.source_repository
    source_commit = expected_subject.source_commit
    lean_toolchain = expected_subject.lean_toolchain
    mathlib_revision = expected_subject.mathlib_revision

    if evidence.adapter_id != item.adapter_id or evidence.adapter_version != item.adapter_version:
        raise ProofVerificationSetError("Verifier adapter output does not match the requested adapter")
    if evidence.receipt_sha256 != item.receipt_sha256:
        raise ProofVerificationSetError("Verifier adapter output does not match the exact receipt bytes")
    if evidence.subject_graph_id != registration.graph_id:
        raise ProofVerificationSetError("Verifier subject graph_id does not match the set")
    if evidence.subject_graph_content_sha256 != registration.graph_content_sha256:
        raise ProofVerificationSetError("Verifier subject graph digest does not match the set")
    if evidence.subject_node_id != item.node_id:
        raise ProofVerificationSetError("Verifier subject node does not match the set item")
    if evidence.subject_declaration_ids != declaration_ids:
        raise ProofVerificationSetError(
            "Verifier subject declarations do not match the graph target"
        )
    if (
        evidence.source_repository != repository
        or evidence.source_commit != source_commit
        or evidence.lean_toolchain != lean_toolchain
        or evidence.mathlib_revision != mathlib_revision
    ):
        raise ProofVerificationSetError(
            "Verifier provenance does not match the graph target"
        )
    verified_at = _timestamp(evidence.verified_at, "Verifier verified_at")
    if evidence.outcome != "accepted" or evidence.sorry_free is not True:
        raise ProofVerificationSetError("Baseline evidence must be accepted and sorry-free")
    if evidence.solution_sha256 != item.candidate_sha256:
        raise ProofVerificationSetError(
            "Proof candidate_sha256 does not match the adapter-derived solution_sha256"
        )
    if VERIFIER_METHODS.get(evidence.verifier_system) != evidence.method:
        raise ProofVerificationSetError("Verifier system and method are not supported")
    if evidence.safe_for_storage is not True:
        raise ProofVerificationSetError(
            "Verifier adapter did not establish that receipt bytes exclude credentials and raw logs"
        )

    hyades: dict[str, str] | None = None
    if evidence.method == "hyades-run":
        source = _exact_object(
            evidence.hyades,
            "Verifier Hyades run",
            {"workflow_id", "run_id", "status"},
            required={"workflow_id", "run_id", "status"},
        )
        if source["status"] != "completed":
            raise ProofVerificationSetError("Accepted Hyades evidence requires a completed run")
        hyades = {
            "workflow_id": _text(
                source["workflow_id"], "Verifier Hyades workflow_id", 200, required=True
            ),
            "run_id": _text(source["run_id"], "Verifier Hyades run_id", 200, required=True),
            "status": "completed",
        }
    elif evidence.hyades is not None:
        raise ProofVerificationSetError(
            f"{evidence.method} evidence cannot claim a Hyades run"
        )

    return BoundProofVerification(
        node_id=item.node_id,
        candidate_sha256=item.candidate_sha256,
        receipt_sha256=item.receipt_sha256,
        adapter_id=item.adapter_id,
        adapter_version=item.adapter_version,
        verifier_system=evidence.verifier_system,
        method=evidence.method,
        subject_declaration_ids=declaration_ids,
        source_repository=repository,
        source_commit=source_commit,
        lean_toolchain=lean_toolchain,
        mathlib_revision=mathlib_revision,
        verified_at=verified_at,
        hyades=hyades,
    )


def _validate_expected_subject(
    registration: ProofVerificationSetRegistration,
    item: ProofVerificationItem,
    expected_subject: ExpectedProofSubject,
) -> ExpectedProofSubject:
    """Validate and normalize every field before provider code can observe it."""
    if item not in registration.items:
        raise ProofVerificationSetError("Proof verification item is absent from the set")
    if (
        expected_subject.graph_id != registration.graph_id
        or expected_subject.graph_content_sha256 != registration.graph_content_sha256
        or expected_subject.node_id != item.node_id
    ):
        raise ProofVerificationSetError(
            "Expected proof subject does not match the exact graph item"
        )
    if not isinstance(expected_subject.declaration_ids, tuple):
        raise ProofVerificationSetError(
            "Expected proof subject declaration_ids must be a tuple"
        )
    declaration_ids = tuple(
        _text(value, "Expected proof subject declaration_id", 512, required=True)
        for value in expected_subject.declaration_ids
    )
    if (
        not declaration_ids
        or len(declaration_ids) > 128
        or len(set(declaration_ids)) != len(declaration_ids)
    ):
        raise ProofVerificationSetError(
            "Expected proof subject requires 1 to 128 unique declaration IDs"
        )
    repository = _text(
        expected_subject.source_repository,
        "Expected proof subject source_repository",
        512,
        required=True,
    )
    source_commit = _git_oid(
        expected_subject.source_commit, "Expected proof subject source_commit"
    )
    lean_toolchain = _text(
        expected_subject.lean_toolchain,
        "Expected proof subject lean_toolchain",
        200,
        required=True,
    )
    mathlib_revision = _git_oid(
        expected_subject.mathlib_revision,
        "Expected proof subject mathlib_revision",
    )
    return ExpectedProofSubject(
        graph_id=expected_subject.graph_id,
        graph_content_sha256=expected_subject.graph_content_sha256,
        node_id=expected_subject.node_id,
        declaration_ids=declaration_ids,
        source_repository=repository,
        source_commit=source_commit,
        lean_toolchain=lean_toolchain,
        mathlib_revision=mathlib_revision,
    )


def run_verifier_adapter(
    registration: ProofVerificationSetRegistration,
    item: ProofVerificationItem,
    expected_subject: ExpectedProofSubject,
    adapter: ProofReceiptVerifierAdapter,
) -> BoundProofVerification:
    """Invoke one selected callable and bind its typed output, or fail closed."""
    expected_subject = _validate_expected_subject(
        registration, item, expected_subject
    )
    if not callable(adapter):
        raise ProofVerificationSetError("Proof receipt verifier adapter is unavailable")
    request = VerifierAdapterRequest(
        adapter_id=item.adapter_id,
        adapter_version=item.adapter_version,
        receipt_media_type=item.receipt_media_type,
        receipt_bytes=item.receipt_bytes,
        receipt_sha256=item.receipt_sha256,
        graph_id=registration.graph_id,
        graph_content_sha256=registration.graph_content_sha256,
        node_id=item.node_id,
        candidate_sha256=item.candidate_sha256,
        expected_subject=expected_subject,
    )
    evidence = adapter(request)
    if not isinstance(evidence, VerifierAdapterEvidence):
        raise ProofVerificationSetError(
            "Proof receipt verifier adapter returned unsupported evidence"
        )
    return bind_verifier_adapter_evidence(
        registration, item, expected_subject, evidence
    )
