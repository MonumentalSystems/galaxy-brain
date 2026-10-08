import unittest
import json

from share_bundle import (
    ShareBundleError,
    build_canvas_bundle,
    build_canvas_conversation_bundle,
    build_node_bundle,
    build_object_bundle,
    validate_create_request,
)


HASH = "a" * 64
OTHER_HASH = "b" * 64
PINNED_PAPER = f"gb:object:v1:paper:paper-1:pinned:sha256%3A{HASH}"
CONVERSATION_ID = "40000000-0000-4000-8000-000000000001"
TURN_ID = "50000000-0000-4000-8000-000000000001"
SYSTEM_TURN_ID = "50000000-0000-4000-8000-000000000002"
TOOL_TURN_ID = "50000000-0000-4000-8000-000000000003"
PINNED_CHAT = f"gb:object:v1:chat:{CONVERSATION_ID}:pinned:sha256%3A{HASH}"
PINNED_TURN = f"gb:object:v1:turn:{TURN_ID}:pinned:sha256%3A{OTHER_HASH}"


class ShareBundleContractTests(unittest.TestCase):
    def test_create_contract_rejects_unknown_fields_modes_and_unpinned_objects(self):
        valid = {
            "schemaId": "gb.share-bundle.v1",
            "mode": "object-only",
            "selector": {"objectRef": PINNED_PAPER},
            "idempotencyKey": "share:test-0001",
        }
        self.assertEqual(validate_create_request(valid)[0], "object-only")
        for invalid in (
            {**valid, "conversationId": "forbidden"},
            {**valid, "mode": "conversation-only"},
            {**valid, "selector": {"objectRef": "gb:object:v1:paper:paper-1:latest"}},
            {**valid, "selector": {"objectRef": PINNED_PAPER, "snapshot": {}}},
        ):
            with self.assertRaises(ShareBundleError):
                validate_create_request(invalid)
        for kind in ("chat", "run", "turn"):
            with self.assertRaises(ShareBundleError):
                validate_create_request({
                    **valid,
                    "selector": {"objectRef": f"gb:object:v1:{kind}:private:pinned:sha256%3A{HASH}"},
                })

    def test_combined_create_contract_accepts_only_exact_selector_fields(self):
        valid = {
            "schemaId": "gb.share-bundle.v2",
            "mode": "canvas-plus-conversation",
            "selector": {
                "canvasId": "30000000-0000-4000-8000-000000000001",
                "version": 4,
                "contentHash": f"sha256:{OTHER_HASH}",
                "conversationRef": PINNED_CHAT,
            },
            "idempotencyKey": "share:combined-0001",
        }
        self.assertEqual(validate_create_request(valid)[0], "canvas-plus-conversation")
        with self.assertRaises(ShareBundleError):
            validate_create_request({**valid, "schemaId": "gb.share-bundle.v1"})
        with self.assertRaises(ShareBundleError):
            validate_create_request({
                "schemaId": "gb.share-bundle.v2",
                "mode": "object-only",
                "selector": {"objectRef": PINNED_PAPER},
                "idempotencyKey": "share:wrong-schema-0001",
            })
        for selector in (
            {**valid["selector"], "turns": []},
            {**valid["selector"], "conversationRef": "gb:object:v1:chat:private:latest"},
            {**valid["selector"], "conversationRef": PINNED_TURN},
        ):
            with self.assertRaises(ShareBundleError):
                validate_create_request({**valid, "selector": selector})

    def test_node_bundle_pins_server_revision_and_excludes_arbitrary_metadata(self):
        bundle = build_node_bundle("node-1", "revision-7", {
            "type": "note",
            "title": "Pinned note",
            "content": "Exact content\nwith two lines.",
            "tags": ["evidence"],
            "version": 7,
            "metadata": {"secret": "must not cross the share boundary"},
        })
        self.assertEqual(bundle["target_type"], "object-only")
        self.assertEqual(bundle["snapshot_json"]["schemaId"], "gb.share-bundle.v1")
        self.assertEqual(bundle["snapshot_json"]["payload"]["schemaId"], "gb.share-object.v1")
        self.assertNotIn("metadata", bundle["snapshot_json"]["payload"])
        self.assertNotIn("secret", str(bundle))
        self.assertRegex(bundle["content_hash"], r"^sha256:[0-9a-f]{64}$")

    def test_canonical_object_bundle_requires_same_exact_pinned_identity(self):
        resolution = {
            "requestedRef": PINNED_PAPER,
            "status": "resolved",
            "resolvedRef": PINNED_PAPER,
            "provider": "galaxy.paper",
            "sourceKind": "paper",
            "source": {"paper": {"id": "paper-1", "title": "Pinned paper"}},
        }
        bundle = build_object_bundle(PINNED_PAPER, resolution)
        self.assertEqual(bundle["snapshot_json"]["payload"]["ref"], PINNED_PAPER)
        with self.assertRaises(ShareBundleError):
            build_object_bundle(PINNED_PAPER, {
                **resolution,
                "resolvedRef": f"gb:object:v1:paper:paper-1:pinned:sha256%3A{OTHER_HASH}",
            })

    def test_raster_object_share_contains_manifest_metadata_but_never_image_bytes(self):
        ref = f"gb:object:v1:document:document-1:pinned:sha256%3A{HASH}"
        manifest = {
            "schemaId": "gb.raster-image.v1",
            "format": "png",
            "mediaType": "image/png",
            "width": 640,
            "height": 480,
            "channels": 4,
            "frameCount": 1,
            "byteSize": 4096,
            "contentSha256": OTHER_HASH,
        }
        resolution = {
            "requestedRef": ref,
            "status": "resolved",
            "resolvedRef": ref,
            "provider": "galaxy.document",
            "sourceKind": "document",
            "source": {
                "documentId": "document-1",
                "revisionId": "10000000-0000-4000-8000-000000000001",
                "revisionSha256": HASH,
                "title": "Figure",
                "mediaType": "image/png",
                "rasterImage": manifest,
                "representations": [{
                    "id": "20000000-0000-4000-8000-000000000002",
                    "kind": "original",
                    "mediaType": "image/png",
                    "contentSha256": OTHER_HASH,
                }],
            },
        }
        bundle = build_object_bundle(ref, resolution)
        payload = bundle["snapshot_json"]["payload"]
        self.assertEqual(payload["source"]["rasterImage"], manifest)
        serialized = json.dumps(payload, separators=(",", ":"))
        self.assertNotIn("content_bytes", serialized)
        self.assertNotIn("blob:", serialized)
        self.assertNotIn("data:image", serialized)

    def test_canvas_bundle_rejects_latest_refs_and_freezes_exact_revision(self):
        canvas = {"id": "30000000-0000-4000-8000-000000000001", "title": "Atlas"}
        snapshot = {
            "schemaId": "gb.canvas.snapshot.v1",
            "items": [{"subjectRef": PINNED_PAPER}],
            "edges": [],
            "frames": [{
                "id": "sources", "title": "Sources", "x": -40, "y": 20,
                "width": 720, "height": 480, "tone": "sage",
            }],
            "removedItemIds": [],
            "removedEdgeIds": [],
        }
        revision = {"version": 4, "content_hash": f"sha256:{OTHER_HASH}", "snapshot_json": snapshot}
        bundle = build_canvas_bundle(canvas, revision)
        self.assertEqual(bundle["snapshot_json"]["payload"]["version"], 4)
        self.assertEqual(bundle["snapshot_json"]["payload"]["contentHash"], f"sha256:{OTHER_HASH}")
        self.assertEqual(bundle["snapshot_json"]["payload"]["snapshot"]["frames"], snapshot["frames"])
        with self.assertRaises(ShareBundleError):
            build_canvas_bundle(canvas, {
                **revision,
                "snapshot_json": {
                    **snapshot,
                    "items": [{"subjectRef": "gb:object:v1:paper:paper-1:latest"}],
                },
            })
        with self.assertRaises(ShareBundleError):
            build_canvas_bundle(canvas, {
                **revision,
                "snapshot_json": {**snapshot, "items": [{"subjectRef": PINNED_CHAT}]},
            })

    def test_combined_bundle_freezes_one_exact_chat_and_redacts_private_metadata(self):
        canvas = {
            "id": "30000000-0000-4000-8000-000000000001",
            "title": "Conversation atlas",
        }
        revision = {
            "version": 4,
            "content_hash": f"sha256:{OTHER_HASH}",
            "snapshot_json": {
                "schemaId": "gb.canvas.snapshot.v1",
                "items": [{"subjectRef": PINNED_CHAT}],
                "edges": [],
                "removedItemIds": [],
                "removedEdgeIds": [],
            },
        }
        conversation = {
            "conversationId": CONVERSATION_ID,
            "workspaceId": "workspace-1",
            "ref": PINNED_CHAT,
            "title": "Exact research branch",
            "goal": "Compare two derivations.",
            "version": 2,
            "contentHash": f"sha256:{HASH}",
            "artifactRefs": [PINNED_PAPER],
            "provenance": {"model": "private-model"},
            "tenantId": "private-tenant",
            "turns": [{
                "turnId": TURN_ID,
                "ordinal": 1,
                "role": "assistant",
                "content": "The exact result is $x^2$.",
                "ref": PINNED_TURN,
                "contentHash": f"sha256:{OTHER_HASH}",
                "artifactRefs": [PINNED_PAPER],
                "provenance": {"model": "private-model"},
                "createdAt": "private-time",
            }, {
                "turnId": SYSTEM_TURN_ID,
                "ordinal": 2,
                "role": "system",
                "content": None,
                "ref": f"gb:object:v1:turn:{SYSTEM_TURN_ID}:pinned:sha256%3A{'c' * 64}",
                "contentHash": f"sha256:{'c' * 64}",
            }, {
                "turnId": TOOL_TURN_ID,
                "ordinal": 3,
                "role": "tool",
                "content": None,
                "ref": f"gb:object:v1:turn:{TOOL_TURN_ID}:pinned:sha256%3A{'d' * 64}",
                "contentHash": f"sha256:{'d' * 64}",
            }],
            "edges": [],
        }
        bundle = build_canvas_conversation_bundle(canvas, revision, conversation)
        payload = bundle["snapshot_json"]["payload"]
        self.assertEqual(bundle["target_type"], "canvas-plus-conversation")
        self.assertEqual(bundle["snapshot_json"]["schemaId"], "gb.share-bundle.v2")
        self.assertEqual(payload["schemaId"], "gb.share-canvas-redacted-conversation.v1")
        self.assertEqual(payload["conversation"]["schemaId"], "gb.share-redacted-conversation.v1")
        turns = payload["conversation"]["turns"]
        self.assertEqual(turns[0]["publication"]["content"], "The exact result is $x^2$.")
        self.assertRegex(turns[0]["publication"]["contentSha256"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(turns[0]["sourceContentHash"], f"sha256:{OTHER_HASH}")
        self.assertEqual(turns[1]["publication"], {"status": "redacted", "reason": "role-excluded"})
        self.assertEqual(turns[2]["publication"], {"status": "redacted", "reason": "role-excluded"})
        serialized = json.dumps(payload, separators=(",", ":"))
        for excluded in ("artifactRefs", "provenance", "tenantId", "workspaceId", "private-model", "private-time"):
            self.assertNotIn(excluded, serialized)

        alphabetic_id = "4abcdef0-0000-4000-8000-000000000001"
        uppercase_chat = f"gb:object:v1:chat:{alphabetic_id.upper()}:pinned:sha256%3A{HASH}"
        lowercase_chat = f"gb:object:v1:chat:{alphabetic_id}:pinned:sha256%3A{HASH}"
        case_insensitive_bundle = build_canvas_conversation_bundle(
            canvas,
            {
                **revision,
                "snapshot_json": {
                    **revision["snapshot_json"],
                    "items": [{"subjectRef": lowercase_chat}],
                },
            },
            {
                **conversation,
                "conversationId": alphabetic_id,
                "ref": uppercase_chat,
            },
        )
        self.assertEqual(
            case_insensitive_bundle["snapshot_json"]["source"]["conversationRef"],
            uppercase_chat,
        )

        with self.assertRaises(ShareBundleError):
            build_canvas_conversation_bundle(canvas, revision, {
                **conversation,
                "turns": [
                    conversation["turns"][0],
                    {**conversation["turns"][1], "content": "private-system-secret"},
                    conversation["turns"][2],
                ],
            })

        for invalid_ref in (PINNED_TURN, f"gb:object:v1:chat:other:pinned:sha256%3A{HASH}"):
            with self.assertRaises(ShareBundleError):
                build_canvas_conversation_bundle(canvas, {
                    **revision,
                    "snapshot_json": {
                        **revision["snapshot_json"],
                        "items": [
                            {"subjectRef": PINNED_CHAT},
                            {"subjectRef": invalid_ref},
                        ],
                    },
                }, conversation)


if __name__ == "__main__":
    unittest.main()
