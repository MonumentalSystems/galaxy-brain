import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  assertHamReferenceProviders,
  createHamReferenceDecision,
  isExactHamTaskResolution,
  parseHamReferenceResolutionRequest,
  resolveHamReferenceTenant,
} from "../lib/ham-reference-resolver-contract.js"

const TENANT = "00000000-0000-4000-8000-000000000001"
const PRINCIPAL = "10000000-0000-4000-8000-000000000001"
const MEMORY = "gb:object:v1:ham.memory:3262:latest"
const TASK = "gb:object:v1:ham.task:task-reader-1:latest"

function request(references = [MEMORY]) {
  return {
    schema: "gb.referent-resolution-batch.v1",
    references,
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    operation: "read",
  }
}

test("the HAM resolver accepts only exact tenant-bound canonical batches", () => {
  const parsed = parseHamReferenceResolutionRequest(request(), TENANT.toUpperCase())
  assert.equal(parsed.references[0].id, "3262")
  assert.equal(parsed.references[0].resolvable, true)
  assert.throws(() => parseHamReferenceResolutionRequest({ ...request(), extra: true }, TENANT), /unsupported fields/i)
  assert.throws(() => parseHamReferenceResolutionRequest({ ...request(), tenant_id: PRINCIPAL }, TENANT), /not authorized/i)
  assert.throws(() => parseHamReferenceResolutionRequest(request([MEMORY, MEMORY]), TENANT), /unique/i)
  assert.equal(
    parseHamReferenceResolutionRequest(request(["gb:object:v1:ham.memory:0:latest"]), TENANT).references[0].resolvable,
    false,
  )
})

test("unsupported providers receive no decision instead of ambient authority", () => {
  const parsed = parseHamReferenceResolutionRequest(request([
    MEMORY,
    "gb:object:v1:code.repo:repository:pinned:git%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%3Bsnapshot%3Asha256%3Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]), TENANT)
  assert.equal(parsed.references[0].resolvable, true)
  assert.equal(parsed.references[1].resolvable, false)
  assert.deepEqual(createHamReferenceDecision(parsed, parsed.references[0]), {
    reference: MEMORY,
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    readable: true,
    resolved_revision: null,
    provider: "ham",
  })
  assert.throws(() => createHamReferenceDecision(parsed, parsed.references[1]), /Only readable HAM/)
})

test("HAM tasks resolve only as live heads and survive later task versions", () => {
  const parsed = parseHamReferenceResolutionRequest(request([TASK]), TENANT)
  const task = parsed.references[0]
  assert.deepEqual(task, {
    wire: TASK,
    id: "task-reader-1",
    resolvable: true,
    providerKind: "task",
    resolvedRevision: null,
  })
  assert.deepEqual(createHamReferenceDecision(parsed, task), {
    reference: TASK,
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    readable: true,
    resolved_revision: null,
    provider: "ham",
  })
  assert.equal(isExactHamTaskResolution(task, { task_id: "task-reader-1", version: 7 }), true)
  assert.equal(isExactHamTaskResolution(task, { task_id: "task-reader-1", version: 8 }), true)
  assert.equal(isExactHamTaskResolution(task, { task_id: "other", version: 7 }), false)
  assert.equal(isExactHamTaskResolution(task, { task_id: "task-reader-1", version: "7" }), false)
  assert.equal(isExactHamTaskResolution(task, null), false)

  for (const unsupported of [
    "gb:object:v1:ham.task:task-reader-1:pinned:version%3A7",
    "gb:object:v1:ham.task:task-reader-1:pinned:version%3A0",
    "gb:object:v1:ham.task:task-reader-1:pinned:version%3A01",
    "gb:object:v1:ham.task:task-reader-1:pinned:version%3A9007199254740992",
  ]) {
    assert.equal(parseHamReferenceResolutionRequest(request([unsupported]), TENANT).references[0].resolvable, false)
  }
})

test("task resolution fails closed across tenant or provider configuration gaps", () => {
  const parsed = parseHamReferenceResolutionRequest(request([TASK]), TENANT)
  assert.equal(resolveHamReferenceTenant(TENANT, TENANT.toUpperCase()), TENANT)
  assert.equal(resolveHamReferenceTenant(TENANT, PRINCIPAL), null)
  assert.equal(resolveHamReferenceTenant("not-a-uuid", TENANT), null)
  assert.doesNotThrow(() => assertHamReferenceProviders(parsed, {
    taskTenant: TENANT,
    taskConfig: { baseUrl: "https://ham.internal", bearerToken: "secret" },
  }))
  assert.throws(() => assertHamReferenceProviders(parsed, {
    taskTenant: PRINCIPAL,
    taskConfig: { baseUrl: "https://ham.internal", bearerToken: "secret" },
  }), /provider is unavailable/)
  assert.throws(() => assertHamReferenceProviders(parsed, {
    taskTenant: TENANT,
    taskConfig: null,
  }), /provider is unavailable/)
})

test("the internal route keeps credentials server-side and resolves by exact GET", async () => {
  const route = await readFile(new URL("../app/api/internal/object-references/resolve/route.ts", import.meta.url), "utf8")
  const deployment = await readFile(new URL("../docs/FEDERATED_GRAPH.md", import.meta.url), "utf8")
  assert.match(route, /timingSafeEqual/)
  assert.match(route, /GB_OBJECT_REFERENCE_RESOLVER_TOKEN/)
  assert.match(route, /HAM_SEARCH_GALAXY_TENANT_ID/)
  assert.match(route, /HAM_TASK_GALAXY_TENANT_ID/)
  assert.match(route, /resolveHamTaskProxyConfig\("detail", process\.env\)/)
  assert.match(route, /\/memories\/\$\{memoryId\}/)
  assert.match(route, /\/tasks\/\$\{encodeURIComponent\(reference\.id\)\}/)
  assert.match(route, /isExactHamTaskResolution\(reference, payload\)/)
  assert.match(route, /response\.status === 404/)
  assert.match(route, /AbortSignal\.timeout\(5_000\)/)
  assert.match(route, /request\.body\.getReader\(\)/)
  assert.match(route, /MAX_BODY_BYTES/)
  assert.doesNotMatch(route, /NEXT_PUBLIC/)
  assert.match(route, /HAM reference provider is unavailable/)
  assert.match(deployment, /read bearer used by this resolver must be[\s\S]*project-scoped to exactly `HAM_TASK_PROJECT_REF`/)
  assert.match(deployment, /tenant-wide or multi-project[\s\S]*is not a valid deployment/)
})
