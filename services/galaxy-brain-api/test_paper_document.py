import hashlib
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, Request

from server import (
    ARXIV_FETCH_PLAN_CLAIM,
    IdentityContext,
    _bridge_paper_document,
    _document_import_client_idempotency_key,
    _paper_byte_range,
    fetch_private_arxiv_document,
    read_paper_document,
    store_paper_document,
)
from arxiv_pdf_fetch import ArxivPdfFetchError
from ingestion_plan_registry import resolve_ingestion_plan_claim


PAPER_ID = "10000000-0000-4000-8000-000000000001"
REVISION_ID = "20000000-0000-4000-8000-000000000001"
TENANT_ID = "30000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "40000000-0000-4000-8000-000000000001"
BRIDGE_ID = "51000000-0000-4000-8000-000000000001"
PDF = b"%PDF-1.4\nprivate paper\n%%EOF\n"


def request(method="GET", body=b"", headers=None):
    encoded_headers = [
        (name.lower().encode("ascii"), value.encode("ascii"))
        for name, value in (headers or {}).items()
    ]
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": method,
        "path": f"/papers/{PAPER_ID}/document",
        "query_string": b"",
        "headers": encoded_headers,
    }, receive)


class DocumentCursor:
    def __init__(self, row):
        self.row = row
        self.executions = []

    def execute(self, statement, parameters=None):
        self.executions.append((" ".join(statement.split()), parameters))

    def fetchone(self):
        return self.row


class SequenceCursor(DocumentCursor):
    def __init__(self, rows):
        super().__init__(None)
        self.rows = list(rows)

    def fetchone(self):
        return self.rows.pop(0)


class DocumentConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class PaperDocumentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id=TENANT_ID,
            principal_id=PRINCIPAL_ID,
            principal_kind="human",
        )
        self.paper = {"id": PAPER_ID}
        self.revision = {
            "id": REVISION_ID,
            "paper_id": PAPER_ID,
            "metadata_hash": "b" * 64,
            "metadata": {
                "arxiv_id": "2404.06147",
                "arxiv_version": 1,
                "title": "Vortex unbinding",
                "authors": [{"name": "A. Researcher"}],
                "published_at": "2024-04-08T00:00:00Z",
            },
        }

    def test_byte_ranges_support_pdf_viewer_reads_and_reject_invalid_ranges(self):
        self.assertIsNone(_paper_byte_range(None, 100))
        self.assertEqual(_paper_byte_range("bytes=10-19", 100), (10, 19))
        self.assertEqual(_paper_byte_range("bytes=90-", 100), (90, 99))
        self.assertEqual(_paper_byte_range("bytes=-10", 100), (90, 99))
        with self.assertRaises(HTTPException) as caught:
            _paper_byte_range("bytes=100-101", 100)
        self.assertEqual(caught.exception.status_code, 416)

    def test_stored_document_reads_are_private_hash_bound_and_range_capable(self):
        cursor = DocumentCursor({
            "filename": "Vortex unbinding.pdf",
            "byte_size": len(PDF),
            "content_sha256": hashlib.sha256(PDF).hexdigest(),
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "pdf_bytes": PDF,
        })
        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch("server.get_conn", return_value=DocumentConnection(cursor)):
            response = read_paper_document(
                PAPER_ID,
                request(headers={"Range": "bytes=0-7"}),
                REVISION_ID,
                self.identity,
            )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.body, PDF[:8])
        self.assertEqual(response.headers["content-range"], f"bytes 0-7/{len(PDF)}")
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        self.assertEqual(response.headers["etag"], f'"sha256-{hashlib.sha256(PDF).hexdigest()}"')
        self.assertTrue(response.headers["content-disposition"].startswith("inline;"))

    async def test_store_rejects_non_pdf_bytes_before_writing(self):
        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), self.assertRaises(HTTPException) as caught:
            await store_paper_document(
                PAPER_ID,
                request("PUT", b"not-a-pdf", {"Content-Type": "application/pdf"}),
                REVISION_ID,
                self.identity,
            )
        self.assertEqual(caught.exception.status_code, 422)

    async def test_store_binds_exact_pdf_bytes_to_the_immutable_revision(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        cursor = DocumentCursor({
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "Vortex unbinding - A. Researcher (2024).pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        })

        @contextmanager
        def transaction(_connection):
            yield cursor

        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch("server.get_conn", return_value=object()), patch("server._transaction", transaction), patch(
            "server._bridge_paper_document",
            side_effect=lambda _cur, _identity, _paper, _revision, document, _raw, **_options: {
                **document,
                "durable_document": {"ref": "gb:object:v1:document:test:pinned:sha256%3A" + expected_hash},
                "bridge_replayed": False,
                "deduplicated_artifact": False,
            },
        ):
            stored = await store_paper_document(
                PAPER_ID,
                request("PUT", PDF, {
                    "Content-Type": "application/pdf",
                    "Content-Length": str(len(PDF)),
                }),
                REVISION_ID,
                self.identity,
            )

        self.assertEqual(stored["content_sha256"], expected_hash)
        self.assertFalse(stored["deduplicated"])
        insert = next(item for item in cursor.executions if item[0].startswith("INSERT INTO gb_paper_documents"))
        self.assertEqual(insert[1][0:4], (TENANT_ID, PAPER_ID, REVISION_ID, PRINCIPAL_ID))
        self.assertEqual(insert[1][5], len(PDF))
        self.assertEqual(insert[1][6], expected_hash)
        self.assertEqual(insert[1][7], "https://arxiv.org/pdf/2404.06147v1")

    async def test_authenticated_private_fetch_uses_exact_metadata_and_registered_plan(self):
        fetched = SimpleNamespace(
            content=PDF,
            content_sha256=hashlib.sha256(PDF).hexdigest(),
            source_url="https://arxiv.org/pdf/2404.06147v1",
        )
        stored = {"content_sha256": fetched.content_sha256, "deduplicated": False}
        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch(
            "server.get_conn", return_value=DocumentConnection(DocumentCursor(None)),
        ), patch("server.fetch_arxiv_pdf", return_value=fetched) as fetch, patch(
            "server._store_paper_document_bytes", return_value=stored,
        ) as persist:
            result = await fetch_private_arxiv_document(
                PAPER_ID,
                REVISION_ID,
                self.identity,
            )

        fetch.assert_called_once_with("2404.06147", 1)
        persist.assert_called_once()
        self.assertEqual(persist.call_args.args[3], PDF)
        self.assertEqual(persist.call_args.kwargs["source_kind"], "arxiv")
        self.assertEqual(persist.call_args.kwargs["ingestion_plan"]["id"], "arxiv.fetch-default")
        self.assertEqual(result, stored)

    async def test_private_fetch_maps_bounded_upstream_failures_without_persisting(self):
        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch(
            "server.get_conn", return_value=DocumentConnection(DocumentCursor(None)),
        ), patch(
            "server.fetch_arxiv_pdf",
            side_effect=ArxivPdfFetchError("Paper PDF exceeds the 100 MB storage limit", 413),
        ), patch("server._store_paper_document_bytes") as persist:
            with self.assertRaises(HTTPException) as caught:
                await fetch_private_arxiv_document(PAPER_ID, REVISION_ID, self.identity)
        self.assertEqual(caught.exception.status_code, 413)
        persist.assert_not_called()

    async def test_private_fetch_replays_existing_private_bytes_without_network_or_relabelling(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "Vortex unbinding - A. Researcher (2024).pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        preflight_cursor = DocumentCursor({"pdf_bytes": PDF})
        replay_cursor = SequenceCursor([
            None,
            paper_document,
            {"idempotency_key": f"gb.internal:arxiv-fetch:{REVISION_ID}"},
        ])
        stored = {"content_sha256": hashlib.sha256(PDF).hexdigest(), "bridge_replayed": True}

        @contextmanager
        def transaction(_connection):
            yield replay_cursor

        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch(
            "server.get_conn", side_effect=[DocumentConnection(preflight_cursor), object()],
        ), patch(
            "server._transaction", transaction,
        ), patch("server.fetch_arxiv_pdf") as fetch, patch(
            "server._bridge_paper_document", return_value=stored,
        ) as bridge:
            result = await fetch_private_arxiv_document(PAPER_ID, REVISION_ID, self.identity)

        fetch.assert_not_called()
        bridge.assert_called_once()
        self.assertEqual(bridge.call_args.kwargs["source_kind"], "arxiv")
        self.assertEqual(bridge.call_args.kwargs["ingestion_plan"]["id"], "arxiv.fetch-default")
        self.assertEqual(result, stored)
        self.assertEqual(preflight_cursor.executions[0][1], (TENANT_ID, REVISION_ID))

    async def test_private_fetch_preserves_a_preexisting_legacy_bridge(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "Vortex unbinding - A. Researcher (2024).pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        preflight_cursor = DocumentCursor({"pdf_bytes": PDF})
        replay_cursor = SequenceCursor([
            None,
            paper_document,
            {"idempotency_key": f"gb.internal:legacy-paper:{REVISION_ID}"},
        ])

        @contextmanager
        def transaction(_connection):
            yield replay_cursor

        with patch("server._paper_or_404", return_value=self.paper), patch(
            "server._paper_revision_or_404", return_value=self.revision,
        ), patch(
            "server.get_conn", side_effect=[DocumentConnection(preflight_cursor), object()],
        ), patch("server._transaction", transaction), patch("server.fetch_arxiv_pdf") as fetch, patch(
            "server._bridge_paper_document", return_value={"bridge_replayed": True},
        ) as bridge:
            result = await fetch_private_arxiv_document(PAPER_ID, REVISION_ID, self.identity)

        fetch.assert_not_called()
        self.assertTrue(result["bridge_replayed"])
        self.assertEqual(bridge.call_args.kwargs["source_kind"], "legacy-paper")
        self.assertIsNone(bridge.call_args.kwargs["ingestion_plan"])

    def test_bridge_binds_exact_legacy_and_canonical_evidence(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "Vortex unbinding - A. Researcher (2024).pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        durable = {
            "schemaId": "gb.document.import.v1",
            "persisted": True,
            "ref": "gb:object:v1:document:60000000-0000-4000-8000-000000000001:pinned:sha256%3A" + "c" * 64,
            "document_id": "60000000-0000-4000-8000-000000000001",
            "revision_id": "70000000-0000-4000-8000-000000000001",
            "revision_sha256": "c" * 64,
            "artifact_id": "80000000-0000-4000-8000-000000000001",
            "source_id": "90000000-0000-4000-8000-000000000001",
            "content_sha256": expected_hash,
            "deduplicatedArtifact": False,
        }
        representation_id = "a0000000-0000-4000-8000-000000000001"
        cursor = SequenceCursor([None, {"id": BRIDGE_ID}])
        with patch("server._persist_document_import", return_value=(durable, representation_id)) as persist, patch(
            "server._persist_object_link", return_value={"id": "link-1", "version": 1},
        ) as persist_link:
            result = _bridge_paper_document(
                cursor, self.identity, self.paper, self.revision, paper_document, PDF,
            )

        self.assertEqual(result["durable_document"]["ref"], durable["ref"])
        self.assertFalse(result["bridge_replayed"])
        persist.assert_called_once()
        call = persist.call_args.kwargs
        self.assertEqual(call["normalized_media_type"], "application/pdf")
        self.assertEqual(call["idempotency_key"], f"gb.internal:legacy-paper:{REVISION_ID}")
        self.assertEqual(call["source_metadata"]["paperMetadataHash"], "b" * 64)
        bridge = next(item for item in cursor.executions if item[0].startswith("INSERT INTO gb_paper_document_bridges"))
        self.assertEqual(bridge[1][0:5], (
            TENANT_ID, paper_document["id"], PAPER_ID, REVISION_ID, "b" * 64,
        ))
        self.assertEqual(bridge[1][11], expected_hash)
        link = persist_link.call_args.args[2]
        self.assertEqual(
            link["from_ref"],
            f"gb:object:v1:paper:{PAPER_ID}:pinned:sha256%3A{'b' * 64}",
        )
        self.assertEqual(link["to_ref"], durable["ref"])
        self.assertEqual(link["relation"], "corresponds_to")
        self.assertEqual(link["basis"], "imported")
        self.assertEqual(link["provenance"], {
            "source": "import",
            "source_system": "arxiv",
            "source_ref": "https://arxiv.org/pdf/2404.06147v1",
            "source_snapshot": f"sha256:{expected_hash}",
            "extractor_version": "galaxy.paper-document-bridge.v1",
            "confidence": 1.0,
        })
        self.assertEqual(
            link["idempotency_key"],
            f"gb.internal:paper-document-link:{BRIDGE_ID}",
        )

    def test_bridge_bounds_the_derived_document_title_without_losing_paper_metadata(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "paper.pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        revision = {
            **self.revision,
            "metadata": {**self.revision["metadata"], "title": "T" * 700},
        }
        durable = {
            "document_id": "60000000-0000-4000-8000-000000000001",
            "revision_id": "70000000-0000-4000-8000-000000000001",
            "revision_sha256": "c" * 64,
            "artifact_id": "80000000-0000-4000-8000-000000000001",
            "source_id": "90000000-0000-4000-8000-000000000001",
            "content_sha256": expected_hash,
            "deduplicatedArtifact": False,
        }
        with patch("server._persist_document_import", return_value=(
            durable, "a0000000-0000-4000-8000-000000000001",
        )) as persist, patch("server._persist_paper_document_link"):
            _bridge_paper_document(
                SequenceCursor([None, {"id": BRIDGE_ID}]),
                self.identity, self.paper, revision, paper_document, PDF,
            )
        self.assertEqual(persist.call_args.kwargs["metadata"]["title"], "T" * 500)
        self.assertEqual(persist.call_args.kwargs["source_metadata"]["paperMetadataHash"], "b" * 64)

    def test_bridge_generated_identity_avoids_a_seeded_preupgrade_link_collision(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "paper.pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        durable = {
            "ref": "gb:object:v1:document:60000000-0000-4000-8000-000000000001:pinned:sha256%3A" + "c" * 64,
            "document_id": "60000000-0000-4000-8000-000000000001",
            "revision_id": "70000000-0000-4000-8000-000000000001",
            "revision_sha256": "c" * 64,
            "artifact_id": "80000000-0000-4000-8000-000000000001",
            "source_id": "90000000-0000-4000-8000-000000000001",
            "deduplicatedArtifact": False,
        }
        seeded_preupgrade_key = f"gb.internal:paper-document-link:{paper_document['id']}"
        persisted_keys = []

        def persist_link(_cur, _identity, link):
            if link["idempotency_key"] == seeded_preupgrade_key:
                raise HTTPException(status_code=409, detail="Seeded pre-upgrade collision")
            persisted_keys.append(link["idempotency_key"])
            return {"id": "link-1", "version": 1}

        with patch("server._persist_document_import", return_value=(
            durable, "a0000000-0000-4000-8000-000000000001",
        )), patch("server._persist_object_link", side_effect=persist_link):
            result = _bridge_paper_document(
                SequenceCursor([None, {"id": BRIDGE_ID}]),
                self.identity, self.paper, self.revision,
                paper_document, PDF,
            )

        self.assertFalse(result["bridge_replayed"])
        self.assertEqual(persisted_keys, [
            f"gb.internal:paper-document-link:{BRIDGE_ID}",
        ])

    def test_bridge_replay_backfills_the_graph_relation_without_reimporting(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "paper.pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        durable = {
            "ref": "gb:object:v1:document:60000000-0000-4000-8000-000000000001:pinned:sha256%3A" + "c" * 64,
            "document_id": "60000000-0000-4000-8000-000000000001",
            "revision_sha256": "c" * 64,
            "source_id": "90000000-0000-4000-8000-000000000001",
        }
        cursor = SequenceCursor([{
            "id": BRIDGE_ID,
            "source_id": durable["source_id"],
            "request_sha256": None,
            "content_sha256": expected_hash,
        }])
        with patch("server._paper_document_bridge_request_hash", return_value="d" * 64), patch(
            "server._document_import_record", return_value=durable,
        ), patch("server._persist_paper_document_link") as persist_link, patch(
            "server._persist_document_import",
        ) as persist_import:
            cursor.rows[0]["request_sha256"] = "d" * 64
            result = _bridge_paper_document(
                cursor, self.identity, self.paper, self.revision, paper_document, PDF,
            )
        persist_import.assert_not_called()
        persist_link.assert_called_once_with(
            cursor, self.identity, self.paper, self.revision, durable,
            bridge_id=BRIDGE_ID,
            source_url="https://arxiv.org/pdf/2404.06147v1",
            content_sha256=expected_hash,
        )
        self.assertTrue(result["bridge_replayed"])

    def test_arxiv_bridge_replay_uses_the_same_plan_bound_request_identity(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "paper.pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        durable = {
            "ref": "gb:object:v1:document:60000000-0000-4000-8000-000000000001:pinned:sha256%3A" + "c" * 64,
            "document_id": "60000000-0000-4000-8000-000000000001",
            "revision_id": "70000000-0000-4000-8000-000000000001",
            "revision_sha256": "c" * 64,
            "artifact_id": "80000000-0000-4000-8000-000000000001",
            "source_id": "90000000-0000-4000-8000-000000000001",
            "content_sha256": expected_hash,
            "deduplicatedArtifact": False,
        }
        plan = resolve_ingestion_plan_claim(ARXIV_FETCH_PLAN_CLAIM)
        created_cursor = SequenceCursor([None, {"id": BRIDGE_ID}])
        with patch("server._persist_document_import", return_value=(
            durable, "a0000000-0000-4000-8000-000000000001",
        )), patch("server._persist_paper_document_link"):
            created = _bridge_paper_document(
                created_cursor, self.identity, self.paper, self.revision,
                paper_document, PDF, source_kind="arxiv", ingestion_plan=plan,
            )
        bridge_insert = next(
            entry for entry in created_cursor.executions
            if entry[0].startswith("INSERT INTO gb_paper_document_bridges")
        )
        request_sha256 = bridge_insert[1][-2]

        replay_cursor = SequenceCursor([{
            "id": BRIDGE_ID,
            "source_id": durable["source_id"],
            "request_sha256": request_sha256,
            "content_sha256": expected_hash,
        }])
        with patch("server._document_import_record", return_value=durable), patch(
            "server._persist_paper_document_link",
        ), patch("server._persist_document_import") as persist_import:
            replayed = _bridge_paper_document(
                replay_cursor, self.identity, self.paper, self.revision,
                paper_document, PDF, source_kind="arxiv", ingestion_plan=plan,
            )

        self.assertFalse(created["bridge_replayed"])
        self.assertTrue(replayed["bridge_replayed"])
        persist_import.assert_not_called()

    def test_public_document_import_cannot_use_the_server_namespace(self):
        with self.assertRaises(HTTPException) as caught:
            _document_import_client_idempotency_key(
                f"gb.internal:legacy-paper:{REVISION_ID}",
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_bridge_replay_fails_closed_when_exact_evidence_changes(self):
        expected_hash = hashlib.sha256(PDF).hexdigest()
        paper_document = {
            "id": "50000000-0000-4000-8000-000000000001",
            "paper_id": PAPER_ID,
            "paper_revision_id": REVISION_ID,
            "media_type": "application/pdf",
            "filename": "paper.pdf",
            "byte_size": len(PDF),
            "content_sha256": expected_hash,
            "source_url": "https://arxiv.org/pdf/2404.06147v1",
            "stored_at": "2026-09-17T00:00:00Z",
        }
        cursor = SequenceCursor([{
            "source_id": "90000000-0000-4000-8000-000000000001",
            "request_sha256": "0" * 64,
            "content_sha256": expected_hash,
        }])
        with self.assertRaises(HTTPException) as caught:
            _bridge_paper_document(
                cursor, self.identity, self.paper, self.revision, paper_document, PDF,
            )
        self.assertEqual(caught.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
