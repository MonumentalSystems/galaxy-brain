import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  appendExperimentMetric,
  appendEvidenceReference,
  buildWandbRunUrl,
  buildExperimentUpdatePatch,
  canonicalizeExperimentTags,
  classifyExperimentLoadError,
  configSnapshotsEqual,
  describeExperimentLoadError,
  experimentSaveCompletionState,
  formatExperimentTags,
  isExperimentSaveRequestActive,
  loadedExperimentForScope,
  mergeExperimentMetrics,
  mergeExperimentUpdate,
  observationExperimentForSubmission,
  parseConfigSnapshot,
  parseManualMetricDraft,
  pendingExperimentObservationForScope,
  rebaseSubmittedExperimentField,
  shouldQueueExperimentSave,
  shouldScheduleQueuedExperimentSave,
} from "../lib/eln-experiment-state.js"

test("pending observation selection cannot cross an authority scope", () => {
  const operation = {
    operationId: "00000000-0000-4000-8000-000000000001",
    experimentId: "experiment-a",
    request: { schemaId: "gb.eln-observation-create.v1", body: "sealed", observedAt: null },
  }
  const originalScope = JSON.stringify(["tenant-a", "principal-a", "experiment-a"])
  const selection = { scopeKey: originalScope, operation }

  assert.equal(pendingExperimentObservationForScope(selection, originalScope), operation)
  assert.equal(
    pendingExperimentObservationForScope(
      selection,
      JSON.stringify(["tenant-a", "principal-b", "experiment-a"]),
    ),
    null,
    "a new principal cannot submit or clean up the old principal's journal",
  )
  assert.equal(
    pendingExperimentObservationForScope(
      selection,
      JSON.stringify(["tenant-b", "principal-a", "experiment-a"]),
    ),
    null,
    "a new tenant cannot submit or clean up the old tenant's journal",
  )
  assert.equal(
    pendingExperimentObservationForScope(
      selection,
      JSON.stringify(["tenant-a", "principal-a", "experiment-b"]),
    ),
    null,
    "a new experiment cannot submit or clean up the old experiment's journal",
  )
})

test("loaded experiment and composer authority reject stale scopes", () => {
  const experiment = { id: "experiment-a", title: "Old authority record" }
  const originalScope = JSON.stringify(["tenant-a", "principal-a", "experiment-a"])
  const selection = { scopeKey: originalScope, experiment }

  assert.equal(loadedExperimentForScope(selection, originalScope), experiment)
  assert.equal(observationExperimentForSubmission(selection, originalScope, originalScope), experiment)
  for (const staleScope of [
    JSON.stringify(["tenant-a", "principal-b", "experiment-a"]),
    JSON.stringify(["tenant-b", "principal-a", "experiment-a"]),
    JSON.stringify(["tenant-a", "principal-a", "experiment-b"]),
  ]) {
    assert.equal(
      loadedExperimentForScope(selection, staleScope),
      null,
      "a stale loaded experiment cannot authorize a journal or POST",
    )
  }
  assert.equal(
    observationExperimentForSubmission(
      selection,
      originalScope,
      JSON.stringify(["tenant-a", "principal-b", "experiment-a"]),
    ),
    null,
    "an old composer draft cannot authorize a journal or POST under the current loaded record",
  )
})

test("ordinary experiment updates preserve already-loaded metrics", () => {
  const metrics = [
    {
      id: 7,
      experiment_id: "exp-1",
      name: "loss",
      value: 0.125,
      timestamp: "2026-09-09T12:00:00Z",
      source: "manual",
    },
  ]

  const merged = mergeExperimentUpdate(
    { id: "exp-1", title: "Before", metrics },
    { id: "exp-1", title: "After" },
  )

  assert.equal(merged.title, "After")
  assert.deepEqual(merged.metrics, metrics)
})

