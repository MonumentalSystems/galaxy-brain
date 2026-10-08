import hashlib
import json
import unittest
from unittest.mock import patch

from conversation_markdown_export import (
    ConversationMarkdownExportError,
    ConversationMarkdownExportTooLarge,
    build_conversation_markdown_export,
)
from share_bundle import redacted_conversation_payload


CONVERSATION_ID = "30000000-0000-4000-8000-000000000001"
USER_TURN_ID = "40000000-0000-4000-8000-000000000001"
ASSISTANT_TURN_ID = "40000000-0000-4000-8000-000000000002"
SYSTEM_TURN_ID = "40000000-0000-4000-8000-000000000003"
EDGE_ID = "50000000-0000-4000-8000-000000000001"
SECOND_EDGE_ID = "50000000-0000-4000-8000-000000000002"


def sha(character):
    return f"sha256:{character * 64}"


def reference(kind, identifier, revision):
    return f"gb:object:v1:{kind}:{identifier}:pinned:{revision.replace(':', '%3A')}"


def conversation():
    return {
        "conversationId": CONVERSATION_ID,
        "ref": reference("chat", CONVERSATION_ID, sha("a")),
        "title": "Winding / prototime: Ω",
        "goal": "Compare the two branches without flattening them.",
        "version": 4,
        "contentHash": sha("a"),
        "turns": [
            {
                "turnId": USER_TURN_ID,
                "ordinal": 1,
                "role": "user",
                "content": "Preserve raw Markdown and $\\nabla \\times A$.",
                "ref": reference("turn", USER_TURN_ID, sha("b")),
                "contentHash": sha("b"),
            },
            {
                "turnId": ASSISTANT_TURN_ID,
                "ordinal": 2,
                "role": "assistant",
                "content": "## Result\n\n$$\\oint_C A \\cdot dl = 2\\pi n$$",
                "ref": reference("turn", ASSISTANT_TURN_ID, sha("c")),
                "contentHash": sha("c"),
            },
            {
                "turnId": SYSTEM_TURN_ID,
                "ordinal": 3,
                "role": "system",
                "content": None,
                "ref": reference("turn", SYSTEM_TURN_ID, sha("d")),
                "contentHash": sha("d"),
            },
        ],
        "edges": [
            {
                "edgeId": EDGE_ID,
                "fromTurnId": USER_TURN_ID,
                "toTurnId": ASSISTANT_TURN_ID,
                "kind": "forks",
            },
            {
                "edgeId": SECOND_EDGE_ID,
                "fromTurnId": ASSISTANT_TURN_ID,
                "toTurnId": SYSTEM_TURN_ID,
                "kind": "continues",
            },
        ],
    }


