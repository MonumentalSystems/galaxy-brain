import unittest
from unittest.mock import patch

import ingestion_plan_registry as registry
from durable_ingestion import IngestionContractError
from ingestion_plan_registry import (
    ingestion_plan_expected_source_kind,
    ingestion_plan_content_sha256,
    resolve_ingestion_plan_claim,
    resolve_stored_ingestion_plan_evidence,
)


PLAN_HASH = "3fc4ea4cb03ee53467e9f4977be28145be100580cf09123e144e6153d070ae66"
DATASOURCE_PLAN_HASH = "e3f23ff9cfc350e5a29d3efb897b96bee480bae0375dba83bea1d15cfc5b68d3"
WEB_CAPTURE_PLAN_HASH = "0e541cf2165e72e38baaeadd2617198bfcf064b0990f3fd8fcf927048f1ca6a8"
ARXIV_FETCH_PLAN_HASH = "46401cc8ea4e916304239fc6dc0fa5511790cf95d3f8cf52bf4de368c8d1f08a"


class IngestionPlanRegistryTests(unittest.TestCase):
    def test_code_owned_snapshot_matches_the_javascript_canonical_hash(self):
        plan = resolve_ingestion_plan_claim({
            "id": "document.upload-default", "version": "1.0.0", "contentSha256": PLAN_HASH,
        })
        self.assertEqual(ingestion_plan_content_sha256(plan), PLAN_HASH)
        self.assertEqual(plan["owner"]["pluginId"], "documents")
        self.assertEqual(plan["persist"]["routeId"], "document.import-route")
        self.assertEqual(plan["transformPolicy"]["transforms"][0]["contributionId"], "docling.convert")
        self.assertEqual(resolve_stored_ingestion_plan_evidence(plan), plan)

        drifted = {**plan, "source": {**plan["source"], "contributionId": "evil.source"}}
        with self.assertRaises(IngestionContractError):
            resolve_stored_ingestion_plan_evidence(drifted)

        with patch.dict(registry._PLAN_CATALOG, {}, clear=True):
            self.assertEqual(resolve_stored_ingestion_plan_evidence(plan), plan)

    def test_datasource_plan_matches_javascript_and_binds_its_source_kind(self):
        plan = resolve_ingestion_plan_claim({
            "id": "datasource.file-default",
            "version": "1.0.0",
            "contentSha256": DATASOURCE_PLAN_HASH,
        })
        self.assertEqual(ingestion_plan_content_sha256(plan), DATASOURCE_PLAN_HASH)
        self.assertEqual(plan["owner"]["pluginId"], "datasources")
        self.assertEqual(plan["source"]["contributionId"], "datasource.connected")
        self.assertEqual(ingestion_plan_expected_source_kind(plan), "datasource")
        self.assertEqual(resolve_stored_ingestion_plan_evidence(plan), plan)
        self.assertEqual(
            ingestion_plan_expected_source_kind(resolve_ingestion_plan_claim({
                "id": "document.upload-default",
                "version": "1.0.0",
                "contentSha256": PLAN_HASH,
            })),
            "upload",
        )

    def test_unknown_fields_and_catalog_drift_fail_closed(self):
        invalid = [
            {"id": "document.upload-default", "version": "1.0.0", "contentSha256": PLAN_HASH, "url": "x"},
            {"id": "unknown", "version": "1.0.0", "contentSha256": PLAN_HASH},
            {"id": "document.upload-default", "version": "1.0.1", "contentSha256": PLAN_HASH},
            {"id": "document.upload-default", "version": "1.0.0", "contentSha256": "A" * 64},
        ]
        for claim in invalid:
            with self.subTest(claim=claim), self.assertRaises(IngestionContractError):
                resolve_ingestion_plan_claim(claim)

    def test_web_capture_plan_matches_javascript_and_binds_url_source_kind(self):
        plan = resolve_ingestion_plan_claim({
            "id": "web.capture-default",
            "version": "1.0.0",
            "contentSha256": WEB_CAPTURE_PLAN_HASH,
        })
        self.assertEqual(ingestion_plan_content_sha256(plan), WEB_CAPTURE_PLAN_HASH)
        self.assertEqual(plan["owner"]["pluginId"], "web-capture")
        self.assertEqual(plan["source"]["contributionId"], "web.capture")
        self.assertEqual(ingestion_plan_expected_source_kind(plan), "url")
        self.assertEqual(resolve_stored_ingestion_plan_evidence(plan), plan)

    def test_arxiv_fetch_plan_matches_javascript_and_binds_arxiv_source_kind(self):
        plan = resolve_ingestion_plan_claim({
            "id": "arxiv.fetch-default",
            "version": "1.0.0",
            "contentSha256": ARXIV_FETCH_PLAN_HASH,
        })
        self.assertEqual(ingestion_plan_content_sha256(plan), ARXIV_FETCH_PLAN_HASH)
        self.assertEqual(plan["owner"]["pluginId"], "papers")
        self.assertEqual(plan["source"]["contributionId"], "arxiv.pdf")
        self.assertEqual(plan["source"]["implementationId"], "builtin.arxiv.pdf-source")
        self.assertEqual(plan["persist"]["routeId"], "arxiv.private-fetch-route")
        self.assertEqual(ingestion_plan_expected_source_kind(plan), "arxiv")
        self.assertEqual(resolve_stored_ingestion_plan_evidence(plan), plan)


if __name__ == "__main__":
    unittest.main()
