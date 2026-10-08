import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  MAX_DATASOURCE_CONTENT_REQUEST_BYTES,
  MAX_DATASOURCE_SOURCE_URI_CHARACTERS,
  datasourceContentRequestBody,
  datasourceDurableImportUnavailableReason,
  datasourceFileIngestionRegistered,
  datasourceImportFilename,
  datasourceImportTitle,
  datasourceSourceUri,
} from "../lib/datasource-durable-import.js"
import { reconcileReferencePlacement } from "../lib/canvas/reference-placement.js"
import { validateDurableDocumentImport } from "../lib/durable-document-import.js"
import { dispatchAtlasCommand, listAtlasCommands } from "../lib/plugins/atlas-commands.js"
import { builtinPluginRegistry } from "../lib/plugins/builtins.js"

const connection = {
  id: "10000000-0000-4000-8000-000000000001",
  plugin_id: "filesystem-vault",
  display_name: "Research vault",
}

function snapshot(items = []) {
  return {
    schemaId: "gb.canvas.snapshot.v1",
    items,
    edges: [],
    removedItemIds: [],
    removedEdgeIds: [],
  }
}

function canvas(content, overrides = {}) {
  return {
    canvasId: "50000000-0000-4000-8000-000000000001",
    workspaceId: "workspace-1",
    slug: "main",
    title: "Atlas",
    isDefault: true,
    version: 1,
    contentHash: `sha256:${"1".repeat(64)}`,
    content,
    ...overrides,
  }
}

test("datasource command is a code-owned Atlas contribution with no injected payload", () => {
  const command = listAtlasCommands({ canPlaceReference: true })
    .find((value) => value.id === "datasource.manage.open")
  assert.equal(command?.pluginId, "datasources")
  assert.equal(command?.enabled, true)
  assert.deepEqual(dispatchAtlasCommand("datasource.manage.open", {}), {
    ok: true,
    effect: { kind: "open-datasource-manager" },
  })
  assert.deepEqual(dispatchAtlasCommand("datasource.manage.open", { endpoint: "https://evil.example" }), {
    ok: false,
    code: "invalid_input",
  })
  assert.equal(datasourceFileIngestionRegistered(), true)
  const plan = builtinPluginRegistry.resolve("ingestionPlans", "datasource.file-default")
  assert.equal(plan?.pluginId, "datasources")
  assert.equal(plan?.handler.implementationId, "builtin.ingestion-plan.datasource-file-default")
})

test("only exact durable document media are eligible and provenance stays bounded", () => {
  const pdf = { id: "papers/source.pdf", title: "source.pdf", path: "papers/source.pdf", mime_type: "application/pdf", size: 42 }
  const markdown = { id: "notes/result.md", title: "result.md", path: "notes/result.md", mime_type: "text/markdown", size: 120 }
  const image = { id: "figures/result.png", title: "result.png", path: "figures/result.png", mime_type: "image/png", size: 300 }
  const svg = { id: "figures/result.svg", title: "result.svg", path: "figures/result.svg", mime_type: "image/svg+xml", size: 300 }
  assert.equal(datasourceDurableImportUnavailableReason(pdf, connection), null)
  assert.equal(datasourceDurableImportUnavailableReason(markdown, connection), null)
  assert.match(datasourceDurableImportUnavailableReason(image, connection), /currently supports PDF and UTF-8 text/)
  assert.match(datasourceDurableImportUnavailableReason(svg, connection), /currently supports PDF and UTF-8 text/)
  assert.equal(datasourceImportFilename(markdown), "result.md")
  assert.equal(datasourceImportTitle(markdown), "result")
  assert.equal(
    datasourceSourceUri(connection, markdown),
    "datasource://10000000-0000-4000-8000-000000000001/notes%2Fresult.md",
  )
  assert.match(datasourceDurableImportUnavailableReason({ ...pdf, size: 100_000_001 }, connection), /100 MB/)
  assert.match(datasourceDurableImportUnavailableReason({ ...pdf, id: "x".repeat(2_049) }, connection), /oversized identity/)
  const oversizedUnicodeId = "😀".repeat(1_021)
  assert.ok(new TextEncoder().encode(datasourceContentRequestBody(oversizedUnicodeId)).byteLength > MAX_DATASOURCE_CONTENT_REQUEST_BYTES)
  assert.ok(Array.from(datasourceSourceUri(connection, { ...pdf, id: oversizedUnicodeId })).length > MAX_DATASOURCE_SOURCE_URI_CHARACTERS)
  assert.match(datasourceDurableImportUnavailableReason({ ...pdf, id: oversizedUnicodeId }, connection), /bounded durable import transport/)
  assert.match(datasourceDurableImportUnavailableReason({ ...pdf, id: "/".repeat(2_048) }, connection), /bounded durable import transport/)
  assert.match(
    datasourceDurableImportUnavailableReason({ ...pdf, title: `${"x".repeat(509)}.pdf`, path: `${"x".repeat(509)}.pdf` }, connection),
    /512-character/,
  )
  assert.match(
    datasourceDurableImportUnavailableReason({ ...pdf, title: `${"x".repeat(501)}.pdf`, path: `${"x".repeat(501)}.pdf` }, connection),
    /500-character/,
  )
})