test("an update response can intentionally replace metrics", () => {
  const freshMetrics = [{ id: 8, name: "accuracy", value: 0.98 }]
  const merged = mergeExperimentUpdate(
    { id: "exp-1", metrics: [{ id: 7, name: "loss", value: 0.125 }] },
    { id: "exp-1", metrics: freshMetrics },
  )

  assert.deepEqual(merged.metrics, freshMetrics)
})

test("delayed PATCH responses preserve concurrently created append-only attachments", () => {
  const originalAttachment = {
    attachmentId: "attachment-1",
    ref: "gb:object:v1:document:30000000-0000-4000-8000-000000000001:pinned:sha256%3A" + "a".repeat(64),
  }
  const concurrentAttachment = {
    attachmentId: "attachment-2",
    ref: "gb:object:v1:document:30000000-0000-4000-8000-000000000002:pinned:sha256%3A" + "b".repeat(64),
    title: "Created while the save was in flight",
  }
  const merged = mergeExperimentUpdate(
    { id: "exp-1", attachment_refs: [originalAttachment], attachment_count: 1 },
    { id: "exp-1", title: "After" },
  )
  assert.deepEqual(merged.attachment_refs, [originalAttachment])
  assert.equal(merged.attachment_count, 1)

  const currentAfterCreate = {
    ...merged,
    attachment_refs: [originalAttachment, concurrentAttachment],
    attachment_count: 2,
  }
  const delayedPatch = mergeExperimentUpdate(currentAfterCreate, {
    id: "exp-1", title: "After", attachment_refs: [originalAttachment], attachment_count: 1,
  })
  assert.deepEqual(delayedPatch.attachment_refs, [originalAttachment, concurrentAttachment])
  assert.equal(delayedPatch.attachment_count, 2)
  assert.equal(delayedPatch.attachment_refs[1], concurrentAttachment)
})

test("delayed PATCH responses cannot erase concurrently appended observations", () => {
  const first = { id: "observation-1", body: "First" }
  const concurrent = { id: "observation-2", body: "Concurrent" }
  const current = { id: "exp-1", observation_refs: [first, concurrent], observation_count: 2 }
  const delayed = mergeExperimentUpdate(current, {
    id: "exp-1", title: "Saved earlier", observation_refs: [first], observation_count: 1,
  })
  assert.deepEqual(delayed.observation_refs, [first, concurrent])
  assert.equal(delayed.observation_count, 2)
})

test("only a real 404 is presented as not found", () => {
  assert.equal(classifyExperimentLoadError({ status: 404 }), "not-found")
  assert.equal(classifyExperimentLoadError({ status: 503 }), "error")
  assert.equal(classifyExperimentLoadError(new TypeError("fetch failed")), "error")
})

test("load error descriptions are bounded and have a safe fallback", () => {
  assert.equal(
    describeExperimentLoadError({ status: 503, message: "password=do-not-render" }),
    "The lab notebook service is temporarily unavailable.",
  )
  assert.equal(
    describeExperimentLoadError(null),
    "The lab notebook service could not load this experiment.",
  )
  assert.equal(
    describeExperimentLoadError(new TypeError("fetch failed for secret upstream URL")),
    "Galaxy Brain could not reach the lab notebook service.",
  )
  assert.doesNotMatch(describeExperimentLoadError(new Error("raw upstream detail")), /upstream detail/)
})

test("experiment detail loads opt into throwing API errors", async () => {
  const source = await readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /getExperiment\(id: string\)[\s\S]*?gbFetch\(`\/experiments\/\$\{id\}`, undefined, true\)/,
  )
})

test("configuration snapshots accept objects, reject other JSON, and compare independent of key order", () => {
  assert.deepEqual(parseConfigSnapshot(""), { value: {}, error: null })
  assert.deepEqual(parseConfigSnapshot('{"seed":42}'), { value: { seed: 42 }, error: null })
  assert.match(parseConfigSnapshot("[1, 2]").error, /JSON object/)
  assert.match(parseConfigSnapshot("{oops").error, /not valid JSON/)
  assert.equal(configSnapshotsEqual({ alpha: 1, nested: { beta: 2 } }, { nested: { beta: 2 }, alpha: 1 }), true)
  assert.equal(configSnapshotsEqual({ alpha: 1 }, { alpha: 2 }), false)
})

