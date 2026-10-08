import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  atlasCanvasShareUnavailableReason,
  inspectAtlasCanvasConversationShare,
  inspectAtlasCanvasShare,
  inspectAtlasObjectShareReference,
} from "../lib/atlas-share.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"
import { dispatchAtlasCommand, listAtlasCommands } from "../lib/plugins/atlas-commands.js"

const HASH = `sha256:${"a".repeat(64)}`
const CANVAS_ID = "123e4567-e89b-42d3-a456-426614174000"
const pinnedPaper = createGalaxyObjectReference("paper", "paper-1", { mode: "pinned", revision: HASH })
const versionPinnedPaper = createGalaxyObjectReference("paper", "paper-1", {
  mode: "pinned",
  revision: "version:7",
})
const pinnedChat = createGalaxyObjectReference("chat", "40000000-0000-4000-8000-000000000001", {
  mode: "pinned",
  revision: HASH,
})

function canvas(subjectRef = pinnedPaper) {
  return {
    canvasId: CANVAS_ID,
    version: 7,
    contentHash: HASH,
    content: {
      items: [{ subjectRef }],
      edges: [],
    },
  }
}

test("selected-object sharing requires exact identity and excludes conversation records", () => {
  assert.deepEqual(inspectAtlasObjectShareReference(pinnedPaper), {
    ok: true,
    selector: { objectRef: pinnedPaper },
  })
  assert.deepEqual(
    inspectAtlasObjectShareReference(createGalaxyObjectReference("paper", "paper-1")),
    { ok: false, code: "exact_reference_required" },
  )
  assert.deepEqual(
    inspectAtlasObjectShareReference(versionPinnedPaper),
    { ok: false, code: "content_hash_required" },
  )
  for (const kind of ["chat", "run", "turn"]) {
    assert.deepEqual(
      inspectAtlasObjectShareReference(createGalaxyObjectReference(kind, "private-1", {
        mode: "pinned",
        revision: HASH,
      })),
      { ok: false, code: "conversation_excluded" },
    )
  }
})

test("canvas sharing accepts only an exact server-owned revision with pinned references", () => {
  assert.deepEqual(inspectAtlasCanvasShare(canvas()), {
    ok: true,
    selector: { canvasId: CANVAS_ID, version: 7, contentHash: HASH },
  })
  assert.deepEqual(
    inspectAtlasCanvasShare(canvas(versionPinnedPaper)),
    { ok: true, selector: { canvasId: CANVAS_ID, version: 7, contentHash: HASH } },
  )
  assert.deepEqual(
    inspectAtlasCanvasShare(canvas(createGalaxyObjectReference("paper", "paper-1"))),
    { ok: false, code: "exact_reference_required" },
  )
  assert.deepEqual(
    inspectAtlasCanvasShare({ ...canvas(), contentHash: "not-a-hash" }),
    { ok: false, code: "invalid_canvas" },
  )
  assert.deepEqual(
    inspectAtlasCanvasShare({
      ...canvas(),
      content: {
        items: [{ subjectRef: pinnedPaper }],
        edges: [{ semanticRef: createGalaxyObjectReference("claim", "claim-1") }],
      },
    }),
    { ok: false, code: "exact_reference_required" },
  )
  assert.deepEqual(
    inspectAtlasCanvasShare(canvas(createGalaxyObjectReference("turn", "private-turn", {
      mode: "pinned",
      revision: HASH,
    }))),
    { ok: false, code: "conversation_excluded" },
  )
})

test("canvas command failures have accurate, actionable reasons", () => {
  assert.equal(
    atlasCanvasShareUnavailableReason({ ok: false, code: "conversation_excluded" }, true),
    "Remove conversation references before sharing this Atlas. Conversation transcripts are excluded.",
  )
  assert.equal(
    atlasCanvasShareUnavailableReason({ ok: false, code: "exact_reference_required" }, true),
    "Pin every Atlas object to an exact revision, or share an exact selected object instead.",
  )
  assert.equal(
    atlasCanvasShareUnavailableReason({ ok: false, code: "invalid_canvas" }, true),
    "Reload or save this Atlas before sharing; its durable revision is invalid or unavailable.",
  )
  assert.equal(
    atlasCanvasShareUnavailableReason({ ok: false, code: "invalid_canvas" }, false),
    "Move or place an object to create a durable Atlas first.",
  )
})

test("combined sharing requires exactly the selected pinned chat and rejects wider conversation scope", () => {
  assert.deepEqual(inspectAtlasCanvasConversationShare(canvas(pinnedChat), pinnedChat), {
    ok: true,
    selector: {
      canvasId: CANVAS_ID,
      version: 7,
      contentHash: HASH,
      conversationRef: pinnedChat,
    },
  })
  assert.deepEqual(inspectAtlasCanvasConversationShare(canvas(pinnedPaper), pinnedChat), {
    ok: false,
    code: "conversation_scope_ambiguous",
  })
  assert.deepEqual(inspectAtlasCanvasConversationShare({
    ...canvas(pinnedChat),
    content: {
      items: [{ subjectRef: pinnedChat }, { subjectRef: createGalaxyObjectReference("turn", "turn-1", { mode: "pinned", revision: HASH }) }],
      edges: [],
    },
  }, pinnedChat), { ok: false, code: "conversation_scope_ambiguous" })
  assert.deepEqual(inspectAtlasCanvasConversationShare(canvas(pinnedChat), createGalaxyObjectReference("chat", "floating")), {
    ok: false,
    code: "exact_conversation_required",
  })
})

