import json
import math
import unittest
from pathlib import Path

from canvas_contract import (
    CanvasContractError,
    SNAPSHOT_SCHEMA,
    apply_commands,
    canonical_hash,
    normalize_change_event,
    normalize_snapshot,
    serialize_snapshot,
    snapshot_hash,
)


FIXTURE = json.loads(
    (Path(__file__).parent / "contracts" / "fixtures" / "canvas-snapshot-v1.json")
    .read_text(encoding="utf-8")
)


class CanvasContractTests(unittest.TestCase):
    def test_matches_the_cross_runtime_golden_bytes_and_hash(self):
        self.assertEqual(serialize_snapshot(FIXTURE["input"]).decode("utf-8"), FIXTURE["canonical"])
        self.assertEqual(serialize_snapshot(FIXTURE["reorderedInput"]).decode("utf-8"), FIXTURE["canonical"])
        self.assertEqual(snapshot_hash(FIXTURE["input"]), FIXTURE["contentHash"])
        self.assertEqual(normalize_snapshot(FIXTURE["input"])["items"][0]["x"], 0)
        self.assertEqual(serialize_snapshot(FIXTURE["frameInput"]).decode("utf-8"), FIXTURE["frameCanonical"])
        self.assertEqual(snapshot_hash(FIXTURE["frameInput"]), FIXTURE["frameContentHash"])

    def test_rejects_transient_fields_invalid_numbers_and_lone_surrogates(self):
        with self.assertRaises(CanvasContractError):
            normalize_snapshot({"schemaId": "gb.canvas.snapshot.v1", "items": [], "edges": [], "camera": {}})
        invalid = json.loads(json.dumps(FIXTURE["input"]))
        invalid["items"][0]["x"] = math.inf
        with self.assertRaises(CanvasContractError):
            normalize_snapshot(invalid)
        invalid = json.loads(json.dumps(FIXTURE["input"]))
        invalid["items"][0]["style"]["text"] = "\ud800"
        with self.assertRaises(CanvasContractError):
            normalize_snapshot(invalid)

    def test_change_notifications_are_invalidation_only(self):
        event = normalize_change_event({
            "schemaId": "gb.canvas.changed.v1",
            "canvasId": "10000000-0000-4000-8000-000000000001",
            "version": 13,
            "contentHash": f"sha256:{'a' * 64}",
            "mutationId": "mutation-13",
        })
        self.assertEqual(set(event), {"schemaId", "canvasId", "version", "contentHash", "mutationId"})
        with self.assertRaises(CanvasContractError):
            normalize_change_event({**event, "commands": []})

    def test_frames_are_optional_canonical_and_human_presentation_only(self):
        empty = normalize_snapshot({"schemaId": SNAPSHOT_SCHEMA, "items": [], "edges": [], "frames": []})
        self.assertNotIn("frames", empty)
        framed = apply_commands(empty, [{"type": "frame.create", "frame": {
            "id": "sources", "title": "Sources", "x": 10, "y": 20,
            "width": 720, "height": 480, "tone": "sage",
        }}])
        self.assertEqual(framed["frames"][0]["id"], "sources")
        moved = apply_commands(framed, [
            {"type": "frame.move", "frameId": "sources", "position": {"x": 40, "y": 50}},
            {"type": "frame.resize", "frameId": "sources", "size": {"width": 900, "height": 600}},
        ])
        self.assertEqual((moved["frames"][0]["x"], moved["frames"][0]["width"]), (40, 900))
        removed = apply_commands(moved, [{"type": "frame.remove", "frameId": "sources"}])
        self.assertNotIn("frames", removed)

        with self.assertRaises(CanvasContractError):
            normalize_snapshot({
                "schemaId": SNAPSHOT_SCHEMA, "items": [], "edges": [],
                "frames": [{"id": "bad", "title": "Bad", "x": 0, "y": 0,
                            "width": 100, "height": 200, "tone": "sage"}],
            })

        astral_boundary = "😀" * 60
        astral_frame = {
            "id": "astral", "title": astral_boundary, "x": 0, "y": 0,
            "width": 720, "height": 480, "tone": "plum",
        }
        self.assertEqual(normalize_snapshot({
            "schemaId": SNAPSHOT_SCHEMA, "items": [], "edges": [], "frames": [astral_frame],
        })["frames"][0]["title"], astral_boundary)
        with self.assertRaises(CanvasContractError):
            normalize_snapshot({
                "schemaId": SNAPSHOT_SCHEMA, "items": [], "edges": [],
                "frames": [{**astral_frame, "title": "😀" * 61}],
            })

        for malformed_tone in ({"name": "sage"}, ["sage"], None):
            with self.subTest(tone=malformed_tone), self.assertRaises(CanvasContractError):
                normalize_snapshot({
                    "schemaId": SNAPSHOT_SCHEMA, "items": [], "edges": [],
                    "frames": [{**astral_frame, "tone": malformed_tone}],
                })

    def test_bounded_commands_round_trip_without_renderer_operations(self):
        empty = {
            "schemaId": "gb.canvas.snapshot.v1",
            "items": [],
            "edges": [],
            "removedItemIds": [],
            "removedEdgeIds": [],
        }
        note = normalize_snapshot(FIXTURE["input"])["items"][0]
        paper = normalize_snapshot(FIXTURE["input"])["items"][1]
        first = apply_commands(empty, [
            {"type": "item.place", "item": note},
            {"type": "item.place", "item": paper},
            {"type": "edge.connect", "edge": {
                "id": "edge-1",
                "sourceItemId": note["id"],
                "targetItemId": paper["id"],
                "edgeKind": "presentation",
                "label": "supports",
                "style": {},
            }},
        ])
        moved = apply_commands(first, [
            {"type": "item.move", "itemId": note["id"], "position": {"x": 12.5, "y": -4}},
            {"type": "item.resize", "itemId": note["id"], "size": {"width": 500, "height": 300}},
            {"type": "item.reorder", "itemId": note["id"], "zIndex": 8},
        ])
        self.assertEqual(moved["items"][0]["x"], 12.5)
        self.assertEqual(moved["items"][0]["width"], 500)
        self.assertEqual(moved["items"][0]["zIndex"], 8)
        disconnected = apply_commands(moved, [{"type": "edge.disconnect", "edgeId": "edge-1"}])
        self.assertEqual(disconnected["edges"], [])
        self.assertEqual(disconnected["removedEdgeIds"], ["edge-1"])
        reconnected = apply_commands(disconnected, [{"type": "edge.connect", "edge": {
            "id": "edge-2",
            "sourceItemId": note["id"],
            "targetItemId": paper["id"],
            "edgeKind": "presentation",
            "style": {},
        }}])
        removed = apply_commands(reconnected, [{"type": "item.remove", "itemId": note["id"]}])
        self.assertEqual(len(removed["items"]), 1)
        self.assertEqual(removed["edges"], [])
        self.assertEqual(removed["removedItemIds"], [note["id"]])
        self.assertEqual(removed["removedEdgeIds"], ["edge-1", "edge-2"])
        self.assertEqual(len(canonical_hash({"commands": []})), 64)

    def test_overlay_removals_create_tombstones_without_materialized_items(self):
        empty = {
            "schemaId": "gb.canvas.snapshot.v1",
            "items": [],
            "edges": [],
            "removedItemIds": [],
            "removedEdgeIds": [],
        }
        removed = apply_commands(empty, [
            {"type": "item.remove", "itemId": "projected-note"},
            {"type": "edge.disconnect", "edgeId": "projected-edge"},
        ])
        self.assertEqual(removed["removedItemIds"], ["projected-note"])
        self.assertEqual(removed["removedEdgeIds"], ["projected-edge"])

    def test_accepts_exact_pinned_chat_items_with_conversation_geometry(self):
        chat_ref = (
            "gb:object:v1:chat:research-thread:pinned:sha256%3A"
            + ("c" * 64)
        )
        snapshot = {
            "schemaId": "gb.canvas.snapshot.v1",
            "items": [{
                "id": "conversation",
                "subjectRef": chat_ref,
                "nodeType": "galaxy.chat",
                "x": 80,
                "y": 80,
                "width": 420,
                "height": 260,
                "angle": 0,
                "zIndex": 0,
                "displayMode": "card",
                "collapsed": False,
                "style": {},
            }],
            "edges": [],
            "removedItemIds": [],
            "removedEdgeIds": [],
        }

        normalized = normalize_snapshot(snapshot)
        self.assertEqual(normalized["items"][0]["subjectRef"], chat_ref)
        self.assertEqual(normalized["items"][0]["nodeType"], "galaxy.chat")
        self.assertEqual(normalized["items"][0]["width"], 420)
        self.assertEqual(normalized["items"][0]["height"], 260)

    def test_rejects_raw_ops_duplicate_placements_and_unbound_edges(self):
        empty = {"schemaId": "gb.canvas.snapshot.v1", "items": [], "edges": []}
        with self.assertRaises(CanvasContractError):
            normalize_snapshot({**empty, "removedItemIds": None})
        note = normalize_snapshot(FIXTURE["input"])["items"][0]
        with self.assertRaises(CanvasContractError):
            apply_commands(empty, [{"type": "node.update", "op": {}}])
        with self.assertRaises(CanvasContractError):
            apply_commands(
                {"schemaId": "gb.canvas.snapshot.v1", "items": [note], "edges": []},
                [{"type": "item.place", "item": note}],
            )
        with self.assertRaises(CanvasContractError):
            apply_commands(empty, [{"type": "edge.connect", "edge": {
                "id": "edge-1",
                "sourceItemId": "missing-a",
                "targetItemId": "missing-b",
                "edgeKind": "presentation",
                "style": {},
            }}])


if __name__ == "__main__":
    unittest.main()
