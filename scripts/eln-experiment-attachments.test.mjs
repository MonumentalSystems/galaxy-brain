import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  confirmedAttachmentRetry,
  exactAttachmentDocumentRef,
  experimentAttachmentOperationKey,
} from "../lib/eln-experiment-attachments.js"

const digest = "a".repeat(64)
const ref = `gb:object:v1:document:30000000-0000-4000-8000-000000000001:pinned:sha256%3A${digest}`

test("attachment keys bind the exact experiment and pinned document ref", async () => {
  const first = await experimentAttachmentOperationKey("experiment-1", ref)
  assert.match(first, /^eln\.attachment\.[0-9a-f]{64}$/u)
  assert.equal(first, await experimentAttachmentOperationKey("experiment-1", ref))
  assert.notEqual(first, await experimentAttachmentOperationKey("experiment-2", ref))
  assert.equal(exactAttachmentDocumentRef(ref).revisionSha256, digest)
  assert.throws(() => exactAttachmentDocumentRef(ref.replace(":pinned:", ":latest:")))
})

test("confirmed import recovery retains only binding material", async () => {
  const key = await experimentAttachmentOperationKey("experiment-1", ref)
  const retry = confirmedAttachmentRetry({
    document: { ref, title: "Exact notes" },
    placementOperationId: "unused-import-operation",
  }, key)
  assert.deepEqual(retry, { documentRef: ref, idempotencyKey: key, title: "Exact notes" })
  assert.equal(Object.hasOwn(retry, "file"), false)
})

test("proxy and UI enforce the bounded two-stage attachment path", async () => {
  const [route, api, record, drawer, card, research, server] = await Promise.all([
    readFile(new URL("../app/api/eln/[...path]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-record.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-evidence-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-attachment-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-record.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/galaxy-brain-api/server.py", import.meta.url), "utf8"),
  ])
  assert.match(route, /MAX_EXPERIMENT_ATTACHMENT_BODY_BYTES = 8_192/u)
  assert.match(route, /experimentAttachmentCreate[\s\S]*readBoundedBody\(request, MAX_EXPERIMENT_ATTACHMENT_BODY_BYTES\)/u)
  assert.match(route, /headers\.set\("Idempotency-Key", experimentAttachmentIdempotencyKey\)/u)
  assert.match(api, /schemaId: "gb\.eln-attachment-create\.v1"/u)
  assert.match(record, /if \(attachmentRetry\) return await bindConfirmedAttachment\(attachmentRetry\)/u)
  assert.match(record, /const confirmation = await galaxyBrainAPI\.importDocument[\s\S]*setAttachmentRetry\(retry\)[\s\S]*bindConfirmedAttachment\(retry\)/u)
  assert.match(drawer, /Legacy references[\s\S]*read-only/u)
  assert.match(drawer, /image\/png[\s\S]*\.ts[\s\S]*\.py/u)
  assert.match(drawer, /<ExperimentAttachmentList attachments=\{attachments\}/u)
  assert.doesNotMatch(drawer, /href=\{`\/documents\/\$\{encodeURIComponent\(attachment\.documentRevisionId\)\}`\}/u)
  assert.match(card, /hydrateAtlasObjectReferences\(references/u)
  assert.match(card, /currentBatch\?\.byReference\[attachment\.ref\]/u)
  assert.match(card, /failed=\{currentResolution\?\.failed \?\? false\}/u)
  assert.match(card, /setResolution\(\{ identity: referenceIdentity, batch: null, failed: true \}\)/u)
  assert.match(card, /<ObjectProjectionHost/u)
  assert.match(card, /getObjectProjector\(current\.projection\)/u)
  assert.match(card, /current\.handles\.find/u)
  assert.match(card, /projector\.pluginId === "documents"/u)
  assert.match(card, /<AtlasReferenceHandoffLink/u)
  assert.match(card, /subjectRef=\{attachment\.ref\}/u)
  assert.match(card, /expectedDocumentRevisionId=\{attachment\.documentRevisionId\}/u)
  assert.match(card, /expectedRevisionSha256=\{attachment\.revisionSha256\}/u)
  assert.match(card, /resolution=\{current\}/u)
  assert.doesNotMatch(record, /AtlasReferenceHandoffLink/u)
  assert.match(server, /artifact\.content_sha256 AS artifact_content_sha256/u)
  assert.match(server, /INSERT INTO gb_experiment_attachment_requests/u)
  assert.match(research, /revisionSha256: attachment\.revisionSha256/u)
  assert.match(research, /contentSha256: attachment\.contentSha256/u)
  assert.match(research, /revision sha256[\s\S]*content sha256/u)
  assert.doesNotMatch(server, /class ExperimentCreate[\s\S]{0,1000}linked_papers/u)
})
