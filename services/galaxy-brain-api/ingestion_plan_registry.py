"""Code-owned, non-executable ingestion plan catalog."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from typing import Any, Optional

from durable_ingestion import IngestionContractError


INGESTION_PLAN_SCHEMA_ID = "gb.ingestion-plan.v1"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_DOCUMENT_UPLOAD_PLAN = {
    "schemaId": INGESTION_PLAN_SCHEMA_ID,
    "id": "document.upload-default",
    "version": "1.0.0",
    "owner": {"pluginId": "documents", "pluginVersion": "1.0.0"},
    "implementationId": "builtin.ingestion-plan.document-upload-default",
    "source": {
        "contributionId": "document.upload",
        "implementationId": "builtin.document.upload-source",
    },
    "persist": {
        "routeId": "document.import-route",
        "implementationId": "builtin.document.import-route",
        "originalRequired": True,
    },
    "transformPolicy": {
        "implementationId": "builtin.document-transform-policy.structure-first-v1",
        "transforms": [
            {"contributionId": "docling.convert", "implementationId": "builtin.docling.convert"},
            {"contributionId": "markitdown.convert", "implementationId": "builtin.markitdown.convert"},
            {"contributionId": "plain-text.convert", "implementationId": "builtin.plain-text.convert"},
        ],
    },
    "output": {"kind": "document", "revisionPolicy": "pinned"},
    "contentSha256": "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66",
}
_DATASOURCE_FILE_PLAN = {
    "schemaId": INGESTION_PLAN_SCHEMA_ID,
    "id": "datasource.file-default",
    "version": "1.0.0",
    "owner": {"pluginId": "datasources", "pluginVersion": "1.0.0"},
    "implementationId": "builtin.ingestion-plan.datasource-file-default",
    "source": {
        "contributionId": "datasource.connected",
        "implementationId": "builtin.datasource.connected-source",
    },
    "persist": {
        "routeId": "document.import-route",
        "implementationId": "builtin.document.import-route",
        "originalRequired": True,
    },
    "transformPolicy": {
        "implementationId": "builtin.document-transform-policy.structure-first-v1",
        "transforms": [
            {"contributionId": "docling.convert", "implementationId": "builtin.docling.convert"},
            {"contributionId": "markitdown.convert", "implementationId": "builtin.markitdown.convert"},
            {"contributionId": "plain-text.convert", "implementationId": "builtin.plain-text.convert"},
        ],
    },
    "output": {"kind": "document", "revisionPolicy": "pinned"},
    "contentSha256": "e3f23ff9cfc350e5a29d3efb897b96bee480bae0375dba83bea1d15cfc5b68d3",
}
_WEB_CAPTURE_PLAN = {
    "schemaId": INGESTION_PLAN_SCHEMA_ID,
    "id": "web.capture-default",
    "version": "1.0.0",
    "owner": {"pluginId": "web-capture", "pluginVersion": "1.0.0"},
    "implementationId": "builtin.ingestion-plan.web-capture-default",
    "source": {
        "contributionId": "web.capture",
        "implementationId": "builtin.web.capture-source",
    },
    "persist": {
        "routeId": "document.import-route",
        "implementationId": "builtin.document.import-route",
        "originalRequired": True,
    },
    "transformPolicy": {
        "implementationId": "builtin.document-transform-policy.structure-first-v1",
        "transforms": [
            {"contributionId": "docling.convert", "implementationId": "builtin.docling.convert"},
            {"contributionId": "markitdown.convert", "implementationId": "builtin.markitdown.convert"},
            {"contributionId": "plain-text.convert", "implementationId": "builtin.plain-text.convert"},
        ],
    },
    "output": {"kind": "document", "revisionPolicy": "pinned"},
    "contentSha256": "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8",
}
_ARXIV_FETCH_PLAN = {
    "schemaId": INGESTION_PLAN_SCHEMA_ID,
    "id": "arxiv.fetch-default",
    "version": "1.0.0",
    "owner": {"pluginId": "papers", "pluginVersion": "1.0.0"},
    "implementationId": "builtin.ingestion-plan.arxiv-fetch-default",
    "source": {
        "contributionId": "arxiv.pdf",
        "implementationId": "builtin.arxiv.pdf-source",
    },
    "persist": {
        "routeId": "arxiv.private-fetch-route",
        "implementationId": "builtin.arxiv.private-fetch-route",
        "originalRequired": True,
    },
    "transformPolicy": {
        "implementationId": "builtin.document-transform-policy.structure-first-v1",
        "transforms": [
            {"contributionId": "docling.convert", "implementationId": "builtin.docling.convert"},
            {"contributionId": "markitdown.convert", "implementationId": "builtin.markitdown.convert"},
            {"contributionId": "plain-text.convert", "implementationId": "builtin.plain-text.convert"},
        ],
    },
    "output": {"kind": "document", "revisionPolicy": "pinned"},
    "contentSha256": "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a",
}
_PLAN_CATALOG = {
    (plan["id"], plan["version"], plan["contentSha256"]): plan
    for plan in (_DOCUMENT_UPLOAD_PLAN, _DATASOURCE_FILE_PLAN, _WEB_CAPTURE_PLAN, _ARXIV_FETCH_PLAN)
}
_PLAN_SOURCE_KINDS = {
    "document.upload": "upload",
    "datasource.connected": "datasource",
    "web.capture": "url",
    "arxiv.pdf": "arxiv",
}


def canonical_ingestion_plan_json(value: dict) -> str:
    payload = {key: item for key, item in value.items() if key != "contentSha256"}
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def ingestion_plan_content_sha256(value: dict) -> str:
    return hashlib.sha256(canonical_ingestion_plan_json(value).encode("utf-8")).hexdigest()


def resolve_ingestion_plan_claim(value: Optional[Any]) -> Optional[dict]:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"id", "version", "contentSha256"}:
        raise IngestionContractError("ingestion plan claim is invalid")
    if not all(isinstance(value.get(key), str) for key in ("id", "version", "contentSha256")):
        raise IngestionContractError("ingestion plan claim is invalid")
    if not _SHA256.fullmatch(value["contentSha256"]):
        raise IngestionContractError("ingestion plan claim hash is invalid")
    plan = _PLAN_CATALOG.get((value["id"], value["version"], value["contentSha256"]))
    if plan is None:
        raise IngestionContractError("ingestion plan is not registered")
    if ingestion_plan_content_sha256(plan) != plan["contentSha256"]:
        raise IngestionContractError("registered ingestion plan hash is invalid")
    return deepcopy(plan)


def ingestion_plan_expected_source_kind(value: dict) -> str:
    source = value.get("source") if isinstance(value, dict) else None
    contribution_id = source.get("contributionId") if isinstance(source, dict) else None
    source_kind = _PLAN_SOURCE_KINDS.get(contribution_id)
    if source_kind is None:
        raise IngestionContractError("ingestion plan does not have a source-kind binding")
    return source_kind


def resolve_stored_ingestion_plan_evidence(value: Optional[Any]) -> Optional[dict]:
    """Validate a self-contained immutable v1 snapshot without a live plugin dependency."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {
        "schemaId", "id", "version", "owner", "implementationId", "source",
        "persist", "transformPolicy", "output", "contentSha256",
    }:
        raise IngestionContractError("stored ingestion plan evidence is invalid")
    owner = value.get("owner")
    source = value.get("source")
    persist = value.get("persist")
    policy = value.get("transformPolicy")
    output = value.get("output")
    transforms = policy.get("transforms") if isinstance(policy, dict) else None
    stable_ids = [
        value.get("id"), value.get("implementationId"),
        owner.get("pluginId") if isinstance(owner, dict) else None,
        source.get("contributionId") if isinstance(source, dict) else None,
        source.get("implementationId") if isinstance(source, dict) else None,
        persist.get("routeId") if isinstance(persist, dict) else None,
        persist.get("implementationId") if isinstance(persist, dict) else None,
        policy.get("implementationId") if isinstance(policy, dict) else None,
    ]
    valid_transforms = (
        isinstance(transforms, list)
        and 1 <= len(transforms) <= 16
        and all(
            isinstance(item, dict)
            and set(item) == {"contributionId", "implementationId"}
            and all(isinstance(item.get(key), str) and _ID.fullmatch(item[key]) for key in item)
            for item in transforms
        )
        and len({item["contributionId"] for item in transforms}) == len(transforms)
    )
    if (
        value.get("schemaId") != INGESTION_PLAN_SCHEMA_ID
        or not all(isinstance(item, str) and _ID.fullmatch(item) for item in stable_ids)
        or not isinstance(value.get("version"), str) or not _VERSION.fullmatch(value["version"])
        or not isinstance(owner, dict) or set(owner) != {"pluginId", "pluginVersion"}
        or not isinstance(owner.get("pluginVersion"), str) or not _VERSION.fullmatch(owner["pluginVersion"])
        or not isinstance(source, dict) or set(source) != {"contributionId", "implementationId"}
        or not isinstance(persist, dict)
        or set(persist) != {"routeId", "implementationId", "originalRequired"}
        or persist.get("originalRequired") is not True
        or not isinstance(policy, dict) or set(policy) != {"implementationId", "transforms"}
        or not valid_transforms
        or not isinstance(output, dict) or set(output) != {"kind", "revisionPolicy"}
        or output != {"kind": "document", "revisionPolicy": "pinned"}
        or not isinstance(value.get("contentSha256"), str)
        or not _SHA256.fullmatch(value["contentSha256"])
        or ingestion_plan_content_sha256(value) != value["contentSha256"]
    ):
        raise IngestionContractError("stored ingestion plan evidence is invalid")
    return deepcopy(value)
