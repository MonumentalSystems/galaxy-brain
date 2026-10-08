import unittest
from unittest.mock import patch

from fastapi import HTTPException

from canvas_contract import SNAPSHOT_SCHEMA, canonical_hash, snapshot_hash
from server import (
    CanvasCreate,
    CanvasMutation,
    IdentityContext,
    create_canvas,
    list_canvases,
    list_canvas_revisions,
    mutate_canvas,
    list_surfaces,
    _canvas_or_404,
    _canvas_replay,
    _authorize_local_referent,
    _validate_surface_placement_commands,
    _validate_frame_mutation_authority,
)
from object_links import parse_canonical_reference


TENANT_ID = "10000000-0000-4000-8000-000000000001"
PRINCIPAL_ID = "20000000-0000-4000-8000-000000000001"
OTHER_PRINCIPAL_ID = "20000000-0000-4000-8000-000000000002"
CANVAS_ID = "30000000-0000-4000-8000-000000000001"
REVISION_ID = "40000000-0000-4000-8000-000000000001"
EMPTY = {
    "schemaId": SNAPSHOT_SCHEMA,
    "items": [],
    "edges": [],
    "removedItemIds": [],
    "removedEdgeIds": [],
}
EMPTY_HASH = snapshot_hash(EMPTY)


class Cursor:
    def __init__(self, rows):
        self.rows = iter(rows)
        self.current = None
        self.statements = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        self.statements.append((normalized, params))
        if normalized in {"BEGIN", "COMMIT", "ROLLBACK"}:
            self.current = None
        else:
            self.current = next(self.rows, None)

    def fetchone(self):
        return self.current

    def fetchall(self):
        if self.current is None:
            return []
        return self.current if isinstance(self.current, list) else [self.current]


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


