import asyncio
import base64
import hashlib
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import psycopg2
from fastapi import HTTPException, Request

from proof_work_state import empty_work_item
from proofs_blah_dev_adapter import PROOFS_BLAH_DEV_MEDIA_TYPE
from server import (
    PROOF_VERIFIER_ADAPTERS,
    IdentityContext,
    RegisteredProofVerifierAdapter,
    verify_proof_work_item,
)
from test_proofs_blah_dev_adapter import (
    ADAPTER_KEY,
    COMMIT,
    DECLARATION,
    MATHLIB,
    REPORT_BYTES,
    REPOSITORY,
    SOLUTION_SHA256,
    TEST_ADAPTER,
    sign,
    signed_report,
)


TENANT = "10000000-0000-4000-8000-000000000001"
PRINCIPAL = "20000000-0000-4000-8000-000000000001"
WORKSPACE_DB_ID = "30000000-0000-4000-8000-000000000001"
VERIFICATION_ID = "40000000-0000-4000-8000-000000000001"
ARTIFACT_ID = "50000000-0000-4000-8000-000000000001"
PUBKEY = "a" * 64
GRAPH_HASH = "b" * 64
NODE_ID = "zero-isExact2"
IMPLEMENTATION_SHA256 = "9" * 64


def workspace(version=3):
    return {
        "id": WORKSPACE_DB_ID,
        "tenant_id": TENANT,
        "workspace_key": "leanproofs-mission",
        "graph_id": "leanproofs-mission",
        "graph_content_sha256": GRAPH_HASH,
        "node_ids": [NODE_ID],
        "current_version": version,
        "updated_at": datetime(2026, 9, 29, 6, 0, tzinfo=timezone.utc),
    }


def candidate_state():
    state = empty_work_item(NODE_ID)
    state["version"] = 2
    state["proof"].update({
        "status": "candidate",
        "candidate_sha256": SOLUTION_SHA256,
        "candidate_submitted_at": "2026-09-29T05:40:00Z",
    })
    return state


class RuntimeCursor:
    """Ordinary API runtime: read-only workspace and graph lookups."""

    def __init__(self, *, activated=True):
        self.activated = activated
        self.queries = []
        self.next_row = None

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if normalized.startswith("SELECT * FROM gb_proof_workspaces"):
            self.next_row = workspace()
        elif normalized.startswith("SELECT source_graph.graph_json"):
            self.next_row = ({
                "source_graph_json": {
                    "revision": {
                        "repository": REPOSITORY,
                        "commit": COMMIT,
                        "lean_toolchain": "leanprover/lean4:v4.33.1",
                        "mathlib_revision": MATHLIB,
                    },
                },
                "mission_graph_json": {
                    "targets": [{
                        "target_id": NODE_ID,
                        "formal_binding": {
                            "binding_kind": "declaration",
                            "declaration_equivalence_claimed": True,
                            "declaration_ids": [DECLARATION],
                        },
                    }],
                },
            } if self.activated else None)
        else:
            raise AssertionError(f"runtime connection must not run: {normalized}")

    def fetchone(self):
        return self.next_row


class RegistrarError(psycopg2.Error):
    def __init__(self, pgcode):
        super().__init__("registrar rejected input")
        self._pgcode = pgcode

    @property
    def pgcode(self):
        return self._pgcode