test("evidence references are trimmed, deduplicated, and bounded", () => {
  const first = appendEvidenceReference([], "  10.1234/example  ")
  assert.deepEqual(first, ["10.1234/example"])
  assert.equal(appendEvidenceReference(first, "10.1234/example"), first)
  assert.equal(appendEvidenceReference(first, "x".repeat(2049)), first)
})

test("manual metrics validate finite values and non-negative integer steps", () => {
  assert.deepEqual(parseManualMetricDraft({ name: " accuracy ", value: "0.98", step: "12" }), {
    metric: { name: "accuracy", value: 0.98, step: 12, source: "manual" },
    error: null,
  })
  assert.match(parseManualMetricDraft({ name: "", value: "1", step: "" }).error, /name is required/)
  assert.match(parseManualMetricDraft({ name: "loss", value: "Infinity", step: "" }).error, /finite number/)
  assert.match(parseManualMetricDraft({ name: "loss", value: "1", step: "1.5" }).error, /non-negative integer/)
})

test("W&B links keep entity/project structure while encoding path segments", () => {
  assert.equal(
    buildWandbRunUrl("research team/vortex project", "run/42"),
    "https://wandb.ai/research%20team/vortex%20project/runs/run%2F42",
  )
  assert.equal(buildWandbRunUrl("", ""), null)
})

test("tag formatting is canonical and does not create a follow-up patch", () => {
  const current = {
    title: "Vortex trial",
    status: "running",
    domain: "fusion",
    hypothesis: "h",
    protocol: "p",
    config_snapshot: { seed: 42 },
    wandb_run_id: "",
    wandb_project: "",
    local_run_path: "",
    results: "r",
    interpretation: "i",
    conclusion: "c",
    tags: ["vortex", "helicity"],
    linked_papers: [],
    linked_experiments: [],
  }
  const tags = canonicalizeExperimentTags(" vortex, helicity, vortex ")
  assert.deepEqual(tags, ["vortex", "helicity"])
  assert.equal(formatExperimentTags(tags), "vortex, helicity")
  assert.deepEqual(buildExperimentUpdatePatch(current, { ...current, tags }), {})
  assert.deepEqual(buildExperimentUpdatePatch(current, { ...current, title: "Vortex trial 2", tags }), {
    title: "Vortex trial 2",
  })
})

test("metric reconciliation changes metrics only and preserves the editing baseline", () => {
  const current = { id: "exp-1", title: "Locally saved title", metrics: [] }
  const optimistic = appendExperimentMetric(
    current,
    { name: "accuracy", value: 0.98, source: "manual" },
    "2026-09-09T12:00:00Z",
  )
  assert.equal(optimistic.title, "Locally saved title")
  assert.equal(optimistic.metrics.length, 1)
  assert.equal(optimistic.metrics[0].experiment_id, "exp-1")

  const reconciled = mergeExperimentMetrics(optimistic, [{ id: 9, name: "accuracy", value: 0.98 }])
  assert.equal(reconciled.title, "Locally saved title")
  assert.deepEqual(reconciled.metrics, [{ id: 9, name: "accuracy", value: 0.98 }])
})