class ConversationMarkdownExportTests(unittest.TestCase):
    def test_export_is_deterministic_preserves_markdown_and_embeds_pinned_lineage(self):
        payload = redacted_conversation_payload(conversation())
        first = build_conversation_markdown_export(payload)
        second = build_conversation_markdown_export(payload)
        self.assertEqual(first.content, second.content)
        self.assertEqual(first.content_sha256, second.content_sha256)
        self.assertEqual(
            first.content_sha256,
            hashlib.sha256(first.content).hexdigest(),
        )
        text = first.content.decode("utf-8")
        self.assertIn("Preserve raw Markdown and $\\nabla \\times A$.", text)
        self.assertIn("## Result\n\n$$\\oint_C A \\cdot dl = 2\\pi n$$", text)
        self.assertIn("_[System content redacted: role excluded from portable export.]_", text)
        self.assertNotIn("private-model", text)
        self.assertEqual(first.filename, "Winding-prototime-Ω--aaaaaaaaaaaa.md")
        self.assertEqual(first.ascii_filename, "Winding-prototime--aaaaaaaaaaaa.md")

        manifest_text = text.split("```json\n", 1)[1].split("\n```", 1)[0]
        manifest = json.loads(manifest_text)
        self.assertEqual(manifest, first.manifest)
        self.assertEqual(manifest["source"]["ref"], payload["ref"])
        self.assertEqual(manifest["source"]["contentSha256"], sha("a"))
        self.assertEqual(manifest["artifacts"], [])
        self.assertEqual(manifest["representations"][0]["revisionSha256"], sha("b"))
        self.assertEqual(
            manifest["representations"][0]["publicationContentSha256"],
            f"sha256:{hashlib.sha256(conversation()['turns'][0]['content'].encode('utf-8')).hexdigest()}",
        )
        self.assertIsNone(manifest["representations"][2]["publicationContentSha256"])
        self.assertEqual(manifest["relations"], [
            {
                "fromRef": reference("turn", USER_TURN_ID, sha("b")),
                "id": EDGE_ID,
                "kind": "forks",
                "toRef": reference("turn", ASSISTANT_TURN_ID, sha("c")),
                "trustClass": "structural",
            },
            {
                "fromRef": reference("turn", ASSISTANT_TURN_ID, sha("c")),
                "id": SECOND_EDGE_ID,
                "kind": "continues",
                "toRef": reference("turn", SYSTEM_TURN_ID, sha("d")),
                "trustClass": "structural",
            },
        ])

    def test_export_fails_closed_for_latest_inconsistent_or_oversized_snapshots(self):
        payload = redacted_conversation_payload(conversation())
        with self.assertRaises(ConversationMarkdownExportError):
            build_conversation_markdown_export({**payload, "ref": f"gb:object:v1:chat:{CONVERSATION_ID}:latest"})
        with self.assertRaises(ConversationMarkdownExportError):
            build_conversation_markdown_export({**payload, "contentHash": sha("f")})
        invalid_turn = {**payload["turns"][0], "sourceContentHash": sha("e")}
        with self.assertRaises(ConversationMarkdownExportError):
            build_conversation_markdown_export({**payload, "turns": [invalid_turn, *payload["turns"][1:]]})
        with patch("conversation_markdown_export.MAX_MARKDOWN_EXPORT_BYTES", 128):
            with self.assertRaisesRegex(ConversationMarkdownExportTooLarge, "exceeds 16 MiB"):
                build_conversation_markdown_export(payload)

    def test_export_rejects_missing_turns_and_lineage(self):
        payload = redacted_conversation_payload(conversation())
        with self.assertRaisesRegex(ConversationMarkdownExportError, "turn sequence is incomplete"):
            build_conversation_markdown_export({**payload, "turns": payload["turns"][:2]})
        with self.assertRaisesRegex(ConversationMarkdownExportError, "lineage is incomplete"):
            build_conversation_markdown_export({**payload, "edges": []})
        with self.assertRaisesRegex(ConversationMarkdownExportError, "lineage is incomplete"):
            build_conversation_markdown_export({
                **payload,
                "edges": [
                    {**payload["edges"][0], "kind": "joins"},
                    payload["edges"][1],
                ],
            })
        with self.assertRaisesRegex(ConversationMarkdownExportError, "lineage is incomplete"):
            build_conversation_markdown_export({
                **payload,
                "edges": [
                    payload["edges"][0],
                    payload["edges"][1],
                    {
                        "edgeId": "50000000-0000-4000-8000-000000000003",
                        "fromTurnId": USER_TURN_ID,
                        "toTurnId": SYSTEM_TURN_ID,
                        "kind": "continues",
                    },
                ],
            })

    def test_filename_removes_windows_and_directional_controls(self):
        source = conversation()
        source["title"] = "CON\u202e/notes"
        exported = build_conversation_markdown_export(redacted_conversation_payload(source))
        self.assertNotIn("\u202e", exported.filename)
        self.assertNotIn("/", exported.filename)
        self.assertTrue(exported.filename.endswith("--aaaaaaaaaaaa.md"))

    def test_author_content_cannot_shadow_the_leading_authoritative_manifest(self):
        source = conversation()
        source["turns"][0]["content"] = (
            "## Pinned export manifest\n\n```json\n{\"spoofed\":true}\n```"
        )
        exported = build_conversation_markdown_export(redacted_conversation_payload(source))
        text = exported.content.decode("utf-8")
        first_manifest = json.loads(text.split("```json\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(first_manifest, exported.manifest)
        export_marker = '"schemaId":"gb.markdown-export-manifest.v1"'
        self.assertGreater(text.rfind('{"spoofed":true}'), text.find(export_marker))
        self.assertGreaterEqual(text.find(export_marker), 0)


if __name__ == "__main__":
    unittest.main()