test("registered share commands expose only typed selectors", () => {
  const listed = listAtlasCommands({
    canShareCanvas: true,
    canShareCanvasConversation: true,
    canShareSelection: true,
  }).filter((command) => command.id.startsWith("share."))
  assert.deepEqual(listed.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "share.canvas-conversation.create", enabled: true },
    { id: "share.canvas.create", enabled: true },
    { id: "share.selection.create", enabled: true },
  ])

  assert.deepEqual(dispatchAtlasCommand("share.selection.create", { objectRef: pinnedPaper }), {
    ok: true,
    effect: { kind: "create-object-share", selector: { objectRef: pinnedPaper } },
  })
  assert.deepEqual(dispatchAtlasCommand("share.selection.create", { objectRef: versionPinnedPaper }), {
    ok: false,
    code: "content_hash_required",
  })
  assert.deepEqual(dispatchAtlasCommand("share.canvas.create", {
    canvasId: CANVAS_ID,
    version: 7,
    contentHash: HASH,
  }), {
    ok: true,
    effect: {
      kind: "create-canvas-share",
      selector: { canvasId: CANVAS_ID, version: 7, contentHash: HASH },
    },
  })
  assert.deepEqual(dispatchAtlasCommand("share.canvas.create", {
    canvasId: CANVAS_ID,
    version: 7,
    contentHash: HASH,
    conversationId: "forbidden",
  }), { ok: false, code: "invalid_input" })
  assert.deepEqual(dispatchAtlasCommand("share.canvas-conversation.create", {
    canvasId: CANVAS_ID,
    version: 7,
    contentHash: HASH,
    conversationRef: pinnedChat,
  }), {
    ok: true,
    effect: {
      kind: "confirm-canvas-conversation-share",
      selector: { canvasId: CANVAS_ID, version: 7, contentHash: HASH, conversationRef: pinnedChat },
    },
  })
  assert.deepEqual(dispatchAtlasCommand("share.canvas-conversation.create", {
    canvasId: CANVAS_ID,
    version: 7,
    contentHash: HASH,
    conversationRef: pinnedChat,
    transcript: [],
  }), { ok: false, code: "invalid_input" })
})

test("Atlas creates tenant-scoped bundles through the typed API and preserves retry identity", async () => {
  const [client, dialog, api, types] = await Promise.all([
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/atlas/atlas-share-scope-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/types/sharing.ts", import.meta.url), "utf8"),
  ])
  assert.match(client, /galaxyBrainAPI\.createShareBundle/)
  assert.match(client, /mode: "object-only"/)
  assert.match(client, /mode: "canvas-only"/)
  assert.match(client, /mode: "canvas-plus-conversation"/)
  assert.match(client, /schemaId: "gb\.share-bundle\.v2"/)
  assert.match(client, /idempotencyKey: `share:\$\{crypto\.randomUUID\(\)\}`/)
  assert.match(client, /Retry same share/)
  assert.match(client, /void runAtlasShare\(shareRetryRequest\)/)
  assert.match(client, /canvasShareUnavailableReason: atlasCanvasShareUnavailableReason\(/)
  assert.match(client, /signed-in members of this Galaxy tenant/)
  assert.match(client, /Conversation transcripts require the explicit Atlas \+ conversation share scope/)
  assert.match(client, /onShareCanvasConversation=\{prepareCanvasConversationShare\}/)
  const combinedPreparation = client.slice(
    client.indexOf("const prepareCanvasConversationShare"),
    client.indexOf("const executeCanvasConversationShareCommand"),
  )
  assert.match(combinedPreparation, /inspectAtlasCanvasConversationShare\(current, selected\.subjectRef\)/)
  assert.doesNotMatch(combinedPreparation, /getCanvas|setAtlas/u)
  assert.doesNotMatch(client, /transcriptSnapshot|rawTranscript/)
  assert.match(api, /createShareBundle\(data: CreateShareBundleInput\)/)
  assert.match(types, /canvas-plus-conversation/u)
  assert.doesNotMatch(types, /conversation-only/u)
  assert.match(dialog, /onOpenAutoFocus/)
  assert.match(dialog, /onCloseAutoFocus/)
  assert.match(dialog, /closeDisabled=\{busy\}/)
  assert.match(dialog, /max-h-\[calc\(100dvh-1rem\)\]/)
  assert.match(dialog, /w-\[calc\(100dvw-1rem\)\]|w-\[calc\(100vw-1rem\)\]/)
  assert.match(dialog, /Signed-in members of this Galaxy tenant/)
  assert.match(dialog, /Future canvas changes or turns, system\/tool bodies, artifacts, runs, logs, presence, credentials, or edit rights/)
  assert.match(dialog, /Retry same bundle/)
  assert.match(dialog, /aria-live="polite"/)
  assert.match(dialog, /field-muted-strong/u)
  assert.match(client, /Copy is unavailable here\. Select the visible URL and copy it manually\./)
})
