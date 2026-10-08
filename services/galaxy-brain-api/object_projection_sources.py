"""Private, tenant-bound source resolution for object projection.

This module deliberately returns only the bounded fields consumed by Galaxy's
registered object projectors.  It does not return stored bodies, source URLs,
identity context, or authorization diagnostics.  RLS authorization and exact
revision lookup happen in one read-only repeatable-read snapshot.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Iterable
from urllib.parse import quote

from object_links import ObjectLinkError, parse_canonical_reference
from durable_ingestion import (
    IngestionContractError,
    RASTER_IMAGE_MEDIA_TYPES,
    normalize_audio_original_manifest,
    normalize_raster_image_manifest,
)


REQUEST_SCHEMA_V1 = "gb.object-projection-source-request.v1"
RESPONSE_SCHEMA_V1 = "gb.object-projection-source-response.v1"
REQUEST_SCHEMA_V2 = "gb.object-projection-source-request.v2"
RESPONSE_SCHEMA_V2 = "gb.object-projection-source-response.v2"
REQUEST_SCHEMA = "gb.object-projection-source-request.v3"
RESPONSE_SCHEMA = "gb.object-projection-source-response.v3"
MAX_REQUEST_BYTES = 65_536
MAX_REFERENCES = 64
MAX_RESPONSE_BYTES = 1_048_576
MAX_DOCUMENT_REPRESENTATIONS = 32
MAX_TRANSFORM_RECEIPTS = 128

_SHA256 = re.compile(r"[0-9a-f]{64}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_SAFE_COMPONENT = "~!*'()-._"
_SUPPORTED_KINDS = frozenset({
    "paper",
    "document",
    "document.anchor",
    "eln.experiment",
    "eln.observation",
    "surface",
    "chat",
    "proof.graph",
    "proof.node",
})


class ProjectionSourceRequestError(ValueError):
    def __init__(self, message: str, *, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


class ProjectionSourceProviderError(RuntimeError):
    """The private source provider could not produce a trustworthy response."""


def _receipt_representation_identities(receipt: dict | None) -> set[tuple[str, str]]:
    if receipt is None:
        return set()
    identities: set[tuple[str, str]] = set()
    representation_id = receipt.get("output_representation_id")
    output_sha256 = receipt.get("output_sha256")
    if representation_id is not None or output_sha256 is not None:
        identities.add((_identifier(representation_id), _hash(output_sha256)))
    manifest = receipt.get("output_manifest")
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaId") != "gb.transform-output-manifest.v1"
    ):
        raise ProjectionSourceProviderError("Projection source contains an invalid transform manifest")
    representations = manifest.get("representations", [])
    if not isinstance(representations, list) or len(representations) > MAX_DOCUMENT_REPRESENTATIONS:
        raise ProjectionSourceProviderError("Projection source contains an invalid transform manifest")
    for representation in representations:
        if not isinstance(representation, dict):
            raise ProjectionSourceProviderError("Projection source contains an invalid transform manifest")
        identities.add((
            _identifier(representation.get("id")),
            _hash(representation.get("contentSha256")),
        ))
    return identities


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ProjectionSourceRequestError("Projection request contains duplicate fields")
        value[key] = item
    return value


def parse_projection_source_request(
    encoded: bytes, *, include_schema: bool = False,
) -> list[str] | tuple[str, list[str]]:
    """Parse the exact private request envelope before opening a DB snapshot."""
    if not isinstance(encoded, bytes):
        raise ProjectionSourceRequestError("Projection request must be a JSON body")
    if len(encoded) > MAX_REQUEST_BYTES:
        raise ProjectionSourceRequestError("Projection request is too large", status_code=413)
    if not encoded:
        raise ProjectionSourceRequestError("Projection request must be a JSON body")
    try:
        payload = json.loads(
            encoded.decode("utf-8", "strict"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except ProjectionSourceRequestError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ProjectionSourceRequestError("Projection request must be valid UTF-8 JSON") from error
    if not isinstance(payload, dict) or set(payload) != {"schemaId", "references"}:
        raise ProjectionSourceRequestError("Projection request has unsupported fields")
    schema_id = payload["schemaId"]
    if schema_id not in {REQUEST_SCHEMA_V1, REQUEST_SCHEMA_V2, REQUEST_SCHEMA}:
        raise ProjectionSourceRequestError("Unsupported projection request schema")
    references = payload["references"]
    if (
        not isinstance(references, list)
        or not 1 <= len(references) <= MAX_REFERENCES
        or any(not isinstance(value, str) for value in references)
        or len(set(references)) != len(references)
    ):
        raise ProjectionSourceRequestError(
            f"Projection request requires 1 to {MAX_REFERENCES} unique canonical references"
        )
    try:
        parsed = [parse_canonical_reference(value) for value in references]
    except ObjectLinkError as error:
        raise ProjectionSourceRequestError("Projection request contains an invalid canonical reference") from error
    if any(reference.wire != value for reference, value in zip(parsed, references)):
        raise ProjectionSourceRequestError("Projection request contains a noncanonical reference")
    return (schema_id, references) if include_schema else references


def _digest(revision: str | None) -> str | None:
    if revision is None or not revision.startswith("sha256:"):
        return None
    digest = revision.removeprefix("sha256:")
    return digest if _SHA256.fullmatch(digest) else None


def _wire(kind: str, identifier: str, digest: str) -> str:
    value = (
        f"gb:object:v1:{kind}:{quote(identifier, safe=_SAFE_COMPONENT)}:pinned:"
        f"{quote(f'sha256:{digest}', safe=_SAFE_COMPONENT)}"
    )
    return parse_canonical_reference(value).wire


def _text(value: Any, maximum: int, *, required: bool = False) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ProjectionSourceProviderError("Projection source contains invalid text")
    normalized = value.strip()
    if not normalized and required:
        raise ProjectionSourceProviderError("Projection source contains invalid text")
    characters = list(normalized)
    if len(characters) <= maximum:
        return normalized
    if maximum < 2:
        return characters[0]
    return "".join(characters[:maximum - 1]) + "…"


def _hash(value: Any) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise ProjectionSourceProviderError("Projection source contains an invalid digest")
    return value


def _identifier(value: Any, maximum: int = 512) -> str:
    if value is None:
        raise ProjectionSourceProviderError("Projection source contains an invalid identifier")
    result = str(value)
    if not result or result != result.strip() or len(result) > maximum:
        raise ProjectionSourceProviderError("Projection source contains an invalid identifier")
    return result


def _uuid(value: Any) -> str:
    result = _identifier(value, 36).lower()
    if not _UUID.fullmatch(result):
        raise ProjectionSourceProviderError("Projection source contains an invalid UUID")
    return result


def _timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return _identifier(value, 256)


def _resolved(requested: str, resolved_ref: str, provider: str, source_kind: str, source: dict) -> dict:
    return {
        "requestedRef": requested,
        "status": "resolved",
        "resolvedRef": resolved_ref,
        "provider": provider,
        "sourceKind": source_kind,
        "source": source,
    }


def _unavailable(requested: str) -> dict:
    return {"requestedRef": requested, "status": "unavailable"}


def _paper(cur, tenant_id: str, reference, response_schema: str) -> dict | None:
    digest = _digest(reference.revision)
    if reference.revision is not None and digest is None:
        return None
    cur.execute(
        """SELECT paper.id, revision.id AS revision_id, revision.metadata_hash,
                  revision.metadata ->> 'title' AS revision_title,
                  revision.metadata ->> 'abstract' AS revision_abstract,
                  bridge.document_id, bridge.document_revision_id,
                  bridge.document_revision_sha256,
                  bridge.content_sha256 AS document_sha256,
                  original.media_type AS document_media_type,
                  durable_revision.display_filename AS document_filename,
                  legacy.content_sha256 AS legacy_document_sha256,
                  legacy.media_type AS legacy_document_media_type,
                  legacy.filename AS legacy_document_filename
             FROM gb_papers AS paper
             JOIN gb_paper_revisions AS revision
               ON revision.tenant_id = paper.tenant_id
              AND revision.paper_id = paper.id
             LEFT JOIN gb_paper_document_bridges AS bridge
               ON bridge.tenant_id = revision.tenant_id
              AND bridge.paper_revision_id = revision.id
             LEFT JOIN gb_document_revisions AS durable_revision
               ON durable_revision.tenant_id = bridge.tenant_id
              AND durable_revision.id = bridge.document_revision_id
             LEFT JOIN gb_document_representations AS original
              ON original.tenant_id = bridge.tenant_id
              AND original.id = bridge.original_representation_id
             LEFT JOIN gb_paper_documents AS legacy
               ON legacy.tenant_id = revision.tenant_id
              AND legacy.paper_revision_id = revision.id
            WHERE paper.tenant_id = %s
              AND paper.id::text = %s
              AND revision.metadata_hash = COALESCE(%s, paper.metadata_hash)
            LIMIT 1""",
        (tenant_id, reference.identifier, digest),
    )
    row = cur.fetchone()
    if row is None:
        return None
    paper_id = _identifier(row["id"])
    metadata_hash = _hash(row["metadata_hash"])
    paper = {
        "id": paper_id,
        "title": _text(row["revision_title"], 240, required=True),
        "metadataHash": metadata_hash,
    }
    abstract = _text(row["revision_abstract"], 4000)
    if abstract:
        paper["abstract"] = abstract
    revision = {
        "id": _identifier(row["revision_id"]),
        "metadataHash": metadata_hash,
    }
    if response_schema == RESPONSE_SCHEMA_V1 and row.get("legacy_document_sha256") is not None:
        revision["document"] = {
            "contentSha256": _hash(row["legacy_document_sha256"]),
            "mediaType": _text(row["legacy_document_media_type"], 160, required=True),
            "filename": _text(row["legacy_document_filename"], 512, required=True),
        }
    elif response_schema == RESPONSE_SCHEMA and row.get("document_sha256") is not None:
        revision["document"] = {
            "ref": _wire(
                "document",
                _identifier(row["document_id"]),
                _hash(row["document_revision_sha256"]),
            ),
            "documentId": _uuid(row["document_id"]),
            "revisionId": _uuid(row["document_revision_id"]),
            "revisionSha256": _hash(row["document_revision_sha256"]),
            "contentSha256": _hash(row["document_sha256"]),
            "mediaType": _text(row["document_media_type"], 160, required=True),
            "displayFilename": _text(row["document_filename"], 512, required=True),
        }
    return _resolved(
        reference.wire,
        _wire("paper", paper_id, metadata_hash),
        "galaxy.paper",
        "paper",
        {"paper": paper, "revision": revision},
    )


def _document(cur, tenant_id: str, reference) -> dict | None:
    digest = _digest(reference.revision)
    if reference.revision is not None and digest is None:
        return None
    cur.execute(
        """SELECT document.id AS document_id, revision.id AS revision_id,
                  revision.revision_sha256, revision.title, revision.display_filename,
                  artifact.media_type, artifact.content_sha256, artifact.byte_size,
                  source.source_metadata
             FROM gb_documents AS document
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = document.tenant_id
              AND revision.document_id = document.id
             JOIN gb_artifacts AS artifact
               ON artifact.tenant_id = revision.tenant_id
              AND artifact.id = revision.original_artifact_id
             JOIN gb_artifact_sources AS source
               ON source.tenant_id = revision.tenant_id
              AND source.id = revision.source_id
            WHERE document.tenant_id = %s AND document.id::text = %s
              AND document.deleted_at IS NULL
              AND revision.id = CASE WHEN %s::text IS NULL
                    THEN document.current_revision_id ELSE revision.id END
              AND (%s::text IS NULL OR revision.revision_sha256 = %s)
            LIMIT 1""",
        (tenant_id, reference.identifier, digest, digest, digest),
    )
    row = cur.fetchone()
    if row is None:
        return None
    document_id = _identifier(row["document_id"])
    if document_id != reference.identifier:
        raise ProjectionSourceProviderError("Projection source changed the requested document identity")
    revision_id = _uuid(row["revision_id"])
    revision_sha256 = _hash(row["revision_sha256"])
    if digest is not None and revision_sha256 != digest:
        raise ProjectionSourceProviderError("Projection source changed the requested document revision")
    media_type = _text(row["media_type"], 160, required=True)
    raster_image = None
    audio_original = None
    source_metadata = row.get("source_metadata") if isinstance(row.get("source_metadata"), dict) else {}
    if media_type in RASTER_IMAGE_MEDIA_TYPES:
        try:
            raster_image = normalize_raster_image_manifest(
                source_metadata.get("rasterImage"),
                filename=row["display_filename"],
                media_type=media_type,
                content_sha256=_hash(row["content_sha256"]),
            )
        except IngestionContractError as error:
            raise ProjectionSourceProviderError("Projection source contains invalid raster image metadata") from error
    elif source_metadata.get("rasterImage") is not None:
        raise ProjectionSourceProviderError("Projection source contains inconsistent raster image metadata")
    if media_type == "audio/webm":
        try:
            audio_original = normalize_audio_original_manifest(
                source_metadata.get("audioOriginal"),
                media_type=media_type,
                content_sha256=_hash(row["content_sha256"]),
                byte_size=int(row["byte_size"]),
            )
        except (IngestionContractError, TypeError, ValueError) as error:
            raise ProjectionSourceProviderError("Projection source contains invalid audio original metadata") from error
    elif source_metadata.get("audioOriginal") is not None:
        raise ProjectionSourceProviderError("Projection source contains inconsistent audio original metadata")
    cur.execute(
        """SELECT id, output_representation_id, output_sha256,
                  output_manifest, fallback_receipt_id
             FROM gb_transform_receipts
            WHERE tenant_id = %s AND document_revision_id = %s
            ORDER BY created_at DESC, id DESC
            LIMIT %s""",
        (tenant_id, revision_id, MAX_TRANSFORM_RECEIPTS),
    )
    receipts = cur.fetchall()
    fallback_ids = {
        str(receipt["fallback_receipt_id"])
        for receipt in receipts if receipt.get("fallback_receipt_id") is not None
    }
    primary_receipt = next(
        (receipt for receipt in receipts if str(receipt["id"]) not in fallback_ids),
        None,
    )
    fallback_receipt = next(
        (
            receipt for receipt in receipts
            if primary_receipt is not None
            and primary_receipt.get("fallback_receipt_id") is not None
            and str(receipt["id"]) == str(primary_receipt["fallback_receipt_id"])
        ),
        None,
    )
    output_identities = (
        _receipt_representation_identities(primary_receipt)
        | _receipt_representation_identities(fallback_receipt)
    )
    output_identity_keys = [
        f"{representation_id}:{content_sha256}"
        for representation_id, content_sha256 in sorted(output_identities)
    ]
    cur.execute(
        """SELECT id, kind, media_type, content_sha256
             FROM gb_document_representations
            WHERE tenant_id = %s AND document_revision_id = %s
              AND (
                    kind = 'original'
                    OR (id::text || ':' || content_sha256) = ANY(%s)
                  )
            ORDER BY CASE WHEN kind = 'original' THEN 0 ELSE 1 END, created_at, id
            LIMIT %s""",
        (tenant_id, revision_id, output_identity_keys, MAX_DOCUMENT_REPRESENTATIONS + 1),
    )
    representation_rows = cur.fetchall()
    if len(representation_rows) > MAX_DOCUMENT_REPRESENTATIONS:
        raise ProjectionSourceProviderError("Projection source contains too many current representations")
    representations = []
    for representation in representation_rows:
        kind = _text(representation["kind"], 64, required=True)
        representations.append({
            "id": _identifier(representation["id"]),
            "kind": kind,
            "mediaType": _text(representation["media_type"], 160, required=True),
            "contentSha256": _hash(representation["content_sha256"]),
            "label": kind,
        })
    source = {
        "documentId": document_id,
        "revisionId": revision_id,
        "revisionSha256": revision_sha256,
        "title": _text(row["title"], 240, required=True),
        "displayFilename": _text(row["display_filename"], 240, required=True),
        "mediaType": media_type,
        "representations": representations,
    }
    if raster_image is not None:
        source["rasterImage"] = raster_image
    if audio_original is not None:
        source["audioOriginal"] = audio_original
    return _resolved(
        reference.wire,
        _wire("document", document_id, revision_sha256),
        "galaxy.document",
        "document",
        source,
    )


def _selector(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ProjectionSourceProviderError("Projection source contains an invalid anchor selector")
    kind = value.get("kind")
    if kind == "page-region":
        page = value.get("page")
        if isinstance(page, bool) or not isinstance(page, int) or page < 1 or page > 100_000:
            raise ProjectionSourceProviderError("Projection source contains an invalid anchor selector")
        return {"kind": kind, "page": page}
    if kind == "text-quote":
        return {"kind": kind, "exact": _text(value.get("exact"), 4000, required=True)}
    if kind == "json-pointer":
        return {"kind": kind, "pointer": _text(value.get("pointer"), 240, required=True)}
    raise ProjectionSourceProviderError("Projection source contains an invalid anchor selector")


def _document_anchor(cur, tenant_id: str, reference) -> dict | None:
    digest = _digest(reference.revision)
    if reference.revision is not None and digest is None:
        return None
    if not reference.identifier.startswith("sha256:"):
        return None
    anchor_digest = reference.identifier.removeprefix("sha256:")
    if not _SHA256.fullmatch(anchor_digest):
        return None
    cur.execute(
        """SELECT anchor.id, anchor.representation_sha256, anchor.anchor_sha256,
                  anchor.selector_json, revision.title
             FROM gb_document_anchors AS anchor
             JOIN gb_document_representations AS representation
               ON representation.tenant_id = anchor.tenant_id
              AND representation.id = anchor.representation_id
              AND representation.content_sha256 = anchor.representation_sha256
             JOIN gb_document_revisions AS revision
               ON revision.tenant_id = representation.tenant_id
              AND revision.id = representation.document_revision_id
            WHERE anchor.tenant_id = %s AND anchor.anchor_sha256 = %s
              AND anchor.identity_version = 'gb.anchor.v1'
              AND (%s::text IS NULL OR anchor.representation_sha256 = %s)
            LIMIT 1""",
        (tenant_id, anchor_digest, digest, digest),
    )
    row = cur.fetchone()
    if row is None:
        return None
    stored_anchor_digest = _hash(row["anchor_sha256"])
    anchor_id = f"sha256:{stored_anchor_digest}"
    if _identifier(row["id"]) != anchor_id:
        raise ProjectionSourceProviderError("Projection source contains an invalid anchor identity")
    representation_sha256 = _hash(row["representation_sha256"])
    source = {
        "id": anchor_id,
        "representationSha256": representation_sha256,
        "anchorSha256": stored_anchor_digest,
        "title": _text(row["title"], 160, required=True),
        "selector": _selector(row["selector_json"]),
    }
    return _resolved(
        reference.wire,
        _wire("document.anchor", anchor_id, representation_sha256),
        "galaxy.document",
        "document.anchor",
        source,
    )


def _experiment(cur, tenant_id: str, reference) -> dict | None:
    if reference.revision is not None:
        return None
    cur.execute(
        """SELECT id, title, results, interpretation, updated_at
             FROM gb_experiments
            WHERE tenant_id = %s AND id::text = %s
            LIMIT 1""",
        (tenant_id, reference.identifier),
    )
    row = cur.fetchone()
    if row is None:
        return None
    experiment_id = _identifier(row["id"])
    source = {
        "id": experiment_id,
        "title": _text(row["title"], 240, required=True),
        "updatedAt": _timestamp(row["updated_at"]),
    }
    results = _text(row["results"], 4000)
    interpretation = _text(row["interpretation"], 4000)
    if results:
        source["results"] = results
    if interpretation:
        source["interpretation"] = interpretation
    return {
        "requestedRef": reference.wire,
        "status": "resolved",
        "resolvedRef": reference.wire,
        "provider": "galaxy-brain-eln",
        "sourceKind": "eln.experiment",
        "source": source,
    }


def _observation(cur, tenant_id: str, reference) -> dict | None:
    digest = _digest(reference.revision)
    if reference.revision is not None and digest is None:
        return None
    cur.execute(
        """SELECT observation.id, observation.experiment_id,
                  observation.created_by_principal_id, observation.created_at,
                  revision.version, revision.body, revision.observed_at,
                  revision.revision_sha256
             FROM gb_eln_observations AS observation
             JOIN gb_eln_observation_revisions AS revision
               ON revision.tenant_id = observation.tenant_id
              AND revision.observation_id = observation.id
            WHERE observation.tenant_id = %s AND observation.id::text = %s
              AND (%s::text IS NULL OR revision.revision_sha256 = %s)
            ORDER BY revision.version DESC LIMIT 1""",
        (tenant_id, reference.identifier, digest, digest),
    )
    row = cur.fetchone()
    if row is None:
        return None
    observation_id = _uuid(row["id"])
    revision_sha256 = _hash(row["revision_sha256"])
    source = {
        "id": observation_id,
        "experimentId": _identifier(row["experiment_id"]),
        "version": row["version"],
        "revisionSha256": revision_sha256,
        "body": _text(row["body"], 4000, required=True),
        "observedAt": _timestamp(row["observed_at"]),
        "createdAt": _timestamp(row["created_at"]),
        "createdByPrincipalId": _uuid(row["created_by_principal_id"]),
    }
    return _resolved(
        reference.wire,
        _wire("eln.observation", observation_id, revision_sha256),
        "galaxy-brain-eln",
        "eln.observation",
        source,
    )
def _surface(cur, tenant_id: str, reference, response_schema: str) -> dict | None:
    digest = _digest(reference.revision)
    if reference.revision is not None and digest is None:
        return None
    if digest is None:
        cur.execute(
            """SELECT id, title, status, catalog_id, current_version, current_content_hash,
                      schema_digest, catalog_digest, renderer_version,
                      TRUE AS placement_eligible
                 FROM gb_surfaces
                WHERE tenant_id = %s AND id::text = %s AND deleted_at IS NULL
                  AND status = 'promoted'
                LIMIT 1""",
            (tenant_id, reference.identifier),
        )
    else:
        cur.execute(
            """SELECT surface.id, revision.title, revision.status, surface.catalog_id,
                      revision.version AS current_version,
                      revision.content_hash AS current_content_hash,
                      revision.schema_digest, revision.catalog_digest,
                      revision.renderer_version,
                      (surface.status = 'promoted'
                       AND surface.current_version = revision.version
                       AND surface.current_content_hash = revision.content_hash)
                        AS placement_eligible
                 FROM gb_surfaces AS surface
                 JOIN gb_surface_revisions AS revision
                   ON revision.tenant_id = surface.tenant_id
                  AND revision.surface_id = surface.id
                WHERE surface.tenant_id = %s AND surface.id::text = %s
                  AND surface.deleted_at IS NULL AND revision.content_hash = %s
                  AND revision.status = 'promoted'
                LIMIT 1""",
            (tenant_id, reference.identifier, digest),
        )
    row = cur.fetchone()
    if row is None:
        return None
    surface_id = _identifier(row["id"])
    content_hash = _hash(row["current_content_hash"])
    current_version = row["current_version"]
    if isinstance(current_version, bool) or not isinstance(current_version, int) or current_version < 1:
        raise ProjectionSourceProviderError("Projection source contains an invalid surface version")
    source = {
        "id": surface_id,
        "title": _text(row["title"], 240, required=True),
        "status": _text(row["status"], 32, required=True),
        "catalogId": _text(row["catalog_id"], 120, required=True),
        "currentVersion": current_version,
        "currentContentHash": content_hash,
    }
    if response_schema == RESPONSE_SCHEMA:
        source["schemaDigest"] = _hash(row["schema_digest"])
        source["catalogDigest"] = _hash(row["catalog_digest"])
        source["rendererVersion"] = _text(row["renderer_version"], 200, required=True)
        source["placementEligible"] = row["placement_eligible"] is True
    return _resolved(
        reference.wire,
        _wire("surface", surface_id, content_hash),
        "galaxy.surface",
        "surface",
        source,
    )


def _chat(cur, tenant_id: str, reference) -> dict | None:
    digest = _digest(reference.revision)
    if digest is None:
        return None
    cur.execute(
        """SELECT conversation.id, conversation.workspace_id, conversation.title,
                  conversation.goal, revision.version, revision.content_hash,
                  COALESCE((
                    SELECT count(*)
                      FROM gb_conversation_edges AS edge
                     WHERE edge.tenant_id = conversation.tenant_id
                       AND edge.conversation_id = conversation.id
                       AND edge.edge_kind = 'forks'
                       AND edge.introduced_in_version <= revision.version
                  ), 0) AS branch_count
             FROM gb_conversations AS conversation
             JOIN gb_conversation_revisions AS revision
               ON revision.tenant_id = conversation.tenant_id
              AND revision.conversation_id = conversation.id
            WHERE conversation.tenant_id = %s
              AND conversation.id::text = %s
              AND revision.content_hash = %s
            LIMIT 1""",
        (tenant_id, reference.identifier, f"sha256:{digest}"),
    )
    row = cur.fetchone()
    if row is None:
        return None
    conversation_id = _uuid(row["id"])
    if conversation_id != reference.identifier:
        raise ProjectionSourceProviderError("Projection source changed the requested conversation identity")
    content_hash = _hash(str(row["content_hash"]).removeprefix("sha256:"))
    if content_hash != digest:
        raise ProjectionSourceProviderError("Projection source changed the requested conversation revision")
    version = row["version"]
    branch_count = row["branch_count"]
    if (
        isinstance(version, bool) or not isinstance(version, int) or not 1 <= version <= 1_000_001
        or isinstance(branch_count, bool) or not isinstance(branch_count, int)
        or not 0 <= branch_count <= version - 1
    ):
        raise ProjectionSourceProviderError("Projection source contains invalid conversation counts")
    source = {
        "conversationId": conversation_id,
        "workspaceId": _identifier(row["workspace_id"], 128),
        "title": _text(row["title"], 240, required=True),
        "goalSummary": _text(row["goal"], 4000, required=True),
        "version": version,
        "contentSha256": content_hash,
        "turnCount": version - 1,
        "branchCount": branch_count,
    }
    return _resolved(
        reference.wire,
        _wire("chat", conversation_id, content_hash),
        "galaxy.conversation",
        "chat",
        source,
    )


def _proof(cur, tenant_id: str, reference) -> dict | None:
    digest = _digest(reference.revision)
    if digest is None:
        return None
    if reference.kind == "proof.graph":
        cur.execute(
            """SELECT graph_id, title, content_sha256
                 FROM gb_proof_graphs
                WHERE tenant_id = %s AND graph_id = %s AND content_sha256 = %s
                LIMIT 1""",
            (tenant_id, reference.identifier, digest),
        )
        row = cur.fetchone()
        if row is None:
            return None
        graph_id = _identifier(row["graph_id"])
        content_hash = _hash(row["content_sha256"])
        source = {
            "graphId": graph_id,
            "title": _text(row["title"], 240, required=True),
            "contentSha256": content_hash,
        }
        return _resolved(
            reference.wire,
            _wire("proof.graph", graph_id, content_hash),
            "galaxy.proof",
            "proof.graph",
            source,
        )
    cur.execute(
        """SELECT content_sha256,
                  graph_json -> 'targets' -> (array_position(node_ref_ids, %s) - 1)
                    ->> 'title' AS target_title,
                  graph_json -> 'targets' -> (array_position(node_ref_ids, %s) - 1)
                    ->> 'natural_language_summary' AS target_summary
             FROM gb_proof_graphs
            WHERE tenant_id = %s AND %s = ANY(node_ref_ids) AND content_sha256 = %s
            LIMIT 1""",
        (reference.identifier, reference.identifier, tenant_id, reference.identifier, digest),
    )
    row = cur.fetchone()
    if row is None:
        return None
    content_hash = _hash(row["content_sha256"])
    source = {
        "nodeRefId": reference.identifier,
        "title": _text(row["target_title"], 240, required=True),
        "contentSha256": content_hash,
    }
    summary = _text(row["target_summary"], 4000)
    if summary:
        source["summary"] = summary
    return _resolved(
        reference.wire,
        _wire("proof.node", reference.identifier, content_hash),
        "galaxy.proof",
        "proof.node",
        source,
    )


def _resolve_one(cur, tenant_id: str, reference, response_schema: str) -> dict | None:
    if reference.kind not in _SUPPORTED_KINDS:
        return None
    if reference.kind == "paper":
        return _paper(cur, tenant_id, reference, response_schema)
    if reference.kind == "surface":
        return _surface(cur, tenant_id, reference, response_schema)
    resolver = {
        "document": _document,
        "document.anchor": _document_anchor,
        "eln.experiment": _experiment,
        "eln.observation": _observation,
        "chat": _chat,
        "proof.graph": _proof,
        "proof.node": _proof,
    }[reference.kind]
    return resolver(cur, tenant_id, reference)


def resolve_projection_sources(
    conn,
    tenant_id: str,
    principal_id: str,
    references: Iterable[str],
    response_schema: str = RESPONSE_SCHEMA,
) -> dict:
    """Resolve a validated batch in one RLS-bound transaction snapshot."""
    if response_schema not in {RESPONSE_SCHEMA_V1, RESPONSE_SCHEMA_V2, RESPONSE_SCHEMA}:
        raise ProjectionSourceRequestError("Unsupported projection response schema")
    try:
        canonical = [parse_canonical_reference(value) for value in references]
    except ObjectLinkError as error:
        raise ProjectionSourceRequestError(
            "Projection reference batch contains an invalid canonical reference"
        ) from error
    if any(reference.wire != value for reference, value in zip(canonical, references)):
        raise ProjectionSourceRequestError(
            "Projection reference batch contains a noncanonical reference"
        )
    wires = [reference.wire for reference in canonical]
    if not 1 <= len(canonical) <= MAX_REFERENCES or len(set(wires)) != len(wires):
        raise ProjectionSourceRequestError("Projection reference batch is out of bounds")
    cur = conn.cursor()
    cur.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    try:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
        cur.execute("SELECT set_config('app.principal_id', %s, true)", (principal_id,))
        results = []
        for reference in canonical:
            result = _resolve_one(cur, tenant_id, reference, response_schema)
            results.append(result if result is not None else _unavailable(reference.wire))
        response = {"schemaId": response_schema, "results": results}
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_RESPONSE_BYTES:
            raise ProjectionSourceProviderError("Projection source response exceeds its limit")
    except BaseException:
        cur.execute("ROLLBACK")
        raise
    else:
        cur.execute("COMMIT")
        return response
