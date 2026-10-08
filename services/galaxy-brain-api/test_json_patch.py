import unittest

from json_patch import JsonPatchError, apply_json_patch


class JsonPatchTests(unittest.TestCase):
    def test_applies_bounded_operations_without_mutating_input(self):
        original = {
            "surfaceUpdate": {
                "components": [
                    {"id": "a", "component": {"Title": {"text": "Draft"}}},
                    {"id": "b", "component": {"Badge": {"text": "Old"}}},
                ]
            },
            "bindings": [],
        }
        patched = apply_json_patch(
            original,
            [
                {"op": "test", "path": "/surfaceUpdate/components/0/id", "value": "a"},
                {
                    "op": "replace",
                    "path": "/surfaceUpdate/components/0/component/Title/text",
                    "value": "Reviewed",
                },
                {
                    "op": "add",
                    "path": "/surfaceUpdate/components/0/component/Title/tone",
                    "value": "quiet",
                },
                {"op": "test", "path": "/surfaceUpdate/components/1/id", "value": "b"},
                {
                    "op": "remove",
                    "path": "/surfaceUpdate/components/1/component/Badge/text",
                },
                {
                    "op": "add",
                    "path": "/surfaceUpdate/components/-",
                    "value": {"id": "c", "component": {"Separator": {}}},
                },
            ],
        )

        self.assertEqual(
            original["surfaceUpdate"]["components"][0]["component"]["Title"],
            {"text": "Draft"},
        )
        self.assertEqual(
            patched["surfaceUpdate"]["components"][0]["component"]["Title"],
            {"text": "Reviewed", "tone": "quiet"},
        )
        self.assertEqual(len(patched["surfaceUpdate"]["components"]), 3)

    def test_requires_stable_id_guard_for_component_and_binding_indexes(self):
        surface = {
            "surfaceUpdate": {
                "components": [{"id": "title", "component": {"Title": {"text": "Old"}}}]
            },
            "bindings": [{"id": "binding-1", "target": {}}],
        }
        with self.assertRaisesRegex(JsonPatchError, "stable id"):
            apply_json_patch(
                surface,
                [{"op": "replace", "path": "/surfaceUpdate/components/0/component/Title/text", "value": "New"}],
            )

        patched = apply_json_patch(
            surface,
            [
                {"op": "test", "path": "/surfaceUpdate/components/0/id", "value": "title"},
                {"op": "replace", "path": "/surfaceUpdate/components/0/component/Title/text", "value": "New"},
                {"op": "test", "path": "/bindings/0/id", "value": "binding-1"},
                {"op": "remove", "path": "/bindings/0"},
            ],
        )
        self.assertEqual(patched["surfaceUpdate"]["components"][0]["component"]["Title"]["text"], "New")
        self.assertEqual(patched["bindings"], [])

    def test_decodes_json_pointer_escapes(self):
        patched = apply_json_patch(
            {
                "surfaceUpdate": {
                    "components": [
                        {"id": "a/b", "component": {"Title": {"~key": 1}}}
                    ]
                }
            },
            [
                {"op": "test", "path": "/surfaceUpdate/components/0/id", "value": "a/b"},
                {
                    "op": "replace",
                    "path": "/surfaceUpdate/components/0/component/Title/~0key",
                    "value": 2,
                },
            ],
        )
        self.assertEqual(
            patched["surfaceUpdate"]["components"][0]["component"]["Title"]["~key"],
            2,
        )

    def test_array_shifts_invalidate_index_guards(self):
        surface = {
            "surfaceUpdate": {
                "components": [
                    {"id": "a", "component": {"Title": {"text": "First"}}},
                    {"id": "b", "component": {"Title": {"text": "Second"}}},
                ]
            },
            "bindings": [
                {"id": "binding-a", "target": {}},
                {"id": "binding-b", "target": {}},
            ],
        }
        cases = [
            [
                {"op": "test", "path": "/surfaceUpdate/components/0/id", "value": "a"},
                {"op": "remove", "path": "/surfaceUpdate/components/0"},
                {"op": "replace", "path": "/surfaceUpdate/components/0/component/Title/text", "value": "Wrong target"},
            ],
            [
                {"op": "test", "path": "/bindings/0/id", "value": "binding-a"},
                {"op": "remove", "path": "/bindings/0"},
                {"op": "replace", "path": "/bindings/0/target", "value": {"componentId": "b", "prop": "data"}},
            ],
        ]
        for patch in cases:
            with self.subTest(patch=patch), self.assertRaisesRegex(JsonPatchError, "current target's stable id"):
                apply_json_patch(surface, patch)

    def test_rejects_invalid_paths_operations_and_failed_tests(self):
        cases = [
            [{"op": "replace", "path": "missing-slash", "value": 1}],
            [{"op": "remove", "path": "/missing"}],
            [{"op": "add", "path": "/items/01", "value": 1}],
            [{"op": "move", "from": "/parent", "path": "/parent/child"}],
            [{"op": "copy", "from": "/value", "path": "/copy"}],
            [{"op": "replace", "path": "", "value": {"ok": True}}],
            [{"op": "replace", "path": "/schema", "value": "other"}],
            [{"op": "replace", "path": "/surfaceUpdate/components", "value": []}],
            [{"op": "test", "path": "/value", "value": 2}],
            [{"op": "execute", "path": "/value"}],
            [{"op": "remove", "path": "/value", "extra": True}],
        ]
        document = {"items": [], "parent": {"child": 1}, "value": 1}
        for patch in cases:
            with self.subTest(patch=patch), self.assertRaises(JsonPatchError):
                apply_json_patch(document, patch)

    def test_bounds_patch_document(self):
        with self.assertRaisesRegex(JsonPatchError, "1-128"):
            apply_json_patch({}, [])
        with self.assertRaisesRegex(JsonPatchError, "1-128"):
            apply_json_patch({}, [{"op": "add", "path": f"/v{i}", "value": i} for i in range(129)])
        with self.assertRaisesRegex(JsonPatchError, "maximum encoded size"):
            apply_json_patch({}, [{"op": "add", "path": "/large", "value": "x" * 140_000}])


if __name__ == "__main__":
    unittest.main()
