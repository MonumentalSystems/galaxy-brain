import assert from "node:assert/strict"

import {
  getNotebookSaveStateLabel,
  hasNotebookEditorChanges,
  joinNodeTags,
  normalizeTagString,
} from "../lib/notebook-editor-state.js"

const node = {
  title: "Original",
  content: "Body",
  tags: ["alpha", "beta"],
}

assert.deepEqual(normalizeTagString("alpha, beta , ,gamma"), ["alpha", "beta", "gamma"])
assert.equal(joinNodeTags(node.tags), "alpha, beta")
assert.equal(hasNotebookEditorChanges(node, "Original", "Body", "alpha, beta"), false)
assert.equal(hasNotebookEditorChanges(node, "Changed", "Body", "alpha, beta"), true)
assert.equal(hasNotebookEditorChanges(node, "Original", "Updated", "alpha, beta"), true)
assert.equal(hasNotebookEditorChanges(node, "Original", "Body", "alpha"), true)
assert.equal(getNotebookSaveStateLabel(false, false, null), "All changes saved")
assert.equal(getNotebookSaveStateLabel(true, false, null), "Unsaved changes")
assert.equal(getNotebookSaveStateLabel(false, true, null), "Saving soon...")
assert.match(getNotebookSaveStateLabel(false, false, new Date("2026-05-02T18:20:00Z")), /^Saved /)

console.log("notebook-editor-state tests passed")
