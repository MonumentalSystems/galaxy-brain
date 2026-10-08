"""Code-owned verifier adapter for signed proofs.blah.dev verification reports.

Receipt bytes are the exact JSON body returned by
``GET https://proofs.blah.dev/api/research/v1/verification-reports/{id}``:
``{report_id, report, report_hash, attestation, created_at}``.  This module
performs no networking, persistence, or work-state mutation.

What the adapter establishes:

* ``report_hash`` is the SHA-256 of the producer's canonical report JSON
  (JavaScript ``JSON.stringify`` with recursively sorted keys), recomputed here.
* ``attestation.signature`` is an Ed25519 signature over that raw 32-byte
  digest under a key pinned in this file.  Keys are never fetched at runtime,
  and each key ID must equal the SHA-256 prefix of the key's SPKI DER bytes.
* The signed report says the proof was verified for a ``prove`` intent, has no
  rejection code, depends only on ``propext``, ``Classical.choice``, and
  ``Quot.sound``, and was checked against the submitted source whose SHA-256
  equals the Galaxy candidate digest.
* The signed ``report.origin`` names exactly the repository, commit, and
  declaration that the Galaxy graph node declares.

What it does not establish: it does not re-run Lean.  It trusts the kernel
check that proofs.blah.dev performed and attested by signature.  ``origin`` is
the producer's recorded provenance: signed, but not kernel-checked.  A report
without ``origin`` cannot be bound to a Galaxy subject and fails closed.

The registered implementation digest is the SHA-256 of this module's source
with LF line endings.  Any edit to this file requires a new adapter version and
a migration that registers the new digest.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from proof_verification_set import (
    ProofVerificationSetError,
    VerifierAdapterEvidence,
    VerifierAdapterRequest,
)
from proof_work_state import SENSITIVE_FIELD


PROOFS_BLAH_DEV_ADAPTER_ID = "proofs-blah-dev"
PROOFS_BLAH_DEV_ADAPTER_VERSION = "1"
PROOFS_BLAH_DEV_MEDIA_TYPE = (
    "application/vnd.proofs-blah-dev.verification-report+json"
)
PROOFS_BLAH_DEV_VERIFIER_SYSTEM = "proofs-blah-dev"
PROOFS_BLAH_DEV_VERIFICATION_METHOD = "signed-report"
PROOFS_BLAH_DEV_REPORT_SCHEMA = "proofs-verification-report/v1"
MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES = 262_144
MAX_CANONICAL_DEPTH = 64
PERMITTED_AXIOMS = frozenset({"propext", "Classical.choice", "Quot.sound"})

# Pinned production attestation keys.  A key ID is "ed25519:" followed by the
# first 16 hex digits of the SHA-256 of the key's SubjectPublicKeyInfo DER.
PINNED_ATTESTATION_KEYS = MappingProxyType({
    "ed25519:4d09a2be99b9a36d": (
        "-----BEGIN PUBLIC KEY-----\n"
        "MCowBQYDK2VwAyEAcPD3NIaqouJujzDdQF2wuDHMmJ7edVVXyQ0M3/fj4IQ=\n"
        "-----END PUBLIC KEY-----\n"
    ),
})

KEY_ID = re.compile(r"^ed25519:[0-9a-f]{16}$")
SHA256_REF = re.compile(r"^sha256:([0-9a-f]{64})$")
GIT_OID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
REPORT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
# JavaScript orders integer-like own keys numerically before string keys, so a
# sorted-key object containing them has no single unambiguous canonical form.
ARRAY_INDEX_KEY = re.compile(r"^(?:0|[1-9][0-9]*)$")
SURROGATE = re.compile("[\ud800-\udfff]")
MAX_SAFE_INTEGER = 2**53 - 1

RECEIPT_FIELDS = frozenset({
    "report_id", "report", "report_hash", "attestation", "created_at",
})
ATTESTATION_FIELDS = frozenset({"key_id", "signature", "algorithm"})
ORIGIN_FIELDS = frozenset({
    "collection", "repository", "revision", "path", "line_start", "line_end",
    "declaration", "key",
})
REQUIRED_ORIGIN_FIELDS = frozenset({"repository", "revision", "declaration"})


class ProofsBlahDevReceiptError(ProofVerificationSetError):
    """A proofs.blah.dev verification report failed closed."""


@dataclass(frozen=True)
class AttestationKey:
    """One parsed Ed25519 key whose ID is bound to its SPKI digest."""

    key_id: str
    spki_sha256: str
    public_key: Ed25519PublicKey


def load_attestation_keys(keys: Mapping[str, str]) -> Mapping[str, AttestationKey]:
    """Parse PEM keys and require each key ID to name its own SPKI digest."""
    if not isinstance(keys, Mapping) or not keys:
        raise ProofsBlahDevReceiptError("proofs.blah.dev attestation keys are required")
    loaded: dict[str, AttestationKey] = {}
    for key_id, pem in keys.items():
        if not isinstance(key_id, str) or not KEY_ID.fullmatch(key_id):
            raise ProofsBlahDevReceiptError("proofs.blah.dev attestation key_id is invalid")
        if not isinstance(pem, str):
            raise ProofsBlahDevReceiptError("proofs.blah.dev attestation key must be PEM text")
        try:
            public_key = serialization.load_pem_public_key(pem.encode("ascii"))
        except (UnicodeEncodeError, ValueError, TypeError) as error:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation key is not a valid public key"
            ) from error
        if not isinstance(public_key, Ed25519PublicKey):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation key must be Ed25519"
            )
        spki = public_key.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        spki_sha256 = hashlib.sha256(spki).hexdigest()
        if key_id != f"ed25519:{spki_sha256[:16]}":
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation key_id does not match its SPKI digest"
            )
        loaded[key_id] = AttestationKey(key_id, spki_sha256, public_key)
    return MappingProxyType(loaded)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProofsBlahDevReceiptError("Duplicate JSON fields are not allowed")
        result[key] = value
    return result


def _reject_non_json_number(value: str):
    raise ProofsBlahDevReceiptError(f"Non-finite JSON number {value} is not allowed")


def _parse_int(token: str) -> int:
    value = int(token)
    if abs(value) > MAX_SAFE_INTEGER:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev report integer exceeds the JavaScript safe range"
        )
    return value


def _parse_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise ProofsBlahDevReceiptError("proofs.blah.dev report number is not finite")
    try:
        exact = Decimal(token) == Decimal(repr(value))
    except InvalidOperation as error:
        raise ProofsBlahDevReceiptError("proofs.blah.dev report number is invalid") from error
    if not exact:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev report number cannot be reproduced exactly"
        )
    return value


def _load_receipt(content: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            content.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_non_json_number,
            parse_int=_parse_int,
            parse_float=_parse_float,
        )
    except ProofsBlahDevReceiptError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev verification report must be valid UTF-8 JSON"
        ) from error
    if not isinstance(value, dict):
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev verification report must be an object"
        )
    return value


def _js_number(value: float) -> str:
    """Format one finite double exactly as ECMAScript Number::toString does."""
    if not math.isfinite(value):
        raise ProofsBlahDevReceiptError("proofs.blah.dev report number is not finite")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent_text = repr(abs(value)).partition("e")
    integer_part, _, fraction_part = mantissa.partition(".")
    digits = integer_part + fraction_part
    point = len(integer_part) + (int(exponent_text) if exponent_text else 0)
    stripped = digits.lstrip("0")
    point -= len(digits) - len(stripped)
    digits = stripped.rstrip("0")
    k, n = len(digits), point
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        exponent = n - 1
        exponent_sign = "+" if exponent >= 0 else "-"
        head = digits if k == 1 else f"{digits[0]}.{digits[1:]}"
        text = f"{head}e{exponent_sign}{abs(exponent)}"
    return sign + text


def _js_string(value: str) -> str:
    if SURROGATE.search(value):
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev report contains an unpaired surrogate"
        )
    return json.dumps(value, ensure_ascii=False)


def _canonical(value: Any, depth: int = 0) -> str:
    if depth > MAX_CANONICAL_DEPTH:
        raise ProofsBlahDevReceiptError("proofs.blah.dev report is nested too deeply")
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report integer exceeds the JavaScript safe range"
            )
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item, depth + 1) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if ARRAY_INDEX_KEY.fullmatch(key):
                raise ProofsBlahDevReceiptError(
                    "proofs.blah.dev report contains an integer-like object key"
                )
            _js_string(key)
        keys = sorted(value, key=lambda key: key.encode("utf-16-be"))
        return "{" + ",".join(
            f"{_js_string(key)}:{_canonical(value[key], depth + 1)}" for key in keys
        ) + "}"
    raise ProofsBlahDevReceiptError("proofs.blah.dev report contains an unsupported value")


def canonical_report_json(report: Any) -> bytes:
    """Reproduce JavaScript JSON.stringify with recursively sorted object keys."""
    return _canonical(report).encode("utf-8")


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProofsBlahDevReceiptError(f"{label} must be an object")
    return value


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ProofsBlahDevReceiptError(f"{label} must be canonical non-empty text")
    if SURROGATE.search(value):
        raise ProofsBlahDevReceiptError(f"{label} contains an unpaired surrogate")
    if len(value.encode("utf-16-le")) // 2 > maximum:
        raise ProofsBlahDevReceiptError(f"{label} exceeds {maximum} characters")
    return value


def _git_oid(value: Any, label: str) -> str:
    if not isinstance(value, str) or not GIT_OID.fullmatch(value):
        raise ProofsBlahDevReceiptError(f"{label} must be a lowercase Git object ID")
    return value


def _sha256_ref(value: Any, label: str) -> str:
    match = SHA256_REF.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ProofsBlahDevReceiptError(f"{label} must be sha256:<lowercase hex>")
    return match.group(1)


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ProofsBlahDevReceiptError(f"{label} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProofsBlahDevReceiptError(f"{label} must be an ISO timestamp") from error
    if parsed.tzinfo is None:
        raise ProofsBlahDevReceiptError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _signature(value: Any) -> bytes:
    if not isinstance(value, str) or not BASE64URL.fullmatch(value) or len(value) % 4 == 1:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev attestation signature must be canonical base64url"
        )
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError) as error:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev attestation signature must be canonical base64url"
        ) from error
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev attestation signature must be canonical base64url"
        )
    if len(decoded) != 64:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev attestation signature must contain 64 bytes"
        )
    return decoded


def _contains_sensitive_field(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            SENSITIVE_FIELD.fullmatch(key) or _contains_sensitive_field(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_sensitive_field(child) for child in value)
    return False


def _origin(report: dict[str, Any]) -> tuple[str, str, str]:
    origin = report.get("origin")
    if origin is None:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev report has no recorded origin; "
            "its Galaxy subject binding fails closed"
        )
    origin = _object(origin, "proofs.blah.dev report origin")
    unknown = sorted(set(origin) - ORIGIN_FIELDS)
    if unknown:
        raise ProofsBlahDevReceiptError(
            f"proofs.blah.dev report origin contains unknown field {unknown[0]}"
        )
    missing = sorted(REQUIRED_ORIGIN_FIELDS - set(origin))
    if missing:
        raise ProofsBlahDevReceiptError(
            f"proofs.blah.dev report origin.{missing[0]} is required"
        )
    repository = _text(origin["repository"], "proofs.blah.dev origin repository", 512)
    revision = _git_oid(origin["revision"], "proofs.blah.dev origin revision")
    declaration = _text(origin["declaration"], "proofs.blah.dev origin declaration", 512)
    for name in ("collection", "path"):
        if name in origin and origin[name] is not None:
            _text(origin[name], f"proofs.blah.dev origin {name}", 1024)
    line_bounds = []
    for name in ("line_start", "line_end"):
        if name in origin and origin[name] is not None:
            line = origin[name]
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise ProofsBlahDevReceiptError(
                    f"proofs.blah.dev origin {name} must be a positive integer"
                )
            line_bounds.append(line)
    if len(line_bounds) == 2 and line_bounds[0] > line_bounds[1]:
        raise ProofsBlahDevReceiptError(
            "proofs.blah.dev origin line_start must not follow line_end"
        )
    if "key" in origin and origin["key"] is not None:
        expected_key = f"lean:{repository}@{revision}/{declaration}"
        if origin["key"] != expected_key:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev origin key does not name its repository, revision, "
                "and declaration"
            )
    return repository, revision, declaration


class ProofsBlahDevReportAdapter:
    """Authenticate one exact signed report under an immutable key set.

    Production code uses only ``PROOFS_BLAH_DEV_ADAPTER``, which is bound to
    ``PINNED_ATTESTATION_KEYS``.  The ``attestation_keys`` constructor argument
    is the test-only seam for exercising signed success paths with a generated
    key; no request, environment variable, or registry entry can select it.
    """

    __slots__ = ("_keys",)

    def __init__(self, *, attestation_keys: Mapping[str, str]):
        object.__setattr__(self, "_keys", load_attestation_keys(attestation_keys))

    def __setattr__(self, name, value):
        raise AttributeError("proofs.blah.dev adapter is immutable")

    @property
    def attestation_key_ids(self) -> frozenset[str]:
        return frozenset(self._keys)

    def __call__(self, request: VerifierAdapterRequest) -> VerifierAdapterEvidence:
        try:
            return self._verify(request)
        except ProofVerificationSetError:
            raise
        except Exception as error:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev verification report failed closed"
            ) from error

    def _verify(self, request: VerifierAdapterRequest) -> VerifierAdapterEvidence:
        if not isinstance(request, VerifierAdapterRequest):
            raise ProofsBlahDevReceiptError("proofs.blah.dev adapter request is invalid")
        if (
            request.adapter_id != PROOFS_BLAH_DEV_ADAPTER_ID
            or request.adapter_version != PROOFS_BLAH_DEV_ADAPTER_VERSION
        ):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev adapter id/version does not match the request"
            )
        if request.receipt_media_type != PROOFS_BLAH_DEV_MEDIA_TYPE:
            raise ProofsBlahDevReceiptError(
                f"proofs.blah.dev receipt media type must be {PROOFS_BLAH_DEV_MEDIA_TYPE}"
            )
        content = request.receipt_bytes
        if not isinstance(content, bytes) or not 1 <= len(content) <= MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev verification report must contain 1 byte to "
                f"{MAX_PROOFS_BLAH_DEV_RECEIPT_BYTES} bytes"
            )
        if hashlib.sha256(content).hexdigest() != request.receipt_sha256:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev receipt bytes do not match receipt_sha256"
            )

        receipt = _load_receipt(content)
        if set(receipt) != RECEIPT_FIELDS:
            unexpected = sorted(set(receipt) ^ RECEIPT_FIELDS)
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev verification report fields are invalid: "
                f"{unexpected[0]}"
            )
        report = _object(receipt["report"], "proofs.blah.dev report")
        claimed_digest = _sha256_ref(receipt["report_hash"], "proofs.blah.dev report_hash")
        digest = hashlib.sha256(canonical_report_json(report)).hexdigest()
        if digest != claimed_digest:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report_hash does not match the canonical report"
            )

        attestation = _object(receipt["attestation"], "proofs.blah.dev attestation")
        unknown = sorted(set(attestation) - ATTESTATION_FIELDS)
        if unknown:
            raise ProofsBlahDevReceiptError(
                f"proofs.blah.dev attestation contains unknown field {unknown[0]}"
            )
        if "algorithm" in attestation and not isinstance(attestation["algorithm"], str):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation algorithm must be text"
            )
        key_id = attestation.get("key_id")
        if not isinstance(key_id, str) or not KEY_ID.fullmatch(key_id):
            raise ProofsBlahDevReceiptError("proofs.blah.dev attestation key_id is invalid")
        key = self._keys.get(key_id)
        if key is None:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation key_id is not pinned"
            )
        if key_id != f"ed25519:{key.spki_sha256[:16]}":
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation key_id does not match its SPKI digest"
            )
        try:
            key.public_key.verify(
                _signature(attestation.get("signature")), bytes.fromhex(digest)
            )
        except InvalidSignature as error:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev attestation signature is invalid"
            ) from error

        # Everything below is read from the authenticated report only.
        report_id = report.get("report_id")
        if (
            not isinstance(report_id, str)
            or not REPORT_ID.fullmatch(report_id)
            or receipt["report_id"] != report_id
        ):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report_id does not match the signed report"
            )
        if "attestation_key_id" in report and report["attestation_key_id"] != key_id:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev signed attestation_key_id does not match the signature key"
            )
        if report.get("schema_version") != PROOFS_BLAH_DEV_REPORT_SCHEMA:
            raise ProofsBlahDevReceiptError(
                f"proofs.blah.dev report must use {PROOFS_BLAH_DEV_REPORT_SCHEMA}"
            )
        if report.get("outcome") != "verified":
            raise ProofsBlahDevReceiptError("proofs.blah.dev report outcome is not verified")
        if report.get("intent") != "prove":
            raise ProofsBlahDevReceiptError("proofs.blah.dev report intent is not prove")
        if "rejection_code" not in report or report["rejection_code"] is not None:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report rejection_code must be null"
            )
        axioms = report.get("axioms")
        if (
            not isinstance(axioms, list)
            or not all(isinstance(axiom, str) for axiom in axioms)
            or len(set(axioms)) != len(axioms)
        ):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report axioms must be unique names"
            )
        if not set(axioms) <= PERMITTED_AXIOMS:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report depends on a non-permitted axiom"
            )
        input_manifest = _object(
            report.get("input_manifest"), "proofs.blah.dev report input_manifest"
        )
        theorem_revision_id = _text(
            report.get("theorem_revision_id"),
            "proofs.blah.dev report theorem_revision_id",
            200,
        )
        if input_manifest.get("theorem_revision_id") != theorem_revision_id:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report theorem_revision_id does not match its input manifest"
            )
        solution_sha256 = _sha256_ref(
            report.get("source_hash"), "proofs.blah.dev report source_hash"
        )
        if (
            "source_sha256" in input_manifest
            and input_manifest["source_sha256"] != solution_sha256
        ):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report source_hash does not match its input manifest"
            )
        if solution_sha256 != request.candidate_sha256:
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report source_hash does not match the Galaxy candidate"
            )
        environment = _object(
            report.get("formal_environment"), "proofs.blah.dev report formal_environment"
        )
        lean_toolchain = _text(
            environment.get("lean_toolchain"), "proofs.blah.dev lean_toolchain", 200
        )
        mathlib_revision = _git_oid(
            environment.get("mathlib_commit"), "proofs.blah.dev mathlib_commit"
        )
        verified_at = _timestamp(
            report.get("finished_at"), "proofs.blah.dev report finished_at"
        )

        repository, revision, declaration = _origin(report)
        subject = request.expected_subject
        if (
            repository != subject.source_repository
            or revision != subject.source_commit
            or (declaration,) != subject.declaration_ids
        ):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev report origin does not match the Galaxy graph node"
            )
        if _contains_sensitive_field(receipt):
            raise ProofsBlahDevReceiptError(
                "proofs.blah.dev verification report contains a credential or raw-log field"
            )

        return VerifierAdapterEvidence(
            adapter_id=PROOFS_BLAH_DEV_ADAPTER_ID,
            adapter_version=PROOFS_BLAH_DEV_ADAPTER_VERSION,
            receipt_sha256=request.receipt_sha256,
            outcome="accepted",
            solution_sha256=solution_sha256,
            sorry_free=True,
            verifier_system=PROOFS_BLAH_DEV_VERIFIER_SYSTEM,
            method=PROOFS_BLAH_DEV_VERIFICATION_METHOD,
            subject_graph_id=request.graph_id,
            subject_graph_content_sha256=request.graph_content_sha256,
            subject_node_id=request.node_id,
            subject_declaration_ids=(declaration,),
            source_repository=repository,
            source_commit=revision,
            lean_toolchain=lean_toolchain,
            mathlib_revision=mathlib_revision,
            verified_at=verified_at,
            hyades=None,
            safe_for_storage=True,
        )


def proofs_blah_dev_adapter_implementation_sha256() -> str:
    """Return the registered implementation digest: this LF-normalized source."""
    source = Path(__file__).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(source).hexdigest()


PROOFS_BLAH_DEV_ADAPTER = ProofsBlahDevReportAdapter(
    attestation_keys=PINNED_ATTESTATION_KEYS
)
