"""Server-owned, allowlisted document transform adapter implementations.

The public API deliberately accepts only source bytes and their declared file
identity. Deployment URLs, credentials, provider routes, multipart fields, and
normalization rules remain owned by this module rather than plugin metadata or
request input.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Literal, Optional

from durable_ingestion import (
    IngestionContractError,
    MAX_TRANSFORM_BYTES,
    MAX_TRANSFORM_OUTPUT_BYTES,
    TRANSFORM_CONFIG_REVISION,
    TRANSFORM_PIPELINE_VERSION,
    docling_response_metadata,
    normalize_docling_document,
    normalize_docling_markdown,
    normalize_markitdown_document,
    normalize_plain_text_document,
    representation_content_sha256,
)


DOCLING_IMPLEMENTATION_ID = "builtin.docling.convert"
MARKITDOWN_IMPLEMENTATION_ID = "builtin.markitdown.convert"
PLAIN_TEXT_IMPLEMENTATION_ID = "builtin.plain-text.convert"
DOCUMENT_TRANSFORM_IMPLEMENTATION_IDS = frozenset({
    DOCLING_IMPLEMENTATION_ID,
    MARKITDOWN_IMPLEMENTATION_ID,
    PLAIN_TEXT_IMPLEMENTATION_ID,
})

DOCLING_PLUGIN_VERSION = "1.0.2"
MARKITDOWN_PLUGIN_VERSION = "1.0.1"
PLAIN_TEXT_PLUGIN_VERSION = "1.0.0"
MARKITDOWN_ENGINE_VERSION = "0.1.8"
TRANSFORM_TIMEOUT_SECONDS = 120
DOCLING_ASYNC_TIMEOUT_SECONDS = 900
DOCLING_POLL_INTERVAL_SECONDS = 2
ADAPTER_RESULT_SCHEMA = "gb.document-transform-adapter-result.v1"

_DOCLING_FIXED_FORM_FIELDS = (
    ("to_formats", "json"),
    ("to_formats", "md"),
    ("image_export_mode", "embedded"),
    ("do_ocr", "true"),
    ("do_table_structure", "true"),
    ("table_mode", "accurate"),
    ("do_formula_enrichment", "false"),
    ("do_pdf_heading_hierarchy", "true"),
    ("include_images", "true"),
    ("include_page_images", "false"),
    ("abort_on_error", "false"),
)

# Kept as the PDF-shaped compatibility constant while new callers should use
# docling_form_fields so the provider receives the actual declared format.
DOCLING_FORM_FIELDS = (("from_formats", "pdf"),) + _DOCLING_FIXED_FORM_FIELDS

_DOCLING_FORMATS = {
    ".pdf": ("pdf", frozenset({"application/pdf"})),
    ".docx": (
        "docx",
        frozenset({
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
    ),
    ".html": ("html", frozenset({"text/html", "application/xhtml+xml"})),
    ".htm": ("html", frozenset({"text/html", "application/xhtml+xml"})),
    ".xhtml": ("html", frozenset({"text/html", "application/xhtml+xml"})),
}
_MARKITDOWN_FALLBACK_MEDIA_TYPES = {
    ".pdf": frozenset({"application/pdf"}),
    ".docx": frozenset({
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    ".html": frozenset({"text/html", "application/xhtml+xml"}),
    ".htm": frozenset({"text/html", "application/xhtml+xml"}),
}
_VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+:-]{0,99}")
_DIAGNOSTIC_PATTERN = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+")
_DOCLING_TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_DOCLING_TASK_STATES = frozenset({"pending", "started", "success", "failure"})


class TransformAdapterContractError(ValueError):
    """Raised for invalid adapter selection or caller-owned source metadata."""


@dataclass(frozen=True)
class DocumentTransformAdapter:
    implementation_id: str
    plugin_id: str
    plugin_version: str
    engine: str


@dataclass(frozen=True)
class DocumentTransformResult:
    """Validated, bounded output from exactly one allowlisted adapter."""

    implementation_id: str
    plugin_id: str
    plugin_version: str
    engine: str
    engine_version: str
    config: Dict[str, Any]
    status: Literal["success", "partial", "failed"]
    diagnostic_code: Optional[str] = None
    structure: Optional[dict] = None
    markdown: Optional[str] = None

    def __post_init__(self) -> None:
        adapter = resolve_document_transform_adapter(self.implementation_id)
        if (
            self.plugin_id != adapter.plugin_id
            or self.plugin_version != adapter.plugin_version
            or self.engine != adapter.engine
        ):
            raise TransformAdapterContractError("Transform result adapter identity is invalid")
        if not _VERSION_PATTERN.fullmatch(self.engine_version):
            raise TransformAdapterContractError("Transform result engine version is invalid")
        if self.status not in {"success", "partial", "failed"}:
            raise TransformAdapterContractError("Transform result status is invalid")
        if self.diagnostic_code is not None and not _DIAGNOSTIC_PATTERN.fullmatch(self.diagnostic_code):
            raise TransformAdapterContractError("Transform result diagnostic is invalid")
        if self.status == "failed":
            if self.diagnostic_code is None or self.structure is not None or self.markdown is not None:
                raise TransformAdapterContractError("Failed transform result is invalid")
        elif self.structure is None and self.markdown is None:
            raise TransformAdapterContractError("Successful transform result has no output")
        if self.status == "success" and self.diagnostic_code is not None:
            raise TransformAdapterContractError("Successful transform result has a diagnostic")
        if self.structure is not None:
            try:
                representation_content_sha256("document-structure", self.structure)
            except IngestionContractError as error:
                raise TransformAdapterContractError(str(error)) from error
        if self.markdown is not None:
            try:
                representation_content_sha256("markdown", self.markdown)
            except IngestionContractError as error:
                raise TransformAdapterContractError(str(error)) from error
        try:
            encoded_config = json.dumps(
                self.config, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise TransformAdapterContractError("Transform result config is not JSON-safe") from error
        if len(encoded_config) > 65_536:
            raise TransformAdapterContractError("Transform result config exceeds the limit")

    def as_dict(self) -> dict:
        return {
            "schemaId": ADAPTER_RESULT_SCHEMA,
            "implementationId": self.implementation_id,
            "pluginId": self.plugin_id,
            "pluginVersion": self.plugin_version,
            "engine": self.engine,
            "engineVersion": self.engine_version,
            "config": self.config,
            "status": self.status,
            "diagnosticCode": self.diagnostic_code,
            "structure": self.structure,
            "markdown": self.markdown,
        }


_ADAPTERS = {
    DOCLING_IMPLEMENTATION_ID: DocumentTransformAdapter(
        DOCLING_IMPLEMENTATION_ID, "docling", DOCLING_PLUGIN_VERSION, "docling",
    ),
    MARKITDOWN_IMPLEMENTATION_ID: DocumentTransformAdapter(
        MARKITDOWN_IMPLEMENTATION_ID, "markitdown", MARKITDOWN_PLUGIN_VERSION, "markitdown",
    ),
    PLAIN_TEXT_IMPLEMENTATION_ID: DocumentTransformAdapter(
        PLAIN_TEXT_IMPLEMENTATION_ID, "plain-text", PLAIN_TEXT_PLUGIN_VERSION, "utf-8",
    ),
}


def resolve_document_transform_adapter(implementation_id: str) -> DocumentTransformAdapter:
    """Resolve an exact built-in implementation ID, failing closed otherwise."""
    if not isinstance(implementation_id, str) or implementation_id not in _ADAPTERS:
        raise TransformAdapterContractError("Document transform implementation is not allowlisted")
    return _ADAPTERS[implementation_id]


def _configured_version(environment_name: str) -> Optional[str]:
    value = os.environ.get(environment_name, "").strip()
    return value if _VERSION_PATTERN.fullmatch(value) else None


def configured_document_transform_engine_version(implementation_id: str) -> Optional[str]:
    resolve_document_transform_adapter(implementation_id)
    if implementation_id == DOCLING_IMPLEMENTATION_ID:
        return _configured_version("DOCLING_ENGINE_VERSION")
    if implementation_id == PLAIN_TEXT_IMPLEMENTATION_ID:
        return "unicode-15"
    return MARKITDOWN_ENGINE_VERSION


def document_transform_adapter_fingerprint() -> str:
    """Bind replay identity to the exact code-owned adapter set and engines."""
    payload = {
        "schemaId": "gb.document-transform-adapter-set.v1",
        "configRevision": TRANSFORM_CONFIG_REVISION,
        "adapters": [
            {
                "implementationId": implementation_id,
                "pluginVersion": _ADAPTERS[implementation_id].plugin_version,
                "engineVersion": (
                    configured_document_transform_engine_version(implementation_id)
                    or "unconfigured"
                ),
            }
            for implementation_id in sorted(DOCUMENT_TRANSFORM_IMPLEMENTATION_IDS)
        ],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _normalized_media_type(media_type: str) -> str:
    if not isinstance(media_type, str) or not 1 <= len(media_type) <= 255:
        raise TransformAdapterContractError("Document media type is invalid")
    if "\r" in media_type or "\n" in media_type:
        raise TransformAdapterContractError("Document media type is invalid")
    value = media_type.split(";", 1)[0].strip().lower()
    if not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", value):
        raise TransformAdapterContractError("Document media type is invalid")
    return value


def _docling_source_format(filename: str, media_type: str) -> Optional[str]:
    declared = _DOCLING_FORMATS.get(Path(filename).suffix.lower())
    normalized_media_type = _normalized_media_type(media_type)
    if declared is None or normalized_media_type not in declared[1]:
        return None
    return declared[0]


def docling_form_fields(filename: str, media_type: str) -> tuple[tuple[str, str], ...]:
    source_format = _docling_source_format(filename, media_type)
    if source_format is None:
        raise TransformAdapterContractError("Document format is not supported by the Docling adapter")
    return (("from_formats", source_format),) + _DOCLING_FIXED_FORM_FIELDS


def document_transform_adapter_config(
    implementation_id: str,
    output_kind: str,
    *,
    engine_version: Optional[str] = None,
    filename: Optional[str] = None,
    media_type: Optional[str] = None,
) -> dict:
    adapter = resolve_document_transform_adapter(implementation_id)
    if not isinstance(output_kind, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", output_kind):
        raise TransformAdapterContractError("Document transform output kind is invalid")
    config: Dict[str, Any] = {
        "schemaId": "gb.document-transform-config.v1",
        "pipelineVersion": TRANSFORM_PIPELINE_VERSION,
        "configRevision": TRANSFORM_CONFIG_REVISION,
        "pluginId": adapter.plugin_id,
        "outputKind": output_kind,
    }
    if implementation_id == DOCLING_IMPLEMENTATION_ID:
        if (filename is None) != (media_type is None):
            raise TransformAdapterContractError("Docling config requires filename and media type together")
        source_format = "pdf" if filename is None else _docling_source_format(filename, media_type or "")
        fields = (
            (("from_formats", source_format),) if source_format is not None else ()
        ) + _DOCLING_FIXED_FORM_FIELDS
        config["engineVersion"] = (
            engine_version
            or configured_document_transform_engine_version(implementation_id)
            or "unconfigured"
        )
        config["outputKinds"] = ["document-structure", "markdown"]
        config["execution"] = {
            "mode": "async",
            "maxWaitSeconds": DOCLING_ASYNC_TIMEOUT_SECONDS,
            "pollIntervalSeconds": DOCLING_POLL_INTERVAL_SECONDS,
        }
        options = {name: value for name, value in fields if name not in {"to_formats", "from_formats"}}
        options["from_formats"] = [
            value for name, value in fields if name == "from_formats"
        ]
        options["to_formats"] = [
            value for name, value in fields if name == "to_formats"
        ]
        config["options"] = options
    return config


class _RejectTransformRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        del request, file_pointer, code, message, headers, new_url
        return None


_TRANSFORM_OPENER = urllib.request.build_opener(_RejectTransformRedirects())


def _read_transform_response(response, deadline: float) -> bytes:
    read_one = getattr(response, "read1", None)
    socket_value = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
    set_timeout = getattr(socket_value, "settimeout", None)
    if not callable(read_one) or not callable(set_timeout):
        raise OSError("transform response does not expose a bounded HTTP stream")
    encoded = bytearray()
    while len(encoded) <= MAX_TRANSFORM_OUTPUT_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("transform response exceeded its wall-clock deadline")
        try:
            set_timeout(remaining)
        except OSError as error:
            # http.client may release its socket as soon as it has parsed a
            # response that closes the connection.  The response's buffered
            # reader still owns the descriptor and remains readable, but the
            # released socket wrapper rejects settimeout() with EBADF.
            if error.errno != errno.EBADF or not getattr(socket_value, "_closed", False):
                raise
        chunk = read_one(min(32_768, MAX_TRANSFORM_OUTPUT_BYTES + 1 - len(encoded)))
        if not chunk:
            return bytes(encoded)
        encoded.extend(chunk)
    return bytes(encoded)


def _fixed_transform_url(environment_name: str, endpoint: str) -> Optional[str]:
    base = os.environ.get(environment_name, "").strip()
    if not base:
        return None
    parsed = urllib.parse.urlsplit(base)
    hostname = (parsed.hostname or "").lower()
    trusted_compose_markitdown = (
        environment_name == "MARKITDOWN_API_INTERNAL" and base == "http://markitdown:8043"
    )
    trusted_compose_docling = (
        environment_name == "DOCLING_API_INTERNAL" and base == "http://docling:5001"
    )
    if (
        parsed.scheme not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (
            parsed.scheme == "http"
            and hostname not in {"localhost", "127.0.0.1", "::1"}
            and not trusted_compose_markitdown
            and not trusted_compose_docling
        )
    ):
        return None
    return urllib.parse.urljoin(base.rstrip("/") + "/", endpoint.lstrip("/"))


def _multipart_document(
    filename: str,
    media_type: str,
    content: bytes,
    *,
    file_field: str = "file",
    form_fields: tuple[tuple[str, str], ...] = (),
) -> tuple[bytes, str]:
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", file_field):
        raise ValueError("multipart file field is invalid")
    if len(form_fields) > 16:
        raise ValueError("multipart form has too many fields")
    boundary = f"galaxy-{secrets.token_hex(18)}"
    safe_filename = re.sub(r'["\\\r\n]', "_", Path(filename).name) or "document"
    parts = []
    for name, value in form_fields:
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", name)
            or not isinstance(value, str)
            or len(value.encode("utf-8")) > 1024
            or "\r" in value
            or "\n" in value
        ):
            raise ValueError("multipart form field is invalid")
        parts.extend((
            f"--{boundary}\r\n".encode("ascii"),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii"),
            value.encode("utf-8"),
            b"\r\n",
        ))
    parts.extend((
        f"--{boundary}\r\n".encode("ascii"),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_filename}"\r\n'.encode("utf-8"),
        f"Content-Type: {media_type}\r\n\r\n".encode("ascii"),
        content,
        f"\r\n--{boundary}--\r\n".encode("ascii"),
    ))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _call_transform_request(
    outbound: urllib.request.Request,
    *,
    diagnostic_prefix: str,
    timeout_seconds: float = TRANSFORM_TIMEOUT_SECONDS,
) -> tuple[Optional[Any], str]:
    deadline = time.monotonic() + timeout_seconds
    try:
        with _TRANSFORM_OPENER.open(outbound, timeout=timeout_seconds) as response:
            declared_length = response.headers.get("Content-Length")
            if declared_length and int(declared_length) > MAX_TRANSFORM_OUTPUT_BYTES:
                return None, f"{diagnostic_prefix}.output_too_large"
            encoded = _read_transform_response(response, deadline)
            if len(encoded) > MAX_TRANSFORM_OUTPUT_BYTES:
                return None, f"{diagnostic_prefix}.output_too_large"
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            return None, f"{diagnostic_prefix}.redirected"
        if error.code == 415:
            return None, f"{diagnostic_prefix}.unsupported"
        if error.code == 413:
            return None, f"{diagnostic_prefix}.input_too_large"
        if error.code in {408, 504}:
            return None, f"{diagnostic_prefix}.timeout"
        return None, f"{diagnostic_prefix}.failed"
    except urllib.error.URLError as error:
        if isinstance(error.reason, TimeoutError):
            return None, f"{diagnostic_prefix}.timeout"
        return None, f"{diagnostic_prefix}.unavailable"
    except TimeoutError:
        return None, f"{diagnostic_prefix}.timeout"
    except (OSError, ValueError):
        return None, f"{diagnostic_prefix}.unavailable"
    try:
        return json.loads(encoded.decode("utf-8")), ""
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, f"{diagnostic_prefix}.invalid_response"


def _call_transform_service(
    *,
    base_environment: str,
    endpoint: str,
    token_environment: str,
    token_header: str,
    filename: str,
    media_type: str,
    content: bytes,
    diagnostic_prefix: str,
    file_field: str = "file",
    form_fields: tuple[tuple[str, str], ...] = (),
    timeout_seconds: float = TRANSFORM_TIMEOUT_SECONDS,
) -> tuple[Optional[Any], str]:
    url = _fixed_transform_url(base_environment, endpoint)
    token = _transform_service_token(token_environment)
    if url is None or not token:
        return None, f"{diagnostic_prefix}.not_configured"
    body, multipart_type = _multipart_document(
        filename, media_type, content, file_field=file_field, form_fields=form_fields,
    )
    outbound = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": multipart_type, token_header: token},
    )
    return _call_transform_request(
        outbound, diagnostic_prefix=diagnostic_prefix, timeout_seconds=timeout_seconds,
    )


def _call_transform_json_service(
    *,
    base_environment: str,
    endpoint: str,
    token_environment: str,
    token_header: str,
    diagnostic_prefix: str,
    timeout_seconds: float = TRANSFORM_TIMEOUT_SECONDS,
) -> tuple[Optional[Any], str]:
    url = _fixed_transform_url(base_environment, endpoint)
    token = _transform_service_token(token_environment)
    if url is None or not token:
        return None, f"{diagnostic_prefix}.not_configured"
    outbound = urllib.request.Request(
        url,
        method="GET",
        headers={token_header: token},
    )
    return _call_transform_request(
        outbound, diagnostic_prefix=diagnostic_prefix, timeout_seconds=timeout_seconds,
    )


def _transform_service_token(environment_name: str) -> str:
    token = os.environ.get(environment_name, "").strip()
    if token:
        return token
    if environment_name == "DOCLING_API_KEY":
        return os.environ.get("GALAXY_DEPLOY_DOCLING_API_KEY", "").strip()
    return ""


def _docling_task_state(
    payload: Any, *, expected_task_id: Optional[str] = None,
) -> Optional[tuple[str, str]]:
    if not isinstance(payload, dict):
        return None
    task_id = payload.get("task_id")
    task_status = payload.get("task_status")
    if (
        not isinstance(task_id, str)
        or not _DOCLING_TASK_ID_PATTERN.fullmatch(task_id)
        or (expected_task_id is not None and task_id != expected_task_id)
        or task_status not in _DOCLING_TASK_STATES
    ):
        return None
    return task_id, task_status


def _call_docling_async(
    *,
    filename: str,
    media_type: str,
    content: bytes,
    form_fields: tuple[tuple[str, str], ...],
) -> tuple[Optional[Any], str]:
    deadline = time.monotonic() + DOCLING_ASYNC_TIMEOUT_SECONDS
    task_payload, diagnostic = _call_transform_service(
        base_environment="DOCLING_API_INTERNAL",
        endpoint="v1/convert/file/async",
        token_environment="DOCLING_API_KEY",
        token_header="X-API-Key",
        filename=filename,
        media_type=media_type,
        content=content,
        diagnostic_prefix="docling",
        file_field="files",
        form_fields=form_fields,
    )
    if task_payload is None:
        return None, diagnostic
    task_state = _docling_task_state(task_payload)
    if task_state is None:
        return None, "docling.invalid_response"
    task_id, task_status = task_state
    while task_status not in {"success", "failure"}:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None, "docling.timeout"
        status_payload, diagnostic = _call_transform_json_service(
            base_environment="DOCLING_API_INTERNAL",
            endpoint=f"v1/status/poll/{urllib.parse.quote(task_id, safe='')}",
            token_environment="DOCLING_API_KEY",
            token_header="X-API-Key",
            diagnostic_prefix="docling",
            timeout_seconds=min(TRANSFORM_TIMEOUT_SECONDS, remaining),
        )
        if status_payload is None:
            return None, diagnostic
        task_state = _docling_task_state(status_payload, expected_task_id=task_id)
        if task_state is None:
            return None, "docling.invalid_response"
        _, task_status = task_state
        if task_status not in {"success", "failure"}:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, "docling.timeout"
            time.sleep(min(DOCLING_POLL_INTERVAL_SECONDS, remaining))
    if task_status == "failure":
        return None, "docling.failed"
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None, "docling.timeout"
    return _call_transform_json_service(
        base_environment="DOCLING_API_INTERNAL",
        endpoint=f"v1/result/{urllib.parse.quote(task_id, safe='')}",
        token_environment="DOCLING_API_KEY",
        token_header="X-API-Key",
        diagnostic_prefix="docling",
        timeout_seconds=min(TRANSFORM_TIMEOUT_SECONDS, remaining),
    )


def _transform_engine_version(payload: Any) -> str:
    if not isinstance(payload, dict):
        return "unknown"
    candidates = [payload.get("engine_version"), payload.get("version")]
    document = payload.get("document")
    if isinstance(document, dict):
        candidates.append(document.get("version"))
    for candidate in candidates:
        if isinstance(candidate, str) and _VERSION_PATTERN.fullmatch(candidate.strip()):
            return candidate.strip()
    return "unknown"


def _validated_source(filename: str, media_type: str, content: bytes) -> tuple[str, str, bytes]:
    if not isinstance(filename, str) or not filename or len(filename.encode("utf-8")) > 1024:
        raise TransformAdapterContractError("Document filename is invalid")
    normalized_media_type = _normalized_media_type(media_type)
    if not isinstance(content, bytes):
        raise TransformAdapterContractError("Document content must be bytes")
    return filename, normalized_media_type, content


def _result(
    adapter: DocumentTransformAdapter,
    *,
    engine_version: str,
    config: dict,
    status: Literal["success", "partial", "failed"],
    diagnostic_code: Optional[str] = None,
    structure: Optional[dict] = None,
    markdown: Optional[str] = None,
) -> DocumentTransformResult:
    return DocumentTransformResult(
        implementation_id=adapter.implementation_id,
        plugin_id=adapter.plugin_id,
        plugin_version=adapter.plugin_version,
        engine=adapter.engine,
        engine_version=engine_version,
        config=config,
        status=status,
        diagnostic_code=diagnostic_code,
        structure=structure,
        markdown=markdown,
    )


def _execute_docling(
    adapter: DocumentTransformAdapter, filename: str, media_type: str, content: bytes,
) -> DocumentTransformResult:
    engine_version = configured_document_transform_engine_version(adapter.implementation_id)
    config = document_transform_adapter_config(
        adapter.implementation_id,
        "document-structure",
        engine_version=engine_version,
        filename=filename,
        media_type=media_type,
    )
    if engine_version is None:
        return _result(
            adapter, engine_version="unknown", config=config, status="failed",
            diagnostic_code="docling.engine_version_not_configured",
        )
    try:
        fields = docling_form_fields(filename, media_type)
    except TransformAdapterContractError:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="docling.unsupported",
        )
    if len(content) > MAX_TRANSFORM_BYTES:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="docling.input_too_large",
        )
    payload, diagnostic = _call_docling_async(
        filename=filename,
        media_type=media_type,
        content=content,
        form_fields=fields,
    )
    if payload is None:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code=diagnostic,
        )
    try:
        metadata = docling_response_metadata(payload)
    except IngestionContractError:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="docling.invalid_response",
        )
    reported_version = _transform_engine_version(payload)
    if reported_version != "unknown" and reported_version != engine_version:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="docling.engine_version_mismatch",
        )
    document = payload.get("document") if isinstance(payload, dict) else None
    has_structure = isinstance(document, dict) and (
        "json_content" in document or "blocks" in document
    )
    has_markdown = isinstance(document, dict) and "md_content" in document
    structure = None
    markdown = None
    structure_invalid = False
    if has_structure:
        try:
            structure = normalize_docling_document(payload)
        except IngestionContractError:
            structure_invalid = True
    if has_markdown:
        try:
            markdown = normalize_docling_markdown(payload)
        except IngestionContractError:
            pass
    if structure is None and markdown is None:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="docling.invalid_response",
        )
    if structure is None:
        status = "partial"
        diagnostic_code = (
            "docling.structure_invalid" if structure_invalid
            else "docling.structure_unavailable"
        )
    elif markdown is None:
        status, diagnostic_code = "partial", "docling.markdown_unavailable"
    elif metadata["status"] == "partial_success":
        status, diagnostic_code = "partial", "docling.partial_success"
    elif metadata["errorCount"] > 0:
        status, diagnostic_code = "partial", "docling.reported_errors"
    else:
        status, diagnostic_code = "success", None
    return _result(
        adapter,
        engine_version=engine_version,
        config=config,
        status=status,
        diagnostic_code=diagnostic_code,
        structure=structure,
        markdown=markdown,
    )


def _execute_markitdown(
    adapter: DocumentTransformAdapter, filename: str, media_type: str, content: bytes,
) -> DocumentTransformResult:
    config = document_transform_adapter_config(adapter.implementation_id, "markdown")
    accepted_media_types = _MARKITDOWN_FALLBACK_MEDIA_TYPES.get(Path(filename).suffix.lower())
    if accepted_media_types is None or media_type not in accepted_media_types:
        return _result(
            adapter, engine_version=MARKITDOWN_ENGINE_VERSION, config=config, status="failed",
            diagnostic_code="markitdown.unsupported",
        )
    if len(content) > MAX_TRANSFORM_BYTES:
        return _result(
            adapter, engine_version="unknown", config=config, status="failed",
            diagnostic_code="markitdown.input_too_large",
        )
    payload, diagnostic = _call_transform_service(
        base_environment="MARKITDOWN_API_INTERNAL",
        endpoint="convert",
        token_environment="MARKITDOWN_PROXY_TOKEN",
        token_header="X-GB-Proxy-Token",
        filename=filename,
        media_type=media_type,
        content=content,
        diagnostic_prefix="markitdown",
    )
    if payload is None:
        return _result(
            adapter, engine_version="unknown", config=config, status="failed",
            diagnostic_code=diagnostic,
        )
    engine_version = _transform_engine_version(payload)
    try:
        if engine_version != MARKITDOWN_ENGINE_VERSION:
            raise IngestionContractError("MarkItDown engine version is missing or mismatched")
        markdown = normalize_markitdown_document(payload)
    except IngestionContractError:
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code="markitdown.invalid_response",
        )
    return _result(
        adapter,
        engine_version=engine_version,
        config=config,
        status="success",
        markdown=markdown,
    )


def _execute_plain_text(
    adapter: DocumentTransformAdapter, filename: str, media_type: str, content: bytes,
) -> DocumentTransformResult:
    del media_type
    engine_version = configured_document_transform_engine_version(adapter.implementation_id) or "unicode-15"
    config = document_transform_adapter_config(adapter.implementation_id, "markdown")
    try:
        markdown = normalize_plain_text_document(filename, content)
    except IngestionContractError as error:
        diagnostic = "plain_text.output_too_large" if "limit" in str(error) else "plain_text.invalid_utf8"
        return _result(
            adapter, engine_version=engine_version, config=config, status="failed",
            diagnostic_code=diagnostic,
        )
    return _result(
        adapter,
        engine_version=engine_version,
        config=config,
        status="success",
        markdown=markdown,
    )


def execute_document_transform_adapter(
    implementation_id: str,
    *,
    filename: str,
    media_type: str,
    content: bytes,
) -> DocumentTransformResult:
    """Execute one exact server-owned adapter and return a bounded envelope."""
    adapter = resolve_document_transform_adapter(implementation_id)
    filename, media_type, content = _validated_source(filename, media_type, content)
    if implementation_id == DOCLING_IMPLEMENTATION_ID:
        return _execute_docling(adapter, filename, media_type, content)
    if implementation_id == MARKITDOWN_IMPLEMENTATION_ID:
        return _execute_markitdown(adapter, filename, media_type, content)
    return _execute_plain_text(adapter, filename, media_type, content)
