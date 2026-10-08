"""Galaxy Brain ELN — Backend API Service.

REST API for managing experiments, hypotheses, and metrics in the
Galaxy Brain Electronic Lab Notebook.

Uses Galaxy Brain's dedicated PostgreSQL database. Ordered migrations are
applied by the deployment migration job before this runtime starts.

Usage:
    uvicorn server:app --host 0.0.0.0 --port 8044 --reload
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID, uuid4

import psycopg2
import psycopg2.extras
from psycopg2 import sql
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator
from json_patch import JsonPatchError, apply_json_patch
from arxiv_client import (
    ArxivError,
    arxiv_pdf_redistribution_license,
    get_arxiv_paper,
    normalize_arxiv_id,
    search_arxiv,
)
from arxiv_pdf_fetch import ArxivPdfFetchError, fetch_arxiv_pdf
from surface_bindings import SurfaceBindingError, resolve_surface_bindings
from tenant_filesystem import (
    AuthorizedTenantRoot,
    authorize_tenant_root,
    authorize_tenant_root_binding,
    parse_tenant_filesystem_roots,
)
from datasource_filesystem import (
    MAX_DATASOURCE_ENUMERATION_ITEMS,
    DatasourceFileNotFound,
    DatasourceFileRejected,
    DatasourceFileTooLarge,
    enumerate_authorized_datasource_files,
    read_authorized_datasource_file,
)
from surface_contract import (
    CATALOG_DIGEST,
    CATALOG_ID,
    CATALOG_VERSION,
    RENDERER_VERSION,
    SCHEMA_DIGEST,
    SURFACE_SCHEMA,
    SurfaceContractError,
    get_surface_contract_manifest,
    validate_binding_source,
    validate_surface_spec,
)
from task_plan_contract import (
    TASK_PLAN_SCHEMA,
    TaskPlanContractError,
    validate_task_plan_spec,
)
from task_plan_proposal import (
    TaskPlanProposalError,
    build_task_plan_proposal,
    proposal_input_references,
    validate_task_plan_proposal_intent,
)
from proof_work_state import (
    WORK_STATE_SCHEMA,
    ProofWorkStateConflict,
    ProofWorkStateError,
    apply_transition as apply_proof_work_transition,
    empty_work_item as empty_proof_work_item,
    idempotency_key as proof_idempotency_key,
    identifier as proof_identifier,
    same_hyades_task_binding,
    sha256 as proof_sha256,
    validate_transition as validate_proof_transition,
)
from proof_graph_registry import (
    MAX_PROOF_GRAPH_BYTES,
    ProofGraphRegistryError,
    parse_proof_graph_bytes,
)
from proof_mission_contract import (
    MAX_MISSION_INTENT_BYTES,
    ProofMissionContractError,
    derive_proof_mission,
    parse_mission_intent_bytes,
)
from proof_mission_activation import (
    ProofMissionActivationError,
    compile_proof_mission_activation,
)
from proof_verification_set import (
    ExpectedProofSubject,
    MAX_PROOF_VERIFICATION_SET_BYTES,
    ProofVerificationSetError,
    parse_proof_verification_set_bytes,
    run_verifier_adapter,
)
from trusted_proof_verification import (
    DISABLED_HYADES_ADAPTERS,
    MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES,
    TrustedProofVerificationError,
    parse_trusted_proof_verification_request_bytes,
    run_trusted_verifier_adapter,
)
from proofs_blah_dev_adapter import (
    PROOFS_BLAH_DEV_ADAPTER,
    PROOFS_BLAH_DEV_ADAPTER_ID,
    PROOFS_BLAH_DEV_ADAPTER_VERSION,
    proofs_blah_dev_adapter_implementation_sha256,
)
from object_links import (
    MAX_BODY_BYTES as MAX_OBJECT_LINK_BODY_BYTES,
    MAX_PROPOSAL_BODY_BYTES,
    MAX_PROPOSAL_DECISION_BODY_BYTES,
    KINDS as OBJECT_REFERENCE_KINDS,
    ObjectLinkError,
    ReferentAccess,
    ReferentAccessError,
    authorize_referent,
    canonical_reference,
    parse_canonical_reference,
    validate_link_payload,
    validate_relation_proposal_decision_payload,
    validate_relation_proposal_payload,
    validate_retraction_payload,
)
from agent_result_contract import (
    MAX_BODY_BYTES as MAX_AGENT_RESULT_BODY_BYTES,
    AgentResultContractError,
    parse_agent_result_decision,
    parse_agent_result_lookup,
    pinned_anchor_reference,
    pinned_document_reference,
)
from object_projection_sources import (
    MAX_REQUEST_BYTES as MAX_PROJECTION_SOURCE_REQUEST_BYTES,
    REQUEST_SCHEMA as PROJECTION_SOURCE_REQUEST_SCHEMA,
    REQUEST_SCHEMA_V1 as PROJECTION_SOURCE_REQUEST_SCHEMA_V1,
    REQUEST_SCHEMA_V2 as PROJECTION_SOURCE_REQUEST_SCHEMA_V2,
    RESPONSE_SCHEMA as PROJECTION_SOURCE_RESPONSE_SCHEMA,
    RESPONSE_SCHEMA_V1 as PROJECTION_SOURCE_RESPONSE_SCHEMA_V1,
    RESPONSE_SCHEMA_V2 as PROJECTION_SOURCE_RESPONSE_SCHEMA_V2,
    ProjectionSourceProviderError,
    ProjectionSourceRequestError,
    parse_projection_source_request,
    resolve_projection_sources,
)
from graph_window import (
    CLUSTER_SPECS as GRAPH_WINDOW_CLUSTERS,
    MAX_MEMBERS as MAX_GRAPH_WINDOW_MEMBERS,
    MAX_REQUEST_BYTES as MAX_GRAPH_WINDOW_REQUEST_BYTES,
    RESPONSE_SCHEMA as GRAPH_WINDOW_RESPONSE_SCHEMA,
    GraphWindowError,
    canonical_json as graph_window_canonical_json,
    cluster_for_id as graph_window_cluster_for_id,
    cluster_id as graph_window_cluster_id,
    cluster_intersects as graph_window_cluster_intersects,
    decode_cursor as decode_graph_window_cursor,
    encode_cursor as encode_graph_window_cursor,
    parse_request as parse_graph_window_request,
)
from canvas_contract import (
    CanvasContractError,
    SNAPSHOT_SCHEMA as CANVAS_SNAPSHOT_SCHEMA,
    apply_commands as apply_canvas_commands,
    canonical_hash as canvas_request_hash,
    normalize_commands as normalize_canvas_commands,
    normalize_snapshot as normalize_canvas_snapshot,
    snapshot_hash as canvas_snapshot_hash,
)
from conversation_dag import (
    ConversationContractError,
    build_list_response as build_conversation_list_response,
    build_read_projection as build_conversation_read_projection,
    build_turn_resolution as build_conversation_turn_resolution,
    content_hash as conversation_turn_content_hash,
    decode_list_cursor as decode_conversation_list_cursor,
    exact_reference as exact_conversation_reference,
    next_content_hash as next_conversation_content_hash,
    normalize_create as normalize_conversation_create,
    normalize_turn_operation as normalize_conversation_turn_operation,
    workspace_id as normalize_conversation_workspace_id,
)
from durable_ingestion import (
    IMPORT_SCHEMA as DOCUMENT_IMPORT_SCHEMA,
    MAX_DOCX_BYTES,
    MAX_DOCUMENT_BYTES,
    MAX_AUDIO_ORIGINAL_BYTES,
    RASTER_IMAGE_MEDIA_TYPES,
    TRANSFORM_SCHEMA as DOCUMENT_TRANSFORM_SCHEMA,
    IngestionContractError,
    audio_original_candidate,
    audio_original_manifest,
    decode_import_metadata,
    decode_raster_image_manifest,
    docx_candidate,
    canonical_json as ingestion_canonical_json,
    fallback_plugin_for_filename,
    import_request_hash,
    media_type as ingestion_media_type,
    normalize_display_filename,
    normalize_raster_image_manifest,
    normalize_audio_original_manifest,
    representation_content_sha256,
    sha256_bytes,
    _raster_magic,
    transform_request_hash,
    validate_docx_package,
)
from ingestion_plan_registry import (
    ingestion_plan_expected_source_kind,
    resolve_ingestion_plan_claim,
    resolve_stored_ingestion_plan_evidence,
)
from formal_project_package import (
    MAX_FORMAL_PROJECT_PACKAGE_ENVELOPE_BYTES,
    FormalProjectPackageError,
    parse_formal_project_package_envelope,
)
from document_transform_adapters import (
    DOCLING_ASYNC_TIMEOUT_SECONDS,
    DOCLING_IMPLEMENTATION_ID,
    MARKITDOWN_IMPLEMENTATION_ID,
    PLAIN_TEXT_IMPLEMENTATION_ID,
    TRANSFORM_TIMEOUT_SECONDS,
    document_transform_adapter_fingerprint,
    execute_document_transform_adapter,
)
from document_anchors import (
    DOCUMENT_ANCHOR_SCHEMA_ID,
    DocumentAnchorContractError,
    canonical_anchor_json,
    create_document_anchor,
    is_document_anchor_text_media_type,
)
from document_chunks import (
    CHUNK_MANIFEST_SCHEMA_ID,
    CHUNK_SCHEMA_ID,
    canonical_chunk_json,
    current_document_chunker,
    materialize_document_chunks,
)
from document_search import (
    DEFAULT_LIMIT as DEFAULT_DOCUMENT_SEARCH_LIMIT,
    DocumentSearchContractError,
    SEARCH_SCHEMA_ID as DOCUMENT_SEARCH_SCHEMA_ID,
    bounded_search_result_text,
    bounded_search_selector,
    normalize_document_search_limit,
    normalize_document_search_query,
    plain_search_snippet,
)
from document_marks import (
    DOCUMENT_MARK_SCHEMA_ID,
    MARK_KINDS,
    DocumentMarkContractError,
    document_mark_content_hash,
    document_mark_request_hash,
    normalize_document_mark_state,
)
from share_bundle import (
    BUNDLE_SCHEMAS as SHARE_BUNDLE_SCHEMAS,
    ShareBundleError,
    build_canvas_bundle,
    build_canvas_conversation_bundle,
    build_node_bundle,
    build_object_bundle,
    redacted_conversation_payload,
    request_hash as share_bundle_request_hash,
    validate_create_request as validate_share_bundle_create_request,
)
from conversation_markdown_export import (
    ConversationMarkdownExportError,
    ConversationMarkdownExportTooLarge,
    build_conversation_markdown_export,
)

log = logging.getLogger("galaxy-brain-api")

DEFAULT_ITEM_LIMIT = 200
MAX_ITEM_LIMIT = 1000
MAX_PAPER_DOCUMENT_BYTES = 100_000_000
ARXIV_FETCH_PLAN_CLAIM = {
    "id": "arxiv.fetch-default",
    "version": "1.0.0",
    "contentSha256": "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a",
}
MAX_REFERENT_RESOLVER_RESPONSE_BYTES = 262_144
MAX_REFERENT_RESOLUTION_REFERENCES = 128
REFERENT_RESOLVER_TIMEOUT_SECONDS = 4
OBJECT_REFERENCE_RESOLVER_URL = os.environ.get("GB_OBJECT_REFERENCE_RESOLVER_URL", "").strip()
OBJECT_REFERENCE_RESOLVER_TOKEN = os.environ.get("GB_OBJECT_REFERENCE_RESOLVER_TOKEN", "").strip()
# One leased attempt may wait for the asynchronous Docling task, make a
# fallback converter call, then still needs time to persist immutable
# representations and receipts. Two regular converter deadlines of slack keep
# a second worker from reclaiming the attempt during result fetch or fallback.
TRANSFORM_LEASE_SECONDS = DOCLING_ASYNC_TIMEOUT_SECONDS + TRANSFORM_TIMEOUT_SECONDS * 2
TRANSFORM_MAX_CONCURRENCY = 4
_TRANSFORM_SEMAPHORE = threading.BoundedSemaphore(TRANSFORM_MAX_CONCURRENCY)
MAX_DOCUMENT_ANCHOR_BODY_BYTES = 131_072
MAX_DOCUMENT_ANCHOR_TEXT_BYTES = 2 * 1024 * 1024
MAX_DOCUMENT_MARK_BODY_BYTES = 131_072
MAX_AGENT_ANCHOR_CREATE_BODY_BYTES = 65_536
MAX_SHARE_BUNDLE_CREATE_BODY_BYTES = 16_384
MAX_CONVERSATION_PORTABLE_CONTENT_BYTES = 8 * 1024 * 1024


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    _startup()
    yield


@dataclass(frozen=True)
class IdentityContext:
    tenant_id: str
    principal_id: str
    principal_kind: str
    nostr_pubkey: Optional[str] = None
    role: Optional[str] = None


_request_identity: ContextVar[Optional[IdentityContext]] = ContextVar(
    "galaxy_request_identity",
    default=None,
)


def require_identity(request: Request) -> Optional[IdentityContext]:
    """Return the identity already authenticated by request middleware."""
    if request.url.path == "/health":
        return None
    identity = _request_identity.get()
    if identity is None:
        raise HTTPException(status_code=401, detail="Missing authenticated tenant principal")
    return identity


app = FastAPI(
    title="Galaxy Brain ELN API",
    description="Experiment and hypothesis management for the Galaxy Brain ELN",
    version="0.1.0",
    lifespan=lifespan,
    dependencies=[Depends(require_identity)],
)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_local = threading.local()

DB_HOST = os.environ.get("GB_DB_HOST", "localhost")
DB_PORT = int(os.environ.get("GB_DB_PORT", "5433"))
DB_NAME = os.environ.get("GB_DB_NAME", "galaxy_brain")
DB_USER = os.environ.get("GB_DB_USER", "galaxy_brain")
DB_PASS = os.environ.get("GB_DB_PASS", "")
DB_URL = os.environ.get("GB_DATABASE_URL", "").strip()
# Trusted proof verification uses a separate login that is a member of the
# NOLOGIN gb_proof_verifier authority. It never serves ordinary requests.
PROOF_VERIFIER_DB_URL = os.environ.get("GB_PROOF_VERIFIER_DATABASE_URL", "").strip()
PIPELINE_ROOT = os.environ.get("PIPELINE_ROOT", "")
PROXY_TOKEN = os.environ.get("GALAXY_API_PROXY_TOKEN", "")
FILESYSTEM_ROOTS_BY_TENANT = parse_tenant_filesystem_roots(
    os.environ.get("GB_DATASOURCE_ALLOWED_ROOTS_BY_TENANT", "")
)


@app.middleware("http")
async def require_proxy_token(request: Request, call_next):
    """Only accept application traffic from the authenticated web proxy."""
    if request.url.path == "/health":
        return await call_next(request)
    supplied = request.headers.get("X-GB-Proxy-Token", "")
    if not PROXY_TOKEN:
        return JSONResponse(status_code=503, content={"detail": "API proxy token is not configured"})
    if not secrets.compare_digest(supplied, PROXY_TOKEN):
        return JSONResponse(status_code=401, content={"detail": "Invalid API proxy credentials"})
    tenant_header = request.headers.get("X-GB-Tenant-ID", "")
    principal_header = request.headers.get("X-GB-Principal-ID", "")
    principal_kind = request.headers.get("X-GB-Principal-Kind", "")
    nostr_pubkey = request.headers.get("X-GB-Nostr-Pubkey", "")
    if not tenant_header or not principal_header or not principal_kind:
        return JSONResponse(status_code=401, content={"detail": "Missing authenticated tenant principal"})
    if nostr_pubkey and not re.fullmatch(r"[0-9a-f]{64}", nostr_pubkey):
        return JSONResponse(status_code=400, content={"detail": "Invalid Nostr public key"})
    if principal_kind == "agent" and not nostr_pubkey:
        return JSONResponse(status_code=401, content={"detail": "Missing authenticated agent Nostr key"})
    try:
        tenant_id = str(UUID(tenant_header))
        principal_id = str(UUID(principal_header))
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Invalid tenant or principal identifier"})
    if principal_kind not in {"human", "agent", "service"}:
        return JSONResponse(status_code=400, content={"detail": "Invalid principal kind"})

    identity = IdentityContext(tenant_id, principal_id, principal_kind, nostr_pubkey or None)
    context_token = _request_identity.set(identity)
    try:
        cur = get_conn().cursor()
        cur.execute(
            """
            SELECT m.role
            FROM app_principals p
            JOIN app_tenant_memberships m ON m.principal_id = p.id
            JOIN app_tenants t ON t.id = m.tenant_id
            LEFT JOIN app_agents a ON a.principal_id = p.id AND a.tenant_id = m.tenant_id
            WHERE p.id = %s AND m.tenant_id = %s
              AND p.kind = %s AND p.status = 'active' AND t.status = 'active'
              AND (%s <> 'agent' OR a.nostr_pubkey = %s)
            """,
            (principal_id, tenant_id, principal_kind, principal_kind, nostr_pubkey),
        )
        membership = cur.fetchone()
        if membership is None:
            return JSONResponse(status_code=401, content={"detail": "Inactive or unknown tenant principal"})
        _request_identity.set(IdentityContext(
            tenant_id,
            principal_id,
            principal_kind,
            nostr_pubkey or None,
            membership["role"],
        ))
        return await call_next(request)
    finally:
        _request_identity.reset(context_token)


def _make_conn():
    connection_args = {"cursor_factory": psycopg2.extras.RealDictCursor}
    if DB_URL:
        conn = psycopg2.connect(DB_URL, **connection_args)
    else:
        conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
            user=DB_USER, password=DB_PASS, **connection_args,
        )
    conn.autocommit = True
    return conn


def get_conn():
    conn = getattr(_local, "conn", None)
    if conn is None or conn.closed:
        conn = _make_conn()
        _local.conn = conn
    else:
        try:
            conn.cursor().execute("SELECT 1")
        except Exception:
            conn = _make_conn()
            _local.conn = conn
    identity = _request_identity.get()
    cur = conn.cursor()
    cur.execute(
        "SELECT set_config('app.tenant_id', %s, false)",
        (identity.tenant_id if identity else "",),
    )
    cur.execute(
        "SELECT set_config('app.principal_id', %s, false)",
        (identity.principal_id if identity else "",),
    )
    return conn


def _make_proof_verifier_conn():
    conn = psycopg2.connect(
        PROOF_VERIFIER_DB_URL, cursor_factory=psycopg2.extras.RealDictCursor
    )
    conn.autocommit = True
    return conn


def get_proof_verifier_conn():
    """Return the verifier-authority connection bound to the request identity."""
    if not PROOF_VERIFIER_DB_URL:
        raise RuntimeError("trusted proof verifier authority is not configured")
    conn = getattr(_local, "proof_verifier_conn", None)
    if conn is None or conn.closed:
        conn = _make_proof_verifier_conn()
        _local.proof_verifier_conn = conn
    else:
        try:
            conn.cursor().execute("SELECT 1")
        except Exception:
            conn = _make_proof_verifier_conn()
            _local.proof_verifier_conn = conn
    identity = _request_identity.get()
    cur = conn.cursor()
    cur.execute(
        "SELECT set_config('app.tenant_id', %s, false)",
        (identity.tenant_id if identity else "",),
    )
    cur.execute(
        "SELECT set_config('app.principal_id', %s, false)",
        (identity.principal_id if identity else "",),
    )
    return conn


@contextmanager
def _transaction(conn):
    """Run a bounded transaction on the request thread's dedicated connection."""
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        yield cur
    except BaseException:
        cur.execute("ROLLBACK")
        raise
    else:
        cur.execute("COMMIT")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def row_to_dict(row) -> dict:
    """Convert RealDictRow to a JSON-safe plain dict."""
    if row is None:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, datetime):
            d[k] = v.isoformat()
        elif isinstance(v, UUID):
            d[k] = str(v)
    return d


SURFACE_PROVENANCE_FIELDS = {
    "source",
    "model",
    "profile",
    "run_id",
    "message_id",
    "prompt_hash",
    "evidence_refs",
    "ham_refs",
    "actor_ref",
    "note",
}


def _surface_uuid(surface_id: str) -> str:
    try:
        return str(UUID(surface_id))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid surface identifier") from error


def _task_plan_uuid(task_plan_id: str) -> str:
    try:
        return str(UUID(task_plan_id))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid task plan identifier") from error


def _ham_task_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,199}", normalized):
        raise HTTPException(status_code=422, detail="HAM task identifier is invalid")
    return normalized


def _task_plan_spec(value: Any) -> dict:
    try:
        return validate_task_plan_spec(value)
    except TaskPlanContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _task_plan_title(value: str) -> str:
    normalized = value.strip()
    if not 1 <= len(normalized) <= 200:
        raise HTTPException(status_code=422, detail="Task plan title must contain 1-200 characters")
    return normalized


def _task_plan_hash(title: str, spec: dict, provenance: dict) -> str:
    return _surface_request_hash({"title": title, "spec": spec, "provenance": provenance})


def _get_task_plan_or_404(task_plan_id: str) -> dict:
    normalized_id = _task_plan_uuid(task_plan_id)
    cur = get_conn().cursor()
    cur.execute("SELECT * FROM gb_task_plans WHERE id = %s", (normalized_id,))
    plan = row_to_dict(cur.fetchone())
    if plan is None:
        raise HTTPException(status_code=404, detail="Task plan not found")
    return plan


def _replayed_task_plan(
    cur,
    task_plan_id: str,
    idempotency_key: str,
    request_hash: str,
    current: Optional[dict] = None,
) -> Optional[dict]:
    cur.execute(
        "SELECT task_plan_id, request_hash FROM gb_task_plan_revisions WHERE idempotency_key = %s",
        (idempotency_key,),
    )
    replay = row_to_dict(cur.fetchone())
    if not replay:
        return None
    if str(replay["task_plan_id"]) != task_plan_id or replay["request_hash"] != request_hash:
        raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
    replayed = current if current is not None else _get_task_plan_or_404(task_plan_id)
    replayed["replayed"] = True
    return replayed


def _canonical_uuid(value: str, label: str) -> str:
    try:
        return str(UUID(value))
    except (TypeError, ValueError, AttributeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid {label} identifier") from error


def _proof_value(callable_value, *args, conflict: bool = False, **kwargs):
    try:
        return callable_value(*args, **kwargs)
    except ProofWorkStateConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ProofWorkStateError as error:
        status_code = 409 if conflict else 422
        raise HTTPException(status_code=status_code, detail=str(error)) from error


def _proof_workspace_key(value: Any) -> str:
    return _proof_value(proof_identifier, value, "workspace_id", workspace=True)


def _proof_graph_digest(value: Any) -> str:
    return _proof_value(proof_sha256, value, "proof graph content_sha256")


def _proof_verification_set_digest(value: Any, label: str = "content_sha256") -> str:
    return _proof_value(proof_sha256, value, f"proof verification set {label}")


def _proof_graph_summary(row, *, replayed: bool = False) -> dict:
    record = row_to_dict(row)
    result = {
        "schemaId": "gb.proof-graph.summary.v1",
        "registrationId": record["id"],
        "graphId": record["graph_id"],
        "graphKind": record["graph_kind"],
        "title": record["title"],
        "contentSha256": record["content_sha256"],
        "byteSize": record["byte_size"],
        "targetCount": record["target_count"],
        "relationCount": record["relation_count"],
        "registeredByPrincipalId": record["registered_by_principal_id"],
        "registeredByNostrPubkey": record["registered_by_nostr_pubkey"],
        "registeredAt": record["registered_at"],
    }
    if replayed:
        result["replayed"] = True
    return result


def _formal_project_package_summary(row, *, replayed: bool = False) -> dict:
    record = row_to_dict(row)
    result = {
        "schemaId": "gb.formal-project-package.summary.v1",
        "registrationId": record["id"],
        "projectId": record["project_id"],
        "repository": record["repository"],
        "commit": record["commit_oid"],
        "tree": record["tree_oid"],
        "environment": {
            "leanToolchain": record["lean_toolchain"],
            "mathlibRevision": record["mathlib_revision"],
        },
        "conversionProfile": record["conversion_profile"],
        "manifestSha256": record["manifest_sha256"],
        "proofGraphRef": {
            "graph_id": record["repository_field_graph_id"],
            "content_sha256": record["repository_field_dag_sha256"],
        },
        "artifacts": {
            "formalGraph": {"materialized": False, "sha256": record["formal_graph_sha256"]},
            "repositoryGraph": {"materialized": False, "sha256": record["repository_graph_sha256"]},
            "authoredConceptualDag": {"materialized": True, "sha256": record["authored_dag_sha256"]},
            "repositoryFieldDag": {"materialized": True, "sha256": record["repository_field_dag_sha256"]},
            "correspondence": {"materialized": True, "sha256": record["correspondence_sha256"]},
        },
        "registeredByPrincipalId": record["registered_by_principal_id"],
        "registeredByNostrPubkey": record["registered_by_nostr_pubkey"],
        "registeredAt": record["registered_at"],
    }
    if replayed:
        result["replayed"] = True
    return result


def _proof_verification_set_summary(row, *, replayed: bool = False) -> dict:
    record = row_to_dict(row)
    result = {
        "schemaId": "gb.proof-verification-set.summary.v1",
        "registrationId": record["id"],
        "graphRef": {
            "graph_id": record["graph_id"],
            "content_sha256": record["graph_content_sha256"],
        },
        "contentSha256": record["content_sha256"],
        "byteSize": record["byte_size"],
        "itemCount": record["item_count"],
        "registeredByPrincipalId": record["registered_by_principal_id"],
        "registeredByNostrPubkey": record["registered_by_nostr_pubkey"],
        "registeredAt": record["registered_at"],
    }
    if replayed:
        result["replayed"] = True
    return result


async def _read_proof_graph_registration(request: Request):
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_PROOF_GRAPH_BYTES:
            raise HTTPException(status_code=413, detail="Proof graph exceeds 16 MiB")
        chunks.append(chunk)
    content = b"".join(chunks)
    try:
        return parse_proof_graph_bytes(content)
    except ProofGraphRegistryError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


async def _read_formal_project_package_envelope(request: Request) -> bytes:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_FORMAL_PROJECT_PACKAGE_ENVELOPE_BYTES:
            raise HTTPException(status_code=413, detail="Formal project package exceeds its byte bound")
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_proof_mission_intent(request: Request) -> dict[str, Any]:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_MISSION_INTENT_BYTES:
            raise HTTPException(status_code=413, detail="Proof mission intent exceeds 64 KiB")
        chunks.append(chunk)
    try:
        return parse_mission_intent_bytes(b"".join(chunks))
    except ProofMissionContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


async def _read_proof_verification_set_registration(request: Request):
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_PROOF_VERIFICATION_SET_BYTES:
            raise HTTPException(status_code=413, detail="Proof verification set exceeds 16 MiB")
        chunks.append(chunk)
    try:
        return await run_in_threadpool(
            parse_proof_verification_set_bytes, b"".join(chunks)
        )
    except ProofVerificationSetError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@dataclass(frozen=True)
class RegisteredProofVerifierAdapter:
    implementation_sha256: str
    verify: Any


# A structural receipt envelope is not proof. Only server-side adapters that
# authenticate or replay the exact opaque receipt bytes are dispatched here,
# and each must match its migration-registered implementation digest. Hyades
# remains a disabled placeholder. Explicit empty baselines remain valid.
PROOF_VERIFIER_ADAPTERS: dict[
    tuple[str, str], RegisteredProofVerifierAdapter
] = {
    (PROOFS_BLAH_DEV_ADAPTER_ID, PROOFS_BLAH_DEV_ADAPTER_VERSION): (
        RegisteredProofVerifierAdapter(
            implementation_sha256=proofs_blah_dev_adapter_implementation_sha256(),
            verify=PROOFS_BLAH_DEV_ADAPTER,
        )
    ),
}


MAX_PROOF_SUBJECT_DECLARATIONS = 128
MAX_PROOF_SUBJECT_DECLARATION_UTF16_UNITS = 512
MAX_PROOF_SUBJECT_JSON_BYTES = 60_000
MAX_PROOF_MISSION_ACTIVATION_BYTES = 131_072


def _activation_unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProofMissionActivationError(
                "Duplicate proof mission activation fields are not allowed"
            )
        result[key] = value
    return result


def _insert_exact_json_artifact(
    cur,
    *,
    tenant_id: str,
    principal_id: str,
    content: bytes,
    content_sha256: str,
) -> str:
    """Insert or reconcile one exact content-addressed JSON artifact."""
    if hashlib.sha256(content).hexdigest() != content_sha256:
        raise HTTPException(status_code=409, detail="Artifact content hash mismatch")
    cur.execute(
        """INSERT INTO gb_artifacts (
             tenant_id, content_sha256, byte_size, media_type,
             content_bytes, created_by_principal_id
           ) VALUES (%s, %s, %s, 'application/json', %s, %s)
           ON CONFLICT (tenant_id, content_sha256) DO NOTHING
           RETURNING id""",
        (
            tenant_id,
            content_sha256,
            len(content),
            psycopg2.Binary(content),
            principal_id,
        ),
    )
    inserted = cur.fetchone()
    if inserted is not None:
        return str(inserted["id"])
    cur.execute(
        """SELECT id, byte_size, media_type, content_bytes
             FROM gb_artifacts
            WHERE tenant_id = %s AND content_sha256 = %s""",
        (tenant_id, content_sha256),
    )
    existing = cur.fetchone()
    if (
        existing is None
        or existing["byte_size"] != len(content)
        or existing["media_type"] != "application/json"
        or bytes(existing["content_bytes"]) != content
    ):
        raise HTTPException(status_code=409, detail="Artifact content hash collision")
    return str(existing["id"])


def _persist_passive_proof_graph(cur, registration, identity: IdentityContext):
    if registration.graph_kind != "repository-field":
        raise HTTPException(
            status_code=422,
            detail=(
                "Claimable proof graphs require server-authoritative activation; "
                "the generic registry accepts passive repository-field graphs only"
            ),
        )
    artifact_id = _insert_exact_json_artifact(
        cur,
        tenant_id=identity.tenant_id,
        principal_id=identity.principal_id,
        content=registration.content_bytes,
        content_sha256=registration.content_sha256,
    )
    cur.execute(
        """INSERT INTO gb_proof_graphs (
             tenant_id, graph_id, graph_kind, title, artifact_id, content_sha256,
             graph_json, target_ids, node_ref_ids, target_count,
             relation_count, registered_by_principal_id,
             registered_by_nostr_pubkey
           ) VALUES (%s, %s, %s, %s, %s, %s,
                     convert_from(%s, 'UTF8')::jsonb,
                     %s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, content_sha256) DO NOTHING
           RETURNING id""",
        (
            identity.tenant_id, registration.graph_id, registration.graph_kind,
            registration.title, artifact_id, registration.content_sha256,
            psycopg2.Binary(registration.content_bytes), list(registration.target_ids),
            list(registration.node_ref_ids), len(registration.target_ids),
            registration.relation_count, identity.principal_id, identity.nostr_pubkey,
        ),
    )
    created = cur.fetchone()
    cur.execute(
        """SELECT graph.id, graph.graph_id, graph.graph_kind, graph.title,
                  graph.artifact_id, graph.content_sha256, artifact.byte_size,
                  graph.target_count, graph.relation_count,
                  graph.registered_by_principal_id,
                  graph.registered_by_nostr_pubkey, graph.registered_at,
                  graph.target_ids, graph.node_ref_ids
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s AND graph.content_sha256 = %s""",
        (identity.tenant_id, registration.content_sha256),
    )
    existing = cur.fetchone()
    if existing is None:
        raise HTTPException(status_code=409, detail="Proof graph registration could not be reconciled")
    if (
        str(existing["artifact_id"]) != str(artifact_id)
        or list(existing["target_ids"]) != list(registration.target_ids)
        or list(existing["node_ref_ids"]) != list(registration.node_ref_ids)
        or existing["graph_id"] != registration.graph_id
        or existing["graph_kind"] != registration.graph_kind
        or existing["title"] != registration.title
        or existing["target_count"] != len(registration.target_ids)
        or existing["relation_count"] != registration.relation_count
    ):
        raise HTTPException(status_code=409, detail="Proof graph content hash collision")
    return existing, created is None


def _reject_activation_non_json_number(value: str):
    raise ProofMissionActivationError(
        f"Non-finite JSON number {value} is not allowed"
    )


async def _read_proof_mission_activation_request(request: Request) -> dict[str, Any]:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_PROOF_MISSION_ACTIVATION_BYTES:
            raise HTTPException(
                status_code=413, detail="Proof mission activation exceeds 128 KiB"
            )
        chunks.append(chunk)
    exact_bytes = b"".join(chunks)
    try:
        value = json.loads(
            exact_bytes.decode("utf-8", "strict"),
            object_pairs_hook=_activation_unique_object,
            parse_constant=_reject_activation_non_json_number,
        )
        if not isinstance(value, dict):
            raise ProofMissionActivationError(
                "Proof mission activation must be an object"
            )
        allowed = {
            "schema_id", "mission_intent", "expected_mission_content_sha256",
            "verification_set_ref", "workspace_id", "idempotency_key",
        }
        unknown = sorted(set(value) - allowed)
        missing = sorted(allowed - set(value))
        if unknown:
            raise ProofMissionActivationError(
                f"Proof mission activation contains unknown field {unknown[0]}"
            )
        if missing:
            raise ProofMissionActivationError(
                f"Proof mission activation.{missing[0]} is required"
            )
        if value["schema_id"] != "galaxy.proof-mission-activation-request.v1":
            raise ProofMissionActivationError(
                "Proof mission activation schema_id is unsupported"
            )
        intent = value["mission_intent"]
        if not isinstance(intent, dict):
            raise ProofMissionActivationError(
                "Proof mission activation mission_intent must be an object"
            )
        intent_bytes = json.dumps(
            intent,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
        if len(intent_bytes) > MAX_MISSION_INTENT_BYTES:
            raise ProofMissionActivationError(
                "Proof mission activation mission_intent exceeds 64 KiB"
            )
        intent = parse_mission_intent_bytes(intent_bytes)
        verification_ref = value["verification_set_ref"]
        if not isinstance(verification_ref, dict):
            raise ProofMissionActivationError(
                "Proof mission activation verification_set_ref must be an object"
            )
        if set(verification_ref) != {
            "graph_id", "graph_content_sha256", "content_sha256"
        }:
            raise ProofMissionActivationError(
                "Proof mission activation verification_set_ref fields are invalid"
            )
        normalized_verification_ref = {
            "graph_id": _proof_value(
                proof_identifier,
                verification_ref.get("graph_id"),
                "verification_set_ref.graph_id",
            ),
            "graph_content_sha256": _proof_graph_digest(
                verification_ref.get("graph_content_sha256")
            ),
            "content_sha256": _proof_verification_set_digest(
                verification_ref.get("content_sha256")
            ),
        }
        expected_mission_content_sha256 = _proof_graph_digest(
            value["expected_mission_content_sha256"]
        )
        workspace_id = _proof_workspace_key(value["workspace_id"])
        idempotency = _proof_value(
            proof_idempotency_key, value["idempotency_key"]
        )
    except HTTPException:
        raise
    except (
        UnicodeError,
        json.JSONDecodeError,
        RecursionError,
        TypeError,
        ValueError,
        ProofMissionContractError,
        ProofMissionActivationError,
    ) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    request_value = {
        "schema_id": value["schema_id"],
        "mission_intent": intent,
        "expected_mission_content_sha256": expected_mission_content_sha256,
        "verification_set_ref": normalized_verification_ref,
        "workspace_id": workspace_id,
    }
    return {
        **request_value,
        "idempotency_key": idempotency,
        "exact_bytes": exact_bytes,
        "request_hash": _surface_request_hash(request_value),
        "mission_intent_bytes": intent_bytes,
        "mission_intent_sha256": hashlib.sha256(intent_bytes).hexdigest(),
    }


def _canonical_proof_subject_text(value, label: str, max_utf16_units: int) -> str:
    if not isinstance(value, str) or not value:
        raise ProofVerificationSetError(f"{label} is required")
    if value != value.strip():
        raise ProofVerificationSetError(f"{label} must use canonical whitespace")
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise ProofVerificationSetError(f"{label} contains invalid Unicode") from error
    if units > max_utf16_units:
        raise ProofVerificationSetError(f"{label} exceeds its safe size bound")
    return value


def _proof_graph_target_index(graph_artifact: dict) -> dict[str, dict]:
    targets = graph_artifact.get("targets")
    if not isinstance(targets, list):
        raise ProofVerificationSetError("Proof graph targets must be an array")
    indexed: dict[str, dict] = {}
    for target in targets:
        if not isinstance(target, dict):
            raise ProofVerificationSetError("Proof graph targets must be objects")
        target_id = target.get("target_id")
        if not isinstance(target_id, str) or not target_id:
            raise ProofVerificationSetError("Proof graph target_id is required")
        if target_id in indexed:
            raise ProofVerificationSetError(f"Proof graph target {target_id} is duplicated")
        indexed[target_id] = target
    return indexed


def _expected_proof_subject(
    registration, item, graph_artifact: dict, *, target_index=None
):
    """Derive the only adapter subject allowed by the exact graph bytes."""
    revision = graph_artifact.get("revision")
    if not isinstance(revision, dict):
        raise ProofVerificationSetError(
            "Proof graph revision provenance is required for verified evidence"
        )
    required_revision = (
        "repository", "commit", "lean_toolchain", "mathlib_revision"
    )
    revision_limits = {
        "repository": 512,
        "commit": 64,
        "lean_toolchain": 200,
        "mathlib_revision": 64,
    }
    try:
        normalized_revision = {
            name: _canonical_proof_subject_text(
                revision.get(name), f"Proof graph revision {name}", revision_limits[name]
            )
            for name in required_revision
        }
    except ProofVerificationSetError as error:
        raise ProofVerificationSetError(
            f"Proof graph revision provenance is invalid for verified evidence: {error}"
        ) from error
    if target_index is None:
        target_index = _proof_graph_target_index(graph_artifact)
    target = target_index.get(item.node_id)
    binding = None if target is None else target.get("formal_binding")
    declaration_ids = None if not isinstance(binding, dict) else binding.get("declaration_ids")
    if (
        not isinstance(binding, dict)
        or binding.get("declaration_equivalence_claimed") is not True
        or binding.get("binding_kind") not in ("declaration", "declaration-bundle")
        or not isinstance(declaration_ids, list)
        or not declaration_ids
        or len(declaration_ids) > MAX_PROOF_SUBJECT_DECLARATIONS
    ):
        raise ProofVerificationSetError(
            "Proof graph target requires unambiguous formal declaration bindings"
        )
    normalized_declarations = []
    for value in declaration_ids:
        try:
            normalized_declarations.append(_canonical_proof_subject_text(
                value,
                "Proof graph declaration identifier",
                MAX_PROOF_SUBJECT_DECLARATION_UTF16_UNITS,
            ))
        except ProofVerificationSetError as error:
            raise ProofVerificationSetError(
                "Proof graph target requires unambiguous formal declaration bindings: "
                f"{error}"
            ) from error
    if len(set(normalized_declarations)) != len(normalized_declarations):
        raise ProofVerificationSetError(
            "Proof graph target requires unambiguous formal declaration bindings"
        )
    subject_json = {
        "graph_id": registration.graph_id,
        "graph_content_sha256": registration.graph_content_sha256,
        "node_id": item.node_id,
        "declaration_ids": normalized_declarations,
        "source_repository": normalized_revision["repository"],
    }
    if len(json.dumps(
        subject_json, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")) > MAX_PROOF_SUBJECT_JSON_BYTES:
        raise ProofVerificationSetError(
            "Proof graph declaration bindings exceed the safe subject size bound"
        )
    return ExpectedProofSubject(
        graph_id=registration.graph_id,
        graph_content_sha256=registration.graph_content_sha256,
        node_id=item.node_id,
        declaration_ids=tuple(normalized_declarations),
        source_repository=normalized_revision["repository"],
        source_commit=normalized_revision["commit"],
        lean_toolchain=normalized_revision["lean_toolchain"],
        mathlib_revision=normalized_revision["mathlib_revision"],
    )


def _run_proof_verifier_adapters(registration, graph_artifact: dict):
    adapter_items = []
    for item_index, item in enumerate(registration.items):
        adapter_key = (item.adapter_id, item.adapter_version)
        adapter = PROOF_VERIFIER_ADAPTERS.get(adapter_key)
        if adapter is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Proof verification adapter "
                    f"{adapter_key[0]}@{adapter_key[1]} is not enabled; "
                    "only an explicit empty verification baseline can be registered"
                ),
            )
        adapter_items.append((item_index, item, adapter))
    if not adapter_items:
        return ()

    accepted = []
    target_index = _proof_graph_target_index(graph_artifact)
    for item_index, item, adapter in adapter_items:
        try:
            subject = _expected_proof_subject(
                registration, item, graph_artifact, target_index=target_index
            )
            bound = run_verifier_adapter(
                registration, item, subject, adapter.verify
            )
        except ProofVerificationSetError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        accepted.append((item_index, item, bound, subject, adapter))
    return tuple(accepted)


def _proof_graph_ref(value: Any) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="graph_ref must be an object")
    return {
        "graph_id": _proof_value(proof_identifier, value.get("graph_id"), "graph_ref.graph_id"),
        "content_sha256": _proof_value(
            proof_sha256, value.get("content_sha256"), "graph_ref.content_sha256"
        ),
    }


def _proof_workspace_or_404(
    workspace_key: str,
    tenant_id: str,
    *,
    cur=None,
    for_update: bool = False,
) -> dict:
    cursor = cur or get_conn().cursor()
    query = "SELECT * FROM gb_proof_workspaces WHERE tenant_id = %s AND workspace_key = %s"
    if for_update:
        query += " FOR UPDATE"
    cursor.execute(query, (tenant_id, _proof_workspace_key(workspace_key)))
    workspace = row_to_dict(cursor.fetchone())
    if workspace is None:
        raise HTTPException(status_code=404, detail="Proof work workspace not found")
    return workspace


def _assert_proof_graph_ref(workspace: dict, graph_ref: dict) -> None:
    if (
        workspace["graph_id"] != graph_ref["graph_id"]
        or workspace["graph_content_sha256"] != graph_ref["content_sha256"]
    ):
        raise HTTPException(status_code=409, detail="Proof work state is bound to a different graph hash")


def _proof_state_response(workspace: dict, *, cur=None, replayed: bool = False) -> dict:
    cursor = cur or get_conn().cursor()
    cursor.execute(
        """
        SELECT item.state,
               EXISTS (
                 SELECT 1
                   FROM gb_proof_work_verifications AS verification
                  WHERE verification.tenant_id = item.tenant_id
                    AND verification.workspace_id = item.workspace_id
                    AND verification.node_id = item.node_id
                    AND verification.candidate_sha256 =
                        item.state #>> '{proof,candidate_sha256}'
               ) AS trusted_verification
          FROM gb_proof_work_items AS item
         WHERE item.workspace_id = %s
         ORDER BY item.node_id
        """,
        (workspace["id"],),
    )
    items = []
    for row in cursor.fetchall():
        state = json.loads(json.dumps(row["state"]))
        proof = dict(state.get("proof") or {})
        if proof.get("status") == "verified" and not row.get("trusted_verification"):
            # Quarantine pre-boundary/self-asserted verification. Keep the
            # candidate visible, but never offer an impossible claim action:
            # the preserved raw state must first receive proof.supersede.
            proof["status"] = "candidate"
            proof["verification"] = None
            state["proof"] = proof
            work = dict(state.get("work") or {})
            work["status"] = "blocked"
            work["claim"] = None
            work["hyades"] = None
            work["blocker"] = (
                "Legacy verification lacks a trusted ledger record; "
                "supersede it before beginning new work"
            )
            state["work"] = work
        items.append(state)
    response = {
        "schema_id": WORK_STATE_SCHEMA,
        "workspace_id": workspace["workspace_key"],
        "graph_ref": {
            "graph_id": workspace["graph_id"],
            "content_sha256": workspace["graph_content_sha256"],
        },
        "version": workspace["current_version"],
        "updated_at": row_to_dict({"value": workspace["updated_at"]})["value"],
        "items": items,
    }
    if replayed:
        response["replayed"] = True
    return response


def _proof_transition_replay(cur, workspace_id: str, idempotency_key: str, request_hash: str):
    cur.execute(
        """
        SELECT workspace_id, request_hash
          FROM gb_proof_work_transitions
         WHERE idempotency_key = %s
        """,
        (idempotency_key,),
    )
    replay = row_to_dict(cur.fetchone())
    if not replay:
        return None
    if str(replay["workspace_id"]) != str(workspace_id) or replay["request_hash"] != request_hash:
        raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
    return replay


def _paper_tags(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 32:
        raise HTTPException(status_code=422, detail="Paper tags must be an array of at most 32 values")
    tags: list[str] = []
    for item in value:
        if not isinstance(item, str) or not 1 <= len(item.strip()) <= 80:
            raise HTTPException(status_code=422, detail="Paper tag is invalid")
        normalized = item.strip()
        if normalized.casefold() not in {tag.casefold() for tag in tags}:
            tags.append(normalized)
    return tags


def _paper_anchor(kind: str, value: Any) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Annotation anchor must be an object")
    if kind in {"highlight", "comment"} and value.get("type") == "text":
        if set(value) != {"type", "quote", "startOffset", "endOffset"}:
            raise HTTPException(status_code=422, detail="Text annotation anchor is invalid")
        quote = value.get("quote")
        start = value.get("startOffset")
        end = value.get("endOffset")
        if (
            not isinstance(quote, str) or not 1 <= len(quote) <= 5000
            or not isinstance(start, int) or isinstance(start, bool) or start < 0
            or not isinstance(end, int) or isinstance(end, bool) or end <= start or end > 10_000_000
            or end - start != len(quote.encode("utf-16-le")) // 2
        ):
            raise HTTPException(status_code=422, detail="Text annotation anchor is invalid")
    elif kind in {"highlight", "comment"} and value.get("type") == "region":
        if set(value) != {"type", "x", "y", "width", "height"}:
            raise HTTPException(status_code=422, detail="Region annotation anchor is invalid")
        for field in ("x", "y", "width", "height"):
            coordinate = value.get(field)
            if not isinstance(coordinate, (int, float)) or isinstance(coordinate, bool):
                raise HTTPException(status_code=422, detail="Region annotation anchor is invalid")
        if (
            not 0 <= value["x"] < 1 or not 0 <= value["y"] < 1
            or not 0.01 <= value["width"] <= 1 or not 0.01 <= value["height"] <= 1
            or value["x"] + value["width"] > 1.000001
            or value["y"] + value["height"] > 1.000001
        ):
            raise HTTPException(status_code=422, detail="Region annotation anchor is invalid")
    elif kind == "ink":
        if set(value) != {"type", "points", "width"} or value.get("type") != "ink":
            raise HTTPException(status_code=422, detail="Ink annotation anchor is invalid")
        points = value.get("points")
        width = value.get("width")
        if not isinstance(points, list) or not 2 <= len(points) <= 4096:
            raise HTTPException(status_code=422, detail="Ink annotation points are invalid")
        if not isinstance(width, (int, float)) or isinstance(width, bool) or not 0.1 <= width <= 50:
            raise HTTPException(status_code=422, detail="Ink annotation width is invalid")
        for point in points:
            if (
                not isinstance(point, dict) or set(point) != {"x", "y"}
                or not isinstance(point["x"], (int, float)) or isinstance(point["x"], bool)
                or not isinstance(point["y"], (int, float)) or isinstance(point["y"], bool)
                or not 0 <= point["x"] <= 1 or not 0 <= point["y"] <= 1
            ):
                raise HTTPException(status_code=422, detail="Ink annotation point is invalid")
    else:
        raise HTTPException(status_code=422, detail="Annotation kind is invalid")
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 131_072:
        raise HTTPException(status_code=422, detail="Annotation anchor exceeds the size limit")
    return json.loads(encoded)


def _paper_pdf_filename(metadata: dict) -> str:
    title = str(metadata.get("title") or "paper").strip()
    authors = metadata.get("authors")
    first_author = ""
    if isinstance(authors, list) and authors and isinstance(authors[0], dict):
        first_author = str(authors[0].get("name") or "").strip()
    published = str(metadata.get("published_at") or "")
    year = published[:4] if re.fullmatch(r"[0-9]{4}", published[:4]) else ""
    parts = [title]
    if first_author:
        parts.append(first_author)
    if year:
        parts[-1] = f"{parts[-1]} ({year})" if len(parts) > 1 else f"{title} ({year})"
    stem = " - ".join(parts)
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" .")[:180].rstrip(" .") or "paper"
    return f"{stem}.pdf"


def _paper_or_404(paper_id: str) -> dict:
    normalized_id = _canonical_uuid(paper_id, "paper")
    cur = get_conn().cursor()
    cur.execute("SELECT * FROM gb_papers WHERE id = %s", (normalized_id,))
    paper = row_to_dict(cur.fetchone())
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper


def _paper_revision_or_404(paper_id: str, revision_id: str) -> dict:
    normalized_revision = _canonical_uuid(revision_id, "paper revision")
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_paper_revisions WHERE id = %s AND paper_id = %s",
        (normalized_revision, paper_id),
    )
    revision = row_to_dict(cur.fetchone())
    if not revision:
        raise HTTPException(status_code=404, detail="Paper revision not found")
    return revision


def _paper_document_record(row, cur=None) -> Optional[dict]:
    document = row_to_dict(row)
    if not document:
        return None
    document.pop("pdf_bytes", None)
    source_id = document.pop("bridge_source_id", None)
    if source_id:
        document["durable_document"] = _document_import_record(
            cur or get_conn().cursor(), str(source_id),
        )
    else:
        document["durable_document"] = None
    return document


def _paper_byte_range(value: Optional[str], byte_size: int) -> Optional[tuple[int, int]]:
    if not value:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or (not match.group(1) and not match.group(2)):
        raise HTTPException(status_code=416, detail="Invalid paper byte range")
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else byte_size - 1
    else:
        suffix = int(match.group(2))
        if suffix <= 0:
            raise HTTPException(status_code=416, detail="Invalid paper byte range")
        start = max(0, byte_size - suffix)
        end = byte_size - 1
    if start >= byte_size or start > end:
        raise HTTPException(status_code=416, detail="Paper byte range is outside the document")
    return start, min(end, byte_size - 1)


def _surface_title(title: str) -> str:
    normalized = title.strip()
    if not 1 <= len(normalized) <= 200:
        raise HTTPException(status_code=422, detail="Surface title must contain 1-200 characters")
    return normalized


def _idempotency_key(value: str) -> str:
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail="Invalid idempotency key")
    normalized = value.strip()
    if not 8 <= len(normalized) <= 200 or any(ord(char) < 33 or ord(char) > 126 for char in normalized):
        raise HTTPException(status_code=422, detail="Invalid idempotency key")
    return normalized


def _document_import_idempotency_key(value: str) -> str:
    """Match the durable source table's deliberately narrower key alphabet."""
    normalized = _idempotency_key(value)
    if not re.fullmatch(r"[A-Za-z0-9._:-]+", normalized):
        raise HTTPException(status_code=422, detail="Invalid document import idempotency key")
    return normalized


def _document_import_client_idempotency_key(value: str) -> str:
    """Keep server-authored durable imports outside the public replay namespace."""
    normalized = _document_import_idempotency_key(value)
    if normalized.startswith("gb.internal:"):
        raise HTTPException(status_code=422, detail="Reserved document import idempotency key")
    return normalized


def _ingestion_value(callable_value, *args, **kwargs):
    try:
        return callable_value(*args, **kwargs)
    except IngestionContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _canvas_value(callable_value, *args, **kwargs):
    try:
        return callable_value(*args, **kwargs)
    except CanvasContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _canvas_uuid(value: str) -> str:
    return _canonical_uuid(value, "canvas")


def _canvas_workspace_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", normalized):
        raise HTTPException(status_code=422, detail="Canvas workspace identifier is invalid")
    return normalized


def _canvas_slug(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", normalized):
        raise HTTPException(status_code=422, detail="Canvas slug is invalid")
    return normalized


def _canvas_title(value: str) -> str:
    normalized = value.strip()
    if not 1 <= len(normalized) <= 200:
        raise HTTPException(status_code=422, detail="Canvas title must contain 1-200 characters")
    return normalized


def _lock_canvas_workspace(cur, tenant_id: str, workspace_id: str) -> None:
    cur.execute(
        "SELECT pg_advisory_xact_lock(hashtext('gb_canvas_workspace'), hashtext(%s))",
        (f"{tenant_id}:{workspace_id}",),
    )


def _surface_spec(value: Any) -> dict:
    try:
        return validate_surface_spec(value)
    except SurfaceContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _surface_provenance(value: Any, identity: IdentityContext, event: str) -> dict:
    if not isinstance(value, dict) or set(value) - SURFACE_PROVENANCE_FIELDS:
        raise HTTPException(status_code=422, detail="Surface provenance contains unsupported properties")
    actor_ref = value.get("actor_ref")
    if actor_ref is not None and (
        not isinstance(actor_ref, str)
        or not 8 <= len(actor_ref) <= 200
        or any(ord(char) < 33 or ord(char) > 126 for char in actor_ref)
    ):
        raise HTTPException(status_code=422, detail="Surface actor reference is invalid")
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Surface provenance must be JSON serializable") from error
    if len(encoded.encode("utf-8")) > 32_768:
        raise HTTPException(status_code=422, detail="Surface provenance exceeds the size limit")
    provenance = json.loads(encoded)
    provenance["galaxy"] = {
        "event": event,
        "principal_id": identity.principal_id,
        "principal_kind": identity.principal_kind,
        "recorded_at": datetime.now().astimezone().isoformat(),
    }
    return provenance


def _surface_content_hash(title: str, status: str, spec: dict, provenance: dict) -> str:
    snapshot = {
        "title": title,
        "status": status,
        "spec": spec,
        "provenance": provenance,
    }
    encoded = json.dumps(
        snapshot,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _surface_request_hash(value: dict) -> str:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Surface request must be valid JSON") from error
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _get_surface_or_404(surface_id: str) -> dict:
    normalized_id = _surface_uuid(surface_id)
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_surfaces WHERE id = %s AND deleted_at IS NULL",
        (normalized_id,),
    )
    surface = row_to_dict(cur.fetchone())
    if surface is None:
        raise HTTPException(status_code=404, detail=f"Surface {surface_id} not found")
    return surface


def _get_datasource_connection_or_404(connection_id: str, identity: IdentityContext) -> dict:
    cur = get_conn().cursor()
    cur.execute(
        """
        SELECT
            c.*,
            p.display_name AS plugin_display_name,
            p.kind AS plugin_kind,
            p.capabilities AS plugin_capabilities
        FROM gb_datasource_connections c
        JOIN gb_datasource_plugins p ON p.id = c.plugin_id
        WHERE c.id = %s AND c.tenant_id = %s
        """,
        (connection_id, identity.tenant_id),
    )
    connection = row_to_dict(cur.fetchone())
    if connection is None:
        raise HTTPException(status_code=404, detail=f"Datasource connection {connection_id} not found")
    return connection


def _resolve_filesystem_root(connection: dict, identity: IdentityContext) -> AuthorizedTenantRoot:
    if connection.get("plugin_id") != "filesystem-vault":
        raise HTTPException(status_code=400, detail="Only filesystem-vault is supported right now")
    if str(connection.get("tenant_id")) != identity.tenant_id:
        raise HTTPException(status_code=403, detail="Datasource connection belongs to another tenant")
    root_path = connection.get("root_path")
    if not root_path:
        raise HTTPException(status_code=400, detail="Datasource connection does not have a root_path configured")
    try:
        binding = authorize_tenant_root_binding(
            FILESYSTEM_ROOTS_BY_TENANT,
            identity.tenant_id,
            root_path,
        )
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error))
    if not os.path.isdir(binding.connection_root):
        raise HTTPException(status_code=400, detail="Datasource root_path does not exist")
    return binding


def _normalize_relative_item_id(item_id: str) -> str:
    normalized = item_id.replace("\\", "/").strip().lstrip("/")
    if not normalized:
        raise HTTPException(status_code=400, detail="Datasource item id may not be empty")
    return normalized


def _resolve_item_path(root_abs: str, item_id: str) -> Path:
    normalized = _normalize_relative_item_id(item_id)
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=400, detail="Datasource item id contains an invalid path segment")

    root = Path(root_abs).resolve(strict=True)
    try:
        candidate = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail=f"Datasource item not found: {item_id}")
    if not candidate.is_relative_to(root):
        raise HTTPException(status_code=400, detail=f"Datasource item escapes root path: {item_id}")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Datasource item not found: {item_id}")
    return candidate


def _datasource_listing_item(entry) -> dict:
    return {
        "id": entry.item_id,
        "title": entry.filename,
        "path": entry.item_id,
        "mime_type": entry.media_type,
        "updated_at": datetime.fromtimestamp(entry.modified_at).isoformat(),
        "size": entry.size,
    }


def _read_filesystem_item(binding: AuthorizedTenantRoot, item_id: str) -> dict:
    exact = read_authorized_datasource_file(binding, item_id, MAX_DOCUMENT_BYTES)
    rel_path = item_id.replace("\\", "/")
    warnings: List[str] = []
    if exact.media_type == "application/pdf":
        content = f"[{exact.media_type}] {exact.filename} ({len(exact.content)} bytes)"
        warnings.append("PDF imported as metadata-only placeholder content by the legacy endpoint.")
    else:
        try:
            content = exact.content.decode("utf-8", errors="strict")
        except Exception as e:
            raise HTTPException(status_code=415, detail="Datasource item cannot be imported safely") from e

    return {
        "id": rel_path,
        "title": exact.filename,
        "path": rel_path,
        "mime_type": exact.media_type,
        "updated_at": datetime.fromtimestamp(exact.modified_at).isoformat(),
        "size": len(exact.content),
        "content": content,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ExperimentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    status: str = "hypothesis"
    hypothesis: str = ""
    protocol: str = ""
    config_snapshot: dict = {}
    wandb_run_id: Optional[str] = None
    wandb_project: Optional[str] = None
    local_run_path: Optional[str] = None
    results: str = ""
    interpretation: str = ""
    conclusion: str = ""
    domain: str = "general"
    tags: List[str] = []
    linked_experiments: List[str] = []
    ham_node_id: Optional[str] = None


class ExperimentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = None
    status: Optional[str] = None
    hypothesis: Optional[str] = None
    protocol: Optional[str] = None
    config_snapshot: Optional[dict] = None
    wandb_run_id: Optional[str] = None
    wandb_project: Optional[str] = None
    local_run_path: Optional[str] = None
    results: Optional[str] = None
    interpretation: Optional[str] = None
    conclusion: Optional[str] = None
    domain: Optional[str] = None
    tags: Optional[List[str]] = None
    linked_experiments: Optional[List[str]] = None
    ham_node_id: Optional[str] = None


class ExperimentAttachmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaId: Literal["gb.eln-attachment-create.v1"]
    documentRef: StrictStr = Field(min_length=1, max_length=800)


class ExperimentObservationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaId: Literal["gb.eln-observation-create.v1"]
    body: StrictStr
    observedAt: Optional[StrictStr] = Field(default=None, max_length=64)

    @field_validator("body")
    @classmethod
    def normalize_body(cls, value: str) -> str:
        normalized = value.strip()
        if (
            not normalized
            or len(normalized) > 4000
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]", normalized)
        ):
            raise ValueError("Observation body must be 1 to 4000 Unicode characters")
        return normalized


class ExperimentMetricCreate(BaseModel):
    name: str
    value: float
    step: Optional[int] = None
    source: str = "manual"


class HypothesisCreate(BaseModel):
    claim: str
    status: str = "open"
    confidence: float = 0.5
    domain: str = "general"
    supporting_experiments: List[str] = []
    refuting_experiments: List[str] = []
    superseded_by: Optional[str] = None
    ham_node_id: Optional[str] = None


class HypothesisUpdate(BaseModel):
    claim: Optional[str] = None
    status: Optional[str] = None
    confidence: Optional[float] = None
    domain: Optional[str] = None
    supporting_experiments: Optional[List[str]] = None
    refuting_experiments: Optional[List[str]] = None
    superseded_by: Optional[str] = None
    ham_node_id: Optional[str] = None


class DatasourcePluginManifest(BaseModel):
    id: str
    display_name: str
    kind: str
    capabilities: List[str]
    auth_type: str = "none"
    is_builtin: bool = True


class DatasourceConnectionCreate(BaseModel):
    plugin_id: str
    display_name: str
    root_path: Optional[str] = None
    config: Dict[str, Any] = {}


class DatasourceConnectionUpdate(BaseModel):
    display_name: Optional[str] = None
    status: Optional[str] = None
    root_path: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    last_sync_cursor: Optional[str] = None
    last_error: Optional[str] = None


class DatasourceImportRequest(BaseModel):
    item_ids: List[str]


class DatasourceContentRequest(BaseModel):
    item_id: StrictStr = Field(min_length=1, max_length=2048)


class DatasourceItem(BaseModel):
    id: str
    title: str
    path: Optional[str] = None
    mime_type: Optional[str] = None
    updated_at: Optional[str] = None
    size: Optional[int] = None


class NodeRevisionUpsert(BaseModel):
    id: str
    node_id: str
    version: int = 1
    timestamp: datetime
    source: str = "update"
    summary: str = ""
    changed_fields: List[str] = []
    snapshot_json: Dict[str, Any] = {}


class SurfaceCreate(BaseModel):
    title: str
    spec: Dict[str, Any]
    provenance: Dict[str, Any] = {}
    idempotency_key: str


class CanvasCreate(BaseModel):
    workspaceId: str
    slug: str = "main"
    title: str
    makeDefault: StrictBool = False
    projectionMode: Literal["ambient", "curated"] = "ambient"
    idempotencyKey: str


class CanvasMutation(BaseModel):
    expectedVersion: StrictInt
    expectedContentHash: str
    idempotencyKey: str
    commands: List[Dict[str, Any]]


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: StrictStr
    title: StrictStr
    goal: StrictStr
    artifact_refs: List[StrictStr] = Field(default_factory=list)
    provenance: Dict[str, StrictStr] = Field(default_factory=dict)
    idempotency_key: StrictStr


class ConversationAppend(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: StrictInt
    parent_turn_id: Optional[StrictStr] = None
    message: Dict[str, StrictStr]
    artifact_refs: List[StrictStr] = Field(default_factory=list)
    provenance: Dict[str, StrictStr] = Field(default_factory=dict)
    idempotency_key: StrictStr


class ConversationFork(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: StrictInt
    parent_turn_id: StrictStr
    message: Dict[str, StrictStr]
    artifact_refs: List[StrictStr] = Field(default_factory=list)
    provenance: Dict[str, StrictStr] = Field(default_factory=dict)
    idempotency_key: StrictStr


class ConversationJoin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: StrictInt
    parent_turn_ids: List[StrictStr]
    message: Dict[str, StrictStr]
    artifact_refs: List[StrictStr] = Field(default_factory=list)
    provenance: Dict[str, StrictStr] = Field(default_factory=dict)
    idempotency_key: StrictStr


class SurfaceUpdate(BaseModel):
    base_version: int
    base_content_hash: Optional[str] = None
    title: Optional[str] = None
    spec: Optional[Dict[str, Any]] = None
    patch: Optional[List[Dict[str, Any]]] = None
    provenance: Dict[str, Any] = {}
    idempotency_key: str


class SurfacePromote(BaseModel):
    base_version: int
    base_content_hash: Optional[str] = None
    provenance: Dict[str, Any] = {}
    idempotency_key: str


class TaskPlanCreate(BaseModel):
    ham_task_id: str
    title: str
    spec: Dict[str, Any]
    provenance: Dict[str, Any] = {}
    idempotency_key: str


class TaskPlanUpdate(BaseModel):
    base_version: int
    base_content_hash: Optional[str] = None
    title: Optional[str] = None
    spec: Dict[str, Any]
    provenance: Dict[str, Any] = {}
    idempotency_key: str


class TaskPlanDispatchIntentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_plan_version: StrictInt
    expected_content_hash: StrictStr
    ham_task_id: StrictStr
    expected_task_version: StrictInt
    idempotency_key: StrictStr


class TaskPlanProposalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str
    expectedVersion: StrictInt
    expectedContentHash: str
    expectedHamTaskId: str
    expectedHamTaskVersion: StrictInt
    sourceJobIds: List[str]
    title: str
    goal: str
    instruction: Optional[str]
    inputRefs: List[str]
    branches: List[Dict[str, Any]]


class ProofWorkspaceCreate(BaseModel):
    workspace_id: str
    graph_ref: Dict[str, Any]
    node_ids: List[str]
    idempotency_key: str


class ProofWorkGraphRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    graph_id: StrictStr
    content_sha256: StrictStr


class ProofWorkTransition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    graph_ref: ProofWorkGraphRef
    node_id: str
    expected_version: StrictInt
    expected_item_version: StrictInt
    transition: Dict[str, Any]
    idempotency_key: str


class ProofCoordinationTaskBindingItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node_id: str
    expected_item_version: StrictInt
    binding: Dict[str, Any]


class ProofCoordinationTaskBindingBulk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    graph_ref: Dict[str, Any]
    expected_version: StrictInt
    bindings: List[ProofCoordinationTaskBindingItem]
    idempotency_key: str


class PaperImport(BaseModel):
    arxiv_id: str


class PaperAnnotationCreate(BaseModel):
    paper_revision_id: str
    kind: str
    page_number: int
    anchor: Dict[str, Any]
    body: str = ""
    color: str = "#facc15"
    lens: str = "analysis"
    semantic_role: str = "note"
    tags: List[str] = []
    idempotency_key: str


class PaperAnnotationUpdate(BaseModel):
    base_version: int
    body: Optional[str] = None
    color: Optional[str] = None
    lens: Optional[str] = None
    semantic_role: Optional[str] = None
    tags: Optional[List[str]] = None


class PaperClaimCreate(BaseModel):
    source_annotation_id: Optional[str] = None
    statement: str
    status: str = "open"
    tags: List[str] = []
    idempotency_key: str


class ClaimEvidenceCreate(BaseModel):
    annotation_id: str
    relation: str


class PaperTaskLinkCreate(BaseModel):
    ham_task_id: str
    parent_ham_task_id: Optional[str] = None
    relation: str
    title_snapshot: str
    annotation_id: Optional[str] = None
    claim_id: Optional[str] = None


OBJECT_LINK_COLUMNS = """id, from_ref, to_ref, relation, basis, provenance,
    created_by_principal_id, created_at"""
OBJECT_LINK_RETRACTION_COLUMNS = """id, link_id, expected_version, reason,
    retracted_by_principal_id, created_at"""


def _referent_access(
    reference,
    identity: IdentityContext,
    *,
    revision: Optional[str],
    provider: str,
) -> ReferentAccess:
    return ReferentAccess(
        reference=reference.wire,
        tenant_id=identity.tenant_id,
        principal_id=identity.principal_id,
        readable=True,
        resolved_revision=revision,
        provider=provider,
    )


def _authorize_proof_referent(cur, reference, identity: IdentityContext):
    revision = reference.revision
    # Immutable proof structures have no meaningful tenant-wide "latest".
    # Every proof referent must select one exact registered artifact hash.
    if revision is None:
        return None
    digest = revision.removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        return None
    if reference.kind == "proof.graph":
        cur.execute(
            """SELECT content_sha256 FROM gb_proof_graphs
                WHERE tenant_id = %s AND graph_id = %s
                  AND content_sha256 = %s
                LIMIT 1""",
            (identity.tenant_id, reference.identifier, digest),
        )
    else:
        cur.execute(
            """SELECT graph.content_sha256
                 FROM gb_proof_graphs AS graph
                WHERE graph.tenant_id = %s
                  AND %s = ANY(graph.node_ref_ids)
                  AND graph.content_sha256 = %s
                LIMIT 1""",
            (identity.tenant_id, reference.identifier, digest),
        )
    row = cur.fetchone()
    if row is None:
        return None
    resolved = f"sha256:{row['content_sha256']}"
    return _referent_access(reference, identity, revision=resolved, provider="galaxy.proof-dag")


def _authorize_local_referent(cur, reference, identity: IdentityContext):
    if reference.revision is not None:
        digest = reference.revision.removeprefix("sha256:")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            return None
        if reference.kind == "paper":
            cur.execute(
                """SELECT revision.metadata_hash
                     FROM gb_papers AS paper
                     JOIN gb_paper_revisions AS revision
                       ON revision.tenant_id = paper.tenant_id
                      AND revision.paper_id = paper.id
                    WHERE paper.tenant_id = %s
                      AND (paper.id::text = %s OR paper.arxiv_id = %s)
                      AND revision.metadata_hash = %s
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, reference.identifier, digest),
            )
        elif reference.kind == "surface":
            cur.execute(
                """SELECT revision.content_hash
                     FROM gb_surfaces AS surface
                     JOIN gb_surface_revisions AS revision
                       ON revision.tenant_id = surface.tenant_id
                      AND revision.surface_id = surface.id
                    WHERE surface.tenant_id = %s AND surface.id::text = %s
                      AND surface.deleted_at IS NULL AND revision.content_hash = %s
                      AND revision.status = 'promoted'
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        elif reference.kind == "task-plan":
            cur.execute(
                """SELECT revision.content_hash
                     FROM gb_task_plans AS plan
                     JOIN gb_task_plan_revisions AS revision
                       ON revision.tenant_id = plan.tenant_id
                      AND revision.task_plan_id = plan.id
                    WHERE plan.tenant_id = %s AND plan.id::text = %s
                      AND revision.content_hash = %s
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        elif reference.kind == "document":
            cur.execute(
                """SELECT revision.revision_sha256
                     FROM gb_documents AS document
                     JOIN gb_document_revisions AS revision
                       ON revision.tenant_id = document.tenant_id
                      AND revision.document_id = document.id
                    WHERE document.tenant_id = %s AND document.id::text = %s
                      AND document.deleted_at IS NULL
                      AND revision.revision_sha256 = %s
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        elif reference.kind == "document.anchor":
            cur.execute(
                """SELECT anchor.representation_sha256
                     FROM gb_document_anchors AS anchor
                     JOIN gb_document_representations AS representation
                       ON representation.tenant_id = anchor.tenant_id
                      AND representation.id = anchor.representation_id
                      AND representation.content_sha256 = anchor.representation_sha256
                    WHERE anchor.tenant_id = %s AND anchor.id = %s
                      AND anchor.representation_sha256 = %s
                      AND anchor.identity_version = 'gb.anchor.v1'
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        elif reference.kind == "document.mark":
            cur.execute(
                """SELECT revision.content_hash
                     FROM gb_document_marks AS mark
                     JOIN gb_document_mark_revisions AS revision
                       ON revision.tenant_id = mark.tenant_id
                      AND revision.mark_id = mark.id
                    WHERE mark.tenant_id = %s AND mark.id::text = %s
                      AND revision.content_hash = %s LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        elif reference.kind == "chat":
            cur.execute(
                """SELECT revision.content_hash
                     FROM gb_conversations AS conversation
                     JOIN gb_conversation_revisions AS revision
                       ON revision.tenant_id = conversation.tenant_id
                      AND revision.conversation_id = conversation.id
                    WHERE conversation.tenant_id = %s
                      AND conversation.id::text = %s
                      AND revision.content_hash = %s
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, f"sha256:{digest}"),
            )
        elif reference.kind == "eln.observation":
            cur.execute(
                """SELECT revision.revision_sha256
                     FROM gb_eln_observations AS observation
                     JOIN gb_eln_observation_revisions AS revision
                       ON revision.tenant_id = observation.tenant_id
                      AND revision.observation_id = observation.id
                    WHERE observation.tenant_id = %s AND observation.id::text = %s
                      AND revision.revision_sha256 = %s
                    LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
        else:
            return None
        if cur.fetchone() is None:
            return None
        return _referent_access(
            reference,
            identity,
            revision=reference.revision,
            provider=(
                "galaxy.conversation" if reference.kind == "chat"
                else "galaxy-brain-eln" if reference.kind == "eln.observation"
                else "galaxy"
            ),
        )

    if reference.kind == "document.anchor":
        cur.execute(
            """SELECT representation_sha256 FROM gb_document_anchors
                WHERE tenant_id = %s AND id = %s
                  AND identity_version = 'gb.anchor.v1' LIMIT 1""",
            (identity.tenant_id, reference.identifier),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return _referent_access(
            reference,
            identity,
            revision=f"sha256:{row['representation_sha256']}",
            provider="galaxy.document",
        )

    if reference.kind == "document.mark":
        cur.execute(
            """SELECT current_content_hash FROM gb_document_marks
                WHERE tenant_id = %s AND id::text = %s LIMIT 1""",
            (identity.tenant_id, reference.identifier),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return _referent_access(
            reference,
            identity,
            revision=f"sha256:{row['current_content_hash']}",
            provider="galaxy.document",
        )

    if reference.kind == "eln.observation":
        cur.execute(
            """SELECT revision.revision_sha256
                 FROM gb_eln_observations AS observation
                 JOIN gb_eln_observation_revisions AS revision
                   ON revision.tenant_id = observation.tenant_id
                  AND revision.observation_id = observation.id
                WHERE observation.tenant_id = %s AND observation.id::text = %s
                ORDER BY revision.version DESC LIMIT 1""",
            (identity.tenant_id, reference.identifier),
        )
        row = cur.fetchone()
        if row is None:
            return None
        return _referent_access(
            reference,
            identity,
            revision=f"sha256:{row['revision_sha256']}",
            provider="galaxy-brain-eln",
        )

    table = {
        "paper": ("gb_papers", "id::text = %s OR arxiv_id = %s"),
        "document": ("gb_documents", "id::text = %s AND deleted_at IS NULL"),
        "surface": ("gb_surfaces", "id::text = %s AND deleted_at IS NULL AND status = 'promoted'"),
        "task-plan": ("gb_task_plans", "id::text = %s"),
        "claim": ("gb_paper_claims", "id::text = %s"),
        # Experiments carry no content-addressed revision, so only follow-latest
        # references resolve; a pinned one fails closed above.
        "eln.experiment": ("gb_experiments", "id::text = %s"),
    }.get(reference.kind)
    if table is None:
        return None
    table_name, predicate = table
    parameters = [identity.tenant_id, reference.identifier]
    if reference.kind == "paper":
        parameters.append(reference.identifier)
    cur.execute(
        f"SELECT 1 FROM {table_name} WHERE tenant_id = %s AND ({predicate}) LIMIT 1",
        tuple(parameters),
    )
    if cur.fetchone() is None:
        return None
    if reference.kind == "document":
        cur.execute(
            """SELECT revision.revision_sha256
                 FROM gb_documents AS document
                 JOIN gb_document_revisions AS revision
                   ON revision.tenant_id = document.tenant_id
                  AND revision.id = document.current_revision_id
                WHERE document.tenant_id = %s AND document.id::text = %s
                  AND document.deleted_at IS NULL LIMIT 1""",
            (identity.tenant_id, reference.identifier),
        )
        revision_row = cur.fetchone()
        if revision_row is None:
            return None
        return _referent_access(
            reference,
            identity,
            revision=f"sha256:{revision_row['revision_sha256']}",
            provider="galaxy.document",
        )
    return _referent_access(reference, identity, revision=None, provider="galaxy")


def _validated_referent_resolver_url() -> str:
    if not OBJECT_REFERENCE_RESOLVER_URL or not OBJECT_REFERENCE_RESOLVER_TOKEN:
        raise ReferentAccessError("Referent authorization provider is unavailable", unavailable=True)
    parsed = urllib.parse.urlparse(OBJECT_REFERENCE_RESOLVER_URL)
    local_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        (parsed.scheme != "https" and not local_http)
        or not parsed.hostname or parsed.username or parsed.password
        or parsed.query or parsed.fragment
    ):
        raise ReferentAccessError("Referent authorization provider is misconfigured", unavailable=True)
    return OBJECT_REFERENCE_RESOLVER_URL


def _authorize_remote_referents(references, identity: IdentityContext):
    url = _validated_referent_resolver_url()
    if len(references) > MAX_REFERENT_RESOLUTION_REFERENCES:
        references = references[:MAX_REFERENT_RESOLUTION_REFERENCES]
    body = json.dumps({
        "schema": "gb.referent-resolution-batch.v1",
        "references": [reference.wire for reference in references],
        "tenant_id": identity.tenant_id,
        "principal_id": identity.principal_id,
        "operation": "read",
    }, separators=(",", ":")).encode("utf-8")
    outbound = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {OBJECT_REFERENCE_RESOLVER_TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(outbound, timeout=REFERENT_RESOLVER_TIMEOUT_SECONDS) as response:
            encoded = response.read(MAX_REFERENT_RESOLVER_RESPONSE_BYTES + 1)
        if len(encoded) > MAX_REFERENT_RESOLVER_RESPONSE_BYTES:
            raise ValueError("response is too large")
        payload = json.loads(encoded.decode("utf-8", "strict"))
    except Exception as error:
        log.warning("referent authorization provider failed: %s", error)
        raise ReferentAccessError("Referent authorization provider is unavailable", unavailable=True) from error
    if not isinstance(payload, dict) or set(payload) != {"decisions"} or not isinstance(payload["decisions"], list):
        raise ReferentAccessError("Referent authorization provider returned an invalid decision", unavailable=True)
    requested = {reference.wire for reference in references}
    decisions = {}
    for decision in payload["decisions"]:
        if not isinstance(decision, dict) or not isinstance(decision.get("reference"), str):
            raise ReferentAccessError("Referent authorization provider returned an invalid decision", unavailable=True)
        wire = decision["reference"]
        if wire not in requested or wire in decisions:
            raise ReferentAccessError("Referent authorization provider returned an invalid decision", unavailable=True)
        decisions[wire] = decision
    return decisions


def _authorize_remote_referent(reference, identity: IdentityContext):
    return _authorize_remote_referents([reference], identity).get(reference.wire)


def _object_reference_authorizers(cur):
    authorizers = {kind: _authorize_remote_referent for kind in OBJECT_REFERENCE_KINDS}
    for kind in ("proof.graph", "proof.node"):
        authorizers[kind] = lambda reference, identity, _cur=cur: _authorize_proof_referent(
            _cur, reference, identity,
        )
    for kind in (
        "paper", "document", "document.anchor", "document.mark", "eln.experiment", "eln.observation", "surface",
        "task-plan", "claim", "chat",
    ):
        authorizers[kind] = lambda reference, identity, _cur=cur: _authorize_local_referent(
            _cur, reference, identity,
        )
    return authorizers


def _authorize_object_reference(cur, value: str, identity: IdentityContext) -> ReferentAccess:
    try:
        return authorize_referent(value, identity, _object_reference_authorizers(cur))
    except ReferentAccessError as error:
        if error.unavailable:
            raise HTTPException(status_code=503, detail=str(error)) from error
        raise HTTPException(status_code=404, detail="Object referent was not found or is not readable") from error


def _authorize_object_references(cur, values, identity: IdentityContext):
    """Authorize a bounded, de-duplicated set with one remote gateway call.

    Missing/denied referents map to ``None`` so list projections can omit the
    affected edge. Provider outage remains a 503 because returning a partial
    graph as complete would be misleading.
    """
    references = {}
    for value in values:
        parsed = parse_canonical_reference(value)
        references.setdefault(parsed.wire, parsed)

    local_kinds = {
        "paper", "document", "document.anchor", "document.mark", "eln.experiment", "eln.observation", "surface",
        "task-plan", "claim", "proof.graph", "proof.node", "chat",
    }
    remote = [reference for reference in references.values() if reference.kind not in local_kinds]
    remote = remote[:MAX_REFERENT_RESOLUTION_REFERENCES]
    try:
        remote_decisions = _authorize_remote_referents(remote, identity) if remote else {}
    except ReferentAccessError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    results = {}
    authorizers = _object_reference_authorizers(cur)
    remote_wires = {reference.wire for reference in remote}
    for wire, reference in references.items():
        if reference.kind not in local_kinds and wire not in remote_wires:
            results[wire] = None
            continue
        selected = dict(authorizers)
        if reference.kind not in local_kinds:
            selected[reference.kind] = lambda _reference, _identity, decision=remote_decisions.get(wire): decision
        try:
            results[wire] = authorize_referent(wire, identity, selected)
        except ReferentAccessError as error:
            if error.unavailable:
                raise HTTPException(status_code=503, detail=str(error)) from error
            results[wire] = None
    return results


@app.get("/object-references/resolve")
def resolve_object_reference(
    ref: str,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        canonical_reference(ref)
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    access = _authorize_object_reference(get_conn().cursor(), ref, identity)
    return {
        "reference": access.reference,
        "readable": True,
        "resolved_revision": access.resolved_revision,
        "provider": access.provider,
    }


async def _read_projection_source_request(request: Request) -> tuple[str, list[str]]:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_PROJECTION_SOURCE_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Projection source request exceeds 64 KiB")
        chunks.append(chunk)
    try:
        return parse_projection_source_request(b"".join(chunks), include_schema=True)
    except ProjectionSourceRequestError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error


def _resolve_projection_source_request(
    references: list[str],
    identity: IdentityContext,
    response_schema: str,
) -> dict:
    try:
        return resolve_projection_sources(
            get_conn(), identity.tenant_id, identity.principal_id, references, response_schema,
        )
    except (psycopg2.Error, ProjectionSourceProviderError) as error:
        log.warning("object projection source provider unavailable: %s", type(error).__name__)
        raise HTTPException(
            status_code=503,
            detail="Object projection source provider is unavailable",
        ) from error


@app.post("/object-projection-sources/resolve")
async def resolve_object_projection_source_batch(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    # Headerless requests are the deployed v1 web contract.  Keep accepting
    # them during a rolling upgrade while requiring explicit markers for every
    # newer contract.
    gateway_version = request.headers.get("X-GB-Projection-Gateway", "") or "v1"
    if gateway_version not in {"v1", "v2", "v3"}:
        raise HTTPException(status_code=404, detail="Not found")
    request_schema, references = await _read_projection_source_request(request)
    expected_request_schema = {
        "v1": PROJECTION_SOURCE_REQUEST_SCHEMA_V1,
        "v2": PROJECTION_SOURCE_REQUEST_SCHEMA_V2,
        "v3": PROJECTION_SOURCE_REQUEST_SCHEMA,
    }[gateway_version]
    if request_schema != expected_request_schema:
        raise HTTPException(status_code=422, detail="Projection gateway version does not match request schema")
    response_schema = {
        "v1": PROJECTION_SOURCE_RESPONSE_SCHEMA_V1,
        "v2": PROJECTION_SOURCE_RESPONSE_SCHEMA_V2,
        "v3": PROJECTION_SOURCE_RESPONSE_SCHEMA,
    }[gateway_version]
    return await run_in_threadpool(
        _resolve_projection_source_request, references, identity, response_schema,
    )


async def _read_object_link_json(request: Request, maximum: int = MAX_OBJECT_LINK_BODY_BYTES):
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > maximum:
            raise HTTPException(status_code=413, detail="Request body is too large")
        chunks.append(chunk)

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ObjectLinkError("Duplicate JSON fields are not allowed")
            value[key] = item
        return value

    try:
        return json.loads(
            b"".join(chunks).decode("utf-8", "strict"),
            object_pairs_hook=unique_fields,
        )
    except (UnicodeError, json.JSONDecodeError, ObjectLinkError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


async def _read_graph_window_request(request: Request) -> dict[str, Any]:
    encoded = bytearray()
    async for chunk in request.stream():
        encoded.extend(chunk)
        if len(encoded) > MAX_GRAPH_WINDOW_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Graph window request is too large")
    try:
        return parse_graph_window_request(bytes(encoded))
    except GraphWindowError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error


def _graph_window_reference(kind: str, identifier: object, digest: object) -> str:
    safe_component = "~!*'()-._"
    value = (
        f"gb:object:v1:{kind}:"
        f"{urllib.parse.quote(str(identifier), safe=safe_component)}:pinned:"
        f"{urllib.parse.quote(f'sha256:{digest}', safe=safe_component)}"
    )
    return canonical_reference(value)


def _graph_window_timestamp(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if not isinstance(value, str) or not value:
        raise GraphWindowError("Graph window source contains an invalid timestamp", status_code=503)
    return value


def _graph_window_title(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GraphWindowError("Graph window source contains an invalid title", status_code=503)
    characters = list(value.strip())
    return value.strip() if len(characters) <= 240 else "".join(characters[:239]) + "…"


def _graph_window_member_rows(cur, spec, request_value: dict, identity: IdentityContext):
    cursor = None
    if request_value["cursor"]:
        cursor = decode_graph_window_cursor(
            request_value["cursor"],
            secret=PROXY_TOKEN,
            tenant_id=identity.tenant_id,
            principal_id=identity.principal_id,
            request=request_value,
        )
    keyset = ""
    parameters: list[object] = [identity.tenant_id]
    if cursor:
        keyset = " AND (source.updated_at, source.id) < (%s::timestamptz, %s::uuid)"
        parameters.extend((cursor["updatedAt"], cursor["memberId"]))
    parameters.append(MAX_GRAPH_WINDOW_MEMBERS + 1)
    if spec.kind == "document":
        statement = f"""SELECT source.id, revision.title, source.updated_at,
                               revision.revision_sha256 AS digest
                          FROM gb_documents AS source
                          JOIN gb_document_revisions AS revision
                            ON revision.tenant_id = source.tenant_id
                           AND revision.id = source.current_revision_id
                         WHERE source.tenant_id = %s AND source.deleted_at IS NULL
                               {keyset}
                         ORDER BY source.updated_at DESC, source.id DESC LIMIT %s"""
    elif spec.kind == "paper":
        statement = f"""SELECT source.id,
                               revision.metadata ->> 'title' AS title,
                               source.updated_at, revision.metadata_hash AS digest
                          FROM gb_papers AS source
                          JOIN gb_paper_revisions AS revision
                            ON revision.tenant_id = source.tenant_id
                           AND revision.paper_id = source.id
                           AND revision.metadata_hash = source.metadata_hash
                         WHERE source.tenant_id = %s {keyset}
                         ORDER BY source.updated_at DESC, source.id DESC LIMIT %s"""
    elif spec.kind == "surface":
        statement = f"""SELECT source.id, revision.title, source.updated_at,
                               revision.content_hash AS digest
                          FROM gb_surfaces AS source
                          JOIN gb_surface_revisions AS revision
                            ON revision.tenant_id = source.tenant_id
                           AND revision.surface_id = source.id
                           AND revision.version = source.current_version
                           AND revision.content_hash = source.current_content_hash
                           AND revision.status = 'promoted'
                         WHERE source.tenant_id = %s AND source.deleted_at IS NULL
                           AND source.status = 'promoted' {keyset}
                         ORDER BY source.updated_at DESC, source.id DESC LIMIT %s"""
    else:
        raise GraphWindowError("This aggregate has no immutable member page")
    cur.execute(statement, tuple(parameters))
    rows = cur.fetchall()
    has_more = len(rows) > MAX_GRAPH_WINDOW_MEMBERS
    selected = rows[:MAX_GRAPH_WINDOW_MEMBERS]
    members = []
    cluster_identifier = graph_window_cluster_id(spec, identity.tenant_id, request_value["workspaceId"])
    for row in selected:
        digest = row["digest"]
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise GraphWindowError("Graph window source contains an invalid digest", status_code=503)
        member_id = str(row["id"])
        members.append({
            "ref": _graph_window_reference(spec.kind, member_id, digest),
            "clusterId": cluster_identifier,
            "provider": spec.provider,
            "kind": spec.kind,
            "title": _graph_window_title(row["title"]),
            "updatedAt": _graph_window_timestamp(row["updated_at"]),
        })
    next_cursor = None
    if has_more and selected:
        last = selected[-1]
        next_cursor = encode_graph_window_cursor(
            secret=PROXY_TOKEN,
            tenant_id=identity.tenant_id,
            principal_id=identity.principal_id,
            request=request_value,
            updated_at=_graph_window_timestamp(last["updated_at"]),
            member_id=str(last["id"]),
        )
    return members, next_cursor, has_more


def _build_graph_window(request_value: dict, identity: IdentityContext) -> dict:
    conn = get_conn()
    count_queries = {
        "document": "SELECT count(*) AS count FROM gb_documents WHERE tenant_id = %s AND deleted_at IS NULL",
        "paper": "SELECT count(*) AS count FROM gb_papers WHERE tenant_id = %s",
        "eln.experiment": "SELECT count(*) AS count FROM gb_experiments WHERE tenant_id = %s",
        "surface": "SELECT count(*) AS count FROM gb_surfaces WHERE tenant_id = %s AND deleted_at IS NULL AND status = 'promoted'",
    }
    with _transaction(conn) as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        cur.execute("SET LOCAL statement_timeout = '750ms'")
        root_ref = request_value["rootRef"]
        if root_ref and _authorize_object_references(cur, [root_ref], identity).get(root_ref) is None:
            raise HTTPException(status_code=404, detail="Graph focus was not found or is not readable")

        requested_kinds = set(request_value["filters"]["kinds"])
        clusters = []
        counts: dict[str, int | None] = {}
        provider_status: dict[str, str] = {}
        for spec in GRAPH_WINDOW_CLUSTERS:
            if requested_kinds and spec.kind not in requested_kinds:
                continue
            if not graph_window_cluster_intersects(spec, request_value["viewport"]):
                continue
            cur.execute("SAVEPOINT graph_window_count")
            try:
                cur.execute(count_queries[spec.kind], (identity.tenant_id,))
                row = cur.fetchone()
                count: int | None = int(row["count"]) if row is not None else 0
                provider_status[spec.kind] = "ready"
            except Exception:
                cur.execute("ROLLBACK TO SAVEPOINT graph_window_count")
                count = None
                provider_status[spec.kind] = "unavailable"
            finally:
                cur.execute("RELEASE SAVEPOINT graph_window_count")
            counts[spec.kind] = count
            clusters.append({
                "id": graph_window_cluster_id(spec, identity.tenant_id, request_value["workspaceId"]),
                "provider": spec.provider,
                "kind": spec.kind,
                "label": spec.label,
                "count": count,
                "countStatus": "exact" if count is not None else "unavailable",
                "expandable": spec.expandable and count != 0,
                "bounds": {"x": spec.x, "y": spec.y, "width": spec.width, "height": spec.height},
            })

        members: list[dict] = []
        next_cursor = None
        has_more = False
        expanded = request_value["expandClusterId"]
        if expanded:
            spec = graph_window_cluster_for_id(
                expanded, tenant_id=identity.tenant_id, workspace_id=request_value["workspaceId"],
            )
            visible_ids = {cluster["id"] for cluster in clusters}
            if spec is None or expanded not in visible_ids:
                raise GraphWindowError("Expanded cluster is outside this graph window")
            if not spec.expandable:
                raise GraphWindowError("This aggregate has no immutable member page")
            members, next_cursor, has_more = _graph_window_member_rows(cur, spec, request_value, identity)

        providers = []
        for spec in GRAPH_WINDOW_CLUSTERS:
            if spec.kind not in counts:
                continue
            status = provider_status[spec.kind]
            provider = {"provider": spec.provider, "status": status}
            if counts[spec.kind] is not None:
                provider["count"] = counts[spec.kind]
            else:
                provider["reason"] = "Aggregate count exceeded the bounded database read"
            providers.append(provider)
        providers.append({
            "provider": "galaxy.object-links",
            "status": "partial",
            "reason": "Aggregate relation windows are not emitted by this bounded read model yet",
        })
        material = {
            "query": {key: value for key, value in request_value.items() if key != "cursor"},
            "clusters": clusters,
            "members": members,
            "edges": [],
            "continuation": {"cursor": next_cursor, "hasMore": has_more},
        }
        return {
            "schemaId": GRAPH_WINDOW_RESPONSE_SCHEMA,
            "consistency": "follow-latest",
            "query": {key: value for key, value in request_value.items() if key != "schemaId"},
            "windowHash": hashlib.sha256(graph_window_canonical_json(material).encode("utf-8")).hexdigest(),
            "clusters": clusters,
            "members": members,
            "edges": [],
            "focus": {"ref": root_ref} if root_ref else None,
            "providers": providers,
            "provenance": {
                "workspaceId": request_value["workspaceId"],
                "source": "tenant-scoped PostgreSQL aggregate window",
                "memberReferences": "exact-pinned-only",
            },
            "continuation": {
                "cursor": next_cursor,
                "hasMore": has_more,
                "model": "replace-page",
            },
        }


@app.post("/graph/window")
async def read_graph_window(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not secrets.compare_digest(request.headers.get("X-GB-Graph-Window-Gateway", ""), "v1"):
        raise HTTPException(status_code=404, detail="Not found")
    request_value = await _read_graph_window_request(request)
    try:
        response = await run_in_threadpool(_build_graph_window, request_value, identity)
        return JSONResponse(
            content=response,
            headers={"Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache"},
        )
    except HTTPException:
        raise
    except GraphWindowError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    except Exception as error:
        log.error("graph window error: %s", error)
        raise HTTPException(status_code=503, detail="Graph window provider is unavailable") from error


@app.get("/object-links")
def list_object_links(
    ref: str,
    limit: int = 50,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        canonical_reference(ref)
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    cur = get_conn().cursor()
    try:
        cur.execute(
            f"""SELECT {OBJECT_LINK_COLUMNS}, 1 AS version FROM gb_object_links AS link
                WHERE tenant_id = %s AND (from_ref = %s OR to_ref = %s)
                  AND NOT EXISTS (
                    SELECT 1 FROM gb_object_link_retractions AS correction
                     WHERE correction.tenant_id = link.tenant_id AND correction.link_id = link.id
                  )
                ORDER BY created_at DESC, id DESC LIMIT %s""",
            (identity.tenant_id, ref, ref, limit),
        )
        rows = [row_to_dict(row) for row in cur.fetchall()]
        access = _authorize_object_references(
            cur,
            [ref, *(endpoint for row in rows for endpoint in (row["from_ref"], row["to_ref"]))],
            identity,
        )
        if access.get(ref) is None:
            raise HTTPException(status_code=404, detail="Object referent was not found or is not readable")
        return [
            row for row in rows
            if access.get(row["from_ref"]) is not None and access.get(row["to_ref"]) is not None
        ]
    except HTTPException:
        raise
    except Exception as error:
        log.error("list_object_links error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to read object links") from error


@app.post("/object-links", status_code=201)
async def create_object_link(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_human_session_link_mutation(request, identity)
    try:
        link = validate_link_payload(await _read_object_link_json(request))
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if link["idempotency_key"].startswith("gb.internal:"):
        raise HTTPException(status_code=422, detail="Reserved object link idempotency key")
    conn = get_conn()
    try:
        with _transaction(conn) as cur:
            return _persist_object_link(cur, identity, link)
    except HTTPException:
        raise
    except Exception as error:
        log.error("create_object_link error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to create object link") from error


def _persist_object_link(cur, identity: IdentityContext, link: dict) -> dict:
    """Persist one already-validated assertion inside the caller's transaction."""
    encoded = json.dumps(link, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    request_sha256 = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    access = _authorize_object_references(
        cur, (link["from_ref"], link["to_ref"]), identity,
    )
    if any(access.get(link[field]) is None for field in ("from_ref", "to_ref")):
        raise HTTPException(status_code=404, detail="Object referent was not found or is not readable")
    cur.execute(
        f"""INSERT INTO gb_object_links (
              tenant_id, from_ref, to_ref, relation, basis, provenance,
              created_by_principal_id, idempotency_key, request_sha256
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            RETURNING {OBJECT_LINK_COLUMNS}""",
        (
            identity.tenant_id, link["from_ref"], link["to_ref"],
            link["relation"], link["basis"],
            psycopg2.extras.Json(link["provenance"]), identity.principal_id,
            link["idempotency_key"], request_sha256,
        ),
    )
    row = cur.fetchone()
    if row is not None:
        return {**row_to_dict(row), "version": 1}
    cur.execute(
        f"""SELECT {OBJECT_LINK_COLUMNS}, request_sha256
            FROM gb_object_links
            WHERE tenant_id = %s AND idempotency_key = %s""",
        (identity.tenant_id, link["idempotency_key"]),
    )
    existing = cur.fetchone()
    if existing is None or existing["request_sha256"] != request_sha256:
        raise HTTPException(status_code=409, detail="Idempotency key already used for another link")
    return {**row_to_dict({key: existing[key] for key in (
        "id", "from_ref", "to_ref", "relation", "basis", "provenance",
        "created_by_principal_id", "created_at",
    )}), "version": 1}


@app.post("/relation-proposals", status_code=201)
async def create_relation_proposal(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not secrets.compare_digest(
        request.headers.get("X-GB-Agent-Tool-Gateway", ""), "v1",
    ):
        raise HTTPException(status_code=404, detail="Not found")
    if identity.principal_kind != "agent":
        raise HTTPException(status_code=403, detail="Relation proposals require an authenticated agent")
    try:
        proposal = validate_relation_proposal_payload(
            await _read_object_link_json(request, MAX_PROPOSAL_BODY_BYTES),
        )
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    encoded = json.dumps(proposal, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    request_sha256 = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    provenance = {
        "source": "agent-tool",
        "tool": "relations.propose",
        "principal_kind": identity.principal_kind,
    }
    conn = get_conn()
    try:
        with _transaction(conn) as cur:
            access = _authorize_object_references(
                cur, (proposal["fromRef"], proposal["toRef"]), identity,
            )
            if any(access.get(proposal[field]) is None for field in ("fromRef", "toRef")):
                raise HTTPException(status_code=404, detail="Object referent was not found or is not readable")
            cur.execute(
                """INSERT INTO gb_object_link_proposals (
                       tenant_id, from_ref, to_ref, relation, rationale, provenance,
                       created_by_principal_id, idempotency_key, request_sha256
                   ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
                   RETURNING id, from_ref, to_ref, relation, status, request_sha256, created_at""",
                (
                    identity.tenant_id, proposal["fromRef"], proposal["toRef"],
                    proposal["relation"], proposal["rationale"],
                    psycopg2.extras.Json(provenance), identity.principal_id,
                    proposal["idempotencyKey"], request_sha256,
                ),
            )
            row = row_to_dict(cur.fetchone())
            replayed = False
            if row is None:
                cur.execute(
                    """SELECT id, from_ref, to_ref, relation, status, request_sha256, created_at
                         FROM gb_object_link_proposals
                        WHERE tenant_id = %s AND idempotency_key = %s""",
                    (identity.tenant_id, proposal["idempotencyKey"]),
                )
                row = row_to_dict(cur.fetchone())
                if row is None or row["request_sha256"] != request_sha256:
                    raise HTTPException(status_code=409, detail={
                        "code": "idempotency_key_reused",
                        "message": "Idempotency key was reused with different input",
                    })
                replayed = True
            if row["status"] != "pending":
                raise HTTPException(status_code=500, detail="Relation proposal state is invalid")
            return {
                "schemaId": "gb.relation-proposal-receipt.v1",
                "proposalId": str(row["id"]),
                "fromRef": row["from_ref"],
                "toRef": row["to_ref"],
                "relation": row["relation"],
                "status": "pending",
                "requestHash": row["request_sha256"],
                "replayed": replayed,
                "createdAt": row_to_dict({"value": row["created_at"]})["value"],
            }
    except HTTPException:
        raise
    except Exception as error:
        log.error("create_relation_proposal error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to create relation proposal") from error


def _relation_proposal_uuid(proposal_id: str) -> str:
    try:
        return str(UUID(proposal_id))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Invalid relation proposal identifier") from error


def _require_human_relation_reviewer(identity: IdentityContext) -> None:
    if identity.principal_kind != "human":
        raise HTTPException(status_code=403, detail="Relation proposals require human review")


def _require_human_session_link_mutation(request: Request, identity: IdentityContext) -> None:
    if identity.principal_kind != "human" or not secrets.compare_digest(
        request.headers.get("X-GB-Human-Session", ""), "v1",
    ):
        raise HTTPException(
            status_code=403,
            detail="Active object links require an authenticated human browser session",
        )


def _require_human_session_mark_mutation(request: Request, identity: IdentityContext) -> None:
    if identity.principal_kind != "human" or not secrets.compare_digest(
        request.headers.get("X-GB-Human-Session", ""), "v1",
    ):
        raise HTTPException(
            status_code=403,
            detail="Document marks require an authenticated human browser session",
        )


def _require_human_session_observation_mutation(request: Request, identity: IdentityContext) -> None:
    if identity.principal_kind != "human" or not secrets.compare_digest(
        request.headers.get("X-GB-Human-Session", ""), "v1",
    ):
        raise HTTPException(
            status_code=403,
            detail="Experiment observations require an authenticated human browser session",
        )


def _require_relation_review_gateway(request: Request) -> None:
    if not secrets.compare_digest(
        request.headers.get("X-GB-Relation-Review-Gateway", ""), "v1",
    ):
        raise HTTPException(status_code=404, detail="Not found")


def _relation_proposal_accept_eligible(row: dict) -> bool:
    try:
        return all(
            parse_canonical_reference(row[field]).revision is not None
            for field in ("from_ref", "to_ref")
        )
    except ObjectLinkError:
        return False


def _relation_review_cursor(row: dict, identity: IdentityContext) -> str:
    payload = json.dumps({
        "created_at": row_to_dict({"value": row["created_at"]})["value"],
        "id": str(row["id"]),
        "tenant_id": identity.tenant_id,
        "principal_id": identity.principal_id,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new((PROXY_TOKEN or "unconfigured").encode("utf-8"), payload, hashlib.sha256).digest()
    return ".".join(
        base64.urlsafe_b64encode(part).decode("ascii").rstrip("=")
        for part in (payload, signature)
    )


def _parse_relation_review_cursor(
    value: str | None, identity: IdentityContext,
) -> tuple[datetime, str] | None:
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= 512 or value.count(".") != 1:
        raise HTTPException(status_code=422, detail="Invalid relation review cursor")
    try:
        encoded_payload, encoded_signature = value.split(".", 1)
        payload = base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        signature = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        expected = hmac.new(
            (PROXY_TOKEN or "unconfigured").encode("utf-8"), payload, hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        decoded = json.loads(payload.decode("utf-8", "strict"))
        if not isinstance(decoded, dict) or set(decoded) != {
            "created_at", "id", "tenant_id", "principal_id",
        }:
            raise ValueError("shape")
        if (decoded["tenant_id"] != identity.tenant_id
                or decoded["principal_id"] != identity.principal_id):
            raise ValueError("scope")
        created_at = datetime.fromisoformat(decoded["created_at"])
        if created_at.tzinfo is None:
            raise ValueError("timezone")
        return created_at, str(UUID(decoded["id"]))
    except (TypeError, ValueError, UnicodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="Invalid relation review cursor") from error


@app.get("/relation-proposals")
def list_relation_proposals(
    request: Request,
    limit: int = 20,
    cursor: str | None = None,
    identity: IdentityContext = Depends(require_identity),
):
    _require_relation_review_gateway(request)
    _require_human_relation_reviewer(identity)
    if not 1 <= limit <= 20:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 20")
    continuation = _parse_relation_review_cursor(cursor, identity)
    # Twenty conforming proposals remain below both the remote authorization
    # transport and the dedicated 256 KiB response cap because proposal input
    # is itself normalized and capped at 8 KiB before persistence.
    scan_limit = 20
    cur = get_conn().cursor()
    try:
        cursor_clause = ""
        parameters: list[Any] = [identity.tenant_id]
        if continuation is not None:
            cursor_clause = "AND (proposal.created_at, proposal.id) > (%s, %s)"
            parameters.extend(continuation)
        parameters.append(scan_limit + 1)
        cur.execute(
            f"""SELECT proposal.id, proposal.from_ref, proposal.to_ref,
                      proposal.relation, proposal.rationale, proposal.provenance,
                      proposal.created_at
                 FROM gb_object_link_proposals AS proposal
                WHERE proposal.tenant_id = %s
                  AND NOT EXISTS (
                    SELECT 1 FROM gb_object_link_proposal_decisions AS decision
                     WHERE decision.tenant_id = proposal.tenant_id
                       AND decision.proposal_id = proposal.id
                  )
                  {cursor_clause}
                ORDER BY proposal.created_at ASC, proposal.id ASC
                LIMIT %s""",
            tuple(parameters),
        )
        rows = [row_to_dict(row) for row in cur.fetchall()]
        access = _authorize_object_references(
            cur,
            [endpoint for row in rows for endpoint in (row["from_ref"], row["to_ref"])],
            identity,
        )
        proposals = []
        last_scanned = None
        for row in rows[:scan_limit]:
            last_scanned = row
            if (access.get(row["from_ref"]) is None or access.get(row["to_ref"]) is None):
                continue
            proposals.append({
                "schemaId": "gb.relation-proposal-review-item.v1",
                "proposalId": str(row["id"]),
                "fromRef": row["from_ref"],
                "toRef": row["to_ref"],
                "relation": row["relation"],
                "rationale": row["rationale"],
                "source": "agent-tool",
                "currentVersion": 1,
                "status": "pending",
                "acceptEligible": _relation_proposal_accept_eligible(row),
                "createdAt": row_to_dict({"value": row["created_at"]})["value"],
            })
            if len(proposals) == limit:
                break
        scanned_count = 0 if last_scanned is None else rows.index(last_scanned) + 1
        has_more = scanned_count < len(rows)
        return {
            "schemaId": "gb.relation-proposal-review-page.v1",
            "items": proposals,
            "bounded": has_more,
            "nextCursor": _relation_review_cursor(last_scanned, identity) if has_more and last_scanned else None,
        }
    except HTTPException:
        raise
    except Exception as error:
        log.error("list_relation_proposals error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to read relation proposals") from error


def _proposal_decision_response(proposal: dict, decision: dict, *, replayed: bool) -> dict:
    return {
        "schemaId": "gb.relation-proposal-decision-receipt.v1",
        "proposalId": str(proposal["id"]),
        "fromRef": proposal["from_ref"],
        "toRef": proposal["to_ref"],
        "relation": proposal["relation"],
        "decision": decision["decision"],
        "currentVersion": decision["decision_version"],
        "objectLinkId": str(decision["object_link_id"]) if decision["object_link_id"] else None,
        "replayed": replayed,
        "decidedAt": row_to_dict({"value": decision["created_at"]})["value"],
    }


def _require_agent_result_gateway(request: Request) -> None:
    if not secrets.compare_digest(
        request.headers.get("X-GB-Paper-Agent-Result-Gateway", ""), "v1",
    ):
        raise HTTPException(status_code=404, detail="Not found")


async def _read_agent_result_json(request: Request) -> object:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_AGENT_RESULT_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Agent result decision exceeds its size limit")
        chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks).decode("utf-8", "strict"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise HTTPException(status_code=400, detail="Agent result decision must be valid UTF-8 JSON") from error


def _agent_result_anchor_and_backlink(
    cur,
    identity: IdentityContext,
    document_revision_id: str,
    anchor_id: str,
    task_id: str,
) -> tuple[str, str, str]:
    cur.execute(
        """SELECT anchor.representation_sha256
             FROM gb_document_anchors AS anchor
             JOIN gb_document_representations AS representation
               ON representation.tenant_id = anchor.tenant_id
              AND representation.id = anchor.representation_id
              AND representation.content_sha256 = anchor.representation_sha256
            WHERE anchor.tenant_id = %s AND anchor.id = %s
              AND representation.document_revision_id = %s
              AND anchor.identity_version = 'gb.anchor.v1'
            LIMIT 1""",
        (identity.tenant_id, anchor_id, document_revision_id),
    )
    anchor = cur.fetchone()
    if anchor is None:
        raise HTTPException(status_code=404, detail="Agent result source was not found")
    anchor_ref = pinned_anchor_reference(anchor_id, anchor["representation_sha256"])
    cur.execute(
        """SELECT link.from_ref, link.to_ref, link.provenance
             FROM gb_object_links AS link
            WHERE link.tenant_id = %s AND link.relation = 'context_for'
              AND (link.from_ref = %s OR link.to_ref = %s)
              AND NOT EXISTS (
                SELECT 1 FROM gb_object_link_retractions AS correction
                 WHERE correction.tenant_id = link.tenant_id
                   AND correction.link_id = link.id
              )
            ORDER BY link.created_at ASC, link.id ASC""",
        (identity.tenant_id, anchor_ref, anchor_ref),
    )
    for row in cur.fetchall():
        other_ref = row["to_ref"] if row["from_ref"] == anchor_ref else row["from_ref"]
        provenance = row["provenance"] if isinstance(row["provenance"], dict) else {}
        try:
            parsed = parse_canonical_reference(other_ref)
            created = parse_canonical_reference(provenance.get("source_ref"))
        except ObjectLinkError:
            continue
        if (
            parsed.kind == "ham.task"
            and parsed.identifier == task_id
            and parsed.revision is None
            and created.kind == "ham.task"
            and created.identifier == task_id
            and created.revision is not None
            and re.fullmatch(r"version:[1-9][0-9]{0,14}", created.revision)
        ):
            return anchor_ref, created.wire, parsed.wire
    raise HTTPException(status_code=404, detail="Agent result task backlink was not found")


def _agent_result_review_response(
    decision: dict | None,
    *,
    task_version: int,
    event_id: str,
    result_hash_ref: str,
) -> dict:
    review_state = decision["decision"] if decision is not None else "unreviewed"
    result_ref = None
    if review_state == "accepted":
        result_ref = pinned_document_reference(
            str(decision["document_id"]), decision["document_revision_sha256"],
        )
    return {
        "schemaId": "gb.paper-agent-result-review.v1",
        "reviewState": review_state,
        "taskVersion": task_version,
        "eventId": event_id,
        "resultHash": result_hash_ref,
        "resultRef": result_ref,
    }


def _select_agent_result_candidate(
    cur,
    identity: IdentityContext,
    document_revision_id: str,
    anchor_id: str,
    task_id: str,
    task_version: int,
    event_id: str,
    result_sha256: str,
) -> dict | None:
    cur.execute(
        """SELECT id, anchor_ref, created_task_ref, terminal_task_ref,
                  terminal_task_version, terminal_event_id, occurred_at, run_id, performed_by_ref,
                  result_sha256, summary_markdown, evidence_refs, request_sha256
             FROM gb_agent_result_candidates
            WHERE tenant_id = %s AND document_revision_id = %s AND anchor_id = %s
              AND ham_task_id = %s AND terminal_task_version = %s
              AND terminal_event_id = %s AND result_sha256 = %s""",
        (
            identity.tenant_id, document_revision_id, anchor_id, task_id,
            task_version, event_id, result_sha256,
        ),
    )
    return row_to_dict(cur.fetchone())


def _select_agent_result_decision(cur, identity: IdentityContext, candidate_id: str) -> dict | None:
    cur.execute(
        """SELECT id, decision, document_id, document_revision_id,
                  document_revision_sha256, request_sha256, created_at
             FROM gb_agent_result_decisions
            WHERE tenant_id = %s AND candidate_id = %s""",
        (identity.tenant_id, candidate_id),
    )
    return row_to_dict(cur.fetchone())


@app.get("/documents/{document_revision_id}/anchors/{anchor_id}/agent-results/{task_id}")
def get_paper_agent_result_review(
    document_revision_id: str,
    anchor_id: str,
    task_id: str,
    request: Request,
    task_version: str,
    event_id: str,
    result_sha256: str,
    identity: IdentityContext = Depends(require_identity),
):
    _require_agent_result_gateway(request)
    _require_human_relation_reviewer(identity)
    document_revision_id = _canonical_uuid(document_revision_id, "document revision")
    try:
        lookup = parse_agent_result_lookup(task_version, event_id, result_sha256)
    except AgentResultContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    cur = get_conn().cursor()
    _agent_result_anchor_and_backlink(
        cur, identity, document_revision_id, anchor_id, task_id,
    )
    candidate = _select_agent_result_candidate(
        cur, identity, document_revision_id, anchor_id, task_id,
        lookup["task_version"], lookup["event_id"], lookup["result_sha256"],
    )
    decision = (
        _select_agent_result_decision(cur, identity, str(candidate["id"]))
        if candidate is not None else None
    )
    return _agent_result_review_response(
        decision,
        task_version=lookup["task_version"],
        event_id=lookup["event_id"],
        result_hash_ref=lookup["result_hash_ref"],
    )


@app.post(
    "/documents/{document_revision_id}/anchors/{anchor_id}/agent-results/{task_id}",
    status_code=201,
)
async def decide_paper_agent_result(
    document_revision_id: str,
    anchor_id: str,
    task_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_agent_result_gateway(request)
    _require_human_session_link_mutation(request, identity)
    document_revision_id = _canonical_uuid(document_revision_id, "document revision")
    try:
        normalized = parse_agent_result_decision(await _read_agent_result_json(request))
    except AgentResultContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if normalized["task_id"] != task_id:
        raise HTTPException(status_code=422, detail="Agent result task does not match route")

    conn = get_conn()
    try:
        with _transaction(conn) as cur:
            anchor_ref, created_task_ref, active_task_ref = _agent_result_anchor_and_backlink(
                cur, identity, document_revision_id, anchor_id, task_id,
            )
            created_task = parse_canonical_reference(created_task_ref)
            created_task_version = int(created_task.revision.removeprefix("version:"))
            if normalized["task_version"] < created_task_version:
                raise HTTPException(
                    status_code=409,
                    detail="Terminal task version predates the source backlink",
                )
            references = [
                anchor_ref, active_task_ref, *normalized["evidence_refs"],
            ]
            access = _authorize_object_references(cur, references, identity)
            if any(access.get(reference) is None for reference in references):
                raise HTTPException(status_code=404, detail="Agent result evidence was not found or is not readable")

            identity_lock = json.dumps([
                identity.tenant_id, document_revision_id, anchor_id, task_id,
                normalized["task_version"], normalized["event_id"], normalized["result_sha256"],
            ], separators=(",", ":"), ensure_ascii=False)
            cur.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (identity_lock,),
            )
            candidate = _select_agent_result_candidate(
                cur, identity, document_revision_id, anchor_id, task_id,
                normalized["task_version"], normalized["event_id"], normalized["result_sha256"],
            )
            cur.execute(
                """SELECT id, request_sha256
                     FROM gb_agent_result_candidates
                    WHERE tenant_id = %s AND idempotency_key = %s""",
                (identity.tenant_id, normalized["idempotency_key"]),
            )
            idempotent_candidate = row_to_dict(cur.fetchone())
            if idempotent_candidate is not None and (
                candidate is None
                or str(idempotent_candidate["id"]) != str(candidate["id"])
                or idempotent_candidate["request_sha256"] != normalized["candidate_sha256"]
            ):
                raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
            if candidate is None:
                cur.execute(
                    """INSERT INTO gb_agent_result_candidates (
                           tenant_id, document_revision_id, anchor_id, anchor_ref,
                           ham_task_id, created_task_ref, terminal_task_version,
                           terminal_task_ref, terminal_event_id, occurred_at, run_id, performed_by_ref,
                           result_sha256, summary_markdown, evidence_refs,
                           created_by_principal_id, idempotency_key, request_sha256
                       ) VALUES (
                           %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                           %s, %s, %s, %s, %s, %s, %s
                       ) RETURNING id, anchor_ref, created_task_ref, terminal_task_ref,
                                   terminal_task_version, terminal_event_id, occurred_at, run_id,
                                   performed_by_ref, result_sha256, summary_markdown,
                                   evidence_refs, request_sha256""",
                    (
                        identity.tenant_id, document_revision_id, anchor_id, anchor_ref,
                        task_id, created_task_ref, normalized["task_version"],
                        normalized["terminal_task_ref"], normalized["event_id"],
                        normalized["occurred_at"], normalized["run_id"], normalized["performed_by_ref"],
                        normalized["result_sha256"], normalized["summary"],
                        psycopg2.extras.Json(normalized["evidence_refs"]),
                        identity.principal_id, normalized["idempotency_key"],
                        normalized["candidate_sha256"],
                    ),
                )
                candidate = row_to_dict(cur.fetchone())
            elif candidate["request_sha256"] != normalized["candidate_sha256"]:
                raise HTTPException(status_code=409, detail="Terminal agent result snapshot changed")

            cur.execute(
                """SELECT id, candidate_id, decision, document_id, document_revision_id,
                          document_revision_sha256, request_sha256, created_at
                     FROM gb_agent_result_decisions
                    WHERE tenant_id = %s AND idempotency_key = %s""",
                (identity.tenant_id, normalized["idempotency_key"]),
            )
            replay = row_to_dict(cur.fetchone())
            if replay is not None:
                if (
                    str(replay["candidate_id"]) != str(candidate["id"])
                    or replay["request_sha256"] != normalized["request_sha256"]
                ):
                    raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
                return _agent_result_review_response(
                    replay,
                    task_version=normalized["task_version"],
                    event_id=normalized["event_id"],
                    result_hash_ref=normalized["result_hash_ref"],
                )
            decision = _select_agent_result_decision(cur, identity, str(candidate["id"]))
            if decision is not None:
                raise HTTPException(status_code=409, detail="Agent result was already reviewed")

            result_document = None
            if normalized["action"] == "accept":
                raw = normalized["summary"].encode("utf-8")
                content_sha256 = sha256_bytes(raw)
                filename = f"ham-result-{normalized['result_sha256'][:16]}.md"
                title = f"Research result for {task_id}"
                metadata = {
                    "title": title,
                    "originalFilename": filename,
                    "displayFilename": filename,
                    "mediaType": "text/markdown; charset=utf-8",
                    "sourceKind": "ham-task-result",
                    "sourceUri": f"ham:task:{task_id}",
                    "arxivId": None,
                }
                revision_sha256 = sha256_bytes(json.dumps(
                    {**metadata, "contentSha256": content_sha256},
                    sort_keys=True, separators=(",", ":"),
                ).encode("utf-8"))
                result_document, _ = _persist_document_import(
                    cur,
                    identity,
                    raw=raw,
                    normalized_media_type=metadata["mediaType"],
                    metadata=metadata,
                    idempotency_key=f"gb.internal:agent-result:{candidate['id']}",
                    request_sha256=normalized["candidate_sha256"],
                    revision_sha256=revision_sha256,
                    source_metadata={
                        "schemaId": "gb.ham-task-result-source.v1",
                        "terminalTaskRef": normalized["terminal_task_ref"],
                        "terminalEventId": normalized["event_id"],
                        "resultHash": normalized["result_hash_ref"],
                    },
                )
                result_ref = pinned_document_reference(
                    str(result_document["document_id"]), result_document["revision_sha256"],
                )
                link_targets = [
                    (active_task_ref, "derived_from", "task"),
                    (anchor_ref, "context_for", "anchor"),
                    *(
                        (reference, "cites", f"citation:{index}")
                        for index, reference in enumerate(normalized["evidence_refs"])
                    ),
                ]
                for target_ref, relation, suffix in link_targets:
                    link_input = validate_link_payload({
                        "from_ref": result_ref,
                        "to_ref": target_ref,
                        "relation": relation,
                        "basis": "authored",
                        "provenance": {
                            "source": "manual",
                            "source_system": "galaxy.agent-result-review.v1",
                            "source_ref": normalized["terminal_task_ref"],
                        },
                        "idempotency_key": f"gb.internal:agent-result:{candidate['id']}:{suffix}",
                    })
                    _persist_object_link(cur, identity, link_input)

            stored_decision = "accepted" if normalized["action"] == "accept" else "rejected"
            cur.execute(
                """INSERT INTO gb_agent_result_decisions (
                       tenant_id, candidate_id, decision, reason, document_id,
                       document_revision_id, document_revision_sha256,
                       created_by_principal_id, idempotency_key, request_sha256
                   ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id, decision, document_id, document_revision_id,
                             document_revision_sha256, request_sha256, created_at""",
                (
                    identity.tenant_id, candidate["id"], stored_decision,
                    "Accepted by human research review" if stored_decision == "accepted"
                    else "Rejected by human research review",
                    result_document["document_id"] if result_document else None,
                    result_document["revision_id"] if result_document else None,
                    result_document["revision_sha256"] if result_document else None,
                    identity.principal_id, normalized["idempotency_key"],
                    normalized["request_sha256"],
                ),
            )
            decision = row_to_dict(cur.fetchone())
            return _agent_result_review_response(
                decision,
                task_version=normalized["task_version"],
                event_id=normalized["event_id"],
                result_hash_ref=normalized["result_hash_ref"],
            )
    except HTTPException:
        raise
    except Exception as error:
        log.error("decide_paper_agent_result error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to decide agent result") from error


@app.post("/relation-proposals/{proposal_id}/decisions", status_code=201)
async def decide_relation_proposal(
    proposal_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_relation_review_gateway(request)
    _require_human_relation_reviewer(identity)
    proposal_id = _relation_proposal_uuid(proposal_id)
    try:
        decision_input = validate_relation_proposal_decision_payload(
            await _read_object_link_json(request, MAX_PROPOSAL_DECISION_BODY_BYTES),
        )
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    encoded = json.dumps(decision_input, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    request_sha256 = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    conn = get_conn()
    try:
        with _transaction(conn) as cur:
            cur.execute(
                """SELECT id, from_ref, to_ref, relation, rationale
                     FROM gb_object_link_proposals
                    WHERE tenant_id = %s AND id = %s
                    FOR UPDATE""",
                (identity.tenant_id, proposal_id),
            )
            proposal = row_to_dict(cur.fetchone())
            if proposal is None:
                raise HTTPException(status_code=404, detail="Relation proposal not found")
            access = _authorize_object_references(
                cur, (proposal["from_ref"], proposal["to_ref"]), identity,
            )
            if any(access.get(proposal[field]) is None for field in ("from_ref", "to_ref")):
                raise HTTPException(status_code=404, detail="Relation proposal not found")

            cur.execute(
                """SELECT id, proposal_id, decision_version, decision, object_link_id,
                          request_sha256, created_at
                     FROM gb_object_link_proposal_decisions
                    WHERE tenant_id = %s AND idempotency_key = %s""",
                (identity.tenant_id, decision_input["idempotency_key"]),
            )
            replay = row_to_dict(cur.fetchone())
            if replay is not None:
                if str(replay["proposal_id"]) != proposal_id or replay["request_sha256"] != request_sha256:
                    raise HTTPException(status_code=409, detail={
                        "code": "idempotency_key_reused",
                        "message": "Idempotency key was reused with different input",
                    })
                return _proposal_decision_response(proposal, replay, replayed=True)

            cur.execute(
                """SELECT decision_version, decision
                     FROM gb_object_link_proposal_decisions
                    WHERE tenant_id = %s AND proposal_id = %s""",
                (identity.tenant_id, proposal_id),
            )
            current = cur.fetchone()
            if current is not None:
                raise HTTPException(status_code=409, detail={
                    "code": "stale_relation_proposal",
                    "message": "Relation proposal was already decided",
                    "current_version": current["decision_version"],
                    "current_decision": current["decision"],
                })
            if decision_input["expected_version"] != 1:
                raise HTTPException(status_code=409, detail={
                    "code": "stale_relation_proposal",
                    "message": "Relation proposal version is stale",
                    "current_version": 1,
                })

            object_link_id = None
            stored_decision = "accepted" if decision_input["decision"] == "accept" else "rejected"
            if stored_decision == "accepted":
                parsed_from = parse_canonical_reference(proposal["from_ref"])
                parsed_to = parse_canonical_reference(proposal["to_ref"])
                if parsed_from.revision is None or parsed_to.revision is None:
                    raise HTTPException(
                        status_code=422,
                        detail="Only exact pinned relation proposals can be accepted",
                    )
                link_input = validate_link_payload({
                    "from_ref": proposal["from_ref"],
                    "to_ref": proposal["to_ref"],
                    "relation": proposal["relation"],
                    "basis": "authored",
                    "provenance": {
                        "source": "manual",
                        "source_system": "galaxy.relation-review.v1",
                    },
                    "idempotency_key": f"gb.internal:relation-proposal:{proposal_id}",
                })
                relation_lock = json.dumps([
                    identity.tenant_id, link_input["from_ref"], link_input["to_ref"],
                    link_input["relation"], "authored",
                ], separators=(",", ":"), ensure_ascii=False)
                cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (relation_lock,),
                )
                # Proposal review promotes semantic intent, so two accepted
                # proposals for the same active authored tuple converge here.
                # Direct human-authored assertions keep the object-link
                # ledger's existing independent idempotency semantics.
                cur.execute(
                    """SELECT link.id
                         FROM gb_object_links AS link
                        WHERE link.tenant_id = %s
                          AND link.from_ref = %s AND link.to_ref = %s
                          AND link.relation = %s AND link.basis = 'authored'
                          AND NOT EXISTS (
                            SELECT 1 FROM gb_object_link_retractions AS correction
                             WHERE correction.tenant_id = link.tenant_id
                               AND correction.link_id = link.id
                          )
                        ORDER BY link.created_at ASC, link.id ASC
                        LIMIT 1""",
                    (
                        identity.tenant_id, link_input["from_ref"], link_input["to_ref"],
                        link_input["relation"],
                    ),
                )
                existing_link = cur.fetchone()
                if existing_link is not None:
                    object_link_id = existing_link["id"]
                else:
                    link = _persist_object_link(cur, identity, link_input)
                    object_link_id = link["id"]

            cur.execute(
                """INSERT INTO gb_object_link_proposal_decisions (
                       tenant_id, proposal_id, decision_version, decision, reason,
                       object_link_id, created_by_principal_id, idempotency_key,
                       request_sha256
                   ) VALUES (%s, %s, 2, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
                   RETURNING id, proposal_id, decision_version, decision,
                             object_link_id, request_sha256, created_at""",
                (
                    identity.tenant_id, proposal_id, stored_decision,
                    decision_input["reason"], object_link_id, identity.principal_id,
                    decision_input["idempotency_key"], request_sha256,
                ),
            )
            stored = row_to_dict(cur.fetchone())
            if stored is None:
                cur.execute(
                    """SELECT id, proposal_id, decision_version, decision,
                              object_link_id, request_sha256, created_at
                         FROM gb_object_link_proposal_decisions
                        WHERE tenant_id = %s AND idempotency_key = %s""",
                    (identity.tenant_id, decision_input["idempotency_key"]),
                )
                stored = row_to_dict(cur.fetchone())
                if (stored is None or str(stored["proposal_id"]) != proposal_id
                        or stored["request_sha256"] != request_sha256):
                    raise HTTPException(status_code=409, detail={
                        "code": "idempotency_key_reused",
                        "message": "Idempotency key was reused with different input",
                    })
                return _proposal_decision_response(proposal, stored, replayed=True)
            return _proposal_decision_response(proposal, stored, replayed=False)
    except HTTPException:
        raise
    except Exception as error:
        log.error("decide_relation_proposal error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to decide relation proposal") from error


def _object_link_uuid(link_id: str) -> str:
    try:
        return str(UUID(link_id))
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Invalid object link identifier") from error


@app.get("/object-links/{link_id}/history")
def object_link_history(link_id: str, identity: IdentityContext = Depends(require_identity)):
    link_id = _object_link_uuid(link_id)
    cur = get_conn().cursor()
    try:
        cur.execute(
            f"""SELECT {OBJECT_LINK_COLUMNS} FROM gb_object_links
                 WHERE tenant_id = %s AND id = %s""",
            (identity.tenant_id, link_id),
        )
        assertion = cur.fetchone()
        if assertion is None:
            raise HTTPException(status_code=404, detail="Object link not found")
        cur.execute(
            f"""SELECT {OBJECT_LINK_RETRACTION_COLUMNS} FROM gb_object_link_retractions
                 WHERE tenant_id = %s AND link_id = %s""",
            (identity.tenant_id, link_id),
        )
        correction = cur.fetchone()
        access = _authorize_object_references(
            cur, (assertion["from_ref"], assertion["to_ref"]), identity,
        )
        if any(access.get(assertion[field]) is None for field in ("from_ref", "to_ref")):
            raise HTTPException(status_code=404, detail="Object link not found")
        return {
            "assertion": {**row_to_dict(assertion), "version": 1},
            "retraction": {**row_to_dict(correction), "version": 2} if correction else None,
            "current_version": 2 if correction else 1,
            "active": correction is None,
        }
    except HTTPException:
        raise
    except Exception as error:
        log.error("object_link_history error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to read object link history") from error


@app.post("/object-links/{link_id}/retract", status_code=201)
async def retract_object_link(
    link_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_human_session_link_mutation(request, identity)
    link_id = _object_link_uuid(link_id)
    try:
        correction = validate_retraction_payload(await _read_object_link_json(request))
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    encoded = json.dumps(correction, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    request_sha256 = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    conn = get_conn()
    try:
        with _transaction(conn) as cur:
            cur.execute(
                """SELECT id, created_by_principal_id FROM gb_object_links
                    WHERE tenant_id = %s AND id = %s""",
                (identity.tenant_id, link_id),
            )
            assertion = cur.fetchone()
            if assertion is None:
                raise HTTPException(status_code=404, detail="Object link not found")
            if (str(assertion["created_by_principal_id"]) != identity.principal_id
                    and identity.role not in {"owner", "admin"}):
                raise HTTPException(status_code=403, detail="Only the creator or a tenant administrator can retract a link")
            if correction["expected_version"] != 1:
                raise HTTPException(status_code=409, detail="Object link version has changed")
            cur.execute(
                f"""INSERT INTO gb_object_link_retractions (
                      tenant_id, link_id, expected_version, reason,
                      retracted_by_principal_id, idempotency_key, request_sha256
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    RETURNING {OBJECT_LINK_RETRACTION_COLUMNS}""",
                (
                    identity.tenant_id, link_id, correction["expected_version"],
                    correction["reason"], identity.principal_id,
                    correction["idempotency_key"], request_sha256,
                ),
            )
            row = cur.fetchone()
            if row is not None:
                return {**row_to_dict(row), "version": 2}
            cur.execute(
                f"""SELECT {OBJECT_LINK_RETRACTION_COLUMNS}, idempotency_key, request_sha256
                    FROM gb_object_link_retractions
                    WHERE tenant_id = %s AND link_id = %s""",
                (identity.tenant_id, link_id),
            )
            existing = cur.fetchone()
            if (existing is None or existing["idempotency_key"] != correction["idempotency_key"]
                    or existing["request_sha256"] != request_sha256):
                raise HTTPException(status_code=409, detail="Object link was already retracted or idempotency key was reused")
            return {**row_to_dict({key: existing[key] for key in (
                "id", "link_id", "expected_version", "reason",
                "retracted_by_principal_id", "created_at",
            )}), "version": 2}
    except HTTPException:
        raise
    except Exception as error:
        log.error("retract_object_link error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to retract object link") from error


BUILTIN_DATASOURCE_PLUGINS = [
    DatasourcePluginManifest(
        id="filesystem-vault",
        display_name="Filesystem Vault",
        kind="filesystem",
        capabilities=["list", "fetch", "sync", "watch"],
        auth_type="path",
        is_builtin=True,
    ),
]


# ---------------------------------------------------------------------------
# Endpoints — Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    try:
        cur = get_conn().cursor()
        cur.execute("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        log.warning("Health check DB error: %s", e)
        return {"status": "ok", "db": "error"}


# ---------------------------------------------------------------------------
# Endpoints - Datasources
# ---------------------------------------------------------------------------

@app.get("/datasources/plugins")
def list_datasource_plugins():
    try:
        cur = get_conn().cursor()
        cur.execute(
            """
            SELECT id, display_name, kind, capabilities, auth_type, is_builtin, created_at, updated_at
            FROM gb_datasource_plugins
            ORDER BY display_name
            """
        )
        return [row_to_dict(r) for r in cur.fetchall()]
    except Exception as e:
        log.error("list_datasource_plugins error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to list datasource plugins") from e


@app.get("/datasources/connections")
def list_datasource_connections(
    plugin_id: Optional[str] = None,
    status: Optional[str] = None,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        cur = get_conn().cursor()
        conditions = ["c.tenant_id = %s"]
        params = [identity.tenant_id]
        if plugin_id:
            conditions.append("c.plugin_id = %s")
            params.append(plugin_id)
        if status:
            conditions.append("c.status = %s")
            params.append(status)
        where = "WHERE " + " AND ".join(conditions)
        cur.execute(
            f"""
            SELECT
                c.*,
                p.display_name AS plugin_display_name,
                p.kind AS plugin_kind,
                p.capabilities AS plugin_capabilities
            FROM gb_datasource_connections c
            JOIN gb_datasource_plugins p ON p.id = c.plugin_id
            {where}
            ORDER BY c.updated_at DESC
            """,
            params,
        )
        return [row_to_dict(r) for r in cur.fetchall()]
    except Exception as e:
        log.error("list_datasource_connections error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to list datasource connections") from e


@app.post("/datasources/connections")
def create_datasource_connection(req: DatasourceConnectionCreate, identity: IdentityContext = Depends(require_identity)):
    try:
        cur = get_conn().cursor()
        cur.execute("SELECT id FROM gb_datasource_plugins WHERE id = %s", (req.plugin_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Datasource plugin {req.plugin_id} not found")

        root_path = req.root_path
        if req.plugin_id == "filesystem-vault":
            if not root_path:
                raise HTTPException(status_code=422, detail="Filesystem datasources require a configured root path")
            try:
                root_path = authorize_tenant_root(
                    FILESYSTEM_ROOTS_BY_TENANT,
                    identity.tenant_id,
                    root_path,
                )
            except PermissionError as error:
                raise HTTPException(status_code=403, detail=str(error)) from error
            if not os.path.isdir(root_path):
                raise HTTPException(status_code=422, detail="Datasource root path does not exist")

        cur.execute(
            """
            INSERT INTO gb_datasource_connections (
                tenant_id, created_by_principal_id, plugin_id, display_name, root_path, config
            ) VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                identity.tenant_id, identity.principal_id, req.plugin_id,
                req.display_name, root_path, json.dumps(req.config),
            ),
        )
        return row_to_dict(cur.fetchone())
    except HTTPException:
        raise
    except Exception as e:
        log.error("create_datasource_connection error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to create datasource connection") from e


@app.patch("/datasources/connections/{connection_id}")
def update_datasource_connection(
    connection_id: str,
    req: DatasourceConnectionUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        connection = _get_datasource_connection_or_404(connection_id, identity)
        cur = get_conn().cursor()

        updates = {k: v for k, v in req.model_dump().items() if v is not None}
        if not updates:
            cur.execute(
                "SELECT * FROM gb_datasource_connections WHERE id = %s AND tenant_id = %s",
                (connection_id, identity.tenant_id),
            )
            unchanged = row_to_dict(cur.fetchone())
            if unchanged is None:
                raise HTTPException(status_code=404, detail=f"Datasource connection {connection_id} not found")
            return unchanged

        if "config" in updates:
            updates["config"] = json.dumps(updates["config"])
        if "root_path" in updates and connection["plugin_id"] == "filesystem-vault":
            try:
                root_path = authorize_tenant_root(
                    FILESYSTEM_ROOTS_BY_TENANT,
                    identity.tenant_id,
                    updates["root_path"],
                )
            except PermissionError as error:
                raise HTTPException(status_code=403, detail=str(error)) from error
            if not os.path.isdir(root_path):
                raise HTTPException(status_code=422, detail="Datasource root path does not exist")
            updates["root_path"] = root_path

        set_parts = [sql.SQL("{} = %s").format(sql.Identifier(col)) for col in updates]
        set_parts.append(sql.SQL("updated_at = now()"))
        query = sql.SQL(
            "UPDATE gb_datasource_connections SET {} WHERE id = %s AND tenant_id = %s RETURNING *"
        ).format(
            sql.SQL(", ").join(set_parts)
        )
        params = list(updates.values())
        params.extend([connection_id, identity.tenant_id])
        cur.execute(query, params)
        updated = row_to_dict(cur.fetchone())
        if updated is None:
            raise HTTPException(status_code=404, detail=f"Datasource connection {connection_id} not found")
        return updated
    except HTTPException:
        raise
    except Exception as e:
        log.error("update_datasource_connection error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to update datasource connection") from e


@app.post("/datasources/{connection_id}/sync")
def sync_datasource_connection(connection_id: str, identity: IdentityContext = Depends(require_identity)):
    try:
        connection = _get_datasource_connection_or_404(connection_id, identity)
        binding = _resolve_filesystem_root(connection, identity)
        listing = enumerate_authorized_datasource_files(
            binding,
            MAX_DATASOURCE_ENUMERATION_ITEMS,
        )
        item_count = len(listing.entries)
        cur = get_conn().cursor()
        next_cursor = datetime.utcnow().isoformat()
        cur.execute(
            """
            INSERT INTO gb_datasource_sync_runs (
                tenant_id, created_by_principal_id, connection_id,
                status, imported_count, next_cursor, completed_at
            ) VALUES (%s, %s, %s, %s, %s, %s, now())
            RETURNING *
            """,
            (
                identity.tenant_id, identity.principal_id, connection_id,
                "completed", item_count, next_cursor,
            ),
        )
        sync_run = row_to_dict(cur.fetchone())

        cur.execute(
            """
            UPDATE gb_datasource_connections
            SET last_synced_at = now(), last_sync_cursor = %s, last_error = NULL, updated_at = now()
            WHERE id = %s AND tenant_id = %s
            RETURNING *
            """,
            (next_cursor, connection_id, identity.tenant_id),
        )
        updated_connection = row_to_dict(cur.fetchone())
        if updated_connection is None:
            raise HTTPException(status_code=404, detail=f"Datasource connection {connection_id} not found")
        message = (
            f"Scanned at least {item_count} item(s) from {connection['display_name']}; "
            "the safe inventory cap was reached."
            if listing.truncated
            else f"Scanned {item_count} item(s) from {connection['display_name']}."
        )
        return {
            "connection": updated_connection,
            "sync_run": sync_run,
            "message": message,
            "inventory_truncated": listing.truncated,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error("sync_datasource_connection error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to scan datasource connection") from e


@app.get("/datasources/{connection_id}/items")
def list_datasource_items(
    connection_id: str,
    limit: int = DEFAULT_ITEM_LIMIT,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        connection = _get_datasource_connection_or_404(connection_id, identity)
        binding = _resolve_filesystem_root(connection, identity)
        listing = enumerate_authorized_datasource_files(binding)
        capped_limit = max(1, min(limit, MAX_ITEM_LIMIT))
        items = [_datasource_listing_item(entry) for entry in listing.entries[:capped_limit]]
        return {
            "connection": connection,
            "items": items,
            "count": len(items),
            "truncated": listing.truncated or len(listing.entries) > capped_limit,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error("list_datasource_items error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to list datasource items") from e


@app.post("/datasources/{connection_id}/import")
def import_datasource_items(
    connection_id: str,
    req: DatasourceImportRequest,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        if not req.item_ids:
            raise HTTPException(status_code=400, detail="Provide at least one datasource item id to import")
        connection = _get_datasource_connection_or_404(connection_id, identity)
        binding = _resolve_filesystem_root(connection, identity)
        imported = [_read_filesystem_item(binding, item_id) for item_id in req.item_ids]
        return {
            "connection": connection,
            "items": imported,
            "count": len(imported),
        }
    except DatasourceFileNotFound as error:
        raise HTTPException(status_code=404, detail="Datasource item is not available") from error
    except DatasourceFileTooLarge as error:
        raise HTTPException(status_code=413, detail="Datasource item exceeds the 100 MB import limit") from error
    except DatasourceFileRejected as error:
        raise HTTPException(status_code=415, detail="Datasource item cannot be imported safely") from error
    except HTTPException:
        raise
    except Exception as e:
        log.error("import_datasource_items error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to import datasource items") from e


@app.post("/datasources/{connection_id}/content")
def read_datasource_item_content(
    connection_id: str,
    req: DatasourceContentRequest,
    identity: IdentityContext = Depends(require_identity),
):
    """Read one exact tenant-authorized file for the durable ingestion endpoint."""
    try:
        connection = _get_datasource_connection_or_404(connection_id, identity)
        binding = _resolve_filesystem_root(connection, identity)
        exact = read_authorized_datasource_file(binding, req.item_id, MAX_DOCUMENT_BYTES)
        content = exact.content
        content_sha256 = sha256_bytes(content)
        filename = urllib.parse.quote(exact.filename, safe="")
        return Response(
            content,
            media_type=exact.media_type,
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
                "ETag": f'"sha256:{content_sha256}"',
                "X-Content-SHA256": content_sha256,
                "X-Content-Type-Options": "nosniff",
            },
        )
    except DatasourceFileNotFound as error:
        raise HTTPException(status_code=404, detail="Datasource item is not available") from error
    except DatasourceFileTooLarge as error:
        raise HTTPException(status_code=413, detail="Datasource item exceeds the 100 MB import limit") from error
    except DatasourceFileRejected as error:
        raise HTTPException(status_code=415, detail="Datasource item cannot be imported safely") from error
    except HTTPException:
        raise
    except Exception as error:
        log.error("read_datasource_item_content error: %s", error)
        raise HTTPException(status_code=500, detail="Unable to read datasource item") from error


# ---------------------------------------------------------------------------
# Endpoints - Node Revisions
# ---------------------------------------------------------------------------

@app.get("/node-revisions/{node_id}")
def list_node_revisions(node_id: str, limit: int = 100):
    try:
        capped_limit = max(1, min(limit, 500))
        cur = get_conn().cursor()
        cur.execute(
            """
            SELECT id, node_id, version, timestamp, source, summary, changed_fields, snapshot_json, created_at
            FROM gb_node_revisions
            WHERE node_id = %s
            ORDER BY timestamp DESC, created_at DESC
            LIMIT %s
            """,
            (node_id, capped_limit),
        )
        return [row_to_dict(r) for r in cur.fetchall()]
    except Exception as e:
        log.error("list_node_revisions error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/node-revisions/bulk")
def upsert_node_revisions(revisions: List[NodeRevisionUpsert], identity: IdentityContext = Depends(require_identity)):
    try:
        if not revisions:
            return {"upserted": 0}

        cur = get_conn().cursor()
        for revision in revisions:
            cur.execute(
                """
                INSERT INTO gb_node_revisions (
                    tenant_id, created_by_principal_id, id, node_id, version,
                    timestamp, source, summary, changed_fields, snapshot_json
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET node_id = EXCLUDED.node_id,
                    version = EXCLUDED.version,
                    timestamp = EXCLUDED.timestamp,
                    source = EXCLUDED.source,
                    summary = EXCLUDED.summary,
                    changed_fields = EXCLUDED.changed_fields,
                    snapshot_json = EXCLUDED.snapshot_json
                """,
                (
                    identity.tenant_id,
                    identity.principal_id,
                    revision.id,
                    revision.node_id,
                    revision.version,
                    revision.timestamp,
                    revision.source,
                    revision.summary,
                    revision.changed_fields,
                    json.dumps(revision.snapshot_json),
                ),
            )
        return {"upserted": len(revisions)}
    except Exception as e:
        log.error("upsert_node_revisions error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Endpoints - Typed immutable share bundles
# ---------------------------------------------------------------------------

async def _read_share_bundle_create(request: Request) -> dict:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_SHARE_BUNDLE_CREATE_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Share bundle selector exceeds 16 KiB")
        chunks.append(chunk)

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ShareBundleError("Share bundle request contains duplicate fields")
            value[key] = item
        return value

    try:
        decoded = b"".join(chunks).decode("utf-8", "strict")
        value = json.loads(decoded, object_pairs_hook=unique_fields)
        validate_share_bundle_create_request(value)
        return value
    except (UnicodeError, json.JSONDecodeError, ShareBundleError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _share_bundle_response(row: dict) -> dict:
    core = dict(row["snapshot_json"])
    return {
        "id": str(row["id"]),
        **core,
        "contentHash": row["content_hash"],
        "createdAt": row_to_dict({"value": row["created_at"]})["value"],
    }


def _share_bundle_replay(cur, identity: IdentityContext, idempotency_key: str, req_hash: str) -> Optional[dict]:
    cur.execute(
        """SELECT id, snapshot_json, content_hash, request_hash, created_at
             FROM gb_share_snapshots
            WHERE tenant_id = %s AND bundle_schema_id = ANY(%s) AND idempotency_key = %s""",
        (identity.tenant_id, list(SHARE_BUNDLE_SCHEMAS), idempotency_key),
    )
    existing = row_to_dict(cur.fetchone())
    if existing is None:
        return None
    if existing["request_hash"] != req_hash:
        raise HTTPException(status_code=409, detail={
            "code": "idempotency_key_reused",
            "message": "Idempotency key was reused with a different share selector",
        })
    return _share_bundle_response(existing)


def _exact_conversation_snapshot(cur, conversation: dict, conversation_reference) -> dict:
    """Load one immutable historical conversation under an existing tenant lock."""
    if conversation_reference.kind != "chat" or conversation_reference.revision is None:
        raise HTTPException(status_code=422, detail="Exact conversation snapshot requires a pinned chat reference")
    if conversation_reference.identifier.lower() != str(conversation["id"]).lower():
        raise HTTPException(status_code=422, detail="Conversation reference does not match the requested conversation")
    cur.execute(
        """SELECT version, content_hash
             FROM gb_conversation_revisions
            WHERE tenant_id = %s AND conversation_id = %s
              AND content_hash = %s""",
        (
            conversation["tenant_id"],
            conversation["id"],
            conversation_reference.revision,
        ),
    )
    exact_revision = row_to_dict(cur.fetchone())
    if exact_revision is None:
        raise HTTPException(status_code=404, detail="Exact conversation revision was not found")
    cur.execute(
        """SELECT COUNT(*) AS turn_count,
                  COALESCE(SUM(
                    CASE WHEN revision.role IN ('user', 'assistant')
                         THEN octet_length(revision.content) ELSE 0 END
                  ), 0) AS published_bytes
             FROM gb_conversation_turns AS turn
             JOIN gb_conversation_turn_revisions AS revision
               ON revision.tenant_id = turn.tenant_id
              AND revision.conversation_id = turn.conversation_id
              AND revision.turn_id = turn.id
              AND revision.version = 1
            WHERE turn.tenant_id = %s AND turn.conversation_id = %s
              AND turn.introduced_in_version <= %s""",
        (conversation["tenant_id"], conversation["id"], exact_revision["version"]),
    )
    portable_size = row_to_dict(cur.fetchone())
    if portable_size is None or portable_size["turn_count"] > 1000:
        raise HTTPException(status_code=422, detail="Conversation exceeds the 1000-turn portable snapshot bound")
    if portable_size["turn_count"] != exact_revision["version"] - 1:
        raise HTTPException(status_code=422, detail="Conversation historical snapshot is incomplete")
    if portable_size["published_bytes"] > MAX_CONVERSATION_PORTABLE_CONTENT_BYTES:
        raise HTTPException(status_code=413, detail="Conversation publishable content exceeds 8 MiB")
    cur.execute(
        """SELECT turn.id, turn.ordinal, revision.role,
                  CASE WHEN revision.role IN ('user', 'assistant')
                       THEN revision.content ELSE NULL END AS content,
                  revision.content_hash
             FROM gb_conversation_turns AS turn
             JOIN gb_conversation_turn_revisions AS revision
               ON revision.tenant_id = turn.tenant_id
              AND revision.conversation_id = turn.conversation_id
              AND revision.turn_id = turn.id
              AND revision.version = 1
            WHERE turn.tenant_id = %s AND turn.conversation_id = %s
              AND turn.introduced_in_version <= %s
            ORDER BY turn.ordinal
            LIMIT 1001""",
        (conversation["tenant_id"], conversation["id"], exact_revision["version"]),
    )
    turn_rows = [row_to_dict(row) for row in cur.fetchall()]
    if len(turn_rows) > 1000:
        raise HTTPException(status_code=422, detail="Conversation exceeds the 1000-turn portable snapshot bound")
    edge_rows = []
    if turn_rows:
        cur.execute(
            """SELECT id, from_turn_id, to_turn_id, edge_kind
                 FROM gb_conversation_edges
                WHERE tenant_id = %s AND conversation_id = %s
                  AND introduced_in_version <= %s
                ORDER BY introduced_in_version, id
                LIMIT 8001""",
            (
                conversation["tenant_id"],
                conversation["id"],
                exact_revision["version"],
            ),
        )
        edge_rows = [row_to_dict(row) for row in cur.fetchall()]
        if len(edge_rows) > 8000:
            raise HTTPException(status_code=422, detail="Conversation exceeds the 8000-edge portable snapshot bound")
    safe_component = "~!*'()-._"
    exact_conversation_ref = conversation_reference.wire
    turns = [{
        "turnId": str(row["id"]),
        "ordinal": row["ordinal"],
        "role": row["role"],
        "content": row["content"],
        "ref": canonical_reference(
            "gb:object:v1:turn:"
            f"{urllib.parse.quote(str(row['id']), safe=safe_component)}:pinned:"
            f"{urllib.parse.quote(row['content_hash'], safe=safe_component)}"
        ),
        "contentHash": row["content_hash"],
    } for row in turn_rows]
    edges = [{
        "edgeId": str(row["id"]),
        "fromTurnId": str(row["from_turn_id"]),
        "toTurnId": str(row["to_turn_id"]),
        "kind": row["edge_kind"],
    } for row in edge_rows]
    return {
        "conversationId": str(conversation["id"]),
        "workspaceId": conversation["workspace_id"],
        "ref": exact_conversation_ref,
        "title": conversation["title"],
        "goal": conversation["goal"],
        "version": exact_revision["version"],
        "contentHash": exact_revision["content_hash"],
        "turns": turns,
        "edges": edges,
    }


def _build_share_bundle(mode: str, selector: dict, identity: IdentityContext) -> dict:
    conn = get_conn()
    if mode == "canvas-plus-conversation":
        try:
            conversation_reference = parse_canonical_reference(selector["conversationRef"])
        except ObjectLinkError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        with _transaction(conn) as cur:
            canvas = _canvas_or_404(selector["canvasId"], identity, cur=cur)
            cur.execute(
                """SELECT version, content_hash, snapshot_json
                     FROM gb_canvas_revisions
                    WHERE tenant_id = %s AND canvas_id = %s
                      AND version = %s AND content_hash = %s""",
                (
                    identity.tenant_id,
                    canvas["id"],
                    selector["version"],
                    selector["contentHash"],
                ),
            )
            canvas_revision = row_to_dict(cur.fetchone())
            if canvas_revision is None:
                raise HTTPException(status_code=404, detail="Exact canvas revision was not found")
            conversation = _conversation_or_404(
                conversation_reference.identifier,
                identity,
                cur=cur,
                for_share=True,
            )
            if canvas["workspace_id"] != conversation["workspace_id"]:
                raise HTTPException(status_code=422, detail="Canvas and conversation workspaces do not match")
            frozen_conversation = _exact_conversation_snapshot(
                cur,
                conversation,
                conversation_reference,
            )
            try:
                return build_canvas_conversation_bundle(
                    canvas,
                    canvas_revision,
                    frozen_conversation,
                )
            except ShareBundleError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

    if mode == "canvas-only":
        with _transaction(conn) as cur:
            canvas = _canvas_or_404(selector["canvasId"], identity, cur=cur)
            cur.execute(
                """SELECT version, content_hash, snapshot_json
                     FROM gb_canvas_revisions
                    WHERE tenant_id = %s AND canvas_id = %s
                      AND version = %s AND content_hash = %s""",
                (
                    identity.tenant_id,
                    canvas["id"],
                    selector["version"],
                    selector["contentHash"],
                ),
            )
            revision = row_to_dict(cur.fetchone())
            if revision is None:
                raise HTTPException(status_code=404, detail="Exact canvas revision was not found")
            try:
                return build_canvas_bundle(canvas, revision)
            except ShareBundleError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

    if "nodeId" in selector:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, node_id, snapshot_json
                 FROM gb_node_revisions
                WHERE tenant_id = %s AND node_id = %s AND id = %s""",
            (identity.tenant_id, selector["nodeId"], selector["revisionId"]),
        )
        revision = row_to_dict(cur.fetchone())
        if revision is None:
            raise HTTPException(status_code=404, detail="Exact object revision was not found")
        try:
            return build_node_bundle(
                selector["nodeId"], selector["revisionId"], revision["snapshot_json"],
            )
        except ShareBundleError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    response = _resolve_projection_source_request([selector["objectRef"]], identity)
    try:
        return build_object_bundle(selector["objectRef"], response["results"][0])
    except ShareBundleError as error:
        status = 404 if "not found or is not readable" in str(error) else 422
        raise HTTPException(status_code=status, detail=str(error)) from error


@app.post("/share-bundles", status_code=201)
async def create_share_bundle(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    value = await _read_share_bundle_create(request)
    mode, selector, idempotency_key = validate_share_bundle_create_request(value)
    req_hash = share_bundle_request_hash(mode, selector)
    cur = get_conn().cursor()
    replay = _share_bundle_replay(cur, identity, idempotency_key, req_hash)
    if replay is not None:
        return replay
    bundle = await run_in_threadpool(_build_share_bundle, mode, selector, identity)
    try:
        cur = get_conn().cursor()
        cur.execute(
            """INSERT INTO gb_share_snapshots (
                   tenant_id, created_by_principal_id, target_type, target_id,
                   access, snapshot_json, bundle_schema_id, mode, content_hash,
                   idempotency_key, request_hash
               ) VALUES (%s, %s, %s, %s, 'tenant-read', %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, idempotency_key)
                 WHERE bundle_schema_id IN ('gb.share-bundle.v1', 'gb.share-bundle.v2')
               DO NOTHING
               RETURNING id, snapshot_json, content_hash, request_hash, created_at""",
            (
                identity.tenant_id,
                identity.principal_id,
                bundle["target_type"],
                bundle["target_id"],
                psycopg2.extras.Json(bundle["snapshot_json"]),
                bundle["snapshot_json"]["schemaId"],
                mode,
                bundle["content_hash"],
                idempotency_key,
                req_hash,
            ),
        )
        created = row_to_dict(cur.fetchone())
        if created is not None:
            return _share_bundle_response(created)
        replay = _share_bundle_replay(cur, identity, idempotency_key, req_hash)
        if replay is not None:
            return replay
        raise HTTPException(status_code=409, detail="Share bundle creation conflicted")
    except HTTPException:
        raise
    except psycopg2.Error as error:
        log.error("create_share_bundle database error: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="Share bundle storage is unavailable") from error


@app.get("/share-bundles/{bundle_id}")
def get_share_bundle(
    bundle_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    try:
        normalized_id = str(UUID(bundle_id))
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Share bundle not found") from error
    cur = get_conn().cursor()
    cur.execute(
        """SELECT id, snapshot_json, content_hash, request_hash, created_at
             FROM gb_share_snapshots
            WHERE id = %s AND tenant_id = %s AND bundle_schema_id = ANY(%s)""",
        (normalized_id, identity.tenant_id, list(SHARE_BUNDLE_SCHEMAS)),
    )
    bundle = row_to_dict(cur.fetchone())
    if bundle is None:
        raise HTTPException(status_code=404, detail="Share bundle not found")
    return _share_bundle_response(bundle)


@app.get("/share-snapshots/{snapshot_id}")
def get_legacy_share_snapshot(
    snapshot_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    """Read a pre-v1 share snapshot without reopening the legacy write API."""
    try:
        normalized_id = str(UUID(snapshot_id))
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Share snapshot not found") from error
    cur = get_conn().cursor()
    cur.execute(
        """SELECT id, target_type, target_id, access, snapshot_json, created_at
             FROM gb_share_snapshots
            WHERE id = %s AND tenant_id = %s AND bundle_schema_id IS NULL""",
        (normalized_id, identity.tenant_id),
    )
    snapshot = row_to_dict(cur.fetchone())
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Share snapshot not found")
    return snapshot


# ---------------------------------------------------------------------------
# Endpoints — Durable conversations and turn DAGs
# ---------------------------------------------------------------------------

def _conversation_value(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except ConversationContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _conversation_uuid(conversation_id: str) -> str:
    try:
        return str(UUID(conversation_id))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid conversation identifier") from error


def _conversation_or_404(
    conversation_id: str,
    identity: IdentityContext,
    *,
    cur=None,
    for_update: bool = False,
    for_share: bool = False,
) -> dict:
    if for_update and for_share:
        raise ValueError("conversation lock mode is ambiguous")
    normalized_id = _conversation_uuid(conversation_id)
    cursor = cur or get_conn().cursor()
    query = "SELECT * FROM gb_conversations WHERE id = %s AND tenant_id = %s"
    if for_update:
        query += " FOR UPDATE"
    elif for_share:
        query += " FOR SHARE"
    cursor.execute(query, (normalized_id, identity.tenant_id))
    conversation = row_to_dict(cursor.fetchone())
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


def _conversation_read(
    cur,
    conversation: dict,
    *,
    after_ordinal: int = 0,
    limit: int = 100,
) -> dict:
    cur.execute(
        """SELECT turn.id, turn.ordinal, revision.role, revision.content,
                  revision.artifact_refs, revision.provenance,
                  revision.content_hash, turn.created_at
             FROM gb_conversation_turns AS turn
             JOIN gb_conversation_turn_revisions AS revision
               ON revision.tenant_id = turn.tenant_id
              AND revision.conversation_id = turn.conversation_id
              AND revision.turn_id = turn.id
              AND revision.version = 1
            WHERE turn.tenant_id = %s AND turn.conversation_id = %s
              AND turn.ordinal > %s
            ORDER BY turn.ordinal
            LIMIT %s""",
        (conversation["tenant_id"], conversation["id"], after_ordinal, limit + 1),
    )
    turn_rows = [row_to_dict(row) for row in cur.fetchall()]
    has_more = len(turn_rows) > limit
    turns = turn_rows[:limit]
    turn_ids = [row["id"] for row in turns]
    edges = []
    parent_turns = []
    if turn_ids:
        cur.execute(
            """SELECT id, from_turn_id, to_turn_id, edge_kind, created_at
                 FROM gb_conversation_edges
                WHERE tenant_id = %s AND conversation_id = %s
                  AND to_turn_id = ANY(%s::uuid[])
                ORDER BY created_at, id""",
            (conversation["tenant_id"], conversation["id"], turn_ids),
        )
        edges = [row_to_dict(row) for row in cur.fetchall()]
        page_turn_ids = {str(turn_id) for turn_id in turn_ids}
        parent_ids = sorted({
            str(row["from_turn_id"]) for row in edges
            if str(row["from_turn_id"]) not in page_turn_ids
        })
        if parent_ids:
            cur.execute(
                """SELECT turn.id, turn.ordinal, revision.role, revision.content,
                          revision.artifact_refs, revision.provenance,
                          revision.content_hash, turn.created_at
                     FROM gb_conversation_turns AS turn
                     JOIN gb_conversation_turn_revisions AS revision
                       ON revision.tenant_id = turn.tenant_id
                      AND revision.conversation_id = turn.conversation_id
                      AND revision.turn_id = turn.id
                      AND revision.version = 1
                    WHERE turn.tenant_id = %s AND turn.conversation_id = %s
                      AND turn.id = ANY(%s::uuid[])
                    ORDER BY turn.ordinal""",
                (conversation["tenant_id"], conversation["id"], parent_ids),
            )
            parent_turns = [row_to_dict(row) for row in cur.fetchall()]
    return _conversation_value(
        build_conversation_read_projection,
        conversation,
        turns,
        edges,
        parent_turns=parent_turns,
        after_ordinal=after_ordinal,
        limit=limit,
        has_more=has_more,
    )


def _conversation_replay(cur, conversation_id: str, idempotency_key: str, request_hash: str) -> Optional[dict]:
    cur.execute(
        """SELECT id, version, content_hash, mutation_kind, mutation_json, request_hash
             FROM gb_conversation_revisions
            WHERE conversation_id = %s AND idempotency_key = %s""",
        (conversation_id, idempotency_key),
    )
    revision = row_to_dict(cur.fetchone())
    if revision is None:
        return None
    if revision["request_hash"] != request_hash:
        raise HTTPException(status_code=409, detail={
            "code": "idempotency_key_reused",
            "message": "Idempotency key was reused with different input",
        })
    return revision


def _authorize_conversation_artifacts(cur, references, identity: IdentityContext) -> None:
    if not references:
        return
    decisions = _authorize_object_references(cur, references, identity)
    if any(decisions.get(reference) is None for reference in references):
        raise HTTPException(status_code=404, detail="Conversation artifact was not found or is not readable")


def _conversation_mutation_receipt(conversation_id: str, revision: dict, *, replayed: bool) -> dict:
    mutation = dict(revision["mutation_json"])
    return {
        "schemaId": "gb.conversation.mutation-receipt.v1",
        "conversationId": conversation_id,
        "version": revision["version"],
        "contentHash": revision["content_hash"],
        "revisionId": str(revision["id"]),
        "turnId": mutation["turnId"],
        "operation": revision["mutation_kind"],
        "replayed": replayed,
    }


@app.get("/conversations")
def list_conversations(
    workspace_id: Optional[str] = Query(default=None, min_length=1, max_length=128),
    cursor: Optional[str] = Query(default=None, min_length=1, max_length=8_192),
    limit: int = Query(default=50, ge=1, le=200),
    identity: IdentityContext = Depends(require_identity),
):
    normalized_workspace = (
        _conversation_value(normalize_conversation_workspace_id, workspace_id)
        if workspace_id is not None else None
    )
    continuation = (
        _conversation_value(decode_conversation_list_cursor, cursor, PROXY_TOKEN)
        if cursor is not None else None
    )
    if continuation is not None and (
        continuation["tenant_id"] != identity.tenant_id
        or continuation["workspace_id"] != normalized_workspace
    ):
        raise HTTPException(status_code=422, detail="Conversation cursor does not match the requested scope")
    conn = get_conn()
    with _transaction(conn) as cur:
        if continuation is None:
            cur.execute(
                "SELECT pg_current_snapshot()::text AS snapshot, clock_timestamp() AS issued_at"
            )
            snapshot_row = row_to_dict(cur.fetchone())
            snapshot = snapshot_row["snapshot"]
            issued_at = snapshot_row["issued_at"]
            after_id = None
        else:
            snapshot = continuation["snapshot"]
            issued_at = continuation["issued_at"]
            after_id = continuation["after_id"]
        candidate_predicates = [
            "creation.tenant_id = %s",
            "creation.version = 1",
            "creation.mutation_kind = 'create'",
            "pg_visible_in_snapshot(creation.xmin::text::xid8, %s::pg_snapshot)",
        ]
        candidate_parameters = [identity.tenant_id, snapshot]
        if normalized_workspace is not None:
            candidate_predicates.append("creation.mutation_json->>'workspaceId' = %s")
            candidate_parameters.append(normalized_workspace)
        if after_id is not None:
            candidate_predicates.append("creation.conversation_id < %s::uuid")
            candidate_parameters.append(after_id)
        candidate_parameters.extend((limit + 1, identity.tenant_id, snapshot))
        cur.execute(
            f"""WITH visible_creation_candidates AS MATERIALIZED (
                    SELECT creation.conversation_id, creation.mutation_json,
                           creation.created_at
                      FROM gb_conversation_revisions AS creation
                     WHERE {' AND '.join(candidate_predicates)}
                     ORDER BY creation.conversation_id DESC
                     LIMIT %s
                  )
                SELECT creation.conversation_id AS id,
                       creation.mutation_json->>'workspaceId' AS workspace_id,
                       creation.mutation_json->>'title' AS title,
                       creation.mutation_json->>'goal' AS goal,
                       creation.mutation_json->'artifactRefs' AS artifact_refs,
                       creation.created_at,
                       head.version AS snapshot_version,
                       head.content_hash AS snapshot_content_hash,
                       head.created_at AS snapshot_updated_at
                  FROM visible_creation_candidates AS creation
                  JOIN LATERAL (
                    SELECT revision.version, revision.content_hash,
                           revision.created_at
                      FROM gb_conversation_revisions AS revision
                     WHERE revision.tenant_id = %s
                       AND revision.conversation_id = creation.conversation_id
                       AND pg_visible_in_snapshot(
                         revision.xmin::text::xid8,
                         %s::pg_snapshot
                       )
                     ORDER BY revision.version DESC
                     LIMIT 1
                  ) AS head ON TRUE
                 ORDER BY creation.conversation_id DESC""",
            tuple(candidate_parameters),
        )
        rows = [row_to_dict(row) for row in cur.fetchall()]
        has_more = len(rows) > limit
        return _conversation_value(
            build_conversation_list_response,
            rows[:limit],
            snapshot=snapshot,
            issued_at=issued_at,
            tenant_id=identity.tenant_id,
            workspace=normalized_workspace,
            cursor_secret=PROXY_TOKEN,
            limit=limit,
            has_more=has_more,
        )


@app.post("/conversations", status_code=201)
def create_conversation(req: ConversationCreate, identity: IdentityContext = Depends(require_identity)):
    normalized = _conversation_value(normalize_conversation_create, req.model_dump())
    conn = get_conn()
    with _transaction(conn) as cur:
        cur.execute(
            """SELECT * FROM gb_conversations
                WHERE tenant_id = %s AND creation_idempotency_key = %s
                FOR UPDATE""",
            (identity.tenant_id, normalized["idempotency_key"]),
        )
        existing = row_to_dict(cur.fetchone())
        if existing is not None:
            if existing["creation_request_hash"] != normalized["request_hash"]:
                raise HTTPException(status_code=409, detail={
                    "code": "idempotency_key_reused",
                    "message": "Idempotency key was reused with different input",
                })
            return {**_conversation_read(cur, existing), "replayed": True}
        _authorize_conversation_artifacts(cur, normalized["artifact_refs"], identity)
        cur.execute(
            """INSERT INTO gb_conversations (
                   tenant_id, workspace_id, title, goal, artifact_refs, provenance,
                   current_content_hash, created_by_principal_id,
                   creation_idempotency_key, creation_request_hash
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, creation_idempotency_key) DO NOTHING
               RETURNING *""",
            (
                identity.tenant_id, normalized["workspace_id"], normalized["title"],
                normalized["goal"], psycopg2.extras.Json(normalized["artifact_refs"]),
                psycopg2.extras.Json(normalized["provenance"]), normalized["content_hash"],
                identity.principal_id, normalized["idempotency_key"], normalized["request_hash"],
            ),
        )
        conversation = row_to_dict(cur.fetchone())
        if conversation is None:
            cur.execute(
                """SELECT * FROM gb_conversations
                    WHERE tenant_id = %s AND creation_idempotency_key = %s
                    FOR UPDATE""",
                (identity.tenant_id, normalized["idempotency_key"]),
            )
            raced = row_to_dict(cur.fetchone())
            if raced is None or raced["creation_request_hash"] != normalized["request_hash"]:
                raise HTTPException(status_code=409, detail="Conversation creation conflicts with an existing request")
            return {**_conversation_read(cur, raced), "replayed": True}
        mutation = {
            "kind": "create",
            "workspaceId": normalized["workspace_id"],
            "title": normalized["title"],
            "goal": normalized["goal"],
            "artifactRefs": normalized["artifact_refs"],
            "provenance": normalized["provenance"],
        }
        cur.execute(
            """INSERT INTO gb_conversation_revisions (
                   tenant_id, conversation_id, version, parent_content_hash,
                   content_hash, mutation_kind, mutation_json, idempotency_key,
                   request_hash, created_by_principal_id
               ) VALUES (%s, %s, 1, NULL, %s, 'create', %s, %s, %s, %s)""",
            (
                identity.tenant_id, conversation["id"], normalized["content_hash"],
                psycopg2.extras.Json(mutation), normalized["idempotency_key"],
                normalized["request_hash"], identity.principal_id,
            ),
        )
        return _conversation_read(cur, conversation)


@app.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: str,
    after_ordinal: int = Query(default=0, ge=0, le=999999),
    limit: int = Query(default=100, ge=1, le=500),
    expected_version: Optional[int] = Query(default=None, ge=1),
    expected_content_hash: Optional[str] = Query(default=None, pattern=r"^sha256:[0-9a-f]{64}$"),
    identity: IdentityContext = Depends(require_identity),
):
    if after_ordinal > 0 and (expected_version is None or expected_content_hash is None):
        raise HTTPException(status_code=422, detail={
            "code": "continuation_snapshot_required",
            "message": "Continuation reads require the original conversation version and content hash",
        })
    conn = get_conn()
    with _transaction(conn) as cur:
        conversation = _conversation_or_404(
            conversation_id, identity, cur=cur, for_share=True,
        )
        if (
            expected_version is not None
            and conversation["current_version"] != expected_version
        ) or (
            expected_content_hash is not None
            and conversation["current_content_hash"] != expected_content_hash
        ):
            raise HTTPException(status_code=409, detail={
                "code": "stale_conversation_snapshot",
                "message": "Conversation changed after the previous page was read",
                "currentVersion": conversation["current_version"],
                "currentContentHash": conversation["current_content_hash"],
            })
        return _conversation_read(cur, conversation, after_ordinal=after_ordinal, limit=limit)


@app.get("/conversations/{conversation_id}/exports/markdown")
def export_conversation_markdown(
    conversation_id: str,
    conversation_ref: str = Query(min_length=1, max_length=16_384),
    identity: IdentityContext = Depends(require_identity),
):
    """Download one immutable historical chat using the portable redaction boundary."""
    normalized_conversation_id = _conversation_uuid(conversation_id)
    parsed_conversation = _conversation_value(
        exact_conversation_reference,
        conversation_ref,
        "chat",
        normalized_conversation_id,
        "conversation_ref",
    )
    conn = get_conn()
    with _transaction(conn) as cur:
        conversation = _conversation_or_404(
            normalized_conversation_id,
            identity,
            cur=cur,
            for_share=True,
        )
        frozen = _exact_conversation_snapshot(cur, conversation, parsed_conversation)
        try:
            payload = redacted_conversation_payload(frozen)
            exported = build_conversation_markdown_export(payload)
        except ConversationMarkdownExportTooLarge as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except (ShareBundleError, ConversationMarkdownExportError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    encoded_filename = urllib.parse.quote(exported.filename, safe="")
    content_disposition = (
        f'attachment; filename="{exported.ascii_filename}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )
    return Response(
        content=exported.content,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": content_disposition,
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "ETag": f'"sha256-{exported.content_sha256}"',
            "X-Content-SHA256": exported.content_sha256,
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/conversations/{conversation_id}/turns/{turn_id}")
def get_conversation_turn(
    conversation_id: str,
    turn_id: str,
    conversation_ref: str = Query(min_length=1, max_length=16_384),
    turn_ref: str = Query(min_length=1, max_length=16_384),
    identity: IdentityContext = Depends(require_identity),
):
    normalized_conversation_id = _conversation_uuid(conversation_id)
    try:
        normalized_turn_id = str(UUID(turn_id))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid conversation turn identifier") from error
    parsed_conversation = _conversation_value(
        exact_conversation_reference,
        conversation_ref,
        "chat",
        normalized_conversation_id,
        "conversation_ref",
    )
    parsed_turn = _conversation_value(
        exact_conversation_reference,
        turn_ref,
        "turn",
        normalized_turn_id,
        "turn_ref",
    )
    conn = get_conn()
    with _transaction(conn) as cur:
        cur.execute(
            """SELECT conversation.id, conversation.workspace_id,
                      turn.id AS turn_id, turn.ordinal, turn.introduced_in_version,
                      turn_revision.role, turn_revision.content,
                      turn_revision.artifact_refs, turn_revision.provenance,
                      turn_revision.content_hash, turn.created_at,
                      introducing_revision.content_hash AS introducing_content_hash,
                      containing_revision.version AS containing_version,
                      containing_revision.content_hash AS containing_content_hash
                 FROM gb_conversations AS conversation
                 JOIN gb_conversation_turns AS turn
                   ON turn.tenant_id = conversation.tenant_id
                  AND turn.conversation_id = conversation.id
                 JOIN gb_conversation_turn_revisions AS turn_revision
                   ON turn_revision.tenant_id = turn.tenant_id
                  AND turn_revision.conversation_id = turn.conversation_id
                  AND turn_revision.turn_id = turn.id
                  AND turn_revision.version = 1
                  AND turn_revision.introduced_in_version = turn.introduced_in_version
                 JOIN gb_conversation_revisions AS introducing_revision
                   ON introducing_revision.tenant_id = turn.tenant_id
                  AND introducing_revision.conversation_id = turn.conversation_id
                  AND introducing_revision.version = turn.introduced_in_version
                 JOIN gb_conversation_revisions AS containing_revision
                   ON containing_revision.tenant_id = turn.tenant_id
                  AND containing_revision.conversation_id = turn.conversation_id
                  AND containing_revision.content_hash = %s
                  AND containing_revision.version >= turn.introduced_in_version
                WHERE conversation.tenant_id = %s
                  AND conversation.id = %s
                  AND turn.id = %s""",
            (
                parsed_conversation.revision, identity.tenant_id,
                normalized_conversation_id, normalized_turn_id,
            ),
        )
        row = row_to_dict(cur.fetchone())
        if row is None:
            raise HTTPException(status_code=404, detail="Conversation turn not found")
        turn = {**row, "id": row["turn_id"]}
        return _conversation_value(
            build_conversation_turn_resolution,
            {"id": normalized_conversation_id, "workspace_id": row["workspace_id"]},
            turn,
            conversation_reference=parsed_conversation.wire,
            turn_reference=parsed_turn.wire,
        )


def _mutate_conversation(conversation_id: str, edge_kind: str, request_value: dict,
                         identity: IdentityContext) -> dict:
    normalized_id = _conversation_uuid(conversation_id)
    operation = _conversation_value(normalize_conversation_turn_operation, edge_kind, request_value)
    mutation_kind = {"continues": "append", "forks": "fork", "joins": "join"}[edge_kind]
    conn = get_conn()
    with _transaction(conn) as cur:
        conversation = _conversation_or_404(normalized_id, identity, cur=cur, for_update=True)
        replay = _conversation_replay(
            cur, normalized_id, operation["idempotency_key"], operation["request_hash"],
        )
        if replay is not None:
            return _conversation_mutation_receipt(normalized_id, replay, replayed=True)
        if conversation["current_version"] != operation["expected_version"]:
            raise HTTPException(status_code=409, detail={
                "code": "stale_conversation",
                "message": "Conversation changed; reload before retrying",
                "currentVersion": conversation["current_version"],
                "currentContentHash": conversation["current_content_hash"],
            })
        _authorize_conversation_artifacts(cur, operation["artifact_refs"], identity)
        parent_ids = operation["parent_turn_ids"]
        if not parent_ids:
            cur.execute(
                "SELECT 1 FROM gb_conversation_turns WHERE tenant_id = %s AND conversation_id = %s LIMIT 1",
                (identity.tenant_id, normalized_id),
            )
            if cur.fetchone() is not None:
                raise HTTPException(status_code=409, detail={
                    "code": "parent_turn_required",
                    "message": "Non-root appends require one current tip",
                })
        else:
            cur.execute(
                """SELECT turn.id,
                          NOT EXISTS (
                            SELECT 1 FROM gb_conversation_edges AS edge
                             WHERE edge.tenant_id = turn.tenant_id
                               AND edge.conversation_id = turn.conversation_id
                               AND edge.from_turn_id = turn.id
                          ) AS is_tip
                     FROM gb_conversation_turns AS turn
                    WHERE turn.tenant_id = %s AND turn.conversation_id = %s
                      AND turn.id = ANY(%s::uuid[])
                    FOR SHARE""",
                (identity.tenant_id, normalized_id, parent_ids),
            )
            parents = {str(row["id"]): bool(row["is_tip"]) for row in cur.fetchall()}
            if set(parents) != set(parent_ids):
                raise HTTPException(status_code=404, detail="Parent turn not found in this conversation")
            if edge_kind in {"continues", "joins"} and not all(parents.values()):
                raise HTTPException(status_code=409, detail={
                    "code": "parent_not_tip",
                    "message": "Append and join operations require current tips",
                })
        turn_id = str(uuid4())
        next_version = conversation["current_version"] + 1
        turn_ordinal = next_version - 1
        turn_hash = conversation_turn_content_hash({
            "schemaId": "gb.conversation.turn-revision.v1",
            "conversationId": normalized_id,
            "turnId": turn_id,
            "version": 1,
            "message": operation["message"],
            "artifactRefs": operation["artifact_refs"],
            "provenance": operation["provenance"],
        })
        mutation = {
            "turnId": turn_id,
            "parentTurnIds": parent_ids,
            "message": operation["message"],
            "artifactRefs": operation["artifact_refs"],
            "provenance": operation["provenance"],
            "turnContentHash": turn_hash,
        }
        next_hash = _conversation_value(
            next_conversation_content_hash,
            conversation["current_content_hash"], next_version, mutation_kind, mutation,
        )
        cur.execute(
            """INSERT INTO gb_conversation_turns (
                   id, tenant_id, conversation_id, ordinal, introduced_in_version,
                   created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s)""",
            (
                turn_id, identity.tenant_id, normalized_id, turn_ordinal,
                next_version, identity.principal_id,
            ),
        )
        cur.execute(
            """INSERT INTO gb_conversation_turn_revisions (
                   tenant_id, conversation_id, turn_id, introduced_in_version, role, content,
                   artifact_refs, provenance, content_hash, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                identity.tenant_id, normalized_id, turn_id, next_version,
                operation["message"]["role"], operation["message"]["content"],
                psycopg2.extras.Json(operation["artifact_refs"]),
                psycopg2.extras.Json(operation["provenance"]), turn_hash,
                identity.principal_id,
            ),
        )
        for parent_id in parent_ids:
            cur.execute(
                """INSERT INTO gb_conversation_edges (
                       tenant_id, conversation_id, from_turn_id, to_turn_id,
                       introduced_in_version, edge_kind, created_by_principal_id
                   ) VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    identity.tenant_id, normalized_id, parent_id, turn_id,
                    next_version, edge_kind, identity.principal_id,
                ),
            )
        cur.execute(
            """UPDATE gb_conversations
                  SET current_version = %s, current_content_hash = %s, updated_at = now()
                WHERE tenant_id = %s AND id = %s AND current_version = %s
                RETURNING *""",
            (
                next_version, next_hash, identity.tenant_id, normalized_id,
                operation["expected_version"],
            ),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=409, detail={
                "code": "stale_conversation",
                "message": "Conversation changed while the turn was appended",
            })
        cur.execute(
            """INSERT INTO gb_conversation_revisions (
                   tenant_id, conversation_id, version, parent_content_hash,
                   content_hash, mutation_kind, mutation_json, idempotency_key,
                   request_hash, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id, version, content_hash, mutation_kind, mutation_json, request_hash""",
            (
                identity.tenant_id, normalized_id, next_version,
                conversation["current_content_hash"], next_hash, mutation_kind,
                psycopg2.extras.Json(mutation), operation["idempotency_key"],
                operation["request_hash"], identity.principal_id,
            ),
        )
        revision = row_to_dict(cur.fetchone())
        return _conversation_mutation_receipt(normalized_id, revision, replayed=False)


@app.post("/conversations/{conversation_id}/turns", status_code=201)
def append_conversation_turn(
    conversation_id: str,
    req: ConversationAppend,
    identity: IdentityContext = Depends(require_identity),
):
    return _mutate_conversation(conversation_id, "continues", req.model_dump(), identity)


@app.post("/conversations/{conversation_id}/forks", status_code=201)
def fork_conversation_turn(
    conversation_id: str,
    req: ConversationFork,
    identity: IdentityContext = Depends(require_identity),
):
    return _mutate_conversation(conversation_id, "forks", req.model_dump(), identity)


@app.post("/conversations/{conversation_id}/joins", status_code=201)
def join_conversation_turns(
    conversation_id: str,
    req: ConversationJoin,
    identity: IdentityContext = Depends(require_identity),
):
    return _mutate_conversation(conversation_id, "joins", req.model_dump(), identity)


# ---------------------------------------------------------------------------
# Endpoints — Durable canvases
# ---------------------------------------------------------------------------

def _canvas_or_404(
    canvas_id: str,
    identity: IdentityContext,
    *,
    cur=None,
    for_update: bool = False,
) -> dict:
    normalized_id = _canvas_uuid(canvas_id)
    cursor = cur or get_conn().cursor()
    query = """SELECT * FROM gb_canvases
                WHERE id = %s AND tenant_id = %s AND deleted_at IS NULL"""
    if for_update:
        query += " FOR UPDATE"
    cursor.execute(query, (normalized_id, identity.tenant_id))
    canvas = row_to_dict(cursor.fetchone())
    if canvas is None:
        raise HTTPException(status_code=404, detail="Canvas not found")
    return canvas


def _canvas_content(cur, canvas: dict) -> dict:
    canvas_id = str(canvas["id"])
    cur.execute(
        """SELECT id, subject_ref, node_type, x, y, width, height, angle,
                  z_index, display_mode, collapsed, style_json
             FROM gb_canvas_items
            WHERE canvas_id = %s AND deleted_at IS NULL
            ORDER BY id""",
        (canvas_id,),
    )
    items = [{
        "id": row["id"],
        "subjectRef": row["subject_ref"],
        "nodeType": row["node_type"],
        "x": row["x"],
        "y": row["y"],
        "width": row["width"],
        "height": row["height"],
        "angle": row["angle"],
        "zIndex": row["z_index"],
        "displayMode": row["display_mode"],
        "collapsed": row["collapsed"],
        "style": dict(row["style_json"]),
    } for row in cur.fetchall()]
    cur.execute(
        """SELECT id, source_item_id, target_item_id, edge_kind, label,
                  semantic_ref, style_json
             FROM gb_canvas_edges
            WHERE canvas_id = %s AND deleted_at IS NULL
            ORDER BY id""",
        (canvas_id,),
    )
    edges = []
    for row in cur.fetchall():
        edge = {
            "id": row["id"],
            "sourceItemId": row["source_item_id"],
            "targetItemId": row["target_item_id"],
            "edgeKind": row["edge_kind"],
            "style": dict(row["style_json"]),
        }
        if row["label"] is not None:
            edge["label"] = row["label"]
        if row["semantic_ref"] is not None:
            edge["semanticRef"] = row["semantic_ref"]
        edges.append(edge)
    snapshot = {
        "schemaId": CANVAS_SNAPSHOT_SCHEMA,
        "items": items,
        "edges": edges,
        "removedItemIds": list(canvas.get("removed_item_ids") or []),
        "removedEdgeIds": list(canvas.get("removed_edge_ids") or []),
    }
    frames = list(canvas.get("frames_json") or [])
    if frames:
        snapshot["frames"] = frames
    return _canvas_value(normalize_canvas_snapshot, snapshot)


def _canvas_envelope(canvas: dict, content: dict, *, mutation_id: Optional[str] = None,
                     replayed: bool = False) -> dict:
    content_hash = _canvas_value(canvas_snapshot_hash, content)
    if content_hash != canvas["current_content_hash"]:
        raise HTTPException(status_code=500, detail="Canvas snapshot hash does not match its revision")
    response = {
        "canvasId": str(canvas["id"]),
        "workspaceId": canvas["workspace_id"],
        "slug": canvas["slug"],
        "title": canvas["title"],
        "isDefault": canvas["is_default"],
        "projectionMode": _canvas_projection_mode(canvas.get("projection_mode")),
        "version": canvas["current_version"],
        "contentHash": content_hash,
        "content": content,
    }
    if mutation_id is not None:
        response["mutationId"] = str(mutation_id)
    if replayed:
        response["replayed"] = True
    return response


def _canvas_projection_mode(value: object) -> str:
    if value not in ("ambient", "curated"):
        raise HTTPException(status_code=500, detail="Canvas projection mode is invalid")
    return str(value)


def _canvas_mutation_receipt(
    canvas: dict,
    mutation_id: str,
    request_hash: str,
    *,
    replayed: bool = False,
) -> dict:
    return {
        "schemaId": "gb.canvas.mutation-receipt.v1",
        "canvasId": str(canvas["id"]),
        "version": canvas["current_version"],
        "contentHash": canvas["current_content_hash"],
        "mutationId": mutation_id,
        "requestHash": request_hash,
        "replayed": replayed,
    }


def _canvas_replay(cur, canvas_id: str, idempotency_key: str, request_hash: str) -> Optional[dict]:
    cur.execute(
        """SELECT id, canvas_id, version, content_hash, snapshot_json, request_hash
             FROM gb_canvas_revisions
            WHERE canvas_id = %s AND idempotency_key = %s""",
        (canvas_id, idempotency_key),
    )
    revision = row_to_dict(cur.fetchone())
    if revision is None:
        return None
    if str(revision["canvas_id"]) != canvas_id or revision["request_hash"] != request_hash:
        raise HTTPException(status_code=409, detail={
            "code": "idempotency_key_reused",
            "message": "Idempotency key was reused with different input",
        })
    content = _canvas_value(normalize_canvas_snapshot, revision["snapshot_json"])
    if _canvas_value(canvas_snapshot_hash, content) != revision["content_hash"]:
        raise HTTPException(status_code=500, detail="Canvas revision hash is invalid")
    return {**revision, "snapshot_json": content}


def _synchronize_canvas_rows(cur, canvas: dict, content: dict, identity: IdentityContext) -> None:
    canvas_id = str(canvas["id"])
    cur.execute(
        """UPDATE gb_canvases
              SET removed_item_ids = %s, removed_edge_ids = %s, frames_json = %s
            WHERE id = %s AND tenant_id = %s""",
        (
            psycopg2.extras.Json(content["removedItemIds"]),
            psycopg2.extras.Json(content["removedEdgeIds"]),
            psycopg2.extras.Json(content.get("frames", [])),
            canvas_id,
            identity.tenant_id,
        ),
    )
    cur.execute(
        "UPDATE gb_canvas_items SET deleted_at = now(), updated_at = now() WHERE canvas_id = %s AND deleted_at IS NULL",
        (canvas_id,),
    )
    for item in content["items"]:
        cur.execute(
            """INSERT INTO gb_canvas_items (
                   id, tenant_id, canvas_id, subject_ref, node_type, x, y, width,
                   height, angle, z_index, display_mode, collapsed, style_json,
                   created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, canvas_id, id) DO UPDATE SET
                   subject_ref = EXCLUDED.subject_ref,
                   node_type = EXCLUDED.node_type,
                   x = EXCLUDED.x,
                   y = EXCLUDED.y,
                   width = EXCLUDED.width,
                   height = EXCLUDED.height,
                   angle = EXCLUDED.angle,
                   z_index = EXCLUDED.z_index,
                   display_mode = EXCLUDED.display_mode,
                   collapsed = EXCLUDED.collapsed,
                   style_json = EXCLUDED.style_json,
                   updated_at = now(),
                   deleted_at = NULL""",
            (
                item["id"], identity.tenant_id, canvas_id, item["subjectRef"], item["nodeType"],
                item["x"], item["y"], item["width"], item["height"], item["angle"],
                item["zIndex"], item["displayMode"], item["collapsed"],
                psycopg2.extras.Json(item["style"]), identity.principal_id,
            ),
        )
    cur.execute(
        "UPDATE gb_canvas_edges SET deleted_at = now(), updated_at = now() WHERE canvas_id = %s AND deleted_at IS NULL",
        (canvas_id,),
    )
    for edge in content["edges"]:
        cur.execute(
            """INSERT INTO gb_canvas_edges (
                   id, tenant_id, canvas_id, source_item_id, target_item_id,
                   edge_kind, label, semantic_ref, style_json, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, canvas_id, id) DO UPDATE SET
                   source_item_id = EXCLUDED.source_item_id,
                   target_item_id = EXCLUDED.target_item_id,
                   edge_kind = EXCLUDED.edge_kind,
                   label = EXCLUDED.label,
                   semantic_ref = EXCLUDED.semantic_ref,
                   style_json = EXCLUDED.style_json,
                   updated_at = now(),
                   deleted_at = NULL""",
            (
                edge["id"], identity.tenant_id, canvas_id, edge["sourceItemId"],
                edge["targetItemId"], edge["edgeKind"], edge.get("label"),
                edge.get("semanticRef"), psycopg2.extras.Json(edge["style"]),
                identity.principal_id,
            ),
        )


def _validate_surface_placement_commands(cur, commands, identity: IdentityContext) -> None:
    """Require every new surface placement to name one exact promoted revision."""
    for command in commands:
        if command.get("type") != "item.place":
            continue
        item = command.get("item") or {}
        subject_ref = item.get("subjectRef")
        surface_node = item.get("nodeType") == "galaxy.surface"
        try:
            reference = parse_canonical_reference(subject_ref)
        except ObjectLinkError:
            if surface_node:
                raise HTTPException(status_code=422, detail="Surface placements require an exact promoted revision")
            continue
        surface_reference = reference.kind == "surface"
        if not surface_node and not surface_reference:
            continue
        if not surface_node or not surface_reference or reference.revision is None:
            raise HTTPException(status_code=422, detail="Surface placements require an exact promoted revision")
        access = _authorize_local_referent(cur, reference, identity)
        if access is None or access.resolved_revision != reference.revision:
            raise HTTPException(status_code=422, detail="Surface placements require an exact promoted revision")


def _validate_frame_mutation_authority(commands, identity: IdentityContext) -> None:
    if any(command.get("type", "").startswith("frame.") for command in commands):
        if identity.principal_kind != "human":
            raise HTTPException(status_code=403, detail="Atlas frames require human mutation authority")


@app.get("/canvases")
def list_canvases(
    workspace_id: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=200),
    identity: IdentityContext = Depends(require_identity),
):
    conditions = ["tenant_id = %s", "deleted_at IS NULL"]
    params = [identity.tenant_id]
    if workspace_id is not None:
        conditions.append("workspace_id = %s")
        params.append(_canvas_workspace_id(workspace_id))
    params.append(limit)
    cur = get_conn().cursor()
    cur.execute(
        f"""SELECT id, workspace_id, slug, title, is_default, projection_mode,
                   current_version, current_content_hash,
                   created_at, updated_at
              FROM gb_canvases
             WHERE {' AND '.join(conditions)}
             ORDER BY is_default DESC, updated_at DESC, id
             LIMIT %s""",
        params,
    )
    return [{
        "canvasId": str(row["id"]),
        "workspaceId": row["workspace_id"],
        "slug": row["slug"],
        "title": row["title"],
        "isDefault": row["is_default"],
        "projectionMode": _canvas_projection_mode(row.get("projection_mode")),
        "version": row["current_version"],
        "contentHash": row["current_content_hash"],
        "createdAt": row_to_dict({"value": row["created_at"]})["value"],
        "updatedAt": row_to_dict({"value": row["updated_at"]})["value"],
    } for row in cur.fetchall()]


@app.post("/canvases", status_code=201)
def create_canvas(req: CanvasCreate, identity: IdentityContext = Depends(require_identity)):
    workspace_id = _canvas_workspace_id(req.workspaceId)
    slug = _canvas_slug(req.slug)
    title = _canvas_title(req.title)
    idempotency_key = _idempotency_key(req.idempotencyKey)
    request_hash = _canvas_value(canvas_request_hash, {
        "workspaceId": workspace_id,
        "slug": slug,
        "title": title,
        "makeDefault": req.makeDefault,
        "projectionMode": req.projectionMode,
    })
    legacy_ambient_request_hash = None
    if req.projectionMode == "ambient":
        legacy_ambient_request_hash = _canvas_value(canvas_request_hash, {
            "workspaceId": workspace_id,
            "slug": slug,
            "title": title,
            "makeDefault": req.makeDefault,
        })
    empty = {
        "schemaId": CANVAS_SNAPSHOT_SCHEMA,
        "items": [],
        "edges": [],
        "removedItemIds": [],
        "removedEdgeIds": [],
    }
    content_hash = _canvas_value(canvas_snapshot_hash, empty)
    conn = get_conn()
    with _transaction(conn) as cur:
        _lock_canvas_workspace(cur, identity.tenant_id, workspace_id)
        cur.execute(
            """SELECT * FROM gb_canvases
                WHERE tenant_id = %s
                  AND creation_idempotency_key = %s
                FOR UPDATE""",
            (identity.tenant_id, idempotency_key),
        )
        existing = row_to_dict(cur.fetchone())
        if existing is not None:
            if existing["creation_request_hash"] not in (request_hash, legacy_ambient_request_hash):
                raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
            content = _canvas_content(cur, existing)
            return _canvas_envelope(existing, content, replayed=True)
        cur.execute(
            """SELECT id FROM gb_canvases
                WHERE tenant_id = %s AND workspace_id = %s AND slug = %s
                  AND deleted_at IS NULL
                FOR UPDATE""",
            (identity.tenant_id, workspace_id, slug),
        )
        if cur.fetchone() is not None:
            raise HTTPException(status_code=409, detail="Canvas slug already exists in this workspace")
        cur.execute(
            """SELECT id FROM gb_canvases
                WHERE tenant_id = %s AND workspace_id = %s AND is_default
                  AND deleted_at IS NULL
                FOR UPDATE""",
            (identity.tenant_id, workspace_id),
        )
        current_default = row_to_dict(cur.fetchone())
        is_default = req.makeDefault or current_default is None
        if req.makeDefault and current_default is not None:
            cur.execute(
                """UPDATE gb_canvases SET is_default = false
                    WHERE tenant_id = %s AND workspace_id = %s AND is_default
                      AND deleted_at IS NULL""",
                (identity.tenant_id, workspace_id),
            )
        cur.execute(
            """INSERT INTO gb_canvases (
                   tenant_id, workspace_id, slug, title, is_default, projection_mode, current_content_hash,
                   created_by_principal_id, creation_idempotency_key, creation_request_hash
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT DO NOTHING
               RETURNING *""",
            (
                identity.tenant_id, workspace_id, slug, title, is_default, req.projectionMode, content_hash,
                identity.principal_id, idempotency_key, request_hash,
            ),
        )
        canvas = row_to_dict(cur.fetchone())
        if canvas is None:
            cur.execute(
                """SELECT * FROM gb_canvases
                    WHERE tenant_id = %s AND creation_idempotency_key = %s
                    FOR UPDATE""",
                (identity.tenant_id, idempotency_key),
            )
            raced = row_to_dict(cur.fetchone())
            if raced is None or raced["creation_request_hash"] not in (request_hash, legacy_ambient_request_hash):
                raise HTTPException(status_code=409, detail="Canvas creation conflicts with an existing canvas")
            content = _canvas_content(cur, raced)
            return _canvas_envelope(raced, content, replayed=True)
        cur.execute(
            """INSERT INTO gb_canvas_revisions (
                   tenant_id, canvas_id, version, content_hash, mutation_json,
                   snapshot_json, idempotency_key, request_hash, created_by_principal_id
               ) VALUES (%s, %s, 1, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                identity.tenant_id, canvas["id"], content_hash,
                psycopg2.extras.Json({
                    "type": "canvas.create",
                    "workspaceId": workspace_id,
                    "slug": slug,
                    "isDefault": is_default,
                    "projectionMode": req.projectionMode,
                }),
                psycopg2.extras.Json(empty), idempotency_key, request_hash,
                identity.principal_id,
            ),
        )
        mutation_id = str(cur.fetchone()["id"])
        return _canvas_envelope(canvas, empty, mutation_id=mutation_id)


@app.get("/canvases/{canvas_id}")
def get_canvas(canvas_id: str, identity: IdentityContext = Depends(require_identity)):
    canvas = _canvas_or_404(canvas_id, identity)
    content = _canvas_content(get_conn().cursor(), canvas)
    return _canvas_envelope(canvas, content)


@app.get("/canvases/{canvas_id}/revisions")
def list_canvas_revisions(
    canvas_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    identity: IdentityContext = Depends(require_identity),
):
    canvas = _canvas_or_404(canvas_id, identity)
    cur = get_conn().cursor()
    cur.execute(
        """SELECT id, version, content_hash, idempotency_key,
                  created_by_principal_id, created_at
             FROM gb_canvas_revisions
            WHERE canvas_id = %s
            ORDER BY version DESC
            LIMIT %s""",
        (canvas["id"], limit),
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.post("/canvases/{canvas_id}/mutations")
def mutate_canvas(
    canvas_id: str,
    req: CanvasMutation,
    identity: IdentityContext = Depends(require_identity),
    response: Literal["snapshot", "receipt"] = "snapshot",
):
    normalized_id = _canvas_uuid(canvas_id)
    if req.expectedVersion < 1:
        raise HTTPException(status_code=422, detail="expectedVersion must be positive")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", req.expectedContentHash):
        raise HTTPException(status_code=422, detail="expectedContentHash is invalid")
    idempotency_key = _idempotency_key(req.idempotencyKey)
    commands = _canvas_value(normalize_canvas_commands, req.commands)
    # Mutation authority is evaluated for every request, including an exact
    # idempotent replay. A replay receipt must never become a capability an
    # agent or service can borrow from a prior human request.
    _validate_frame_mutation_authority(commands, identity)
    request_body = {
        "expectedVersion": req.expectedVersion,
        "expectedContentHash": req.expectedContentHash,
        "commands": commands,
    }
    request_hash = _canvas_value(canvas_request_hash, request_body)
    conn = get_conn()
    with _transaction(conn) as cur:
        canvas = _canvas_or_404(normalized_id, identity, cur=cur, for_update=True)
        replay = _canvas_replay(cur, normalized_id, idempotency_key, request_hash)
        if replay is not None:
            historical = {
                **canvas,
                "current_version": replay["version"],
                "current_content_hash": replay["content_hash"],
            }
            if response == "receipt":
                return _canvas_mutation_receipt(
                    historical,
                    str(replay["id"]),
                    replay["request_hash"],
                    replayed=True,
                )
            return _canvas_envelope(
                historical,
                replay["snapshot_json"],
                mutation_id=str(replay["id"]),
                replayed=True,
            )
        if (canvas["current_version"] != req.expectedVersion
                or canvas["current_content_hash"] != req.expectedContentHash):
            raise HTTPException(status_code=409, detail={
                "code": "stale_canvas",
                "message": "Canvas changed; reload before retrying",
                "currentVersion": canvas["current_version"],
                "currentContentHash": canvas["current_content_hash"],
            })
        current = _canvas_content(cur, canvas)
        if _canvas_value(canvas_snapshot_hash, current) != canvas["current_content_hash"]:
            raise HTTPException(status_code=500, detail="Canvas snapshot hash does not match its revision")
        _validate_surface_placement_commands(cur, commands, identity)
        content = _canvas_value(apply_canvas_commands, current, commands)
        content_hash = _canvas_value(canvas_snapshot_hash, content)
        next_version = canvas["current_version"] + 1
        _synchronize_canvas_rows(cur, canvas, content, identity)
        cur.execute(
            """UPDATE gb_canvases
                  SET current_version = %s, current_content_hash = %s, updated_at = now()
                WHERE id = %s AND current_version = %s
                RETURNING *""",
            (next_version, content_hash, normalized_id, req.expectedVersion),
        )
        updated = row_to_dict(cur.fetchone())
        if updated is None:
            raise HTTPException(status_code=409, detail={
                "code": "stale_canvas",
                "message": "Canvas changed while the mutation was applied",
            })
        cur.execute(
            """INSERT INTO gb_canvas_revisions (
                   tenant_id, canvas_id, version, content_hash, mutation_json,
                   snapshot_json, idempotency_key, request_hash, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                identity.tenant_id, normalized_id, next_version, content_hash,
                psycopg2.extras.Json(request_body), psycopg2.extras.Json(content),
                idempotency_key, request_hash, identity.principal_id,
            ),
        )
        mutation_id = str(cur.fetchone()["id"])
        if response == "receipt":
            return _canvas_mutation_receipt(updated, mutation_id, request_hash)
        return _canvas_envelope(updated, content, mutation_id=mutation_id)


# ---------------------------------------------------------------------------
# Endpoints — Experiments
# ---------------------------------------------------------------------------

def _experiment_response(row) -> Optional[dict]:
    """Keep replay coordination fields internal to the API service."""
    experiment = row_to_dict(row)
    if experiment is not None:
        experiment.pop("creation_idempotency_key", None)
        experiment.pop("creation_request_hash", None)
    return experiment


def _experiment_attachment_ref(row) -> dict:
    value = row_to_dict(row)
    revision_digest = value["document_revision_sha256"]
    return {
        "schemaId": "gb.eln-attachment-ref.v1",
        "ref": _pinned_object_reference("document", value["document_id"], revision_digest),
        "attachmentId": value["id"],
        "documentRevisionId": value["document_revision_id"],
        "title": value["title"],
        "displayFilename": value["display_filename"],
        "mediaType": value["media_type"],
        "revisionSha256": revision_digest,
        "contentSha256": value["artifact_content_sha256"],
        "createdAt": value["created_at"],
    }


def _read_experiment_attachments(cur, tenant_id: str, experiment_id: str) -> list[dict]:
    cur.execute(
        """SELECT attachment.id, attachment.document_id,
                         attachment.document_revision_id,
                         attachment.document_revision_sha256, attachment.created_at,
                         revision.title, revision.display_filename, artifact.media_type,
                         artifact.content_sha256 AS artifact_content_sha256
                    FROM gb_experiment_attachments AS attachment
                    JOIN gb_document_revisions AS revision
                      ON revision.tenant_id = attachment.tenant_id
                     AND revision.document_id = attachment.document_id
                     AND revision.id = attachment.document_revision_id
                     AND revision.revision_sha256 = attachment.document_revision_sha256
                    JOIN gb_artifacts AS artifact
                      ON artifact.tenant_id = revision.tenant_id
                     AND artifact.id = revision.original_artifact_id
                   WHERE attachment.tenant_id = %s AND attachment.experiment_id = %s
                   ORDER BY attachment.created_at, attachment.id
                   LIMIT 65""",
        (tenant_id, experiment_id),
    )
    rows = cur.fetchall()
    if len(rows) > 64:
        raise HTTPException(status_code=500, detail="Experiment attachment state exceeds its bound")
    return [_experiment_attachment_ref(row) for row in rows]


def _with_experiment_attachments(cur, experiment: dict, tenant_id: str) -> dict:
    attachments = _read_experiment_attachments(cur, tenant_id, experiment["id"])
    experiment["attachment_refs"] = attachments
    experiment["attachment_count"] = len(attachments)
    return experiment


def _observation_idempotency_key(value: str) -> str:
    key = value.strip()
    if key != value or not re.fullmatch(
        r"eln-observation:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        key,
    ):
        raise HTTPException(status_code=422, detail="Invalid observation idempotency key")
    return key


def _observation_timestamp(value: Optional[str]) -> tuple[datetime, Optional[str]]:
    if value is None:
        return datetime.now(timezone.utc), None
    if not re.fullmatch(
        r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T"
        r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?"
        r"(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])",
        value,
    ):
        raise HTTPException(status_code=422, detail="Observation time must be an RFC 3339 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        normalized = parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError) as error:
        raise HTTPException(status_code=422, detail="Observation time must be an RFC 3339 timestamp") from error
    return normalized, normalized.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _observation_ref(row) -> dict:
    value = row_to_dict(row)
    digest = value["revision_sha256"]
    observed_at = datetime.fromisoformat(value["observed_at"].replace("Z", "+00:00"))
    return {
        "schemaId": "gb.eln-observation-ref.v1",
        "id": value["id"],
        "experimentId": value["experiment_id"],
        "ref": _pinned_object_reference("eln.observation", str(value["id"]), digest),
        "version": value["version"],
        "revisionSha256": digest,
        "body": value["body"],
        "observedAt": observed_at.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "createdAt": value["created_at"],
        "createdByPrincipalId": value["created_by_principal_id"],
    }


def _read_experiment_observations(cur, tenant_id: str, experiment_id: str) -> list[dict]:
    cur.execute(
        """SELECT observation.id, observation.experiment_id,
                         observation.created_by_principal_id, observation.created_at,
                         revision.version, revision.body, revision.observed_at,
                         revision.revision_sha256
                    FROM gb_eln_observations AS observation
                    JOIN LATERAL (
                      SELECT candidate.version, candidate.body, candidate.observed_at,
                             candidate.revision_sha256
                        FROM gb_eln_observation_revisions AS candidate
                       WHERE candidate.tenant_id = observation.tenant_id
                         AND candidate.observation_id = observation.id
                       ORDER BY candidate.version DESC LIMIT 1
                    ) AS revision ON TRUE
                   WHERE observation.tenant_id = %s AND observation.experiment_id = %s
                   ORDER BY observation.created_at, observation.id, revision.version DESC
                   LIMIT 257""",
        (tenant_id, experiment_id),
    )
    rows = cur.fetchall()
    if len(rows) > 256:
        raise HTTPException(status_code=500, detail="Experiment observation state exceeds its bound")
    return [_observation_ref(row) for row in rows]


def _with_experiment_observations(cur, experiment: dict, tenant_id: str) -> dict:
    observations = _read_experiment_observations(cur, tenant_id, experiment["id"])
    experiment["observation_refs"] = observations
    experiment["observation_count"] = len(observations)
    return experiment


def _with_experiment_evidence(cur, experiment: dict, tenant_id: str) -> dict:
    return _with_experiment_observations(
        cur,
        _with_experiment_attachments(cur, experiment, tenant_id),
        tenant_id,
    )


@app.get("/experiments")
def list_experiments(
    status: Optional[str] = None,
    domain: Optional[str] = None,
    limit: Optional[int] = Query(default=None, ge=1, le=200),
    identity: IdentityContext = Depends(require_identity),
):
    """List experiments, optionally filtered and bounded before disclosure."""
    try:
        cur = get_conn().cursor()
        conditions = ["tenant_id = %s"]
        params = [identity.tenant_id]
        if status:
            conditions.append("status = %s")
            params.append(status)
        if domain:
            conditions.append("domain = %s")
            params.append(domain)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        query = f"""SELECT experiment.*,
                           (SELECT count(*) FROM gb_experiment_attachments AS attachment
                             WHERE attachment.tenant_id = experiment.tenant_id
                               AND attachment.experiment_id = experiment.id) AS attachment_count,
                           (SELECT count(*) FROM gb_eln_observations AS observation
                             WHERE observation.tenant_id = experiment.tenant_id
                               AND observation.experiment_id = experiment.id) AS observation_count
                      FROM gb_experiments AS experiment {where} ORDER BY updated_at DESC"""
        if limit is not None:
            query += " LIMIT %s"
            params.append(limit)
        cur.execute(query, params)
        return [_experiment_response(r) for r in cur.fetchall()]
    except Exception as e:
        log.error("list_experiments error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to list experiments") from e


@app.post("/experiments", status_code=201)
def create_experiment(
    req: ExperimentCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    identity: IdentityContext = Depends(require_identity),
):
    """Create an experiment exactly once for one tenant-scoped request key."""
    key = _idempotency_key(idempotency_key)
    try:
        encoded_request = json.dumps(
            req.model_dump(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Experiment request must be valid JSON") from error
    request_hash = hashlib.sha256(encoded_request.encode("utf-8")).hexdigest()
    try:
        with _transaction(get_conn()) as cur:
            experiment_id = str(uuid4())
            cur.execute(
                """INSERT INTO gb_experiment_creation_receipts (
                     tenant_id, idempotency_key, request_sha256, experiment_id,
                     created_by_principal_id
                   ) VALUES (%s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
                   RETURNING experiment_id, request_sha256""",
                (
                    identity.tenant_id, key, request_hash, experiment_id,
                    identity.principal_id,
                ),
            )
            receipt = row_to_dict(cur.fetchone())
            if receipt is None:
                cur.execute(
                    """SELECT experiment_id, request_sha256
                         FROM gb_experiment_creation_receipts
                        WHERE tenant_id = %s AND idempotency_key = %s""",
                    (identity.tenant_id, key),
                )
                receipt = row_to_dict(cur.fetchone())
                if receipt is None:
                    raise HTTPException(
                        status_code=409,
                        detail="Experiment creation could not be reconciled",
                    )
                if receipt["request_sha256"] != request_hash:
                    raise HTTPException(
                        status_code=409,
                        detail="Idempotency key was reused with different input",
                    )
                cur.execute(
                    """SELECT * FROM gb_experiments
                        WHERE tenant_id = %s AND id = %s""",
                    (identity.tenant_id, receipt["experiment_id"]),
                )
                replay = _experiment_response(cur.fetchone())
                if replay is None:
                    raise HTTPException(
                        status_code=410,
                        detail="The experiment created by this request was deleted",
                    )
                replay["replayed"] = True
                return replay

            cur.execute(
                """
                INSERT INTO gb_experiments (
                    id, tenant_id, created_by_principal_id, user_id,
                    title, status, hypothesis, protocol, config_snapshot,
                    wandb_run_id, wandb_project, local_run_path,
                    results, interpretation, conclusion,
                    domain, tags, linked_experiments, ham_node_id,
                    creation_idempotency_key, creation_request_hash
                ) VALUES (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s
                )
                RETURNING *
                """,
                (
                    receipt["experiment_id"], identity.tenant_id,
                    identity.principal_id, identity.principal_id,
                    req.title, req.status, req.hypothesis, req.protocol,
                    json.dumps(req.config_snapshot),
                    req.wandb_run_id, req.wandb_project, req.local_run_path,
                    req.results, req.interpretation, req.conclusion,
                    req.domain, req.tags, req.linked_experiments,
                    req.ham_node_id, key, request_hash,
                ),
            )
            created = _experiment_response(cur.fetchone())
            if created is None:
                raise HTTPException(status_code=409, detail="Experiment creation could not be reconciled")
            return created
    except HTTPException:
        raise
    except Exception as error:
        log.error("create_experiment failed")
        raise HTTPException(status_code=500, detail="Unable to create experiment") from error


@app.get("/experiments/{experiment_id}")
def get_experiment(experiment_id: str, identity: IdentityContext = Depends(require_identity)):
    """Get a single experiment by ID, including its metrics."""
    try:
        cur = get_conn().cursor()
        cur.execute(
            "SELECT * FROM gb_experiments WHERE id = %s AND tenant_id = %s",
            (experiment_id, identity.tenant_id),
        )
        exp = _experiment_response(cur.fetchone())
        if exp is None:
            raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
        cur.execute(
            "SELECT * FROM gb_experiment_metrics WHERE experiment_id = %s ORDER BY timestamp",
            (experiment_id,),
        )
        exp["metrics"] = [row_to_dict(r) for r in cur.fetchall()]
        return _with_experiment_evidence(cur, exp, identity.tenant_id)
    except HTTPException:
        raise
    except Exception as e:
        log.error("get_experiment error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to read experiment") from e


@app.patch("/experiments/{experiment_id}")
def update_experiment(
    experiment_id: str,
    req: ExperimentUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    """Partially update an experiment (only non-None fields are written)."""
    try:
        cur = get_conn().cursor()

        # Verify the experiment exists
        cur.execute(
            "SELECT id FROM gb_experiments WHERE id = %s AND tenant_id = %s",
            (experiment_id, identity.tenant_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")

        updates = {k: v for k, v in req.model_dump().items() if v is not None}
        if not updates:
            # Nothing to update — return current state
            cur.execute(
                "SELECT * FROM gb_experiments WHERE id = %s AND tenant_id = %s",
                (experiment_id, identity.tenant_id),
            )
            current = _experiment_response(cur.fetchone())
            return _with_experiment_evidence(cur, current, identity.tenant_id)

        # Serialize config_snapshot if present
        if "config_snapshot" in updates:
            updates["config_snapshot"] = json.dumps(updates["config_snapshot"])

        set_parts = [sql.SQL("{} = %s").format(sql.Identifier(col)) for col in updates]
        set_parts.append(sql.SQL("updated_at = now()"))
        query = sql.SQL("UPDATE gb_experiments SET {} WHERE id = %s AND tenant_id = %s RETURNING *").format(
            sql.SQL(", ").join(set_parts)
        )
        params = list(updates.values())
        params.append(experiment_id)
        params.append(identity.tenant_id)
        cur.execute(query, params)
        updated = _experiment_response(cur.fetchone())
        return _with_experiment_evidence(cur, updated, identity.tenant_id)
    except HTTPException:
        raise
    except Exception as e:
        log.error("update_experiment error: %s", e)
        raise HTTPException(status_code=500, detail="Unable to update experiment") from e


def _observation_receipt(
    cur,
    tenant_id: str,
    experiment_id: str,
    observation_id: str,
    request_hash: str,
    *,
    replayed: bool,
) -> dict:
    cur.execute(
        """SELECT observation.id, observation.experiment_id,
                         observation.created_by_principal_id, observation.created_at,
                         revision.version, revision.body, revision.observed_at,
                         revision.revision_sha256
                    FROM gb_eln_observations AS observation
                    JOIN gb_eln_observation_revisions AS revision
                      ON revision.tenant_id = observation.tenant_id
                     AND revision.observation_id = observation.id
                   WHERE observation.tenant_id = %s AND observation.experiment_id = %s
                     AND observation.id = %s AND revision.version = 1
                   LIMIT 1""",
        (tenant_id, experiment_id, observation_id),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=410, detail="The observation created by this request was deleted")
    return {
        "schemaId": "gb.eln-observation-create-receipt.v1",
        "experimentId": experiment_id,
        "requestSha256": request_hash,
        "replayed": replayed,
        "observation": _observation_ref(row),
    }


@app.get("/experiments/{experiment_id}/observations")
def list_experiment_observations(
    experiment_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    cur = get_conn().cursor()
    cur.execute(
        "SELECT 1 FROM gb_experiments WHERE tenant_id = %s AND id = %s",
        (identity.tenant_id, experiment_id),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return {
        "schemaId": "gb.eln-observation-list.v1",
        "experimentId": experiment_id,
        "observations": _read_experiment_observations(cur, identity.tenant_id, experiment_id),
    }


@app.post("/experiments/{experiment_id}/observations", status_code=201)
def create_experiment_observation(
    experiment_id: str,
    req: ExperimentObservationCreate,
    request: Request,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    identity: IdentityContext = Depends(require_identity),
):
    _require_human_session_observation_mutation(request, identity)
    if not 1 <= len(experiment_id) <= 200 or any(ord(char) < 32 for char in experiment_id):
        raise HTTPException(status_code=422, detail="Experiment identity is invalid")
    key = _observation_idempotency_key(idempotency_key)
    observed_at, normalized_requested_time = _observation_timestamp(req.observedAt)
    normalized_request = {
        "body": req.body,
        "experimentId": experiment_id,
        "observedAt": normalized_requested_time,
        "schemaId": req.schemaId,
    }
    request_hash = hashlib.sha256(json.dumps(
        normalized_request,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")).hexdigest()
    observed_at_wire = observed_at.isoformat(timespec="microseconds").replace("+00:00", "Z")
    revision_hash = hashlib.sha256(json.dumps(
        {"body": req.body, "observedAt": observed_at_wire},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")).hexdigest()

    try:
        with _transaction(get_conn()) as cur:
            cur.execute(
                """SELECT experiment_id, observation_id, request_sha256
                       FROM gb_eln_observation_create_receipts
                      WHERE tenant_id = %s AND idempotency_key = %s""",
                (identity.tenant_id, key),
            )
            existing = row_to_dict(cur.fetchone())
            if existing is not None:
                if existing["request_sha256"] != request_hash or existing["experiment_id"] != experiment_id:
                    raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
                return _observation_receipt(
                    cur, identity.tenant_id, experiment_id, existing["observation_id"],
                    request_hash, replayed=True,
                )

            cur.execute(
                "SELECT id FROM gb_experiments WHERE tenant_id = %s AND id = %s FOR UPDATE",
                (identity.tenant_id, experiment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Experiment not found")
            cur.execute(
                "SELECT count(*) AS count FROM gb_eln_observations WHERE tenant_id = %s AND experiment_id = %s",
                (identity.tenant_id, experiment_id),
            )
            if cur.fetchone()["count"] >= 256:
                raise HTTPException(status_code=409, detail="Experiment already has the maximum 256 observations")

            observation_id = str(uuid4())
            cur.execute(
                """INSERT INTO gb_eln_observation_create_receipts (
                     tenant_id, idempotency_key, request_sha256, experiment_id,
                     observation_id, created_by_principal_id
                   ) VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
                   RETURNING observation_id""",
                (
                    identity.tenant_id, key, request_hash, experiment_id,
                    observation_id, identity.principal_id,
                ),
            )
            inserted_receipt = cur.fetchone()
            if inserted_receipt is None:
                cur.execute(
                    """SELECT experiment_id, observation_id, request_sha256
                           FROM gb_eln_observation_create_receipts
                          WHERE tenant_id = %s AND idempotency_key = %s""",
                    (identity.tenant_id, key),
                )
                raced = row_to_dict(cur.fetchone())
                if raced is None:
                    raise HTTPException(status_code=409, detail="Observation creation could not be reconciled")
                if raced["request_sha256"] != request_hash or raced["experiment_id"] != experiment_id:
                    raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
                return _observation_receipt(
                    cur, identity.tenant_id, experiment_id, raced["observation_id"],
                    request_hash, replayed=True,
                )

            cur.execute(
                """INSERT INTO gb_eln_observations (
                     id, tenant_id, experiment_id, created_by_principal_id
                   ) VALUES (%s, %s, %s, %s)""",
                (observation_id, identity.tenant_id, experiment_id, identity.principal_id),
            )
            cur.execute(
                """INSERT INTO gb_eln_observation_revisions (
                     tenant_id, observation_id, version, body, observed_at,
                     revision_sha256, created_by_principal_id
                   ) VALUES (%s, %s, 1, %s, %s, %s, %s)""",
                (
                    identity.tenant_id, observation_id, req.body, observed_at,
                    revision_hash, identity.principal_id,
                ),
            )
            return _observation_receipt(
                cur, identity.tenant_id, experiment_id, observation_id,
                request_hash, replayed=False,
            )
    except HTTPException:
        raise
    except Exception as error:
        log.error("create_experiment_observation failed")
        raise HTTPException(status_code=500, detail="Unable to create observation") from error


@app.get("/experiments/{experiment_id}/attachments")
def list_experiment_attachments(
    experiment_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    cur = get_conn().cursor()
    cur.execute(
        "SELECT 1 FROM gb_experiments WHERE tenant_id = %s AND id = %s",
        (identity.tenant_id, experiment_id),
    )
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return {
        "schemaId": "gb.eln-attachment-list.v1",
        "experimentId": experiment_id,
        "attachments": _read_experiment_attachments(cur, identity.tenant_id, experiment_id),
    }


@app.post("/experiments/{experiment_id}/attachments", status_code=201)
def create_experiment_attachment(
    experiment_id: str,
    req: ExperimentAttachmentCreate,
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    identity: IdentityContext = Depends(require_identity),
):
    if not 1 <= len(experiment_id) <= 200 or any(ord(char) < 32 for char in experiment_id):
        raise HTTPException(status_code=422, detail="Experiment identity is invalid")
    key = _document_import_idempotency_key(idempotency_key)
    try:
        reference = parse_canonical_reference(req.documentRef)
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail="A canonical pinned document reference is required") from error
    if (
        reference.kind != "document"
        or reference.revision is None
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", reference.revision)
    ):
        raise HTTPException(status_code=422, detail="A canonical pinned document reference is required")
    request_hash = hashlib.sha256(json.dumps({
        "schemaId": req.schemaId,
        "experimentId": experiment_id,
        "documentRef": reference.wire,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    try:
        with _transaction(get_conn()) as cur:
            cur.execute(
                "SELECT id FROM gb_experiments WHERE tenant_id = %s AND id = %s FOR UPDATE",
                (identity.tenant_id, experiment_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Experiment not found")

            _authorize_object_reference(cur, reference.wire, identity)
            digest = reference.revision.removeprefix("sha256:")
            cur.execute(
                """SELECT document.id AS document_id, revision.id AS revision_id
                       FROM gb_documents AS document
                       JOIN gb_document_revisions AS revision
                         ON revision.tenant_id = document.tenant_id
                        AND revision.document_id = document.id
                      WHERE document.tenant_id = %s AND document.id::text = %s
                        AND document.deleted_at IS NULL
                        AND revision.revision_sha256 = %s
                      LIMIT 1""",
                (identity.tenant_id, reference.identifier, digest),
            )
            resolved = cur.fetchone()
            if resolved is None:
                raise HTTPException(status_code=404, detail="Document revision was not found or is not readable")

            cur.execute(
                """SELECT request.attachment_id AS id, request.request_sha256
                     FROM gb_experiment_attachment_requests AS request
                     JOIN gb_experiment_attachments AS attachment
                       ON attachment.tenant_id = request.tenant_id
                      AND attachment.experiment_id = request.experiment_id
                      AND attachment.id = request.attachment_id
                    WHERE request.tenant_id = %s AND request.experiment_id = %s
                      AND request.idempotency_key = %s""",
                (identity.tenant_id, experiment_id, key),
            )
            existing_key = cur.fetchone()
            if existing_key is not None:
                if existing_key["request_sha256"] != request_hash:
                    raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
                attachment_id = existing_key["id"]
                replayed = True
                deduplicated = False
            else:
                cur.execute(
                    """SELECT count(*) AS count
                         FROM gb_experiment_attachment_requests
                        WHERE tenant_id = %s AND experiment_id = %s""",
                    (identity.tenant_id, experiment_id),
                )
                if int(cur.fetchone()["count"]) >= 256:
                    raise HTTPException(status_code=409, detail="Experiment attachment request limit reached")
                cur.execute(
                    """SELECT id FROM gb_experiment_attachments
                        WHERE tenant_id = %s AND experiment_id = %s
                          AND document_id = %s AND document_revision_sha256 = %s""",
                    (identity.tenant_id, experiment_id, resolved["document_id"], digest),
                )
                same_revision = cur.fetchone()
                if same_revision is not None:
                    attachment_id = same_revision["id"]
                    replayed = False
                    deduplicated = True
                else:
                    cur.execute(
                        "SELECT count(*) AS count FROM gb_experiment_attachments WHERE tenant_id = %s AND experiment_id = %s",
                        (identity.tenant_id, experiment_id),
                    )
                    if int(cur.fetchone()["count"]) >= 64:
                        raise HTTPException(status_code=409, detail="Experiment attachment limit reached")
                    cur.execute(
                        """INSERT INTO gb_experiment_attachments (
                             tenant_id, experiment_id, document_id, document_revision_id,
                             document_revision_sha256, created_by_principal_id,
                             idempotency_key, request_sha256
                           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                           RETURNING id""",
                        (
                            identity.tenant_id, experiment_id, resolved["document_id"],
                            resolved["revision_id"], digest, identity.principal_id, key, request_hash,
                        ),
                    )
                    attachment_id = cur.fetchone()["id"]
                    replayed = False
                    deduplicated = False

                cur.execute(
                    """INSERT INTO gb_experiment_attachment_requests (
                         tenant_id, experiment_id, idempotency_key, request_sha256, attachment_id
                       ) VALUES (%s, %s, %s, %s, %s)""",
                    (identity.tenant_id, experiment_id, key, request_hash, attachment_id),
                )

            attachments = _read_experiment_attachments(cur, identity.tenant_id, experiment_id)
            attachment = next(item for item in attachments if item["attachmentId"] == str(attachment_id))
            return {
                "schemaId": "gb.eln-attachment-create-receipt.v1",
                "experimentId": experiment_id,
                "requestSha256": request_hash,
                "attachment": attachment,
                "replayed": replayed,
                "deduplicated": deduplicated,
            }
    except HTTPException:
        raise
    except Exception as error:
        log.error("create_experiment_attachment failed")
        raise HTTPException(status_code=500, detail="Unable to attach document") from error


@app.delete("/experiments/{experiment_id}")
def delete_experiment(experiment_id: str, identity: IdentityContext = Depends(require_identity)):
    """Delete an experiment and its metrics (CASCADE)."""
    try:
        cur = get_conn().cursor()
        cur.execute(
            "DELETE FROM gb_experiments WHERE id = %s AND tenant_id = %s RETURNING id",
            (experiment_id, identity.tenant_id),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")
        return {"deleted": experiment_id}
    except HTTPException:
        raise
    except Exception as e:
        log.error("delete_experiment error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/experiments/{experiment_id}/metrics")
def add_metrics(
    experiment_id: str,
    metrics: List[ExperimentMetricCreate],
    identity: IdentityContext = Depends(require_identity),
):
    """Append one or more metric data points to an experiment."""
    try:
        cur = get_conn().cursor()

        # Verify the experiment exists
        cur.execute(
            "SELECT id FROM gb_experiments WHERE id = %s AND tenant_id = %s",
            (experiment_id, identity.tenant_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Experiment {experiment_id} not found")

        count = 0
        for m in metrics:
            cur.execute(
                """
                INSERT INTO gb_experiment_metrics
                  (tenant_id, created_by_principal_id, experiment_id, name, value, step, source)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    identity.tenant_id, identity.principal_id,
                    experiment_id, m.name, m.value, m.step, m.source,
                ),
            )
            count += 1

        return {"added": count}
    except HTTPException:
        raise
    except Exception as e:
        log.error("add_metrics error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Endpoints — Hypotheses
# ---------------------------------------------------------------------------

@app.get("/hypotheses")
def list_hypotheses(
    status: Optional[str] = None,
    domain: Optional[str] = None,
    identity: IdentityContext = Depends(require_identity),
):
    """List hypotheses, optionally filtered by status and/or domain."""
    try:
        cur = get_conn().cursor()
        conditions = ["tenant_id = %s"]
        params = [identity.tenant_id]
        if status:
            conditions.append("status = %s")
            params.append(status)
        if domain:
            conditions.append("domain = %s")
            params.append(domain)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        cur.execute(
            f"SELECT * FROM gb_hypotheses {where} ORDER BY updated_at DESC",
            params,
        )
        return [row_to_dict(r) for r in cur.fetchall()]
    except Exception as e:
        log.error("list_hypotheses error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/hypotheses")
def create_hypothesis(req: HypothesisCreate, identity: IdentityContext = Depends(require_identity)):
    """Create a new hypothesis."""
    try:
        cur = get_conn().cursor()
        cur.execute(
            """
            INSERT INTO gb_hypotheses (
                tenant_id, created_by_principal_id, user_id,
                claim, status, confidence, domain,
                supporting_experiments, refuting_experiments,
                superseded_by, ham_node_id
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (
                identity.tenant_id, identity.principal_id, identity.principal_id,
                req.claim, req.status, req.confidence, req.domain,
                req.supporting_experiments, req.refuting_experiments,
                req.superseded_by, req.ham_node_id,
            ),
        )
        return row_to_dict(cur.fetchone())
    except Exception as e:
        log.error("create_hypothesis error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/hypotheses/{hypothesis_id}")
def get_hypothesis(hypothesis_id: str, identity: IdentityContext = Depends(require_identity)):
    """Get a single hypothesis by ID."""
    try:
        cur = get_conn().cursor()
        cur.execute(
            "SELECT * FROM gb_hypotheses WHERE id = %s AND tenant_id = %s",
            (hypothesis_id, identity.tenant_id),
        )
        row = row_to_dict(cur.fetchone())
        if row is None:
            raise HTTPException(status_code=404, detail=f"Hypothesis {hypothesis_id} not found")
        return row
    except HTTPException:
        raise
    except Exception as e:
        log.error("get_hypothesis error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/hypotheses/{hypothesis_id}")
def update_hypothesis(
    hypothesis_id: str,
    req: HypothesisUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    """Partially update a hypothesis (only non-None fields are written)."""
    try:
        cur = get_conn().cursor()

        # Verify the hypothesis exists
        cur.execute(
            "SELECT id FROM gb_hypotheses WHERE id = %s AND tenant_id = %s",
            (hypothesis_id, identity.tenant_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Hypothesis {hypothesis_id} not found")

        updates = {k: v for k, v in req.model_dump().items() if v is not None}
        if not updates:
            cur.execute(
                "SELECT * FROM gb_hypotheses WHERE id = %s AND tenant_id = %s",
                (hypothesis_id, identity.tenant_id),
            )
            return row_to_dict(cur.fetchone())

        set_parts = [sql.SQL("{} = %s").format(sql.Identifier(col)) for col in updates]
        set_parts.append(sql.SQL("updated_at = now()"))
        query = sql.SQL("UPDATE gb_hypotheses SET {} WHERE id = %s AND tenant_id = %s RETURNING *").format(
            sql.SQL(", ").join(set_parts)
        )
        params = list(updates.values())
        params.append(hypothesis_id)
        params.append(identity.tenant_id)
        cur.execute(query, params)
        return row_to_dict(cur.fetchone())
    except HTTPException:
        raise
    except Exception as e:
        log.error("update_hypothesis error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/hypotheses/{hypothesis_id}")
def delete_hypothesis(hypothesis_id: str, identity: IdentityContext = Depends(require_identity)):
    """Delete a hypothesis."""
    try:
        cur = get_conn().cursor()
        cur.execute(
            "DELETE FROM gb_hypotheses WHERE id = %s AND tenant_id = %s RETURNING id",
            (hypothesis_id, identity.tenant_id),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Hypothesis {hypothesis_id} not found")
        return {"deleted": hypothesis_id}
    except HTTPException:
        raise
    except Exception as e:
        log.error("delete_hypothesis error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Endpoints — Research papers and anchored review
# ---------------------------------------------------------------------------

@app.get("/papers/search")
def search_papers(
    q: str,
    limit: int = 10,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    try:
        return search_arxiv(q, limit)
    except ArxivError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/papers")
def list_papers(limit: int = 100, identity: IdentityContext = Depends(require_identity)):
    del identity
    cur = get_conn().cursor()
    cur.execute("SELECT * FROM gb_papers ORDER BY updated_at DESC LIMIT %s", (max(1, min(limit, 200)),))
    return [row_to_dict(row) for row in cur.fetchall()]


@app.post("/papers/import", status_code=201)
def import_paper(req: PaperImport, identity: IdentityContext = Depends(require_identity)):
    try:
        metadata = get_arxiv_paper(req.arxiv_id)
    except ArxivError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    encoded = json.dumps(metadata, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    metadata_hash = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    cur = get_conn().cursor()
    cur.execute(
        """
        WITH upserted AS (
          INSERT INTO gb_papers (
            tenant_id, created_by_principal_id, arxiv_id, arxiv_version, title, abstract,
            authors, categories, published_at, source_updated_at, abs_url, pdf_url,
            doi, journal_ref, license_url, metadata_hash
          ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
          ON CONFLICT (tenant_id, arxiv_id) DO UPDATE
          SET arxiv_version = EXCLUDED.arxiv_version, title = EXCLUDED.title,
              abstract = EXCLUDED.abstract, authors = EXCLUDED.authors,
              categories = EXCLUDED.categories, published_at = EXCLUDED.published_at,
              source_updated_at = EXCLUDED.source_updated_at, abs_url = EXCLUDED.abs_url,
              pdf_url = EXCLUDED.pdf_url, doi = EXCLUDED.doi,
              journal_ref = EXCLUDED.journal_ref, license_url = EXCLUDED.license_url,
              metadata_hash = EXCLUDED.metadata_hash, updated_at = now()
          WHERE EXCLUDED.arxiv_version >= gb_papers.arxiv_version
          RETURNING *
        ), paper AS (
          SELECT * FROM upserted
          UNION ALL
          SELECT existing.* FROM gb_papers AS existing
          WHERE existing.tenant_id = %s AND existing.arxiv_id = %s
            AND NOT EXISTS (SELECT 1 FROM upserted)
          LIMIT 1
        ), revision_insert AS (
          INSERT INTO gb_paper_revisions (
            tenant_id, paper_id, arxiv_version, metadata_hash, metadata, created_by_principal_id
          )
          SELECT tenant_id, id, %s, %s, %s, %s FROM paper
          ON CONFLICT (tenant_id, paper_id, metadata_hash) DO NOTHING
          RETURNING id, paper_id, arxiv_version, metadata_hash
        ), revision AS (
          SELECT * FROM revision_insert
          UNION ALL
          SELECT existing.id, existing.paper_id, existing.arxiv_version, existing.metadata_hash
          FROM gb_paper_revisions AS existing
          JOIN paper ON paper.tenant_id = existing.tenant_id AND paper.id = existing.paper_id
          WHERE existing.metadata_hash = %s
            AND NOT EXISTS (SELECT 1 FROM revision_insert)
          LIMIT 1
        )
        SELECT paper.*,
               revision.id AS imported_revision_id,
               revision.metadata_hash AS imported_revision_metadata_hash,
               revision.arxiv_version AS imported_revision_arxiv_version
        FROM paper
        LEFT JOIN revision ON revision.paper_id = paper.id
        """,
        (
            identity.tenant_id, identity.principal_id,
            metadata["arxiv_id"], metadata["arxiv_version"], metadata["title"], metadata["abstract"],
            psycopg2.extras.Json(metadata["authors"]), metadata["categories"],
            metadata.get("published_at"), metadata.get("source_updated_at"),
            metadata["abs_url"], metadata["pdf_url"], metadata.get("doi"),
            metadata.get("journal_ref"), metadata.get("license_url"), metadata_hash,
            identity.tenant_id, metadata["arxiv_id"],
            metadata["arxiv_version"], metadata_hash,
            psycopg2.extras.Json(metadata), identity.principal_id,
            metadata_hash,
        ),
    )
    imported = row_to_dict(cur.fetchone())
    if imported and not imported.get("imported_revision_id"):
        # A concurrent first import can win the unique revision insert after this
        # statement's snapshot was established. The conflicting INSERT waits for
        # that winner, so a new READ COMMITTED statement can resolve its exact
        # immutable receipt without mutating the revision row.
        cur.execute(
            """SELECT id AS imported_revision_id,
                      metadata_hash AS imported_revision_metadata_hash,
                      arxiv_version AS imported_revision_arxiv_version
                 FROM gb_paper_revisions
                WHERE tenant_id = %s AND paper_id = %s AND metadata_hash = %s""",
            (identity.tenant_id, imported["id"], metadata_hash),
        )
        revision_receipt = row_to_dict(cur.fetchone())
        if not revision_receipt:
            raise HTTPException(status_code=503, detail="Paper revision receipt is not yet available; retry.")
        imported.update(revision_receipt)
    return imported


def _document_import_record(cur, source_id: str) -> Optional[dict]:
    cur.execute(
        """SELECT d.id AS document_id, d.title, d.display_filename,
                  r.id AS revision_id, r.version, r.revision_sha256,
                  a.id AS artifact_id, a.content_sha256, a.byte_size, a.media_type,
                  original.id AS representation_id,
                  s.id AS source_id, s.source_kind, s.original_filename, s.source_uri,
                  s.idempotency_key, s.request_sha256, s.source_metadata, s.created_at
             FROM gb_artifact_sources s
             JOIN gb_artifacts a ON a.tenant_id = s.tenant_id AND a.id = s.artifact_id
             JOIN gb_document_revisions r ON r.tenant_id = s.tenant_id AND r.source_id = s.id
             JOIN gb_documents d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
             JOIN gb_document_representations original
               ON original.tenant_id = r.tenant_id
              AND original.document_revision_id = r.id
              AND original.kind = 'original'
              AND original.artifact_id = a.id
            WHERE s.id = %s""",
        (source_id,),
    )
    row = row_to_dict(cur.fetchone())
    if not row:
        return None
    source_metadata = row.get("source_metadata") if isinstance(row.get("source_metadata"), dict) else {}
    ingestion_plan = source_metadata.get("ingestionPlan")
    return {
        "schemaId": DOCUMENT_IMPORT_SCHEMA,
        "persisted": True,
        "ref": _pinned_object_reference(
            "document", str(row["document_id"]), row["revision_sha256"],
        ),
        "document_id": str(row["document_id"]),
        "revision_id": str(row["revision_id"]),
        "artifact_id": str(row["artifact_id"]),
        "source_id": str(row["source_id"]),
        "title": row["title"],
        "display_filename": row["display_filename"],
        "version": int(row["version"]),
        "content_sha256": row["content_sha256"],
        "revision_sha256": row["revision_sha256"],
        "byte_size": int(row["byte_size"]),
        "media_type": row["media_type"],
        "source_kind": row["source_kind"],
        "original_filename": row["original_filename"],
        "source_uri": row["source_uri"],
        "ingestion_plan": ingestion_plan if isinstance(ingestion_plan, dict) else None,
    }


def _persist_document_import(
    cur,
    identity: IdentityContext,
    *,
    raw: bytes,
    normalized_media_type: str,
    metadata: dict,
    idempotency_key: str,
    request_sha256: str,
    revision_sha256: str,
    source_metadata: Optional[dict] = None,
) -> tuple[dict, str]:
    """Create or replay one durable original inside the caller's transaction."""
    title = metadata["title"]
    original_filename = metadata["originalFilename"]
    display_filename = metadata["displayFilename"]
    source_kind = metadata["sourceKind"]
    source_uri = metadata["sourceUri"]
    arxiv_id = metadata["arxivId"]
    content_sha256 = sha256_bytes(raw)
    cur.execute(
        "SELECT pg_advisory_xact_lock(hashtext('gb_document_import'), hashtext(%s))",
        (f"{identity.tenant_id}:{idempotency_key}",),
    )
    cur.execute(
        """SELECT id, request_sha256 FROM gb_artifact_sources
            WHERE tenant_id = %s AND idempotency_key = %s""",
        (identity.tenant_id, idempotency_key),
    )
    replay = cur.fetchone()
    if replay:
        if replay["request_sha256"] != request_sha256:
            raise HTTPException(status_code=409, detail="Document import idempotency key was reused")
        record = _document_import_record(cur, str(replay["id"]))
        if not record:
            raise HTTPException(status_code=409, detail="Document import replay is incomplete")
        cur.execute(
            """SELECT id FROM gb_document_representations
                WHERE tenant_id = %s AND document_revision_id = %s AND kind = 'original'
                  AND artifact_id = %s AND content_sha256 = %s""",
            (identity.tenant_id, record["revision_id"], record["artifact_id"], record["content_sha256"]),
        )
        original = cur.fetchone()
        if not original:
            raise HTTPException(status_code=409, detail="Document import replay is incomplete")
        record["replayed"] = True
        record["deduplicatedArtifact"] = True
        return record, str(original["id"])

    cur.execute(
        """INSERT INTO gb_artifacts (
             tenant_id, content_sha256, byte_size, media_type, content_bytes, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, content_sha256) DO NOTHING
           RETURNING id""",
        (
            identity.tenant_id, content_sha256, len(raw), normalized_media_type,
            psycopg2.Binary(raw), identity.principal_id,
        ),
    )
    artifact = cur.fetchone()
    deduplicated = artifact is None
    if artifact is None:
        cur.execute(
            """SELECT id, byte_size FROM gb_artifacts
                WHERE tenant_id = %s AND content_sha256 = %s""",
            (identity.tenant_id, content_sha256),
        )
        artifact = cur.fetchone()
        if (
            not artifact
            or int(artifact["byte_size"]) != len(raw)
        ):
            raise HTTPException(status_code=409, detail="Artifact hash collision")
    artifact_id = str(artifact["id"])
    stored_source_metadata = {
        "arxivId": arxiv_id,
        **({"rasterImage": metadata["rasterImage"]} if "rasterImage" in metadata else {}),
        **({"audioOriginal": metadata["audioOriginal"]} if "audioOriginal" in metadata else {}),
        **(source_metadata or {}),
    }
    cur.execute(
        """INSERT INTO gb_artifact_sources (
             tenant_id, artifact_id, source_kind, original_filename, source_uri,
             source_metadata, idempotency_key, request_sha256, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (
            identity.tenant_id, artifact_id, source_kind, original_filename, source_uri,
            psycopg2.extras.Json(stored_source_metadata), idempotency_key,
            request_sha256, identity.principal_id,
        ),
    )
    source_id = str(cur.fetchone()["id"])
    cur.execute(
        """INSERT INTO gb_documents (
             tenant_id, title, display_filename, created_by_principal_id
           ) VALUES (%s, %s, %s, %s) RETURNING id""",
        (identity.tenant_id, title, display_filename, identity.principal_id),
    )
    document_id = str(cur.fetchone()["id"])
    cur.execute(
        """INSERT INTO gb_document_revisions (
             tenant_id, document_id, version, title, display_filename, original_artifact_id,
             source_id, revision_sha256, created_by_principal_id
           ) VALUES (%s, %s, 1, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (
            identity.tenant_id, document_id, title, display_filename, artifact_id,
            source_id, revision_sha256, identity.principal_id,
        ),
    )
    revision_id = str(cur.fetchone()["id"])
    cur.execute(
        "UPDATE gb_documents SET current_revision_id = %s WHERE id = %s",
        (revision_id, document_id),
    )
    cur.execute(
        """INSERT INTO gb_document_representations (
             tenant_id, document_revision_id, kind, media_type, content_sha256,
             artifact_id, created_by_principal_id
           ) VALUES (%s, %s, 'original', %s, %s, %s, %s) RETURNING id""",
        (
            identity.tenant_id, revision_id, normalized_media_type, content_sha256,
            artifact_id, identity.principal_id,
        ),
    )
    representation_id = str(cur.fetchone()["id"])
    record = _document_import_record(cur, source_id)
    if not record:
        raise HTTPException(status_code=409, detail="Document import did not produce an exact original")
    record["replayed"] = False
    record["deduplicatedArtifact"] = deduplicated
    return record, representation_id


def _document_revision_for_transform(cur, revision_id: str) -> Optional[dict]:
    cur.execute(
        """SELECT r.id AS revision_id, r.document_id, r.original_artifact_id,
                  r.display_filename, a.content_sha256, a.byte_size, a.media_type,
                  a.content_bytes
             FROM gb_document_revisions r
             JOIN gb_artifacts a
               ON a.tenant_id = r.tenant_id AND a.id = r.original_artifact_id
            WHERE r.id = %s""",
        (revision_id,),
    )
    return row_to_dict(cur.fetchone())


def _document_revision_evidence_for_transform(cur, revision_id: str) -> Optional[dict]:
    """Read only immutable evidence needed to fence transform finalization."""
    cur.execute(
        """SELECT r.id AS revision_id, r.original_artifact_id, r.display_filename,
                  a.content_sha256, a.byte_size, a.media_type, s.source_metadata
             FROM gb_document_revisions r
             JOIN gb_artifacts a
               ON a.tenant_id = r.tenant_id AND a.id = r.original_artifact_id
             JOIN gb_artifact_sources s
               ON s.tenant_id = r.tenant_id AND s.id = r.source_id
            WHERE r.id = %s""",
        (revision_id,),
    )
    return row_to_dict(cur.fetchone())


def _insert_document_representation(
    cur,
    identity: IdentityContext,
    revision_id: str,
    kind: str,
    media_type: str,
    content: Any,
) -> dict:
    encoded_content = (
        ingestion_canonical_json(content).encode("utf-8")
        if kind == "document-structure"
        else content.encode("utf-8")
    )
    content_sha256 = sha256_bytes(encoded_content)
    content_bytes = psycopg2.Binary(encoded_content)
    cur.execute(
        """INSERT INTO gb_document_representations (
             tenant_id, document_revision_id, kind, media_type, content_sha256,
             content_bytes, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, document_revision_id, kind, content_sha256) DO NOTHING
           RETURNING id""",
        (
            identity.tenant_id, revision_id, kind, media_type, content_sha256,
            content_bytes, identity.principal_id,
        ),
    )
    inserted = cur.fetchone()
    if inserted is None:
        cur.execute(
            """SELECT id FROM gb_document_representations
                WHERE tenant_id = %s AND document_revision_id = %s
                  AND kind = %s AND content_sha256 = %s""",
            (identity.tenant_id, revision_id, kind, content_sha256),
        )
        inserted = cur.fetchone()
    if inserted is None:
        raise HTTPException(status_code=409, detail="Document representation could not be reconciled")
    return {
        "id": str(inserted["id"]),
        "kind": kind,
        "media_type": media_type,
        "content_sha256": content_sha256,
        "content": content,
    }


def _chunk_identity_canonical(representation_sha256: str, chunk: dict) -> str:
    return canonical_chunk_json({
        "schemaId": CHUNK_SCHEMA_ID,
        "representationSha256": representation_sha256,
        "selector": chunk["selector"],
        "chunker": {
            "id": chunk["chunkerId"],
            "version": chunk["chunkerVersion"],
            "configSha256": chunk["chunkerConfigSha256"],
        },
    })


def _chunk_manifest_identity_canonical(representation_sha256: str, chunker: dict) -> str:
    return canonical_chunk_json({
        "schemaId": CHUNK_MANIFEST_SCHEMA_ID,
        "representationSha256": representation_sha256,
        "chunker": {
            "id": chunker["id"],
            "version": chunker["version"],
            "configSha256": chunker["configSha256"],
        },
    })


def _materialize_representation_chunks(
    cur,
    identity: IdentityContext,
    representation: dict,
) -> dict:
    manifest = materialize_document_chunks(
        representation["id"],
        representation["content_sha256"],
        representation["kind"],
        representation["content"],
    )
    chunker = manifest["chunker"]
    config_canonical = canonical_chunk_json(chunker["config"])
    rows = []
    for chunk in manifest["chunks"]:
        selector_canonical = canonical_chunk_json(chunk["selector"])
        rows.append((
            chunk["id"], identity.tenant_id, CHUNK_SCHEMA_ID,
            _chunk_identity_canonical(representation["content_sha256"], chunk),
            representation["id"], representation["content_sha256"], chunk["ordinal"],
            psycopg2.extras.Json(chunk["selector"]), selector_canonical,
            chunk["selectorSha256"], chunk["textContent"], chunk["contentSha256"],
            chunk["chunkerId"], chunk["chunkerVersion"],
            psycopg2.extras.Json(chunker["config"]), config_canonical,
            chunk["chunkerConfigSha256"], identity.principal_id,
        ))
    if rows:
        psycopg2.extras.execute_values(
            cur,
            """INSERT INTO gb_document_chunks (
                 id, tenant_id, identity_version, identity_canonical,
                 representation_id, representation_sha256, ordinal,
                 selector_json, selector_canonical, selector_sha256,
                 text_content, content_sha256, chunker, chunker_version,
                 chunker_config_json, chunker_config_canonical, chunker_config_sha256,
                 created_by_principal_id
               ) VALUES %s ON CONFLICT DO NOTHING""",
            rows,
            page_size=500,
        )
    cur.execute(
        """SELECT id, ordinal, selector_json, selector_sha256,
                  text_content, content_sha256
             FROM gb_document_chunks
            WHERE tenant_id = %s AND representation_id = %s
              AND representation_sha256 = %s AND identity_version = %s
              AND chunker = %s AND chunker_version = %s
              AND chunker_config_sha256 = %s
            ORDER BY ordinal""",
        (
            identity.tenant_id, representation["id"], representation["content_sha256"],
            CHUNK_SCHEMA_ID, chunker["id"], chunker["version"], chunker["configSha256"],
        ),
    )
    stored_chunks = [row_to_dict(row) for row in cur.fetchall()]
    if len(stored_chunks) != len(manifest["chunks"]):
        raise HTTPException(status_code=409, detail="Document chunks could not be reconciled")
    for stored, expected in zip(stored_chunks, manifest["chunks"]):
        if (
            stored["id"] != expected["id"]
            or stored["ordinal"] != expected["ordinal"]
            or stored["selector_json"] != expected["selector"]
            or stored["selector_sha256"] != expected["selectorSha256"]
            or stored["text_content"] != expected["textContent"]
            or stored["content_sha256"] != expected["contentSha256"]
        ):
            raise HTTPException(status_code=409, detail="Stored document chunk identity conflicts")

    ordered_ids = [chunk["id"] for chunk in manifest["chunks"]]
    chunks_sha256 = sha256_bytes(canonical_chunk_json(ordered_ids).encode("utf-8"))
    manifest_identity = _chunk_manifest_identity_canonical(
        representation["content_sha256"], chunker,
    )
    manifest_id = f"sha256:{sha256_bytes(manifest_identity.encode('utf-8'))}"
    cur.execute(
        """INSERT INTO gb_document_chunk_manifests (
             id, tenant_id, identity_version, identity_canonical,
             representation_id, representation_sha256, representation_kind,
             chunker, chunker_version, chunker_config_json,
             chunker_config_canonical, chunker_config_sha256,
             chunk_count, chunks_sha256, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT DO NOTHING RETURNING id""",
        (
            manifest_id, identity.tenant_id, CHUNK_MANIFEST_SCHEMA_ID, manifest_identity,
            representation["id"], representation["content_sha256"], representation["kind"],
            chunker["id"], chunker["version"], psycopg2.extras.Json(chunker["config"]),
            config_canonical, chunker["configSha256"], len(ordered_ids), chunks_sha256,
            identity.principal_id,
        ),
    )
    cur.fetchone()
    cur.execute(
        """SELECT id, representation_id, representation_sha256, representation_kind,
                  chunker, chunker_version, chunker_config_json, chunker_config_sha256,
                  chunk_count, chunks_sha256
             FROM gb_document_chunk_manifests
            WHERE tenant_id = %s AND representation_id = %s AND id = %s""",
        (identity.tenant_id, representation["id"], manifest_id),
    )
    stored_manifest = row_to_dict(cur.fetchone())
    if not stored_manifest or (
        str(stored_manifest["representation_id"]) != representation["id"]
        or stored_manifest["representation_sha256"] != representation["content_sha256"]
        or stored_manifest["representation_kind"] != representation["kind"]
        or stored_manifest["chunker"] != chunker["id"]
        or stored_manifest["chunker_version"] != chunker["version"]
        or stored_manifest["chunker_config_json"] != chunker["config"]
        or stored_manifest["chunker_config_sha256"] != chunker["configSha256"]
        or stored_manifest["chunk_count"] != len(ordered_ids)
        or stored_manifest["chunks_sha256"] != chunks_sha256
    ):
        raise HTTPException(status_code=409, detail="Document chunk manifest conflicts")
    return {
        **manifest,
        "id": manifest_id,
        "chunksSha256": chunks_sha256,
    }


def _best_effort_materialize_transform_chunks(
    identity: IdentityContext,
    revision_id: str,
    primary_receipt_id: str,
) -> None:
    """Build a local index without making transform evidence depend on it."""
    try:
        with _transaction(get_conn()) as cur:
            response = _document_transform_response(
                cur, identity, revision_id, primary_receipt_id, replayed=True,
            )
        representations = [
            representation for representation in response["representations"]
            if representation["kind"] in {"document-structure", "markdown", "text"}
        ]
    except Exception:
        log.exception("document chunk source discovery failed", extra={
            "document_revision_id": revision_id,
            "primary_receipt_id": primary_receipt_id,
        })
        return

    # Each derivative is independently useful. A valid but unchunkable rich
    # structure must not roll back a completed Markdown or text index.
    for representation in representations:
        try:
            with _transaction(get_conn()) as cur:
                _materialize_representation_chunks(cur, identity, representation)
        except Exception:
            log.exception("document representation chunk materialization failed", extra={
                "document_revision_id": revision_id,
                "primary_receipt_id": primary_receipt_id,
                "representation_id": representation["id"],
                "representation_kind": representation["kind"],
            })


def _representation_manifest(representation: dict) -> dict:
    return _representations_manifest([representation])


def _representations_manifest(representations: List[dict]) -> dict:
    return {
        "schemaId": "gb.transform-output-manifest.v1",
        "representations": [
            {
                "id": representation["id"],
                "kind": representation["kind"],
                "mediaType": representation["media_type"],
                "contentSha256": representation["content_sha256"],
            }
            for representation in representations
        ],
    }


def _insert_transform_receipt(
    cur,
    identity: IdentityContext,
    revision: dict,
    *,
    plugin_id: str,
    plugin_version: str,
    engine: str,
    engine_version: str,
    config: dict,
    status: str,
    diagnostic_code: Optional[str],
    output_manifest: dict,
    output_representation_id: Optional[str] = None,
    output_sha256: Optional[str] = None,
    fallback_receipt_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    request_sha256: Optional[str] = None,
) -> dict:
    cur.execute(
        """INSERT INTO gb_transform_receipts (
             tenant_id, document_revision_id, input_artifact_id,
             plugin_id, plugin_version, engine, engine_version,
             config_json, config_sha256, input_sha256, output_representation_id, output_sha256,
             status, diagnostic_code, output_manifest, fallback_receipt_id,
             idempotency_key, request_sha256, created_by_principal_id
           ) VALUES (
             %s, %s, %s, %s, %s, %s, %s,
             %s, encode(digest(convert_to(%s::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
             %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
           )
           RETURNING id, config_sha256, created_at""",
        (
            identity.tenant_id, revision["revision_id"], revision["original_artifact_id"],
            plugin_id, plugin_version, engine, engine_version,
            psycopg2.extras.Json(config), psycopg2.extras.Json(config),
            revision["content_sha256"], output_representation_id, output_sha256, status, diagnostic_code,
            psycopg2.extras.Json(output_manifest), fallback_receipt_id,
            idempotency_key, request_sha256, identity.principal_id,
        ),
    )
    inserted = cur.fetchone()
    created_at = inserted["created_at"]
    if isinstance(created_at, datetime):
        created_at = created_at.isoformat()
    return {
        "id": str(inserted["id"]),
        "plugin_id": plugin_id,
        "plugin_version": plugin_version,
        "engine": engine,
        "engine_version": engine_version,
        "config_sha256": inserted["config_sha256"],
        "input_sha256": revision["content_sha256"],
        "output_representation_id": output_representation_id,
        "output_sha256": output_sha256,
        "status": status,
        "diagnostic_code": diagnostic_code,
        "output_manifest": output_manifest,
        "fallback_receipt_id": fallback_receipt_id,
        "created_at": created_at,
    }


def _receipt_view(row: Any) -> Optional[dict]:
    value = row_to_dict(row)
    if not value:
        return None
    return {
        key: value.get(key)
        for key in (
            "id", "plugin_id", "plugin_version", "engine", "engine_version",
            "config_sha256", "input_sha256", "output_representation_id", "output_sha256", "status",
            "diagnostic_code", "output_manifest", "fallback_receipt_id", "created_at",
        )
    }


def _document_representations(
    cur,
    revision_id: str,
    identities: Optional[set[tuple[str, str]]] = None,
) -> List[dict]:
    identity_ids = sorted({representation_id for representation_id, _ in identities or set()})
    identity_filter = (
        " AND (representation.artifact_id IS NOT NULL "
        "OR representation.id = ANY(%s::uuid[]))"
        if identities is not None
        else ""
    )
    cur.execute(
        """SELECT representation.id, representation.kind, representation.media_type,
                  representation.content_sha256, representation.artifact_id,
                  representation.content_json, representation.content_bytes,
                  CASE WHEN representation.content_json IS NULL THEN NULL ELSE
                    encode(digest(convert_to(representation.content_json::text, 'UTF8'), 'sha256'), 'hex')
                  END AS content_json_sha256,
                  artifact.content_sha256 AS artifact_sha256, representation.created_at
             FROM gb_document_representations representation
             LEFT JOIN gb_artifacts artifact
               ON artifact.tenant_id = representation.tenant_id
              AND artifact.id = representation.artifact_id
            WHERE representation.document_revision_id = %s"""
        + identity_filter
        + " ORDER BY representation.created_at, representation.id",
        (revision_id, identity_ids) if identities is not None else (revision_id,),
    )
    representations = []
    for raw in cur.fetchall():
        row = row_to_dict(raw)
        representation_identity = (str(row["id"]), row["content_sha256"])
        if (
            identities is not None
            and row["artifact_id"] is None
            and representation_identity not in identities
        ):
            continue
        content = None
        if row["artifact_id"] is not None:
            if row["artifact_sha256"] != row["content_sha256"]:
                raise HTTPException(status_code=409, detail="Stored original representation hash mismatch")
        elif row["content_json"] is not None:
            content = row["content_json"]
            if row["content_json_sha256"] != row["content_sha256"]:
                raise HTTPException(status_code=409, detail="Stored document representation hash mismatch")
        else:
            encoded = bytes(row["content_bytes"] or b"")
            if sha256_bytes(encoded) != row["content_sha256"]:
                raise HTTPException(status_code=409, detail="Stored document representation hash mismatch")
            try:
                decoded = encoded.decode("utf-8")
            except UnicodeDecodeError as error:
                raise HTTPException(status_code=409, detail="Stored text representation is invalid") from error
            if row["kind"] == "document-structure":
                try:
                    content = json.loads(decoded)
                except json.JSONDecodeError as error:
                    raise HTTPException(status_code=409, detail="Stored document structure is invalid") from error
            else:
                content = decoded
        representations.append({
            "id": str(row["id"]),
            "kind": row["kind"],
            "media_type": row["media_type"],
            "content_sha256": row["content_sha256"],
            "artifact_id": str(row["artifact_id"]) if row["artifact_id"] else None,
            "content": content,
            "created_at": row["created_at"],
        })
    return representations


def _document_local_index_status(cur, identity: IdentityContext, representations: List[dict]) -> dict:
    candidates = [
        representation
        for kind in ("document-structure", "markdown", "text")
        for representation in reversed(representations)
        if representation["kind"] == kind
    ]
    preferred = None
    chunker = None
    manifest = None
    for candidate in candidates:
        candidate_chunker = current_document_chunker(candidate["kind"])
        cur.execute(
            """SELECT id, representation_id, representation_sha256, representation_kind,
                      chunker, chunker_version, chunker_config_sha256,
                      chunk_count, chunks_sha256
                 FROM gb_document_chunk_manifests
                WHERE tenant_id = %s AND representation_id = %s
                  AND representation_sha256 = %s AND identity_version = %s
                  AND chunker = %s AND chunker_version = %s
                  AND chunker_config_sha256 = %s
                LIMIT 1""",
            (
                identity.tenant_id, candidate["id"], candidate["content_sha256"],
                CHUNK_MANIFEST_SCHEMA_ID, candidate_chunker["id"],
                candidate_chunker["version"], candidate_chunker["configSha256"],
            ),
        )
        candidate_manifest = row_to_dict(cur.fetchone())
        if candidate_manifest is not None:
            preferred = candidate
            chunker = candidate_chunker
            manifest = candidate_manifest
            break
    if preferred is None or chunker is None or manifest is None:
        return {
            "schemaId": "gb.document-local-index-status.v1",
            "status": "not-built",
        }
    cur.execute(
        """SELECT count(*)::integer AS chunk_count
             FROM gb_document_chunks
            WHERE tenant_id = %s AND representation_id = %s
              AND representation_sha256 = %s AND identity_version = %s
              AND chunker = %s AND chunker_version = %s
              AND chunker_config_sha256 = %s""",
        (
            identity.tenant_id, preferred["id"], preferred["content_sha256"],
            CHUNK_SCHEMA_ID, chunker["id"], chunker["version"], chunker["configSha256"],
        ),
    )
    counted = row_to_dict(cur.fetchone())
    if counted is None or counted["chunk_count"] != manifest["chunk_count"]:
        raise HTTPException(status_code=409, detail="Document chunk manifest is incomplete")
    return {
        "schemaId": "gb.document-local-index-status.v1",
        "status": "ready",
        "chunk_count": manifest["chunk_count"],
        "chunks_sha256": manifest["chunks_sha256"],
        "source": {
            "manifest_id": manifest["id"],
            "representation_id": str(manifest["representation_id"]),
            "representation_sha256": manifest["representation_sha256"],
            "representation_kind": manifest["representation_kind"],
            "chunker": manifest["chunker"],
            "chunker_version": manifest["chunker_version"],
            "chunker_config_sha256": manifest["chunker_config_sha256"],
        },
    }


def _receipt_representation_identities(receipt: Optional[dict]) -> set[tuple[str, str]]:
    if receipt is None:
        return set()
    identities = set()
    representation_id = receipt.get("output_representation_id")
    content_sha256 = receipt.get("output_sha256")
    if representation_id is not None or content_sha256 is not None:
        try:
            normalized_representation_id = str(UUID(representation_id))
        except (TypeError, ValueError):
            raise HTTPException(status_code=409, detail="Stored transform receipt output is invalid")
        if not isinstance(content_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", content_sha256):
            raise HTTPException(status_code=409, detail="Stored transform receipt output is invalid")
        identities.add((normalized_representation_id, content_sha256))
    manifest = receipt.get("output_manifest")
    if not isinstance(manifest, dict):
        raise HTTPException(status_code=409, detail="Stored transform receipt manifest is invalid")
    representations = manifest.get("representations", [])
    if not isinstance(representations, list) or len(representations) > 32:
        raise HTTPException(status_code=409, detail="Stored transform receipt manifest is invalid")
    for representation in representations:
        if not isinstance(representation, dict):
            raise HTTPException(status_code=409, detail="Stored transform receipt manifest is invalid")
        manifest_id = representation.get("id")
        manifest_hash = representation.get("contentSha256")
        try:
            normalized_manifest_id = str(UUID(manifest_id))
        except (TypeError, ValueError):
            raise HTTPException(status_code=409, detail="Stored transform receipt manifest is invalid")
        if not isinstance(manifest_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest_hash):
            raise HTTPException(status_code=409, detail="Stored transform receipt manifest is invalid")
        identities.add((normalized_manifest_id, manifest_hash))
    return identities


def _document_transform_response(
    cur,
    identity: IdentityContext,
    revision_id: str,
    primary_receipt_id: str,
    *,
    replayed: bool,
) -> dict:
    cur.execute(
        """SELECT id, plugin_id, plugin_version, engine, engine_version,
                  config_sha256, input_sha256, output_representation_id, output_sha256, status,
                  diagnostic_code, output_manifest, fallback_receipt_id, created_at
             FROM gb_transform_receipts WHERE id = %s""",
        (primary_receipt_id,),
    )
    receipt = _receipt_view(cur.fetchone())
    if receipt is None:
        raise HTTPException(status_code=409, detail="Document transform replay is incomplete")
    fallback_receipt = None
    if receipt["fallback_receipt_id"]:
        cur.execute(
            """SELECT id, plugin_id, plugin_version, engine, engine_version,
                      config_sha256, input_sha256, output_representation_id, output_sha256, status,
                      diagnostic_code, output_manifest, fallback_receipt_id, created_at
                 FROM gb_transform_receipts WHERE id = %s""",
            (receipt["fallback_receipt_id"],),
        )
        fallback_receipt = _receipt_view(cur.fetchone())
    output_identities = (
        _receipt_representation_identities(receipt)
        | _receipt_representation_identities(fallback_receipt)
    )
    representations = [
        representation
        for representation in _document_representations(cur, revision_id, output_identities)
        if representation["kind"] == "original"
        or (representation["id"], representation["content_sha256"]) in output_identities
    ]
    return {
        "schemaId": DOCUMENT_TRANSFORM_SCHEMA,
        "persisted": True,
        "document_revision_id": revision_id,
        "representations": representations,
        "local_index": _document_local_index_status(cur, identity, representations),
        "receipt": receipt,
        "fallbackReceipt": fallback_receipt,
        "replayed": replayed,
    }


async def _read_document_anchor_json(request: Request) -> dict:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_DOCUMENT_ANCHOR_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Document anchor body exceeds 128 KiB")
        chunks.append(chunk)

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise DocumentAnchorContractError("Duplicate JSON fields are not allowed")
            value[key] = item
        return value

    try:
        value = json.loads(
            b"".join(chunks).decode("utf-8", "strict"),
            object_pairs_hook=unique_fields,
        )
    except DocumentAnchorContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise HTTPException(
            status_code=422, detail="Document anchor body is not valid bounded JSON",
        ) from error
    if not isinstance(value, dict) or set(value) != {"representation_id", "selector"}:
        raise HTTPException(
            status_code=422,
            detail="Document anchor requires representation_id and selector",
        )
    return value


async def _read_agent_anchor_create_json(request: Request) -> dict:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_AGENT_ANCHOR_CREATE_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Agent anchor request exceeds 64 KiB")
        chunks.append(chunk)

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise DocumentAnchorContractError("Duplicate JSON fields are not allowed")
            value[key] = item
        return value

    try:
        value = json.loads(
            b"".join(chunks).decode("utf-8", "strict"),
            object_pairs_hook=unique_fields,
        )
    except DocumentAnchorContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise HTTPException(
            status_code=422, detail="Agent anchor request is not valid bounded JSON",
        ) from error
    if not isinstance(value, dict) or set(value) != {
        "documentRef", "representation", "selector", "idempotencyKey",
    }:
        raise HTTPException(status_code=422, detail="Agent anchor request fields are invalid")
    representation = value["representation"]
    if not isinstance(representation, dict) or set(representation) != {"id", "contentSha256"}:
        raise HTTPException(status_code=422, detail="Agent anchor representation fields are invalid")
    return value


async def _read_document_mark_json(request: Request) -> dict:
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_DOCUMENT_MARK_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Document mark body exceeds 128 KiB")
        chunks.append(chunk)

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise DocumentMarkContractError("Duplicate JSON fields are not allowed")
            value[key] = item
        return value

    try:
        value = json.loads(
            b"".join(chunks).decode("utf-8", "strict"),
            object_pairs_hook=unique_fields,
        )
    except DocumentMarkContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Document mark body is not valid bounded JSON") from error
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Document mark body must be an object")
    return value


def _document_mark_uuid(value: str) -> str:
    return _canonical_uuid(value, "document mark")


def _document_mark_record(cur, identity: IdentityContext, mark_id: str) -> Optional[dict]:
    cur.execute(
        """SELECT mark.id, mark.document_revision_id, mark.anchor_id, mark.kind,
                  mark.current_version, mark.current_revision_id,
                  mark.current_content_hash, mark.body_markdown, mark.color,
                  mark.semantic_role, mark.tags, mark.state,
                  mark.created_by_principal_id, mark.created_at, mark.updated_at,
                  anchor.representation_sha256
             FROM gb_document_marks AS mark
             JOIN gb_document_anchors AS anchor
               ON anchor.tenant_id = mark.tenant_id
              AND anchor.document_revision_id = mark.document_revision_id
              AND anchor.id = mark.anchor_id
              AND anchor.identity_version = 'gb.anchor.v1'
            WHERE mark.tenant_id = %s AND mark.id = %s LIMIT 1""",
        (identity.tenant_id, mark_id),
    )
    row = row_to_dict(cur.fetchone())
    if row is None:
        return None
    return {
        "schemaId": DOCUMENT_MARK_SCHEMA_ID,
        "id": str(row["id"]),
        "ref": _pinned_object_reference(
            "document.mark", str(row["id"]), row["current_content_hash"],
        ),
        "document_revision_id": str(row["document_revision_id"]),
        "anchor_id": row["anchor_id"],
        "anchor_ref": _pinned_object_reference(
            "document.anchor", row["anchor_id"], row["representation_sha256"],
        ),
        "kind": row["kind"],
        "version": int(row["current_version"]),
        "revision_id": str(row["current_revision_id"]),
        "content_hash": row["current_content_hash"],
        "body_markdown": row["body_markdown"],
        "color": row["color"],
        "semantic_role": row["semantic_role"],
        "tags": list(row["tags"] or []),
        "state": row["state"],
        "created_by_principal_id": str(row["created_by_principal_id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _document_mark_revision_record(
    cur,
    identity: IdentityContext,
    mark_id: str,
    revision_id: str,
) -> Optional[dict]:
    """Return the exact immutable acknowledgement produced by one mark mutation."""
    cur.execute(
        """SELECT mark.id, mark.document_revision_id, mark.anchor_id, mark.kind,
                  revision.version AS current_version,
                  revision.id AS current_revision_id,
                  revision.content_hash AS current_content_hash,
                  revision.body_markdown, revision.color, revision.semantic_role,
                  revision.tags, revision.state,
                  mark.created_by_principal_id,
                  mark.created_at, revision.created_at AS updated_at,
                  anchor.representation_sha256
             FROM gb_document_marks AS mark
             JOIN gb_document_mark_revisions AS revision
               ON revision.tenant_id = mark.tenant_id
              AND revision.mark_id = mark.id
             JOIN gb_document_anchors AS anchor
               ON anchor.tenant_id = mark.tenant_id
              AND anchor.document_revision_id = mark.document_revision_id
              AND anchor.id = mark.anchor_id
              AND anchor.identity_version = 'gb.anchor.v1'
            WHERE mark.tenant_id = %s AND mark.id = %s AND revision.id = %s
            LIMIT 1""",
        (identity.tenant_id, mark_id, revision_id),
    )
    row = row_to_dict(cur.fetchone())
    if row is None:
        return None
    return {
        "schemaId": DOCUMENT_MARK_SCHEMA_ID,
        "id": str(row["id"]),
        "ref": _pinned_object_reference(
            "document.mark", str(row["id"]), row["current_content_hash"],
        ),
        "document_revision_id": str(row["document_revision_id"]),
        "anchor_id": row["anchor_id"],
        "anchor_ref": _pinned_object_reference(
            "document.anchor", row["anchor_id"], row["representation_sha256"],
        ),
        "kind": row["kind"],
        "version": int(row["current_version"]),
        "revision_id": str(row["current_revision_id"]),
        "content_hash": row["current_content_hash"],
        "body_markdown": row["body_markdown"],
        "color": row["color"],
        "semantic_role": row["semantic_role"],
        "tags": list(row["tags"] or []),
        "state": row["state"],
        "created_by_principal_id": str(row["created_by_principal_id"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _document_mark_state(value: dict) -> dict:
    try:
        return normalize_document_mark_state(value)
    except DocumentMarkContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _document_anchor_representation(
    cur,
    identity: IdentityContext,
    revision_id: str,
    representation_id: str,
) -> Optional[dict]:
    cur.execute(
        """SELECT representation.id, representation.kind, representation.media_type,
                  representation.content_sha256, representation.artifact_id,
                  representation.content_json, representation.content_bytes,
                  CASE WHEN representation.content_json IS NULL THEN NULL ELSE
                    encode(digest(convert_to(representation.content_json::text, 'UTF8'), 'sha256'), 'hex')
                  END AS content_json_sha256,
                  artifact.content_sha256 AS artifact_sha256,
                  artifact.byte_size AS artifact_byte_size,
                  CASE
                    WHEN representation.kind = 'original'
                     AND artifact.byte_size <= 2097152
                     AND (
                       btrim(lower(split_part(representation.media_type, ';', 1)))
                         ~ '^text/[a-z0-9!#$&^_.+-]+$'
                       OR btrim(lower(split_part(representation.media_type, ';', 1)))
                          IN ('application/json', 'application/xml')
                     )
                    THEN artifact.content_bytes
                    ELSE NULL
                  END AS artifact_bytes,
                  revision.id AS document_revision_id, revision.document_id,
                  revision.revision_sha256 AS document_revision_sha256,
                  revision.title, revision.display_filename,
                  revision.source_id, source.source_kind, source.source_uri
             FROM gb_document_representations AS representation
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = representation.tenant_id
              AND revision.id = representation.document_revision_id
             LEFT JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = representation.tenant_id
              AND artifact.id = representation.artifact_id
             JOIN gb_artifact_sources AS source
               ON source.tenant_id = revision.tenant_id
              AND source.id = revision.source_id
            WHERE representation.tenant_id = %s
              AND representation.document_revision_id = %s
              AND representation.id = %s
            LIMIT 1""",
        (identity.tenant_id, revision_id, representation_id),
    )
    row = row_to_dict(cur.fetchone())
    if not row:
        return None
    content = None
    if row["artifact_id"] is not None:
        if row["artifact_sha256"] != row["content_sha256"]:
            raise HTTPException(status_code=409, detail="Stored original representation hash mismatch")
        if row["kind"] == "original" and is_document_anchor_text_media_type(row["media_type"]):
            if row["artifact_byte_size"] is None:
                raise HTTPException(status_code=409, detail="Stored original representation is unavailable")
            if int(row["artifact_byte_size"]) > MAX_DOCUMENT_ANCHOR_TEXT_BYTES:
                raise HTTPException(status_code=422, detail="Textual original exceeds the anchor limit")
            if row["artifact_bytes"] is None:
                raise HTTPException(status_code=409, detail="Stored original representation is unavailable")
            encoded = bytes(row["artifact_bytes"])
            if len(encoded) != int(row["artifact_byte_size"]) or sha256_bytes(encoded) != row["content_sha256"]:
                raise HTTPException(status_code=409, detail="Stored original representation hash mismatch")
            try:
                content = encoded.decode("utf-8", "strict")
            except UnicodeDecodeError as error:
                raise HTTPException(status_code=409, detail="Stored textual original is invalid UTF-8") from error
    elif row["content_json"] is not None:
        content = row["content_json"]
        if row["content_json_sha256"] != row["content_sha256"]:
            raise HTTPException(status_code=409, detail="Stored document representation hash mismatch")
    else:
        encoded = bytes(row["content_bytes"] or b"")
        if sha256_bytes(encoded) != row["content_sha256"]:
            raise HTTPException(status_code=409, detail="Stored document representation hash mismatch")
        try:
            decoded = encoded.decode("utf-8")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=409, detail="Stored text representation is invalid") from error
        if row["kind"] == "document-structure":
            try:
                content = json.loads(decoded)
            except json.JSONDecodeError as error:
                raise HTTPException(status_code=409, detail="Stored document structure is invalid") from error
        else:
            content = decoded
    row["content"] = content
    return row


def _pinned_object_reference(kind: str, identifier: str, digest: str) -> str:
    safe = "~!*'()-._"
    wire = (
        f"gb:object:v1:{kind}:{urllib.parse.quote(identifier, safe=safe)}:pinned:"
        f"{urllib.parse.quote(f'sha256:{digest}', safe=safe)}"
    )
    return canonical_reference(wire)


def _document_anchor_record(
    cur,
    identity: IdentityContext,
    anchor_id: str,
    *,
    include_receipts: bool = True,
) -> Optional[dict]:
    cur.execute(
        """SELECT anchor.id, anchor.document_revision_id, anchor.representation_id,
                  anchor.representation_sha256, anchor.selector_json, anchor.selector_kind,
                  anchor.selector_sha256, anchor.anchor_sha256, anchor.created_at,
                  revision.document_id, revision.revision_sha256 AS document_revision_sha256,
                  revision.title, revision.display_filename,
                  revision.source_id, source.source_kind, source.source_uri,
                  representation.kind AS representation_kind,
                  representation.media_type AS representation_media_type
             FROM gb_document_anchors AS anchor
             JOIN gb_document_representations AS representation
               ON representation.tenant_id = anchor.tenant_id
              AND representation.id = anchor.representation_id
              AND representation.content_sha256 = anchor.representation_sha256
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = anchor.tenant_id
              AND revision.id = anchor.document_revision_id
             JOIN gb_artifact_sources AS source
               ON source.tenant_id = revision.tenant_id
              AND source.id = revision.source_id
            WHERE anchor.tenant_id = %s AND anchor.id = %s
              AND anchor.identity_version = 'gb.anchor.v1'
            LIMIT 1""",
        (identity.tenant_id, anchor_id),
    )
    row = row_to_dict(cur.fetchone())
    if not row:
        return None
    receipt_ids = None
    if include_receipts:
        cur.execute(
            """SELECT id FROM gb_transform_receipts
                WHERE tenant_id = %s AND document_revision_id = %s
                  AND (
                    (output_representation_id = %s AND output_sha256 = %s)
                    OR EXISTS (
                      SELECT 1
                        FROM jsonb_array_elements(
                          CASE
                            WHEN jsonb_typeof(output_manifest->'representations') = 'array'
                            THEN output_manifest->'representations'
                            ELSE '[]'::jsonb
                          END
                        ) AS manifested(item)
                       WHERE manifested.item->>'id' = %s
                         AND manifested.item->>'contentSha256' = %s
                    )
                  )
                ORDER BY created_at, id""",
            (
                identity.tenant_id, str(row["document_revision_id"]),
                str(row["representation_id"]), row["representation_sha256"],
                str(row["representation_id"]), row["representation_sha256"],
            ),
        )
        receipt_ids = [str(item["id"]) for item in cur.fetchall()]
    record = {
        "schemaId": DOCUMENT_ANCHOR_SCHEMA_ID,
        "id": row["id"],
        "ref": _pinned_object_reference(
            "document.anchor", row["id"], row["representation_sha256"],
        ),
        "document_ref": _pinned_object_reference(
            "document", str(row["document_id"]), row["document_revision_sha256"],
        ),
        "document_id": str(row["document_id"]),
        "document_revision_id": str(row["document_revision_id"]),
        "document_revision_sha256": row["document_revision_sha256"],
        "title": row["title"],
        "display_filename": row["display_filename"],
        "representation_id": str(row["representation_id"]),
        "representation_kind": row["representation_kind"],
        "representation_media_type": row["representation_media_type"],
        "representation_sha256": row["representation_sha256"],
        "selector": row["selector_json"],
        "selector_kind": row["selector_kind"],
        "selector_sha256": row["selector_sha256"],
        "anchor_sha256": row["anchor_sha256"],
        "source": {
            "id": str(row["source_id"]),
            "kind": row["source_kind"],
            "uri": row["source_uri"],
        },
        "created_at": row["created_at"],
    }
    if receipt_ids is not None:
        record["transform_receipt_ids"] = receipt_ids
    return record


def _document_anchor_cursor(created_at: Any, anchor_id: str, revision_id: str) -> str:
    timestamp = created_at.isoformat() if isinstance(created_at, datetime) else str(created_at)
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(status_code=500, detail="Stored document anchor cursor is invalid") from error
    if parsed.tzinfo is None:
        raise HTTPException(status_code=500, detail="Stored document anchor cursor is invalid")
    try:
        normalized = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except OverflowError as error:
        raise HTTPException(status_code=500, detail="Stored document anchor cursor is invalid") from error
    payload = json.dumps(
        {
            "schema_id": "gb.anchor.cursor.v1",
            "document_revision_id": revision_id,
            "created_at": normalized,
            "id": anchor_id,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _parse_document_anchor_cursor(
    value: Optional[str], revision_id: str,
) -> Optional[tuple[str, str]]:
    if value is None:
        return None
    try:
        padded = value + ("=" * (-len(value) % 4))
        decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
        payload = json.loads(decoded.decode("utf-8", "strict"))
        if not isinstance(payload, dict) or set(payload) != {
            "schema_id", "document_revision_id", "created_at", "id",
        }:
            raise ValueError("cursor shape")
        if (
            payload["schema_id"] != "gb.anchor.cursor.v1"
            or payload["document_revision_id"] != revision_id
        ):
            raise ValueError("cursor scope")
        created_at = payload["created_at"]
        anchor_id = payload["id"]
        if not isinstance(created_at, str) or not isinstance(anchor_id, str):
            raise ValueError("cursor types")
        parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if parsed.tzinfo is None or not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
            raise ValueError("cursor values")
        normalized = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return normalized, anchor_id
    except (UnicodeError, ValueError, OverflowError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="Document anchor cursor is invalid") from error


@app.post("/documents/import", status_code=201)
async def import_document(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    """Persist exact original bytes and provenance before any transform work."""
    idempotency_key = _document_import_client_idempotency_key(
        request.headers.get("idempotency-key", ""),
    )
    import_metadata = _ingestion_value(
        decode_import_metadata, request.headers.get("x-gb-import-metadata"),
    )
    original_filename = import_metadata["filename"]
    title = import_metadata["title"]
    source_kind = import_metadata["sourceKind"]
    source_uri = import_metadata["sourceUri"]
    # This endpoint never fetches the supplied URI. It records provenance for
    # bytes already supplied by the authenticated caller.
    arxiv_id = import_metadata["arxivId"]
    capture_intent_sha256 = import_metadata.get("captureIntentSha256")
    ingestion_plan = _ingestion_value(
        resolve_ingestion_plan_claim, import_metadata.get("ingestionPlan"),
    )
    if ingestion_plan is not None and ingestion_plan_expected_source_kind(ingestion_plan) != source_kind:
        raise HTTPException(status_code=422, detail="Ingestion plan does not authorize this source kind")
    supplied_media_type = request.headers.get("content-type")
    docx_upload = docx_candidate(original_filename, supplied_media_type)
    audio_candidate = audio_original_candidate(original_filename, supplied_media_type)
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            declared_bytes = int(declared_length)
            if docx_upload and declared_bytes > MAX_DOCX_BYTES:
                raise HTTPException(status_code=413, detail="DOCX exceeds the 25 MiB import limit")
            if audio_candidate and declared_bytes > MAX_AUDIO_ORIGINAL_BYTES:
                raise HTTPException(status_code=413, detail="WebM/Opus audio exceeds the 20 MiB import limit")
            if declared_bytes > MAX_DOCUMENT_BYTES:
                raise HTTPException(status_code=413, detail="Document exceeds the 100 MB import limit")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Document has an invalid content length") from error
    content = bytearray()
    signature = bytearray()
    async for chunk in request.stream():
        if len(signature) < 4:
            signature.extend(chunk[:4 - len(signature)])
            if len(signature) == 4:
                audio_candidate = audio_candidate or audio_original_candidate(
                    original_filename, supplied_media_type, bytes(signature),
                )
        if audio_candidate and len(content) + len(chunk) > MAX_AUDIO_ORIGINAL_BYTES:
            raise HTTPException(status_code=413, detail="WebM/Opus audio exceeds the 20 MiB import limit")
        if docx_upload and len(content) + len(chunk) > MAX_DOCX_BYTES:
            raise HTTPException(status_code=413, detail="DOCX exceeds the 25 MiB import limit")
        if len(content) + len(chunk) > MAX_DOCUMENT_BYTES:
            raise HTTPException(status_code=413, detail="Document exceeds the 100 MB import limit")
        content.extend(chunk)
    if not content:
        raise HTTPException(status_code=422, detail="Document body is empty")

    raw = bytes(content)
    content_sha256 = sha256_bytes(raw)
    if docx_upload:
        normalized_media_type = _ingestion_value(
            validate_docx_package, raw, original_filename, supplied_media_type,
        )
    else:
        normalized_media_type = _ingestion_value(
            ingestion_media_type, original_filename, supplied_media_type,
        )
    raster_image_header = request.headers.get("x-gb-raster-image")
    raster_image = None
    audio_original = None
    raster_candidate = (
        normalized_media_type in RASTER_IMAGE_MEDIA_TYPES
        or normalized_media_type.startswith("image/")
        or _raster_magic(raw) is not None
        or raster_image_header is not None
    )
    if raster_candidate:
        if normalized_media_type not in RASTER_IMAGE_MEDIA_TYPES:
            raise HTTPException(status_code=422, detail="Only static PNG, JPEG, WebP, and GIF images are supported")
        if source_kind != "upload":
            raise HTTPException(status_code=422, detail="Raster images must be uploaded as local files")
        raster_image = _ingestion_value(
            decode_raster_image_manifest,
            raster_image_header,
            filename=original_filename,
            media_type=normalized_media_type,
            content_sha256=content_sha256,
            byte_size=len(raw),
            content=raw,
        )
    elif audio_original_candidate(original_filename, normalized_media_type, raw):
        if source_kind != "upload":
            raise HTTPException(status_code=422, detail="WebM/Opus audio must be uploaded as a local file")
        audio_original = _ingestion_value(
            audio_original_manifest, raw, original_filename, normalized_media_type,
        )
    display_filename = _ingestion_value(
        normalize_display_filename, title, original_filename, content_sha256, arxiv_id,
    )
    metadata = {
        "title": title,
        "originalFilename": original_filename,
        "displayFilename": display_filename,
        "mediaType": normalized_media_type,
        "sourceKind": source_kind,
        "sourceUri": source_uri,
        "arxivId": arxiv_id,
    }
    if ingestion_plan is not None:
        metadata["ingestionPlan"] = ingestion_plan
    if capture_intent_sha256 is not None:
        metadata["captureIntentSha256"] = capture_intent_sha256
    if raster_image is not None:
        metadata["rasterImage"] = raster_image
    if audio_original is not None:
        metadata["audioOriginal"] = audio_original
    request_sha256 = import_request_hash(metadata, content_sha256)
    revision_sha256 = sha256_bytes(
        json.dumps({**metadata, "contentSha256": content_sha256}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )

    with _transaction(get_conn()) as cur:
        record, _ = _persist_document_import(
            cur,
            identity,
            raw=raw,
            normalized_media_type=normalized_media_type,
            metadata=metadata,
            idempotency_key=idempotency_key,
            request_sha256=request_sha256,
            revision_sha256=revision_sha256,
            source_metadata={
                **({"ingestionPlan": ingestion_plan} if ingestion_plan is not None else {}),
                **({"captureIntentSha256": capture_intent_sha256} if capture_intent_sha256 is not None else {}),
            } or None,
        )
        return record


@app.get("/documents")
def list_documents(identity: IdentityContext = Depends(require_identity)):
    del identity
    cur = get_conn().cursor()
    cur.execute(
        """SELECT id, title, display_filename, current_revision_id, current_version,
                  created_at, updated_at
             FROM gb_documents WHERE deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT 1000"""
    )
    return {"schemaId": "gb.document.list.v1", "documents": [row_to_dict(row) for row in cur.fetchall()]}


@app.get("/documents/search")
def search_documents(
    q: str = Query(...),
    limit: int = Query(DEFAULT_DOCUMENT_SEARCH_LIMIT),
    identity: IdentityContext = Depends(require_identity),
):
    """Search current tenant-local derived chunks without exposing chunk objects."""
    try:
        query = normalize_document_search_query(q)
        bounded_limit = normalize_document_search_limit(limit)
    except DocumentSearchContractError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    structure_chunker = current_document_chunker("document-structure")
    markdown_chunker = current_document_chunker("markdown")
    text_chunker = current_document_chunker("text")
    parameters = (
        "document-structure", 0, structure_chunker["id"], structure_chunker["version"],
        structure_chunker["configSha256"],
        "markdown", 1, markdown_chunker["id"], markdown_chunker["version"],
        markdown_chunker["configSha256"],
        "text", 2, text_chunker["id"], text_chunker["version"],
        text_chunker["configSha256"],
        query, identity.tenant_id, bounded_limit + 1,
    )
    try:
        with _transaction(get_conn()) as cur:
            cur.execute("SET LOCAL statement_timeout = '2s'")
            cur.execute(
                """WITH required_chunker(kind, priority, chunker, chunker_version, config_sha256) AS (
                       VALUES (%s, %s, %s, %s, %s),
                              (%s, %s, %s, %s, %s),
                              (%s, %s, %s, %s, %s)
                     ), search_query AS (
                       SELECT plainto_tsquery('simple'::regconfig, %s) AS value
                     ), indexed_content_candidates AS MATERIALIZED (
                       SELECT DISTINCT ON (document.id, representation.id)
                              document.id AS document_id,
                              chunk.tenant_id,
                              document.updated_at,
                              revision.id AS document_revision_id,
                              revision.revision_sha256,
                              revision.title,
                              revision.display_filename,
                              representation.id AS representation_id,
                              representation.content_sha256 AS representation_sha256,
                              representation.kind AS representation_kind,
                              representation.created_at AS representation_created_at,
                              required.priority AS representation_priority,
                              chunk.content_sha256 AS chunk_content_sha256,
                              chunk.selector_json,
                              chunk.ordinal,
                              chunk.chunker,
                              chunk.chunker_version,
                              chunk.chunker_config_sha256,
                              chunk.text_content,
                              ts_rank_cd(
                                to_tsvector('simple'::regconfig, chunk.text_content), search_query.value
                              ) AS relevance
                         FROM gb_document_chunks AS chunk
                         CROSS JOIN search_query
                         JOIN gb_document_representations AS representation
                           ON representation.tenant_id = chunk.tenant_id
                          AND representation.id = chunk.representation_id
                          AND representation.content_sha256 = chunk.representation_sha256
                         JOIN required_chunker AS required
                           ON required.kind = representation.kind
                          AND required.chunker = chunk.chunker
                          AND required.chunker_version = chunk.chunker_version
                          AND required.config_sha256 = chunk.chunker_config_sha256
                         JOIN gb_document_revisions AS revision
                           ON revision.tenant_id = representation.tenant_id
                          AND revision.id = representation.document_revision_id
                         JOIN gb_documents AS document
                           ON document.tenant_id = revision.tenant_id
                          AND document.id = revision.document_id
                          AND document.current_revision_id = revision.id
                          AND document.current_version = revision.version
                        WHERE chunk.tenant_id = %s
                          AND chunk.identity_version = 'gb.document-chunk.v1'
                          AND document.deleted_at IS NULL
                          AND to_tsvector('simple'::regconfig, chunk.text_content) @@ search_query.value
                        ORDER BY document.id, representation.id, relevance DESC,
                                 chunk.ordinal, chunk.content_sha256
                     ), complete_content_candidates AS (
                       SELECT candidate.*,
                              preferred.manifest_id
                         FROM indexed_content_candidates AS candidate
                         JOIN LATERAL (
                           SELECT preferred_representation.id AS representation_id,
                                  preferred_representation.content_sha256 AS representation_sha256,
                                  preferred_manifest.id AS manifest_id,
                                  preferred_manifest.chunker,
                                  preferred_manifest.chunker_version,
                                  preferred_manifest.chunker_config_sha256
                             FROM gb_document_representations AS preferred_representation
                             JOIN required_chunker AS preferred_required
                               ON preferred_required.kind = preferred_representation.kind
                             JOIN gb_document_chunk_manifests AS preferred_manifest
                               ON preferred_manifest.tenant_id = preferred_representation.tenant_id
                              AND preferred_manifest.representation_id = preferred_representation.id
                              AND preferred_manifest.representation_sha256 = preferred_representation.content_sha256
                              AND preferred_manifest.identity_version = 'gb.document-chunk-manifest.v1'
                              AND preferred_manifest.representation_kind = preferred_required.kind
                              AND preferred_manifest.chunker = preferred_required.chunker
                              AND preferred_manifest.chunker_version = preferred_required.chunker_version
                              AND preferred_manifest.chunker_config_sha256 = preferred_required.config_sha256
                            WHERE preferred_representation.tenant_id = candidate.tenant_id
                              AND preferred_representation.document_revision_id = candidate.document_revision_id
                              AND preferred_manifest.chunk_count = (
                                SELECT count(*)::integer
                                  FROM gb_document_chunks AS complete_chunk
                                 WHERE complete_chunk.tenant_id = preferred_manifest.tenant_id
                                   AND complete_chunk.representation_id = preferred_manifest.representation_id
                                   AND complete_chunk.representation_sha256 = preferred_manifest.representation_sha256
                                   AND complete_chunk.identity_version = 'gb.document-chunk.v1'
                                   AND complete_chunk.chunker = preferred_manifest.chunker
                                   AND complete_chunk.chunker_version = preferred_manifest.chunker_version
                                   AND complete_chunk.chunker_config_sha256 = preferred_manifest.chunker_config_sha256
                              )
                            ORDER BY preferred_required.priority,
                                     preferred_representation.created_at DESC,
                                     preferred_representation.id DESC
                            LIMIT 1
                         ) AS preferred
                           ON preferred.representation_id = candidate.representation_id
                          AND preferred.representation_sha256 = candidate.representation_sha256
                          AND preferred.chunker = candidate.chunker
                          AND preferred.chunker_version = candidate.chunker_version
                          AND preferred.chunker_config_sha256 = candidate.chunker_config_sha256
                     ), ranked AS (
                       SELECT candidate.*,
                              'content'::text AS match_source,
                              ts_headline(
                                'simple'::regconfig,
                                candidate.text_content,
                                search_query.value,
                                'StartSel=__GB_START__, StopSel=__GB_STOP__, MaxWords=45, MinWords=8, ShortWord=2, MaxFragments=1, FragmentDelimiter= … '
                              ) AS headline,
                              row_number() OVER (
                                PARTITION BY candidate.document_id
                                ORDER BY candidate.representation_priority,
                                         candidate.representation_created_at DESC,
                                         candidate.representation_id DESC,
                                         candidate.relevance DESC,
                                         candidate.ordinal,
                                         candidate.chunk_content_sha256
                              ) AS document_rank
                         FROM complete_content_candidates AS candidate
                         CROSS JOIN search_query
                     )
                     SELECT * FROM ranked
                      WHERE document_rank = 1
                      ORDER BY relevance DESC, updated_at DESC, document_id
                      LIMIT %s""",
                parameters,
            )
            rows = [row_to_dict(row) for row in cur.fetchall()]
    except psycopg2.errors.QueryCanceled as error:
        raise HTTPException(status_code=503, detail="Document search timed out") from error

    has_more = len(rows) > bounded_limit
    items = []
    for row in rows[:bounded_limit]:
        try:
            snippet = plain_search_snippet(row["headline"])
            selector = bounded_search_selector(row["selector_json"])
            title = bounded_search_result_text(
                row["title"], "title", maximum_characters=1_000, maximum_bytes=4_096,
            )
            display_filename = bounded_search_result_text(
                row["display_filename"], "display filename",
                maximum_characters=512, maximum_bytes=2_048,
            )
        except DocumentSearchContractError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        items.append({
            "documentRef": _pinned_object_reference(
                "document", str(row["document_id"]), row["revision_sha256"],
            ),
            "documentId": str(row["document_id"]),
            "documentRevisionId": str(row["document_revision_id"]),
            "revisionSha256": row["revision_sha256"],
            "title": title,
            "displayFilename": display_filename,
            "snippet": snippet,
            "matchSource": row["match_source"],
            "source": {
                "manifestId": row["manifest_id"],
                "representationId": str(row["representation_id"]),
                "representationSha256": row["representation_sha256"],
                "representationKind": row["representation_kind"],
                "chunkContentSha256": row["chunk_content_sha256"],
                "selector": selector,
            },
        })
    response = {
        "schemaId": DOCUMENT_SEARCH_SCHEMA_ID,
        "query": query,
        "items": items,
        "continuation": {"hasMore": has_more},
    }
    if len(json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 65_536:
        raise HTTPException(status_code=503, detail="Document search response exceeds its bounded contract")
    return response


@app.get("/documents/{revision_id}")
def get_document_revision(
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    """Resolve an exact immutable revision for cold reader deep links."""
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    cur = get_conn().cursor()
    cur.execute(
        """SELECT revision.id AS revision_id, revision.document_id, revision.version,
                  revision.revision_sha256, revision.title, revision.display_filename,
                  revision.original_artifact_id, revision.source_id, revision.created_at,
                  artifact.content_sha256 AS artifact_sha256,
                  artifact.byte_size AS artifact_byte_size,
                  artifact.media_type AS artifact_media_type,
                  source.source_kind, source.source_uri, source.original_filename,
                  source.source_metadata
             FROM gb_document_revisions AS revision
             JOIN gb_documents AS document
               ON document.tenant_id = revision.tenant_id
              AND document.id = revision.document_id
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = revision.tenant_id
              AND artifact.id = revision.original_artifact_id
             JOIN gb_artifact_sources AS source
               ON source.tenant_id = revision.tenant_id
              AND source.id = revision.source_id
            WHERE revision.tenant_id = %s AND revision.id = %s
              AND document.deleted_at IS NULL LIMIT 1""",
        (identity.tenant_id, normalized_revision_id),
    )
    row = row_to_dict(cur.fetchone())
    if row is None:
        raise HTTPException(status_code=404, detail="Document revision not found")
    cur.execute(
        """SELECT id, kind, media_type, content_sha256, created_at
             FROM gb_document_representations
            WHERE tenant_id = %s AND document_revision_id = %s
            ORDER BY created_at, id""",
        (identity.tenant_id, normalized_revision_id),
    )
    representations = []
    for representation in cur.fetchall():
        value = row_to_dict(representation)
        representation_id = str(value["id"])
        representations.append({
            "id": representation_id,
            "kind": value["kind"],
            "media_type": value["media_type"],
            "content_sha256": value["content_sha256"],
            "content_path": (
                f"/documents/{normalized_revision_id}/representations/"
                f"{representation_id}/content"
            ),
            "created_at": value["created_at"],
        })
    source_metadata = row.get("source_metadata") if isinstance(row.get("source_metadata"), dict) else {}
    raster_image = source_metadata.get("rasterImage")
    audio_original = source_metadata.get("audioOriginal")
    if row["artifact_media_type"] in RASTER_IMAGE_MEDIA_TYPES:
        raster_image = _ingestion_value(
            normalize_raster_image_manifest,
            raster_image,
            filename=row["original_filename"],
            media_type=row["artifact_media_type"],
            content_sha256=row["artifact_sha256"],
            byte_size=int(row["artifact_byte_size"]),
        )
    elif raster_image is not None:
        raise HTTPException(status_code=409, detail="Document source metadata is inconsistent")
    if row["artifact_media_type"] == "audio/webm":
        audio_original = _ingestion_value(
            normalize_audio_original_manifest,
            audio_original,
            media_type=row["artifact_media_type"],
            content_sha256=row["artifact_sha256"],
            byte_size=int(row["artifact_byte_size"]),
        )
    elif audio_original is not None:
        raise HTTPException(status_code=409, detail="Document source metadata is inconsistent")
    response = {
        "schemaId": "gb.document-revision.v1",
        "document_id": str(row["document_id"]),
        "ref": _pinned_object_reference(
            "document", str(row["document_id"]), row["revision_sha256"],
        ),
        "revision_id": str(row["revision_id"]),
        "version": int(row["version"]),
        "revision_sha256": row["revision_sha256"],
        "title": row["title"],
        "display_filename": row["display_filename"],
        "created_at": row["created_at"],
        "artifact": {
            "id": str(row["original_artifact_id"]),
            "content_sha256": row["artifact_sha256"],
            "byte_size": int(row["artifact_byte_size"]),
            "media_type": row["artifact_media_type"],
        },
        "source": {
            "id": str(row["source_id"]),
            "kind": row["source_kind"],
            "uri": row["source_uri"],
            "original_filename": row["original_filename"],
        },
        "representations": representations,
    }
    if raster_image is not None:
        response["raster_image"] = raster_image
    if audio_original is not None:
        response["audio_original"] = audio_original
    return response


def _transform_failure_status(response: dict) -> int:
    receipt = response.get("fallbackReceipt") or response.get("receipt") or {}
    diagnostic = str(receipt.get("diagnostic_code") or "")
    if diagnostic.endswith(".unsupported"):
        return 415
    if diagnostic.endswith(".input_too_large") or diagnostic.endswith(".output_too_large"):
        return 422
    if diagnostic.endswith(".not_configured"):
        return 503
    return 502


def _transform_response_for_receipt(
    cur,
    identity: IdentityContext,
    revision_id: str,
    primary_receipt_id: str,
    *,
    replayed: bool,
):
    response = _document_transform_response(
        cur, identity, revision_id, primary_receipt_id, replayed=replayed,
    )
    fallback = response.get("fallbackReceipt")
    succeeded = response["receipt"]["status"] in {"success", "partial"} or (
        fallback is not None and fallback["status"] in {"success", "partial", "fallback"}
    )
    if succeeded:
        return response
    response["error"] = "Document transform did not produce a representation"
    return JSONResponse(response, status_code=_transform_failure_status(response))


def _release_transform_attempt(
    identity: IdentityContext,
    attempt_id: str,
    lease_token: str,
) -> None:
    """Make an unexpectedly interrupted attempt immediately reclaimable."""
    try:
        with _transaction(get_conn()) as cur:
            cur.execute(
                """UPDATE gb_transform_attempts
                      SET lease_expires_at = now(), updated_at = now()
                    WHERE tenant_id = %s AND id = %s AND state = 'running'
                      AND lease_token = %s""",
                (identity.tenant_id, attempt_id, lease_token),
            )
    except Exception:
        log.exception("failed to release document transform lease")


@app.get("/documents/{revision_id}/representations")
def list_document_representations(
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    cur = get_conn().cursor()
    # Listing metadata and derived text must not pull the authoritative source
    # blob into API memory. The exact bytes are read only by the content route
    # or by a worker that owns a transform lease and capacity slot.
    revision = _document_revision_evidence_for_transform(cur, normalized_revision_id)
    if revision is None:
        raise HTTPException(status_code=404, detail="Document revision not found")
    cur.execute(
        """SELECT id, plugin_id, plugin_version, engine, engine_version,
                  config_sha256, input_sha256, output_representation_id, output_sha256, status,
                  diagnostic_code, output_manifest, fallback_receipt_id, created_at
             FROM gb_transform_receipts
            WHERE document_revision_id = %s
            ORDER BY created_at DESC, id DESC LIMIT 128""",
        (normalized_revision_id,),
    )
    receipt_rows = [_receipt_view(row) for row in cur.fetchall()]
    fallback_ids = {
        str(receipt["fallback_receipt_id"])
        for receipt in receipt_rows
        if receipt is not None and receipt["fallback_receipt_id"]
    }
    primary_receipt = next(
        (
            receipt for receipt in receipt_rows
            if receipt is not None and str(receipt["id"]) not in fallback_ids
        ),
        None,
    )
    fallback_receipt = next(
        (
            receipt for receipt in receipt_rows
            if primary_receipt is not None
            and receipt is not None
            and str(receipt["id"]) == str(primary_receipt["fallback_receipt_id"])
        ),
        None,
    )
    current_receipts = [
        receipt for receipt in (primary_receipt, fallback_receipt) if receipt is not None
    ]
    output_identities = set().union(*(
        _receipt_representation_identities(receipt) for receipt in current_receipts
    )) if current_receipts else set()
    representations = _document_representations(
        cur, normalized_revision_id, output_identities,
    )
    return {
        "schemaId": "gb.document.representations.v1",
        "document_revision_id": normalized_revision_id,
        "representations": representations,
        "receipts": current_receipts,
        "local_index": _document_local_index_status(cur, identity, representations),
    }


@app.get("/documents/{revision_id}/representations/{representation_id}/content")
def read_document_representation_content(
    revision_id: str,
    representation_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
    document_id: Optional[str] = None,
    revision_sha256: Optional[str] = None,
):
    """Serve one immutable representation without conflating it with metadata."""
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    normalized_representation_id = _canonical_uuid(
        representation_id, "document representation",
    )
    if (document_id is None) != (revision_sha256 is None):
        raise HTTPException(status_code=422, detail="Document representation binding is incomplete")
    binding_clause = ""
    binding_parameters: tuple[str, ...] = ()
    if document_id is not None and revision_sha256 is not None:
        normalized_document_id = _canonical_uuid(document_id, "document")
        if not re.fullmatch(r"[0-9a-f]{64}", revision_sha256):
            raise HTTPException(status_code=422, detail="Document revision hash is invalid")
        binding_clause = "AND revision.document_id = %s AND revision.revision_sha256 = %s"
        binding_parameters = (normalized_document_id, revision_sha256)
    cur = get_conn().cursor()
    cur.execute(
        f"""SELECT representation.kind, representation.media_type,
                  representation.content_sha256, representation.artifact_id,
                  representation.content_json::text AS content_json_text,
                  representation.content_bytes, artifact.content_bytes AS artifact_bytes,
                  revision.display_filename
             FROM gb_document_representations AS representation
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = representation.tenant_id
              AND revision.id = representation.document_revision_id
             LEFT JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = representation.tenant_id
              AND artifact.id = representation.artifact_id
              AND artifact.content_sha256 = representation.content_sha256
            WHERE representation.tenant_id = %s
              AND representation.document_revision_id = %s
              AND representation.id = %s
              {binding_clause}
            LIMIT 1""",
        (identity.tenant_id, normalized_revision_id, normalized_representation_id, *binding_parameters),
    )
    row = row_to_dict(cur.fetchone())
    if row is None:
        raise HTTPException(status_code=404, detail="Document representation not found")
    if row["artifact_id"] is not None:
        if row["artifact_bytes"] is None:
            raise HTTPException(status_code=409, detail="Stored original representation is unavailable")
        content = bytes(row["artifact_bytes"])
    elif row["content_json_text"] is not None:
        content = row["content_json_text"].encode("utf-8")
    else:
        content = bytes(row["content_bytes"] or b"")
    if sha256_bytes(content) != row["content_sha256"]:
        raise HTTPException(status_code=409, detail="Stored document representation hash mismatch")

    display_name = str(row["display_filename"] or "document")
    extension = {
        "markdown": ".md",
        "text": ".txt",
        "document-structure": ".json",
    }.get(row["kind"], "")
    if row["kind"] != "original" and extension and not display_name.lower().endswith(extension):
        display_name = f"{Path(display_name).stem}{extension}"
    size = len(content)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(display_name)}",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "ETag": f'"sha256-{row["content_sha256"]}"',
        "X-Content-Type-Options": "nosniff",
        "X-Content-SHA256": row["content_sha256"],
    }
    try:
        selected_range = _paper_byte_range(request.headers.get("range"), size)
    except HTTPException as error:
        error.headers = {"Content-Range": f"bytes */{size}"}
        raise
    if selected_range is None:
        return Response(content, media_type=row["media_type"], headers=headers)
    start, end = selected_range
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(
        content[start:end + 1], status_code=206,
        media_type=row["media_type"], headers=headers,
    )


@app.get("/documents/{revision_id}/anchors")
def list_document_anchors(
    revision_id: str,
    limit: int = Query(100, ge=1, le=100),
    cursor: Optional[str] = Query(None, max_length=512),
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    cur = get_conn().cursor()
    if _document_revision_evidence_for_transform(cur, normalized_revision_id) is None:
        raise HTTPException(status_code=404, detail="Document revision not found")
    after = _parse_document_anchor_cursor(cursor, normalized_revision_id)
    parameters: list[Any] = [identity.tenant_id, normalized_revision_id]
    after_clause = ""
    if after is not None:
        after_clause = "AND (created_at, id) > (%s::timestamptz, %s)"
        parameters.extend(after)
    parameters.append(limit + 1)
    cur.execute(
        f"""SELECT id, created_at FROM gb_document_anchors
            WHERE tenant_id = %s AND document_revision_id = %s
              AND identity_version = 'gb.anchor.v1'
              {after_clause}
            ORDER BY created_at, id LIMIT %s""",
        tuple(parameters),
    )
    rows = cur.fetchall()
    page = rows[:limit]
    has_more = len(rows) > limit
    return {
        "schemaId": "gb.anchor.list.v1",
        "document_revision_id": normalized_revision_id,
        "anchors": [
            record for record in (
                _document_anchor_record(cur, identity, row["id"], include_receipts=False)
                for row in page
            ) if record is not None
        ],
        "next_cursor": _document_anchor_cursor(
            page[-1]["created_at"], page[-1]["id"], normalized_revision_id,
        )
        if has_more and page else None,
    }


@app.get("/documents/{revision_id}/anchors/{anchor_id}")
def get_document_anchor(
    revision_id: str,
    anchor_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
        raise HTTPException(status_code=422, detail="Document anchor id is invalid")
    record = _document_anchor_record(get_conn().cursor(), identity, anchor_id)
    if record is None or record["document_revision_id"] != normalized_revision_id:
        raise HTTPException(status_code=404, detail="Document anchor not found")
    return record


@app.get("/document-anchors/{anchor_id}")
def get_document_anchor_by_id(
    anchor_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    """Resolve one canonical anchor without requiring embedded reader route state."""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
        raise HTTPException(status_code=422, detail="Document anchor id is invalid")
    record = _document_anchor_record(get_conn().cursor(), identity, anchor_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Document anchor not found")
    return record


def _agent_anchor_document_revision(cur, identity: IdentityContext, document_ref: str):
    try:
        reference = parse_canonical_reference(document_ref)
    except ObjectLinkError as error:
        raise HTTPException(status_code=422, detail="A pinned canonical document reference is required") from error
    if (
        reference.kind != "document" or reference.revision is None
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", reference.revision)
    ):
        raise HTTPException(status_code=422, detail="A pinned canonical document reference is required")
    digest = reference.revision.removeprefix("sha256:")
    cur.execute(
        """SELECT document.id AS document_id, revision.id,
                  revision.revision_sha256
             FROM gb_documents AS document
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = document.tenant_id
              AND revision.document_id = document.id
            WHERE document.tenant_id = %s AND document.id::text = %s
              AND document.deleted_at IS NULL
              AND revision.revision_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, reference.identifier, digest),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Document representation not found")
    return {
        "document_ref": reference.wire,
        "document_id": str(row["document_id"]),
        "revision_id": str(row["id"]),
        "revision_sha256": row["revision_sha256"],
    }


def _agent_anchor_request_hash(document_ref: str, representation: dict, selector: dict) -> str:
    value = {
        "schemaId": "gb.agent-anchor-create.v1",
        "documentRef": document_ref,
        "representation": {
            "id": representation["id"],
            "contentSha256": representation["contentSha256"],
        },
        "selector": selector,
    }
    return hashlib.sha256(canonical_anchor_json(value).encode("utf-8")).hexdigest()


def _agent_anchor_receipt(
    document_ref: str,
    anchor: dict,
    request_hash: str,
    *,
    replayed: bool,
) -> dict:
    return {
        "schemaId": "gb.anchor.create-receipt.v1",
        "documentRef": document_ref,
        "anchorId": anchor["id"],
        "anchorRef": _pinned_object_reference(
            "document.anchor", anchor["id"], anchor["representationSha256"],
        ),
        "representationId": anchor["representationId"],
        "representationSha256": anchor["representationSha256"],
        "selectorSha256": anchor["selectorSha256"],
        "anchorSha256": anchor["anchorSha256"],
        "requestHash": request_hash,
        "replayed": replayed,
    }


@app.post("/agent-anchor-creations", status_code=201)
async def create_agent_document_anchor(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not secrets.compare_digest(
        request.headers.get("X-GB-Agent-Tool-Gateway", ""), "v1",
    ):
        raise HTTPException(status_code=404, detail="Not found")
    payload = await _read_agent_anchor_create_json(request)
    representation_input = payload["representation"]
    normalized_representation_id = _canonical_uuid(
        representation_input["id"], "document representation",
    )
    representation_sha256 = representation_input["contentSha256"]
    if not isinstance(representation_sha256, str) or not re.fullmatch(
        r"[0-9a-f]{64}", representation_sha256,
    ):
        raise HTTPException(status_code=422, detail="Document representation hash is invalid")
    idempotency_key = _idempotency_key(payload["idempotencyKey"])

    with _transaction(get_conn()) as cur:
        document_revision = _agent_anchor_document_revision(
            cur, identity, payload["documentRef"],
        )
        document_ref = document_revision["document_ref"]
        revision_id = document_revision["revision_id"]
        representation = _document_anchor_representation(
            cur, identity, revision_id, normalized_representation_id,
        )
        if representation is None or representation["content_sha256"] != representation_sha256:
            raise HTTPException(status_code=404, detail="Document representation not found")
        try:
            anchor = create_document_anchor(representation, payload["selector"])
        except DocumentAnchorContractError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        request_hash = _agent_anchor_request_hash(
            document_ref,
            {"id": normalized_representation_id, "contentSha256": representation_sha256},
            anchor["selector"],
        )
        cur.execute(
            """INSERT INTO gb_document_anchors (
                 id, tenant_id, document_revision_id, representation_id,
                 representation_sha256, selector_json, selector_kind,
                 selector_sha256, anchor_sha256, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, id) DO NOTHING
               RETURNING id""",
            (
                anchor["id"], identity.tenant_id, revision_id,
                anchor["representationId"], anchor["representationSha256"],
                psycopg2.extras.Json(anchor["selector"]), anchor["selector"]["kind"],
                anchor["selectorSha256"], anchor["anchorSha256"], identity.principal_id,
            ),
        )
        cur.fetchone()
        record = _document_anchor_record(cur, identity, anchor["id"], include_receipts=False)
        if record is None:
            raise HTTPException(status_code=409, detail={
                "code": "anchor_hash_collision", "message": "Anchor could not be reconciled",
            })
        if (
            record["document_revision_id"] != revision_id
            or record["representation_id"] != anchor["representationId"]
            or record["representation_sha256"] != anchor["representationSha256"]
            or record["selector_sha256"] != anchor["selectorSha256"]
            or record["anchor_sha256"] != anchor["anchorSha256"]
            or record["selector"] != anchor["selector"]
        ):
            raise HTTPException(status_code=409, detail={
                "code": "anchor_hash_collision", "message": "Anchor hash collision",
            })
        cur.execute(
            """INSERT INTO gb_agent_anchor_requests (
                 tenant_id, idempotency_key, request_hash, document_ref,
                 document_id, document_revision_id, document_revision_sha256,
                 representation_id, representation_sha256, anchor_id,
                 created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
               RETURNING id""",
            (
                identity.tenant_id, idempotency_key, request_hash, document_ref,
                document_revision["document_id"], revision_id,
                document_revision["revision_sha256"],
                normalized_representation_id, representation_sha256, anchor["id"],
                identity.principal_id,
            ),
        )
        inserted_request = cur.fetchone()
        replayed = inserted_request is None
        if replayed:
            cur.execute(
                """SELECT request_hash, document_ref, document_id,
                          document_revision_id, document_revision_sha256, representation_id,
                          representation_sha256, anchor_id
                     FROM gb_agent_anchor_requests
                    WHERE tenant_id = %s AND idempotency_key = %s
                    LIMIT 1""",
                (identity.tenant_id, idempotency_key),
            )
            existing = cur.fetchone()
            if (
                existing is None or existing["request_hash"] != request_hash
                or existing["document_ref"] != document_ref
                or str(existing["document_id"]) != document_revision["document_id"]
                or str(existing["document_revision_id"]) != revision_id
                or existing["document_revision_sha256"] != document_revision["revision_sha256"]
                or str(existing["representation_id"]) != normalized_representation_id
                or existing["representation_sha256"] != representation_sha256
                or existing["anchor_id"] != anchor["id"]
            ):
                raise HTTPException(status_code=409, detail={
                    "code": "idempotency_key_reused",
                    "message": "Idempotency key was already used for another anchor operation",
                })
        return _agent_anchor_receipt(
            document_ref, anchor, request_hash, replayed=replayed,
        )


@app.post("/documents/{revision_id}/anchors", status_code=201)
async def create_document_anchor_record(
    revision_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    payload = await _read_document_anchor_json(request)
    normalized_representation_id = _canonical_uuid(
        payload["representation_id"], "document representation",
    )
    with _transaction(get_conn()) as cur:
        representation = _document_anchor_representation(
            cur, identity, normalized_revision_id, normalized_representation_id,
        )
        if representation is None:
            raise HTTPException(status_code=404, detail="Document representation not found")
        try:
            anchor = create_document_anchor(representation, payload["selector"])
        except DocumentAnchorContractError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        cur.execute(
            """INSERT INTO gb_document_anchors (
                 id, tenant_id, document_revision_id, representation_id,
                 representation_sha256, selector_json, selector_kind,
                 selector_sha256, anchor_sha256, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, id) DO NOTHING
               RETURNING id""",
            (
                anchor["id"], identity.tenant_id, normalized_revision_id,
                anchor["representationId"], anchor["representationSha256"],
                psycopg2.extras.Json(anchor["selector"]), anchor["selector"]["kind"],
                anchor["selectorSha256"], anchor["anchorSha256"], identity.principal_id,
            ),
        )
        inserted = cur.fetchone()
        record = _document_anchor_record(cur, identity, anchor["id"])
        if record is None:
            raise HTTPException(status_code=409, detail="Document anchor could not be reconciled")
        if (
            record["document_revision_id"] != normalized_revision_id
            or record["representation_id"] != anchor["representationId"]
            or record["representation_sha256"] != anchor["representationSha256"]
            or record["selector_sha256"] != anchor["selectorSha256"]
            or record["anchor_sha256"] != anchor["anchorSha256"]
            or record["selector"] != anchor["selector"]
        ):
            raise HTTPException(status_code=409, detail="Document anchor hash collision")
        record["replayed"] = inserted is None
        return record


@app.get("/documents/{revision_id}/anchors/{anchor_id}/marks")
def list_document_marks(
    revision_id: str,
    anchor_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
        raise HTTPException(status_code=422, detail="Document anchor id is invalid")
    cur = get_conn().cursor()
    anchor = _document_anchor_record(cur, identity, anchor_id, include_receipts=False)
    if anchor is None or anchor["document_revision_id"] != normalized_revision_id:
        raise HTTPException(status_code=404, detail="Document anchor not found")
    cur.execute(
        """SELECT id FROM gb_document_marks
            WHERE tenant_id = %s AND document_revision_id = %s AND anchor_id = %s
              AND state <> 'deleted'
            ORDER BY created_at, id LIMIT 1000""",
        (identity.tenant_id, normalized_revision_id, anchor_id),
    )
    return {
        "schemaId": "gb.document-mark.list.v1",
        "document_revision_id": normalized_revision_id,
        "anchor_id": anchor_id,
        "marks": [
            record for record in (
                _document_mark_record(cur, identity, str(row["id"]))
                for row in cur.fetchall()
            ) if record is not None
        ],
    }


@app.post("/documents/{revision_id}/anchors/{anchor_id}/marks", status_code=201)
async def create_document_mark(
    revision_id: str,
    anchor_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_human_session_mark_mutation(request, identity)
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
        raise HTTPException(status_code=422, detail="Document anchor id is invalid")
    payload = await _read_document_mark_json(request)
    required = {
        "kind", "body_markdown", "color", "semantic_role", "tags", "state",
        "idempotency_key",
    }
    if set(payload) != required:
        raise HTTPException(status_code=422, detail="Document mark create fields are invalid")
    kind = payload["kind"]
    if not isinstance(kind, str) or kind not in MARK_KINDS:
        raise HTTPException(status_code=422, detail="Document mark kind is invalid")
    state = _document_mark_state({key: payload[key] for key in (
        "body_markdown", "color", "semantic_role", "tags", "state",
    )})
    if state["state"] != "active":
        raise HTTPException(status_code=422, detail="A new document mark must be active")
    idempotency_key = _idempotency_key(payload["idempotency_key"])
    content_hash = document_mark_content_hash(anchor_id, kind, state)
    request_value = {
        "document_revision_id": normalized_revision_id,
        "anchor_id": anchor_id,
        "kind": kind,
        **state,
    }
    request_hash = document_mark_request_hash("create", request_value)
    with _transaction(get_conn()) as cur:
        anchor = _document_anchor_record(cur, identity, anchor_id, include_receipts=False)
        if anchor is None or anchor["document_revision_id"] != normalized_revision_id:
            raise HTTPException(status_code=404, detail="Document anchor not found")
        mark_id = str(uuid4())
        mark_revision_id = str(uuid4())
        cur.execute(
            """INSERT INTO gb_document_marks (
                 id, tenant_id, document_revision_id, anchor_id, kind,
                 current_version, current_revision_id, current_content_hash,
                 body_markdown, color, semantic_role, tags, state,
                 creation_idempotency_key, creation_request_hash,
                 created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, 1, %s, %s, %s, %s, %s, %s, %s,
                         %s, %s, %s)
               ON CONFLICT (tenant_id, creation_idempotency_key) DO NOTHING
               RETURNING id""",
            (
                mark_id, identity.tenant_id, normalized_revision_id, anchor_id, kind,
                mark_revision_id, content_hash, state["body_markdown"], state["color"],
                state["semantic_role"], state["tags"], state["state"], idempotency_key,
                request_hash, identity.principal_id,
            ),
        )
        inserted = cur.fetchone()
        if inserted is None:
            cur.execute(
                """SELECT mark.id, mark.creation_request_hash,
                          revision.id AS revision_id
                     FROM gb_document_marks AS mark
                     JOIN gb_document_mark_revisions AS revision
                       ON revision.tenant_id = mark.tenant_id
                      AND revision.mark_id = mark.id
                      AND revision.version = 1
                      AND revision.idempotency_key = mark.creation_idempotency_key
                    WHERE mark.tenant_id = %s
                      AND mark.creation_idempotency_key = %s""",
                (identity.tenant_id, idempotency_key),
            )
            existing = cur.fetchone()
            if existing is None or existing["creation_request_hash"] != request_hash:
                raise HTTPException(status_code=409, detail="Document mark idempotency key was reused")
            record = _document_mark_revision_record(
                cur, identity, str(existing["id"]), str(existing["revision_id"]),
            )
            if record is None:
                raise HTTPException(status_code=409, detail="Document mark replay is incomplete")
            record["replayed"] = True
            return record
        cur.execute(
            """INSERT INTO gb_document_mark_revisions (
                 id, tenant_id, mark_id, version, content_hash, body_markdown,
                 color, semantic_role, tags, state, idempotency_key, request_hash,
                 created_by_principal_id
               ) VALUES (%s, %s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                mark_revision_id, identity.tenant_id, mark_id, content_hash,
                state["body_markdown"], state["color"], state["semantic_role"],
                state["tags"], state["state"], idempotency_key, request_hash,
                identity.principal_id,
            ),
        )
        record = _document_mark_record(cur, identity, mark_id)
        if record is None:
            raise HTTPException(status_code=409, detail="Document mark creation is incomplete")
        record["replayed"] = False
        return record


@app.get("/documents/{revision_id}/marks/{mark_id}")
def get_document_mark(
    revision_id: str,
    mark_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    normalized_mark_id = _document_mark_uuid(mark_id)
    record = _document_mark_record(get_conn().cursor(), identity, normalized_mark_id)
    if record is None or record["document_revision_id"] != normalized_revision_id:
        raise HTTPException(status_code=404, detail="Document mark not found")
    return record


@app.patch("/documents/{revision_id}/marks/{mark_id}")
async def update_document_mark(
    revision_id: str,
    mark_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    _require_human_session_mark_mutation(request, identity)
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    normalized_mark_id = _document_mark_uuid(mark_id)
    payload = await _read_document_mark_json(request)
    allowed = {
        "expected_version", "body_markdown", "color", "semantic_role", "tags",
        "state", "idempotency_key",
    }
    if (
        not set(payload).issubset(allowed)
        or not {"expected_version", "idempotency_key"}.issubset(payload)
        or len(payload) == 2
        or isinstance(payload["expected_version"], bool)
        or not isinstance(payload["expected_version"], int)
        or payload["expected_version"] < 1
    ):
        raise HTTPException(status_code=422, detail="Document mark update fields are invalid")
    idempotency_key = _idempotency_key(payload["idempotency_key"])
    request_value = {
        "mark_id": normalized_mark_id,
        "expected_version": payload["expected_version"],
        "patch": {key: payload[key] for key in sorted(set(payload) - {
            "expected_version", "idempotency_key",
        })},
    }
    request_hash = document_mark_request_hash("update", request_value)
    with _transaction(get_conn()) as cur:
        cur.execute(
            """SELECT id, mark_id, request_hash FROM gb_document_mark_revisions
                WHERE tenant_id = %s AND idempotency_key = %s""",
            (identity.tenant_id, idempotency_key),
        )
        replay = cur.fetchone()
        if replay is not None:
            if str(replay["mark_id"]) != normalized_mark_id or replay["request_hash"] != request_hash:
                raise HTTPException(status_code=409, detail="Document mark idempotency key was reused")
            record = _document_mark_revision_record(
                cur, identity, normalized_mark_id, str(replay["id"]),
            )
            if record is None or record["document_revision_id"] != normalized_revision_id:
                raise HTTPException(status_code=404, detail="Document mark not found")
            record["replayed"] = True
            return record
        cur.execute(
            """SELECT id, document_revision_id, anchor_id, kind, current_version,
                      body_markdown, color, semantic_role, tags, state
                 FROM gb_document_marks
                WHERE tenant_id = %s AND id = %s FOR UPDATE""",
            (identity.tenant_id, normalized_mark_id),
        )
        current = row_to_dict(cur.fetchone())
        if current is None or str(current["document_revision_id"]) != normalized_revision_id:
            raise HTTPException(status_code=404, detail="Document mark not found")
        # The first lookup can race a concurrent request that is blocked on the
        # same mark row. Recheck after the lock so the winner's immutable
        # acknowledgement is replayed instead of misreported as a stale write.
        cur.execute(
            """SELECT id, mark_id, request_hash FROM gb_document_mark_revisions
                WHERE tenant_id = %s AND idempotency_key = %s""",
            (identity.tenant_id, idempotency_key),
        )
        replay = cur.fetchone()
        if replay is not None:
            if str(replay["mark_id"]) != normalized_mark_id or replay["request_hash"] != request_hash:
                raise HTTPException(status_code=409, detail="Document mark idempotency key was reused")
            record = _document_mark_revision_record(
                cur, identity, normalized_mark_id, str(replay["id"]),
            )
            if record is None or record["document_revision_id"] != normalized_revision_id:
                raise HTTPException(status_code=404, detail="Document mark not found")
            record["replayed"] = True
            return record
        if int(current["current_version"]) != payload["expected_version"]:
            raise HTTPException(status_code=409, detail="Document mark version has changed")
        next_state = _document_mark_state({
            "body_markdown": payload.get("body_markdown", current["body_markdown"]),
            "color": payload.get("color", current["color"]),
            "semantic_role": payload.get("semantic_role", current["semantic_role"]),
            "tags": payload.get("tags", list(current["tags"] or [])),
            "state": payload.get("state", current["state"]),
        })
        next_version = int(current["current_version"]) + 1
        content_hash = document_mark_content_hash(current["anchor_id"], current["kind"], next_state)
        revision_row_id = str(uuid4())
        cur.execute(
            """INSERT INTO gb_document_mark_revisions (
                 id, tenant_id, mark_id, version, content_hash, body_markdown,
                 color, semantic_role, tags, state, idempotency_key, request_hash,
                 created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                revision_row_id, identity.tenant_id, normalized_mark_id, next_version,
                content_hash, next_state["body_markdown"], next_state["color"],
                next_state["semantic_role"], next_state["tags"], next_state["state"],
                idempotency_key, request_hash, identity.principal_id,
            ),
        )
        cur.execute(
            """UPDATE gb_document_marks
                  SET current_version = %s, current_revision_id = %s,
                      current_content_hash = %s, body_markdown = %s, color = %s,
                      semantic_role = %s, tags = %s, state = %s, updated_at = now()
                WHERE tenant_id = %s AND id = %s AND current_version = %s
                RETURNING id""",
            (
                next_version, revision_row_id, content_hash, next_state["body_markdown"],
                next_state["color"], next_state["semantic_role"], next_state["tags"],
                next_state["state"], identity.tenant_id, normalized_mark_id,
                payload["expected_version"],
            ),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=409, detail="Document mark version has changed")
        record = _document_mark_revision_record(
            cur, identity, normalized_mark_id, revision_row_id,
        )
        if record is None:
            raise HTTPException(status_code=409, detail="Document mark update is incomplete")
        record["replayed"] = False
        return record


@app.get("/documents/{revision_id}/anchors/{anchor_id}/backlinks")
def list_document_anchor_backlinks(
    revision_id: str,
    anchor_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", anchor_id):
        raise HTTPException(status_code=422, detail="Document anchor id is invalid")
    cur = get_conn().cursor()
    anchor = _document_anchor_record(cur, identity, anchor_id, include_receipts=False)
    if anchor is None or anchor["document_revision_id"] != normalized_revision_id:
        raise HTTPException(status_code=404, detail="Document anchor not found")
    cur.execute(
        """SELECT id FROM gb_document_marks
            WHERE tenant_id = %s AND document_revision_id = %s AND anchor_id = %s
              AND state <> 'deleted' ORDER BY created_at, id LIMIT 1000""",
        (identity.tenant_id, normalized_revision_id, anchor_id),
    )
    marks = [
        record for record in (
            _document_mark_record(cur, identity, str(row["id"])) for row in cur.fetchall()
        ) if record is not None
    ]
    subject_refs = [anchor["ref"], *(mark["ref"] for mark in marks)]
    cur.execute(
        f"""SELECT {OBJECT_LINK_COLUMNS}, 1 AS version FROM gb_object_links AS link
            WHERE tenant_id = %s
              AND (from_ref = ANY(%s) OR to_ref = ANY(%s))
              AND NOT EXISTS (
                SELECT 1 FROM gb_object_link_retractions AS correction
                 WHERE correction.tenant_id = link.tenant_id AND correction.link_id = link.id
              )
            ORDER BY created_at DESC, id DESC LIMIT 1000""",
        (identity.tenant_id, subject_refs, subject_refs),
    )
    candidates = [row_to_dict(row) for row in cur.fetchall()]
    task_candidates = []
    for link in candidates:
        try:
            endpoints = (
                parse_canonical_reference(link["from_ref"]),
                parse_canonical_reference(link["to_ref"]),
            )
        except ObjectLinkError:
            continue
        if not any(endpoint.kind == "ham.task" for endpoint in endpoints):
            continue
        task_candidates.append(link)
    access = _authorize_object_references(
        cur,
        [endpoint for link in task_candidates for endpoint in (link["from_ref"], link["to_ref"])],
        identity,
    ) if task_candidates else {}
    task_links = []
    for link in task_candidates:
        if access.get(link["from_ref"]) is not None and access.get(link["to_ref"]) is not None:
            task_links.append(link)
    return {
        "schemaId": "gb.anchor-backlinks.v1",
        "document_revision_id": normalized_revision_id,
        "anchor_id": anchor_id,
        "anchor_ref": anchor["ref"],
        "marks": marks,
        "task_links": task_links,
    }


def _execute_document_transform_attempt(
    *,
    normalized_revision_id: str,
    identity: IdentityContext,
    attempt_id: str,
    lease_token: str,
    execution_idempotency_key: str,
    request_sha256: str,
    revision_evidence: dict,
) -> dict:
    """Run one already-leased transform outside the browser request lifecycle."""
    primary_receipt_id = None
    try:
        with _transaction(get_conn()) as cur:
            revision = _document_revision_for_transform(cur, normalized_revision_id)
            if revision is None:
                raise HTTPException(status_code=409, detail="Document revision changed during transform")
        if (
            revision["original_artifact_id"] != revision_evidence["original_artifact_id"]
            or revision["content_sha256"] != revision_evidence["content_sha256"]
            or int(revision["byte_size"]) != int(revision_evidence["byte_size"])
        ):
            raise HTTPException(status_code=409, detail="Document revision changed during transform")
        raw = bytes(revision["content_bytes"] or b"")
        if len(raw) != int(revision["byte_size"]) or sha256_bytes(raw) != revision["content_sha256"]:
            raise HTTPException(status_code=409, detail="Stored original artifact hash mismatch")

        filename = revision["display_filename"]
        media_type = revision["media_type"]
        docling_result = execute_document_transform_adapter(
            DOCLING_IMPLEMENTATION_ID,
            filename=filename,
            media_type=media_type,
            content=raw,
        )
        structure = docling_result.structure
        docling_markdown = docling_result.markdown
        docling_diagnostic = docling_result.diagnostic_code

        fallback_result = None
        if structure is None and docling_markdown is None:
            fallback_implementation_id = {
                "markitdown": MARKITDOWN_IMPLEMENTATION_ID,
                "plain-text": PLAIN_TEXT_IMPLEMENTATION_ID,
            }.get(fallback_plugin_for_filename(filename))
            if fallback_implementation_id is not None:
                fallback_result = execute_document_transform_adapter(
                    fallback_implementation_id,
                    filename=filename,
                    media_type=media_type,
                    content=raw,
                )

        with _transaction(get_conn()) as cur:
            cur.execute(
                """SELECT state, lease_token FROM gb_transform_attempts
                    WHERE tenant_id = %s AND id = %s FOR UPDATE""",
                (identity.tenant_id, attempt_id),
            )
            fenced = row_to_dict(cur.fetchone())
            if not fenced or fenced["state"] != "running" or str(fenced["lease_token"]) != lease_token:
                raise HTTPException(status_code=409, detail="Document transform lease was superseded")
            current_revision = _document_revision_evidence_for_transform(cur, normalized_revision_id)
            if (
                current_revision is None
                or current_revision["content_sha256"] != revision["content_sha256"]
                or current_revision["original_artifact_id"] != revision["original_artifact_id"]
            ):
                raise HTTPException(status_code=409, detail="Document revision changed during transform")

            if structure is not None or docling_markdown is not None:
                representations = []
                structure_representation = None
                markdown_representation = None
                if structure is not None:
                    structure_representation = _insert_document_representation(
                        cur, identity, normalized_revision_id,
                        "document-structure", "application/vnd.galaxy.document-structure+json", structure,
                    )
                    representations.append(structure_representation)
                if docling_markdown is not None:
                    markdown_representation = _insert_document_representation(
                        cur, identity, normalized_revision_id,
                        "markdown", "text/markdown; charset=utf-8", docling_markdown,
                    )
                    representations.append(markdown_representation)
                primary_output = structure_representation or markdown_representation
                if primary_output is None:
                    raise HTTPException(status_code=409, detail="Document transform output is incomplete")
                primary_receipt = _insert_transform_receipt(
                    cur, identity, current_revision,
                    plugin_id=docling_result.plugin_id,
                    plugin_version=docling_result.plugin_version,
                    engine=docling_result.engine,
                    engine_version=docling_result.engine_version,
                    config=docling_result.config,
                    status=docling_result.status,
                    diagnostic_code=docling_diagnostic,
                    output_manifest=_representations_manifest(representations),
                    output_representation_id=primary_output["id"],
                    output_sha256=primary_output["content_sha256"],
                    idempotency_key=execution_idempotency_key, request_sha256=request_sha256,
                )
            else:
                fallback_receipt = None
                if fallback_result is not None:
                    if fallback_result.markdown is not None:
                        representation = _insert_document_representation(
                            cur, identity, normalized_revision_id,
                            "markdown", "text/markdown; charset=utf-8",
                            fallback_result.markdown,
                        )
                        fallback_receipt = _insert_transform_receipt(
                            cur, identity, current_revision,
                            plugin_id=fallback_result.plugin_id,
                            plugin_version=fallback_result.plugin_version,
                            engine=fallback_result.engine,
                            engine_version=fallback_result.engine_version,
                            config=fallback_result.config,
                            status="fallback", diagnostic_code=None,
                            output_manifest=_representation_manifest(representation),
                            output_representation_id=representation["id"],
                            output_sha256=representation["content_sha256"],
                        )
                    else:
                        fallback_receipt = _insert_transform_receipt(
                            cur, identity, current_revision,
                            plugin_id=fallback_result.plugin_id,
                            plugin_version=fallback_result.plugin_version,
                            engine=fallback_result.engine,
                            engine_version=fallback_result.engine_version,
                            config=fallback_result.config, status="failed",
                            diagnostic_code=fallback_result.diagnostic_code,
                            output_manifest={
                                "schemaId": "gb.transform-output-manifest.v1", "representations": [],
                            },
                        )
                primary_manifest = {
                    "schemaId": "gb.transform-output-manifest.v1",
                    "representations": [],
                    **({"fallbackReceiptId": fallback_receipt["id"]} if fallback_receipt else {}),
                }
                primary_receipt = _insert_transform_receipt(
                    cur, identity, current_revision,
                    plugin_id=docling_result.plugin_id,
                    plugin_version=docling_result.plugin_version,
                    engine=docling_result.engine,
                    engine_version=docling_result.engine_version,
                    config=docling_result.config,
                    status="failed", diagnostic_code=docling_diagnostic,
                    output_manifest=primary_manifest,
                    fallback_receipt_id=fallback_receipt["id"] if fallback_receipt else None,
                    idempotency_key=execution_idempotency_key, request_sha256=request_sha256,
                )

            cur.execute(
                """UPDATE gb_transform_attempts
                      SET state = 'finished', primary_receipt_id = %s,
                          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
                    WHERE tenant_id = %s AND id = %s AND state = 'running'
                      AND lease_token = %s""",
                (primary_receipt["id"], identity.tenant_id, attempt_id, lease_token),
            )
            if cur.rowcount != 1:
                raise HTTPException(status_code=409, detail="Document transform lease was superseded")
            primary_receipt_id = primary_receipt["id"]
    except Exception:
        _release_transform_attempt(identity, attempt_id, lease_token)
        raise
    _best_effort_materialize_transform_chunks(
        identity, normalized_revision_id, primary_receipt_id,
    )
    return _transform_response_for_receipt(
        get_conn().cursor(), identity, normalized_revision_id,
        primary_receipt_id, replayed=False,
    )


def _run_document_transform_attempt(**execution) -> None:
    """Own tenant context and bounded capacity outside the HTTP response."""
    context_token = _request_identity.set(execution["identity"])
    try:
        if not _TRANSFORM_SEMAPHORE.acquire(blocking=False):
            _release_transform_attempt(
                execution["identity"], execution["attempt_id"], execution["lease_token"],
            )
            return
        try:
            _execute_document_transform_attempt(**execution)
        except Exception:
            log.exception("background document transform failed")
        finally:
            _TRANSFORM_SEMAPHORE.release()
    finally:
        _request_identity.reset(context_token)


def _schedule_document_transform_attempt(**execution) -> None:
    """Start transform work before returning, without binding it to response delivery."""
    worker = threading.Thread(
        target=_run_document_transform_attempt,
        kwargs=execution,
        name=f"document-transform-{execution['attempt_id']}",
        daemon=True,
    )
    worker.start()


@app.post("/documents/{revision_id}/transform", status_code=201)
def transform_document_revision(
    revision_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
    response_background_tasks: BackgroundTasks = None,
):
    """Derive a representation only from an already-persisted original artifact."""
    normalized_revision_id = _canonical_uuid(revision_id, "document revision")
    idempotency_key = _idempotency_key(request.headers.get("idempotency-key", ""))
    transform_mode = request.headers.get("x-gb-transform-mode", "").strip()
    if transform_mode not in {"", "reprocess"}:
        raise HTTPException(status_code=422, detail="Invalid document transform mode")
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > 0:
                raise HTTPException(status_code=400, detail="Document transform accepts no request body")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Document transform has an invalid content length") from error

    lease_token = str(uuid4())
    attempt_id = ""
    replay_receipt_id = None
    running_response = None
    # Reconcile the durable request from small immutable metadata first. Source
    # bytes are not selected until this request owns both the lease and a
    # bounded execution slot, so replay and polling cannot amplify blob reads.
    with _transaction(get_conn()) as cur:
        revision_evidence = _document_revision_evidence_for_transform(
            cur, normalized_revision_id,
        )
        if revision_evidence is None:
            raise HTTPException(status_code=404, detail="Document revision not found")

    source_metadata = (
        revision_evidence.get("source_metadata")
        if isinstance(revision_evidence.get("source_metadata"), dict)
        else {}
    )
    try:
        transform_ingestion_plan = resolve_stored_ingestion_plan_evidence(
            source_metadata.get("ingestionPlan"),
        )
    except IngestionContractError as error:
        raise HTTPException(
            status_code=409,
            detail="Document ingestion plan evidence conflicts with its registered definition",
        ) from error
    request_sha256 = transform_request_hash(
        normalized_revision_id,
        revision_evidence["content_sha256"],
        document_transform_adapter_fingerprint(),
        transform_ingestion_plan["contentSha256"] if transform_ingestion_plan else None,
        idempotency_key if transform_mode == "reprocess" else None,
    )
    execution_idempotency_key = idempotency_key

    with _transaction(get_conn()) as cur:
        cur.execute(
            """INSERT INTO gb_transform_request_keys (
                 tenant_id, idempotency_key, request_sha256,
                 document_revision_id, created_by_principal_id
               ) VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, idempotency_key) DO NOTHING""",
            (
                identity.tenant_id, idempotency_key, request_sha256,
                normalized_revision_id, identity.principal_id,
            ),
        )
        cur.execute(
            """SELECT request_sha256 FROM gb_transform_request_keys
                WHERE tenant_id = %s AND idempotency_key = %s""",
            (identity.tenant_id, idempotency_key),
        )
        key_binding = row_to_dict(cur.fetchone())
        if key_binding is None:
            raise HTTPException(status_code=409, detail="Document transform key could not be reconciled")
        if key_binding["request_sha256"] != request_sha256:
            raise HTTPException(status_code=409, detail="Document transform idempotency key was reused")

        # Serialize one canonical transform request even when callers choose
        # different idempotency keys. The key remains a separate conflict
        # boundary, while the request hash is the work-coalescing identity.
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"{identity.tenant_id}:{request_sha256}",),
        )
        cur.execute(
            """SELECT id, idempotency_key, request_sha256, state, lease_token,
                      lease_expires_at, lease_expires_at > now() AS lease_is_active,
                      primary_receipt_id
                 FROM gb_transform_attempts
                WHERE tenant_id = %s AND request_sha256 = %s
                ORDER BY created_at, id
                LIMIT 1
                FOR UPDATE""",
            (identity.tenant_id, request_sha256),
        )
        attempt = row_to_dict(cur.fetchone())
        inserted = None
        if attempt is None:
            cur.execute(
                """INSERT INTO gb_transform_attempts (
                     tenant_id, document_revision_id, input_artifact_id, input_sha256,
                     idempotency_key, request_sha256, state, lease_token, lease_expires_at,
                     created_by_principal_id
                   ) VALUES (%s, %s, %s, %s, %s, %s, 'running', %s,
                             now() + (%s * interval '1 second'), %s)
                   ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
                   RETURNING id""",
                (
                    identity.tenant_id, normalized_revision_id,
                    revision_evidence["original_artifact_id"],
                    revision_evidence["content_sha256"], idempotency_key,
                    request_sha256, lease_token,
                    TRANSFORM_LEASE_SECONDS, identity.principal_id,
                ),
            )
            inserted = cur.fetchone()
            cur.execute(
                """SELECT id, idempotency_key, request_sha256, state, lease_token,
                          lease_expires_at, lease_expires_at > now() AS lease_is_active,
                          primary_receipt_id
                     FROM gb_transform_attempts
                    WHERE tenant_id = %s AND request_sha256 = %s
                    ORDER BY created_at, id
                    LIMIT 1
                    FOR UPDATE""",
                (identity.tenant_id, request_sha256),
            )
            attempt = row_to_dict(cur.fetchone())
        if not attempt:
            raise HTTPException(status_code=409, detail="Document transform attempt could not be reconciled")
        if attempt["request_sha256"] != request_sha256:
            raise HTTPException(status_code=409, detail="Document transform idempotency key was reused")
        attempt_id = str(attempt["id"])
        execution_idempotency_key = attempt["idempotency_key"]
        if attempt["state"] == "finished":
            replay_receipt_id = str(attempt["primary_receipt_id"])
        elif inserted is None and attempt["lease_is_active"]:
            running_response = JSONResponse(
                {
                    "schemaId": DOCUMENT_TRANSFORM_SCHEMA,
                    "persisted": True,
                    "document_revision_id": normalized_revision_id,
                    "status": "running",
                    "replayed": True,
                },
                status_code=202,
                headers={"Retry-After": "5"},
            )
        elif inserted is None:
            cur.execute(
                """UPDATE gb_transform_attempts
                      SET lease_token = %s,
                          lease_expires_at = now() + (%s * interval '1 second'),
                          attempt_count = attempt_count + 1,
                          updated_at = now()
                    WHERE tenant_id = %s AND id = %s AND state = 'running'""",
                (lease_token, TRANSFORM_LEASE_SECONDS, identity.tenant_id, attempt_id),
            )

    if replay_receipt_id is not None:
        _best_effort_materialize_transform_chunks(
            identity, normalized_revision_id, replay_receipt_id,
        )
        return _transform_response_for_receipt(
            get_conn().cursor(), identity, normalized_revision_id,
            replay_receipt_id, replayed=True,
        )
    if running_response is not None:
        return running_response

    execution = {
        "normalized_revision_id": normalized_revision_id,
        "identity": identity,
        "attempt_id": attempt_id,
        "lease_token": lease_token,
        "execution_idempotency_key": execution_idempotency_key,
        "request_sha256": request_sha256,
        "revision_evidence": revision_evidence,
    }
    # FastAPI injects this object for real HTTP requests. It is intentionally
    # used only to distinguish direct in-process calls: transform work is not
    # attached to the response's Starlette background-task lifecycle.
    if response_background_tasks is None:
        if not _TRANSFORM_SEMAPHORE.acquire(blocking=False):
            _release_transform_attempt(identity, attempt_id, lease_token)
            raise HTTPException(status_code=503, detail="Document transform capacity is temporarily full")
        try:
            return _execute_document_transform_attempt(**execution)
        finally:
            _TRANSFORM_SEMAPHORE.release()
    try:
        _schedule_document_transform_attempt(**execution)
    except RuntimeError as error:
        _release_transform_attempt(identity, attempt_id, lease_token)
        raise HTTPException(
            status_code=503, detail="Document transform worker could not be started",
        ) from error
    return JSONResponse(
        {
            "schemaId": DOCUMENT_TRANSFORM_SCHEMA,
            "persisted": True,
            "document_revision_id": normalized_revision_id,
            "status": "running",
            "replayed": False,
        },
        status_code=202,
        headers={"Retry-After": "2"},
    )


def _paper_document_bridge_request_hash(
    paper: dict,
    revision: dict,
    paper_document: dict,
    durable_request_sha256: str,
) -> str:
    return sha256_bytes(json.dumps({
        "schemaId": "gb.paper-document-bridge.request.v1",
        "paperId": str(paper["id"]),
        "paperRevisionId": str(revision["id"]),
        "paperMetadataHash": revision["metadata_hash"],
        "paperDocumentId": str(paper_document["id"]),
        "contentSha256": paper_document["content_sha256"],
        "durableRequestSha256": durable_request_sha256,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _persist_paper_document_link(
    cur,
    identity: IdentityContext,
    paper: dict,
    revision: dict,
    durable: dict,
    *,
    bridge_id: str,
    source_url: str,
    content_sha256: str,
) -> dict:
    document_ref = _pinned_object_reference(
        "document", str(durable["document_id"]), durable["revision_sha256"],
    )
    if durable.get("ref") != document_ref:
        raise HTTPException(status_code=409, detail="Durable paper document identity is inconsistent")
    link = validate_link_payload({
        "from_ref": _pinned_object_reference(
            "paper", str(paper["id"]), revision["metadata_hash"],
        ),
        "to_ref": document_ref,
        "relation": "corresponds_to",
        "basis": "imported",
        "provenance": {
            "source": "import",
            "source_system": "arxiv",
            "source_ref": source_url,
            "source_snapshot": f"sha256:{content_sha256}",
            "extractor_version": "galaxy.paper-document-bridge.v1",
            "confidence": 1.0,
        },
        "idempotency_key": f"gb.internal:paper-document-link:{bridge_id}",
    })
    return _persist_object_link(cur, identity, link)


def _bridge_paper_document(
    cur,
    identity: IdentityContext,
    paper: dict,
    revision: dict,
    paper_document: dict,
    raw: bytes,
    *,
    source_kind: str = "legacy-paper",
    ingestion_plan: Optional[dict] = None,
) -> dict:
    """Atomically create or replay the canonical identity for private paper bytes."""
    content_sha256 = sha256_bytes(raw)
    if content_sha256 != paper_document["content_sha256"]:
        raise HTTPException(status_code=409, detail="Stored paper bytes do not match their digest")
    metadata = revision["metadata"]
    try:
        arxiv_id, _ = normalize_arxiv_id(str(metadata["arxiv_id"]))
        version = int(metadata["arxiv_version"])
        title = str(metadata["title"]).strip()
    except (ArxivError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Paper revision has invalid arXiv metadata") from error
    if not title:
        raise HTTPException(status_code=422, detail="Paper revision has no title")
    versioned_arxiv_id = f"{arxiv_id}v{version}"
    source_url = f"https://arxiv.org/pdf/{versioned_arxiv_id}"
    display_filename = _ingestion_value(
        normalize_display_filename,
        title,
        paper_document["filename"],
        content_sha256,
        versioned_arxiv_id,
    )
    durable_metadata = {
        "title": title[:500],
        "originalFilename": paper_document["filename"],
        "displayFilename": display_filename,
        "mediaType": "application/pdf",
        "sourceKind": source_kind,
        "sourceUri": source_url,
        "arxivId": versioned_arxiv_id,
    }
    if ingestion_plan is not None:
        durable_metadata["ingestionPlan"] = ingestion_plan
    durable_request_sha256 = import_request_hash(durable_metadata, content_sha256)
    durable_revision_sha256 = sha256_bytes(json.dumps(
        {**durable_metadata, "contentSha256": content_sha256},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8"))
    bridge_namespace = "arxiv-fetch" if source_kind == "arxiv" else "legacy-paper"
    bridge_idempotency_key = f"gb.internal:{bridge_namespace}:{revision['id']}"
    bridge_request_sha256 = _paper_document_bridge_request_hash(
        paper, revision, paper_document, durable_request_sha256,
    )

    cur.execute(
        """SELECT id, source_id, request_sha256, content_sha256
             FROM gb_paper_document_bridges
            WHERE tenant_id = %s AND paper_revision_id = %s""",
        (identity.tenant_id, revision["id"]),
    )
    existing = cur.fetchone()
    if existing:
        if (
            existing["request_sha256"] != bridge_request_sha256
            or existing["content_sha256"] != content_sha256
        ):
            raise HTTPException(status_code=409, detail="Paper document bridge conflicts with stored evidence")
        durable = _document_import_record(cur, str(existing["source_id"]))
        if not durable:
            raise HTTPException(status_code=409, detail="Paper document bridge is incomplete")
        _persist_paper_document_link(
            cur, identity, paper, revision, durable,
            bridge_id=str(existing["id"]), source_url=source_url,
            content_sha256=content_sha256,
        )
        result = _paper_document_record(paper_document)
        result["durable_document"] = durable
        result["bridge_replayed"] = True
        result["deduplicated_artifact"] = True
        return result

    durable, original_representation_id = _persist_document_import(
        cur,
        identity,
        raw=raw,
        normalized_media_type="application/pdf",
        metadata=durable_metadata,
        idempotency_key=bridge_idempotency_key,
        request_sha256=durable_request_sha256,
        revision_sha256=durable_revision_sha256,
        source_metadata={
            "paperId": str(paper["id"]),
            "paperRevisionId": str(revision["id"]),
            "paperMetadataHash": revision["metadata_hash"],
            "arxivVersion": version,
            **({"ingestionPlan": ingestion_plan} if ingestion_plan is not None else {}),
        },
    )
    cur.execute(
        """INSERT INTO gb_paper_document_bridges (
             tenant_id, paper_document_id, paper_id, paper_revision_id, paper_metadata_hash,
             document_id, document_revision_id, document_revision_sha256,
             artifact_id, source_id, original_representation_id, content_sha256,
             idempotency_key, request_sha256, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           RETURNING id""",
        (
            identity.tenant_id, paper_document["id"], paper["id"], revision["id"],
            revision["metadata_hash"], durable["document_id"], durable["revision_id"],
            durable["revision_sha256"], durable["artifact_id"], durable["source_id"],
            original_representation_id, content_sha256, bridge_idempotency_key,
            bridge_request_sha256, identity.principal_id,
        ),
    )
    created_bridge = cur.fetchone()
    if not created_bridge:
        raise HTTPException(status_code=500, detail="Paper document bridge identity was not returned")
    _persist_paper_document_link(
        cur, identity, paper, revision, durable,
        bridge_id=str(created_bridge["id"]), source_url=source_url,
        content_sha256=content_sha256,
    )
    result = _paper_document_record(paper_document)
    result["durable_document"] = durable
    result["bridge_replayed"] = False
    result["deduplicated_artifact"] = bool(durable["deduplicatedArtifact"])
    return result


@app.get("/papers/{paper_id}")
def get_paper(paper_id: str, identity: IdentityContext = Depends(require_identity)):
    del identity
    paper = _paper_or_404(paper_id)
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_paper_revisions WHERE paper_id = %s ORDER BY arxiv_version DESC, imported_at DESC",
        (paper["id"],),
    )
    revisions = [row_to_dict(row) for row in cur.fetchall()]
    cur.execute(
        """SELECT document.id, document.paper_id, document.paper_revision_id,
                  document.media_type, document.filename, document.byte_size,
                  document.content_sha256, document.source_url, document.stored_at,
                  bridge.source_id AS bridge_source_id
             FROM gb_paper_documents AS document
             LEFT JOIN gb_paper_document_bridges AS bridge
               ON bridge.tenant_id = document.tenant_id
              AND bridge.paper_document_id = document.id
            WHERE document.paper_id = %s ORDER BY document.stored_at DESC""",
        (paper["id"],),
    )
    documents_by_revision = {}
    for document_row in cur.fetchall():
        document = _paper_document_record(document_row, cur)
        documents_by_revision[str(document["paper_revision_id"])] = document
    for revision in revisions:
        revision["document"] = documents_by_revision.get(str(revision["id"]))
    cur.execute(
        "SELECT * FROM gb_paper_annotations WHERE paper_id = %s AND deleted_at IS NULL ORDER BY page_number, created_at",
        (paper["id"],),
    )
    annotations = [row_to_dict(row) for row in cur.fetchall()]
    cur.execute("SELECT * FROM gb_paper_claims WHERE paper_id = %s ORDER BY updated_at DESC", (paper["id"],))
    claims = [row_to_dict(row) for row in cur.fetchall()]
    cur.execute(
        """SELECT link.* FROM gb_claim_evidence_links link
             JOIN gb_paper_claims claim ON claim.tenant_id = link.tenant_id AND claim.id = link.claim_id
            WHERE claim.paper_id = %s ORDER BY link.created_at""",
        (paper["id"],),
    )
    evidence_links = [row_to_dict(row) for row in cur.fetchall()]
    cur.execute("SELECT * FROM gb_paper_task_links WHERE paper_id = %s ORDER BY created_at", (paper["id"],))
    task_links = [row_to_dict(row) for row in cur.fetchall()]
    return {
        **paper,
        "revisions": revisions,
        "annotations": annotations,
        "claims": claims,
        "evidence_links": evidence_links,
        "task_links": task_links,
    }


def _store_paper_document_bytes(
    paper: dict,
    revision: dict,
    identity: IdentityContext,
    raw: bytes,
    *,
    source_kind: str = "legacy-paper",
    ingestion_plan: Optional[dict] = None,
) -> dict:
    if source_kind not in {"legacy-paper", "arxiv"}:
        raise HTTPException(status_code=500, detail="Paper document source is not registered")
    if source_kind == "arxiv" and ingestion_plan is None:
        raise HTTPException(status_code=500, detail="arXiv ingestion plan is not registered")
    if ingestion_plan is not None and ingestion_plan_expected_source_kind(ingestion_plan) != source_kind:
        raise HTTPException(status_code=422, detail="Ingestion plan does not authorize this paper source kind")
    if len(raw) < 5 or len(raw) > MAX_PAPER_DOCUMENT_BYTES or not raw.startswith(b"%PDF-"):
        raise HTTPException(status_code=422, detail="Paper document is not a bounded PDF")
    metadata = revision["metadata"]
    try:
        arxiv_id, _ = normalize_arxiv_id(str(metadata["arxiv_id"]))
        version = int(metadata["arxiv_version"])
    except (ArxivError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Paper revision has invalid arXiv metadata") from error
    source_url = f"https://arxiv.org/pdf/{arxiv_id}v{version}"
    filename = _paper_pdf_filename(metadata)
    content_sha256 = hashlib.sha256(raw).hexdigest()

    with _transaction(get_conn()) as cur:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext('gb_paper_document'), hashtext(%s))",
            (f"{identity.tenant_id}:{revision['id']}",),
        )
        cur.execute(
            """INSERT INTO gb_paper_documents (
                 tenant_id, paper_id, paper_revision_id, stored_by_principal_id,
                 media_type, filename, byte_size, content_sha256, source_url, pdf_bytes
               ) VALUES (%s, %s, %s, %s, 'application/pdf', %s, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, paper_revision_id) DO NOTHING
               RETURNING id, paper_id, paper_revision_id, media_type, filename, byte_size,
                         content_sha256, source_url, stored_at""",
            (
                identity.tenant_id, paper["id"], revision["id"], identity.principal_id,
                filename, len(raw), content_sha256, source_url, psycopg2.Binary(raw),
            ),
        )
        paper_document = row_to_dict(cur.fetchone())
        deduplicated = paper_document is None
        if paper_document is None:
            cur.execute(
                """SELECT id, paper_id, paper_revision_id, media_type, filename, byte_size,
                          content_sha256, source_url, stored_at
                     FROM gb_paper_documents
                    WHERE tenant_id = %s AND paper_revision_id = %s""",
                (identity.tenant_id, revision["id"]),
            )
            paper_document = row_to_dict(cur.fetchone())
        if not paper_document:
            raise HTTPException(status_code=409, detail="Paper document storage conflicted")
        if paper_document["content_sha256"] != content_sha256:
            raise HTTPException(
                status_code=409,
                detail="This immutable paper revision already has different PDF bytes",
            )
        bridge_source_kind = source_kind
        bridge_ingestion_plan = ingestion_plan
        if deduplicated:
            cur.execute(
                """SELECT idempotency_key FROM gb_paper_document_bridges
                    WHERE tenant_id = %s AND paper_revision_id = %s""",
                (identity.tenant_id, revision["id"]),
            )
            existing_bridge = row_to_dict(cur.fetchone())
            if existing_bridge and existing_bridge["idempotency_key"] == (
                f"gb.internal:legacy-paper:{revision['id']}"
            ):
                bridge_source_kind = "legacy-paper"
                bridge_ingestion_plan = None
            elif existing_bridge and existing_bridge["idempotency_key"] == (
                f"gb.internal:arxiv-fetch:{revision['id']}"
            ):
                bridge_source_kind = "arxiv"
                bridge_ingestion_plan = _ingestion_value(
                    resolve_ingestion_plan_claim, ARXIV_FETCH_PLAN_CLAIM,
                )
            elif existing_bridge:
                raise HTTPException(status_code=409, detail="Paper document bridge provenance is inconsistent")
        result = _bridge_paper_document(
            cur, identity, paper, revision, paper_document, raw,
            source_kind=bridge_source_kind,
            ingestion_plan=bridge_ingestion_plan,
        )
        result["deduplicated"] = deduplicated
        return result


@app.put("/papers/{paper_id}/document", status_code=201)
async def store_paper_document(
    paper_id: str,
    request: Request,
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    paper = _paper_or_404(paper_id)
    revision = _paper_revision_or_404(paper["id"], revision_id)
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/pdf":
        raise HTTPException(status_code=415, detail="Paper document must be an application/pdf body")
    declared_length = request.headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > MAX_PAPER_DOCUMENT_BYTES:
                raise HTTPException(status_code=413, detail="Paper PDF exceeds the 100 MB storage limit")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Paper document has an invalid content length") from error

    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > MAX_PAPER_DOCUMENT_BYTES:
            raise HTTPException(status_code=413, detail="Paper PDF exceeds the 100 MB storage limit")
        chunks.extend(chunk)
    return _store_paper_document_bytes(paper, revision, identity, bytes(chunks))


@app.post("/papers/{paper_id}/document/fetch", status_code=201)
async def fetch_private_arxiv_document(
    paper_id: str,
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    """Fetch one exact arXiv revision for authenticated private storage."""
    paper = _paper_or_404(paper_id)
    revision = _paper_revision_or_404(paper["id"], revision_id)
    metadata = revision["metadata"]
    try:
        arxiv_id, _ = normalize_arxiv_id(str(metadata["arxiv_id"]))
        version = int(metadata["arxiv_version"])
        ingestion_plan = _ingestion_value(
            resolve_ingestion_plan_claim, ARXIV_FETCH_PLAN_CLAIM,
        )
    except (ArxivError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Paper revision has invalid arXiv metadata") from error

    # Existing private bytes are canonical for this immutable revision. Replay
    # and repair their durable bridge without network access or provenance
    # relabelling; the locked persistence path still enforces byte identity.
    cur = get_conn().cursor()
    cur.execute(
        """SELECT pdf_bytes FROM gb_paper_documents
            WHERE tenant_id = %s AND paper_revision_id = %s""",
        (identity.tenant_id, revision["id"]),
    )
    existing = cur.fetchone()
    if existing:
        return _store_paper_document_bytes(
            paper, revision, identity, bytes(existing["pdf_bytes"]),
        )

    try:
        fetched = await run_in_threadpool(fetch_arxiv_pdf, arxiv_id, version)
    except ArxivPdfFetchError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return _store_paper_document_bytes(
        paper,
        revision,
        identity,
        fetched.content,
        source_kind="arxiv",
        ingestion_plan=ingestion_plan,
    )


@app.post("/papers/{paper_id}/document/bridge")
def bridge_stored_paper_document(
    paper_id: str,
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    """Promote already-stored exact PDF bytes without refetching their URL."""
    paper = _paper_or_404(paper_id)
    revision = _paper_revision_or_404(paper["id"], revision_id)
    with _transaction(get_conn()) as cur:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext('gb_paper_document'), hashtext(%s))",
            (f"{identity.tenant_id}:{revision['id']}",),
        )
        cur.execute(
            """SELECT id, paper_id, paper_revision_id, media_type, filename, byte_size,
                      content_sha256, source_url, stored_at, pdf_bytes
                 FROM gb_paper_documents WHERE paper_revision_id = %s""",
            (revision["id"],),
        )
        paper_document = row_to_dict(cur.fetchone())
        if not paper_document:
            raise HTTPException(status_code=404, detail="Paper revision is not stored in the private bench")
        raw = bytes(paper_document.pop("pdf_bytes"))
        result = _bridge_paper_document(cur, identity, paper, revision, paper_document, raw)
        result["deduplicated"] = True
        return result


@app.get("/papers/{paper_id}/document")
def read_paper_document(
    paper_id: str,
    request: Request,
    revision_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    paper = _paper_or_404(paper_id)
    revision = _paper_revision_or_404(paper["id"], revision_id)
    cur = get_conn().cursor()
    cur.execute(
        """SELECT filename, byte_size, content_sha256, source_url, pdf_bytes
             FROM gb_paper_documents WHERE paper_revision_id = %s""",
        (revision["id"],),
    )
    document = cur.fetchone()
    if not document:
        raise HTTPException(status_code=404, detail="Paper revision is not stored in the private bench")
    data = bytes(document["pdf_bytes"])
    byte_size = int(document["byte_size"])
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Disposition": f"inline; filename*=UTF-8''{urllib.parse.quote(document['filename'])}",
        "ETag": f'"sha256-{document["content_sha256"]}"',
        "Link": f'<{document["source_url"]}>; rel="canonical"',
    }
    try:
        selected_range = _paper_byte_range(request.headers.get("range"), byte_size)
    except HTTPException as error:
        error.headers = {"Content-Range": f"bytes */{byte_size}"}
        raise
    if selected_range is None:
        return Response(data, media_type="application/pdf", headers=headers)
    start, end = selected_range
    headers["Content-Range"] = f"bytes {start}-{end}/{byte_size}"
    return Response(data[start:end + 1], status_code=206, media_type="application/pdf", headers=headers)


@app.get("/papers/{paper_id}/download")
def download_paper(
    paper_id: str,
    revision_id: Optional[str] = None,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    paper = _paper_or_404(paper_id)
    metadata: dict = paper
    if revision_id:
        normalized_revision = _canonical_uuid(revision_id, "paper revision")
        cur = get_conn().cursor()
        cur.execute(
            "SELECT metadata FROM gb_paper_revisions WHERE id = %s AND paper_id = %s",
            (normalized_revision, paper["id"]),
        )
        revision = row_to_dict(cur.fetchone())
        if not revision:
            raise HTTPException(status_code=404, detail="Paper revision not found")
        metadata = revision["metadata"]

    try:
        arxiv_id, _ = normalize_arxiv_id(str(metadata["arxiv_id"]))
        version = int(metadata["arxiv_version"])
    except (ArxivError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail="Paper revision has invalid arXiv metadata") from error
    license_url = arxiv_pdf_redistribution_license(metadata.get("license_url"))
    if not license_url:
        raise HTTPException(
            status_code=403,
            detail="This paper revision does not declare a license that permits Galaxy Brain to serve its PDF",
        )
    url = f"https://arxiv.org/pdf/{arxiv_id}v{version}"
    request = urllib.request.Request(url, headers={
        "Accept": "application/pdf",
        "User-Agent": "GalaxyBrain/0.1 paper download",
    })
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except Exception as error:
        raise HTTPException(status_code=502, detail="The paper PDF is temporarily unavailable") from error
    content_type = response.headers.get_content_type()
    content_length = response.headers.get("Content-Length")
    if content_type != "application/pdf":
        response.close()
        raise HTTPException(status_code=502, detail="arXiv returned an unexpected paper format")
    if content_length:
        try:
            if int(content_length) > 100_000_000:
                response.close()
                raise HTTPException(status_code=413, detail="Paper PDF exceeds the 100 MB download limit")
        except ValueError:
            response.close()
            raise HTTPException(status_code=502, detail="arXiv returned an invalid paper size")

    filename = _paper_pdf_filename(metadata)
    ascii_filename = filename.encode("ascii", "ignore").decode("ascii") or "paper.pdf"
    encoded_filename = urllib.parse.quote(filename)

    def stream_pdf():
        downloaded = 0
        try:
            while chunk := response.read(64 * 1024):
                downloaded += len(chunk)
                if downloaded > 100_000_000:
                    raise RuntimeError("Paper PDF exceeds the download limit")
                yield chunk
        finally:
            response.close()

    return StreamingResponse(
        stream_pdf(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{encoded_filename}",
            "Cache-Control": "private, no-store",
            "Link": f'<https://arxiv.org/abs/{arxiv_id}v{version}>; rel="canonical", <{license_url}>; rel="license"',
            "X-Arxiv-License": license_url,
        },
    )


@app.post("/papers/{paper_id}/annotations", status_code=201)
def create_paper_annotation(
    paper_id: str,
    req: PaperAnnotationCreate,
    identity: IdentityContext = Depends(require_identity),
):
    paper = _paper_or_404(paper_id)
    if req.page_number < 1 or req.page_number > 100_000:
        raise HTTPException(status_code=422, detail="Annotation page is invalid")
    if len(req.body) > 20_000 or req.lens not in {"proof", "audit", "analysis"} or req.semantic_role not in {"claim", "evidence", "note"}:
        raise HTTPException(status_code=422, detail="Annotation classification is invalid")
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", req.color):
        raise HTTPException(status_code=422, detail="Annotation color is invalid")
    anchor = _paper_anchor(req.kind, req.anchor)
    tags = _paper_tags(req.tags)
    idempotency_key = _idempotency_key(req.idempotency_key)
    paper_revision_id = _canonical_uuid(req.paper_revision_id, "paper revision")
    cur = get_conn().cursor()
    cur.execute(
        "SELECT 1 FROM gb_paper_revisions WHERE id = %s AND paper_id = %s",
        (paper_revision_id, paper["id"]),
    )
    if not cur.fetchone():
        raise HTTPException(status_code=422, detail="Paper revision is unavailable")
    request_hash = _surface_request_hash({
        "paper_id": str(paper["id"]),
        "paper_revision_id": paper_revision_id,
        "kind": req.kind,
        "page_number": req.page_number,
        "anchor": anchor,
        "body": req.body,
        "color": req.color.lower(),
        "lens": req.lens,
        "semantic_role": req.semantic_role,
        "tags": tags,
    })
    cur.execute(
        """INSERT INTO gb_paper_annotations (
             tenant_id, paper_id, paper_revision_id, created_by_principal_id,
             kind, page_number, anchor, body, color, lens, semantic_role, tags,
             idempotency_key, request_hash
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING *""",
        (identity.tenant_id, paper["id"], paper_revision_id, identity.principal_id,
         req.kind, req.page_number, psycopg2.extras.Json(anchor), req.body,
         req.color.lower(), req.lens, req.semantic_role, tags, idempotency_key,
         request_hash),
    )
    created = row_to_dict(cur.fetchone())
    if created:
        return created
    cur.execute(
        "SELECT * FROM gb_paper_annotations WHERE idempotency_key = %s",
        (idempotency_key,),
    )
    existing = row_to_dict(cur.fetchone())
    if existing and existing["request_hash"] == request_hash:
        existing["replayed"] = True
        return existing
    raise HTTPException(status_code=409, detail="Idempotency key was reused with different annotation input")


@app.patch("/papers/{paper_id}/annotations/{annotation_id}")
def update_paper_annotation(
    paper_id: str,
    annotation_id: str,
    req: PaperAnnotationUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    paper = _paper_or_404(paper_id)
    annotation = _canonical_uuid(annotation_id, "annotation")
    if req.base_version < 1:
        raise HTTPException(status_code=422, detail="Annotation base version is invalid")
    if req.body is not None and len(req.body) > 20_000:
        raise HTTPException(status_code=422, detail="Annotation body is too large")
    if req.color is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", req.color):
        raise HTTPException(status_code=422, detail="Annotation color is invalid")
    if req.lens is not None and req.lens not in {"proof", "audit", "analysis"}:
        raise HTTPException(status_code=422, detail="Annotation lens is invalid")
    if req.semantic_role is not None and req.semantic_role not in {"claim", "evidence", "note"}:
        raise HTTPException(status_code=422, detail="Annotation semantic role is invalid")
    tags = _paper_tags(req.tags) if req.tags is not None else None
    cur = get_conn().cursor()
    cur.execute(
        """UPDATE gb_paper_annotations
              SET body = COALESCE(%s, body), color = COALESCE(%s, color),
                  lens = COALESCE(%s, lens), semantic_role = COALESCE(%s, semantic_role),
                  tags = COALESCE(%s, tags), version = version + 1, updated_at = now()
            WHERE id = %s AND paper_id = %s AND version = %s AND deleted_at IS NULL
            RETURNING *""",
        (req.body, req.color.lower() if req.color else None, req.lens, req.semantic_role,
         tags, annotation, paper["id"], req.base_version),
    )
    updated = row_to_dict(cur.fetchone())
    if not updated:
        raise HTTPException(status_code=409, detail="Annotation changed or is unavailable")
    return updated


@app.delete("/papers/{paper_id}/annotations/{annotation_id}")
def delete_paper_annotation(
    paper_id: str,
    annotation_id: str,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    paper = _paper_or_404(paper_id)
    annotation = _canonical_uuid(annotation_id, "annotation")
    with _transaction(get_conn()) as cur:
        cur.execute(
            """SELECT id FROM gb_paper_annotations
                WHERE id = %s AND paper_id = %s AND deleted_at IS NULL
                FOR UPDATE""",
            (annotation, paper["id"]),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Annotation not found")
        cur.execute(
            """SELECT EXISTS (
                 SELECT 1 FROM gb_paper_claims WHERE source_annotation_id = %s
                 UNION ALL
                 SELECT 1 FROM gb_claim_evidence_links WHERE annotation_id = %s
                 UNION ALL
                 SELECT 1 FROM gb_paper_task_links WHERE annotation_id = %s
               ) AS is_referenced""",
            (annotation, annotation, annotation),
        )
        if row_to_dict(cur.fetchone()).get("is_referenced"):
            raise HTTPException(status_code=409, detail="Annotation is referenced and cannot be deleted")
        cur.execute(
            """UPDATE gb_paper_annotations
                  SET deleted_at = now(), updated_at = now(), version = version + 1
                WHERE id = %s AND paper_id = %s AND deleted_at IS NULL
                RETURNING id""",
            (annotation, paper["id"]),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=409, detail="Annotation changed while it was being deleted")
    return {"deleted": annotation}


@app.post("/papers/{paper_id}/claims", status_code=201)
def create_paper_claim(
    paper_id: str,
    req: PaperClaimCreate,
    identity: IdentityContext = Depends(require_identity),
):
    paper = _paper_or_404(paper_id)
    statement = req.statement.strip()
    if not 1 <= len(statement) <= 20_000 or req.status not in {"open", "supported", "refuted", "mixed"}:
        raise HTTPException(status_code=422, detail="Claim is invalid")
    annotation_id = _canonical_uuid(req.source_annotation_id, "annotation") if req.source_annotation_id else None
    tags = _paper_tags(req.tags)
    key = _idempotency_key(req.idempotency_key)
    request_hash = _surface_request_hash({
        "paper_id": str(paper["id"]),
        "source_annotation_id": annotation_id,
        "statement": statement,
        "status": req.status,
        "tags": tags,
    })
    with _transaction(get_conn()) as cur:
        if annotation_id:
            cur.execute(
                """SELECT 1 FROM gb_paper_annotations
                    WHERE id = %s AND paper_id = %s AND deleted_at IS NULL
                    FOR UPDATE""",
                (annotation_id, paper["id"]),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=422, detail="Claim source annotation is unavailable")
        cur.execute(
            """INSERT INTO gb_paper_claims (
             tenant_id, paper_id, source_annotation_id, created_by_principal_id,
             statement, status, tags, idempotency_key, request_hash
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
           RETURNING *""",
            (identity.tenant_id, paper["id"], annotation_id, identity.principal_id,
             statement, req.status, tags, key, request_hash),
        )
        created = row_to_dict(cur.fetchone())
        if created:
            return created
        cur.execute("SELECT * FROM gb_paper_claims WHERE idempotency_key = %s", (key,))
        existing = row_to_dict(cur.fetchone())
        if existing and existing["request_hash"] == request_hash:
            existing["replayed"] = True
            return existing
        raise HTTPException(status_code=409, detail="Idempotency key was reused with different claim input")


@app.post("/papers/{paper_id}/claims/{claim_id}/evidence", status_code=201)
def link_claim_evidence(
    paper_id: str,
    claim_id: str,
    req: ClaimEvidenceCreate,
    identity: IdentityContext = Depends(require_identity),
):
    paper = _paper_or_404(paper_id)
    claim = _canonical_uuid(claim_id, "claim")
    annotation = _canonical_uuid(req.annotation_id, "annotation")
    if req.relation not in {"supports", "refutes", "context"}:
        raise HTTPException(status_code=422, detail="Evidence relation is invalid")
    with _transaction(get_conn()) as cur:
        cur.execute(
            """SELECT 1 FROM gb_paper_claims claim
             JOIN gb_paper_annotations annotation ON annotation.tenant_id = claim.tenant_id
            WHERE claim.id = %s AND claim.paper_id = %s
              AND annotation.id = %s AND annotation.paper_id = claim.paper_id
              AND annotation.deleted_at IS NULL
            FOR UPDATE OF annotation""",
            (claim, paper["id"], annotation),
        )
        if not cur.fetchone():
            raise HTTPException(status_code=422, detail="Claim or evidence annotation is unavailable")
        cur.execute(
            """INSERT INTO gb_claim_evidence_links
             (tenant_id, claim_id, annotation_id, relation, created_by_principal_id)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, claim_id, annotation_id) DO NOTHING
           RETURNING *""",
            (identity.tenant_id, claim, annotation, req.relation, identity.principal_id),
        )
        created = row_to_dict(cur.fetchone())
        if created:
            return created
        cur.execute(
            """SELECT * FROM gb_claim_evidence_links
                WHERE claim_id = %s AND annotation_id = %s""",
            (claim, annotation),
        )
        existing = row_to_dict(cur.fetchone())
        if existing and existing["relation"] == req.relation:
            existing["replayed"] = True
            return existing
        raise HTTPException(
            status_code=409,
            detail="Evidence relations are immutable; create a new evidence coordinate to change semantics",
        )


@app.post("/papers/{paper_id}/task-links", status_code=201)
def create_paper_task_link(
    paper_id: str,
    req: PaperTaskLinkCreate,
    identity: IdentityContext = Depends(require_identity),
):
    paper = _paper_or_404(paper_id)
    if req.relation not in {"document-task", "subtask"}:
        raise HTTPException(status_code=422, detail="Task relation is invalid")
    if req.relation == "subtask" and not req.parent_ham_task_id:
        raise HTTPException(status_code=422, detail="Subtask requires a parent HAM task")
    for value in (req.ham_task_id, req.parent_ham_task_id):
        if value is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", value):
            raise HTTPException(status_code=422, detail="HAM task identifier is invalid")
    title = req.title_snapshot.strip()
    if not 1 <= len(title) <= 200:
        raise HTTPException(status_code=422, detail="Task title snapshot is invalid")
    annotation = _canonical_uuid(req.annotation_id, "annotation") if req.annotation_id else None
    claim = _canonical_uuid(req.claim_id, "claim") if req.claim_id else None
    with _transaction(get_conn()) as cur:
        if annotation:
            cur.execute(
                """SELECT 1 FROM gb_paper_annotations
                    WHERE id = %s AND paper_id = %s AND deleted_at IS NULL
                    FOR UPDATE""",
                (annotation, paper["id"]),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=422, detail="Task annotation is unavailable")
        if claim:
            cur.execute("SELECT 1 FROM gb_paper_claims WHERE id = %s AND paper_id = %s", (claim, paper["id"]))
            if not cur.fetchone():
                raise HTTPException(status_code=422, detail="Task claim is unavailable")
        cur.execute(
            """INSERT INTO gb_paper_task_links (
             tenant_id, paper_id, annotation_id, claim_id, ham_task_id,
             parent_ham_task_id, relation, title_snapshot, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, ham_task_id) DO NOTHING
           RETURNING *""",
            (identity.tenant_id, paper["id"], annotation, claim, req.ham_task_id,
             req.parent_ham_task_id, req.relation, title, identity.principal_id),
        )
        created = row_to_dict(cur.fetchone())
        if created:
            return created
        cur.execute(
            "SELECT * FROM gb_paper_task_links WHERE ham_task_id = %s",
            (req.ham_task_id,),
        )
        existing = row_to_dict(cur.fetchone())
        expected = {
            "paper_id": str(paper["id"]),
            "annotation_id": annotation,
            "claim_id": claim,
            "parent_ham_task_id": req.parent_ham_task_id,
            "relation": req.relation,
            "title_snapshot": title,
        }
        if not existing or any(existing.get(key) != value for key, value in expected.items()):
            raise HTTPException(status_code=409, detail="HAM task link already exists with different input")
        existing["replayed"] = True
        return existing


# ---------------------------------------------------------------------------
# Endpoints — Immutable formal-project packages
# ---------------------------------------------------------------------------

@app.post("/formal-project-packages", status_code=201)
async def register_formal_project_package(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/vnd.galaxy.formal-project-package":
        raise HTTPException(status_code=415, detail="Formal project package media type is unsupported")
    envelope = await _read_formal_project_package_envelope(request)
    try:
        package = await run_in_threadpool(parse_formal_project_package_envelope, envelope)
    except FormalProjectPackageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    manifest_json = json.loads(package.manifest_bytes.decode("utf-8", "strict"))
    with _transaction(get_conn()) as cur:
        manifest_artifact_id = _insert_exact_json_artifact(
            cur,
            tenant_id=identity.tenant_id,
            principal_id=identity.principal_id,
            content=package.manifest_bytes,
            content_sha256=package.manifest_sha256,
        )
        authored_artifact_id = _insert_exact_json_artifact(
            cur,
            tenant_id=identity.tenant_id,
            principal_id=identity.principal_id,
            content=package.authored_conceptual_dag_bytes,
            content_sha256=package.authored_conceptual_dag_sha256,
        )
        correspondence_artifact_id = _insert_exact_json_artifact(
            cur,
            tenant_id=identity.tenant_id,
            principal_id=identity.principal_id,
            content=package.correspondence_bytes,
            content_sha256=package.correspondence_sha256,
        )
        _graph, _graph_replayed = _persist_passive_proof_graph(
            cur, package.proof_dag, identity,
        )
        cur.execute(
            """INSERT INTO gb_formal_project_packages (
                 tenant_id, project_id, repository, commit_oid, tree_oid,
                 lean_toolchain, mathlib_revision, conversion_profile,
                 manifest_artifact_id, manifest_sha256, manifest_json,
                 authored_dag_artifact_id, authored_dag_sha256,
                 repository_field_graph_id, repository_field_dag_sha256,
                 correspondence_artifact_id, correspondence_sha256,
                 formal_graph_sha256, repository_graph_sha256,
                 registered_by_principal_id, registered_by_nostr_pubkey
               ) VALUES (
                 %s, %s, %s, %s, %s, %s, %s, %s,
                 %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
               )
               ON CONFLICT (tenant_id, manifest_sha256) DO NOTHING
               RETURNING id""",
            (
                identity.tenant_id, package.project_id, package.repository,
                package.commit, package.tree, package.lean_toolchain,
                package.mathlib_revision, package.conversion_profile,
                manifest_artifact_id, package.manifest_sha256,
                psycopg2.extras.Json(manifest_json), authored_artifact_id,
                package.authored_conceptual_dag_sha256, package.proof_dag.graph_id,
                package.repository_field_dag_sha256, correspondence_artifact_id,
                package.correspondence_sha256, package.formal_graph.sha256,
                package.repository_graph.sha256, identity.principal_id,
                identity.nostr_pubkey,
            ),
        )
        created = cur.fetchone()
        cur.execute(
            """SELECT id, project_id, repository, commit_oid, tree_oid,
                      lean_toolchain, mathlib_revision, conversion_profile,
                      manifest_artifact_id, manifest_sha256,
                      authored_dag_artifact_id, authored_dag_sha256,
                      repository_field_graph_id, repository_field_dag_sha256,
                      correspondence_artifact_id, correspondence_sha256,
                      formal_graph_sha256, repository_graph_sha256,
                      registered_by_principal_id, registered_by_nostr_pubkey,
                      registered_at
                 FROM gb_formal_project_packages
                WHERE tenant_id = %s AND manifest_sha256 = %s""",
            (identity.tenant_id, package.manifest_sha256),
        )
        existing = cur.fetchone()
        if existing is None:
            raise HTTPException(status_code=409, detail="Formal project package could not be reconciled")
        expected = {
            "project_id": package.project_id,
            "repository": package.repository,
            "commit_oid": package.commit,
            "tree_oid": package.tree,
            "lean_toolchain": package.lean_toolchain,
            "mathlib_revision": package.mathlib_revision,
            "conversion_profile": package.conversion_profile,
            "manifest_artifact_id": manifest_artifact_id,
            "manifest_sha256": package.manifest_sha256,
            "authored_dag_artifact_id": authored_artifact_id,
            "authored_dag_sha256": package.authored_conceptual_dag_sha256,
            "repository_field_graph_id": package.proof_dag.graph_id,
            "repository_field_dag_sha256": package.repository_field_dag_sha256,
            "correspondence_artifact_id": correspondence_artifact_id,
            "correspondence_sha256": package.correspondence_sha256,
            "formal_graph_sha256": package.formal_graph.sha256,
            "repository_graph_sha256": package.repository_graph.sha256,
        }
        if any(str(existing[key]) != str(value) for key, value in expected.items()):
            raise HTTPException(status_code=409, detail="Formal project package hash collision")
        return _formal_project_package_summary(existing, replayed=created is None)


@app.get("/formal-project-packages/{manifest_sha256}")
def get_formal_project_package(
    manifest_sha256: str,
    identity: IdentityContext = Depends(require_identity),
):
    digest = _proof_value(proof_sha256, manifest_sha256, "formal project manifest_sha256")
    cur = get_conn().cursor()
    cur.execute(
        """SELECT id, project_id, repository, commit_oid, tree_oid,
                  lean_toolchain, mathlib_revision, conversion_profile,
                  manifest_sha256, authored_dag_sha256,
                  repository_field_graph_id, repository_field_dag_sha256,
                  correspondence_sha256, formal_graph_sha256,
                  repository_graph_sha256, registered_by_principal_id,
                  registered_by_nostr_pubkey, registered_at
             FROM gb_formal_project_packages
            WHERE tenant_id = %s AND manifest_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, digest),
    )
    package = cur.fetchone()
    if package is None:
        raise HTTPException(status_code=404, detail="Formal project package not found")
    return _formal_project_package_summary(package)


# ---------------------------------------------------------------------------
# Endpoints — Immutable proof graph registry
# ---------------------------------------------------------------------------

@app.get("/proof-graphs")
def list_proof_graphs(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    identity: IdentityContext = Depends(require_identity),
):
    cur = get_conn().cursor()
    cur.execute(
        """SELECT graph.id, graph.graph_id, graph.graph_kind, graph.title,
                  graph.content_sha256, artifact.byte_size,
                  target_count, relation_count, registered_by_principal_id,
                  registered_by_nostr_pubkey, registered_at
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s
            ORDER BY graph.registered_at DESC, graph.content_sha256
            LIMIT %s OFFSET %s""",
        (identity.tenant_id, limit + 1, offset),
    )
    rows = cur.fetchall()
    page = rows[:limit]
    return {
        "schemaId": "gb.proof-graph.list.v1",
        "graphs": [_proof_graph_summary(row) for row in page],
        "hasMore": len(rows) > limit,
        "nextOffset": offset + limit if len(rows) > limit else None,
    }


@app.post("/proof-graphs", status_code=201)
async def register_proof_graph(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    registration = await _read_proof_graph_registration(request)
    if registration.graph_kind != "repository-field":
        raise HTTPException(
            status_code=422,
            detail=(
                "Claimable proof graphs require server-authoritative activation; "
                "the generic registry accepts passive repository-field graphs only"
            ),
        )
    with _transaction(get_conn()) as cur:
        existing, replayed = _persist_passive_proof_graph(cur, registration, identity)
        return _proof_graph_summary(existing, replayed=replayed)


@app.get("/proof-graphs/{content_sha256}")
def get_proof_graph(
    content_sha256: str,
    identity: IdentityContext = Depends(require_identity),
):
    digest = _proof_graph_digest(content_sha256)
    cur = get_conn().cursor()
    cur.execute(
        """SELECT graph.graph_id, graph.graph_kind, graph.content_sha256,
                  artifact.content_bytes
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s AND graph.content_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, digest),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Proof graph not found")
    content = bytes(row["content_bytes"])
    if hashlib.sha256(content).hexdigest() != digest:
        raise HTTPException(status_code=409, detail="Stored proof graph hash mismatch")
    return Response(
        content,
        media_type="application/json",
        headers={
            "Cache-Control": "private, immutable",
            "ETag": f'"sha256-{digest}"',
            "X-Content-SHA256": digest,
            "X-Proof-Graph-ID": urllib.parse.quote(row["graph_id"], safe=""),
            "X-Proof-Graph-Kind": row["graph_kind"],
        },
    )


def _derive_proof_mission_candidate(
    digest: str,
    intent: dict[str, Any],
    identity: IdentityContext,
) -> dict[str, Any]:
    """Resolve and derive outside the event loop after the body is bounded."""
    cur = get_conn().cursor()
    cur.execute(
        """SELECT graph.graph_id, graph.graph_kind, graph.content_sha256,
                  artifact.content_bytes
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s AND graph.content_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, digest),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Proof graph not found")
    content = bytes(row["content_bytes"])
    if hashlib.sha256(content).hexdigest() != digest:
        raise HTTPException(status_code=409, detail="Stored proof graph hash mismatch")
    try:
        source = parse_proof_graph_bytes(content)
        if (
            source.content_sha256 != digest
            or source.graph_id != row["graph_id"]
            or source.graph_kind != row["graph_kind"]
        ):
            raise ProofMissionContractError(
                "Stored proof graph metadata does not match its exact artifact"
            )
        candidate = derive_proof_mission(source, intent)
    except (ProofGraphRegistryError, ProofMissionContractError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return candidate.envelope


@app.post("/proof-graphs/{content_sha256}/mission-candidates")
async def derive_proof_mission_candidate(
    content_sha256: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    """Derive a non-active mission from one exact tenant-owned passive graph."""
    digest = _proof_graph_digest(content_sha256)
    intent = await _read_proof_mission_intent(request)
    return await run_in_threadpool(
        _derive_proof_mission_candidate, digest, intent, identity
    )


# ---------------------------------------------------------------------------
# Endpoints — Immutable, receipt-backed proof verification baselines
# ---------------------------------------------------------------------------

@app.get("/proof-verification-sets")
def list_proof_verification_sets(
    graph_content_sha256: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    identity: IdentityContext = Depends(require_identity),
):
    params: list[Any] = [identity.tenant_id]
    graph_filter = ""
    if graph_content_sha256 is not None:
        graph_filter = " AND verification_set.graph_content_sha256 = %s"
        params.append(_proof_verification_set_digest(
            graph_content_sha256, "graph content_sha256"
        ))
    params.extend((limit + 1, offset))
    cur = get_conn().cursor()
    cur.execute(
        f"""SELECT verification_set.id, verification_set.graph_id,
                    verification_set.graph_content_sha256,
                    verification_set.content_sha256, artifact.byte_size,
                    verification_set.item_count,
                    verification_set.registered_by_principal_id,
                    verification_set.registered_by_nostr_pubkey,
                    verification_set.registered_at
               FROM gb_proof_verification_sets AS verification_set
               JOIN gb_artifacts AS artifact
                 ON artifact.tenant_id = verification_set.tenant_id
                AND artifact.id = verification_set.artifact_id
                AND artifact.content_sha256 = verification_set.content_sha256
              WHERE verification_set.tenant_id = %s{graph_filter}
              ORDER BY verification_set.registered_at DESC,
                       verification_set.content_sha256
              LIMIT %s OFFSET %s""",
        tuple(params),
    )
    rows = cur.fetchall()
    page = rows[:limit]
    return {
        "schemaId": "gb.proof-verification-set.list.v1",
        "verificationSets": [
            _proof_verification_set_summary(row) for row in page
        ],
        "hasMore": len(rows) > limit,
        "nextOffset": offset + limit if len(rows) > limit else None,
    }


@app.post("/proof-verification-sets", status_code=201)
async def register_proof_verification_set(
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    registration = await _read_proof_verification_set_registration(request)

    graph_cursor = get_conn().cursor()
    graph_cursor.execute(
        """SELECT graph.graph_kind, artifact.content_bytes
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s
              AND graph.graph_id = %s
              AND graph.content_sha256 = %s
            LIMIT 1""",
        (
            identity.tenant_id,
            registration.graph_id,
            registration.graph_content_sha256,
        ),
    )
    graph_source = graph_cursor.fetchone()
    if graph_source is None:
        raise HTTPException(status_code=404, detail="Proof graph not found")
    if graph_source["graph_kind"] != "repository-field":
        raise HTTPException(
            status_code=422,
            detail="Proof verification baselines require a passive repository-field graph",
        )
    try:
        graph_content = bytes(graph_source["content_bytes"])
        if hashlib.sha256(graph_content).hexdigest() != registration.graph_content_sha256:
            raise ProofVerificationSetError(
                "Stored proof graph hash does not match the verification set"
            )
        graph_artifact = json.loads(graph_content.decode("utf-8"))
        if not isinstance(graph_artifact, dict):
            raise ProofVerificationSetError("Stored proof graph must be a JSON object")
        accepted = await run_in_threadpool(
            _run_proof_verifier_adapters, registration, graph_artifact
        )
    except (UnicodeError, json.JSONDecodeError, ProofVerificationSetError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    with _transaction(get_conn()) as cur:
        cur.execute(
            """SELECT graph_kind
                 FROM gb_proof_graphs
                WHERE tenant_id = %s AND graph_id = %s AND content_sha256 = %s
                FOR SHARE""",
            (
                identity.tenant_id,
                registration.graph_id,
                registration.graph_content_sha256,
            ),
        )
        graph = cur.fetchone()
        if graph is None:
            raise HTTPException(status_code=404, detail="Proof graph not found")
        if graph["graph_kind"] != "repository-field":
            raise HTTPException(
                status_code=422,
                detail="Proof verification baselines require a passive repository-field graph",
            )

        cur.execute(
            """INSERT INTO gb_artifacts (
                 tenant_id, content_sha256, byte_size, media_type,
                 content_bytes, created_by_principal_id
               ) VALUES (%s, %s, %s, 'application/json', %s, %s)
               ON CONFLICT (tenant_id, content_sha256) DO NOTHING
               RETURNING id""",
            (
                identity.tenant_id,
                registration.content_sha256,
                len(registration.content_bytes),
                psycopg2.Binary(registration.content_bytes),
                identity.principal_id,
            ),
        )
        artifact = cur.fetchone()
        if artifact is None:
            cur.execute(
                """SELECT id, byte_size, media_type, content_bytes
                     FROM gb_artifacts
                    WHERE tenant_id = %s AND content_sha256 = %s""",
                (identity.tenant_id, registration.content_sha256),
            )
            artifact = cur.fetchone()
            if (
                artifact is None
                or artifact["media_type"] != "application/json"
                or bytes(artifact["content_bytes"]) != registration.content_bytes
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Proof verification set content hash collision",
                )
        artifact_id = artifact["id"]

        cur.execute(
            """INSERT INTO gb_proof_verification_sets (
                 tenant_id, graph_id, graph_content_sha256, artifact_id,
                 content_sha256, set_json, node_ids, item_count,
                 registered_by_principal_id, registered_by_nostr_pubkey
               ) VALUES (%s, %s, %s, %s, %s,
                         convert_from(%s, 'UTF8')::jsonb, %s, %s, %s, %s)
               ON CONFLICT (tenant_id, content_sha256) DO NOTHING
               RETURNING id""",
            (
                identity.tenant_id,
                registration.graph_id,
                registration.graph_content_sha256,
                artifact_id,
                registration.content_sha256,
                psycopg2.Binary(registration.content_bytes),
                [item.node_id for item in registration.items],
                len(registration.items),
                identity.principal_id,
                identity.nostr_pubkey,
            ),
        )
        created = cur.fetchone()
        verification_set_id = None if created is None else created["id"]
        if verification_set_id is None:
            cur.execute(
                """SELECT id FROM gb_proof_verification_sets
                    WHERE tenant_id = %s AND content_sha256 = %s""",
                (identity.tenant_id, registration.content_sha256),
            )
            replay = cur.fetchone()
            verification_set_id = None if replay is None else replay["id"]
        if verification_set_id is None:
            raise HTTPException(
                status_code=409,
                detail="Proof verification set registration could not be reconciled",
            )

        for item_index, item, bound, subject, adapter in accepted:
            cur.execute(
                """INSERT INTO gb_artifacts (
                     tenant_id, content_sha256, byte_size, media_type,
                     content_bytes, created_by_principal_id
                   ) VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, content_sha256) DO NOTHING
                   RETURNING id""",
                (
                    identity.tenant_id, item.receipt_sha256,
                    len(item.receipt_bytes), item.receipt_media_type,
                    psycopg2.Binary(item.receipt_bytes), identity.principal_id,
                ),
            )
            receipt_artifact = cur.fetchone()
            if receipt_artifact is None:
                cur.execute(
                    """SELECT id, media_type, content_bytes FROM gb_artifacts
                        WHERE tenant_id = %s AND content_sha256 = %s""",
                    (identity.tenant_id, item.receipt_sha256),
                )
                receipt_artifact = cur.fetchone()
                if (
                    receipt_artifact is None
                    or receipt_artifact["media_type"] != item.receipt_media_type
                    or bytes(receipt_artifact["content_bytes"]) != item.receipt_bytes
                ):
                    raise HTTPException(
                        status_code=409,
                        detail="Proof verification receipt content hash collision",
                    )
            subject_json = {
                "graph_id": subject.graph_id,
                "graph_content_sha256": subject.graph_content_sha256,
                "node_id": subject.node_id,
                "declaration_ids": list(subject.declaration_ids),
                "source_repository": subject.source_repository,
            }
            cur.execute(
                """INSERT INTO gb_proof_verification_records (
                     tenant_id, verification_set_id, verification_set_sha256,
                     item_index, node_id, candidate_sha256, receipt_artifact_id,
                     receipt_content_sha256, receipt_media_type,
                     adapter_id, adapter_version, adapter_implementation_sha256,
                     verifier_system, verification_method,
                     solution_sha256, outcome, sorry_free, subject_json,
                     source_commit, lean_toolchain, mathlib_revision, verified_at,
                     provider_run_ref
                   ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                             %s, %s, %s, %s, %s, %s, 'accepted', TRUE, %s,
                             %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, verification_set_id, node_id) DO NOTHING""",
                (
                    identity.tenant_id, verification_set_id,
                    registration.content_sha256, item_index, item.node_id,
                    item.candidate_sha256, receipt_artifact["id"],
                    item.receipt_sha256, item.receipt_media_type,
                    item.adapter_id, item.adapter_version,
                    adapter.implementation_sha256, bound.verifier_system,
                    bound.method, bound.candidate_sha256,
                    psycopg2.extras.Json(subject_json), bound.source_commit,
                    bound.lean_toolchain, bound.mathlib_revision,
                    bound.verified_at,
                    None if bound.hyades is None else psycopg2.extras.Json(bound.hyades),
                ),
            )
        cur.execute(
            """SELECT verification_set.id, verification_set.graph_id,
                      verification_set.graph_content_sha256,
                      verification_set.artifact_id,
                      verification_set.content_sha256, artifact.byte_size,
                      verification_set.item_count, verification_set.node_ids,
                      verification_set.registered_by_principal_id,
                      verification_set.registered_by_nostr_pubkey,
                      verification_set.registered_at
                 FROM gb_proof_verification_sets AS verification_set
                 JOIN gb_artifacts AS artifact
                   ON artifact.tenant_id = verification_set.tenant_id
                  AND artifact.id = verification_set.artifact_id
                  AND artifact.content_sha256 = verification_set.content_sha256
                WHERE verification_set.tenant_id = %s
                  AND verification_set.content_sha256 = %s""",
            (identity.tenant_id, registration.content_sha256),
        )
        existing = cur.fetchone()
        if existing is None:
            raise HTTPException(
                status_code=409,
                detail="Proof verification set registration could not be reconciled",
            )
        if (
            str(existing["artifact_id"]) != str(artifact_id)
            or existing["graph_id"] != registration.graph_id
            or existing["graph_content_sha256"] != registration.graph_content_sha256
            or list(existing["node_ids"]) != [item.node_id for item in registration.items]
            or existing["item_count"] != len(registration.items)
        ):
            raise HTTPException(
                status_code=409,
                detail="Proof verification set content hash collision",
            )
        return _proof_verification_set_summary(existing, replayed=created is None)


@app.get("/proof-verification-sets/{content_sha256}")
def get_proof_verification_set(
    content_sha256: str,
    identity: IdentityContext = Depends(require_identity),
):
    digest = _proof_verification_set_digest(content_sha256)
    cur = get_conn().cursor()
    cur.execute(
        """SELECT verification_set.graph_id,
                  verification_set.graph_content_sha256,
                  verification_set.content_sha256, artifact.content_bytes
             FROM gb_proof_verification_sets AS verification_set
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = verification_set.tenant_id
              AND artifact.id = verification_set.artifact_id
              AND artifact.content_sha256 = verification_set.content_sha256
            WHERE verification_set.tenant_id = %s
              AND verification_set.content_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, digest),
    )
    row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Proof verification set not found")
    content = bytes(row["content_bytes"])
    if hashlib.sha256(content).hexdigest() != digest:
        raise HTTPException(
            status_code=409, detail="Stored proof verification set hash mismatch"
        )
    return Response(
        content,
        media_type="application/json",
        headers={
            "Cache-Control": "private, immutable",
            "ETag": f'"sha256-{digest}"',
            "X-Content-SHA256": digest,
            "X-Proof-Verification-Graph-ID": urllib.parse.quote(row["graph_id"], safe=""),
            "X-Proof-Verification-Graph-SHA256": row["graph_content_sha256"],
        },
    )


def _activate_proof_mission(
    source_digest: str,
    activation_request: dict[str, Any],
    identity: IdentityContext,
) -> dict[str, Any]:
    """Recompile immutable inputs, then persist one atomic empty-baseline mission."""
    verification_ref = activation_request["verification_set_ref"]
    if verification_ref["graph_content_sha256"] != source_digest:
        raise HTTPException(
            status_code=422,
            detail="Verification baseline does not reference the selected source graph",
        )

    read_cursor = get_conn().cursor()
    read_cursor.execute(
        """SELECT graph.id, graph.graph_id, graph.graph_kind,
                  graph.content_sha256, artifact.content_bytes
             FROM gb_proof_graphs AS graph
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = graph.tenant_id
              AND artifact.id = graph.artifact_id
              AND artifact.content_sha256 = graph.content_sha256
            WHERE graph.tenant_id = %s
              AND graph.content_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, source_digest),
    )
    source_row = read_cursor.fetchone()
    if source_row is None:
        raise HTTPException(status_code=404, detail="Proof graph not found")
    if source_row["graph_kind"] != "repository-field":
        raise HTTPException(
            status_code=422,
            detail="Mission activation requires a passive repository-field source",
        )
    if source_row["graph_id"] != verification_ref["graph_id"]:
        raise HTTPException(
            status_code=422,
            detail="Verification baseline graph_id does not match the selected source",
        )

    read_cursor.execute(
        """SELECT verification_set.id, verification_set.graph_id,
                  verification_set.graph_content_sha256,
                  verification_set.content_sha256, verification_set.item_count,
                  artifact.content_bytes
             FROM gb_proof_verification_sets AS verification_set
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = verification_set.tenant_id
              AND artifact.id = verification_set.artifact_id
              AND artifact.content_sha256 = verification_set.content_sha256
            WHERE verification_set.tenant_id = %s
              AND verification_set.content_sha256 = %s
            LIMIT 1""",
        (identity.tenant_id, verification_ref["content_sha256"]),
    )
    verification_row = read_cursor.fetchone()
    if verification_row is None:
        raise HTTPException(status_code=404, detail="Proof verification baseline not found")
    if (
        verification_row["graph_id"] != source_row["graph_id"]
        or verification_row["graph_content_sha256"] != source_digest
    ):
        raise HTTPException(
            status_code=422,
            detail="Verification baseline does not match the exact mission source",
        )
    if verification_row["item_count"] != 0:
        raise HTTPException(
            status_code=422,
            detail=(
                "Non-empty proof verification baselines are not activatable yet; "
                "choose an explicit empty baseline"
            ),
        )

    source_bytes = bytes(source_row["content_bytes"])
    verification_bytes = bytes(verification_row["content_bytes"])
    if hashlib.sha256(source_bytes).hexdigest() != source_digest:
        raise HTTPException(status_code=409, detail="Stored proof graph hash mismatch")
    if (
        hashlib.sha256(verification_bytes).hexdigest()
        != verification_ref["content_sha256"]
    ):
        raise HTTPException(
            status_code=409, detail="Stored proof verification baseline hash mismatch"
        )
    try:
        plan = compile_proof_mission_activation(
            source_graph_bytes=source_bytes,
            source_graph_sha256=source_digest,
            mission_intent_bytes=activation_request["mission_intent_bytes"],
            mission_intent_sha256=activation_request["mission_intent_sha256"],
            verification_set_bytes=verification_bytes,
            verification_set_sha256=verification_ref["content_sha256"],
            verification_records=(),
        )
    except ProofMissionActivationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if (
        plan.mission_content_sha256
        != activation_request["expected_mission_content_sha256"]
    ):
        raise HTTPException(
            status_code=409,
            detail="The reviewed mission candidate is stale; derive and confirm it again",
        )

    mission_json = plan.envelope["mission_graph"]["artifact"]
    try:
        with _transaction(get_conn()) as cur:
            # Immutable rows are rechecked under shared locks after compilation,
            # so the transaction never trusts the earlier convenience reads.
            cur.execute(
                """SELECT graph.graph_id, graph.graph_kind, artifact.content_bytes
                     FROM gb_proof_graphs AS graph
                     JOIN gb_artifacts AS artifact
                       ON artifact.tenant_id = graph.tenant_id
                      AND artifact.id = graph.artifact_id
                      AND artifact.content_sha256 = graph.content_sha256
                    WHERE graph.tenant_id = %s AND graph.content_sha256 = %s
                    FOR SHARE OF graph, artifact""",
                (identity.tenant_id, source_digest),
            )
            locked_source = cur.fetchone()
            if (
                locked_source is None
                or locked_source["graph_id"] != source_row["graph_id"]
                or locked_source["graph_kind"] != "repository-field"
                or bytes(locked_source["content_bytes"]) != source_bytes
            ):
                raise HTTPException(
                    status_code=409, detail="Proof mission source changed during activation"
                )
            cur.execute(
                """SELECT verification_set.id, verification_set.graph_id,
                          verification_set.graph_content_sha256,
                          verification_set.item_count, artifact.content_bytes
                     FROM gb_proof_verification_sets AS verification_set
                     JOIN gb_artifacts AS artifact
                       ON artifact.tenant_id = verification_set.tenant_id
                      AND artifact.id = verification_set.artifact_id
                      AND artifact.content_sha256 = verification_set.content_sha256
                    WHERE verification_set.tenant_id = %s
                      AND verification_set.content_sha256 = %s
                    FOR SHARE OF verification_set, artifact""",
                (identity.tenant_id, verification_ref["content_sha256"]),
            )
            locked_verification = cur.fetchone()
            if (
                locked_verification is None
                or str(locked_verification["id"]) != str(verification_row["id"])
                or locked_verification["graph_id"] != source_row["graph_id"]
                or locked_verification["graph_content_sha256"] != source_digest
                or locked_verification["item_count"] != 0
                or bytes(locked_verification["content_bytes"]) != verification_bytes
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Proof verification baseline changed during activation",
                )

            intent_artifact_id = _insert_exact_json_artifact(
                cur,
                tenant_id=identity.tenant_id,
                principal_id=identity.principal_id,
                content=activation_request["mission_intent_bytes"],
                content_sha256=activation_request["mission_intent_sha256"],
            )
            mission_artifact_id = _insert_exact_json_artifact(
                cur,
                tenant_id=identity.tenant_id,
                principal_id=identity.principal_id,
                content=plan.mission_bytes,
                content_sha256=plan.mission_content_sha256,
            )
            cur.execute(
                """SELECT * FROM gb_activate_proof_mission(
                     %s, %s, %s, %s, %s, %s, %s, %s,
                     %s, %s, %s, %s, %s, %s, %s, %s
                   )""",
                (
                    identity.tenant_id,
                    source_row["graph_id"],
                    source_digest,
                    intent_artifact_id,
                    activation_request["mission_intent_sha256"],
                    psycopg2.extras.Json(activation_request["mission_intent"]),
                    mission_artifact_id,
                    plan.mission_content_sha256,
                    psycopg2.extras.Json(mission_json),
                    str(verification_row["id"]),
                    verification_ref["content_sha256"],
                    activation_request["workspace_id"],
                    identity.principal_id,
                    identity.nostr_pubkey,
                    activation_request["idempotency_key"],
                    activation_request["request_hash"],
                ),
            )
            activated = cur.fetchone()
            if activated is None:
                raise HTTPException(
                    status_code=409, detail="Proof mission activation returned no result"
                )
            cur.execute(
                """SELECT activation.id, activation.source_graph_id,
                          activation.source_graph_sha256,
                          activation.mission_intent_sha256,
                          activation.mission_graph_id,
                          activation.mission_graph_sha256,
                          activation.verification_set_sha256,
                          activation.workspace_key,
                          activation.inherited_verified_node_ids,
                          activation.initial_frontier_node_ids,
                          activation.activated_at,
                          workspace.current_version, workspace.updated_at,
                          (SELECT count(*)::integer
                             FROM gb_proof_work_items AS item
                            WHERE item.tenant_id = activation.tenant_id
                              AND item.workspace_id = activation.workspace_id
                          ) AS item_count,
                          graph.title, graph.target_count, graph.relation_count
                     FROM gb_proof_mission_activations AS activation
                     JOIN gb_proof_workspaces AS workspace
                       ON workspace.tenant_id = activation.tenant_id
                      AND workspace.id = activation.workspace_id
                     JOIN gb_proof_graphs AS graph
                       ON graph.tenant_id = activation.tenant_id
                      AND graph.graph_id = activation.mission_graph_id
                      AND graph.content_sha256 = activation.mission_graph_sha256
                    WHERE activation.tenant_id = %s AND activation.id = %s""",
                (identity.tenant_id, activated["activation_id"]),
            )
            persisted = cur.fetchone()
            if persisted is None:
                raise HTTPException(
                    status_code=409, detail="Proof mission activation could not be reconciled"
                )
    except HTTPException:
        raise
    except psycopg2.Error as error:
        if error.pgcode == "23505":
            raise HTTPException(
                status_code=409,
                detail="Proof mission activation conflicts with an existing activation",
            ) from error
        if error.pgcode in {"23514", "0A000"}:
            raise HTTPException(
                status_code=422, detail="Proof mission activation binding was rejected"
            ) from error
        if error.pgcode == "42501":
            raise HTTPException(
                status_code=403, detail="Proof mission activation is not authorized"
            ) from error
        logging.exception("Proof mission activation database failure")
        raise HTTPException(
            status_code=500, detail="Proof mission activation failed"
        ) from error

    record = row_to_dict(persisted)
    result = {
        "schema_id": "galaxy.proof-mission-activation-result.v1",
        "activation_id": record["id"],
        "activation_state": "active",
        "source_graph_ref": {
            "graph_id": record["source_graph_id"],
            "content_sha256": record["source_graph_sha256"],
        },
        "mission_intent_ref": {
            "content_sha256": record["mission_intent_sha256"],
        },
        "verification_set_ref": {
            "content_sha256": record["verification_set_sha256"],
        },
        "mission_graph": {
            "graph_id": record["mission_graph_id"],
            "content_sha256": record["mission_graph_sha256"],
            "title": record["title"],
            "target_count": record["target_count"],
            "relation_count": record["relation_count"],
        },
        "workspace": {
            "workspace_id": record["workspace_key"],
            "graph_ref": {
                "graph_id": record["mission_graph_id"],
                "content_sha256": record["mission_graph_sha256"],
            },
            "version": record["current_version"],
            "updated_at": record["updated_at"],
            "item_count": record["item_count"],
        },
        "inherited_verified_node_ids": list(
            record["inherited_verified_node_ids"]
        ),
        "initial_frontier_node_ids": list(record["initial_frontier_node_ids"]),
        "activated_at": record["activated_at"],
    }
    if activated["replayed"]:
        result["replayed"] = True
    return result


@app.post(
    "/proof-graphs/{content_sha256}/mission-activations",
    status_code=201,
)
async def activate_proof_mission(
    content_sha256: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    source_digest = _proof_graph_digest(content_sha256)
    activation_request = await _read_proof_mission_activation_request(request)
    return await run_in_threadpool(
        _activate_proof_mission, source_digest, activation_request, identity
    )


# ---------------------------------------------------------------------------
# Endpoints — Hash-bound proof work state
# ---------------------------------------------------------------------------

@app.get("/proof-workspaces")
def list_proof_workspaces(
    graph_id: str,
    content_sha256: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    identity: IdentityContext = Depends(require_identity),
):
    graph_ref = _proof_graph_ref({
        "graph_id": graph_id,
        "content_sha256": content_sha256,
    })
    cur = get_conn().cursor()
    cur.execute(
        """SELECT workspace.workspace_key, workspace.current_version,
                  workspace.updated_at,
                  (SELECT count(*)::integer FROM gb_proof_work_items AS item
                    WHERE item.tenant_id = workspace.tenant_id
                      AND item.workspace_id = workspace.id) AS item_count
             FROM gb_proof_workspaces AS workspace
             JOIN gb_proof_graphs AS graph
               ON graph.tenant_id = workspace.tenant_id
              AND graph.graph_id = workspace.graph_id
              AND graph.content_sha256 = workspace.graph_content_sha256
            WHERE workspace.tenant_id = %s
              AND workspace.graph_id = %s
              AND workspace.graph_content_sha256 = %s
            ORDER BY workspace.updated_at DESC, workspace.workspace_key
            LIMIT %s OFFSET %s""",
        (
            identity.tenant_id, graph_ref["graph_id"], graph_ref["content_sha256"],
            limit + 1, offset,
        ),
    )
    rows = cur.fetchall()
    page = rows[:limit]
    return {
        "schemaId": "galaxy.proof-workspace-summary-list.v1",
        "graph_ref": graph_ref,
        "workspaces": [{
            "workspace_id": row["workspace_key"],
            "version": row["current_version"],
            "updated_at": row_to_dict({"value": row["updated_at"]})["value"],
            "item_count": row["item_count"],
        } for row in page],
        "has_more": len(rows) > limit,
        "next_offset": offset + limit if len(rows) > limit else None,
    }


@app.post("/proof-workspaces", status_code=201)
def create_proof_workspace(
    req: ProofWorkspaceCreate,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    # Existing active graph rows predate the receipt-backed baseline contract.
    # Keep them readable, but fail closed for every new activation until the
    # dedicated activation endpoint can bind one exact verification set.
    raise HTTPException(
        status_code=422,
        detail=(
            "Proof workspace activation requires an explicit accepted proof baseline; "
            "mission candidates are inactive"
        ),
    )


@app.get("/proof-workspaces/{workspace_id}")
def get_proof_workspace(
    workspace_id: str,
    graph_id: str,
    content_sha256: str,
    identity: IdentityContext = Depends(require_identity),
):
    workspace = _proof_workspace_or_404(workspace_id, identity.tenant_id)
    _assert_proof_graph_ref(workspace, _proof_graph_ref({
        "graph_id": graph_id,
        "content_sha256": content_sha256,
    }))
    return _proof_state_response(workspace)


@app.get("/proof-workspaces/{workspace_id}/transitions")
def list_proof_work_transitions(
    workspace_id: str,
    graph_id: str,
    content_sha256: str,
    limit: int = 100,
    identity: IdentityContext = Depends(require_identity),
):
    workspace = _proof_workspace_or_404(workspace_id, identity.tenant_id)
    _assert_proof_graph_ref(workspace, _proof_graph_ref({
        "graph_id": graph_id,
        "content_sha256": content_sha256,
    }))
    cur = get_conn().cursor()
    cur.execute(
        """
        SELECT workspace_version, node_id, item_version, transition_type,
               transition, prior_state, next_state, actor_nostr_pubkey, created_at
          FROM gb_proof_work_transitions
         WHERE tenant_id = %s AND workspace_id = %s
         ORDER BY workspace_version DESC
         LIMIT %s
        """,
        (identity.tenant_id, workspace["id"], max(1, min(limit, 500))),
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.post("/proof-workspaces/{workspace_id}/transitions")
def transition_proof_work_item(
    workspace_id: str,
    req: ProofWorkTransition,
    identity: IdentityContext = Depends(require_identity),
):
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    workspace_key = _proof_workspace_key(workspace_id)
    graph_ref = _proof_graph_ref(req.graph_ref.model_dump())
    node_id = _proof_value(proof_identifier, req.node_id, "node_id")
    if req.expected_version < 1:
        raise HTTPException(status_code=422, detail="expected_version must be positive")
    if req.expected_item_version < 0:
        raise HTTPException(status_code=422, detail="expected_item_version cannot be negative")
    transition = _proof_value(validate_proof_transition, req.transition)
    if transition["type"] in {"proof.verify", "proof.reject"}:
        raise HTTPException(
            status_code=422,
            detail=("Proof verification requires the trusted verifier endpoint; "
                    "generic transitions cannot establish proof truth"),
        )
    if transition["type"] == "coordination.task.bind":
        raise HTTPException(
            status_code=422,
            detail=("Coordination task binding requires its dedicated trusted endpoint; "
                    "generic transitions cannot establish coordination bindings"),
        )
    idempotency = _proof_value(proof_idempotency_key, req.idempotency_key)
    request_hash = _surface_request_hash({
        "operation": "transition-proof-work-item",
        "workspace_id": workspace_key,
        "graph_ref": graph_ref,
        "node_id": node_id,
        "expected_version": req.expected_version,
        "expected_item_version": req.expected_item_version,
        "transition": transition,
    })

    with _transaction(get_conn()) as cur:
        workspace = _proof_workspace_or_404(
            workspace_key, identity.tenant_id, cur=cur, for_update=True
        )
        _assert_proof_graph_ref(workspace, graph_ref)
        replay = _proof_transition_replay(cur, str(workspace["id"]), idempotency, request_hash)
        if replay:
            return _proof_state_response(workspace, cur=cur, replayed=True)
        if workspace["current_version"] != req.expected_version:
            raise HTTPException(status_code=409, detail="Proof work expected_version is stale")
        if node_id not in workspace["node_ids"]:
            raise HTTPException(status_code=422, detail="node_id is not in the bound proof graph")

        if transition["type"] == "claim.acquire":
            cur.execute(
                """
                SELECT activation.id AS activation_id,
                       node.node_id,
                       CASE WHEN node.node_id IS NULL THEN FALSE ELSE NOT EXISTS (
                         SELECT 1
                           FROM unnest(node.prerequisite_node_ids)
                                AS prerequisite(prerequisite_node_id)
                           JOIN gb_proof_mission_activation_nodes AS prerequisite_snapshot
                             ON prerequisite_snapshot.tenant_id = activation.tenant_id
                            AND prerequisite_snapshot.activation_id = activation.id
                            AND prerequisite_snapshot.node_id = prerequisite.prerequisite_node_id
                           LEFT JOIN gb_proof_work_items AS prerequisite_item
                             ON prerequisite_item.tenant_id = activation.tenant_id
                            AND prerequisite_item.workspace_id = activation.workspace_id
                            AND prerequisite_item.node_id = prerequisite.prerequisite_node_id
                          WHERE prerequisite_snapshot.initial_proof_status <> 'verified'
                            AND COALESCE(
                              prerequisite_item.state #>> '{proof,status}', 'open'
                            ) <> 'overridden'
                            AND NOT (
                              prerequisite_item.state #>> '{proof,status}' = 'verified'
                              AND EXISTS (
                                SELECT 1
                                  FROM gb_proof_work_verifications AS verification
                                 WHERE verification.tenant_id = activation.tenant_id
                                   AND verification.workspace_id = activation.workspace_id
                                   AND verification.node_id = prerequisite.prerequisite_node_id
                                   AND verification.candidate_sha256 =
                                       prerequisite_item.state #>> '{proof,candidate_sha256}'
                              )
                            )
                       ) END AS claimable
                  FROM gb_proof_mission_activations AS activation
                  LEFT JOIN gb_proof_mission_activation_nodes AS node
                    ON node.tenant_id = activation.tenant_id
                   AND node.activation_id = activation.id
                   AND node.node_id = %s
                 WHERE activation.tenant_id = %s
                   AND activation.workspace_id = %s
                 LIMIT 1
                """,
                (node_id, identity.tenant_id, workspace["id"]),
            )
            frontier = row_to_dict(cur.fetchone())
            if not frontier:
                raise HTTPException(
                    status_code=409,
                    detail="Proof claims require an activated proof mission",
                )
            if not frontier.get("node_id"):
                raise HTTPException(
                    status_code=409,
                    detail="Activated proof mission frontier is incomplete",
                )
            if not frontier.get("claimable"):
                raise HTTPException(
                    status_code=409,
                    detail="Proof node prerequisites are not verified",
                )

        cur.execute(
            """
            SELECT * FROM gb_proof_work_items
             WHERE workspace_id = %s AND node_id = %s
             FOR UPDATE
            """,
            (workspace["id"], node_id),
        )
        current_row = row_to_dict(cur.fetchone())
        current_version = current_row["current_version"] if current_row else 0
        if current_version != req.expected_item_version:
            raise HTTPException(status_code=409, detail="Proof work expected_item_version is stale")
        current_state = dict(current_row["state"]) if current_row else None
        try:
            next_state = apply_proof_work_transition(
                current_state,
                transition,
                identity.nostr_pubkey,
                actor_principal_id=identity.principal_id,
                actor_principal_kind=identity.principal_kind,
                actor_role=identity.role,
                node_id=node_id,
                now=datetime.now(timezone.utc),
                claim_id=str(uuid4()),
            )
        except ProofWorkStateConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ProofWorkStateError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        next_item_version = current_version + 1
        next_workspace_version = workspace["current_version"] + 1
        next_state["version"] = next_item_version
        cur.execute(
            """
            INSERT INTO gb_proof_work_items (
              tenant_id, workspace_id, node_id, current_version, state,
              updated_by_principal_id, updated_by_nostr_pubkey
            ) VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, workspace_id, node_id) DO UPDATE
              SET current_version = EXCLUDED.current_version,
                  state = EXCLUDED.state,
                  updated_by_principal_id = EXCLUDED.updated_by_principal_id,
                  updated_by_nostr_pubkey = EXCLUDED.updated_by_nostr_pubkey,
                  updated_at = now()
            RETURNING id
            """,
            (
                identity.tenant_id, workspace["id"], node_id, next_item_version,
                psycopg2.extras.Json(next_state), identity.principal_id,
                identity.nostr_pubkey,
            ),
        )
        cur.execute(
            """
            UPDATE gb_proof_workspaces
               SET current_version = %s, updated_at = now()
             WHERE id = %s
            RETURNING *
            """,
            (next_workspace_version, workspace["id"]),
        )
        updated_workspace = row_to_dict(cur.fetchone())
        cur.execute(
            """
            INSERT INTO gb_proof_work_transitions (
              tenant_id, workspace_id, workspace_version, node_id, item_version,
              transition_type, transition, prior_state, next_state,
              actor_principal_id, actor_nostr_pubkey, idempotency_key, request_hash
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            (
                identity.tenant_id, workspace["id"], next_workspace_version,
                node_id, next_item_version, transition["type"],
                psycopg2.extras.Json(transition),
                psycopg2.extras.Json(current_state) if current_state is not None else None,
                psycopg2.extras.Json(next_state), identity.principal_id,
                identity.nostr_pubkey, idempotency, request_hash,
            ),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=409, detail="Proof work transition idempotency conflict")
        return _proof_state_response(updated_workspace, cur=cur)


def _coordination_binding_idempotency(root: str, binding: dict) -> str:
    encoded = json.dumps([
        root,
        binding["packet_id"],
        binding["dispatch_sequence"],
        binding["task_id"],
        binding["assignment_sha256"],
        binding["transition_sha256"],
    ], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "hyades-bind-" + hashlib.sha256(encoded).hexdigest()


@app.post("/proof-workspaces/{workspace_id}/coordination-task-bindings/bulk")
def bind_proof_coordination_tasks(
    workspace_id: str,
    req: ProofCoordinationTaskBindingBulk,
    identity: IdentityContext = Depends(require_identity),
):
    """Atomically bind one complete server-verified Hyades projection."""
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    workspace_key = _proof_workspace_key(workspace_id)
    graph_ref = _proof_graph_ref(req.graph_ref)
    if req.expected_version < 1:
        raise HTTPException(status_code=422, detail="expected_version must be positive")
    if not 1 <= len(req.bindings) <= 1_000:
        raise HTTPException(status_code=422, detail="bindings must contain 1-1000 items")
    root_idempotency = _proof_value(proof_idempotency_key, req.idempotency_key)
    normalized: list[dict] = []
    seen_nodes: set[str] = set()
    for item in req.bindings:
        node_id = _proof_value(proof_identifier, item.node_id, "node_id")
        if node_id in seen_nodes:
            raise HTTPException(status_code=422, detail="bindings contains a duplicate node_id")
        seen_nodes.add(node_id)
        if item.expected_item_version < 0:
            raise HTTPException(status_code=422, detail="expected_item_version cannot be negative")
        transition = _proof_value(validate_proof_transition, {
            "type": "coordination.task.bind",
            "payload": {"binding": item.binding},
        })
        binding = transition["payload"]["binding"]
        if binding["program_id"] != graph_ref["graph_id"] or binding["packet_id"] != node_id:
            raise HTTPException(status_code=422, detail="Hyades task binding does not match the proof graph node")
        expected_resource = (
            f"proof-packet:sha256:{graph_ref['content_sha256']}/"
            f"{graph_ref['graph_id']}/{node_id}"
        )
        if binding["resource_ref"] != expected_resource:
            raise HTTPException(status_code=422, detail="Hyades task binding resource_ref is not exact")
        normalized.append({
            "node_id": node_id,
            "expected_item_version": item.expected_item_version,
            "transition": transition,
            "binding": binding,
            "idempotency_key": _coordination_binding_idempotency(root_idempotency, binding),
        })
    request_hash = _surface_request_hash({
        "operation": "bind-proof-coordination-tasks-bulk",
        "workspace_id": workspace_key,
        "graph_ref": graph_ref,
        "expected_version": req.expected_version,
        "bindings": [{
            "node_id": item["node_id"],
            "expected_item_version": item["expected_item_version"],
            "binding": item["binding"],
        } for item in normalized],
        "idempotency_key": root_idempotency,
    })

    with _transaction(get_conn()) as cur:
        workspace = _proof_workspace_or_404(
            workspace_key, identity.tenant_id, cur=cur, for_update=True
        )
        _assert_proof_graph_ref(workspace, graph_ref)
        workspace_nodes = set(workspace["node_ids"])
        if any(item["node_id"] not in workspace_nodes for item in normalized):
            raise HTTPException(status_code=422, detail="binding node_id is not in the bound proof graph")

        prepared: list[dict] = []
        all_current = True
        for item in normalized:
            cur.execute(
                """
                SELECT * FROM gb_proof_work_items
                 WHERE workspace_id = %s AND node_id = %s
                 FOR UPDATE
                """,
                (workspace["id"], item["node_id"]),
            )
            current_row = row_to_dict(cur.fetchone())
            current_version = current_row["current_version"] if current_row else 0
            current_state = (
                dict(current_row["state"]) if current_row
                else empty_proof_work_item(item["node_id"])
            )
            current_binding = current_state.get("external", {}).get("hyades_task_binding")
            if isinstance(current_binding, dict):
                current_sequence = current_binding.get("dispatch_sequence")
                if not isinstance(current_sequence, int) or isinstance(current_sequence, bool):
                    raise HTTPException(status_code=409, detail="Stored Hyades task binding is invalid")
                if item["binding"]["dispatch_sequence"] < current_sequence:
                    raise HTTPException(status_code=409, detail="Hyades task binding dispatch_sequence is stale")
                if item["binding"]["dispatch_sequence"] == current_sequence:
                    if not same_hyades_task_binding(item["binding"], current_binding):
                        raise HTTPException(
                            status_code=409,
                            detail="Hyades task binding dispatch_sequence already names a different binding",
                        )
                    prepared.append({**item, "current": True})
                    continue
            all_current = False
            if current_version != item["expected_item_version"]:
                raise HTTPException(status_code=409, detail="Proof work expected_item_version is stale")
            try:
                next_state = apply_proof_work_transition(
                    current_state,
                    item["transition"],
                    identity.nostr_pubkey,
                    actor_principal_id=identity.principal_id,
                    actor_principal_kind=identity.principal_kind,
                    actor_role=identity.role,
                    node_id=item["node_id"],
                    now=datetime.now(timezone.utc),
                    claim_id=str(uuid4()),
                )
            except ProofWorkStateConflict as error:
                raise HTTPException(status_code=409, detail=str(error)) from error
            except ProofWorkStateError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            next_state["version"] = current_version + 1
            prepared.append({
                **item,
                "current": False,
                "current_state": current_state,
                "next_state": next_state,
                "next_item_version": current_version + 1,
            })

        if all_current:
            return {
                **_proof_state_response(workspace, cur=cur, replayed=True),
                "applied_count": 0,
                "replayed_count": len(prepared),
            }
        if workspace["current_version"] != req.expected_version:
            raise HTTPException(status_code=409, detail="Proof work expected_version is stale")

        applied = [item for item in prepared if not item["current"]]
        for ordinal, item in enumerate(applied, start=1):
            next_workspace_version = workspace["current_version"] + ordinal
            cur.execute(
                """
                INSERT INTO gb_proof_work_items (
                  tenant_id, workspace_id, node_id, current_version, state,
                  updated_by_principal_id, updated_by_nostr_pubkey
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, workspace_id, node_id) DO UPDATE
                  SET current_version = EXCLUDED.current_version,
                      state = EXCLUDED.state,
                      updated_by_principal_id = EXCLUDED.updated_by_principal_id,
                      updated_by_nostr_pubkey = EXCLUDED.updated_by_nostr_pubkey,
                      updated_at = now()
                """,
                (
                    identity.tenant_id, workspace["id"], item["node_id"],
                    item["next_item_version"], psycopg2.extras.Json(item["next_state"]),
                    identity.principal_id, identity.nostr_pubkey,
                ),
            )
            step_hash = _surface_request_hash({
                "bulk_request_hash": request_hash,
                "node_id": item["node_id"],
                "binding": item["binding"],
                "workspace_version": next_workspace_version,
            })
            cur.execute(
                """
                INSERT INTO gb_proof_work_transitions (
                  tenant_id, workspace_id, workspace_version, node_id, item_version,
                  transition_type, transition, prior_state, next_state,
                  actor_principal_id, actor_nostr_pubkey, idempotency_key, request_hash
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    identity.tenant_id, workspace["id"], next_workspace_version,
                    item["node_id"], item["next_item_version"], item["transition"]["type"],
                    psycopg2.extras.Json(item["transition"]),
                    psycopg2.extras.Json(item["current_state"]),
                    psycopg2.extras.Json(item["next_state"]), identity.principal_id,
                    identity.nostr_pubkey, item["idempotency_key"], step_hash,
                ),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=409, detail="Proof work transition idempotency conflict")

        final_workspace_version = workspace["current_version"] + len(applied)
        cur.execute(
            """
            UPDATE gb_proof_workspaces
               SET current_version = %s, updated_at = now()
             WHERE id = %s
            RETURNING *
            """,
            (final_workspace_version, workspace["id"]),
        )
        updated_workspace = row_to_dict(cur.fetchone())
        return {
            **_proof_state_response(updated_workspace, cur=cur),
            "applied_count": len(applied),
            "replayed_count": len(prepared) - len(applied),
        }


@app.post("/proof-workspaces/{workspace_id}/nodes/{node_id}/verify")
async def verify_proof_work_item(
    workspace_id: str,
    node_id: str,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    """Accept proof truth only from an authenticated, code-owned adapter.

    The request carries opaque receipt bytes and an exact graph subject. A
    Nostr-authenticated requester is not a proof verifier: the selected
    server-owned adapter must authenticate the receipt first, and only the
    separate gb_proof_verifier database authority may then append the ledger
    row and the proof.verify transition in one transaction. Hyades remains a
    disabled placeholder and fails closed before any database access.
    """
    if not identity.nostr_pubkey:
        raise HTTPException(status_code=403, detail="A verified Nostr identity is required")
    workspace_key = _proof_workspace_key(workspace_id)
    expected_node_id = _proof_value(proof_identifier, node_id, "node_id")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_TRUSTED_PROOF_VERIFICATION_REQUEST_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Trusted proof verification request exceeds 2 MiB",
            )
        chunks.append(chunk)
    try:
        parsed = await run_in_threadpool(
            parse_trusted_proof_verification_request_bytes,
            b"".join(chunks),
            allowed_adapters=(*DISABLED_HYADES_ADAPTERS, *PROOF_VERIFIER_ADAPTERS),
        )
    except TrustedProofVerificationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if parsed.item.node_id != expected_node_id:
        raise HTTPException(status_code=422, detail="Request node_id does not match the route")

    adapter = PROOF_VERIFIER_ADAPTERS.get(parsed.adapter_key)
    if adapter is None:
        raise HTTPException(
            status_code=503,
            detail="Hyades verifier adapter is disabled pending authenticated validation",
            headers={"Retry-After": "60"},
        )
    if not PROOF_VERIFIER_DB_URL:
        raise HTTPException(
            status_code=503,
            detail="Trusted proof verifier authority is not configured",
            headers={"Retry-After": "60"},
        )
    return await run_in_threadpool(
        _record_trusted_proof_verification,
        workspace_key,
        parsed,
        adapter,
        identity,
    )


def _trusted_verification_subject(cur, workspace: dict, parsed, identity) -> ExpectedProofSubject:
    """Derive the adapter subject exactly as the sealed registrar does."""
    cur.execute(
        """SELECT source_graph.graph_json AS source_graph_json,
                  mission_graph.graph_json AS mission_graph_json
             FROM gb_proof_mission_activations AS activation
             JOIN gb_proof_graphs AS source_graph
               ON source_graph.tenant_id = activation.tenant_id
              AND source_graph.graph_id = activation.source_graph_id
              AND source_graph.content_sha256 = activation.source_graph_sha256
             JOIN gb_proof_graphs AS mission_graph
               ON mission_graph.tenant_id = activation.tenant_id
              AND mission_graph.graph_id = %s
              AND mission_graph.content_sha256 = %s
            WHERE activation.tenant_id = %s
              AND activation.workspace_id = %s""",
        (
            workspace["graph_id"], workspace["graph_content_sha256"],
            identity.tenant_id, workspace["id"],
        ),
    )
    graphs = cur.fetchone()
    if (
        graphs is None
        or not isinstance(graphs["source_graph_json"], dict)
        or not isinstance(graphs["mission_graph_json"], dict)
    ):
        raise HTTPException(
            status_code=409,
            detail="Trusted proof verification requires an activated proof mission",
        )
    # The registrar binds revision provenance to the passive source graph and
    # the formal declaration binding to the activated mission target.
    subject_graph = {
        "revision": graphs["source_graph_json"].get("revision"),
        "targets": graphs["mission_graph_json"].get("targets"),
    }
    try:
        return _expected_proof_subject(parsed.registration, parsed.item, subject_graph)
    except ProofVerificationSetError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


def _insert_trusted_verification_receipt(cur, item, identity) -> str:
    cur.execute(
        """INSERT INTO gb_artifacts (
             tenant_id, content_sha256, byte_size, media_type,
             content_bytes, created_by_principal_id
           ) VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, content_sha256) DO NOTHING
           RETURNING id""",
        (
            identity.tenant_id, item.receipt_sha256, len(item.receipt_bytes),
            item.receipt_media_type, psycopg2.Binary(item.receipt_bytes),
            identity.principal_id,
        ),
    )
    receipt_artifact = cur.fetchone()
    if receipt_artifact is None:
        cur.execute(
            """SELECT id, media_type, content_bytes FROM gb_artifacts
                WHERE tenant_id = %s AND content_sha256 = %s""",
            (identity.tenant_id, item.receipt_sha256),
        )
        receipt_artifact = cur.fetchone()
        if (
            receipt_artifact is None
            or receipt_artifact["media_type"] != item.receipt_media_type
            or bytes(receipt_artifact["content_bytes"]) != item.receipt_bytes
        ):
            raise HTTPException(
                status_code=409,
                detail="Proof verification receipt content hash collision",
            )
    return str(receipt_artifact["id"])


def _record_trusted_proof_verification(workspace_key: str, parsed, adapter, identity) -> dict:
    graph_ref = parsed.registration.artifact["graph_ref"]
    node_id = parsed.item.node_id

    # Authenticate before any write. These reads use the ordinary runtime
    # connection; the verifier transaction below re-checks every version and
    # the registrar re-derives the same subject under lock.
    runtime_cur = get_conn().cursor()
    workspace = _proof_workspace_or_404(workspace_key, identity.tenant_id, cur=runtime_cur)
    _assert_proof_graph_ref(workspace, graph_ref)
    subject = _trusted_verification_subject(runtime_cur, workspace, parsed, identity)
    try:
        bound = run_trusted_verifier_adapter(
            parsed, subject, {parsed.adapter_key: adapter.verify}
        )
    except TrustedProofVerificationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        with _transaction(get_proof_verifier_conn()) as cur:
            cur.execute("SET LOCAL ROLE gb_proof_verifier")
            locked = _proof_workspace_or_404(
                workspace_key, identity.tenant_id, cur=cur, for_update=True
            )
            _assert_proof_graph_ref(locked, graph_ref)
            replay = _proof_transition_replay(
                cur, str(locked["id"]), parsed.idempotency_key, parsed.request_sha256
            )
            if replay:
                return _proof_state_response(locked, cur=cur, replayed=True)
            if locked["current_version"] != parsed.expected_workspace_version:
                raise HTTPException(
                    status_code=409, detail="Proof work expected_workspace_version is stale"
                )
            if node_id not in locked["node_ids"]:
                raise HTTPException(status_code=422, detail="node_id is not in the bound proof graph")

            cur.execute(
                """
                SELECT * FROM gb_proof_work_items
                 WHERE workspace_id = %s AND node_id = %s
                 FOR UPDATE
                """,
                (locked["id"], node_id),
            )
            current_row = row_to_dict(cur.fetchone())
            current_version = current_row["current_version"] if current_row else 0
            if current_version != parsed.expected_item_version:
                raise HTTPException(
                    status_code=409, detail="Proof work expected_item_version is stale"
                )
            if current_row is None:
                raise HTTPException(
                    status_code=409,
                    detail="Trusted proof verification requires the current candidate",
                )
            current_state = dict(current_row["state"])

            receipt_artifact_id = _insert_trusted_verification_receipt(
                cur, parsed.item, identity
            )
            cur.execute(
                """SELECT * FROM gb_record_accepted_proof_verification(
                     %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                     %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                   )""",
                (
                    identity.tenant_id, locked["id"], node_id, bound.candidate_sha256,
                    receipt_artifact_id, bound.receipt_sha256,
                    parsed.item.receipt_media_type, bound.adapter_id,
                    bound.adapter_version, adapter.implementation_sha256,
                    bound.verifier_system, bound.method, bound.candidate_sha256,
                    list(bound.subject_declaration_ids), bound.source_repository,
                    bound.source_commit, bound.lean_toolchain,
                    bound.mathlib_revision, bound.verified_at,
                    None if bound.hyades is None else psycopg2.extras.Json(bound.hyades),
                    identity.principal_id, identity.nostr_pubkey,
                    parsed.idempotency_key, parsed.request_sha256,
                ),
            )
            recorded = cur.fetchone()
            if recorded is None:
                raise HTTPException(
                    status_code=409, detail="Trusted proof verification returned no result"
                )

            transition = validate_proof_transition({
                "type": "proof.verify",
                "payload": {
                    "verification": {
                        "method": bound.method,
                        "receipt_id": str(recorded["verification_id"]),
                        "receipt_sha256": bound.receipt_sha256,
                        "outcome": "accepted",
                        "solution_sha256": bound.candidate_sha256,
                        "source_commit": bound.source_commit,
                        "lean_toolchain": bound.lean_toolchain,
                        "mathlib_revision": bound.mathlib_revision,
                        "sorry_free": True,
                        "verified_at": bound.verified_at,
                        "hyades": bound.hyades,
                    },
                },
            })
            try:
                next_state = apply_proof_work_transition(
                    current_state,
                    transition,
                    identity.nostr_pubkey,
                    actor_principal_id=identity.principal_id,
                    actor_principal_kind=identity.principal_kind,
                    actor_role=identity.role,
                    node_id=node_id,
                    now=datetime.now(timezone.utc),
                    claim_id=str(uuid4()),
                )
            except ProofWorkStateConflict as error:
                raise HTTPException(status_code=409, detail=str(error)) from error
            except ProofWorkStateError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error

            next_item_version = current_version + 1
            next_workspace_version = locked["current_version"] + 1
            next_state["version"] = next_item_version
            cur.execute(
                """
                UPDATE gb_proof_work_items
                   SET current_version = %s,
                       state = %s,
                       updated_by_principal_id = %s,
                       updated_by_nostr_pubkey = %s,
                       updated_at = now()
                 WHERE tenant_id = %s AND workspace_id = %s AND node_id = %s
                RETURNING id
                """,
                (
                    next_item_version, psycopg2.extras.Json(next_state),
                    identity.principal_id, identity.nostr_pubkey,
                    identity.tenant_id, locked["id"], node_id,
                ),
            )
            if cur.fetchone() is None:
                raise HTTPException(
                    status_code=409, detail="Proof work item could not be reconciled"
                )
            cur.execute(
                """
                UPDATE gb_proof_workspaces
                   SET current_version = %s, updated_at = now()
                 WHERE id = %s
                RETURNING *
                """,
                (next_workspace_version, locked["id"]),
            )
            updated_workspace = row_to_dict(cur.fetchone())
            cur.execute(
                """
                INSERT INTO gb_proof_work_transitions (
                  tenant_id, workspace_id, workspace_version, node_id, item_version,
                  transition_type, transition, prior_state, next_state,
                  actor_principal_id, actor_nostr_pubkey, idempotency_key, request_hash
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING id
                """,
                (
                    identity.tenant_id, locked["id"], next_workspace_version,
                    node_id, next_item_version, transition["type"],
                    psycopg2.extras.Json(transition),
                    psycopg2.extras.Json(current_state),
                    psycopg2.extras.Json(next_state), identity.principal_id,
                    identity.nostr_pubkey, parsed.idempotency_key,
                    parsed.request_sha256,
                ),
            )
            if cur.fetchone() is None:
                raise HTTPException(
                    status_code=409, detail="Proof work transition idempotency conflict"
                )
            return _proof_state_response(updated_workspace, cur=cur)
    except HTTPException:
        raise
    except psycopg2.Error as error:
        if error.pgcode == "23505":
            raise HTTPException(
                status_code=409,
                detail="Trusted proof verification conflicts with an existing verification",
            ) from error
        if error.pgcode == "23514":
            raise HTTPException(
                status_code=422, detail="Trusted proof verification binding was rejected"
            ) from error
        if error.pgcode == "0A000":
            raise HTTPException(
                status_code=503,
                detail="Trusted proof verifier adapter is not enabled",
                headers={"Retry-After": "60"},
            ) from error
        if error.pgcode == "42501":
            raise HTTPException(
                status_code=403, detail="Trusted proof verification is not authorized"
            ) from error
        logging.exception("Trusted proof verification database failure")
        raise HTTPException(
            status_code=500, detail="Trusted proof verification failed"
        ) from error


# ---------------------------------------------------------------------------
# Endpoints — Versioned task construction plans
# ---------------------------------------------------------------------------

@app.get("/task-plans")
def list_task_plans(
    ham_task_id: Optional[str] = None,
    limit: int = 50,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    conditions: list[str] = []
    params: list[Any] = []
    if ham_task_id is not None:
        conditions.append("ham_task_id = %s")
        params.append(_ham_task_id(ham_task_id))
    params.append(max(1, min(limit, 200)))
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    cur = get_conn().cursor()
    cur.execute(
        f"SELECT * FROM gb_task_plans {where} ORDER BY updated_at DESC LIMIT %s",
        params,
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.post("/task-plans", status_code=201)
def create_task_plan(req: TaskPlanCreate, identity: IdentityContext = Depends(require_identity)):
    ham_task_id = _ham_task_id(req.ham_task_id)
    title = _task_plan_title(req.title)
    spec = _task_plan_spec(req.spec)
    if spec["task"]["id"] != ham_task_id:
        raise HTTPException(status_code=422, detail="Task plan reference does not match ham_task_id")
    idempotency_key = _idempotency_key(req.idempotency_key)
    provenance = _surface_provenance(req.provenance, identity, "task-plan-created")
    request_hash = _surface_request_hash({
        "operation": "create-task-plan",
        "ham_task_id": ham_task_id,
        "title": title,
        "spec": spec,
        "provenance": req.provenance,
    })
    content_hash = _task_plan_hash(title, spec, provenance)
    with _transaction(get_conn()) as cur:
        cur.execute(
            """
            INSERT INTO gb_task_plans (
              tenant_id, ham_task_id, created_by_principal_id, title,
              schema_version, current_content_hash, current_spec, provenance,
              creation_idempotency_key, creation_request_hash
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING *
            """,
            (
                identity.tenant_id, ham_task_id, identity.principal_id, title,
                TASK_PLAN_SCHEMA, content_hash, psycopg2.extras.Json(spec),
                psycopg2.extras.Json(provenance), idempotency_key, request_hash,
            ),
        )
        created = row_to_dict(cur.fetchone())
        if not created:
            cur.execute(
                "SELECT * FROM gb_task_plans WHERE creation_idempotency_key = %s OR ham_task_id = %s FOR UPDATE",
                (idempotency_key, ham_task_id),
            )
            existing = row_to_dict(cur.fetchone())
            if (
                not existing
                or existing["creation_idempotency_key"] != idempotency_key
                or existing["creation_request_hash"] != request_hash
            ):
                raise HTTPException(status_code=409, detail="A task plan already exists for this HAM task")
            existing["replayed"] = True
            return existing
        cur.execute(
            """
            INSERT INTO gb_task_plan_revisions (
              tenant_id, task_plan_id, version, title, schema_version,
              content_hash, spec, provenance, idempotency_key, request_hash,
              created_by_principal_id
            ) VALUES (%s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            (
                identity.tenant_id, created["id"], title, TASK_PLAN_SCHEMA,
                content_hash, psycopg2.extras.Json(spec), psycopg2.extras.Json(provenance),
                idempotency_key, request_hash, identity.principal_id,
            ),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
        return created


@app.get("/task-plans/{task_plan_id}/revisions")
def list_task_plan_revisions(
    task_plan_id: str,
    limit: int = 100,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    normalized_id = _task_plan_uuid(task_plan_id)
    _get_task_plan_or_404(normalized_id)
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_task_plan_revisions WHERE task_plan_id = %s ORDER BY version DESC LIMIT %s",
        (normalized_id, max(1, min(limit, 200))),
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.get("/task-plans/{task_plan_id}/revisions/{version}")
def get_task_plan_revision(
    task_plan_id: str,
    version: int,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    normalized_id = _task_plan_uuid(task_plan_id)
    if version < 1:
        raise HTTPException(status_code=422, detail="Task plan revision must be positive")
    _get_task_plan_or_404(normalized_id)
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_task_plan_revisions WHERE task_plan_id = %s AND version = %s",
        (normalized_id, version),
    )
    revision = row_to_dict(cur.fetchone())
    if revision is None:
        raise HTTPException(status_code=404, detail="Task plan revision not found")
    return revision


@app.post("/task-plans/{task_plan_id}/dispatch-intents", status_code=201)
def reserve_task_plan_dispatch_intent(
    task_plan_id: str,
    req: TaskPlanDispatchIntentCreate,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_id = _task_plan_uuid(task_plan_id)
    ham_task_id = _ham_task_id(req.ham_task_id)
    idempotency_key = _idempotency_key(req.idempotency_key)
    if req.expected_plan_version < 1 or req.expected_task_version < 1:
        raise HTTPException(status_code=422, detail="Dispatch intent versions must be positive")
    if not re.fullmatch(r"[0-9a-f]{64}", req.expected_content_hash):
        raise HTTPException(status_code=422, detail="Dispatch intent content hash is invalid")
    request_hash = _surface_request_hash({
        "task_plan_id": normalized_id,
        "task_plan_version": req.expected_plan_version,
        "task_plan_content_hash": req.expected_content_hash,
        "ham_task_id": ham_task_id,
        "expected_task_version": req.expected_task_version,
    })
    with _transaction(get_conn()) as cur:
        cur.execute(
            "SELECT * FROM gb_task_plan_dispatch_intents WHERE idempotency_key = %s FOR UPDATE",
            (idempotency_key,),
        )
        replay = row_to_dict(cur.fetchone())
        if replay is not None:
            if (
                replay["request_hash"] != request_hash
                or str(replay["task_plan_id"]) != normalized_id
                or str(replay["requested_by_principal_id"]) != identity.principal_id
            ):
                raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
            replay["replayed"] = True
            return replay

        cur.execute("SELECT * FROM gb_task_plans WHERE id = %s FOR UPDATE", (normalized_id,))
        current = row_to_dict(cur.fetchone())
        if current is None:
            raise HTTPException(status_code=404, detail="Task plan not found")
        if str(current["created_by_principal_id"]) != identity.principal_id:
            raise HTTPException(status_code=403, detail="Only the saved plan author may reserve its dispatch")
        if (
            current["ham_task_id"] != ham_task_id
            or current["current_version"] != req.expected_plan_version
            or current["current_content_hash"] != req.expected_content_hash
        ):
            raise HTTPException(status_code=409, detail="Saved plan revision changed; reload before starting")
        cur.execute(
            """
            INSERT INTO gb_task_plan_dispatch_intents (
              tenant_id, task_plan_id, task_plan_version, task_plan_content_hash,
              ham_task_id, expected_task_version, requested_by_principal_id,
              idempotency_key, request_hash
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
            RETURNING *
            """,
            (
                identity.tenant_id, normalized_id, req.expected_plan_version,
                req.expected_content_hash, ham_task_id, req.expected_task_version,
                identity.principal_id, idempotency_key, request_hash,
            ),
        )
        reserved = row_to_dict(cur.fetchone())
        if reserved is None:
            cur.execute(
                "SELECT * FROM gb_task_plan_dispatch_intents WHERE idempotency_key = %s FOR UPDATE",
                (idempotency_key,),
            )
            reserved = row_to_dict(cur.fetchone())
            if (
                reserved is None
                or reserved["request_hash"] != request_hash
                or str(reserved["task_plan_id"]) != normalized_id
                or str(reserved["requested_by_principal_id"]) != identity.principal_id
            ):
                raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
            reserved["replayed"] = True
        return reserved


@app.get("/task-plans/{task_plan_id}")
def get_task_plan(task_plan_id: str, identity: IdentityContext = Depends(require_identity)):
    del identity
    return _get_task_plan_or_404(task_plan_id)


@app.post("/task-plans/{task_plan_id}/proposals")
def propose_task_plan_structure(
    task_plan_id: str,
    req: TaskPlanProposalCreate,
    request: Request,
    identity: IdentityContext = Depends(require_identity),
):
    """Calculate an exact-base additive proposal without persisting it."""
    if not secrets.compare_digest(
        request.headers.get("X-GB-Agent-Tool-Gateway", ""), "v1",
    ):
        raise HTTPException(status_code=404, detail="Not found")
    normalized_id = _task_plan_uuid(task_plan_id)
    raw_intent = req.model_dump()
    try:
        intent = validate_task_plan_proposal_intent(raw_intent)
    except TaskPlanProposalError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_task_plan_proposal", "message": "Task plan proposal is invalid"},
        ) from error

    cur = get_conn().cursor()
    cur.execute("SELECT * FROM gb_task_plans WHERE id = %s", (normalized_id,))
    plan = row_to_dict(cur.fetchone())
    if plan is None:
        raise HTTPException(status_code=404, detail="Task plan not found")
    try:
        proposal = build_task_plan_proposal(normalized_id, plan, intent)
    except TaskPlanProposalError as error:
        stale = "stale" in str(error) or "does not match" in str(error)
        raise HTTPException(
            status_code=409 if stale else 422,
            detail={
                "code": "stale_task_plan" if stale else "invalid_task_plan_proposal",
                "message": "Task plan changed; reload before proposing" if stale else "Task plan proposal is invalid",
            },
        ) from error

    references = proposal_input_references(intent)
    if references:
        access = _authorize_object_references(cur, references, identity)
        if any(access.get(reference) is None for reference in references):
            raise HTTPException(status_code=404, detail="An input reference was not found or is not readable")
    return proposal


@app.patch("/task-plans/{task_plan_id}")
def update_task_plan(
    task_plan_id: str,
    req: TaskPlanUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_id = _task_plan_uuid(task_plan_id)
    if req.base_version < 1:
        raise HTTPException(status_code=422, detail="Task plan base version must be positive")
    title = _task_plan_title(req.title) if req.title is not None else None
    spec = _task_plan_spec(req.spec)
    idempotency_key = _idempotency_key(req.idempotency_key)
    request_hash = _surface_request_hash({
        "operation": "update-task-plan",
        "task_plan_id": normalized_id,
        "base_version": req.base_version,
        "base_content_hash": req.base_content_hash,
        "title": title,
        "spec": spec,
        "provenance": req.provenance,
    })
    with _transaction(get_conn()) as cur:
        replayed = _replayed_task_plan(cur, normalized_id, idempotency_key, request_hash)
        if replayed:
            return replayed

        cur.execute("SELECT * FROM gb_task_plans WHERE id = %s FOR UPDATE", (normalized_id,))
        current = row_to_dict(cur.fetchone())
        if not current:
            raise HTTPException(status_code=404, detail="Task plan not found")
        replayed = _replayed_task_plan(
            cur, normalized_id, idempotency_key, request_hash, current=current
        )
        if replayed:
            return replayed
        if current["current_version"] != req.base_version:
            raise HTTPException(status_code=409, detail="Task plan base version is stale")
        if req.base_content_hash is not None and current["current_content_hash"] != req.base_content_hash:
            raise HTTPException(status_code=409, detail="Task plan base content hash is stale")
        if spec["task"]["id"] != current["ham_task_id"]:
            raise HTTPException(status_code=422, detail="Task plan reference cannot be changed")
        next_title = title if title is not None else current["title"]
        provenance = _surface_provenance(req.provenance, identity, "task-plan-revised")
        content_hash = _task_plan_hash(next_title, spec, provenance)
        next_version = current["current_version"] + 1
        cur.execute(
            """
            UPDATE gb_task_plans
               SET title = %s, current_version = %s, current_content_hash = %s,
                   current_spec = %s, provenance = %s, updated_at = now()
             WHERE id = %s
            RETURNING *
            """,
            (
                next_title, next_version, content_hash, psycopg2.extras.Json(spec),
                psycopg2.extras.Json(provenance), normalized_id,
            ),
        )
        updated = row_to_dict(cur.fetchone())
        cur.execute(
            """
            INSERT INTO gb_task_plan_revisions (
              tenant_id, task_plan_id, version, title, schema_version,
              content_hash, spec, provenance, idempotency_key, request_hash,
              created_by_principal_id
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            (
                identity.tenant_id, normalized_id, next_version, next_title,
                TASK_PLAN_SCHEMA, content_hash, psycopg2.extras.Json(spec),
                psycopg2.extras.Json(provenance), idempotency_key, request_hash,
                identity.principal_id,
            ),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
        return updated


# ---------------------------------------------------------------------------
# Endpoints — Bounded generative surfaces
# ---------------------------------------------------------------------------

_EXPERIMENT_STATUSES = frozenset({"hypothesis", "running", "complete", "abandoned"})
_HYPOTHESIS_STATUSES = frozenset({"open", "confirmed", "refuted", "superseded"})


def _binding_projection(kind: str, source: dict, identity: IdentityContext) -> dict:
    try:
        source = validate_binding_source(source)
    except SurfaceContractError as error:
        raise SurfaceBindingError(str(error)) from error
    if source["kind"] != kind:
        raise SurfaceBindingError("binding source kind does not match its projection")
    if kind == "galaxy.ham.task":
        raise SurfaceBindingError("HAM task bindings require the external task projection")
    table = "gb_experiments" if kind == "galaxy.eln.experiment" else "gb_hypotheses"
    statuses = _EXPERIMENT_STATUSES if kind == "galaxy.eln.experiment" else _HYPOTHESIS_STATUSES
    resource_id = source.get("resourceId")
    if resource_id is not None:
        query = {"resource_id": resource_id}
    else:
        query = source["query"]

    conditions = ["tenant_id = %s"]
    params: List[Any] = [identity.tenant_id]
    if "resource_id" in query:
        conditions.append("id = %s")
        params.append(query["resource_id"])
    status = query.get("status")
    if status is not None:
        if status not in statuses:
            raise SurfaceBindingError("binding query status is invalid")
        conditions.append("status = %s")
        params.append(status)
    domain = query.get("domain")
    if domain is not None:
        if not isinstance(domain, str) or not domain or len(domain) > 120:
            raise SurfaceBindingError("binding query domain is invalid")
        conditions.append("domain = %s")
        params.append(domain)
    aggregate = query.get("aggregate")
    if aggregate is not None and aggregate != "status":
        raise SurfaceBindingError("binding aggregate is invalid")
    raw_limit = query.get("limit", 100)
    if not isinstance(raw_limit, int) or isinstance(raw_limit, bool):
        raise SurfaceBindingError("binding query limit is invalid")
    limit = max(1, min(raw_limit, 500))

    cur = get_conn().cursor()
    if aggregate == "status":
        cur.execute(
            f"SELECT status, count(*)::int AS count, max(updated_at) AS updated_at "
            f"FROM {table} WHERE {' AND '.join(conditions)} GROUP BY status ORDER BY status",
            params,
        )
        rows = [row_to_dict(row) for row in cur.fetchall()]
        return {
            "value": [
                {"key": row["status"], "label": row["status"].replace("_", " ").title(), "value": row["count"]}
                for row in rows
            ] or [{"key": "none", "label": "No matching records", "value": 0}],
            "source_ids": [],
            "source_revisions": [row["updated_at"] for row in rows if row.get("updated_at")],
            "freshness": "live",
        }

    if kind == "galaxy.eln.experiment":
        projection = "id, title, status, hypothesis, results, conclusion, domain, tags, updated_at"
    else:
        projection = "id, claim, status, confidence, domain, updated_at"
    cur.execute(
        f"SELECT {projection} FROM {table} WHERE {' AND '.join(conditions)} ORDER BY updated_at DESC LIMIT %s",
        (*params, limit),
    )
    rows = [row_to_dict(row) for row in cur.fetchall()]
    if resource_id is not None and not rows:
        raise SurfaceBindingError("binding resource is unavailable")
    projected_rows = [{key: value for key, value in row.items() if key != "updated_at"} for row in rows]
    value: Any = projected_rows[0] if resource_id is not None else projected_rows
    return {
        "value": value,
        "source_ids": [str(row["id"]) for row in rows],
        "source_revisions": [row["updated_at"] for row in rows if row.get("updated_at")],
        "freshness": "live",
    }

@app.get("/surfaces")
def list_surfaces(
    status: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    if status is not None and status not in {"draft", "promoted", "archived"}:
        raise HTTPException(status_code=422, detail="Invalid surface status")
    bounded_limit = max(1, min(limit, 200))
    cur = get_conn().cursor()
    conditions = ["deleted_at IS NULL"]
    params: List[Any] = []
    if status:
        conditions.append("status = %s")
        params.append(status)
    query = q.strip() if q is not None else ""
    if len(query) > 240:
        raise HTTPException(status_code=422, detail="Surface search is too long")
    if query:
        conditions.append("position(lower(%s) in lower(title)) > 0")
        params.append(query)
    params.append(bounded_limit)
    cur.execute(
        f"SELECT * FROM gb_surfaces WHERE {' AND '.join(conditions)} ORDER BY updated_at DESC LIMIT %s",
        params,
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.post("/surfaces", status_code=201)
def create_surface(req: SurfaceCreate, identity: IdentityContext = Depends(require_identity)):
    title = _surface_title(req.title)
    spec = _surface_spec(req.spec)
    idempotency_key = _idempotency_key(req.idempotency_key)
    request_hash = _surface_request_hash(
        {"operation": "create", "title": title, "spec": spec, "provenance": req.provenance}
    )
    replayed = _replayed_surface(idempotency_key, request_hash)
    if replayed:
        return replayed
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_surfaces WHERE creation_idempotency_key = %s",
        (idempotency_key,),
    )
    existing = row_to_dict(cur.fetchone())
    if existing:
        if existing["creation_request_hash"] != request_hash:
            raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
        replayed = _replayed_surface(idempotency_key, request_hash)
        if replayed:
            return replayed
        raise HTTPException(status_code=409, detail="Surface creation receipt is unavailable")

    provenance = _surface_provenance(req.provenance, identity, "created")
    content_hash = _surface_content_hash(title, "draft", spec, provenance)
    cur.execute(
        """
        WITH created AS (
          INSERT INTO gb_surfaces (
            tenant_id, created_by_principal_id, title, status,
            schema_version, schema_digest, catalog_id, catalog_version,
            catalog_digest, renderer_version,
            current_content_hash, current_spec, provenance,
            creation_idempotency_key, creation_request_hash
          ) VALUES (%s, %s, %s, 'draft', %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s)
          ON CONFLICT (tenant_id, creation_idempotency_key) DO NOTHING
          RETURNING *
        ), revision AS (
          INSERT INTO gb_surface_revisions (
            tenant_id, surface_id, version, title, status, content_hash,
            schema_digest, catalog_digest, renderer_version,
            spec, provenance, idempotency_key, request_hash, created_by_principal_id
          )
          SELECT tenant_id, id, 1, title, status, current_content_hash,
                 schema_digest, catalog_digest, renderer_version,
                 current_spec, provenance, creation_idempotency_key,
                 creation_request_hash, created_by_principal_id
          FROM created
          RETURNING id
        )
        SELECT * FROM created
        """,
        (
            identity.tenant_id,
            identity.principal_id,
            title,
            SURFACE_SCHEMA,
            SCHEMA_DIGEST,
            CATALOG_ID,
            CATALOG_VERSION,
            CATALOG_DIGEST,
            RENDERER_VERSION,
            content_hash,
            psycopg2.extras.Json(spec),
            psycopg2.extras.Json(provenance),
            idempotency_key,
            request_hash,
        ),
    )
    created = row_to_dict(cur.fetchone())
    if created:
        return created

    cur.execute(
        "SELECT * FROM gb_surfaces WHERE creation_idempotency_key = %s",
        (idempotency_key,),
    )
    raced = row_to_dict(cur.fetchone())
    if raced and raced["creation_request_hash"] == request_hash:
        replayed = _replayed_surface(idempotency_key, request_hash)
        if replayed:
            return replayed
        raise HTTPException(status_code=409, detail="Surface creation receipt is unavailable")
    raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")


@app.get("/surfaces/contract")
def get_surface_contract(identity: IdentityContext = Depends(require_identity)):
    del identity
    return get_surface_contract_manifest()


@app.get("/surfaces/{surface_id}")
def get_surface(surface_id: str, identity: IdentityContext = Depends(require_identity)):
    del identity
    return _get_surface_or_404(surface_id)


@app.get("/surfaces/{surface_id}/revisions")
def list_surface_revisions(
    surface_id: str,
    limit: int = 100,
    version: Optional[int] = None,
    identity: IdentityContext = Depends(require_identity),
):
    del identity
    normalized_id = _surface_uuid(surface_id)
    _get_surface_or_404(normalized_id)
    cur = get_conn().cursor()
    if version is not None:
        if version < 1:
            raise HTTPException(status_code=422, detail="Surface revision must be positive")
        cur.execute(
            "SELECT * FROM gb_surface_revisions WHERE surface_id = %s AND version = %s",
            (normalized_id, version),
        )
        revision = row_to_dict(cur.fetchone())
        return [] if not revision else [revision]
    cur.execute(
        """
        SELECT * FROM gb_surface_revisions
        WHERE surface_id = %s
        ORDER BY version DESC
        LIMIT %s
        """,
        (normalized_id, max(1, min(limit, 200))),
    )
    return [row_to_dict(row) for row in cur.fetchall()]


@app.get("/surfaces/{surface_id}/resolve")
def resolve_surface(
    surface_id: str,
    version: Optional[int] = None,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_id = _surface_uuid(surface_id)
    surface = _get_surface_or_404(normalized_id)
    spec = surface["current_spec"]
    resolved_version = surface["current_version"]
    content_hash = surface["current_content_hash"]
    schema_digest = surface["schema_digest"]
    catalog_digest = surface["catalog_digest"]
    renderer_version = surface["renderer_version"]
    if version is not None:
        if version < 1:
            raise HTTPException(status_code=422, detail="Surface revision must be positive")
        cur = get_conn().cursor()
        cur.execute(
            """SELECT version, spec, content_hash, schema_digest, catalog_digest, renderer_version
                 FROM gb_surface_revisions
                WHERE surface_id = %s AND version = %s""",
            (normalized_id, version),
        )
        revision = row_to_dict(cur.fetchone())
        if not revision:
            raise HTTPException(status_code=404, detail="Surface revision not found")
        spec = revision["spec"]
        resolved_version = revision["version"]
        content_hash = revision["content_hash"]
        schema_digest = revision["schema_digest"]
        catalog_digest = revision["catalog_digest"]
        renderer_version = revision["renderer_version"]
    result = resolve_surface_bindings(
        spec,
        lambda kind, source: _binding_projection(kind, source, identity),
    )
    return {
        "surface_id": normalized_id,
        "version": resolved_version,
        "definition_content_hash": content_hash,
        "schema_digest": schema_digest,
        "catalog_digest": catalog_digest,
        "renderer_version": renderer_version,
        **result,
    }


def _replayed_surface(idempotency_key: str, request_hash: str) -> Optional[dict]:
    cur = get_conn().cursor()
    cur.execute(
        "SELECT * FROM gb_surface_revisions WHERE idempotency_key = %s",
        (idempotency_key,),
    )
    revision = row_to_dict(cur.fetchone())
    if not revision:
        return None
    if revision["request_hash"] != request_hash:
        raise HTTPException(status_code=409, detail="Idempotency key was reused with different input")
    surface = _get_surface_or_404(str(revision["surface_id"]))
    surface["replayed"] = True
    # The mutable surface row may have advanced arbitrarily far since this
    # operation first succeeded. Bind every replay response to the exact
    # immutable ledger entry that matched the idempotency key instead of
    # asking callers to infer a receipt from the current head.
    surface["replayed_revision"] = {
        key: revision[key]
        for key in (
            "tenant_id",
            "surface_id",
            "version",
            "title",
            "status",
            "content_hash",
            "schema_digest",
            "catalog_digest",
            "renderer_version",
            "spec",
            "provenance",
            "idempotency_key",
            "request_hash",
        )
    }
    return surface


@app.patch("/surfaces/{surface_id}")
def update_surface(
    surface_id: str,
    req: SurfaceUpdate,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_id = _surface_uuid(surface_id)
    idempotency_key = _idempotency_key(req.idempotency_key)
    if req.base_version < 1:
        raise HTTPException(status_code=422, detail="Surface base version must be positive")
    if req.spec is not None and req.patch is not None:
        raise HTTPException(status_code=422, detail="Provide either spec or patch, not both")
    if req.title is None and req.spec is None and req.patch is None:
        raise HTTPException(status_code=422, detail="Surface update does not contain a change")
    explicit_title = _surface_title(req.title) if req.title is not None else None
    explicit_spec = _surface_spec(req.spec) if req.spec is not None else None

    if req.patch is not None:
        if not req.base_content_hash:
            raise HTTPException(
                status_code=422,
                detail="Patch updates require the base content hash",
            )
        request_hash = _surface_request_hash(
            {
                "operation": "patch",
                "surface_id": normalized_id,
                "base_version": req.base_version,
                "base_content_hash": req.base_content_hash,
                "title": explicit_title,
                "patch": req.patch,
                "provenance": req.provenance,
            }
        )
    else:
        request_input = {
            "operation": "update",
            "surface_id": normalized_id,
            "base_version": req.base_version,
            "title": explicit_title,
            "spec": explicit_spec,
            "provenance": req.provenance,
        }
        if req.base_content_hash is not None:
            request_input["base_content_hash"] = req.base_content_hash
        request_hash = _surface_request_hash(request_input)

    replayed = _replayed_surface(idempotency_key, request_hash)
    if replayed:
        return replayed

    current = _get_surface_or_404(normalized_id)
    if current["current_version"] != req.base_version:
        raise HTTPException(status_code=409, detail="Surface base version is stale")
    if current["status"] != "draft":
        raise HTTPException(status_code=409, detail="Only draft surfaces can be updated")
    if (
        req.base_content_hash is not None
        and current["current_content_hash"] != req.base_content_hash
    ):
        raise HTTPException(status_code=409, detail="Surface base content hash is stale")

    title = explicit_title if explicit_title is not None else current["title"]
    if req.patch is not None:
        try:
            patched_spec = apply_json_patch(current["current_spec"], req.patch)
        except JsonPatchError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        spec = _surface_spec(patched_spec)
        provenance_event = "patched"
    else:
        spec = explicit_spec if explicit_spec is not None else current["current_spec"]
        provenance_event = "updated"

    if req.patch is not None or explicit_spec is not None:
        schema_digest = SCHEMA_DIGEST
        catalog_digest = CATALOG_DIGEST
        renderer_version = RENDERER_VERSION
    else:
        # Metadata-only revisions preserve the definition's existing contract
        # identity. Only a spec that passes the active validator may adopt the
        # active schema, catalog, and renderer fingerprints.
        schema_digest = current["schema_digest"]
        catalog_digest = current["catalog_digest"]
        renderer_version = current["renderer_version"]

    provenance = _surface_provenance(req.provenance, identity, provenance_event)
    content_hash = _surface_content_hash(title, "draft", spec, provenance)
    cur = get_conn().cursor()
    cur.execute(
        """
        WITH updated AS (
          UPDATE gb_surfaces
          SET title = %s, current_spec = %s, provenance = %s,
              current_content_hash = %s, current_version = current_version + 1,
              schema_digest = %s, catalog_digest = %s, renderer_version = %s,
              updated_at = now()
          WHERE id = %s AND current_version = %s AND status = 'draft' AND deleted_at IS NULL
          RETURNING *
        ), revision AS (
          INSERT INTO gb_surface_revisions (
            tenant_id, surface_id, version, title, status, content_hash,
            schema_digest, catalog_digest, renderer_version,
            spec, provenance, idempotency_key, request_hash, created_by_principal_id
          )
          SELECT tenant_id, id, current_version, title, status, current_content_hash,
                 schema_digest, catalog_digest, renderer_version,
                 current_spec, provenance, %s, %s, %s
          FROM updated
          RETURNING id
        )
        SELECT * FROM updated
        """,
        (
            title,
            psycopg2.extras.Json(spec),
            psycopg2.extras.Json(provenance),
            content_hash,
            schema_digest,
            catalog_digest,
            renderer_version,
            normalized_id,
            req.base_version,
            idempotency_key,
            request_hash,
            identity.principal_id,
        ),
    )
    updated = row_to_dict(cur.fetchone())
    if not updated:
        replayed = _replayed_surface(idempotency_key, request_hash)
        if replayed:
            return replayed
        raise HTTPException(status_code=409, detail="Surface changed while the update was applied")
    return updated


@app.post("/surfaces/{surface_id}/promote")
def promote_surface(
    surface_id: str,
    req: SurfacePromote,
    identity: IdentityContext = Depends(require_identity),
):
    normalized_id = _surface_uuid(surface_id)
    idempotency_key = _idempotency_key(req.idempotency_key)
    if req.base_version < 1:
        raise HTTPException(status_code=422, detail="Surface base version must be positive")
    request_input = {
        "operation": "promote",
        "surface_id": normalized_id,
        "base_version": req.base_version,
        "provenance": req.provenance,
    }
    if req.base_content_hash is not None:
        request_input["base_content_hash"] = req.base_content_hash
    request_hash = _surface_request_hash(request_input)
    replayed = _replayed_surface(idempotency_key, request_hash)
    if replayed:
        return replayed

    current = _get_surface_or_404(normalized_id)
    if current["current_version"] != req.base_version:
        raise HTTPException(status_code=409, detail="Surface base version is stale")
    if (
        req.base_content_hash is not None
        and current["current_content_hash"] != req.base_content_hash
    ):
        raise HTTPException(status_code=409, detail="Surface base content hash is stale")
    if current["status"] != "draft":
        raise HTTPException(status_code=409, detail="Only draft surfaces can be promoted")
    spec = _surface_spec(current["current_spec"])
    provenance = _surface_provenance(req.provenance, identity, "promoted")
    content_hash = _surface_content_hash(
        current["title"], "promoted", spec, provenance
    )
    cur = get_conn().cursor()
    cur.execute(
        """
        WITH promoted AS (
          UPDATE gb_surfaces
          SET status = 'promoted', provenance = %s, current_content_hash = %s,
              current_spec = %s, schema_digest = %s, catalog_digest = %s,
              renderer_version = %s,
              current_version = current_version + 1, updated_at = now()
          WHERE id = %s AND current_version = %s AND status = 'draft' AND deleted_at IS NULL
          RETURNING *
        ), revision AS (
          INSERT INTO gb_surface_revisions (
            tenant_id, surface_id, version, title, status, content_hash,
            schema_digest, catalog_digest, renderer_version,
            spec, provenance, idempotency_key, request_hash, created_by_principal_id
          )
          SELECT tenant_id, id, current_version, title, status, current_content_hash,
                 schema_digest, catalog_digest, renderer_version,
                 current_spec, provenance, %s, %s, %s
          FROM promoted
          RETURNING id
        )
        SELECT * FROM promoted
        """,
        (
            psycopg2.extras.Json(provenance),
            content_hash,
            psycopg2.extras.Json(spec),
            SCHEMA_DIGEST,
            CATALOG_DIGEST,
            RENDERER_VERSION,
            normalized_id,
            req.base_version,
            idempotency_key,
            request_hash,
            identity.principal_id,
        ),
    )
    promoted = row_to_dict(cur.fetchone())
    if not promoted:
        replayed = _replayed_surface(idempotency_key, request_hash)
        if replayed:
            return replayed
        raise HTTPException(status_code=409, detail="Surface changed while promotion was applied")
    return promoted


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

TENANT_RLS_TABLES = (
    "gb_experiments",
    "gb_experiment_creation_receipts",
    "gb_experiment_attachments",
    "gb_experiment_attachment_requests",
    "gb_eln_observations",
    "gb_eln_observation_revisions",
    "gb_eln_observation_create_receipts",
    "gb_hypotheses",
    "gb_experiment_metrics",
    "gb_datasource_connections",
    "gb_datasource_sync_runs",
    "gb_share_snapshots",
    "gb_node_revisions",
    "gb_surfaces",
    "gb_surface_revisions",
    "gb_papers",
    "gb_paper_revisions",
    "gb_paper_annotations",
    "gb_paper_documents",
    "gb_paper_document_bridges",
    "gb_object_links",
    "gb_object_link_proposals",
    "gb_object_link_proposal_decisions",
    "gb_object_link_retractions",
    "gb_paper_claims",
    "gb_claim_evidence_links",
    "gb_paper_task_links",
    "gb_task_plans",
    "gb_task_plan_revisions",
    "gb_task_plan_dispatch_intents",
    "gb_proof_graphs",
    "gb_formal_project_packages",
    "gb_proof_verification_sets",
    "gb_proof_verification_records",
    "gb_proof_work_verifications",
    "gb_proof_workspaces",
    "gb_proof_work_items",
    "gb_proof_work_transitions",
    "gb_canvases",
    "gb_canvas_items",
    "gb_canvas_edges",
    "gb_canvas_revisions",
    "gb_conversations",
    "gb_conversation_revisions",
    "gb_conversation_turns",
    "gb_conversation_turn_revisions",
    "gb_conversation_edges",
    "gb_artifacts",
    "gb_artifact_sources",
    "gb_documents",
    "gb_document_revisions",
    "gb_document_representations",
    "gb_transform_receipts",
    "gb_transform_attempts",
    "gb_transform_request_keys",
    "gb_document_anchors",
    "gb_document_chunks",
    "gb_document_chunk_manifests",
    "gb_document_marks",
    "gb_document_mark_revisions",
    "gb_agent_anchor_requests",
    "gb_agent_result_candidates",
    "gb_agent_result_decisions",
)

RUNTIME_DML_PRIVILEGES = ("select", "insert", "update", "delete")
RUNTIME_DML_REQUIREMENTS = {
    table_name: frozenset(RUNTIME_DML_PRIVILEGES) for table_name in TENANT_RLS_TABLES
}
RUNTIME_DML_REQUIREMENTS.update(
    {
        "gb_share_snapshots": frozenset(("select", "insert")),
        "gb_experiment_creation_receipts": frozenset(("select", "insert")),
        "gb_experiment_attachments": frozenset(("select", "insert")),
        "gb_experiment_attachment_requests": frozenset(("select", "insert")),
        "gb_eln_observations": frozenset(("select", "insert")),
        "gb_eln_observation_revisions": frozenset(("select", "insert")),
        "gb_eln_observation_create_receipts": frozenset(("select", "insert")),
        "gb_paper_documents": frozenset(("select", "insert")),
        "gb_paper_document_bridges": frozenset(("select", "insert")),
        "gb_object_links": frozenset(("select", "insert")),
        "gb_object_link_proposals": frozenset(("select", "insert")),
        "gb_object_link_proposal_decisions": frozenset(("select", "insert")),
        "gb_task_plan_dispatch_intents": frozenset(("select", "insert")),
        "gb_object_link_retractions": frozenset(("select", "insert")),
        "gb_proof_graphs": frozenset(("select", "insert")),
        "gb_formal_project_packages": frozenset(("select", "insert")),
        "gb_proof_verification_sets": frozenset(("select", "insert")),
        "gb_proof_verification_records": frozenset(("select", "insert")),
        "gb_proof_work_verifications": frozenset(("select",)),
        "gb_proof_workspaces": frozenset(("select", "insert", "update")),
        "gb_proof_work_items": frozenset(("select", "insert", "update")),
        "gb_proof_work_transitions": frozenset(("select", "insert")),
        "gb_canvases": frozenset(("select", "insert", "update")),
        "gb_canvas_items": frozenset(("select", "insert", "update")),
        "gb_canvas_edges": frozenset(("select", "insert", "update")),
        "gb_canvas_revisions": frozenset(("select", "insert")),
        "gb_conversations": frozenset(("select", "insert", "update")),
        "gb_conversation_revisions": frozenset(("select", "insert")),
        "gb_conversation_turns": frozenset(("select", "insert")),
        "gb_conversation_turn_revisions": frozenset(("select", "insert")),
        "gb_conversation_edges": frozenset(("select", "insert")),
        "gb_artifacts": frozenset(("select", "insert")),
        "gb_artifact_sources": frozenset(("select", "insert")),
        "gb_documents": frozenset(("select", "insert", "update")),
        "gb_document_revisions": frozenset(("select", "insert")),
        "gb_document_representations": frozenset(("select", "insert")),
        "gb_transform_receipts": frozenset(("select", "insert")),
        "gb_transform_attempts": frozenset(("select", "insert", "update")),
        "gb_transform_request_keys": frozenset(("select", "insert")),
        "gb_document_anchors": frozenset(("select", "insert")),
        "gb_document_chunks": frozenset(("select", "insert")),
        "gb_document_chunk_manifests": frozenset(("select", "insert")),
        "gb_document_marks": frozenset(("select", "insert", "update")),
        "gb_document_mark_revisions": frozenset(("select", "insert")),
        "gb_agent_anchor_requests": frozenset(("select", "insert")),
        "gb_agent_result_candidates": frozenset(("select", "insert")),
        "gb_agent_result_decisions": frozenset(("select", "insert")),
    }
)
RUNTIME_DML_FORBIDDEN = {
    "gb_share_snapshots": frozenset(("update", "delete")),
    "gb_experiment_creation_receipts": frozenset(("update", "delete")),
    "gb_experiment_attachments": frozenset(("update", "delete")),
    "gb_experiment_attachment_requests": frozenset(("update", "delete")),
    "gb_eln_observations": frozenset(("update", "delete", "truncate")),
    "gb_eln_observation_revisions": frozenset(("update", "delete", "truncate")),
    "gb_eln_observation_create_receipts": frozenset(("update", "delete", "truncate")),
    "gb_paper_documents": frozenset(("update", "delete")),
    "gb_paper_document_bridges": frozenset(("update", "delete")),
    "gb_object_links": frozenset(("update", "delete")),
    "gb_object_link_proposals": frozenset(("update", "delete")),
    "gb_object_link_proposal_decisions": frozenset(("update", "delete")),
    "gb_task_plan_dispatch_intents": frozenset(("update", "delete", "truncate")),
    "gb_object_link_retractions": frozenset(("update", "delete")),
    "gb_proof_graphs": frozenset(("update", "delete")),
    "gb_formal_project_packages": frozenset(("update", "delete", "truncate")),
    "gb_proof_verification_sets": frozenset(("update", "delete")),
    "gb_proof_verification_records": frozenset(("update", "delete")),
    "gb_proof_work_verifications": frozenset(("insert", "update", "delete")),
    "gb_proof_workspaces": frozenset(("delete",)),
    "gb_proof_work_items": frozenset(("delete",)),
    "gb_proof_work_transitions": frozenset(("update", "delete")),
    "gb_canvases": frozenset(("delete",)),
    "gb_canvas_items": frozenset(("delete",)),
    "gb_canvas_edges": frozenset(("delete",)),
    "gb_canvas_revisions": frozenset(("update", "delete")),
    "gb_conversations": frozenset(("delete",)),
    "gb_conversation_revisions": frozenset(("update", "delete")),
    "gb_conversation_turns": frozenset(("update", "delete")),
    "gb_conversation_turn_revisions": frozenset(("update", "delete")),
    "gb_conversation_edges": frozenset(("update", "delete")),
    "gb_artifacts": frozenset(("update", "delete")),
    "gb_artifact_sources": frozenset(("update", "delete")),
    "gb_documents": frozenset(("delete",)),
    "gb_document_revisions": frozenset(("update", "delete")),
    "gb_document_representations": frozenset(("update", "delete")),
    "gb_transform_receipts": frozenset(("update", "delete")),
    "gb_transform_attempts": frozenset(("delete",)),
    "gb_transform_request_keys": frozenset(("update", "delete")),
    "gb_document_anchors": frozenset(("update", "delete")),
    "gb_document_chunks": frozenset(("update", "delete")),
    "gb_document_chunk_manifests": frozenset(("update", "delete")),
    "gb_document_marks": frozenset(("delete",)),
    "gb_document_mark_revisions": frozenset(("update", "delete")),
    "gb_agent_anchor_requests": frozenset(("update", "delete")),
    "gb_agent_result_candidates": frozenset(("update", "delete", "truncate")),
    "gb_agent_result_decisions": frozenset(("update", "delete", "truncate")),
}
RUNTIME_IDENTITY_READ_TABLES = (
    "app_tenants",
    "app_principals",
    "app_tenant_memberships",
    "app_agents",
)


def _verify_runtime_rls_role(cur):
    """Fail closed when the API role could bypass tenant row-level security."""
    cur.execute(
        """
        SELECT role.rolname
        FROM pg_catalog.pg_roles AS role
        WHERE (role.rolsuper OR role.rolbypassrls)
          AND pg_catalog.pg_has_role(current_user, role.rolname, 'MEMBER')
        ORDER BY role.rolname
        """
    )
    privileged_roles = [row["rolname"] for row in cur.fetchall()]
    if privileged_roles:
        raise RuntimeError(
            "API database role can bypass row-level security via role(s): "
            + ", ".join(privileged_roles)
        )

    cur.execute(
        """
        SELECT tables.relname,
               pg_catalog.pg_get_userbyid(tables.relowner) AS owner_name,
               tables.relrowsecurity,
               pg_catalog.pg_has_role(
                   current_user,
                   pg_catalog.pg_get_userbyid(tables.relowner),
                   'MEMBER'
               ) AS can_assume_owner,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'SELECT')
                 AS can_select,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'INSERT')
                 AS can_insert,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'UPDATE')
                 AS can_update,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'DELETE')
                 AS can_delete,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'TRUNCATE')
                 AS can_truncate
        FROM pg_catalog.pg_class AS tables
        JOIN pg_catalog.pg_namespace AS schemas
          ON schemas.oid = tables.relnamespace
        WHERE schemas.nspname = 'public'
          AND tables.relname = ANY(%s)
        ORDER BY tables.relname
        """,
        (list(TENANT_RLS_TABLES),),
    )
    table_state = {row["relname"]: row for row in cur.fetchall()}
    missing_tables = sorted(set(TENANT_RLS_TABLES) - set(table_state))
    if missing_tables:
        raise RuntimeError("tenant RLS tables are missing: " + ", ".join(missing_tables))

    rls_disabled = sorted(
        table_name for table_name, state in table_state.items() if not state["relrowsecurity"]
    )
    if rls_disabled:
        raise RuntimeError("row-level security is disabled for: " + ", ".join(rls_disabled))

    owned_or_assumable = sorted(
        f"{table_name} ({state['owner_name']})"
        for table_name, state in table_state.items()
        if state["can_assume_owner"]
    )
    if owned_or_assumable:
        raise RuntimeError(
            "API database role owns or can assume the owner of tenant table(s): "
            + ", ".join(owned_or_assumable)
        )

    missing_privileges = sorted(
        (
            table_name,
            sorted(
                privilege
                for privilege in RUNTIME_DML_REQUIREMENTS[table_name]
                if not state[f"can_{privilege}"]
            ),
        )
        for table_name, state in table_state.items()
        if any(
            not state[f"can_{privilege}"]
            for privilege in RUNTIME_DML_REQUIREMENTS[table_name]
        )
    )
    if missing_privileges:
        raise RuntimeError(
            "API database role lacks required DML privileges: "
            + "; ".join(
                f"{table_name} ({', '.join(privileges)})"
                for table_name, privileges in missing_privileges
            )
        )

    forbidden_privileges = sorted(
        (
            table_name,
            sorted(
                privilege
                for privilege in RUNTIME_DML_FORBIDDEN.get(table_name, ())
                if state[f"can_{privilege}"]
            ),
        )
        for table_name, state in table_state.items()
        if any(
            state[f"can_{privilege}"]
            for privilege in RUNTIME_DML_FORBIDDEN.get(table_name, ())
        )
    )
    if forbidden_privileges:
        raise RuntimeError(
            "API database role has forbidden DML privileges: "
            + "; ".join(
                f"{table_name} ({', '.join(privileges)})"
                for table_name, privileges in forbidden_privileges
            )
        )

    cur.execute(
        """
        SELECT registrar.oid IS NOT NULL AS registrar_exists,
               CASE WHEN registrar.oid IS NULL THEN FALSE ELSE
                 pg_catalog.has_function_privilege(current_user, registrar.oid, 'EXECUTE')
               END AS can_execute_registrar,
               authority.oid IS NOT NULL AS verifier_authority_exists,
               CASE WHEN authority.oid IS NULL THEN FALSE ELSE
                 pg_catalog.pg_has_role(current_user, authority.oid, 'MEMBER')
               END AS can_assume_verifier_authority
          FROM (SELECT pg_catalog.to_regprocedure(
            'public.gb_record_accepted_proof_verification(uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text,text[],text,text,text,text,timestamp with time zone,jsonb,uuid,text,text,text)'
          ) AS oid) AS registrar
          CROSS JOIN (SELECT pg_catalog.to_regrole('gb_proof_verifier') AS oid) AS authority
        """
    )
    registrar_state = cur.fetchone()
    if not registrar_state or not registrar_state["registrar_exists"]:
        raise RuntimeError("trusted proof verification registrar is missing")
    if registrar_state["can_execute_registrar"]:
        raise RuntimeError(
            "API database role has forbidden trusted proof verification registrar access"
        )
    if not registrar_state["verifier_authority_exists"]:
        raise RuntimeError("trusted proof verifier authority role is missing")
    if registrar_state["can_assume_verifier_authority"]:
        raise RuntimeError(
            "API database role can assume the trusted proof verifier authority"
        )

    cur.execute(
        """
        SELECT tables.relname,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'SELECT')
                 AS can_select,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'INSERT')
                 AS can_insert,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'UPDATE')
                 AS can_update,
               pg_catalog.has_table_privilege(current_user, tables.oid, 'DELETE')
                 AS can_delete
        FROM pg_catalog.pg_class AS tables
        JOIN pg_catalog.pg_namespace AS schemas ON schemas.oid = tables.relnamespace
        WHERE schemas.nspname = 'public'
          AND tables.relname = ANY(%s)
        ORDER BY tables.relname
        """,
        (list(RUNTIME_IDENTITY_READ_TABLES),),
    )
    identity_table_state = {row["relname"]: row for row in cur.fetchall()}
    missing_identity_tables = sorted(
        set(RUNTIME_IDENTITY_READ_TABLES) - set(identity_table_state)
    )
    if missing_identity_tables:
        raise RuntimeError(
            "identity tables are missing: " + ", ".join(missing_identity_tables)
        )
    unreadable_identity_tables = sorted(
        table_name
        for table_name, state in identity_table_state.items()
        if not state["can_select"]
    )
    if unreadable_identity_tables:
        raise RuntimeError(
            "API database role lacks required identity read privileges: "
            + ", ".join(unreadable_identity_tables)
        )
    writable_identity_tables = sorted(
        (
            table_name,
            sorted(
                privilege
                for privilege in ("insert", "update", "delete")
                if state[f"can_{privilege}"]
            ),
        )
        for table_name, state in identity_table_state.items()
        if any(
            state[f"can_{privilege}"]
            for privilege in ("insert", "update", "delete")
        )
    )
    if writable_identity_tables:
        raise RuntimeError(
            "API database role has forbidden identity write privileges: "
            + "; ".join(
                f"{table_name} ({', '.join(privileges)})"
                for table_name, privileges in writable_identity_tables
            )
        )


PROOF_VERIFIER_AUTHORITY_TABLE_PRIVILEGES = {
    "gb_proof_workspaces": frozenset(("select", "update")),
    "gb_proof_work_items": frozenset(("select", "update")),
    "gb_proof_work_transitions": frozenset(("select", "insert")),
    "gb_artifacts": frozenset(("select", "insert")),
    "gb_proof_work_verifications": frozenset(("select",)),
}


def _verify_proof_verifier_authority(conn, runtime_user: str):
    """Fail closed unless a separate login can assume only the sealed authority."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT session_role.rolname AS login_role,
               session_role.rolsuper OR session_role.rolbypassrls AS login_privileged,
               EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_roles AS privileged
                  WHERE (privileged.rolsuper OR privileged.rolbypassrls)
                    AND pg_catalog.pg_has_role(session_role.oid, privileged.oid, 'MEMBER')
               ) AS can_assume_bypass,
               authority.oid IS NOT NULL AS authority_exists,
               COALESCE(
                 authority.rolcanlogin OR authority.rolsuper OR authority.rolbypassrls
                 OR authority.rolcreaterole OR authority.rolcreatedb
                 OR authority.rolreplication,
                 TRUE
               ) AS authority_unrestricted,
               CASE WHEN authority.oid IS NULL THEN FALSE ELSE
                 pg_catalog.pg_has_role(session_role.oid, authority.oid, 'MEMBER')
               END AS can_assume_authority
          FROM pg_catalog.pg_roles AS session_role
          LEFT JOIN pg_catalog.pg_roles AS authority
            ON authority.rolname = 'gb_proof_verifier'
         WHERE session_role.rolname = session_user
        """
    )
    login = cur.fetchone()
    if not login:
        raise RuntimeError("trusted proof verifier login role is missing")
    if login["login_role"] == runtime_user:
        raise RuntimeError(
            "trusted proof verifier authority must use a login distinct from the API runtime"
        )
    if login["login_privileged"] or login["can_assume_bypass"]:
        raise RuntimeError("trusted proof verifier login can bypass row-level security")
    if not login["authority_exists"] or login["authority_unrestricted"]:
        raise RuntimeError("trusted proof verifier authority must be a restricted NOLOGIN role")
    if not login["can_assume_authority"]:
        raise RuntimeError("trusted proof verifier login is not a member of gb_proof_verifier")

    cur.execute("BEGIN")
    try:
        cur.execute("SET LOCAL ROLE gb_proof_verifier")
        cur.execute(
            """
            SELECT CASE WHEN registrar.oid IS NULL THEN FALSE ELSE
                     pg_catalog.has_function_privilege(current_user, registrar.oid, 'EXECUTE')
                   END AS can_execute_registrar
              FROM (SELECT pg_catalog.to_regprocedure(
                'public.gb_record_accepted_proof_verification(uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text,text[],text,text,text,text,timestamp with time zone,jsonb,uuid,text,text,text)'
              ) AS oid) AS registrar
            """
        )
        registrar = cur.fetchone()
        cur.execute(
            """
            SELECT tables.relname,
                   pg_catalog.pg_has_role(
                       current_user,
                       pg_catalog.pg_get_userbyid(tables.relowner),
                       'MEMBER'
                   ) AS can_assume_owner,
                   pg_catalog.has_table_privilege(current_user, tables.oid, 'SELECT')
                     AS can_select,
                   pg_catalog.has_table_privilege(current_user, tables.oid, 'INSERT')
                     AS can_insert,
                   pg_catalog.has_table_privilege(current_user, tables.oid, 'UPDATE')
                     AS can_update,
                   pg_catalog.has_table_privilege(current_user, tables.oid, 'DELETE')
                     AS can_delete,
                   pg_catalog.has_table_privilege(current_user, tables.oid, 'TRUNCATE')
                     AS can_truncate
              FROM pg_catalog.pg_class AS tables
              JOIN pg_catalog.pg_namespace AS schemas
                ON schemas.oid = tables.relnamespace
             WHERE schemas.nspname = 'public'
               AND tables.relname = ANY(%s)
             ORDER BY tables.relname
            """,
            (list(TENANT_RLS_TABLES),),
        )
        table_state = cur.fetchall()
    finally:
        cur.execute("ROLLBACK")

    if not registrar or not registrar["can_execute_registrar"]:
        raise RuntimeError("trusted proof verifier authority cannot execute the registrar")
    mismatched = []
    for row in table_state:
        if row["can_assume_owner"]:
            mismatched.append(f"{row['relname']} (owner)")
            continue
        expected = PROOF_VERIFIER_AUTHORITY_TABLE_PRIVILEGES.get(
            row["relname"], frozenset()
        )
        actual = {
            privilege
            for privilege in ("select", "insert", "update", "delete", "truncate")
            if row[f"can_{privilege}"]
        }
        if actual != expected:
            mismatched.append(f"{row['relname']} ({', '.join(sorted(actual ^ expected))})")
    if mismatched:
        raise RuntimeError(
            "trusted proof verifier authority privileges do not match the contract: "
            + "; ".join(sorted(mismatched))
        )


def _startup():
    """Verify the migrated schema, seed builtin plugins, and print diagnostics."""
    location = "configured database URL" if DB_URL else f"{DB_HOST}:{DB_PORT}/{DB_NAME}"
    print(f"Galaxy Brain API — connecting to PostgreSQL at {location}...")
    conn = get_conn()
    cur = conn.cursor()

    required_migrations = {
        "001_extensions",
        "002_app_auth",
        "003_eln",
        "004_legacy_tenant_backfill",
        "005_tenants_and_principals",
        "006_bounded_surfaces",
        "007_surface_contract_identity",
        "008_research_papers",
        "009_task_plans",
        "010_personal_workspace_invitations",
        "011_session_nostr_identity",
        "012_proof_work_state",
        "013_api_identity_read_permissions",
        "014_paper_documents",
        "015_object_links",
        "016_object_link_retractions",
        "017_federated_object_links",
        "018_canvas_persistence",
        "019_canvas_multi_document",
        "020_durable_ingestion",
        "021_document_transform_execution",
        "022_document_transform_attempts",
        "023_document_anchor_objects",
        "024_document_marks",
        "025_proof_graph_registry",
        "026_proof_workspace_activation_gate",
        "027_proof_verification_sets",
        "028_proof_mission_activation",
        "029_trusted_proof_verification",
        "030_transform_request_coalescing",
        "031_experiment_creation_idempotency",
        "032_proof_coordination_task_bindings",
        "033_agent_anchor_requests",
        "034_object_link_proposals",
        "035_typed_share_bundles",
        "036_conversation_turn_dag",
        "037_eln_durable_attachments",
        "038_paper_document_bridge",
        "039_document_chunk_identity",
        "040_formal_project_packages",
        "041_object_link_proposal_decisions",
        "042_task_plan_dispatch_intents",
        "043_durable_ingestion_source_kinds",
        "044_document_chunk_search",
        "045_canvas_conversation_share_bundles",
        "046_canvas_frames",
        "047_eln_observation_identity",
        "048_canvas_projection_mode",
        "049_proofs_blah_dev_verifier_authority",
        "050_agent_result_return_path",
    }
    cur.execute("SELECT version FROM public.schema_migrations")
    applied_migrations = {row["version"] for row in cur.fetchall()}
    missing_migrations = sorted(required_migrations - applied_migrations)
    if missing_migrations:
        raise RuntimeError(f"database migrations are missing: {', '.join(missing_migrations)}")
    print("  Ordered database migrations verified.")
    print(
        "  Surface contract verified: "
        f"{SURFACE_SCHEMA} {SCHEMA_DIGEST[:12]} / "
        f"{CATALOG_ID}@{CATALOG_VERSION} {CATALOG_DIGEST[:12]} / "
        f"renderer {RENDERER_VERSION[:12]}."
    )

    _verify_runtime_rls_role(cur)
    print("  Restricted API runtime role and tenant RLS verified.")

    if PROOF_VERIFIER_DB_URL:
        cur.execute("SELECT current_user AS runtime_user")
        _verify_proof_verifier_authority(
            get_proof_verifier_conn(), cur.fetchone()["runtime_user"]
        )
        print("  Trusted proof verifier authority verified.")
    else:
        print(
            "  Trusted proof verifier authority is not configured; "
            "verification requests fail closed."
        )

    try:
        for plugin in BUILTIN_DATASOURCE_PLUGINS:
            cur.execute(
                """
                INSERT INTO gb_datasource_plugins (id, display_name, kind, capabilities, auth_type, is_builtin)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    kind = EXCLUDED.kind,
                    capabilities = EXCLUDED.capabilities,
                    auth_type = EXCLUDED.auth_type,
                    is_builtin = EXCLUDED.is_builtin,
                    updated_at = now()
                """,
                (
                    plugin.id,
                    plugin.display_name,
                    plugin.kind,
                    plugin.capabilities,
                    plugin.auth_type,
                    plugin.is_builtin,
                ),
            )
        print(f"  Seeded {len(BUILTIN_DATASOURCE_PLUGINS)} datasource plugin(s).")
    except Exception as e:
        print(f"  WARNING: datasource plugin seed failed: {e}")

    # Count existing rows
    try:
        cur.execute("SELECT COUNT(*) FROM gb_experiments")
        exp_count = cur.fetchone()["count"]
        cur.execute("SELECT COUNT(*) FROM gb_hypotheses")
        hyp_count = cur.fetchone()["count"]
        cur.execute("SELECT COUNT(*) FROM gb_datasource_connections")
        datasource_count = cur.fetchone()["count"]
        cur.execute("SELECT COUNT(*) FROM gb_node_revisions")
        revision_count = cur.fetchone()["count"]
        cur.execute("SELECT COUNT(*) FROM gb_surfaces")
        surface_count = cur.fetchone()["count"]
        cur.execute("SELECT COUNT(*) FROM gb_task_plans")
        task_plan_count = cur.fetchone()["count"]
        print(f"  gb_experiments: {exp_count} rows")
        print(f"  gb_hypotheses:  {hyp_count} rows")
        print(f"  gb_datasource_connections: {datasource_count} rows")
        print(f"  gb_node_revisions: {revision_count} rows")
        print(f"  gb_surfaces: {surface_count} rows")
        print(f"  gb_task_plans: {task_plan_count} rows")
    except Exception as e:
        print(f"  WARNING: row count query failed: {e}")

    if PIPELINE_ROOT:
        print(f"  PIPELINE_ROOT: {PIPELINE_ROOT}")

    print("  Ready!")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8044)
