import assert from "node:assert/strict"
import { access, readFile, readdir } from "node:fs/promises"
import { constants } from "node:fs"
import { extname, join, relative } from "node:path"
import test from "node:test"

const root = new URL("../", import.meta.url)
const retiredFiles = [
  "components/chat-panel.tsx",
  "components/panels/chat-panel-overlay.tsx",
  "components/panels/social-panel.tsx",
  "components/social-media-dashboard.tsx",
  "components/tool-panel.tsx",
  "components/panels/config-panel.tsx",
  "components/panels/code-editor-panel.tsx",
  "components/code-sandbox.tsx",
  "components/panels/speech-recorder-panel.tsx",
  "components/speech-recorder.tsx",
  "lib/social-media-service.ts",
]
const retiredRuntimeNames = [
  "ChatPanel",
  "ChatPanelOverlay",
  "SocialPanel",
  "SocialMediaDashboard",
  "socialMediaService",
  "social-dashboard",
  "social-feed",
  "social-accounts",
  "social-topics",
  "social-drafts",
  "Social Media Post",
  "ToolPanel",
  "ConfigPanel",
  "CodeEditorPanel",
  "CodeSandbox",
  "SpeechRecorderPanel",
  "SpeechRecorder",
]

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(new URL(`${directory}/`, root), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name))) files.push(path)
  }
  return files
}

test("retired global chat, tool, social, config-wrapper, code-runner, and voice-recorder UI is absent from the runtime closure", async () => {
  for (const path of retiredFiles) {
    await assert.rejects(access(new URL(path, root), constants.F_OK))
  }

  for (const path of await sourceFiles("app").then(async (app) => [
    ...app,
    ...await sourceFiles("components"),
    ...await sourceFiles("lib"),
  ])) {
    const source = await readFile(new URL(path.replaceAll("\\", "/"), root), "utf8")
    for (const retiredName of retiredRuntimeNames) {
      assert.doesNotMatch(source, new RegExp(retiredName), `${relative(".", path)} retains ${retiredName}`)
    }
  }
})

test("retiring the config wrapper preserves the separately gated Flowise media configuration", async () => {
  const flowEditor = await readFile(new URL("components/flow-editor.tsx", root), "utf8")
  const mediaConfig = await readFile(new URL("components/media-processing-config.tsx", root), "utf8")

  assert.match(flowEditor, /from "@\/components\/media-processing-config"/)
  assert.match(flowEditor, /<MediaProcessingConfig\s*\/>/)
  assert.match(mediaConfig, /export function MediaProcessingConfig\(/)
})

test("the unreachable legacy workspace container is gone while Atlas owns the route", async () => {
  await assert.rejects(access(new URL("components/galaxy-brain.tsx", root), constants.F_OK))
  const route = await readFile(new URL("app/workspace/page.tsx", root), "utf8")
  assert.match(route, /<AtlasV2Loader/)
  assert.doesNotMatch(route, /GalaxyBrain|requestedView|requestedShell/)
})

test("Nostr authentication remains a separate retained capability", async () => {
  const routes = [
    "app/api/auth/nostr/options/route.ts",
    "app/api/auth/nostr/request-target/route.ts",
    "app/api/auth/nostr/verify/route.ts",
  ]
  for (const path of routes) {
    await access(new URL(path, root), constants.R_OK)
  }

  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
  assert.equal(typeof packageJson.dependencies["nostr-tools"], "string")
})

test("retirement ledger preserves legacy records instead of deleting them", async () => {
  const ledger = await readFile(new URL("docs/LEGACY_RETIREMENT.md", root), "utf8")
  for (const key of [
    "flowiseSocialAccounts",
    "flowiseSocialPosts",
    "flowiseSocialFilters",
    "flowiseSocialTopics",
    "flowiseSocialDrafts",
  ]) {
    assert.ok(ledger.includes(`\`${key}\``), `ledger omits ${key}`)
  }
  assert.match(ledger, /does not touch Nostr login/)
  assert.match(ledger, /explicit export or purge choice/)
})
