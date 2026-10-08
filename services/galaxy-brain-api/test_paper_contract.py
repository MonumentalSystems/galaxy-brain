import math
import unittest

from fastapi import HTTPException

from server import _paper_anchor, _paper_pdf_filename, _paper_tags


class PaperContractTests(unittest.TestCase):
    def test_accepts_exact_text_and_normalized_ink_anchors(self):
        self.assertEqual(
            _paper_anchor("highlight", {
                "type": "text", "quote": "bounded quote", "startOffset": 3, "endOffset": 16,
            }),
            {"type": "text", "quote": "bounded quote", "startOffset": 3, "endOffset": 16},
        )
        self.assertEqual(
            _paper_anchor("comment", {
                "type": "text", "quote": "😀", "startOffset": 4, "endOffset": 6,
            })["endOffset"],
            6,
        )
        ink = _paper_anchor("ink", {
            "type": "ink", "points": [{"x": 0.0, "y": 0.5}, {"x": 1.0, "y": 0.75}], "width": 3,
        })
        self.assertEqual(len(ink["points"]), 2)
        region = _paper_anchor("highlight", {
            "type": "region", "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4,
        })
        self.assertEqual(region["width"], 0.3)

    def test_rejects_unknown_fields_unbounded_coordinates_and_non_finite_numbers(self):
        values = [
            ("highlight", {"type": "text", "quote": "q", "startOffset": 0, "endOffset": 1, "html": "<b>q</b>"}),
            ("highlight", {"type": "text", "quote": "trimmed", "startOffset": 2, "endOffset": 12}),
            ("ink", {"type": "ink", "points": [{"x": -0.1, "y": 0}, {"x": 1, "y": 1}], "width": 3}),
            ("ink", {"type": "ink", "points": [{"x": math.nan, "y": 0}, {"x": 1, "y": 1}], "width": 3}),
            ("highlight", {"type": "region", "x": 0.8, "y": 0.2, "width": 0.3, "height": 0.4}),
        ]
        for kind, anchor in values:
            with self.subTest(kind=kind, anchor=anchor), self.assertRaises((HTTPException, ValueError)):
                _paper_anchor(kind, anchor)

    def test_tags_are_bounded_and_case_insensitively_unique(self):
        self.assertEqual(_paper_tags([" proof ", "Proof", "audit"]), ["proof", "audit"])
        with self.assertRaises(HTTPException):
            _paper_tags(["x"] * 33)

    def test_download_filename_uses_human_paper_metadata_and_is_filesystem_safe(self):
        self.assertEqual(
            _paper_pdf_filename({
                "title": "Vortices: a study?", "authors": [{"name": "A. Researcher"}],
                "published_at": "2026-04-02T00:00:00Z",
            }),
            "Vortices a study - A. Researcher (2026).pdf",
        )


if __name__ == "__main__":
    unittest.main()
