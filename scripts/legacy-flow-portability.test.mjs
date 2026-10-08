import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const [dialog, constructor, atlasClient, ledger] = await Promise.all([
  readFile(new URL("../components/tasks/legacy-flow-portability-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("../components/tasks/task-constructor.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../docs/LEGACY_RETIREMENT.md", import.meta.url), "utf8"),
])

test("Atlas exposes one local-only legacy portability command", () => {
  assert.match(atlasClient, /LegacyFlowPortabilityDialog/)
  assert.match(atlasClient, /legacy\.flow\.portability\.open/)
  assert.match(dialog, /createLegacyFlowExportFromStorage\(safeLocalStorage\(\)\)/)
  assert.match(dialog, /parseLegacyFlowExport\(json\)/)
  assert.match(dialog, /migrateLegacyFlowToTaskPlan\(flow/)
  assert.doesNotMatch(dialog, /\bfetch\s*\(|galaxyBrainAPI|flowService|setItem\s*\(|removeItem\s*\(|\.clear\s*\(/)
})

test("oversized files are rejected before their contents are read", () => {
  const sizeGate = dialog.indexOf("file.size > LEGACY_FLOW_EXPORT_MAX_BYTES")
  const textRead = dialog.indexOf("await file.text()")
  assert.ok(sizeGate >= 0)
  assert.ok(textRead > sizeGate)
  assert.match(dialog.slice(sizeGate, textRead), /return/)
})

test("validated imports open only the detached Task Constructor preview", () => {
  assert.match(dialog, /mode="preview"/)
  assert.match(dialog, /initialDraft=\{previewState\?\.draft \|\| null\}/)
  assert.match(dialog, /Nothing is uploaded, executed, dispatched, persisted, or removed/)
  assert.match(constructor, /mode !== "preview"[\s\S]*return null/)
  assert.match(constructor, /Preview revision \$\{nextVersion\} saved in memory\. No server data changed\./)
})

test("retirement policy keeps source rollback time-bounded and data preservation permanent", () => {
  assert.match(ledger, /30-day post-production-deploy source rollback window/)
  assert.match(ledger, /parser and converter remain as longer-term compatibility code/)
  assert.match(ledger, /never automatically purge/i)
})
