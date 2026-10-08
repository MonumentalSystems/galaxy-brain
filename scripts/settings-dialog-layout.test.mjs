import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../components/settings-dialog.tsx", import.meta.url), "utf8")
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8")

test("settings dialog connects its content and body to the responsive scroll layout", () => {
  assert.match(source, /settings-dialog-content app-panel/)
  assert.match(source, /settings-dialog-body custom-scrollbar/)
  assert.match(styles, /\.settings-dialog-content\s*{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto;[^}]*overflow:\s*hidden;/s)
  assert.match(styles, /\.settings-dialog-body\s*{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s)
  assert.match(styles, /@media \(max-height:\s*32rem\)[\s\S]*\.settings-dialog-content\s*{[^}]*display:\s*block;[^}]*overflow-y:\s*auto;[\s\S]*\.settings-dialog-body\s*{[^}]*overflow:\s*visible;/)
})