test("save responses rebase untouched remote fields without overwriting in-flight edits", () => {
  const submitted = {
    title: "A2",
    status: "running",
    domain: "fusion",
    hypothesis: "submitted hypothesis",
    protocol: "old protocol",
    configText: '{\n  "seed": 1\n}',
    wandbRunId: "run-old",
    wandbProject: "team/project-old",
    localRunPath: "runs/old",
    results: "submitted results",
    interpretation: "submitted interpretation",
    conclusion: "submitted conclusion",
    tagsInput: "vortex, helicity",
    linkedPapers: ["gb:paper:paper-old"],
    linkedExperiments: ["gb:experiment:exp-old"],
  }
  const current = {
    ...submitted,
    title: "A3 typed while saving",
    configText: '{ "seed":',
    wandbRunId: "run-local",
    wandbProject: "team/project-local",
    localRunPath: "runs/local",
    tagsInput: "vortex, helicity, topology",
    linkedPapers: [...submitted.linkedPapers, "gb:paper:paper-local"],
    linkedExperiments: [...submitted.linkedExperiments, "gb:experiment:exp-local"],
  }
  const server = {
    ...submitted,
    title: "A2",
    protocol: "new-from-other-tab",
    hypothesis: "remote hypothesis",
    configText: '{\n  "seed": 2\n}',
    wandbRunId: "run-remote",
    wandbProject: "team/project-remote",
    localRunPath: "runs/remote",
    tagsInput: "vortex, remote",
    linkedPapers: ["gb:paper:paper-remote"],
    linkedExperiments: ["gb:experiment:exp-remote"],
  }

  const rebased = Object.fromEntries(
    Object.keys(submitted).map((field) => [
      field,
      rebaseSubmittedExperimentField(submitted[field], current[field], server[field]),
    ]),
  )

  assert.equal(rebased.protocol, "new-from-other-tab")
  assert.equal(rebased.hypothesis, "remote hypothesis")
  assert.equal(rebased.title, "A3 typed while saving")
  assert.equal(rebased.configText, '{ "seed":')
  assert.equal(rebased.wandbRunId, "run-local")
  assert.equal(rebased.wandbProject, "team/project-local")
  assert.equal(rebased.localRunPath, "runs/local")
  assert.equal(rebased.tagsInput, "vortex, helicity, topology")
  assert.deepEqual(rebased.linkedPapers, ["gb:paper:paper-old", "gb:paper:paper-local"])
  assert.deepEqual(rebased.linkedExperiments, ["gb:experiment:exp-old", "gb:experiment:exp-local"])
})

test("save completion stays honest while later generations are serialized", () => {
  assert.equal(experimentSaveCompletionState(4, 4, 1), "saving")
  assert.equal(experimentSaveCompletionState(5, 4, 0), "idle")
  assert.equal(experimentSaveCompletionState(5, 5, 0), "saved")
  assert.equal(experimentSaveCompletionState(0, null, 0), "idle")

  // Request 2 is held until request 1 completes, so it cannot reach the server first.
  assert.equal(shouldQueueExperimentSave(1), true)
  assert.equal(shouldScheduleQueuedExperimentSave(2, 1), true)
  assert.equal(shouldQueueExperimentSave(0), false)
  assert.equal(shouldScheduleQueuedExperimentSave(1, 1), false)
  assert.equal(shouldScheduleQueuedExperimentSave(null, 1), false)
})

test("deferred save responses become inert after unmount or an experiment switch", async () => {
  let finishSave
  const deferredSave = new Promise((resolve) => {
    finishSave = resolve
  })
  const lifecycle = { mounted: true, epoch: 7, experimentId: "exp-a" }
  const request = { epoch: lifecycle.epoch, experimentId: lifecycle.experimentId }
  const completion = deferredSave.then(() => isExperimentSaveRequestActive(
    lifecycle.mounted,
    request.epoch,
    lifecycle.epoch,
    request.experimentId,
    lifecycle.experimentId,
  ))

  lifecycle.experimentId = "exp-b"
  lifecycle.epoch += 1
  finishSave()
  assert.equal(await completion, false)
  assert.equal(isExperimentSaveRequestActive(false, 9, 9, "exp-a", "exp-a"), false)
  assert.equal(isExperimentSaveRequestActive(true, 9, 9, "exp-a", "exp-a"), true)
})