test("datasource confirmation validates and preserves one placement identity through retry", async () => {
  const revisionSha256 = "b".repeat(64)
  const serverResponse = {
    schemaId: "gb.document.import.v1",
    persisted: true,
    ref: `gb:object:v1:document:20000000-0000-4000-8000-000000000001:pinned:sha256%3A${revisionSha256}`,
    document_id: "20000000-0000-4000-8000-000000000001",
    revision_id: "30000000-0000-4000-8000-000000000001",
    artifact_id: "40000000-0000-4000-8000-000000000001",
    source_id: "50000000-0000-4000-8000-000000000001",
    title: "Result",
    display_filename: "result-aaaaaaaaaaaa.md",
    version: 1,
    content_sha256: "a".repeat(64),
    revision_sha256: revisionSha256,
    byte_size: 42,
    media_type: "text/markdown",
    source_kind: "datasource",
    original_filename: "result.md",
    source_uri: "datasource://10000000-0000-4000-8000-000000000001/notes%2Fresult.md",
    ingestion_plan: null,
    replayed: false,
    deduplicatedArtifact: false,
  }
  const confirmed = validateDurableDocumentImport(structuredClone(serverResponse))
  const operationId = "60000000-0000-4000-8000-000000000001"
  const current = canvas(snapshot())
  const latest = canvas(snapshot(), {
    version: 2,
    contentHash: `sha256:${"2".repeat(64)}`,
  })
  const mutations = []
  const placed = await reconcileReferencePlacement({
    current,
    subjectRef: confirmed.ref,
    operationId,
    reloadCanvas: async () => latest,
    mutateCanvas: async (_canvasId, input) => {
      mutations.push(input)
      if (mutations.length === 1) throw new Error("version conflict")
      return canvas(snapshot([input.commands[0].item]), {
        version: 3,
        contentHash: `sha256:${"3".repeat(64)}`,
      })
    },
  })
  assert.equal(mutations.length, 2)
  assert.equal(mutations[0].idempotencyKey, `reference-place:${operationId}`)
  assert.equal(mutations[1].idempotencyKey, mutations[0].idempotencyKey)
  assert.equal(mutations[0].commands[0].item.subjectRef, serverResponse.ref)
  assert.equal(mutations[1].commands[0].item.id, mutations[0].commands[0].item.id)
  assert.equal(placed.canvas.version, 3)
  assert.equal(placed.item.subjectRef, serverResponse.ref)
})

