import unittest

from document_chunks import (
    CHUNK_MANIFEST_SCHEMA_ID,
    CHUNK_SCHEMA_ID,
    DocumentChunkContractError,
    canonical_chunk_json,
    current_document_chunker,
    materialize_document_chunks,
)


ID = "123e4567-e89b-42d3-a456-426614174000"
HASH = "a" * 64
STRUCTURE = {
    "schemaId": "gb.document-structure.v1",
    "pages": [{"number": 1}],
    "blocks": [
        {"id": "heading", "kind": "section_header", "text": "Résumé 😀", "latex": None, "page": 1, "region": None},
        {"id": "equation", "kind": "formula", "text": None, "latex": "E=mc^2", "page": 1, "region": None},
        {"id": "table", "kind": "table", "text": "A | B", "latex": None, "page": 1, "region": None},
    ],
    "readingOrder": ["equation", "heading", "table"],
}


class DocumentChunkContractTests(unittest.TestCase):
    def test_structure_chunks_follow_declared_order_and_match_golden_identities(self):
        manifest = materialize_document_chunks(ID, HASH, "document-structure", STRUCTURE)
        self.assertEqual(manifest["schemaId"], CHUNK_MANIFEST_SCHEMA_ID)
        self.assertFalse(manifest["canonicalObject"])
        self.assertNotIn("ref", manifest)
        self.assertEqual([
            (chunk["ordinal"], chunk["selector"], chunk["textContent"])
            for chunk in manifest["chunks"]
        ], [
            (0, {"kind": "json-pointer", "pointer": "/blocks/1"}, "E=mc^2"),
            (1, {"kind": "json-pointer", "pointer": "/blocks/0"}, "Résumé 😀"),
            (2, {"kind": "json-pointer", "pointer": "/blocks/2"}, "A | B"),
        ])
        self.assertEqual([chunk["chunkSha256"] for chunk in manifest["chunks"]], [
            "5a5a0334fbd0078324baea35c4367dd27de300ad8b52a24d1f965d1694e26b76",
            "a3d8bf7d3e61dad5a9f4c2a48b32353639963533f3abd249198ce8b22264bf11",
            "112b3fcaa43480da6d35f5452d6c6c54ce5a45fd9f9c3b1778b9144a2d1d5046",
        ])
        self.assertTrue(all(
            chunk["schemaId"] == CHUNK_SCHEMA_ID
            and chunk["id"] == f"sha256:{chunk['chunkSha256']}"
            for chunk in manifest["chunks"]
        ))

    def test_unicode_windows_count_code_points_and_match_golden_identities(self):
        manifest = materialize_document_chunks(
            ID, "b" * 64, "markdown", "A😀BC𝄞DEF",
            window_code_points=4, overlap_code_points=1,
        )
        self.assertEqual([
            (chunk["selector"], chunk["textContent"]) for chunk in manifest["chunks"]
        ], [
            ({"kind": "text-position", "unit": "unicode-code-point", "start": 0, "end": 4, "overlap": 0}, "A😀BC"),
            ({"kind": "text-position", "unit": "unicode-code-point", "start": 3, "end": 7, "overlap": 1}, "C𝄞DE"),
            ({"kind": "text-position", "unit": "unicode-code-point", "start": 6, "end": 8, "overlap": 1}, "EF"),
        ])
        self.assertEqual([chunk["chunkSha256"] for chunk in manifest["chunks"]], [
            "f3d68efe714fe63d218869b000f25ef9312021183a132f8a274a7cf4da6cce43",
            "77518ab7ecd09776e2e861426d03539572aa4884405b4f5d17f7f28dd551dea5",
            "c2552dfb45f37e0878dcfef82e6fdce2fe1253cc31ea9f0279de450e332e94b0",
        ])

    def test_empty_structure_blocks_are_skipped_with_dense_chunk_ordinals(self):
        manifest = materialize_document_chunks(ID, HASH, "document-structure", {
            "schemaId": "gb.document-structure.v1",
            "blocks": [
                {"id": "first", "text": "First", "latex": None},
                {"id": "empty", "text": "", "latex": None},
                {"id": "last", "text": "Last", "latex": None},
            ],
            "readingOrder": ["first", "empty", "last"],
        })
        self.assertEqual([{
            "ordinal": chunk["ordinal"],
            "selector": chunk["selector"],
            "textContent": chunk["textContent"],
            "chunkSha256": chunk["chunkSha256"],
        } for chunk in manifest["chunks"]], [
            {
                "ordinal": 0,
                "selector": {"kind": "json-pointer", "pointer": "/blocks/0"},
                "textContent": "First",
                "chunkSha256": "a3d8bf7d3e61dad5a9f4c2a48b32353639963533f3abd249198ce8b22264bf11",
            },
            {
                "ordinal": 1,
                "selector": {"kind": "json-pointer", "pointer": "/blocks/2"},
                "textContent": "Last",
                "chunkSha256": "112b3fcaa43480da6d35f5452d6c6c54ce5a45fd9f9c3b1778b9144a2d1d5046",
            },
        ])

    def test_descriptors_are_content_free_and_identity_uses_digest_selector_and_config(self):
        self.assertEqual(current_document_chunker("document-structure"), {
            "id": "galaxy.document-structure-blocks",
            "version": "1",
            "config": {"strategy": "declared-reading-order-json-pointer"},
            "configSha256": "82c5aabe05e41ab2627a14003ae41f01ec34b10f5facca787dd711414201bb1b",
        })
        self.assertEqual(
            current_document_chunker(
                "text", window_code_points=4, overlap_code_points=1,
            )["configSha256"],
            "3f9ccbb6993cadc1788f969c8b54ce98739d2a0f03d164ffb074716d71fddfd4",
        )
        baseline = materialize_document_chunks(
            ID, HASH, "text", "abcdef", window_code_points=4, overlap_code_points=1,
        )
        another_row = materialize_document_chunks(
            "223e4567-e89b-42d3-a456-426614174000", HASH, "text", "abcdef",
            window_code_points=4, overlap_code_points=1,
        )
        new_digest = materialize_document_chunks(
            ID, "c" * 64, "text", "abcdef", window_code_points=4, overlap_code_points=1,
        )
        new_config = materialize_document_chunks(
            ID, HASH, "text", "abcdef", window_code_points=5, overlap_code_points=1,
        )
        self.assertEqual(
            [chunk["id"] for chunk in another_row["chunks"]],
            [chunk["id"] for chunk in baseline["chunks"]],
        )
        self.assertNotEqual(new_digest["chunks"][0]["id"], baseline["chunks"][0]["id"])
        self.assertNotEqual(new_config["chunks"][0]["id"], baseline["chunks"][0]["id"])
        self.assertEqual(
            canonical_chunk_json({"z": 1, "a": {"y": 2, "x": 1}}),
            '{"a":{"x":1,"y":2},"z":1}',
        )

    def test_invalid_structure_unicode_and_bounds_fail_closed(self):
        for reading_order in (
            ["heading", "equation"],
            ["heading", "heading", "table"],
            ["heading", "equation", "missing"],
        ):
            with self.subTest(reading_order=reading_order), self.assertRaisesRegex(
                DocumentChunkContractError, "readingOrder"
            ):
                materialize_document_chunks(
                    ID, HASH, "document-structure",
                    {**STRUCTURE, "readingOrder": reading_order},
                )
        with self.assertRaisesRegex(DocumentChunkContractError, "1048576"):
            materialize_document_chunks(ID, HASH, "document-structure", {
                **STRUCTURE,
                "blocks": [{**STRUCTURE["blocks"][0], "text": "😀" * 262_145}],
                "readingOrder": ["heading"],
            })
        with self.assertRaisesRegex(DocumentChunkContractError, "chunk limit"):
            materialize_document_chunks(
                ID, HASH, "text", "x" * 100_001,
                window_code_points=1, overlap_code_points=0,
            )
        with self.assertRaisesRegex(DocumentChunkContractError, "valid Unicode"):
            materialize_document_chunks(ID, HASH, "text", "\ud800")
        with self.assertRaises(DocumentChunkContractError):
            materialize_document_chunks(ID, HASH, "original", "x")
        with self.assertRaisesRegex(DocumentChunkContractError, "smaller"):
            current_document_chunker(
                "text", window_code_points=4, overlap_code_points=4,
            )

    def test_empty_text_has_descriptor_but_no_invented_chunk(self):
        manifest = materialize_document_chunks(ID, HASH, "text", "")
        self.assertEqual(manifest["chunkCount"], 0)
        self.assertEqual(manifest["chunks"], [])
        self.assertFalse(manifest["canonicalObject"])


if __name__ == "__main__":
    unittest.main()
