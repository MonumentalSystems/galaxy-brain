"""Pure trust boundary for one live proof-verification request.

The public request contains only opaque candidate/receipt material and an exact
registered graph subject.  It cannot contain an outcome, verifier identity,
solution digest, proof status, or any other authoritative verification fact.
Those facts may enter only through an allowlisted server-owned adapter and are
validated by :mod:`proof_verification_set` before a result is returned.

This module performs no persistence, networking, or work-state mutation.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Collection, Mapping

from proof_verification_set import (
    BoundProofVerification,
    ExpectedProofSubject,
    ProofReceiptVerifierAdapter,
    ProofVerificationItem,
    ProofVerificationSetError,
    ProofVerificationSetRegistration,
    parse_proof_verification_set_bytes,
    run_verifier_adapter,
)
from proof_work_state import ProofWorkStateError, idempotency_key


TRUSTED_PROOF_VERIFICATION_REQUEST_SCHEMA = (
    "galaxy.trusted-proof-verification-request.v1"
)
MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES = 2_097_152
HYADES_ADAPTER_ID = "hyades"
HYADES_ADAPTER_VERSION = "1"

SHA256 = re.compile(r"^[0-9a-f]{64}$")
ADAPTER_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
ADAPTER_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$")


class TrustedProofVerificationError(ValueError):
    """The request or selected trusted-verifier operation failed closed."""


@dataclass(frozen=True)
class TrustedProofVerificationRequest:
    """One exact, unverified client request plus its normalized set item.

    ``content_bytes`` and ``request_sha256`` bind the exact submitted bytes,
    including whitespace.  ``artifact`` and ``registration`` are normalized
    structural views used for deterministic validation and adapter execution.
    """

    content_bytes: bytes
    request_sha256: str
    artifact: dict[str, Any]
    registration: ProofVerificationSetRegistration
    item: ProofVerificationItem
    expected_workspace_version: int
    expected_item_version: int
    idempotency_key: str

    @property
    def adapter_key(self) -> tuple[str, str]:
        return (self.item.adapter_id, self.item.adapter_version)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TrustedProofVerificationError("Duplicate JSON fields are not allowed")
        result[key] = value
    return result


def _reject_non_json_number(value: str):
    raise TrustedProofVerificationError(
        f"Non-finite JSON number {value} is not allowed"
    )


def _load_json(content: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            content.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
        )
    except TrustedProofVerificationError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise TrustedProofVerificationError(
            "Trusted proof verification request must be valid UTF-8 JSON"
        ) from error
    if not isinstance(value, dict):
        raise TrustedProofVerificationError(
            "Trusted proof verification request must be an object"
        )
    return value


def _exact_object(
    value: Any,
    label: str,
    allowed: set[str],
    *,
    required: set[str],
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TrustedProofVerificationError(f"{label} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise TrustedProofVerificationError(
            f"{label} contains unknown field {unknown[0]}"
        )
    missing = sorted(required - set(value))
    if missing:
        raise TrustedProofVerificationError(f"{label}.{missing[0]} is required")
    return value


def _adapter_allowlist(
    allowed_adapters: Collection[tuple[str, str]],
) -> frozenset[tuple[str, str]]:
    if isinstance(allowed_adapters, (str, bytes)):
        raise TrustedProofVerificationError(
            "Trusted verifier adapter allowlist must contain id/version pairs"
        )
    try:
        values = tuple(allowed_adapters)
    except TypeError as error:
        raise TrustedProofVerificationError(
            "Trusted verifier adapter allowlist must contain id/version pairs"
        ) from error
    normalized: set[tuple[str, str]] = set()
    for value in values:
        if (
            not isinstance(value, tuple)
            or len(value) != 2
            or not isinstance(value[0], str)
            or not ADAPTER_ID.fullmatch(value[0])
            or not isinstance(value[1], str)
            or not ADAPTER_VERSION.fullmatch(value[1])
        ):
            raise TrustedProofVerificationError(
                "Trusted verifier adapter allowlist contains an invalid id/version pair"
            )
        normalized.add(value)
    return frozenset(normalized)


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
    except UnicodeEncodeError as error:
        raise TrustedProofVerificationError(
            "Trusted proof verification request contains an unpaired surrogate"
        ) from error


def parse_trusted_proof_verification_request_bytes(
    content_bytes: bytes,
    *,
    allowed_adapters: Collection[tuple[str, str]],
    expected_graph_id: str | None = None,
    expected_graph_sha256: str | None = None,
    expected_request_sha256: str | None = None,
) -> TrustedProofVerificationRequest:
    """Parse one bounded exact request and bind it to an adapter allowlist.

    The allowlist is supplied by trusted server code.  Selecting an allowlisted
    adapter does not make a receipt trustworthy; ``run_trusted_verifier_adapter``
    must still execute and validate that adapter.
    """
    if not isinstance(content_bytes, bytes):
        raise TrustedProofVerificationError(
            "Trusted proof verification request content must be bytes"
        )
    if not 1 <= len(content_bytes) <= MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES:
        raise TrustedProofVerificationError(
            "Trusted proof verification request must contain 1 byte to 2 MiB"
        )
    request_sha256 = hashlib.sha256(content_bytes).hexdigest()
    if expected_request_sha256 is not None:
        if (
            not isinstance(expected_request_sha256, str)
            or not SHA256.fullmatch(expected_request_sha256)
        ):
            raise TrustedProofVerificationError(
                "Expected request_sha256 must be a lowercase SHA-256 digest"
            )
        if request_sha256 != expected_request_sha256:
            raise TrustedProofVerificationError(
                "Trusted proof verification request bytes do not match request_sha256"
            )

    source = _exact_object(
        _load_json(content_bytes),
        "Trusted proof verification request",
        {
            "schema_id",
            "graph_ref",
            "node_id",
            "candidate_sha256",
            "receipt",
            "expected_workspace_version",
            "expected_item_version",
            "idempotency_key",
        },
        required={
            "schema_id",
            "graph_ref",
            "node_id",
            "candidate_sha256",
            "receipt",
            "expected_workspace_version",
            "expected_item_version",
            "idempotency_key",
        },
    )
    if source["schema_id"] != TRUSTED_PROOF_VERIFICATION_REQUEST_SCHEMA:
        raise TrustedProofVerificationError(
            "Trusted proof verification request must use "
            f"{TRUSTED_PROOF_VERIFICATION_REQUEST_SCHEMA}"
        )
    expected_workspace_version = source["expected_workspace_version"]
    if (
        not isinstance(expected_workspace_version, int)
        or isinstance(expected_workspace_version, bool)
        or expected_workspace_version < 1
    ):
        raise TrustedProofVerificationError(
            "expected_workspace_version must be a positive integer"
        )
    expected_item_version = source["expected_item_version"]
    if (
        not isinstance(expected_item_version, int)
        or isinstance(expected_item_version, bool)
        or expected_item_version < 0
    ):
        raise TrustedProofVerificationError(
            "expected_item_version must be a non-negative integer"
        )
    try:
        normalized_idempotency_key = idempotency_key(source["idempotency_key"])
    except ProofWorkStateError as error:
        raise TrustedProofVerificationError(str(error)) from error

    # Reuse the immutable verification-set parser for graph, node, candidate,
    # media type, canonical base64, exact receipt digest, and receipt bounds.
    set_artifact = {
        "schema_id": "galaxy.proof-verification-set.v1",
        "graph_ref": source["graph_ref"],
        "items": [
            {
                "node_id": source["node_id"],
                "candidate_sha256": source["candidate_sha256"],
                "receipt": source["receipt"],
            }
        ],
    }
    try:
        registration = parse_proof_verification_set_bytes(
            _canonical_json(set_artifact),
            expected_graph_id=expected_graph_id,
            expected_graph_sha256=expected_graph_sha256,
        )
    except ProofVerificationSetError as error:
        raise TrustedProofVerificationError(str(error)) from error
    item = registration.items[0]
    allowlist = _adapter_allowlist(allowed_adapters)
    if (item.adapter_id, item.adapter_version) not in allowlist:
        raise TrustedProofVerificationError(
            "Trusted proof verifier adapter id/version is not allowlisted"
        )

    artifact = {
        "schema_id": TRUSTED_PROOF_VERIFICATION_REQUEST_SCHEMA,
        "graph_ref": registration.artifact["graph_ref"],
        "node_id": item.node_id,
        "candidate_sha256": item.candidate_sha256,
        "receipt": registration.artifact["items"][0]["receipt"],
        "expected_workspace_version": expected_workspace_version,
        "expected_item_version": expected_item_version,
        "idempotency_key": normalized_idempotency_key,
    }
    return TrustedProofVerificationRequest(
        content_bytes=content_bytes,
        request_sha256=request_sha256,
        artifact=artifact,
        registration=registration,
        item=item,
        expected_workspace_version=expected_workspace_version,
        expected_item_version=expected_item_version,
        idempotency_key=normalized_idempotency_key,
    )


def run_trusted_verifier_adapter(
    request: TrustedProofVerificationRequest,
    expected_subject: ExpectedProofSubject,
    adapters: Mapping[tuple[str, str], ProofReceiptVerifierAdapter],
) -> BoundProofVerification:
    """Dispatch one exact request and validate code-owned adapter evidence.

    ``adapters`` is the server-owned allowlist/dispatch table.  The client can
    select one exact key but cannot submit the callable or its authoritative
    result.  Adapter exceptions and unsupported return values fail closed.
    """
    if not isinstance(request, TrustedProofVerificationRequest):
        raise TrustedProofVerificationError(
            "Trusted proof verification request is invalid"
        )
    adapter = adapters.get(request.adapter_key)
    if adapter is None:
        raise TrustedProofVerificationError(
            "Trusted proof verifier adapter id/version is unavailable"
        )
    try:
        return run_verifier_adapter(
            request.registration, request.item, expected_subject, adapter
        )
    except ProofVerificationSetError as error:
        raise TrustedProofVerificationError(str(error)) from error
    except Exception as error:
        raise TrustedProofVerificationError(
            "Trusted proof verifier adapter failed closed"
        ) from error


def disabled_hyades_adapter(_request):
    """Fail-closed placeholder until authenticated Hyades validation exists."""
    raise ProofVerificationSetError(
        "Hyades verifier adapter is disabled pending authenticated validation"
    )


DISABLED_HYADES_ADAPTERS = MappingProxyType(
    {(HYADES_ADAPTER_ID, HYADES_ADAPTER_VERSION): disabled_hyades_adapter}
)
