import hashlib
import json
import math
import time
import unittest
from pathlib import Path

from surface_contract import (
    APPROVED_COMPONENT_TYPES,
    CATALOG_DIGEST,
    CONTRACT_MANIFEST,
    SCHEMA_DIGEST,
    SurfaceContractError,
    get_surface_contract_manifest,
    surface_contract_identity,
    validate_surface_spec,
)

FIXTURES = Path(__file__).with_name("contracts") / "fixtures"


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def research_board():
    return load_fixture("research-board.valid.json")


def canonical_digest(value):
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class SurfaceContractTests(unittest.TestCase):
    def test_accepts_shared_research_board_fixture(self):
        candidate = research_board()
        self.assertEqual(validate_surface_spec(candidate), candidate)

    def test_manifest_digests_and_identity_are_deterministic(self):
        self.assertEqual(canonical_digest(CONTRACT_MANIFEST["schema"]), SCHEMA_DIGEST)
        self.assertEqual(canonical_digest(CONTRACT_MANIFEST["catalog"]), CATALOG_DIGEST)
        identity = surface_contract_identity()
        self.assertEqual(identity["schema_digest"], SCHEMA_DIGEST)
        self.assertEqual(identity["catalog_digest"], CATALOG_DIGEST)
        self.assertRegex(identity["renderer_version"], r"^[0-9a-f]{40}$")

    def test_previous_catalog_is_the_current_one_without_svg_preview(self):
        # Revisions keep the catalog digest they were saved under. The web
        # renderer still draws revisions saved under this earlier digest
        # (compatibleCatalogDigests in lib/surface-renderer-registry.js),
        # which is only sound because SVGPreview was a pure addition.
        previous = json.loads(json.dumps(CONTRACT_MANIFEST["catalog"]))
        del previous["components"]["SVGPreview"]
        self.assertEqual(canonical_digest(previous), "c2ac06907552b576c9967a85779c539d83ea6b81dab7129058a056e791c5e375")

    def test_manifest_copy_is_detached_and_catalog_is_complete(self):
        manifest = get_surface_contract_manifest()
        manifest["catalog"]["components"].pop("Title")
        self.assertIn("Title", CONTRACT_MANIFEST["catalog"]["components"])
        self.assertEqual(
            APPROVED_COMPONENT_TYPES,
            frozenset(CONTRACT_MANIFEST["catalog"]["components"]),
        )

    def test_rejects_shared_action_fixture_and_arbitrary_jsx(self):
        with self.assertRaisesRegex(SurfaceContractError, "not allowed"):
            validate_surface_spec(load_fixture("research-board.invalid-action.json"))

        candidate = research_board()
        candidate["surfaceUpdate"]["components"][1]["component"] = {
            "JSX": {"code": "<script>alert(1)</script>"}
        }
        with self.assertRaisesRegex(SurfaceContractError, "not approved"):
            validate_surface_spec(candidate)

    def test_svg_preview_accepts_drawings_and_refuses_documents_that_are_not(self):
        def with_svg(props):
            candidate = research_board()
            candidate["surfaceUpdate"]["components"][1]["component"] = {"SVGPreview": props}
            return candidate

        validate_surface_spec(with_svg({
            "svg": '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
            "title": "Contour",
            "filename": "contour.svg",
        }))
        validate_surface_spec(with_svg({"svg": '<?xml version="1.0"?>\n<svg></svg>'}))
        validate_surface_spec(with_svg({"svg": "<svg/>", "width": 480, "height": "320px"}))

        refused = {
            "entity expansion": {"svg": '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>'},
            "embedded script": {"svg": "<svg><script>alert(1)</script></svg>"},
            "script scheme": {"svg": '<svg><a href="javascript:alert(1)"/></svg>'},
            "not an svg": {"svg": "<html><body><svg/></body></html>"},
            "handler prop": {"svg": "<svg/>", "onLoad": "alert(1)"},
            "unknown prop": {"svg": "<svg/>", "html": "<b>x</b>"},
            "empty": {"svg": ""},
            "too large": {"svg": "<svg>" + "x" * 20_000 + "</svg>"},
            "css in a size": {"svg": "<svg/>", "width": "100px;position:fixed"},
            "unbounded size": {"svg": "<svg/>", "height": 99999},
            "upper-case declaration": {"svg": '<?XML version="1.0"?><svg/>'},
        }
        for reason, props in refused.items():
            with self.subTest(reason), self.assertRaises(SurfaceContractError):
                validate_surface_spec(with_svg(props))

        # Comments may precede the drawing. Matching them must stay linear:
        # the earlier pattern doubled its work with each stacked comment.
        validate_surface_spec(with_svg({"svg": "<!---->\n" * 2_000 + "<svg/>"}))
        for source in ("<!---->" * 2_800 + "x", "<!--" + "-" * 19_000, "<!--<!--" * 2_400 + "x"):
            started = time.perf_counter()
            with self.subTest(source[:12]), self.assertRaises(SurfaceContractError):
                validate_surface_spec(with_svg({"svg": source}))
            self.assertLess(time.perf_counter() - started, 1.0)

    def test_rejects_props_outside_renderer_contract(self):
        candidate = research_board()
        candidate["surfaceUpdate"]["components"][3]["component"]["DataTable"][
            "options"
        ]["editable"] = True
        with self.assertRaisesRegex(SurfaceContractError, "Additional properties"):
            validate_surface_spec(candidate)

    def test_rejects_unknown_references_and_cycles(self):
        unknown = research_board()
        unknown["surfaceUpdate"]["components"][0]["children"].append("missing")
        with self.assertRaisesRegex(SurfaceContractError, "unknown child"):
            validate_surface_spec(unknown)

        cyclic = research_board()
        cyclic["surfaceUpdate"]["components"][1]["children"] = ["board"]
        with self.assertRaisesRegex(SurfaceContractError, "cycle"):
            validate_surface_spec(cyclic)

        parent_cycle = research_board()
        parent_cycle["surfaceUpdate"]["components"][0]["parentId"] = "board-title"
        parent_cycle["surfaceUpdate"]["components"][0]["children"] = [
            "board-stats", "experiment-table"
        ]
        with self.assertRaisesRegex(SurfaceContractError, "cycle"):
            validate_surface_spec(parent_cycle)

        conflicting = research_board()
        conflicting["surfaceUpdate"]["components"][2]["parentId"] = "board-title"
        with self.assertRaisesRegex(SurfaceContractError, "conflicting parents"):
            validate_surface_spec(conflicting)

        duplicate = research_board()
        duplicate["surfaceUpdate"]["components"][0]["children"].append("board-title")
        with self.assertRaisesRegex(SurfaceContractError, "duplicate child"):
            validate_surface_spec(duplicate)

    def test_rejects_unapproved_bindings_selectors_and_targets(self):
        candidate = research_board()
        candidate["bindings"][0]["source"] = {
            "kind": "http.fetch",
            "resourceId": "https://example.com",
        }
        with self.assertRaisesRegex(SurfaceContractError, "not approved"):
            validate_surface_spec(candidate)

        candidate = research_board()
        candidate["bindings"][0]["source"]["resourceId"] = "experiment-1"
        with self.assertRaisesRegex(SurfaceContractError, "exactly one"):
            validate_surface_spec(candidate)

        candidate = research_board()
        candidate["bindings"][0]["target"]["prop"] = "options.editable"
        with self.assertRaisesRegex(SurfaceContractError, "not approved for DataTable"):
            validate_surface_spec(candidate)

    def test_binding_selectors_use_source_specific_schemas(self):
        candidate = research_board()
        candidate["bindings"][0]["source"] = {
            "kind": "galaxy.eln.experiment",
            "resourceId": "legacy-experiment.1",
        }
        self.assertEqual(validate_surface_spec(candidate), candidate)

        invalid_sources = [
            {"kind": "galaxy.eln.experiment", "resourceId": 42},
            {"kind": "galaxy.eln.experiment", "query": {"bogus": True}},
            {"kind": "galaxy.eln.experiment", "query": {"status": "open"}},
            {"kind": "galaxy.eln.hypothesis", "query": {"status": "running"}},
            {"kind": "galaxy.ham.task", "query": {"aggregate": "status"}},
        ]
        for source in invalid_sources:
            candidate = research_board()
            candidate["bindings"][0]["source"] = source
            with self.subTest(source=source), self.assertRaises(SurfaceContractError):
                validate_surface_spec(candidate)

    def test_rejects_non_finite_numbers(self):
        candidate = research_board()
        candidate["surfaceUpdate"]["components"][2]["component"]["StatsDisplay"][
            "stats"
        ][0]["value"] = math.inf

        with self.assertRaisesRegex(SurfaceContractError, "finite"):
            validate_surface_spec(candidate)

    def test_rejects_prototype_pollution_keys(self):
        for key in ("__proto__", "prototype", "constructor"):
            candidate = research_board()
            candidate["surfaceUpdate"]["components"][1]["component"]["Title"][key] = {}
            with self.subTest(key=key), self.assertRaisesRegex(
                SurfaceContractError, "not allowed"
            ):
                validate_surface_spec(candidate)


if __name__ == "__main__":
    unittest.main()
