import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { requiredElnScopes } from "../lib/eln-scope.js"

test("the ELN gateway exposes bounded discovery, exact reads, and DAG mutations", async () => {
  const route = await readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8")
  assert.match(route, /MAX_CONVERSATION_MUTATION_BODY_BYTES = 131_072/)
  assert.match(route, /path\.length === 1 && \["GET", "POST"\]\.includes\(request\.method\)/)
  assert.match(route, /path\.length === 4 && path\[2\] === "turns" && request\.method === "GET"/)
  assert.match(route, /path\.length === 4 && path\[2\] === "exports" && path\[3\] === "markdown"/)
  assert.match(route, /MAX_CONVERSATION_MARKDOWN_EXPORT_RESPONSE_BYTES = 16_777_216/)
  assert.match(route, /conversationMarkdownExportQuery = new URLSearchParams\(\{ conversation_ref: value \}\)\.toString\(\)/)
  assert.match(route, /parseGalaxyObjectReference\(value\)/)
  assert.match(route, /reference\.kind !== "chat"/)
  assert.match(route, /reference\.selector\.mode !== "pinned"/)
  assert.match(route, /readBoundedResponseBody\(\s*upstream,\s*MAX_CONVERSATION_MARKDOWN_EXPORT_RESPONSE_BYTES/s)
  assert.match(route, /\["turns", "forks", "joins"\]\.includes\(path\[2\]\)/)
  assert.match(route, /conversationMutationBody = await readBoundedBody/)
  assert.match(route, /MAX_CONVERSATION_COLLECTION_RESPONSE_BYTES = 1_048_576/)
  assert.match(route, /conversationCollectionQuery/)
  assert.match(route, /readBoundedResponseBody/)
  assert.doesNotMatch(route, /conversations.*(?:share|presence|execute|model)/i)
  assert.deepEqual(requiredElnScopes("GET", ["conversations", "id"]), {
    primary: "conversation:read",
    accepted: ["conversation:read"],
  })
  assert.deepEqual(requiredElnScopes("GET", ["conversations", "id", "exports", "markdown"]), {
    primary: "conversation:read",
    accepted: ["conversation:read"],
  })
  assert.deepEqual(requiredElnScopes("POST", ["conversations", "id", "forks"]), {
    primary: "conversation:write",
    accepted: ["conversation:write"],
  })
})

test("exact conversation Markdown export is historical, redacted, bounded, and non-mutating", async () => {
  const [server, renderer, share] = await Promise.all([
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/conversation_markdown_export.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/share_bundle.py", import.meta.url), "utf8"),
  ])
  const helperStart = server.indexOf("def _exact_conversation_snapshot")
  const helperEnd = server.indexOf("def _build_share_bundle", helperStart)
  const helper = server.slice(helperStart, helperEnd)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  assert.match(helper, /conversation_reference\.revision/)
  assert.match(helper, /conversation\["tenant_id"\]/)
  assert.match(helper, /introduced_in_version <= %s/)
  assert.match(helper, /SUM\([\s\S]*octet_length\(revision\.content\)/)
  assert.match(helper, /MAX_CONVERSATION_PORTABLE_CONTENT_BYTES/)
  assert.match(helper, /LIMIT 1001/)
  assert.match(helper, /LIMIT 8001/)
  assert.match(helper, /len\(edge_rows\) > 8000/)

  const routeStart = server.indexOf('@app.get("/conversations/{conversation_id}/exports/markdown")')
  const routeEnd = server.indexOf('@app.get("/conversations/{conversation_id}/turns/{turn_id}")', routeStart)
  const exportRoute = server.slice(routeStart, routeEnd)
  assert.ok(routeStart >= 0 && routeEnd > routeStart)
  assert.match(exportRoute, /_conversation_or_404[\s\S]*for_share=True/)
  assert.match(exportRoute, /_exact_conversation_snapshot/)
  assert.match(exportRoute, /redacted_conversation_payload/)
  assert.match(exportRoute, /build_conversation_markdown_export/)
  assert.match(exportRoute, /"Cache-Control": "private, no-store"/)
  assert.match(exportRoute, /"Content-Security-Policy": "sandbox; default-src 'none'"/)
  assert.match(exportRoute, /"X-Content-SHA256": exported\.content_sha256/)
  assert.doesNotMatch(exportRoute, /INSERT|UPDATE|DELETE|_conversation_read/)

  assert.match(renderer, /MAX_MARKDOWN_EXPORT_BYTES = 16 \* 1024 \* 1024/)
  assert.match(renderer, /Preserve authored Markdown and LaTeX exactly/)
  assert.match(renderer, /"artifacts": \[\]/)
  assert.match(renderer, /"excludedRoles": \["system", "tool"\]/)
  assert.match(renderer, /"trustClass": "structural"/)
  assert.match(share, /def redacted_conversation_payload/)
  assert.doesNotMatch(renderer, /payload\[(?:"|')(?:artifactRefs|tenantId|principalId|workspaceId|provenance)/)
})

test("conversation discovery is a snapshot-stable tenant query without transcript bodies", async () => {
  const server = await readFile(
    new URL("../services/galaxy-brain-api/server.py", import.meta.url),
    "utf8",
  )
  const start = server.indexOf('@app.get("/conversations")')
  const end = server.indexOf('@app.post("/conversations"', start)
  assert.ok(start >= 0 && end > start)
  const discovery = server.slice(start, end)
  assert.match(discovery, /limit: int = Query\(default=50, ge=1, le=200\)/)
  assert.match(discovery, /pg_current_snapshot\(\)::text AS snapshot/)
  assert.match(discovery, /WITH visible_creation_candidates AS MATERIALIZED/)
  assert.match(discovery, /creation\.tenant_id = %s/)
  assert.match(discovery, /pg_visible_in_snapshot/)
  assert.match(discovery, /revision\.xmin::text::xid8/)
  assert.match(discovery, /JOIN LATERAL/)
  assert.match(discovery, /ORDER BY creation\.conversation_id DESC/)
  assert.match(discovery, /ORDER BY revision\.version DESC\s+LIMIT 1/)
  assert.ok(discovery.indexOf("LIMIT %s") < discovery.indexOf("JOIN LATERAL"))
  assert.doesNotMatch(discovery, /SELECT revision\.\*/)
  assert.doesNotMatch(discovery, /DISTINCT ON/)
  assert.doesNotMatch(discovery, /FROM gb_conversations/)
  assert.doesNotMatch(discovery, /turn_revision\.content(?:\s|,)|revision\.content(?:\s|,)/)

  const contract = await readFile(
    new URL("../services/galaxy-brain-api/conversation_dag.py", import.meta.url),
    "utf8",
  )
  const verifier = contract.slice(
    contract.indexOf("def decode_list_cursor"),
    contract.indexOf("def exact_reference"),
  )
  assert.match(verifier, /hmac\.compare_digest/)
  assert.match(verifier, /CURSOR_TTL_SECONDS/)
  assert.ok(verifier.indexOf("hmac.compare_digest") < verifier.indexOf("json.loads"))
  assert.match(discovery, /decode_conversation_list_cursor, cursor, PROXY_TOKEN/)
})

test("direct turn resolution binds the tenant, conversation, turn, and introducing revision", async () => {
  const server = await readFile(
    new URL("../services/galaxy-brain-api/server.py", import.meta.url),
    "utf8",
  )
  const start = server.indexOf('@app.get("/conversations/{conversation_id}/turns/{turn_id}")')
  const end = server.indexOf("def _mutate_conversation", start)
  assert.ok(start >= 0 && end > start)
  const resolver = server.slice(start, end)
  assert.match(resolver, /conversation_ref: str = Query\(min_length=1, max_length=16_384\)/)
  assert.match(resolver, /turn_ref: str = Query\(min_length=1, max_length=16_384\)/)
  assert.match(resolver, /conversation\.tenant_id = %s/)
  assert.match(resolver, /introducing_revision\.version = turn\.introduced_in_version/)
  assert.match(resolver, /containing_revision\.content_hash = %s/)
  assert.match(resolver, /containing_revision\.version >= turn\.introduced_in_version/)
  assert.match(resolver, /conversation_reference=parsed_conversation\.wire/)
  assert.doesNotMatch(resolver, /UPDATE|DELETE|provider transcript|model invocation/i)
})

test("conversation pages are snapshot fenced and hydrate cross-page parents", async () => {
  const server = await readFile(
    new URL("../services/galaxy-brain-api/server.py", import.meta.url),
    "utf8",
  )
  assert.match(server, /query \+= " FOR SHARE"/)
  assert.match(server, /continuation_snapshot_required/)
  assert.match(server, /stale_conversation_snapshot/)
  assert.match(server, /AND to_turn_id = ANY\(%s::uuid\[\]\)/)
  assert.doesNotMatch(
    server,
    /AND from_turn_id = ANY\(%s::uuid\[\]\)\s+AND to_turn_id = ANY\(%s::uuid\[\]\)/,
  )
  assert.match(server, /parent_turns=parent_turns/)
})