test("Atlas datasource UI uses the durable document spine and never creates a browser-local node", async () => {
  const [dialog, atlas, api] = await Promise.all([
    readFile(new URL("../components/atlas/datasource-manager-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/atlas-v2/atlas-v2-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
  ])
  assert.match(dialog, /galaxyBrainAPI\.getDatasourceItemContent/)
  assert.match(dialog, /galaxyBrainAPI\.importDocument/)
  assert.match(dialog, /executeIngestionPlan\(DATASOURCE_FILE_INGESTION_PLAN_ID/)
  assert.match(dialog, /createDocumentTransformClient/)
  assert.match(dialog, /No durable document was created/)
  assert.match(dialog, /confirmedDraft\.confirmation/)
  assert.match(dialog, /Retry placement without importing again/)
  assert.match(dialog, /target: ingestionTarget/)
  assert.match(dialog, /onDurableImport\(result\.confirmation, draft\.target, ingestionNotice, result\)/)
  assert.match(dialog, /!placementError \|\| !importDraft\?\.confirmation/)
  assert.doesNotMatch(dialog, /placementError \|\| importPhase !== "placing"/)
  assert.match(dialog, /sourceKind: "datasource"/)
  assert.match(dialog, /Connector type/)
  assert.doesNotMatch(dialog, /Connector plugin/)
  assert.match(dialog, /role="status" aria-live="polite"/)
  assert.match(dialog, /onCloseAutoFocus/)
  assert.match(dialog, /titleRef\.current\?\.focus\(\)/)
  assert.match(dialog, /initialLoadComplete/)
  assert.match(dialog, /result\.truncated/)
  assert.match(dialog, /Showing the first \$\{result\.count\} items/)
  assert.match(dialog, /pluginRef\.current && !pluginRef\.current\.disabled/)
  assert.match(dialog, /min-h-11/)
  assert.match(dialog, /Scan is a manual, non-destructive inventory operation|Sync is a manual, non-destructive scan/)
  assert.doesNotMatch(dialog, /galaxyBrainService|contentProcessingService|createNode/)
  assert.match(atlas, /completedDatasourceImport/)
  assert.match(atlas, /Datasource file imported durably, placed, and selected/)
  assert.match(atlas, /currentTarget\.workspaceId !== importTarget\.workspaceId/)
  assert.match(atlas, /currentTarget\.canvasId !== importTarget\.canvasId/)
  assert.match(atlas, /next\.searchParams\.set\("canvas", importTarget\.canvasId\)/)
  assert.match(atlas, /DATASOURCE_FILE_INGESTION_PLAN_ID/)
  assert.match(atlas, /replaceDocumentAnalysisState\(analysisStateForResult/)
  assert.match(atlas, /datasourceIngestionNotice/)
  assert.match(api, /X-Content-SHA256/)
  assert.match(api, /crypto\.subtle\.digest\("SHA-256", bytes\)/)
  assert.match(api, /datasourceContentRequestBody\(itemId\)/)
  assert.match(api, /MAX_DATASOURCE_CONTENT_REQUEST_BYTES/)
})

test("the proxy and backend expose only a bounded handle-read route under explicit tenant policy", async () => {
  const [proxy, server, roots, filesystem] = await Promise.all([
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/tenant_filesystem.py", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/datasource_filesystem.py", import.meta.url), "utf8"),
  ])
  assert.match(proxy, /MAX_DATASOURCE_CONTENT_REQUEST_BYTES = 4_096/)
  assert.match(proxy, /Invalid datasource operation/)
  assert.match(proxy, /path\[2\] === "content"/)
  assert.match(server, /@app\.post\("\/datasources\/\{connection_id\}\/content"\)/)
  assert.match(server, /binding = _resolve_filesystem_root\(connection, identity\)/)
  assert.match(server, /listing = enumerate_authorized_datasource_files\(/)
  assert.match(server, /"inventory_truncated": listing\.truncated/)
  assert.match(server, /"truncated": listing\.truncated or len\(listing\.entries\) > capped_limit/)
  assert.doesNotMatch(server, /os\.walk\(/)
  assert.match(server, /read_authorized_datasource_file\(binding, req\.item_id, MAX_DOCUMENT_BYTES\)/)
  assert.match(server, /def _read_filesystem_item[\s\S]*read_authorized_datasource_file\(binding, item_id, MAX_DOCUMENT_BYTES\)/)
  assert.match(server, /"X-Content-SHA256": content_sha256/)
  assert.match(server, /root_path = authorize_tenant_root/)
  assert.match(server, /def update_datasource_connection\([\s\S]*identity: IdentityContext = Depends\(require_identity\)/)
  assert.match(server, /WHERE c\.id = %s AND c\.tenant_id = %s/)
  assert.match(server, /conditions = \["c\.tenant_id = %s"\]/)
  assert.match(server, /WHERE id = %s AND tenant_id = %s RETURNING \*/)
  const datasourceEndpoints = server.slice(server.indexOf('# Endpoints - Datasources'), server.indexOf('# Endpoints - Node Revisions'))
  assert.doesNotMatch(datasourceEndpoints, /status_code=500, detail=str\(/)
  assert.match(roots, /Filesystem datasources are disabled for this tenant/)
  assert.match(roots, /Datasource root_path is outside this tenant's allowed roots/)
  assert.match(roots, /class AuthorizedTenantRoot/)
  assert.match(roots, /configured_root=configured_root/)
  assert.match(filesystem, /openat/)
  assert.match(filesystem, /os\.O_NOFOLLOW/)
  assert.match(filesystem, /FILE_FLAG_OPEN_REPARSE_POINT/)
  assert.match(filesystem, /_windows_final_path/)
  assert.match(filesystem, /_windows_file_identity/)
  assert.match(filesystem, /def enumerate_authorized_datasource_files/)
  assert.match(filesystem, /MAX_DATASOURCE_ENUMERATION_ENTRIES = 50_000/)
  assert.match(filesystem, /content\.decode\("utf-8", errors="strict"\)/)
})
