import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request

from object_projection_sources import (
    MAX_TRANSFORM_RECEIPTS,
    MAX_REFERENCES,
    ProjectionSourceProviderError,
    ProjectionSourceRequestError,
    REQUEST_SCHEMA,
    REQUEST_SCHEMA_V1,
    REQUEST_SCHEMA_V2,
    RESPONSE_SCHEMA,
    RESPONSE_SCHEMA_V1,
    RESPONSE_SCHEMA_V2,
    parse_projection_source_request,
    resolve_projection_sources,
)
from surface_contract import CATALOG_DIGEST, RENDERER_VERSION, SCHEMA_DIGEST


TENANT = "10000000-0000-4000-8000-000000000001"
OTHER_TENANT = "10000000-0000-4000-8000-000000000002"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
PAPER_ID = "30000000-0000-4000-8000-000000000001"
DOCUMENT_ID = "40000000-0000-4000-8000-000000000001"
REVISION_ID = "50000000-0000-4000-8000-000000000001"
REPRESENTATION_ID = "60000000-0000-4000-8000-000000000001"
RECEIPT_ID = "70000000-0000-4000-8000-000000000001"
CONVERSATION_ID = "80000000-0000-4000-8000-000000000001"
DIGEST = "a" * 64
OTHER_DIGEST = "b" * 64


def reference(kind, identifier, digest=None):
    encoded_id = identifier.replace(":", "%3A").replace("#", "%23")
    if digest is None:
        return f"gb:object:v1:{kind}:{encoded_id}:latest"
    return f"gb:object:v1:{kind}:{encoded_id}:pinned:sha256%3A{digest}"


def body(references, schema=REQUEST_SCHEMA):
    return json.dumps({
        "schemaId": schema,
        "references": references,
    }, separators=(",", ":")).encode()


def document_row():
    return {
        "document_id": DOCUMENT_ID,
        "revision_id": REVISION_ID,
        "revision_sha256": DIGEST,
        "title": "Notebook",
        "display_filename": "notebook.md",
        "media_type": "text/markdown; charset=utf-8",
    }


def conversation_row(**overrides):
    return {
        "id": CONVERSATION_ID,
        "workspace_id": "research-field",
        "title": "Pinned research chat",
        "goal": "Compare exact proof obligations.",
        "version": 5,
        "content_hash": f"sha256:{DIGEST}",
        "branch_count": 2,
        **overrides,
    }


def transform_receipt(receipt_id, representations, *, fallback_receipt_id=None):
    first = representations[0] if representations else None
    return {
        "id": receipt_id,
        "output_representation_id": first["id"] if first else None,
        "output_sha256": first["contentSha256"] if first else None,
        "output_manifest": {
            "schemaId": "gb.transform-output-manifest.v1",
            "representations": representations,
        },
        "fallback_receipt_id": fallback_receipt_id,
    }


def representation_row(representation_id, digest=OTHER_DIGEST, kind="markdown"):
    return {
        "id": representation_id,
        "kind": kind,
        "media_type": (
            "application/vnd.galaxy.document-structure+json"
            if kind == "document-structure" else "text/markdown; charset=utf-8"
        ),
        "content_sha256": digest,
    }


def raw_request(encoded, *, private_marker=None):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": encoded, "more_body": False}

    headers = []
    if private_marker is not None:
        headers.append((b"x-gb-projection-gateway", private_marker.encode()))
    return Request({
        "type": "http", "method": "POST", "path": "/object-projection-sources/resolve",
        "query_string": b"", "headers": headers,
    }, receive)


class Cursor:
    def __init__(self, *, one=None, many=None, fail_on=None):
        self.one = list(one or [])
        self.many = list(many or [])
        self.fail_on = fail_on
        self.executions = []

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.executions.append((normalized, parameters))
        if self.fail_on and self.fail_on in normalized:
            raise ProjectionSourceProviderError("simulated provider failure")

    def fetchone(self):
        return self.one.pop(0)

    def fetchall(self):
        return self.many.pop(0)


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class ProjectionSourceRequestTests(unittest.TestCase):
    def test_private_post_route_is_registered(self):
        from server import app

        route = next(
            item for item in app.routes
            if getattr(item, "path", None) == "/object-projection-sources/resolve"
        )
        self.assertEqual(route.methods, {"POST"})

    def test_strict_request_accepts_canonical_refs_in_input_order(self):
        refs = [reference("paper", PAPER_ID), reference("chat", "thread-1")]
        self.assertEqual(parse_projection_source_request(body(refs)), refs)
        self.assertEqual(parse_projection_source_request(body(refs, REQUEST_SCHEMA_V2)), refs)
        self.assertEqual(parse_projection_source_request(body(refs, REQUEST_SCHEMA_V1)), refs)
        self.assertEqual(
            parse_projection_source_request(body(refs), include_schema=True),
            (REQUEST_SCHEMA, refs),
        )

    def test_request_rejects_duplicate_fields_references_and_unknown_fields(self):
        duplicate_field = (
            b'{"schemaId":"' + REQUEST_SCHEMA.encode() +
            b'","schemaId":"' + REQUEST_SCHEMA.encode() +
            b'","references":["' + reference("paper", PAPER_ID).encode() + b'"]}'
        )
        invalid = [
            duplicate_field,
            body([reference("paper", PAPER_ID), reference("paper", PAPER_ID)]),
            json.dumps({"schemaId": REQUEST_SCHEMA, "references": [], "extra": True}).encode(),
            json.dumps({"schemaId": REQUEST_SCHEMA, "references": ["gb:node:1"]}).encode(),
            body([f"gb:object:v1:paper:%c3%a9:latest"]),
            body([reference("chat", str(index)) for index in range(MAX_REFERENCES + 1)]),
            (b'{"schemaId":"' + REQUEST_SCHEMA.encode() + b'","references":' + b"[" * 1200 + b"0" + b"]" * 1200 + b"}"),
        ]
        for encoded in invalid:
            with self.subTest(encoded=encoded[:80]), self.assertRaises(ProjectionSourceRequestError):
                parse_projection_source_request(encoded)

    def test_request_byte_limit_is_applied_before_json_parsing(self):
        with self.assertRaises(ProjectionSourceRequestError) as caught:
            parse_projection_source_request(b"{" + b" " * 65_536)
        self.assertEqual(caught.exception.status_code, 413)


class ProjectionSourceRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_headerless_v1_request_remains_compatible_during_rolling_upgrade(self):
        from server import IdentityContext, resolve_object_projection_source_batch

        identity = IdentityContext(TENANT, PRINCIPAL, "human")
        unavailable = {
            "schemaId": RESPONSE_SCHEMA_V1,
            "results": [{"requestedRef": reference("paper", PAPER_ID), "status": "unavailable"}],
        }
        with patch("server.run_in_threadpool", new=AsyncMock(return_value=unavailable)):
            result = await resolve_object_projection_source_batch(
                raw_request(body([reference("paper", PAPER_ID)], REQUEST_SCHEMA_V1)), identity,
            )
        self.assertEqual(result, unavailable)

    async def test_headerless_v3_request_is_rejected_as_a_version_mismatch(self):
        from server import IdentityContext, resolve_object_projection_source_batch

        identity = IdentityContext(TENANT, PRINCIPAL, "human")
        with self.assertRaises(HTTPException) as caught:
            await resolve_object_projection_source_batch(
                raw_request(body([reference("paper", PAPER_ID)])), identity,
            )
        self.assertEqual(caught.exception.status_code, 422)

    async def test_private_gateway_marker_must_match_the_versioned_body(self):
        from server import IdentityContext, resolve_object_projection_source_batch

        identity = IdentityContext(TENANT, PRINCIPAL, "human")
        for marker, encoded in [
            ("v1", body([reference("paper", PAPER_ID)], REQUEST_SCHEMA)),
            ("v2", body([reference("paper", PAPER_ID)], REQUEST_SCHEMA)),
            ("v3", body([reference("paper", PAPER_ID)], REQUEST_SCHEMA_V2)),
            ("v2", body([reference("paper", PAPER_ID)], REQUEST_SCHEMA_V1)),
        ]:
            with self.subTest(marker=marker), self.assertRaises(HTTPException) as caught:
                await resolve_object_projection_source_batch(
                    raw_request(encoded, private_marker=marker), identity,
                )
            self.assertEqual(caught.exception.status_code, 422)


