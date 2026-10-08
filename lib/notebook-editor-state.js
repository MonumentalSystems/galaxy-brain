export function normalizeTagString(tags) {
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

export function joinNodeTags(tags) {
  return (tags || []).join(", ")
}

export function hasNotebookEditorChanges(node, title, content, tags) {
  return (
    title !== node.title ||
    content !== node.content ||
    tags !== joinNodeTags(node.tags)
  )
}

export function getNotebookSaveStateLabel(hasChanges, pendingAutoSave, lastSavedAt) {
  if (pendingAutoSave) return "Saving soon..."
  if (hasChanges) return "Unsaved changes"
  if (lastSavedAt) return `Saved ${lastSavedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
  return "All changes saved"
}
