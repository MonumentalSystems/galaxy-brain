import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(path, import.meta.url), "utf8")

test("share creation is selector-only, authenticated, bounded, and has no legacy write route", async () => {
  const [api, proxy, types] = await Promise.all([
    read("../services/galaxy-brain-api/server.py"),
    read("../app/api/eln/[...path]/route.ts"),
    read("../lib/types/sharing.ts"),
  ])
  assert.match(api, /@app\.post\("\/share-bundles", status_code=201\)/)
  assert.match(api, /Depends\(require_identity\)/)
  assert.match(api, /MAX_SHARE_BUNDLE_CREATE_BODY_BYTES = 16_384/)
  assert.match(api, /validate_share_bundle_create_request/)
  assert.match(api, /@app\.get\("\/share-snapshots\/\{snapshot_id\}"\)/)
  assert.doesNotMatch(api, /@app\.post\("\/share-snapshots/)
  assert.match(api, /get_legacy_share_snapshot[\s\S]*identity: IdentityContext = Depends\(require_identity\)/)
  assert.match(api, /get_legacy_share_snapshot[\s\S]*tenant_id = %s AND bundle_schema_id IS NULL/)
  assert.match(proxy, /path\[0\] === "share-bundles"/)
  assert.match(proxy, /path\[0\] === "share-snapshots"[\s\S]*path\.length === 2 && request\.method === "GET"/)
  assert.match(proxy, /MAX_SHARE_BUNDLE_CREATE_BODY_BYTES = 16_384/)
  assert.doesNotMatch(types, /CreateLegacyShareSnapshot|CreateShareSnapshotInput/u)
  assert.match(types, /canvas-plus-conversation/u)
})

test("the retained canvas caller sends exact selectors and the share page renders every typed mode", async () => {
  const [canvas, service, page] = await Promise.all([
    read("../components/galaxy-canvas.tsx"),
    read("../lib/galaxy-brain-service.ts"),
    read("../app/share/[snapshotId]/page.tsx"),
  ])
  assert.match(canvas, /pinNodeRevisionForShare/)
  assert.match(canvas, /mode: "object-only"/)
  assert.doesNotMatch(canvas, /snapshot_json/)
  assert.match(service, /upsertNodeRevisions/)
  assert.match(page, /share\.value\.mode === "object-only"/)
  assert.match(page, /CanvasBundle/)
  assert.match(page, /CanvasConversationBundle/)
  assert.match(page, /Tone \{frame\.tone\}/)
  assert.match(page, /x \{frame\.x\} · y \{frame\.y\} · \{frame\.width\} × \{frame\.height\}/)
  assert.match(page, /share\.value\.schemaId === "gb\.share-bundle\.v1"/)
  assert.match(page, /images="omit"/)
  assert.doesNotMatch(page, /getConversation|artifactRefs|provenance/u)
  assert.match(page, /getLegacyShareSnapshot/)
  assert.match(page, /LegacySnapshot/)
  assert.doesNotMatch(page, /Anyone with the link/u)
})

test("share contract adds one explicit v2 canvas plus conversation scope without reopening v1", async () => {
  const [contract, migration] = await Promise.all([
    read("../services/galaxy-brain-api/share_bundle.py"),
    read("../db/migrations/035_typed_share_bundles.sql"),
  ])
  assert.match(contract, /V1_MODES = frozenset\(\{"object-only", "canvas-only"\}\)/)
  assert.match(contract, /V2_MODES = frozenset\(\{"canvas-plus-conversation"\}\)/)
  assert.match(contract, /Canvas shares reject follow-latest object references/)
  const extension = await read("../db/migrations/045_canvas_conversation_share_bundles.sql")
  assert.match(migration, /mode IN \('object-only', 'canvas-only'\)/)
  assert.match(extension, /bundle_schema_id = 'gb\.share-bundle\.v1' AND mode IN \('object-only', 'canvas-only'\)/)
  assert.match(extension, /bundle_schema_id = 'gb\.share-bundle\.v2' AND mode = 'canvas-plus-conversation'/)
  assert.doesNotMatch(`${contract}\n${extension}`, /conversation-only/u)
  assert.match(contract, /Object-only shares exclude conversation, run, and turn records/)
  assert.match(contract, /Canvas-only shares exclude conversation, run, and turn references/)
})

test("combined shares reconstruct an exact bounded historical prefix server-side", async () => {
  const api = await read("../services/galaxy-brain-api/server.py")
  const exactSnapshot = api.slice(
    api.indexOf("def _exact_conversation_snapshot"),
    api.indexOf("def _build_share_bundle"),
  )
  const combinedMode = api.slice(
    api.indexOf('if mode == "canvas-plus-conversation":'),
    api.indexOf('if mode == "canvas-only":'),
  )
  assert.match(exactSnapshot, /gb_conversation_revisions[\s\S]*content_hash = %s/u)
  assert.match(exactSnapshot, /turn\.introduced_in_version <= %s/u)
  assert.match(exactSnapshot, /introduced_in_version <= %s/u)
  assert.match(exactSnapshot, /LIMIT 1001/u)
  assert.match(exactSnapshot, /CASE WHEN revision\.role IN \('user', 'assistant'\)[\s\S]*THEN revision\.content ELSE NULL END AS content/u)
  assert.match(combinedMode, /canvas\["workspace_id"\] != conversation\["workspace_id"\]/u)
  assert.match(combinedMode, /_exact_conversation_snapshot\(/u)
  assert.doesNotMatch(`${exactSnapshot}\n${combinedMode}`, /_conversation_read\(/u)
  assert.doesNotMatch(exactSnapshot, /artifact_refs|provenance|created_at|updated_at/u)
  const contract = await read("../services/galaxy-brain-api/share_bundle.py")
  assert.match(contract, /System and tool turn bodies must be redacted before bundle construction/u)
  assert.match(contract, /"reason": "role-excluded"/u)
  assert.match(contract, /"sourceContentHash": turn_hash/u)
  assert.match(contract, /"contentSha256": f"sha256:/u)
})