test("evidence UI uses bounded metric reconciliation, frozen invalid projections, and honest HAM scope", async () => {
  const [api, drawer, record] = await Promise.all([
    readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-evidence-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-record.tsx", import.meta.url), "utf8"),
  ])
  assert.match(api, /addMetrics[\s\S]*?gbFetch\([\s\S]*?, true\)/)
  assert.match(drawer, /HAM publishing is not configured here/)
  assert.match(drawer, /aria-invalid=\{Boolean\(configError\)\}/)
  assert.doesNotMatch(record, /weaviateService/)
  assert.doesNotMatch(record, /setExperiment\(refreshed\)/)
  assert.match(record, /setExperiment\(\(current\) => mergeExperimentMetrics\(current, refreshed\.metrics\)\)/)
  assert.match(record, /parsedConfig\.error \? \{\} : experimentDraft/)
  for (const setter of [
    "setTitle",
    "setStatus",
    "setDomain",
    "setHypothesis",
    "setProtocol",
    "setConfigText",
    "setWandbRunId",
    "setWandbProject",
    "setLocalRunPath",
    "setResults",
    "setInterpretation",
    "setConclusion",
    "setTagsInput",
    "setLinkedExperiments",
  ]) {
    assert.match(record, new RegExp(`${setter}\\(\\(current\\) => rebaseSubmittedExperimentField\\(`))
  }
  assert.doesNotMatch(record, /linked_papers:\s*linkedPapers/u)
  assert.doesNotMatch(record, /setLinkedPapers/u)
  assert.match(record, /draftGenerationRef\.current \+= 1/)
  assert.match(record, /outstandingSaveRequestsRef\.current\.add\(requestId\)/)
  assert.match(record, /outstandingSaveRequestsRef\.current\.delete\(requestId\)/)
  assert.match(record, /shouldQueueExperimentSave\(outstandingSaveRequestsRef\.current\.size\)/)
  assert.match(record, /shouldScheduleQueuedExperimentSave\(queuedGeneration, submittedGeneration\)/)
  assert.match(record, /experimentSaveCompletionState\(/)
  assert.match(record, /const requestEpoch = recordEpochRef\.current/)
  assert.match(record, /const requestExperimentId = experimentId/)
  assert.match(record, /if \(!isActiveSaveRequest\(\)\) return/)
  assert.match(record, /if \(isActiveSaveRequest\(\)\) \{\s+toast\(\{ title: "Save error"/)
  assert.match(record, /isActiveSaveRequest\(\) &&\s+outstandingSaveRequestsRef\.current\.size === 0/)
  assert.match(record, /recordEpochRef\.current \+= 1/)
  assert.match(record, /activeExperimentIdRef\.current = null/)
  assert.match(record, /outstandingSaveRequests\.clear\(\)/)
  assert.match(record, /queuedSaveGenerationRef\.current = null/)
  assert.match(record, /setSaveState\(outstandingSaveRequestsRef\.current\.size > 0 \? "saving" : "idle"\)/)
  assert.match(record, /outstandingSaveRequestsRef\.current\.size === 0 &&\s+acknowledgedDraftGenerationRef\.current === draftGenerationRef\.current/)
  assert.doesNotMatch(record, /setSaveState\("saved"\)/)
})

test("the research record exposes durable semantic zoom projections", async () => {
  const [dashboard, record, workspace, markdownDocument] = await Promise.all([
    readFile(new URL("../components/eln/eln-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-record.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/workspace/task-workspace-surface.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/workspace/research-markdown-document.tsx", import.meta.url), "utf8"),
  ])

  assert.match(dashboard, /research-workbench/)
  assert.match(dashboard, /Electronic Lab Notebook/)
  assert.match(dashboard, /Atlas[\s\S]*Board[\s\S]*Record[\s\S]*Source/)
  assert.match(workspace, /TaskWorkspaceScale = "atlas" \| "board" \| "record" \| "source"/)
  assert.match(workspace, /value="atlas"/)
  assert.match(workspace, /value="board"/)
  assert.match(workspace, /value="record"/)
  assert.match(workspace, /value="source"/)
  assert.match(workspace, /defaultValue="rendered"/)
  assert.match(workspace, /dynamic\([\s\S]*research-markdown-document/)
  assert.match(workspace, /<ResearchMarkdownDocument markdown=\{markdown\} \/>/)
  assert.match(workspace, /value="raw"/)
  assert.match(markdownDocument, /<MarkdownRenderer content=\{markdown\} images="omit"/)
  assert.match(record, /searchParams\.get\("scale"\)/)
  assert.match(record, /router\.replace\(query \? `\$\{pathname\}\?\$\{query\}` : pathname, \{ scroll: false \}\)/)
  assert.match(record, /<TaskWorkspaceSurface[\s\S]*scale=\{workspaceScale\}[\s\S]*onScaleChange=\{changeWorkspaceScale\}/)
})

test("the new experiment dialog can restore focus to its Atlas command trigger", async () => {
  const dialog = await readFile(new URL("../components/eln/new-experiment-dialog.tsx", import.meta.url), "utf8")

  assert.match(dialog, /returnFocus\?: HTMLElement \| null/)
  assert.match(dialog, /fallbackFocus\?: HTMLElement \| null/)
  assert.match(dialog, /focusFirstConnected\(\[returnFocus, fallbackFocus\], contentRef\.current\)/)
  assert.match(dialog, /event\.preventDefault\(\)/)
  assert.match(dialog, /writePendingExperimentCreate\(window\.localStorage, recoveryScope, draft\)/)
  assert.match(dialog, /listPendingExperimentCreates\(window\.localStorage, recoveryScope\)/)
  assert.match(dialog, /`experiment-create:\$\{nextOperation\.operationId\}`/)
  assert.match(dialog, /onCreated\?\.\(result, nextOperation\.operationId\)/)
  assert.match(dialog, /removePendingExperimentCreate\(window\.localStorage, recoveryScope, nextOperation\.operationId\)/)
  assert.match(dialog, /navigateOnCreated = true/)
  assert.match(dialog, /Retry exact request/)
  assert.match(dialog, /The creation outcome is unconfirmed\./)
  assert.doesNotMatch(dialog, /creationError instanceof Error \? creationError\.message/)
})

test("experiment creation throws safe typed API errors instead of swallowing them", async () => {
  const source = await readFile(new URL("../lib/galaxy-brain-api.ts", import.meta.url), "utf8")
  assert.match(source, /createExperiment\(data: CreateExperimentInput, idempotencyKey: string\)/)
  assert.match(
    source,
    /createExperiment[\s\S]*?headers: \{ "Idempotency-Key": idempotencyKey \}[\s\S]*?JSON\.stringify\(data\)[\s\S]*?\}, true\)/,
  )
})

test("ELN responsive and live-state styling does not disturb authoring fences", async () => {
  const [record, drawer, attachment, browser, hypotheses, hypothesisDialog] = await Promise.all([
    readFile(new URL("../components/eln/experiment-record.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-evidence-drawer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-attachment-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-browser.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/hypothesis-tracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/new-hypothesis-dialog.tsx", import.meta.url), "utf8"),
  ])

  assert.match(record, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(record, /pb-28 md:pb-12/)
  assert.match(record, /max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/)
  assert.match(drawer, /flex flex-col gap-2 sm:flex-row/)
  assert.match(hypotheses, /min-h-8[\s\S]*aria-busy=\{updating\}/)
  assert.match(browser, /Loading research records\./)
  assert.match(hypotheses, /Loading hypotheses\./)
  assert.match(hypothesisDialog, /max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/)
  assert.match(hypothesisDialog, /aria-labelledby="hyp-confidence-label"/)
  assert.match(hypothesisDialog, /aria-busy=\{submitting\}/)
  assert.match(hypothesisDialog, /role="status" aria-live="polite" aria-atomic="true"/)
  assert.match(hypothesisDialog, /Recording hypothesis\./)

  assert.match(attachment, /const controller = new AbortController\(\)/)
  assert.match(attachment, /resolution\?\.identity === referenceIdentity/)
  assert.match(record, /confirmedAttachmentRetry\(confirmation, idempotencyKey\)/)
  assert.match(record, /mergeExperimentMetrics\(current, refreshed\.metrics\)/)
  assert.match(record, /experimentSaveCompletionState\(/)
  assert.match(record, /recordEpochRef\.current/)
})

test("observation recovery is full-scope epoch-fenced, drainable on 404, and deletion-safe", async () => {
  const [record, drawer] = await Promise.all([
    readFile(new URL("../components/eln/experiment-record.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/eln/experiment-evidence-drawer.tsx", import.meta.url), "utf8"),
  ])

  assert.match(record, /const requestEpoch = recordEpochRef\.current/)
  assert.match(record, /JSON\.stringify\(\[tenantId, principalId, experimentId\]\)/)
  assert.match(record, /const pendingObservation = pendingExperimentObservationForScope\([\s\S]*pendingObservationSelection,[\s\S]*observationScopeKey/)
  assert.match(record, /setPendingObservationSelection\(pending \? \{ scopeKey: observationScopeKey, operation: pending \} : null\)/)
  assert.match(record, /const requestScopeKey = observationScopeKey/)
  assert.match(record, /const requestExperiment = observationExperimentForSubmission\([\s\S]*experimentSelection,[\s\S]*requestScopeKey,[\s\S]*composerScopeKey/)
  assert.match(record, /if \(!pendingObservation && composerScopeKey !== requestScopeKey\) return false/)
  assert.match(record, /if \(activeObservationScopeKeyRef\.current !== requestScopeKey\) return false/)
  assert.match(record, /\}, \[experimentId, loadAttempt, observationScopeKey\]\)/)
  assert.match(record, /recordEpochRef\.current === requestEpoch/)
  assert.match(record, /activeObservationScopeKeyRef\.current === requestScopeKey/)
  assert.match(record, /activeExperimentIdRef\.current === requestExperimentId/)
  assert.match(record, /useLayoutEffect\(\(\) => \{[\s\S]*activeObservationScopeKeyRef\.current = observationScopeKey[\s\S]*recordEpochRef\.current \+= 1[\s\S]*\}, \[observationScopeKey\]\)/)
  assert.match(record, /catch \(error\) \{[\s\S]*if \(!isActiveObservationRequest\(\)\) return false/)
  assert.match(record, /finally \{[\s\S]*if \(isActiveObservationRequest\(\)\) setObservationBusy\(false\)/)
  assert.match(record, /removePendingExperimentObservation\([\s\S]*loadNextPendingObservation\(\)/)
  assert.match(record, /if \(!pendingObservation \|\| observationBusy\) return[\s\S]*removePendingExperimentObservation\([\s\S]*pendingObservation\.operationId/)
  assert.match(record, /if \(notFound\)[\s\S]*Pending observation recovery[\s\S]*Retry pending observation[\s\S]*Discard pending retry/)
  assert.match(record, /if \(pendingObservation\)[\s\S]*Resolve the pending observation first/)
  assert.match(record, /disabled=\{deleting \|\| Boolean\(pendingObservation\)\}/)
  assert.match(drawer, /onSubmit=\{submit\} aria-busy=\{busy\}/)
  assert.match(drawer, /key=\{observationAuthorityScopeKey\}/)
  assert.match(drawer, /onAdd\(pending \? undefined : body, authorityScopeKey\)/)
  assert.match(drawer, /role="status" aria-live="polite"/)
  assert.match(drawer, /toLocaleString\(undefined, \{ timeZone: "UTC" \}\)\} UTC/)
})
