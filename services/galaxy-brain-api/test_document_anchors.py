import unittest

from document_anchors import (
    DocumentAnchorContractError,
    canonical_anchor_json,
    create_document_anchor,
    document_anchor_request_hash,
    is_document_anchor_text_media_type,
    normalize_document_anchor_selector,
)


ID = "123e4567-e89b-42d3-a456-426614174000"
HASH = "a" * 64
STRUCTURE = {
    "schemaId": "gb.document-structure.v1",
    "pages": [{"number": 0}, {"number": 1}],
    "blocks": [
        {"id": "heading", "text": "A theorem", "page": 0},
        {"id": "equation", "latex": "x^2", "page": 1},
    ],
    "readingOrder": ["heading", "equation"],
}
PDF = {
    "id": ID, "kind": "original", "media_type": "application/pdf",
    "content_sha256": HASH, "page_count": 2,
}
TEXT = {
    "id": ID, "kind": "text", "media_type": "text/plain", "content_sha256": HASH,
    "content": "first context theorem suffix; second context theorem ending",
}
STRUCTURED = {
    "id": ID, "kind": "document-structure",
    "media_type": "application/vnd.galaxy.document-structure+json",
    "content_sha256": HASH, "content": STRUCTURE,
}


class DocumentAnchorContractTests(unittest.TestCase):
    def test_cross_runtime_page_region_identity_fixture(self):
        selector = {
            "polygon": [0, 0, 1, 0, 1, 0.5, 0, 0.5],
            "coordinateSpace": "normalized-page", "page": 2,
            "quoteHash": "b" * 64, "kind": "page-region",
        }
        anchor = create_document_anchor(STRUCTURED, selector)
        self.assertEqual(anchor["id"], f"sha256:{anchor['anchorSha256']}")
        self.assertEqual(anchor["selectorSha256"], "602bcc56c77ff0313118206810801e4eb070758cc1a49e8b04ddb5d6080be7c6")
        self.assertEqual(anchor["anchorSha256"], "dfe2319bbefb0999a0a3a25bc94447dc8a907216561c535dad73bb1e10c259ad")
        self.assertEqual(
            document_anchor_request_hash(STRUCTURED, selector),
            "9e9ddb7bc39a13137b896f28d267deeaca655da4e4538ac9e5051edfe3e4bfc6",
        )

    def test_page_region_constraints(self):
        base = {
            "kind": "page-region", "page": 1, "coordinateSpace": "normalized-page",
            "polygon": [0, 0, 1, 0, 1, 1, 0, 1],
        }
        for invalid in (
            {**base, "page": 0},
            {**base, "page": 3},
            {**base, "polygon": [0, 0, 1, 1]},
            {**base, "polygon": [0, 0, 0.2, 0.2, 0.4, 0.4, 0.6, 0.6]},
            {**base, "polygon": [0, 0, 2, 0, 1, 1, 0, 1]},
            {**base, "coordinateSpace": "pdf-points"},
            {**base, "unknown": True},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(DocumentAnchorContractError):
                normalize_document_anchor_selector(invalid, STRUCTURED)
        with self.assertRaisesRegex(DocumentAnchorContractError, "page-aware document structure"):
            normalize_document_anchor_selector(base, PDF)

    def test_text_quotes_resolve_flat_content_and_context(self):
        selector = {
            "kind": "text-quote", "exact": "theorem",
            "prefix": "second context ", "suffix": " ending",
        }
        self.assertEqual(normalize_document_anchor_selector(selector, TEXT), selector)
        for invalid in (
            {"kind": "text-quote", "exact": "absent"},
            {"kind": "text-quote", "exact": "theorem", "prefix": "wrong"},
            {"kind": "text-quote", "exact": "theorem"},
            {"kind": "text-quote", "exact": "x" * 16_001},
            {"kind": "text-quote", "exact": "ending", "page": 1},
            {"kind": "text-quote", "exact": "theorem", "prefix": None},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(DocumentAnchorContractError):
                normalize_document_anchor_selector(invalid, TEXT)
        paged = normalize_document_anchor_selector(
            {"kind": "text-quote", "exact": "ending", "page": 2},
            {**TEXT, "page_count": 2},
        )
        self.assertEqual(paged["page"], 2)
        with self.assertRaisesRegex(DocumentAnchorContractError, "flat text"):
            normalize_document_anchor_selector({"kind": "text-quote", "exact": "A theorem"}, STRUCTURED)

    def test_text_quotes_bind_textual_originals_but_not_binary_originals(self):
        selector = {"kind": "text-quote", "exact": "ending"}
        original = {
            **TEXT, "kind": "original", "media_type": "text/x-python; charset=utf-8",
        }
        self.assertEqual(normalize_document_anchor_selector(selector, original), selector)
        self.assertEqual(
            create_document_anchor(original, selector)["id"],
            create_document_anchor(TEXT, selector)["id"],
        )
        self.assertTrue(is_document_anchor_text_media_type("application/json; charset=utf-8"))
        self.assertFalse(is_document_anchor_text_media_type("application/pdf"))
        self.assertFalse(is_document_anchor_text_media_type("text/"))
        with self.assertRaisesRegex(DocumentAnchorContractError, "textual original"):
            normalize_document_anchor_selector(selector, {**original, "media_type": "application/pdf"})

    def test_structure_pointer_is_restricted_and_content_validated(self):
        self.assertEqual(
            normalize_document_anchor_selector({"kind": "json-pointer", "pointer": "/blocks/1"}, STRUCTURED),
            {"kind": "json-pointer", "pointer": "/blocks/1"},
        )
        for pointer in ("/blocks/2", "/pages/0", "/blocks/01", "/blocks/-1"):
            with self.subTest(pointer=pointer), self.assertRaises(DocumentAnchorContractError):
                normalize_document_anchor_selector({"kind": "json-pointer", "pointer": pointer}, STRUCTURED)

    def test_identity_binds_representation_evidence_and_canonical_json(self):
        selector = {"kind": "json-pointer", "pointer": "/blocks/0"}
        first = create_document_anchor(STRUCTURED, selector)
        changed = create_document_anchor({**STRUCTURED, "content_sha256": "c" * 64}, selector)
        self.assertNotEqual(first["id"], changed["id"])
        self.assertNotEqual(document_anchor_request_hash(STRUCTURED, selector), first["anchorSha256"])
        self.assertEqual(canonical_anchor_json({"z": 1, "a": {"y": 2, "x": 1}}), '{"a":{"x":1,"y":2},"z":1}')
        unicode_anchor = create_document_anchor(
            {**TEXT, "content": "😀 theorem"},
            {"kind": "text-quote", "exact": "😀"},
        )
        self.assertEqual(unicode_anchor["selectorSha256"], "d7b7dbc280f7d8aecbc6a6676a49c2208bd5c747d6c22413f5d45bbb4e05b9f3")
        self.assertEqual(unicode_anchor["anchorSha256"], "08ee44d6e44cd9d2de8ad5de8cbe64c578025e2389afccb77e5011ebf7aa08f7")
        with self.assertRaisesRegex(DocumentAnchorContractError, "both media_type and mediaType"):
            create_document_anchor(
                {**TEXT, "media_type": None, "mediaType": "text/plain"},
                {"kind": "text-quote", "exact": "ending"},
            )

    def test_sub_micro_coordinates_match_the_cross_runtime_fixture(self):
        anchor = create_document_anchor(STRUCTURED, {
            "kind": "page-region", "page": 1, "coordinateSpace": "normalized-page",
            "polygon": [1e-7, 0.2, 0.8, 0.2, 0.8, 0.9, 1e-7, 0.9],
        })
        self.assertEqual(anchor["selector"]["polygon"], [0, 0.2, 0.8, 0.2, 0.8, 0.9, 0, 0.9])
        self.assertEqual(anchor["selectorSha256"], "be1fa13af017bb5c25c82bca1ebe5d5d155baa2a381f8a938baafd1b40ab77ac")
        self.assertEqual(anchor["anchorSha256"], "fbf8b9cfefdf5656a16855422f8b9ccc97afda9510e3fbf878fe0a4a777a38f6")


if __name__ == "__main__":
    unittest.main()