class VerifierCursor:
    """gb_proof_verifier authority: one transaction for ledger plus transition."""

    def __init__(self, *, workspace_version=3, registrar_error=None, replay=False):
        self.workspace = workspace(workspace_version)
        self.item_state = candidate_state()
        self.registrar_error = registrar_error
        self.replay = replay
        self.queries = []
        self.registrar_params = None
        self.transition_params = None
        self.next_row = None
        self.rows = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        self.next_row = None
        self.rows = []
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK", "SET LOCAL ROLE gb_proof_verifier"}:
            return
        if normalized.startswith("SELECT * FROM gb_proof_workspaces"):
            self.next_row = self.workspace.copy()
        elif normalized.startswith("SELECT workspace_id, request_hash"):
            self.next_row = (
                {"workspace_id": WORKSPACE_DB_ID, "request_hash": self.replay}
                if self.replay else None
            )
        elif normalized.startswith("SELECT * FROM gb_proof_work_items"):
            self.next_row = {"current_version": 2, "state": self.item_state}
        elif normalized.startswith("INSERT INTO gb_artifacts"):
            self.next_row = {"id": ARTIFACT_ID}
        elif normalized.startswith("SELECT * FROM gb_record_accepted_proof_verification("):
            self.registrar_params = params
            if self.registrar_error:
                raise RegistrarError(self.registrar_error)
            self.next_row = {"verification_id": VERIFICATION_ID, "replayed": False}
        elif normalized.startswith("UPDATE gb_proof_work_items"):
            self.item_state = params[1].adapted
            self.next_row = {"id": "item-1"}
        elif normalized.startswith("UPDATE gb_proof_workspaces"):
            self.workspace["current_version"] = params[0]
            self.next_row = self.workspace.copy()
        elif normalized.startswith("INSERT INTO gb_proof_work_transitions"):
            self.transition_params = params
            self.next_row = {"id": "transition-1"}
        elif normalized.startswith("SELECT item.state,"):
            self.rows = [{"state": self.item_state, "trusted_verification": True}]
        else:
            raise AssertionError(f"unexpected verifier SQL: {normalized}")

    def fetchone(self):
        return self.next_row

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self.value = cursor

    def cursor(self):
        return self.value


def verification_request(receipt_bytes, *, adapter_key=ADAPTER_KEY, candidate=SOLUTION_SHA256):
    body = {
        "schema_id": "galaxy.trusted-proof-verification-request.v1",
        "graph_ref": {"graph_id": "leanproofs-mission", "content_sha256": GRAPH_HASH},
        "node_id": NODE_ID,
        "candidate_sha256": candidate,
        "expected_workspace_version": 3,
        "expected_item_version": 2,
        "idempotency_key": "verify-zero-isExact2-0001",
        "receipt": {
            "adapter_id": adapter_key[0],
            "adapter_version": adapter_key[1],
            "media_type": PROOFS_BLAH_DEV_MEDIA_TYPE,
            "content_encoding": "base64",
            "content_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "content_base64": base64.b64encode(receipt_bytes).decode("ascii"),
        },
    }
    content = json.dumps(body, separators=(",", ":")).encode("utf-8")
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": content, "more_body": False}

    return Request({"type": "http", "method": "POST", "path": "/"}, receive), content


class TrustedProofVerificationApiTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "agent", PUBKEY)

    def call(self, request, *, runtime=None, verifier=None, configured=True, test_adapter=True):
        runtime = runtime or RuntimeCursor()
        verifier = verifier or VerifierCursor()
        adapters = dict(PROOF_VERIFIER_ADAPTERS)
        if test_adapter:
            adapters[ADAPTER_KEY] = RegisteredProofVerifierAdapter(
                implementation_sha256=IMPLEMENTATION_SHA256, verify=TEST_ADAPTER
            )
        with patch.dict(PROOF_VERIFIER_ADAPTERS, adapters, clear=True), patch(
            "server.PROOF_VERIFIER_DB_URL", "postgresql://verifier" if configured else ""
        ), patch("server.get_conn", return_value=Connection(runtime)) as get_conn, patch(
            "server.get_proof_verifier_conn", return_value=Connection(verifier)
        ) as get_verifier_conn:
            try:
                return asyncio.run(verify_proof_work_item(
                    "leanproofs-mission", NODE_ID, request, self.identity,
                ))
            finally:
                self.get_conn = get_conn
                self.get_verifier_conn = get_verifier_conn

    def test_signed_report_appends_ledger_and_transition_in_one_authority_transaction(self):
        receipt = sign(signed_report())
        request, content = verification_request(receipt)
        verifier = VerifierCursor()
        response = self.call(request, verifier=verifier)

        self.assertEqual(verifier.queries[:2], ["BEGIN", "SET LOCAL ROLE gb_proof_verifier"])
        self.assertEqual(verifier.queries[-1], "COMMIT")
        params = verifier.registrar_params
        self.assertEqual(params[0], TENANT)
        self.assertEqual(params[3], SOLUTION_SHA256)
        self.assertEqual(params[4], ARTIFACT_ID)
        self.assertEqual(params[5], hashlib.sha256(receipt).hexdigest())
        self.assertEqual(params[6], PROOFS_BLAH_DEV_MEDIA_TYPE)
        self.assertEqual(params[7:13], (
            "proofs-blah-dev", "1", IMPLEMENTATION_SHA256,
            "proofs-blah-dev", "signed-report", SOLUTION_SHA256,
        ))
        self.assertEqual(params[13:18], (
            [DECLARATION], REPOSITORY, COMMIT, "leanprover/lean4:v4.33.1", MATHLIB,
        ))
        self.assertEqual(params[18], "2026-09-29T05:41:48.738000Z")
        self.assertIsNone(params[19])
        self.assertEqual(params[20:], (
            PRINCIPAL, PUBKEY, "verify-zero-isExact2-0001",
            hashlib.sha256(content).hexdigest(),
        ))

        transition = verifier.transition_params[6].adapted
        self.assertEqual(transition["type"], "proof.verify")
        verification = transition["payload"]["verification"]
        self.assertEqual(verification["method"], "signed-report")
        self.assertEqual(verification["receipt_id"], VERIFICATION_ID)
        self.assertIsNone(verification["hyades"])
        self.assertEqual(response["version"], 4)
        item = response["items"][0]
        self.assertEqual(item["proof"]["status"], "verified")
        self.assertEqual(item["work"]["status"], "closed")
        self.get_conn.assert_called()

    def test_real_report_without_origin_fails_closed_before_the_authority(self):
        request, _ = verification_request(REPORT_BYTES)
        with self.assertRaises(HTTPException) as caught:
            self.call(request, test_adapter=False)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("no recorded origin", caught.exception.detail)
        self.get_verifier_conn.assert_not_called()

    def test_unconfigured_authority_fails_closed_before_any_database_access(self):
        request, _ = verification_request(sign(signed_report()))
        with self.assertRaises(HTTPException) as caught:
            self.call(request, configured=False)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("authority is not configured", caught.exception.detail)
        self.get_conn.assert_not_called()
        self.get_verifier_conn.assert_not_called()

    def test_hyades_remains_disabled(self):
        request, _ = verification_request(sign(signed_report()), adapter_key=("hyades", "1"))
        with self.assertRaises(HTTPException) as caught:
            self.call(request)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("Hyades verifier adapter is disabled", caught.exception.detail)
        self.get_conn.assert_not_called()

    def test_rejected_receipts_never_reach_the_authority(self):
        cases = (
            (sign(signed_report(outcome="rejected")), SOLUTION_SHA256, "outcome is not verified"),
            (sign(signed_report()), "c" * 64, "does not match the Galaxy candidate"),
        )
        for receipt, candidate, message in cases:
            with self.subTest(message=message):
                request, _ = verification_request(receipt, candidate=candidate)
                with self.assertRaises(HTTPException) as caught:
                    self.call(request)
                self.assertEqual(caught.exception.status_code, 422)
                self.assertIn(message, caught.exception.detail)
                self.get_verifier_conn.assert_not_called()

    def test_unactivated_workspace_fails_closed(self):
        request, _ = verification_request(sign(signed_report()))
        with self.assertRaises(HTTPException) as caught:
            self.call(request, runtime=RuntimeCursor(activated=False))
        self.assertEqual(caught.exception.status_code, 409)
        self.get_verifier_conn.assert_not_called()

    def test_stale_workspace_version_rolls_back_before_the_registrar(self):
        request, _ = verification_request(sign(signed_report()))
        verifier = VerifierCursor(workspace_version=4)
        with self.assertRaises(HTTPException) as caught:
            self.call(request, verifier=verifier)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIsNone(verifier.registrar_params)
        self.assertEqual(verifier.queries[-1], "ROLLBACK")

    def test_registrar_rejections_are_mapped_and_roll_back(self):
        for pgcode, status in (("23514", 422), ("23505", 409), ("0A000", 503), ("42501", 403)):
            with self.subTest(pgcode=pgcode):
                request, _ = verification_request(sign(signed_report()))
                verifier = VerifierCursor(registrar_error=pgcode)
                with self.assertRaises(HTTPException) as caught:
                    self.call(request, verifier=verifier)
                self.assertEqual(caught.exception.status_code, status)
                self.assertIsNone(verifier.transition_params)
                self.assertEqual(verifier.queries[-1], "ROLLBACK")


if __name__ == "__main__":
    unittest.main()
