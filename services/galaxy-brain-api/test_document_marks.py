import unittest

from document_marks import (
    DocumentMarkContractError,
    document_mark_content_hash,
    document_mark_request_hash,
    normalize_document_mark_state,
)


ANCHOR_ID = "sha256:" + ("a" * 64)


class DocumentMarkContractTests(unittest.TestCase):
    def test_state_is_bounded_and_canonical(self):
        state = normalize_document_mark_state({
            "body_markdown": "Evidence: $x^2$",
            "color": "#AABBCC",
            "semantic_role": "evidence",
            "tags": ["vortex", "vortex", "helicity"],
            "state": "active",
        })
        self.assertEqual(state["color"], "#aabbcc")
        self.assertEqual(state["tags"], ["vortex", "helicity"])
        self.assertEqual(
            document_mark_content_hash(ANCHOR_ID, "note", state),
            "184595bda676f9c6fc500c9f5f3de1496d0f9c9448d65ea110426b100e1df8da",
        )

    def test_invalid_states_fail_closed(self):
        valid = {
            "body_markdown": "", "color": "#aabbcc", "semantic_role": "note",
            "tags": [], "state": "active",
        }
        for changed in (
            {**valid, "extra": True},
            {**valid, "color": "red"},
            {**valid, "semantic_role": "proof"},
            {**valid, "semantic_role": []},
            {**valid, "state": "hidden"},
            {**valid, "state": {}},
            {**valid, "body_markdown": "x" * 65_537},
            {**valid, "tags": ["x"] * 65},
            {**valid, "tags": ["\x00"]},
            {**valid, "tags": ["   "]},
        ):
            with self.subTest(changed=changed), self.assertRaises(DocumentMarkContractError):
                normalize_document_mark_state(changed)

    def test_content_and_request_hashes_bind_distinct_concerns(self):
        state = {
            "body_markdown": "note", "color": "#123456", "semantic_role": "note",
            "tags": [], "state": "active",
        }
        content_hash = document_mark_content_hash(ANCHOR_ID, "note", state)
        self.assertNotEqual(content_hash, document_mark_request_hash("create", {
            "anchor_id": ANCHOR_ID, "kind": "note", **state,
        }))
        self.assertNotEqual(
            content_hash,
            document_mark_content_hash(ANCHOR_ID, "highlight", state),
        )


if __name__ == "__main__":
    unittest.main()