class ProjectionSourceResolutionTests(unittest.TestCase):
    def test_observation_latest_resolves_to_the_exact_pinned_revision(self):
        observation_id = "90000000-0000-4000-8000-000000000001"
        cursor = Cursor(one=[{
            "id": observation_id,
            "experiment_id": "experiment-1",
            "created_by_principal_id": PRINCIPAL,
            "created_at": "2026-09-28T16:31:00Z",
            "version": 1,
            "body": "Stable reading",
            "observed_at": "2026-09-28T16:30:00Z",
            "revision_sha256": DIGEST,
        }])
        requested = reference("eln.observation", observation_id)
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [requested],
        )["results"][0]
        self.assertEqual(result["requestedRef"], requested)
        self.assertEqual(result["resolvedRef"], reference("eln.observation", observation_id, DIGEST))
        self.assertEqual(result["sourceKind"], "eln.observation")
        self.assertEqual(result["source"]["body"], "Stable reading")

    def test_one_snapshot_preserves_order_and_conflates_unavailable_results(self):
        refs = [reference("chat", "not-supported"), reference("eln.experiment", "missing")]
        cursor = Cursor(one=[None])
        result = resolve_projection_sources(Connection(cursor), TENANT, PRINCIPAL, refs)

        self.assertEqual(result["schemaId"], RESPONSE_SCHEMA)
        self.assertEqual(result["results"], [
            {"requestedRef": refs[0], "status": "unavailable"},
            {"requestedRef": refs[1], "status": "unavailable"},
        ])
        statements = [item[0] for item in cursor.executions]
        self.assertEqual(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        self.assertEqual(statements[1], "SELECT set_config('app.tenant_id', %s, true)")
        self.assertEqual(cursor.executions[1][1], (TENANT,))
        self.assertEqual(statements[2], "SELECT set_config('app.principal_id', %s, true)")
        self.assertEqual(cursor.executions[2][1], (PRINCIPAL,))
        self.assertEqual(statements[-1], "COMMIT")
        lookup, parameters = cursor.executions[3]
        self.assertIn("WHERE tenant_id = %s AND id::text = %s", lookup)
        self.assertEqual(parameters, (TENANT, "missing"))

    def test_provider_failure_rolls_back_the_snapshot(self):
        cursor = Cursor(fail_on="FROM gb_experiments")
        with self.assertRaises(ProjectionSourceProviderError):
            resolve_projection_sources(
                Connection(cursor), TENANT, PRINCIPAL,
                [reference("eln.experiment", "experiment-1")],
            )
        self.assertEqual(cursor.executions[-1][0], "ROLLBACK")
        self.assertNotIn("COMMIT", [item[0] for item in cursor.executions])

    def test_pinned_chat_source_is_tenant_scoped_revision_exact_and_body_free(self):
        requested = reference("chat", CONVERSATION_ID, DIGEST)
        cursor = Cursor(one=[conversation_row()])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [requested],
        )["results"][0]

        self.assertEqual(result, {
            "requestedRef": requested,
            "status": "resolved",
            "resolvedRef": requested,
            "provider": "galaxy.conversation",
            "sourceKind": "chat",
            "source": {
                "conversationId": CONVERSATION_ID,
                "workspaceId": "research-field",
                "title": "Pinned research chat",
                "goalSummary": "Compare exact proof obligations.",
                "version": 5,
                "contentSha256": DIGEST,
                "turnCount": 4,
                "branchCount": 2,
            },
        })
        encoded = json.dumps(result)
        for forbidden in ("turns", "messages", "artifacts", "rawBody", "content"):
            self.assertNotIn(f'"{forbidden}"', encoded)

        lookup, parameters = next(
            item for item in cursor.executions if "FROM gb_conversations AS conversation" in item[0]
        )
        self.assertIn("conversation.tenant_id = %s", lookup)
        self.assertIn("revision.tenant_id = conversation.tenant_id", lookup)
        self.assertIn("revision.content_hash = %s", lookup)
        self.assertIn("edge.tenant_id = conversation.tenant_id", lookup)
        self.assertIn("edge.conversation_id = conversation.id", lookup)
        self.assertIn("edge.edge_kind = 'forks'", lookup)
        self.assertIn("edge.introduced_in_version <= revision.version", lookup)
        self.assertEqual(parameters, (TENANT, CONVERSATION_ID, f"sha256:{DIGEST}"))

    def test_chat_latest_is_unavailable_without_query_and_cross_tenant_absence_is_opaque(self):
        latest = reference("chat", CONVERSATION_ID)
        cursor = Cursor()
        result = resolve_projection_sources(Connection(cursor), TENANT, PRINCIPAL, [latest])
        self.assertEqual(result["results"], [{"requestedRef": latest, "status": "unavailable"}])
        self.assertFalse(any("FROM gb_conversations" in statement for statement, _ in cursor.executions))

        pinned = reference("chat", CONVERSATION_ID, DIGEST)
        other_cursor = Cursor(one=[None])
        other_result = resolve_projection_sources(
            Connection(other_cursor), OTHER_TENANT, PRINCIPAL, [pinned],
        )["results"][0]
        self.assertEqual(other_result, {"requestedRef": pinned, "status": "unavailable"})
        lookup, parameters = next(
            item for item in other_cursor.executions if "FROM gb_conversations" in item[0]
        )
        self.assertIn("conversation.tenant_id = %s", lookup)
        self.assertEqual(parameters, (OTHER_TENANT, CONVERSATION_ID, f"sha256:{DIGEST}"))

    def test_chat_source_rejects_identity_revision_and_count_drift_with_rollback(self):
        requested = reference("chat", CONVERSATION_ID, DIGEST)
        invalid_rows = [
            conversation_row(id="80000000-0000-4000-8000-000000000002"),
            conversation_row(content_hash=f"sha256:{OTHER_DIGEST}"),
            conversation_row(version=0),
            conversation_row(version=1_000_002),
            conversation_row(branch_count=-1),
            conversation_row(branch_count=5),
        ]
        for row in invalid_rows:
            with self.subTest(row=row):
                cursor = Cursor(one=[row])
                with self.assertRaises(ProjectionSourceProviderError):
                    resolve_projection_sources(
                        Connection(cursor), TENANT, PRINCIPAL, [requested],
                    )
                self.assertEqual(cursor.executions[-1][0], "ROLLBACK")
                self.assertNotIn("COMMIT", [item[0] for item in cursor.executions])

    def test_paper_source_is_pinned_camel_case_and_contains_no_pdf_or_url(self):
        row = {
            "id": PAPER_ID,
            "revision_id": REVISION_ID,
            "metadata_hash": DIGEST,
            "revision_title": "A useful paper",
            "revision_abstract": "A" * 5000,
            "document_id": DOCUMENT_ID,
            "document_revision_id": REVISION_ID,
            "document_revision_sha256": DIGEST,
            "document_sha256": OTHER_DIGEST,
            "document_media_type": "application/pdf",
            "document_filename": "paper.pdf",
        }
        cursor = Cursor(one=[row])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [reference("paper", PAPER_ID)],
        )["results"][0]
        self.assertEqual(result["resolvedRef"], reference("paper", PAPER_ID, DIGEST))
        self.assertEqual(result["sourceKind"], "paper")
        self.assertEqual(set(result["source"]), {"paper", "revision"})
        self.assertEqual(result["source"]["paper"]["metadataHash"], DIGEST)
        self.assertEqual(len(result["source"]["paper"]["abstract"]), 4000)
        self.assertEqual(result["source"]["revision"]["document"], {
            "ref": reference("document", DOCUMENT_ID, DIGEST),
            "documentId": DOCUMENT_ID,
            "revisionId": REVISION_ID,
            "revisionSha256": DIGEST,
            "contentSha256": OTHER_DIGEST,
            "mediaType": "application/pdf",
            "displayFilename": "paper.pdf",
        })
        encoded = json.dumps(result)
        for forbidden in ("pdfBytes", "sourceUrl", "tenantId", "principalId"):
            self.assertNotIn(forbidden, encoded)
        lookup = next(item for item in cursor.executions if "FROM gb_papers AS paper" in item[0])
        self.assertNotIn("arxiv_id", lookup[0])
        self.assertEqual(lookup[1], (TENANT, PAPER_ID, None))

    def test_v1_paper_source_preserves_legacy_shape_during_rolling_deploy(self):
        row = {
            "id": PAPER_ID,
            "revision_id": REVISION_ID,
            "metadata_hash": DIGEST,
            "revision_title": "A useful paper",
            "revision_abstract": "Evidence",
            "document_id": DOCUMENT_ID,
            "document_revision_id": REVISION_ID,
            "document_revision_sha256": DIGEST,
            "document_sha256": OTHER_DIGEST,
            "document_media_type": "application/pdf",
            "document_filename": "durable-paper.pdf",
            "legacy_document_sha256": OTHER_DIGEST,
            "legacy_document_media_type": "application/pdf",
            "legacy_document_filename": "legacy-paper.pdf",
        }
        result = resolve_projection_sources(
            Connection(Cursor(one=[row])), TENANT, PRINCIPAL,
            [reference("paper", PAPER_ID)], RESPONSE_SCHEMA_V1,
        )
        self.assertEqual(result["schemaId"], RESPONSE_SCHEMA_V1)
        self.assertEqual(result["results"][0]["source"]["revision"]["document"], {
            "contentSha256": OTHER_DIGEST,
            "mediaType": "application/pdf",
            "filename": "legacy-paper.pdf",
        })

    def test_empty_optional_projector_fields_are_omitted(self):
        paper_cursor = Cursor(one=[{
            "id": PAPER_ID, "revision_id": REVISION_ID, "metadata_hash": DIGEST,
            "revision_title": "Paper", "revision_abstract": "   ",
            "document_id": None, "document_revision_id": None,
            "document_revision_sha256": None,
            "document_sha256": None, "document_media_type": None, "document_filename": None,
        }])
        paper = resolve_projection_sources(
            Connection(paper_cursor), TENANT, PRINCIPAL, [reference("paper", PAPER_ID)],
        )["results"][0]["source"]["paper"]
        self.assertNotIn("abstract", paper)

        experiment_cursor = Cursor(one=[{
            "id": "experiment-1", "title": "Experiment", "results": "",
            "interpretation": "  ", "updated_at": "2026-09-24T00:00:00Z",
        }])
        experiment = resolve_projection_sources(
            Connection(experiment_cursor), TENANT, PRINCIPAL,
            [reference("eln.experiment", "experiment-1")],
        )["results"][0]["source"]
        self.assertNotIn("results", experiment)
        self.assertNotIn("interpretation", experiment)

        proof_cursor = Cursor(one=[{
            "content_sha256": DIGEST,
            "target_title": "Target", "target_summary": "",
        }])
        proof = resolve_projection_sources(
            Connection(proof_cursor), TENANT, PRINCIPAL,
            [reference("proof.node", "graph-1#target-1", DIGEST)],
        )["results"][0]["source"]
        self.assertNotIn("summary", proof)

    def test_document_source_lists_only_bounded_representation_metadata(self):
        row = {
            "document_id": DOCUMENT_ID,
            "revision_id": REVISION_ID,
            "revision_sha256": DIGEST,
            "title": "Notebook",
            "display_filename": "notebook.md",
            "media_type": "text/markdown",
        }
        representation = {
            "id": REPRESENTATION_ID,
            "kind": "markdown",
            "media_type": "text/markdown",
            "content_sha256": OTHER_DIGEST,
        }
        receipt = {
            "id": RECEIPT_ID,
            "output_representation_id": REPRESENTATION_ID,
            "output_sha256": OTHER_DIGEST,
            "output_manifest": {
                "schemaId": "gb.transform-output-manifest.v1",
                "representations": [{
                    "id": REPRESENTATION_ID,
                    "contentSha256": OTHER_DIGEST,
                }],
            },
            "fallback_receipt_id": None,
        }
        cursor = Cursor(one=[row], many=[[receipt], [representation]])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"]["documentId"], DOCUMENT_ID)
        self.assertEqual(result["source"]["revisionId"], REVISION_ID)
        self.assertEqual(result["source"]["revisionSha256"], DIGEST)
        self.assertEqual(result["source"]["representations"][0], {
            "id": REPRESENTATION_ID,
            "kind": "markdown",
            "mediaType": "text/markdown",
            "contentSha256": OTHER_DIGEST,
            "label": "markdown",
        })
        representation_query = next(
            item for item in cursor.executions if "FROM gb_document_representations" in item[0]
        )
        self.assertEqual(representation_query[1][-1], 33)
        self.assertEqual(representation_query[1][2], [f"{REPRESENTATION_ID}:{OTHER_DIGEST}"])
        self.assertNotIn("content_bytes", representation_query[0])
        self.assertNotIn("content_json", representation_query[0])

    def test_document_source_omits_superseded_derived_representations(self):
        row = {
            "document_id": DOCUMENT_ID,
            "revision_id": REVISION_ID,
            "revision_sha256": DIGEST,
            "title": "Notebook",
            "display_filename": "notebook.md",
            "media_type": "text/markdown; charset=utf-8",
        }
        current_id = REPRESENTATION_ID
        stale_id = "60000000-0000-4000-8000-000000000002"
        receipt = {
            "id": RECEIPT_ID,
            "output_representation_id": current_id,
            "output_sha256": OTHER_DIGEST,
            "output_manifest": {
                "schemaId": "gb.transform-output-manifest.v1",
                "representations": [{"id": current_id, "contentSha256": OTHER_DIGEST}],
            },
            "fallback_receipt_id": None,
        }
        current = {
            "id": current_id,
            "kind": "markdown",
            "media_type": "text/markdown; charset=utf-8",
            "content_sha256": OTHER_DIGEST,
        }
        cursor = Cursor(one=[row], many=[[receipt], [current]])
        source = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]["source"]
        self.assertEqual([item["id"] for item in source["representations"]], [current_id])
        representation_query = next(
            item for item in cursor.executions if "FROM gb_document_representations" in item[0]
        )
        self.assertIn("= ANY(%s)", representation_query[0])
        self.assertNotIn(stale_id, representation_query[1][2])

    def test_document_source_newest_empty_receipt_does_not_reuse_older_success(self):
        stale_id = REPRESENTATION_ID
        newest_id = "70000000-0000-4000-8000-000000000002"
        newest_failed = transform_receipt(newest_id, [])
        older_success = transform_receipt(
            RECEIPT_ID,
            [{"id": stale_id, "contentSha256": OTHER_DIGEST}],
        )
        original_id = "60000000-0000-4000-8000-000000000099"
        cursor = Cursor(
            one=[document_row()],
            many=[[newest_failed, older_success], [representation_row(original_id, DIGEST, "original")]],
        )
        source = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]["source"]
        self.assertEqual([item["id"] for item in source["representations"]], [original_id])
        representation_query = next(
            item for item in cursor.executions if "FROM gb_document_representations" in item[0]
        )
        self.assertEqual(representation_query[1][2], [])
        self.assertNotIn(stale_id, representation_query[1][2])

    def test_document_source_unions_only_the_named_current_fallback(self):
        primary_id = "60000000-0000-4000-8000-000000000010"
        fallback_id = "60000000-0000-4000-8000-000000000011"
        stale_id = "60000000-0000-4000-8000-000000000012"
        fallback_receipt_id = "70000000-0000-4000-8000-000000000011"
        receipts = [
            transform_receipt(
                RECEIPT_ID,
                [{"id": primary_id, "contentSha256": DIGEST}],
                fallback_receipt_id=fallback_receipt_id,
            ),
            transform_receipt(
                fallback_receipt_id,
                [{"id": fallback_id, "contentSha256": OTHER_DIGEST}],
            ),
            transform_receipt(
                "70000000-0000-4000-8000-000000000012",
                [{"id": stale_id, "contentSha256": OTHER_DIGEST}],
            ),
        ]
        cursor = Cursor(
            one=[document_row()],
            many=[receipts, [
                representation_row(primary_id, DIGEST, "document-structure"),
                representation_row(fallback_id),
            ]],
        )
        source = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]["source"]
        self.assertEqual(
            [item["id"] for item in source["representations"]],
            [primary_id, fallback_id],
        )
        representation_query = next(
            item for item in cursor.executions if "FROM gb_document_representations" in item[0]
        )
        self.assertEqual(set(representation_query[1][2]), {
            f"{primary_id}:{DIGEST}",
            f"{fallback_id}:{OTHER_DIGEST}",
        })
        self.assertNotIn(stale_id, " ".join(representation_query[1][2]))

    def test_document_source_rejects_malformed_or_oversized_current_manifest(self):
        malformed = transform_receipt(RECEIPT_ID, [])
        malformed["output_manifest"] = {"schemaId": "gb.transform-output-manifest.v1", "representations": {}}
        with self.assertRaises(ProjectionSourceProviderError):
            resolve_projection_sources(
                Connection(Cursor(one=[document_row()], many=[[malformed]])),
                TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
            )

        wrong_schema = transform_receipt(RECEIPT_ID, [])
        wrong_schema["output_manifest"]["schemaId"] = "gb.transform-output-manifest.v0"
        with self.assertRaises(ProjectionSourceProviderError):
            resolve_projection_sources(
                Connection(Cursor(one=[document_row()], many=[[wrong_schema]])),
                TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
            )

        oversized = [
            {
                "id": f"60000000-0000-4000-8000-{index:012x}",
                "contentSha256": OTHER_DIGEST,
            }
            for index in range(33)
        ]
        with self.assertRaises(ProjectionSourceProviderError):
            resolve_projection_sources(
                Connection(Cursor(
                    one=[document_row()],
                    many=[[transform_receipt(RECEIPT_ID, oversized)]],
                )),
                TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
            )

    def test_document_source_rejects_more_than_32_current_rows_across_fallback_union(self):
        fallback_receipt_id = "70000000-0000-4000-8000-000000000011"
        identities = [
            {
                "id": f"60000000-0000-4000-8000-{index:012x}",
                "contentSha256": OTHER_DIGEST,
            }
            for index in range(33)
        ]
        receipts = [
            transform_receipt(
                RECEIPT_ID,
                identities[:20],
                fallback_receipt_id=fallback_receipt_id,
            ),
            transform_receipt(fallback_receipt_id, identities[20:]),
        ]
        rows = [representation_row(item["id"]) for item in identities]
        with self.assertRaisesRegex(ProjectionSourceProviderError, "too many current"):
            resolve_projection_sources(
                Connection(Cursor(one=[document_row()], many=[receipts, rows])),
                TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
            )

    def test_document_source_receipt_scan_is_bounded_and_does_not_cross_boundary(self):
        newest_failed = transform_receipt(RECEIPT_ID, [])
        bounded_rows = [newest_failed] + [
            transform_receipt(
                f"70000000-0000-4000-8000-{index:012x}",
                [],
            )
            for index in range(2, MAX_TRANSFORM_RECEIPTS + 1)
        ]
        cursor = Cursor(one=[document_row()], many=[bounded_rows, []])
        source = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]["source"]
        self.assertEqual(source["representations"], [])
        receipt_query = next(
            item for item in cursor.executions if "FROM gb_transform_receipts" in item[0]
        )
        self.assertEqual(receipt_query[1][-1], MAX_TRANSFORM_RECEIPTS)
        representation_query = next(
            item for item in cursor.executions if "FROM gb_document_representations" in item[0]
        )
        self.assertEqual(representation_query[1][2], [])

    def test_raster_document_source_returns_only_digest_bound_manifest_metadata(self):
        manifest = {
            "schemaId": "gb.raster-image.v1",
            "format": "png",
            "mediaType": "image/png",
            "width": 640,
            "height": 480,
            "channels": 4,
            "frameCount": 1,
            "byteSize": 4096,
            "contentSha256": OTHER_DIGEST,
        }
        row = {
            "document_id": DOCUMENT_ID,
            "revision_id": REVISION_ID,
            "revision_sha256": DIGEST,
            "title": "Figure",
            "display_filename": "Figure [bbbbbbbbbbbb].png",
            "media_type": "image/png",
            "content_sha256": OTHER_DIGEST,
            "source_metadata": {"arxivId": None, "rasterImage": manifest},
        }
        representation = {
            "id": REPRESENTATION_ID,
            "kind": "original",
            "media_type": "image/png",
            "content_sha256": OTHER_DIGEST,
        }
        cursor = Cursor(one=[row], many=[[], [representation]])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"]["rasterImage"], manifest)
        self.assertEqual(result["source"]["revisionId"], REVISION_ID)
        lookup = next(item for item in cursor.executions if "FROM gb_documents AS document" in item[0])
        self.assertNotIn("content_bytes", lookup[0])

        for bad_metadata in [
            {},
            {"rasterImage": {**manifest, "frameCount": 2}},
            {"rasterImage": {**manifest, "contentSha256": DIGEST}},
        ]:
            with self.assertRaises(ProjectionSourceProviderError):
                resolve_projection_sources(
                    Connection(Cursor(one=[{**row, "source_metadata": bad_metadata}])),
                    TENANT,
                    PRINCIPAL,
                    [reference("document", DOCUMENT_ID, DIGEST)],
                )

    def test_audio_document_source_returns_only_digest_bound_exact_manifest(self):
        manifest = {
            "schemaId": "gb.audio-original.v1",
            "container": "webm",
            "codec": "opus",
            "mediaType": "audio/webm",
            "trackCount": 1,
            "channels": 1,
            "byteSize": 4096,
            "contentSha256": OTHER_DIGEST,
        }
        row = {
            "document_id": DOCUMENT_ID,
            "revision_id": REVISION_ID,
            "revision_sha256": DIGEST,
            "title": "Field recording",
            "display_filename": "Field recording [bbbbbbbbbbbb].webm",
            "media_type": "audio/webm",
            "content_sha256": OTHER_DIGEST,
            "byte_size": 4096,
            "source_metadata": {"arxivId": None, "audioOriginal": manifest},
        }
        representation = {
            "id": REPRESENTATION_ID,
            "kind": "original",
            "media_type": "audio/webm",
            "content_sha256": OTHER_DIGEST,
        }
        cursor = Cursor(one=[row], many=[[], [representation]])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL, [reference("document", DOCUMENT_ID, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"]["audioOriginal"], manifest)
        self.assertNotIn("content_bytes", json.dumps(result))
        for bad_metadata in [
            {},
            {"audioOriginal": {**manifest, "contentSha256": DIGEST}},
            {"audioOriginal": {**manifest, "channels": 3}},
        ]:
            with self.assertRaises(ProjectionSourceProviderError):
                resolve_projection_sources(
                    Connection(Cursor(one=[{**row, "source_metadata": bad_metadata}])),
                    TENANT, PRINCIPAL,
                    [reference("document", DOCUMENT_ID, DIGEST)],
                )

    def test_document_source_is_tenant_scoped_and_cross_tenant_absence_is_unavailable(self):
        cursor = Cursor(one=[None])
        requested = reference("document", DOCUMENT_ID, DIGEST)
        result = resolve_projection_sources(
            Connection(cursor), OTHER_TENANT, PRINCIPAL, [requested],
        )["results"][0]

        self.assertEqual(result, {"requestedRef": requested, "status": "unavailable"})
        lookup = next(item for item in cursor.executions if "FROM gb_documents AS document" in item[0])
        self.assertIn("document.tenant_id = %s", lookup[0])
        self.assertIn("revision.tenant_id = document.tenant_id", lookup[0])
        self.assertIn("artifact.tenant_id = revision.tenant_id", lookup[0])
        self.assertEqual(lookup[1], (OTHER_TENANT, DOCUMENT_ID, DIGEST, DIGEST, DIGEST))
        self.assertFalse(any("FROM gb_document_representations" in item[0] for item in cursor.executions))

    def test_document_source_rejects_malformed_or_stale_revision_provenance(self):
        base = {
            "document_id": DOCUMENT_ID,
            "revision_id": REVISION_ID,
            "revision_sha256": DIGEST,
            "title": "Notebook",
            "display_filename": "notebook.md",
            "media_type": "text/markdown",
        }
        for drifted in [
            {**base, "revision_id": "not-a-uuid"},
            {**base, "revision_sha256": OTHER_DIGEST},
            {**base, "document_id": PAPER_ID},
        ]:
            with self.subTest(drifted=drifted), self.assertRaises(ProjectionSourceProviderError):
                resolve_projection_sources(
                    Connection(Cursor(one=[drifted])), TENANT, PRINCIPAL,
                    [reference("document", DOCUMENT_ID, DIGEST)],
                )

    def test_anchor_source_reduces_selector_to_projector_fields(self):
        anchor_id = f"sha256:{OTHER_DIGEST}"
        row = {
            "id": anchor_id,
            "representation_sha256": DIGEST,
            "anchor_sha256": OTHER_DIGEST,
            "selector_json": {
                "kind": "text-quote", "exact": "evidence", "prefix": "secret prefix",
            },
            "title": "Paper",
        }
        cursor = Cursor(one=[row])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("document.anchor", anchor_id, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"]["selector"], {"kind": "text-quote", "exact": "evidence"})
        self.assertEqual(result["source"]["id"], anchor_id)
        self.assertNotIn("prefix", json.dumps(result))
        lookup = next(item for item in cursor.executions if "FROM gb_document_anchors" in item[0])
        self.assertIn("anchor.anchor_sha256 = %s", lookup[0])
        self.assertEqual(lookup[1][1], OTHER_DIGEST)

    def test_anchor_source_rejects_stored_id_digest_drift(self):
        row = {
            "id": f"sha256:{DIGEST}",
            "representation_sha256": DIGEST,
            "anchor_sha256": OTHER_DIGEST,
            "selector_json": {"kind": "text-quote", "exact": "evidence"},
            "title": "Paper",
        }
        with self.assertRaises(ProjectionSourceProviderError):
            resolve_projection_sources(
                Connection(Cursor(one=[row])), TENANT, PRINCIPAL,
                [reference("document.anchor", f"sha256:{OTHER_DIGEST}", DIGEST)],
            )

    def test_direct_resolution_rejects_noncanonical_wire_spelling(self):
        value = "gb:object:v1:paper:%c3%a9:latest"
        with self.assertRaises(ProjectionSourceRequestError):
            resolve_projection_sources(Connection(Cursor()), TENANT, PRINCIPAL, [value])

    def test_mutable_eln_pins_and_immutable_proof_latest_are_unavailable_without_queries(self):
        refs = [
            reference("eln.experiment", "experiment-1", DIGEST),
            reference("proof.graph", "graph-1"),
        ]
        cursor = Cursor()
        result = resolve_projection_sources(Connection(cursor), TENANT, PRINCIPAL, refs)
        self.assertEqual([item["status"] for item in result["results"]], ["unavailable", "unavailable"])
        lookups = [item for item in cursor.executions if "FROM gb_" in item[0]]
        self.assertEqual(lookups, [])

    def test_proof_node_returns_only_exact_target_projection_fields(self):
        node_ref = "graph-1#target-1"
        cursor = Cursor(one=[{
            "content_sha256": DIGEST,
            "target_title": "Main theorem",
            "target_summary": "Prove the statement.",
        }])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("proof.node", node_ref, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"], {
            "nodeRefId": node_ref,
            "title": "Main theorem",
            "summary": "Prove the statement.",
            "contentSha256": DIGEST,
        })
        lookup = next(item for item in cursor.executions if "FROM gb_proof_graphs" in item[0])
        self.assertNotIn(") AS target\n", lookup[0])
        self.assertNotIn("formal_binding", lookup[0])
        self.assertEqual(lookup[1], (node_ref, node_ref, TENANT, node_ref, DIGEST))

    def test_surface_pinned_promoted_revision_uses_revision_fields_not_mutable_head(self):
        cursor = Cursor(one=[{
            "id": DOCUMENT_ID,
            "title": "Promoted surface",
            "status": "promoted",
            "catalog_id": "generous.a2ui",
            "current_version": 2,
            "current_content_hash": DIGEST,
            "schema_digest": SCHEMA_DIGEST,
            "catalog_digest": CATALOG_DIGEST,
            "renderer_version": RENDERER_VERSION,
            "placement_eligible": False,
        }])
        result = resolve_projection_sources(
            Connection(cursor), TENANT, PRINCIPAL,
            [reference("surface", DOCUMENT_ID, DIGEST)],
        )["results"][0]
        self.assertEqual(result["source"], {
            "id": DOCUMENT_ID,
            "title": "Promoted surface",
            "status": "promoted",
            "catalogId": "generous.a2ui",
            "currentVersion": 2,
            "currentContentHash": DIGEST,
            "schemaDigest": SCHEMA_DIGEST,
            "catalogDigest": CATALOG_DIGEST,
            "rendererVersion": RENDERER_VERSION,
            "placementEligible": False,
        })
        lookup = next(item for item in cursor.executions if "FROM gb_surfaces AS surface" in item[0])
        self.assertIn("revision.content_hash = %s", lookup[0])
        self.assertIn("revision.status = 'promoted'", lookup[0])
        self.assertIn("surface.current_version = revision.version", lookup[0])
        self.assertIn("surface.current_content_hash = revision.content_hash", lookup[0])
        self.assertEqual(lookup[1], (TENANT, DOCUMENT_ID, DIGEST))

    def test_v1_and_v2_surface_responses_preserve_the_old_exact_shape(self):
        row = {
            "id": DOCUMENT_ID,
            "title": "Promoted surface",
            "status": "promoted",
            "catalog_id": "generous.a2ui",
            "current_version": 2,
            "current_content_hash": DIGEST,
            "schema_digest": SCHEMA_DIGEST,
            "catalog_digest": CATALOG_DIGEST,
            "renderer_version": RENDERER_VERSION,
            "placement_eligible": True,
        }
        expected = {
            "id": DOCUMENT_ID,
            "title": "Promoted surface",
            "status": "promoted",
            "catalogId": "generous.a2ui",
            "currentVersion": 2,
            "currentContentHash": DIGEST,
        }
        for schema in (RESPONSE_SCHEMA_V1, RESPONSE_SCHEMA_V2):
            with self.subTest(schema=schema):
                result = resolve_projection_sources(
                    Connection(Cursor(one=[row])), TENANT, PRINCIPAL,
                    [reference("surface", DOCUMENT_ID, DIGEST)],
                    schema,
                )["results"][0]
                self.assertEqual(result["source"], expected)


if __name__ == "__main__":
    unittest.main()
