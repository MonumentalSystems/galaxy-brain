import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES,
  ConversationMarkdownDownloadError,
  downloadConversationMarkdown,
  fetchConversationMarkdownExport,
  saveConversationMarkdownExport,
} from "../lib/conversation-markdown-export-client.js"
import { conversationMarkdownExportPath } from "../lib/conversation-graph-client.js"
import { createGalaxyObjectReference } from "../lib/galaxy-object-reference.js"

const conversationId = "3abcdef0-0000-4000-8000-000000000001"
const revision = `sha256:${"a".repeat(64)}`
const conversationRef = createGalaxyObjectReference("chat", conversationId, { mode: "pinned", revision })
const markdown = "# Exact branch\n\n$\\oint_C A \\cdot dl$\n"
const digest = createHash("sha256").update(markdown).digest("hex")
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex")

function markdownResponse(body = markdown, overrides = {}) {
  return new Response(body, {
    status: overrides.status ?? 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Disposition": `attachment; filename="exact.md"; filename*=UTF-8''Exact-%CE%A9.md`,
      "ETag": `"sha256-${digest}"`,
      "X-Content-SHA256": digest,
      ...overrides.headers,
    },
  })
}

test("verified download uses one same-origin exact-reference request before saving", async () => {
  const calls = []
  const saved = []
  const exported = await downloadConversationMarkdown(conversationRef, {
    fetcher: async (path, options) => {
      calls.push({ path, options })
      return markdownResponse()
    },
    digest: hash,
    saver: (value) => saved.push(value),
  })
  assert.equal(calls[0].path, conversationMarkdownExportPath(conversationRef))
  assert.deepEqual({
    method: calls[0].options.method,
    accept: calls[0].options.headers.Accept,
    cache: calls[0].options.cache,
    credentials: calls[0].options.credentials,
    redirect: calls[0].options.redirect,
  }, {
    method: "GET",
    accept: "text/markdown; charset=utf-8",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  })
  assert.equal(exported.filename, "Exact-Ω.md")
  assert.equal(exported.contentSha256, digest)
  assert.equal(exported.byteLength, Buffer.byteLength(markdown))
  assert.equal(await exported.blob.text(), markdown)
  assert.equal(saved[0], exported)
})

test("auth and service errors remain generic and never save response bodies", async () => {
  const privateBody = "private backend detail"
  for (const [status, message] of [
    [403, "Conversation export authorization is no longer valid."],
    [422, "The exact conversation snapshot is not exportable."],
    [503, "Conversation Markdown download is unavailable."],
  ]) {
    let saved = false
    await assert.rejects(downloadConversationMarkdown(conversationRef, {
      fetcher: async () => new Response(privateBody, { status }),
      digest: hash,
      saver: () => { saved = true },
    }), (error) => error.message === message && !error.message.includes(privateBody))
    assert.equal(saved, false)
  }
})

test("invalid media, length, digest, content, and redirects fail closed without saving", async () => {
  const cases = [
    markdownResponse(markdown, { headers: { "Content-Type": "text/html" } }),
    markdownResponse(markdown, { headers: { "Content-Length": "1" } }),
    markdownResponse(markdown, { headers: { "ETag": `"sha256-${"b".repeat(64)}"` } }),
    markdownResponse(`${markdown}changed`),
  ]
  for (const response of cases) {
    await assert.rejects(fetchConversationMarkdownExport(conversationRef, {
      fetcher: async () => response,
      digest: hash,
    }), ConversationMarkdownDownloadError)
  }
  const redirected = markdownResponse()
  Object.defineProperty(redirected, "redirected", { value: true })
  await assert.rejects(fetchConversationMarkdownExport(conversationRef, {
    fetcher: async () => redirected,
    digest: hash,
  }), /redirected unexpectedly/u)
})

test("unsafe filenames fall back and browser cleanup is deferred until the next task", async () => {
  for (const filename of ["../../private.md", "CON.md", "%E2%80%AEevil.md"]) {
    const exported = await fetchConversationMarkdownExport(conversationRef, {
      fetcher: async () => markdownResponse(markdown, {
        headers: { "Content-Disposition": `attachment; filename*=UTF-8''${filename}` },
      }),
      digest: hash,
    })
    assert.equal(exported.filename, "conversation--aaaaaaaaaaaa.md")
  }

  const events = []
  const cleanup = []
  const anchor = {
    click() { events.push("click") },
    remove() { events.push("remove") },
  }
  saveConversationMarkdownExport({ blob: new Blob([markdown]), filename: "exact.md" }, {
    documentValue: {
      body: { append(value) { assert.equal(value, anchor); events.push("append") } },
      createElement(name) { assert.equal(name, "a"); return anchor },
    },
    createObjectURL() { events.push("create"); return "blob:exact" },
    revokeObjectURL(url) { assert.equal(url, "blob:exact"); events.push("revoke") },
    scheduleCleanup(callback) { events.push("schedule"); cleanup.push(callback) },
  })
  assert.deepEqual(events, ["create", "append", "click", "remove", "schedule"])
  cleanup[0]()
  assert.equal(events.at(-1), "revoke")
})

test("declared responses above the browser cap are rejected before reading", async () => {
  const response = markdownResponse(markdown, {
    headers: { "Content-Length": String(CONVERSATION_MARKDOWN_EXPORT_MAX_BYTES + 1) },
  })
  await assert.rejects(fetchConversationMarkdownExport(conversationRef, {
    fetcher: async () => response,
    digest: hash,
  }), /download bound/u)
})

test("abort during digest prevents a stale export from reaching the saver", async () => {
  const controller = new AbortController()
  let releaseDigest
  let markDigestStarted
  let saved = false
  const digestStarted = new Promise((resolve) => { markDigestStarted = resolve })
  const digestPending = new Promise((resolve) => { releaseDigest = resolve })
  const pending = downloadConversationMarkdown(conversationRef, {
    fetcher: async () => markdownResponse(),
    signal: controller.signal,
    digest: async () => {
      markDigestStarted()
      await digestPending
      return digest
    },
    saver: () => { saved = true },
  })
  await digestStarted
  controller.abort()
  releaseDigest()
  await assert.rejects(pending, (error) => error?.name === "AbortError")
  assert.equal(saved, false)
})
