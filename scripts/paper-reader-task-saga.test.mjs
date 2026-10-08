import assert from "node:assert/strict"
import test from "node:test"

import {
  createdHamTaskEvidenceReference,
  latestHamTaskReference,
  normalizePaperTaskOperation,
  paperAgentLoopKeys,
  paperAgentLoopTask,
  paperTaskInput,
  runPaperTaskSaga,
} from "../lib/paper-reader-task-saga.js"

const anchorRef = `gb:object:v1:document.anchor:sha256%3A${"a".repeat(64)}:pinned:sha256%3A${"b".repeat(64)}`
const anchorId = `sha256:${"a".repeat(64)}`
const documentRevisionId = "123e4567-e89b-42d3-a456-426614174000"
const request = {
  schemaId: "gb.paper-task-request.v1",
  idempotencyKey: "reader-operation-123",
  requestedAt: "2026-09-23T12:00:00.000Z",
  anchor: { ref: anchorRef, id: anchorId, document_revision_id: documentRevisionId },
  title: "Investigate the selected equation",
  goal: "Check whether the selected estimate survives the stated boundary assumptions.",
  sourceHref: `/documents/${documentRevisionId}?paperView=pdf&paperPage=3&paperAnchor=${encodeURIComponent(anchorId)}`,
}

test("paper task input carries the exact pinned anchor as a read-only HAM resource", () => {
  const input = paperTaskInput(request)
  assert.deepEqual(input.resourceKeys, [anchorRef])
  assert.equal(input.resourceMode, "read")
  assert.equal(input.riskMode, "diagnostic")
  assert.equal(
    latestHamTaskReference({ id: "task-reader-1", title: "Reader task", version: 7 }),
    "gb:object:v1:ham.task:task-reader-1:latest",
  )
  assert.equal(
    createdHamTaskEvidenceReference({ id: "task-reader-1", title: "Reader task", version: 7 }),
    "gb:object:v1:ham.task:task-reader-1:pinned:version%3A7",
  )
})

test("agent-loop recovery derives one exact pending task baseline and stable plan/run identities", () => {
  const comparison = `gb:object:v1:document:comparison:pinned:sha256%3A${"c".repeat(64)}`
  const operation = normalizePaperTaskOperation({
    ...request,
    executionMode: "run",
    resourceRefs: [anchorRef, comparison],
    task: { id: "task-reader-1", title: "Reader task", version: 7 },
  })
  assert.deepEqual(paperAgentLoopKeys(operation.idempotencyKey), {
    planIdempotencyKey: "paper-agent-plan:reader-operation-123",
    runIdempotencyKey: "paper-agent-run:reader-operation-123",
  })
  assert.deepEqual(paperAgentLoopTask(operation), {
    id: "task-reader-1",
    version: 7,
    title: "Reader task",
    goal: request.goal,
    state: "pending",
    resources: [anchorRef, comparison].map((resourceRef, index) => ({
      id: `paper-resource-${index + 1}`,
      resourceRef,
      redacted: false,
      mode: "read",
      status: "active",
    })),
  })
  assert.equal(normalizePaperTaskOperation(request).executionMode, "review")
  assert.throws(() => normalizePaperTaskOperation({ ...request, executionMode: "silent" }), /executionMode/)
  assert.throws(() => paperAgentLoopTask({ ...request, executionMode: "run" }), /task checkpoint/)
})

test("exact textual-original tasks preserve their media-neutral anchor deep link", () => {
  const textAnchor = {
    ...request.anchor,
    selector: { kind: "text-quote", exact: "literal source" },
    selector_kind: "text-quote",
    representation_kind: "original",
    representation_media_type: "text/markdown; charset=utf-8",
  }
  const operation = normalizePaperTaskOperation({
    ...request,
    anchor: textAnchor,
    resourceRefs: [textAnchor.ref],
    sourceHref: `https://galaxy.test/documents/${textAnchor.document_revision_id}?documentAnchor=${encodeURIComponent(textAnchor.id)}`,
  })
  assert.equal(
    operation.sourceHref,
    `/documents/${textAnchor.document_revision_id}?documentAnchor=${encodeURIComponent(textAnchor.id)}`,
  )
})

test("paper task input preserves a bounded deduplicated pinned comparison set", () => {
  const comparison = `gb:object:v1:document:comparison:pinned:sha256%3A${"c".repeat(64)}`
  const input = paperTaskInput({
    ...request,
    resourceRefs: [anchorRef, comparison, comparison],
  })
  assert.deepEqual(input.resourceKeys, [anchorRef, comparison])
  assert.throws(() => paperTaskInput({
    ...request,
    resourceRefs: Array.from({ length: 8 }, (_, index) => (
      `gb:object:v1:document:comparison-${index}:pinned:sha256%3A${index.toString(16).padStart(64, "0")}`
    )),
  }), /at most 8 distinct/)
  assert.throws(() => paperTaskInput({
    ...request,
    resourceRefs: ["gb:object:v1:document:comparison:latest"],
  }), /canonical pinned/)
})

