import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from fastapi import HTTPException, Request

from object_links import (
    ObjectLinkError, ReferentAccess, ReferentAccessError, authorize_referent,
    canonical_reference, parse_canonical_reference, validate_link_payload,
    validate_retraction_payload,
)
from server import (
    IdentityContext, _authorize_local_referent, _authorize_object_references,
    _authorize_proof_referent,
    create_object_link, list_object_links, object_link_history,
    retract_object_link,
)


TENANT = "30000000-0000-4000-8000-000000000001"
PRINCIPAL = "40000000-0000-4000-8000-000000000001"
SOURCE = "gb:object:v1:paper:2404.06147:latest"
TARGET = "gb:object:v1:ham.memory:3262:latest"
LINK_ID = "50000000-0000-4000-8000-000000000001"


def payload():
    return {
        "from_ref": SOURCE,
        "to_ref": TARGET,
        "relation": "related",
        "basis": "authored",
        "provenance": {"source": "manual", "source_system": "galaxy"},
        "idempotency_key": "paper-ham-3262",
    }


def request(body, *, human_session=True):
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    headers = [(b"x-gb-human-session", b"v1")] if human_session else []
    return Request({
        "type": "http", "method": "POST", "path": "/object-links",
        "query_string": b"", "headers": headers,
    }, receive)


class Cursor:
    def __init__(self, inserted=None, existing=None, rows=None):
        self.inserted = inserted
        self.existing = existing
        self.rows = rows or []
        self.queries = []

    def execute(self, statement, parameters=None):
        self.queries.append((" ".join(statement.split()), parameters))

    def fetchone(self):
        if len(self.queries) == 1:
            return self.inserted
        return self.existing

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class SequencedCursor(Cursor):
    def __init__(self, responses):
        super().__init__()
        self.responses = list(responses)

    def fetchone(self):
        return self.responses.pop(0)


class ObjectLinkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = IdentityContext(TENANT, PRINCIPAL, "human")
        def allow(_cur, values, identity):
            result = {}
            for value in values:
                reference = parse_canonical_reference(value)
                result[value] = ReferentAccess(
                    value, identity.tenant_id, identity.principal_id, True,
                    reference.revision, "test",
                )
            return result
        self.authorization_patch = patch("server._authorize_object_references", side_effect=allow)
        self.authorization_patch.start()

    def tearDown(self):
        if self.authorization_patch is not None:
            self.authorization_patch.stop()

    def test_references_are_exact_and_revision_bounded(self):
        self.assertEqual(canonical_reference(TARGET), TARGET)
        self.assertEqual(canonical_reference("gb:object:v1:paper:%C3%A9:pinned:rev%3A1"),
                         "gb:object:v1:paper:%C3%A9:pinned:rev%3A1")
        for invalid in (
            "gb:node:123", "gb:object:v1:paper:%C3%A9:latest:extra",
            "gb:object:v1:paper:%c3%a9:latest", "gb:object:v1:paper:%ZZ:latest",
            "gb:object:v1:paper:abc:pinned:",
            "gb:object:v1:paper:abc:pinned:" + "x" * 257,
            "gb:object:v1:paper:" + "x" * 513 + ":latest",
            "gb:object:v1:paper:abc%2Fdef:latest:extra",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ObjectLinkError):
                canonical_reference(invalid)

    async def test_active_mutations_require_a_human_browser_session(self):
        for identity in (
            IdentityContext(TENANT, PRINCIPAL, "agent"),
            IdentityContext(TENANT, PRINCIPAL, "service"),
            self.identity,
        ):
            with self.subTest(kind=identity.principal_kind), self.assertRaises(HTTPException) as denied:
                await create_object_link(request(json.dumps(payload()).encode(), human_session=False), identity)
            self.assertEqual(denied.exception.status_code, 403)

    def test_payload_rejects_unattributed_or_epistemically_misleading_links(self):
        validated = validate_link_payload(payload())
        self.assertEqual(validated["relation"], "related")
        for update in (
            {"relation": "verified"}, {"relation": "supports"},
            {"basis": "ham_candidate"}, {"to_ref": SOURCE},
            {"basis": "imported"}, {"provenance": {"source": "import"}},
            {"provenance": {"source": "manual", "source_system": "galaxy", "verified": True}},
        ):
            with self.subTest(update=update), self.assertRaises(ObjectLinkError):
                validate_link_payload({**payload(), **update})
        imported = {**payload(), "basis": "imported", "provenance": {
            "source": "import", "source_system": "codebase-memory",
            "source_ref": "repository:MonumentalSystems/LeanProofs@sha",
            "source_snapshot": f"sha256:{'a' * 64}", "extractor_version": "0.8.1",
        }}
        self.assertEqual(validate_link_payload(imported)["basis"], "imported")

    def test_code_and_proof_links_require_reproducible_pins_and_rich_provenance(self):
        revision = f"git:{'a' * 40};snapshot:sha256:{'b' * 64}"
        code = f"gb:object:v1:code.symbol:code%3Av1%3Aorg%252Frepo%3AMath.lean%3Atheorem:pinned:{revision.replace(':', '%3A').replace(';', '%3B')}"
        proof = f"gb:object:v1:proof.node:graph-1%23node-1:pinned:sha256%3A{'c' * 64}"
        derived = {
            "from_ref": proof, "to_ref": code, "relation": "formalized_by",
            "basis": "derived", "idempotency_key": "proof-code-link-1",
            "provenance": {
                "source": "derivation", "source_system": "prove2me",
                "source_ref": "graph-1#node-1", "source_snapshot": f"sha256:{'c' * 64}",
                "extractor_version": "prove2me-adapter@1", "confidence": 1.0,
            },
        }
        self.assertEqual(validate_link_payload(derived)["relation"], "formalized_by")
        with self.assertRaisesRegex(ObjectLinkError, "pinned revision"):
            validate_link_payload({**derived, "to_ref": "gb:object:v1:code.symbol:code%3Av1%3Arepo%3Asym:latest"})
        with self.assertRaisesRegex(ObjectLinkError, "source_snapshot"):
            validate_link_payload({**derived, "provenance": {**derived["provenance"], "source_snapshot": "main"}})

    def test_document_and_anchor_links_require_sha256_pinned_revisions(self):
        document = (
            "gb:object:v1:document:4fb6d8f3-b111-46ff-bf4a-70eca7aebfd7:"
            f"pinned:sha256%3A{'d' * 64}"
        )
        anchor = (
            f"gb:object:v1:document.anchor:sha256%3A{'a' * 64}:"
            f"pinned:sha256%3A{'e' * 64}"
        )
        linked = {
            "from_ref": document,
            "to_ref": anchor,
            "relation": "context_for",
            "basis": "authored",
            "provenance": {"source": "manual", "source_system": "galaxy"},
            "idempotency_key": "document-anchor-link-1",
        }

        self.assertEqual(validate_link_payload(linked)["to_ref"], anchor)
        for field, invalid in (
            ("from_ref", "gb:object:v1:document:4fb6d8f3-b111-46ff-bf4a-70eca7aebfd7:latest"),
            ("to_ref", f"gb:object:v1:document.anchor:sha256%3A{'a' * 64}:latest"),
            ("from_ref", "gb:object:v1:document:4fb6d8f3-b111-46ff-bf4a-70eca7aebfd7:pinned:revision-1"),
            ("to_ref", f"gb:object:v1:document.anchor:sha256%3A{'a' * 64}:pinned:sha256%3A{'A' * 64}"),
        ):
            with self.subTest(field=field, invalid=invalid), self.assertRaisesRegex(
                ObjectLinkError, "pinned revision|Invalid pinned revision",
            ):
                validate_link_payload({**linked, field: invalid})

    def test_chat_links_require_an_exact_sha256_snapshot(self):
        digest = "d" * 64
        chat = (
            "gb:object:v1:chat:80000000-0000-4000-8000-000000000001:"
            f"pinned:sha256%3A{digest}"
        )
        linked = {**payload(), "from_ref": chat, "idempotency_key": "chat-memory-link-1"}
        self.assertEqual(validate_link_payload(linked)["from_ref"], chat)
        for invalid in (
            "gb:object:v1:chat:80000000-0000-4000-8000-000000000001:latest",
            "gb:object:v1:chat:80000000-0000-4000-8000-000000000001:pinned:version%3A3",
            f"gb:object:v1:chat:80000000-0000-4000-8000-000000000001:pinned:sha256%3A{'D' * 64}",
        ):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(
                ObjectLinkError, "pinned revision|Invalid pinned revision",
            ):
                validate_link_payload({**linked, "from_ref": invalid})

    def test_pinned_chat_authorization_is_local_tenant_scoped_and_revision_exact(self):
        digest = "e" * 64
        wire = (
            "gb:object:v1:chat:80000000-0000-4000-8000-000000000001:"
            f"pinned:sha256%3A{digest}"
        )
        reference = parse_canonical_reference(wire)
        cursor = SequencedCursor([{"content_hash": f"sha256:{digest}"}])
        with patch("server._authorize_remote_referents") as remote:
            result = _authorize_object_references(cursor, [wire], self.identity)
        remote.assert_not_called()
        self.assertEqual(result[wire].reference, wire)
        self.assertEqual(result[wire].resolved_revision, f"sha256:{digest}")
        self.assertEqual(result[wire].provider, "galaxy.conversation")
        sql, parameters = cursor.queries[0]
        self.assertIn("gb_conversation_revisions", sql)
        self.assertEqual(parameters, (
            TENANT, "80000000-0000-4000-8000-000000000001", f"sha256:{digest}",
        ))

        missing = Cursor(inserted=None)
        self.assertIsNone(_authorize_local_referent(missing, reference, self.identity))
        latest = parse_canonical_reference(
            "gb:object:v1:chat:80000000-0000-4000-8000-000000000001:latest"
        )
        latest_cursor = Cursor()
        self.assertIsNone(_authorize_local_referent(latest_cursor, latest, self.identity))
        self.assertEqual(latest_cursor.queries, [])

    def test_experiment_authorization_is_local_tenant_scoped_and_follow_latest_only(self):
        experiment_id = "82000000-0000-4000-8000-000000000001"
        wire = f"gb:object:v1:eln.experiment:{experiment_id}:latest"
        cursor = SequencedCursor([{"?column?": 1}])
        with patch("server._authorize_remote_referents") as remote:
            result = _authorize_object_references(cursor, [wire], self.identity)
        remote.assert_not_called()
        self.assertEqual(result[wire].reference, wire)
        self.assertIsNone(result[wire].resolved_revision)
        sql, parameters = cursor.queries[0]
        self.assertIn("FROM gb_experiments WHERE tenant_id = %s", sql)
        self.assertEqual(parameters, (TENANT, experiment_id))

        missing = SequencedCursor([None])
        self.assertIsNone(_authorize_local_referent(
            missing, parse_canonical_reference(wire), self.identity,
        ))
        # Experiments have no content-addressed revision to pin against.
        pinned = parse_canonical_reference(
            f"gb:object:v1:eln.experiment:{experiment_id}:pinned:sha256%3A{'8' * 64}"
        )
        pinned_cursor = Cursor()
        self.assertIsNone(_authorize_local_referent(pinned_cursor, pinned, self.identity))
        self.assertEqual(pinned_cursor.queries, [])

    def test_observation_authorization_is_tenant_scoped_revision_exact_and_provider_stable(self):
        observation_id = "81000000-0000-4000-8000-000000000001"
        digest = "7" * 64
        pinned_wire = (
            f"gb:object:v1:eln.observation:{observation_id}:"
            f"pinned:sha256%3A{digest}"
        )
        pinned = parse_canonical_reference(pinned_wire)
        pinned_cursor = SequencedCursor([{"revision_sha256": digest}])
        pinned_access = _authorize_local_referent(pinned_cursor, pinned, self.identity)
        self.assertEqual(pinned_access.reference, pinned_wire)
        self.assertEqual(pinned_access.resolved_revision, f"sha256:{digest}")
        self.assertEqual(pinned_access.provider, "galaxy-brain-eln")
        self.assertEqual(pinned_cursor.queries[0][1], (TENANT, observation_id, digest))
        self.assertIn("observation.tenant_id = %s", pinned_cursor.queries[0][0])

        latest_wire = f"gb:object:v1:eln.observation:{observation_id}:latest"
        latest = parse_canonical_reference(latest_wire)
        latest_cursor = SequencedCursor([{"revision_sha256": digest}])
        latest_access = _authorize_local_referent(latest_cursor, latest, self.identity)
        self.assertEqual(latest_access.reference, latest_wire)
        self.assertEqual(latest_access.resolved_revision, f"sha256:{digest}")
        self.assertEqual(latest_access.provider, "galaxy-brain-eln")
        self.assertEqual(latest_cursor.queries[0][1], (TENANT, observation_id))

        missing = SequencedCursor([None])
        self.assertIsNone(_authorize_local_referent(missing, pinned, self.identity))

    def test_authorization_decision_is_bound_to_tenant_principal_reference_and_revision(self):
        reference = f"gb:object:v1:proof.graph:graph-1:pinned:sha256%3A{'a' * 64}"
        parsed = parse_canonical_reference(reference)
        valid = ReferentAccess(reference, TENANT, PRINCIPAL, True, parsed.revision, "prove2me")
        self.assertEqual(authorize_referent(reference, self.identity, {"proof.graph": lambda *_: valid}), valid)
        for decision in (
            None,
            ReferentAccess(reference, "wrong-tenant", PRINCIPAL, True, parsed.revision),
            ReferentAccess(reference, TENANT, "wrong-principal", True, parsed.revision),
            ReferentAccess(reference, TENANT, PRINCIPAL, False, parsed.revision),
            ReferentAccess(reference, TENANT, PRINCIPAL, True, f"sha256:{'b' * 64}"),
        ):
            with self.subTest(decision=decision), self.assertRaises(ReferentAccessError):
                authorize_referent(reference, self.identity, {"proof.graph": lambda *_args, d=decision: d})

    def test_proof_node_resolution_includes_registered_nodes_without_work_state(self):
        digest = "c" * 64
        cursor = Cursor(existing=None)
        cursor.inserted = {"content_sha256": digest}
        reference = parse_canonical_reference(
            f"gb:object:v1:proof.node:graph-1%23untouched:pinned:sha256%3A{digest}"
        )
        access = _authorize_proof_referent(cursor, reference, self.identity)
        self.assertTrue(access.readable)
        sql, params = cursor.queries[0]
        self.assertIn("ANY(graph.node_ref_ids)", sql)
        self.assertNotIn("gb_proof_work_items", sql)
        self.assertEqual(params, (TENANT, "graph-1#untouched", digest))

    def test_retraction_requires_version_reason_and_idempotency(self):
        valid = {"expected_version": 1, "reason": "Wrong association", "idempotency_key": "retract-link-1"}
        self.assertEqual(validate_retraction_payload(valid), valid)
        for update in (
            {"expected_version": True}, {"expected_version": 0},
            {"reason": " "}, {"reason": "x" * 1025},
            {"idempotency_key": "short"},
        ):
            with self.subTest(update=update), self.assertRaises(ObjectLinkError):
                validate_retraction_payload({**valid, **update})

    async def test_create_is_tenant_bound_and_idempotent(self):
        record = {
            "id": "50000000-0000-4000-8000-000000000001",
            "from_ref": SOURCE, "to_ref": TARGET, "relation": "related",
            "basis": "authored", "provenance": {"source": "manual", "source_system": "galaxy"},
            "created_by_principal_id": PRINCIPAL, "created_at": "2026-09-19T00:00:00Z",
        }
        cursor = Cursor(inserted=record)

        @contextmanager
        def transaction(_conn):
            yield cursor

        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await create_object_link(request(json.dumps(payload()).encode()), self.identity)
        self.assertEqual(result["id"], record["id"])
        sql, params = cursor.queries[0]
        self.assertIn("ON CONFLICT (tenant_id, idempotency_key) DO NOTHING", sql)
        self.assertEqual(params[0], TENANT)
        self.assertEqual(params[6], PRINCIPAL)

        cursor = Cursor(inserted=None, existing={**record, "request_sha256": params[8]})
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            replay = await create_object_link(request(json.dumps(payload()).encode()), self.identity)
        self.assertEqual(replay["id"], record["id"])

        cursor = Cursor(inserted=None, existing={**record, "request_sha256": "0" * 64})
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            with self.assertRaises(HTTPException) as caught:
                await create_object_link(request(json.dumps(payload()).encode()), self.identity)
        self.assertEqual(caught.exception.status_code, 409)

    async def test_reads_require_one_canonical_ref_and_tenant_filter(self):
        cursor = Cursor(rows=[])
        with patch("server.get_conn", return_value=Connection(cursor)):
            self.assertEqual(list_object_links(TARGET, 50, self.identity), [])
        sql, params = cursor.queries[0]
        self.assertIn("tenant_id = %s", sql)
        self.assertEqual(params, (TENANT, TARGET, TARGET, 50))
        self.assertIn("NOT EXISTS", sql)
        self.assertIn("gb_object_link_retractions", sql)
        with self.assertRaises(HTTPException) as caught:
            list_object_links("gb:node:123", 50, self.identity)
        self.assertEqual(caught.exception.status_code, 422)

    async def test_list_batches_duplicate_referents_and_omits_denied_neighbors(self):
        self.authorization_patch.stop()
        self.authorization_patch = None
        allowed = "gb:object:v1:ham.memory:allowed:latest"
        denied = "gb:object:v1:ham.memory:denied:latest"
        rows = [
            {"id": "1", "from_ref": TARGET, "to_ref": allowed},
            {"id": "2", "from_ref": TARGET, "to_ref": allowed},
            {"id": "3", "from_ref": TARGET, "to_ref": denied},
        ]
        cursor = Cursor(rows=rows)

        def decisions(references, identity):
            self.assertEqual({reference.wire for reference in references}, {TARGET, allowed, denied})
            return {
                wire: {
                    "reference": wire, "tenant_id": identity.tenant_id,
                    "principal_id": identity.principal_id, "readable": True,
                    "resolved_revision": None, "provider": "ham",
                }
                for wire in (TARGET, allowed)
            }

        with patch("server.get_conn", return_value=Connection(cursor)), patch(
            "server._authorize_remote_referents", side_effect=decisions,
        ) as resolver:
            result = list_object_links(TARGET, 50, self.identity)
        self.assertEqual([row["id"] for row in result], ["1", "2"])
        resolver.assert_called_once()
        with self.assertRaises(HTTPException) as caught:
            list_object_links(TARGET, 101, self.identity)
        self.assertEqual(caught.exception.status_code, 422)

    async def test_history_retains_assertion_and_retraction_with_tenant_scope(self):
        assertion = {
            "id": LINK_ID, "from_ref": SOURCE, "to_ref": TARGET,
            "relation": "related", "basis": "authored",
            "provenance": {"source": "manual", "source_system": "galaxy"},
            "created_by_principal_id": PRINCIPAL, "created_at": "2026-09-19T00:00:00Z",
        }
        correction = {
            "id": "60000000-0000-4000-8000-000000000001", "link_id": LINK_ID,
            "expected_version": 1, "reason": "Wrong association",
            "retracted_by_principal_id": PRINCIPAL, "created_at": "2026-09-19T01:00:00Z",
        }
        cursor = SequencedCursor([assertion, correction])
        with patch("server.get_conn", return_value=Connection(cursor)):
            history = object_link_history(LINK_ID, self.identity)
        self.assertFalse(history["active"])
        self.assertEqual(history["current_version"], 2)
        self.assertEqual(history["assertion"]["version"], 1)
        self.assertEqual(history["retraction"]["version"], 2)
        self.assertEqual(cursor.queries[0][1], (TENANT, LINK_ID))
        self.assertEqual(cursor.queries[1][1], (TENANT, LINK_ID))

    async def test_retraction_is_creator_or_admin_only_and_idempotent(self):
        body = {"expected_version": 1, "reason": "Wrong association", "idempotency_key": "retract-link-1"}
        assertion = {"id": LINK_ID, "created_by_principal_id": PRINCIPAL}
        correction = {
            "id": "60000000-0000-4000-8000-000000000001", "link_id": LINK_ID,
            "expected_version": 1, "reason": body["reason"],
            "retracted_by_principal_id": PRINCIPAL, "created_at": "2026-09-19T01:00:00Z",
        }

        @contextmanager
        def transaction(conn):
            yield conn.cursor()

        other = IdentityContext(TENANT, "70000000-0000-4000-8000-000000000001", "human", role="member")
        cursor = SequencedCursor([assertion])
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            with self.assertRaises(HTTPException) as caught:
                await retract_object_link(LINK_ID, request(json.dumps(body).encode()), other)
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(len(cursor.queries), 1)

        cursor = SequencedCursor([assertion, correction])
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            result = await retract_object_link(LINK_ID, request(json.dumps(body).encode()), self.identity)
        self.assertEqual(result["version"], 2)
        self.assertEqual(cursor.queries[1][1][:2], (TENANT, LINK_ID))
        self.assertIn("ON CONFLICT DO NOTHING", cursor.queries[1][0])

        cursor = SequencedCursor([assertion, None, {**correction, "idempotency_key": body["idempotency_key"],
                                                   "request_sha256": cursor.queries[1][1][-1]}])
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            replay = await retract_object_link(LINK_ID, request(json.dumps(body).encode()), self.identity)
        self.assertEqual(replay["id"], correction["id"])

        cursor = SequencedCursor([assertion, None, {**correction, "idempotency_key": "someone-else",
                                                   "request_sha256": "0" * 64}])
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            with self.assertRaises(HTTPException) as caught:
                await retract_object_link(LINK_ID, request(json.dumps(body).encode()), self.identity)
        self.assertEqual(caught.exception.status_code, 409)

        admin = IdentityContext(TENANT, other.principal_id, "human", role="admin")
        cursor = SequencedCursor([assertion, correction])
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            self.assertEqual((await retract_object_link(
                LINK_ID, request(json.dumps(body).encode()), admin,
            ))["version"], 2)

        cursor = SequencedCursor([assertion])
        stale = {**body, "expected_version": 2}
        with patch("server.get_conn", return_value=Connection(cursor)), patch("server._transaction", transaction):
            with self.assertRaises(HTTPException) as caught:
                await retract_object_link(LINK_ID, request(json.dumps(stale).encode()), self.identity)
        self.assertEqual(caught.exception.status_code, 409)

    async def test_create_rejects_oversize_and_duplicate_json_fields(self):
        with self.assertRaises(HTTPException) as caught:
            await create_object_link(request(b"{" + b"x" * 33000 + b"}"), self.identity)
        self.assertEqual(caught.exception.status_code, 413)
        duplicate = json.dumps(payload()).replace('"relation": "related",',
            '"relation": "related", "relation": "cites",')
        with self.assertRaises(HTTPException) as caught:
            await create_object_link(request(duplicate.encode()), self.identity)
        self.assertEqual(caught.exception.status_code, 422)

    async def test_public_create_cannot_use_the_server_owned_link_namespace(self):
        internal = {**payload(), "idempotency_key": "gb.internal:paper-document-link:revision-1"}
        with self.assertRaises(HTTPException) as caught:
            await create_object_link(request(json.dumps(internal).encode()), self.identity)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(caught.exception.detail, "Reserved object link idempotency key")