class CanvasApiTests(unittest.TestCase):
    def setUp(self):
        self.identity = IdentityContext(
            tenant_id=TENANT_ID,
            principal_id=PRINCIPAL_ID,
            principal_kind="human",
            role="member",
        )
        self.canvas = {
            "id": CANVAS_ID,
            "tenant_id": TENANT_ID,
            "workspace_id": "workspace-main",
            "slug": "main",
            "title": "Research atlas",
            "is_default": True,
            "projection_mode": "ambient",
            "current_version": 1,
            "current_content_hash": EMPTY_HASH,
            "created_by_principal_id": PRINCIPAL_ID,
            "removed_item_ids": [],
            "removed_edge_ids": [],
            "creation_idempotency_key": "canvas-create-1",
            "creation_request_hash": "unused",
            "created_at": "2026-09-23T00:00:00Z",
            "updated_at": "2026-09-23T00:00:00Z",
        }

    def test_frame_mutations_require_human_authority(self):
        _validate_frame_mutation_authority([{"type": "frame.create"}], self.identity)
        for principal_kind in ("agent", "service"):
            identity = IdentityContext(
                tenant_id=TENANT_ID,
                principal_id=PRINCIPAL_ID,
                principal_kind=principal_kind,
                role="member",
            )
            with self.assertRaises(HTTPException) as raised:
                _validate_frame_mutation_authority([{"type": "frame.remove"}], identity)
            self.assertEqual(raised.exception.status_code, 403)
        agent = IdentityContext(
            tenant_id=TENANT_ID,
            principal_id=PRINCIPAL_ID,
            principal_kind="agent",
            role="member",
        )
        _validate_frame_mutation_authority([{"type": "item.move"}], agent)

    def test_frame_authority_is_checked_before_idempotent_replay(self):
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="human-frame-replay",
            commands=[{"type": "frame.remove", "frameId": "sources"}],
        )
        for principal_kind in ("agent", "service"):
            identity = IdentityContext(
                tenant_id=TENANT_ID,
                principal_id=OTHER_PRINCIPAL_ID,
                principal_kind=principal_kind,
                role="service",
            )
            with (
                patch("server.get_conn", side_effect=AssertionError("authority must precede replay lookup")),
                patch("server._canvas_replay", side_effect=AssertionError("replay lookup must not run")),
                self.assertRaises(HTTPException) as raised,
            ):
                mutate_canvas(CANVAS_ID, request, identity)
            self.assertEqual(raised.exception.status_code, 403)

    def test_malformed_frame_tone_is_a_bounded_422(self):
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="malformed-frame-tone",
            commands=[{"type": "frame.create", "frame": {
                "id": "sources", "title": "Sources", "x": 0, "y": 0,
                "width": 720, "height": 480, "tone": {"name": "sage"},
            }}],
        )
        with (
            patch("server.get_conn", side_effect=AssertionError("invalid contract must not reach storage")),
            self.assertRaises(HTTPException) as raised,
        ):
            mutate_canvas(CANVAS_ID, request, self.identity)
        self.assertEqual(raised.exception.status_code, 422)

    def test_frame_create_persists_in_current_rows_and_revision_snapshot(self):
        frame = {
            "id": "sources", "title": "Sources 😀", "x": -40, "y": 20,
            "width": 720, "height": 480, "tone": "sage",
        }
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="frame-create-sources",
            commands=[{"type": "frame.create", "frame": frame}],
        )
        next_content = {**EMPTY, "frames": [frame]}
        next_hash = snapshot_hash(next_content)
        updated = {**self.canvas, "current_version": 2, "current_content_hash": next_hash}
        cursor = Cursor([updated, {"id": REVISION_ID}])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=self.canvas),
            patch("server._canvas_content", return_value=EMPTY),
            patch("server._synchronize_canvas_rows") as synchronize,
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertEqual(result["content"], next_content)
        self.assertEqual(result["contentHash"], next_hash)
        synchronize.assert_called_once_with(cursor, self.canvas, next_content, self.identity)
        revision_insert = next(
            params for statement, params in cursor.statements
            if "INSERT INTO gb_canvas_revisions" in statement
        )
        self.assertEqual(revision_insert[6], "frame-create-sources")
        self.assertEqual(revision_insert[5].adapted, next_content)

    def test_human_frame_replay_returns_the_original_exact_snapshot(self):
        frame = {
            "id": "sources", "title": "Sources 😀", "x": -40, "y": 20,
            "width": 720, "height": 480, "tone": "sage",
        }
        content = {**EMPTY, "frames": [frame]}
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="frame-create-sources",
            commands=[{"type": "frame.create", "frame": frame}],
        )
        replay = {
            "id": REVISION_ID,
            "canvas_id": CANVAS_ID,
            "version": 2,
            "content_hash": snapshot_hash(content),
            "snapshot_json": content,
            "request_hash": "request",
        }
        cursor = Cursor([])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_or_404", return_value=self.canvas),
            patch("server._canvas_replay", return_value=replay),
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertTrue(result["replayed"])
        self.assertEqual(result["content"], content)
        self.assertEqual([statement for statement, _ in cursor.statements], ["BEGIN", "COMMIT"])

    def test_frame_move_resize_and_remove_persist_successfully(self):
        frame = {
            "id": "sources", "title": "Sources", "x": 10, "y": 20,
            "width": 720, "height": 480, "tone": "sage",
        }
        current_content = {**EMPTY, "frames": [frame]}
        cases = [
            (
                "move",
                {"type": "frame.move", "frameId": "sources", "position": {"x": 40, "y": 50}},
                {**EMPTY, "frames": [{**frame, "x": 40, "y": 50}]},
            ),
            (
                "resize",
                {"type": "frame.resize", "frameId": "sources", "size": {"width": 800, "height": 600}},
                {**EMPTY, "frames": [{**frame, "width": 800, "height": 600}]},
            ),
            (
                "remove",
                {"type": "frame.remove", "frameId": "sources"},
                EMPTY,
            ),
        ]
        for label, command, expected_content in cases:
            with self.subTest(operation=label):
                current_hash = snapshot_hash(current_content)
                request = CanvasMutation(
                    expectedVersion=1,
                    expectedContentHash=current_hash,
                    idempotencyKey=f"frame-{label}-sources",
                    commands=[command],
                )
                current_canvas = {**self.canvas, "current_content_hash": current_hash}
                next_hash = snapshot_hash(expected_content)
                updated = {**current_canvas, "current_version": 2, "current_content_hash": next_hash}
                cursor = Cursor([updated, {"id": REVISION_ID}])
                with (
                    patch("server.get_conn", return_value=Connection(cursor)),
                    patch("server._canvas_replay", return_value=None),
                    patch("server._canvas_or_404", return_value=current_canvas),
                    patch("server._canvas_content", return_value=current_content),
                    patch("server._synchronize_canvas_rows") as synchronize,
                ):
                    result = mutate_canvas(CANVAS_ID, request, self.identity)

                self.assertEqual(result["content"], expected_content)
                self.assertEqual(result["contentHash"], next_hash)
                synchronize.assert_called_once_with(cursor, current_canvas, expected_content, self.identity)

    def test_stale_frame_resize_returns_the_authoritative_tenant_canvas_head(self):
        current_hash = f"sha256:{'a' * 64}"
        stale_canvas = {**self.canvas, "current_version": 2, "current_content_hash": current_hash}
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="frame-resize-stale",
            commands=[{
                "type": "frame.resize", "frameId": "sources",
                "size": {"width": 800, "height": 500},
            }],
        )
        cursor = Cursor([])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=stale_canvas) as lookup,
            self.assertRaises(HTTPException) as raised,
        ):
            mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["currentVersion"], 2)
        self.assertEqual(raised.exception.detail["currentContentHash"], current_hash)
        lookup.assert_called_once_with(CANVAS_ID, self.identity, cur=cursor, for_update=True)

    def test_create_writes_the_empty_snapshot_and_one_revision(self):
        cursor = Cursor([None, None, None, None, self.canvas, {"id": REVISION_ID}])
        request = CanvasCreate(
            workspaceId="workspace-main",
            title="Research atlas",
            idempotencyKey="canvas-create-1",
        )
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = create_canvas(request, self.identity)

        self.assertEqual(result["version"], 1)
        self.assertEqual(result["content"], EMPTY)
        self.assertEqual(result["contentHash"], EMPTY_HASH)
        self.assertEqual(result["slug"], "main")
        self.assertTrue(result["isDefault"])
        self.assertEqual(result["projectionMode"], "ambient")
        self.assertEqual(result["mutationId"], REVISION_ID)
        sql = "\n".join(statement for statement, _ in cursor.statements)
        self.assertIn("INSERT INTO gb_canvases", sql)
        self.assertIn("INSERT INTO gb_canvas_revisions", sql)
        self.assertNotIn("canvas-harness", sql)

    def test_surface_placements_require_an_exact_promoted_revision(self):
        digest = "a" * 64
        reference = f"gb:object:v1:surface:surface-1:pinned:sha256%3A{digest}"
        item = {"subjectRef": reference, "nodeType": "galaxy.surface"}

        accepted = Cursor([{"content_hash": digest}])
        _validate_surface_placement_commands(
            accepted,
            [{"type": "item.place", "item": item}],
            self.identity,
        )
        self.assertIn("revision.status = 'promoted'", accepted.statements[0][0])

        for rejected_item in [
            {**item, "subjectRef": "gb:object:v1:surface:surface-1:latest"},
            {**item, "nodeType": "galaxy.note"},
            {**item, "subjectRef": "gb:object:v1:document:document-1:latest"},
        ]:
            with self.subTest(item=rejected_item), self.assertRaises(HTTPException) as caught:
                _validate_surface_placement_commands(
                    Cursor([None]),
                    [{"type": "item.place", "item": rejected_item}],
                    self.identity,
                )
            self.assertEqual(caught.exception.status_code, 422)

        with self.assertRaises(HTTPException) as caught:
            _validate_surface_placement_commands(
                Cursor([None]),
                [{"type": "item.place", "item": item}],
                self.identity,
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_surface_listing_searches_the_full_promoted_set_before_limiting(self):
        cursor = Cursor([[{"id": "surface-old", "title": "Older result"}]])
        with patch("server.get_conn", return_value=Connection(cursor)):
            rows = list_surfaces("promoted", "Older", 200, self.identity)

        self.assertEqual(rows[0]["id"], "surface-old")
        statement, params = cursor.statements[0]
        self.assertIn("status = %s", statement)
        self.assertIn("position(lower(%s) in lower(title)) > 0", statement)
        self.assertLess(statement.index("position(lower(%s)"), statement.index("LIMIT %s"))
        self.assertEqual(params, ["promoted", "Older", 200])

    def test_concurrent_create_replays_the_winning_revision(self):
        raced = {
            **self.canvas,
            "creation_request_hash": canonical_hash({
                "workspaceId": "workspace-main",
                "slug": "main",
                "title": "Research atlas",
                "makeDefault": False,
            }),
        }
        cursor = Cursor([None, raced])
        request = CanvasCreate(
            workspaceId="workspace-main",
            title="Research atlas",
            idempotencyKey="canvas-create-1",
        )
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_content", return_value=EMPTY),
        ):
            result = create_canvas(request, self.identity)

        self.assertTrue(result["replayed"])
        sql = "\n".join(statement for statement, _ in cursor.statements)
        self.assertIn("creation_idempotency_key = %s", sql)
        self.assertNotIn("INSERT INTO gb_canvases", sql)
        self.assertNotIn("INSERT INTO gb_canvas_revisions", sql)

    def test_named_canvas_can_replace_the_workspace_default_atomically(self):
        named = {
            **self.canvas,
            "id": "30000000-0000-4000-8000-000000000002",
            "slug": "proof-map",
            "title": "Proof map",
            "projection_mode": "curated",
            "creation_idempotency_key": "canvas-create-proof-map",
        }
        cursor = Cursor([
            None,
            None,
            None,
            {"id": CANVAS_ID},
            None,
            named,
            {"id": REVISION_ID},
        ])
        request = CanvasCreate(
            workspaceId="workspace-main",
            slug="proof-map",
            title="Proof map",
            makeDefault=True,
            projectionMode="curated",
            idempotencyKey="canvas-create-proof-map",
        )
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = create_canvas(request, self.identity)

        self.assertTrue(result["isDefault"])
        self.assertEqual(result["projectionMode"], "curated")
        statements = [statement for statement, _ in cursor.statements]
        self.assertTrue(any("SET is_default = false" in statement for statement in statements))
        insert = next((entry for entry in cursor.statements if "INSERT INTO gb_canvases" in entry[0]), None)
        self.assertIsNotNone(insert)
        self.assertEqual(insert[1][2:6], ("proof-map", "Proof map", True, "curated"))

    def test_duplicate_active_slug_fails_without_writing(self):
        cursor = Cursor([None, None, {"id": CANVAS_ID}])
        request = CanvasCreate(
            workspaceId="workspace-main",
            slug="main",
            title="Duplicate",
            idempotencyKey="canvas-create-duplicate",
        )
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            self.assertRaises(HTTPException) as caught,
        ):
            create_canvas(request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("slug", caught.exception.detail)
        self.assertNotIn("INSERT INTO gb_canvases", "\n".join(statement for statement, _ in cursor.statements))

    def test_canvas_list_is_default_first_and_exposes_named_canvas_metadata(self):
        named = {
            **self.canvas,
            "id": "30000000-0000-4000-8000-000000000002",
            "slug": "notes",
            "title": "Notes",
            "is_default": False,
        }
        cursor = Cursor([[self.canvas, named]])
        with patch("server.get_conn", return_value=Connection(cursor)):
            result = list_canvases("workspace-main", 50, self.identity)

        self.assertEqual([entry["slug"] for entry in result], ["main", "notes"])
        self.assertTrue(result[0]["isDefault"])
        self.assertEqual([entry["projectionMode"] for entry in result], ["ambient", "ambient"])
        statement, _ = cursor.statements[0]
        self.assertIn("ORDER BY is_default DESC", statement)

    def test_canvas_projection_modes_fail_closed(self):
        with self.assertRaises(ValueError):
            CanvasCreate(
                workspaceId="workspace-main",
                title="Invalid mode",
                projectionMode="unknown",
                idempotencyKey="canvas-create-invalid-mode",
            )

        cursor = Cursor([[{**self.canvas, "projection_mode": "unknown"}]])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            self.assertRaises(HTTPException) as caught,
        ):
            list_canvases("workspace-main", 50, self.identity)
        self.assertEqual(caught.exception.status_code, 500)

    def test_mutation_advances_one_version_and_records_the_validated_batch(self):
        placed = {
            "id": "paper-1",
            "subjectRef": "gb:object:v1:paper:paper-1:latest",
            "nodeType": "galaxy.paper",
            "x": 10,
            "y": 20,
            "width": 420,
            "height": 270,
            "angle": 0,
            "zIndex": 1,
            "displayMode": "card",
            "collapsed": False,
            "style": {},
        }
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-1",
            commands=[{"type": "item.place", "item": placed}],
        )
        next_content = {
            "schemaId": SNAPSHOT_SCHEMA,
            "items": [placed],
            "edges": [],
            "removedItemIds": [],
            "removedEdgeIds": [],
        }
        next_hash = snapshot_hash(next_content)
        updated = {**self.canvas, "current_version": 2, "current_content_hash": next_hash}
        cursor = Cursor([updated, {"id": REVISION_ID}])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=self.canvas),
            patch("server._canvas_content", return_value=EMPTY),
            patch("server._synchronize_canvas_rows") as synchronize,
            patch("server._authorize_object_reference", side_effect=AssertionError("placement must stay opaque")),
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertEqual(result["version"], 2)
        self.assertEqual(result["contentHash"], next_hash)
        self.assertEqual(result["content"], next_content)
        synchronize.assert_called_once()
        sql = "\n".join(statement for statement, _ in cursor.statements)
        self.assertIn("UPDATE gb_canvases", sql)
        self.assertIn("INSERT INTO gb_canvas_revisions", sql)

    def test_fresh_mutation_receipt_omits_the_committed_snapshot(self):
        self.assertEqual(canonical_hash({
            "expectedVersion": 4,
            "expectedContentHash": f"sha256:{'a' * 64}",
            "commands": [{
                "type": "item.move",
                "itemId": "paper-1",
                "position": {"x": 40, "y": 50},
            }],
        }), "a1f52c3c7f7e99ae3a3c2cb3a08bf3e3520fbbbdd931886575c937a01dc19cdf")
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-receipt",
            commands=[{
                "type": "item.move",
                "itemId": "paper-1",
                "position": {"x": 10, "y": 20},
            }],
        )
        updated = {**self.canvas, "current_version": 2}
        cursor = Cursor([updated, {"id": REVISION_ID}])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=self.canvas),
            patch("server._canvas_content", return_value=EMPTY),
            patch("server.apply_canvas_commands", return_value=EMPTY),
            patch("server._synchronize_canvas_rows"),
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity, "receipt")

        self.assertEqual(result, {
            "schemaId": "gb.canvas.mutation-receipt.v1",
            "canvasId": CANVAS_ID,
            "version": 2,
            "contentHash": EMPTY_HASH,
            "mutationId": REVISION_ID,
            "requestHash": canonical_hash({
                "expectedVersion": 1,
                "expectedContentHash": EMPTY_HASH,
                "commands": [{
                    "type": "item.move",
                    "itemId": "paper-1",
                    "position": {"x": 10, "y": 20},
                }],
            }),
            "replayed": False,
        })
        self.assertNotIn("content", result)

    def test_canvas_lookup_is_bound_to_the_authenticated_tenant_not_its_creator(self):
        other_identity = IdentityContext(
            tenant_id=TENANT_ID,
            principal_id=OTHER_PRINCIPAL_ID,
            principal_kind="agent",
            role="service",
        )
        cursor = Cursor([self.canvas])
        result = _canvas_or_404(CANVAS_ID, other_identity, cur=cursor)

        self.assertEqual(result["id"], CANVAS_ID)
        statement, params = cursor.statements[0]
        self.assertIn("tenant_id = %s", statement)
        self.assertNotIn("created_by_principal_id = %s", statement)
        self.assertEqual(params, (CANVAS_ID, TENANT_ID))

    def test_stale_write_returns_current_version_and_hash(self):
        stale_canvas = {**self.canvas, "current_version": 2, "current_content_hash": f"sha256:{'a' * 64}"}
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-stale",
            commands=[{
                "type": "item.move",
                "itemId": "paper-1",
                "position": {"x": 10, "y": 20},
            }],
        )
        cursor = Cursor([])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=stale_canvas),
            self.assertRaises(HTTPException) as caught,
        ):
            mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["currentVersion"], 2)
        self.assertEqual(caught.exception.detail["currentContentHash"], stale_canvas["current_content_hash"])
        self.assertEqual(cursor.statements[-1][0], "ROLLBACK")

    def test_idempotent_retry_returns_the_original_revision_without_writes(self):
        replay = {
            "id": REVISION_ID,
            "canvas_id": CANVAS_ID,
            "version": 2,
            "content_hash": EMPTY_HASH,
            "snapshot_json": EMPTY,
            "request_hash": "request",
        }
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-retry",
            commands=[{"type": "item.remove", "itemId": "paper-1"}],
        )
        cursor = Cursor([])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=replay),
            patch("server._canvas_or_404", return_value=self.canvas),
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity)

        self.assertTrue(result["replayed"])
        self.assertEqual(result["version"], 2)
        self.assertEqual([statement for statement, _ in cursor.statements], ["BEGIN", "COMMIT"])

    def test_receipt_mode_returns_only_bounded_commit_metadata_for_retries(self):
        replay = {
            "id": REVISION_ID,
            "canvas_id": CANVAS_ID,
            "version": 2,
            "content_hash": EMPTY_HASH,
            "snapshot_json": EMPTY,
            "request_hash": canonical_hash({
                "expectedVersion": 1,
                "expectedContentHash": EMPTY_HASH,
                "commands": [{"type": "item.remove", "itemId": "paper-1"}],
            }),
        }
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-retry",
            commands=[{"type": "item.remove", "itemId": "paper-1"}],
        )
        cursor = Cursor([])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_replay", return_value=replay),
            patch("server._canvas_or_404", return_value=self.canvas),
        ):
            result = mutate_canvas(CANVAS_ID, request, self.identity, "receipt")

        self.assertEqual(result, {
            "schemaId": "gb.canvas.mutation-receipt.v1",
            "canvasId": CANVAS_ID,
            "version": 2,
            "contentHash": EMPTY_HASH,
            "mutationId": REVISION_ID,
            "requestHash": canonical_hash({
                "expectedVersion": 1,
                "expectedContentHash": EMPTY_HASH,
                "commands": [{"type": "item.remove", "itemId": "paper-1"}],
            }),
            "replayed": True,
        })
        self.assertNotIn("content", result)

    def test_stale_and_idempotency_conflicts_have_stable_machine_codes(self):
        stale_canvas = {**self.canvas, "current_version": 2, "current_content_hash": f"sha256:{'a' * 64}"}
        request = CanvasMutation(
            expectedVersion=1,
            expectedContentHash=EMPTY_HASH,
            idempotencyKey="canvas-mutation-conflict",
            commands=[{"type": "item.remove", "itemId": "paper-1"}],
        )
        with (
            patch("server.get_conn", return_value=Connection(Cursor([]))),
            patch("server._canvas_replay", return_value=None),
            patch("server._canvas_or_404", return_value=stale_canvas),
            self.assertRaises(HTTPException) as stale,
        ):
            mutate_canvas(CANVAS_ID, request, self.identity, "receipt")
        self.assertEqual(stale.exception.detail["code"], "stale_canvas")

        replay_cursor = Cursor([{
            "id": REVISION_ID,
            "canvas_id": CANVAS_ID,
            "version": 2,
            "content_hash": EMPTY_HASH,
            "snapshot_json": EMPTY,
            "request_hash": "different-request",
        }])
        with self.assertRaises(HTTPException) as reused:
            _canvas_replay(replay_cursor, CANVAS_ID, "canvas-mutation-conflict", "new-request")
        self.assertEqual(reused.exception.detail["code"], "idempotency_key_reused")

    def test_revision_listing_returns_metadata_without_materializing_snapshots(self):
        revision = {
            "id": REVISION_ID,
            "version": 1,
            "content_hash": EMPTY_HASH,
            "idempotency_key": "canvas-create-1",
            "created_by_principal_id": PRINCIPAL_ID,
            "created_at": "2026-09-23T00:00:00Z",
        }
        cursor = Cursor([[revision]])
        with (
            patch("server.get_conn", return_value=Connection(cursor)),
            patch("server._canvas_or_404", return_value=self.canvas),
        ):
            result = list_canvas_revisions(CANVAS_ID, 50, self.identity)

        self.assertEqual(result, [revision])
        statement, params = cursor.statements[0]
        self.assertNotIn("snapshot_json", statement)
        self.assertNotIn("mutation_json", statement)
        self.assertEqual(params, (CANVAS_ID, 50))

    def test_pinned_paper_and_surface_placements_require_readable_revisions(self):
        for kind, identifier in [
            ("paper", "paper-1"),
            ("surface", "30000000-0000-4000-8000-000000000001"),
        ]:
            with self.subTest(kind=kind):
                reference = parse_canonical_reference(
                    f"gb:object:v1:{kind}:{identifier}:pinned:sha256%3A{'a' * 64}"
                )
                cursor = Cursor([{"content_hash": "a" * 64}])
                access = _authorize_local_referent(cursor, reference, self.identity)

                self.assertTrue(access.readable)
                self.assertEqual(access.reference, reference.wire)
                self.assertEqual(access.resolved_revision, f"sha256:{'a' * 64}")
                self.assertIn("JOIN gb_", cursor.statements[0][0])


if __name__ == "__main__":
    unittest.main()