test("legacy recovery replays its original version-pinned provenance without changing the idempotent body", () => {
  const legacy = normalizePaperTaskOperation({
    ...request,
    task: { id: "task-reader-1", title: "Reader task", version: 7 },
  })
  assert.equal(legacy.linkSourceRef, "gb:object:v1:ham.task:task-reader-1:pinned:version%3A7")
  const current = normalizePaperTaskOperation({
    ...request,
    task: { id: "task-reader-1", title: "Reader task", version: 7 },
    linkSourceRef: "gb:object:v1:ham.task:task-reader-1:latest",
  })
  assert.equal(current.linkSourceRef, "gb:object:v1:ham.task:task-reader-1:latest")
})

test("legacy recovery sends the original pinned link body without recreating the task", async () => {
  let taskCalls = 0
  let observedLink = null
  const completed = await runPaperTaskSaga({
    ...request,
    stage: "task-created",
    task: { id: "task-reader-1", title: "Reader task", version: 7 },
  }, {
    async createTask() {
      taskCalls += 1
      throw new Error("legacy recovery must not recreate the task")
    },
    async createLink(input) {
      observedLink = structuredClone(input)
      return { id: "link-legacy", ...input }
    },
    async writeRecovery() {},
    async clearRecovery() {},
  })

  assert.equal(taskCalls, 0)
  assert.equal(observedLink.taskRef, "gb:object:v1:ham.task:task-reader-1:latest")
  assert.equal(observedLink.createdTaskRef, "gb:object:v1:ham.task:task-reader-1:pinned:version%3A7")
  assert.equal(observedLink.idempotencyKey, "paper-link:reader-operation-123")
  assert.equal(completed.createdTaskRef, observedLink.createdTaskRef)
})

test("link failure checkpoints the exact HAM task and reload retries only the link", async () => {
  let persisted = null
  let taskCalls = 0
  let linkCalls = 0
  const taskKeys = []
  const linkKeys = []

  const shared = {
    async createTask(input, idempotencyKey) {
      taskCalls += 1
      taskKeys.push(idempotencyKey)
      assert.deepEqual(input.resourceKeys, [anchorRef])
      return { id: "task-reader-1", title: input.title, version: 7 }
    },
    async writeRecovery(operation) {
      persisted = structuredClone(operation)
    },
    async clearRecovery() {
      persisted = null
    },
  }

  await assert.rejects(
    () => runPaperTaskSaga(request, {
      ...shared,
      async createLink(input) {
        linkCalls += 1
        linkKeys.push(input.idempotencyKey)
        assert.equal(input.anchorRef, anchorRef)
        assert.equal(input.taskRef, "gb:object:v1:ham.task:task-reader-1:latest")
        assert.equal(input.createdTaskRef, "gb:object:v1:ham.task:task-reader-1:pinned:version%3A7")
        throw new Error("simulated Galaxy link outage")
      },
    }),
    /simulated Galaxy link outage/,
  )
  assert.equal(taskCalls, 1)
  assert.equal(linkCalls, 1)
  assert.equal(persisted.stage, "task-created")
  assert.deepEqual(persisted.task, {
    id: "task-reader-1",
    title: "Investigate the selected equation",
    version: 7,
  })

  const afterReload = JSON.parse(JSON.stringify(persisted))
  const completed = await runPaperTaskSaga(afterReload, {
    ...shared,
    async createLink(input) {
      linkCalls += 1
      linkKeys.push(input.idempotencyKey)
      return { id: "link-1", ...input }
    },
  })
  assert.equal(taskCalls, 1, "the checkpointed task is never posted twice")
  assert.equal(linkCalls, 2)
  assert.deepEqual(taskKeys, ["paper-task:reader-operation-123"])
  assert.deepEqual(linkKeys, ["paper-link:reader-operation-123", "paper-link:reader-operation-123"])
  assert.equal(completed.link.id, "link-1")
  assert.equal(persisted, null)
})

test("recovery rejects substituted idempotency keys and unpinned anchors", () => {
  assert.throws(
    () => normalizePaperTaskOperation({ ...request, taskIdempotencyKey: "attacker-key" }),
    /do not match/,
  )
  assert.throws(
    () => normalizePaperTaskOperation({
      ...request,
      anchor: { ref: "gb:object:v1:document.anchor:coordinate:latest" },
    }),
    /exact pinned/,
  )
  assert.throws(
    () => normalizePaperTaskOperation({
      ...request,
      sourceHref: "javascript:alert(1)",
    }),
    /sourceHref/,
  )
})
